const express   = require('express');
const puppeteer = require('puppeteer-core');

const app  = express();
const PORT = process.env.PORT || 3000;

const BROWSERLESS_KEY = process.env.BROWSERLESS_KEY;
const MIRRORS = [
  'https://vidsrc.me',
  'https://vidsrc.in',
  'https://vidsrc.pm',
];

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.get('/sources', async (req, res) => {
  const { imdb, season, episode } = req.query;
  if (!imdb) return res.status(400).json({ error: 'imdb required' });
  if (!BROWSERLESS_KEY) {
    return res.status(500).json({ error: 'BROWSERLESS_KEY env var not set' });
  }

  console.log(`[proxy] imdb=${imdb} season=${season} episode=${episode}`);

  const sources   = [];
  const subtitles = [];
  let   browser;

  try {
    // ── Connect to remote Chrome on Browserless ───────────────────
    browser = await puppeteer.connect({
      browserWSEndpoint:
        `wss://chrome.browserless.io?token=${BROWSERLESS_KEY}`,
    });

    const page = await browser.newPage();

    // ── Intercept all network requests ───────────────────────────
    await page.setRequestInterception(true);

    page.on('request', r => {
      const url  = r.url();
      const type = r.resourceType();

      // Block heavy assets to speed up load
      if (['image', 'font', 'stylesheet'].includes(type)) {
        return r.abort();
      }

      // Capture .m3u8 stream URLs
      if (url.includes('.m3u8')) {
        const hdrs = r.headers();
        if (!sources.find(s => s.url === url)) {
          console.log(`[proxy] Captured m3u8: ${url.slice(0, 80)}...`);
          sources.push({
            url,
            quality:  'auto',
            mimeType: 'application/x-mpegURL',
            headers: {
              'Referer':    hdrs['referer']    || 'https://vidsrc.me/',
              'User-Agent': hdrs['user-agent'] || '',
              'Origin':     hdrs['origin']     || 'https://vidsrc.me',
            },
            subtitles,
          });
        }
      }

      // Capture .mp4 stream URLs
      if (url.match(/\.mp4(\?|$)/)) {
        if (!sources.find(s => s.url === url)) {
          console.log(`[proxy] Captured mp4: ${url.slice(0, 80)}...`);
          sources.push({
            url,
            quality:  'auto',
            mimeType: 'video/mp4',
            headers: {
              'Referer': r.headers()['referer'] || 'https://vidsrc.me/',
            },
            subtitles,
          });
        }
      }

      // Capture subtitle files
      if (url.includes('.vtt')) {
        if (!subtitles.find(s => s.url === url)) {
          subtitles.push({ url, language: 'en', label: 'Subtitle' });
        }
      }

      r.continue();
    });

    // ── Also intercept responses to catch JSON source APIs ────────
    page.on('response', async response => {
      const url         = response.url();
      const contentType = response.headers()['content-type'] || '';

      if (
        contentType.includes('json') &&
        (url.includes('/source') ||
         url.includes('/api/')   ||
         url.includes('/embed/'))
      ) {
        try {
          const json = await response.json();
          console.log(`[proxy] JSON response from ${url.slice(0, 60)}`);

          const list = json?.source || json?.sources || json?.data || [];
          if (Array.isArray(list)) {
            list.forEach(s => {
              const streamUrl = s.file || s.url || s.src;
              if (streamUrl && !sources.find(x => x.url === streamUrl)) {
                sources.push({
                  url:      streamUrl,
                  quality:  s.label || 'auto',
                  mimeType: streamUrl.includes('.m3u8')
                    ? 'application/x-mpegURL' : 'video/mp4',
                  headers:  { 'Referer': 'https://vidsrc.me/' },
                  subtitles: [],
                });
              }
            });
          }
        } catch (_) { /* not parseable JSON, skip */ }
      }
    });

    // ── Try each mirror until one works ──────────────────────────
    let loaded = false;
    for (const mirror of MIRRORS) {
      try {
        const embedUrl = season
          ? `${mirror}/embed/tv?imdb=${imdb}&season=${season}&episode=${episode}`
          : `${mirror}/embed/movie?imdb=${imdb}`;

        console.log(`[proxy] Loading: ${embedUrl}`);

        await page.goto(embedUrl, {
          waitUntil: 'networkidle2',
          timeout:   30000,
        });
        loaded = true;
        console.log(`[proxy] Page loaded from ${mirror}`);
        break;
      } catch (e) {
        console.log(`[proxy] Mirror ${mirror} failed: ${e.message}`);
      }
    }

    if (!loaded) {
      return res.status(502).json({
        error: 'All VidSrc mirrors failed to load',
        sources: [],
      });
    }

    // ── Wait for JS player to fire the stream request ─────────────
    // Poll every second for up to 15 seconds
    let waited = 0;
    while (sources.length === 0 && waited < 15000) {
      await new Promise(r => setTimeout(r, 1000));
      waited += 1000;
      console.log(`[proxy] Waiting for stream... ${waited / 1000}s`);
    }

    console.log(`[proxy] Done. Found ${sources.length} source(s)`);
    res.json({ sources });

  } catch (err) {
    console.error('[proxy] Fatal error:', err.message);
    res.status(500).json({ error: err.message, sources: [] });
  } finally {
    if (browser) {
      await browser.disconnect(); // disconnect, NOT close (it's remote)
    }
  }
});

// Keep Render free tier awake (pings every 14 min)
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    require('https').get(
      process.env.RENDER_EXTERNAL_URL + '/health', () => {}
    );
  }, 840000);
}

app.listen(PORT, () =>
  console.log(`[proxy] Running on port ${PORT}`));
