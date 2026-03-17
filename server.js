const express   = require('express');
const puppeteer = require('puppeteer-core');

const app  = express();
const PORT = process.env.PORT || 3000;

const BROWSERLESS_KEY = process.env.BROWSERLESS_KEY;

// ← correct domain first
const MIRRORS = [
  'https://vidsrc-embed.ru',
  'https://vidsrc.me',
  'https://vidsrc.in',
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
    return res.status(500).json({ error: 'BROWSERLESS_KEY not set' });
  }

  console.log(`[proxy] imdb=${imdb} season=${season} episode=${episode}`);

  let browser;
  const sources   = [];
  const subtitles = [];

  try {
    browser = await puppeteer.connect({
      browserWSEndpoint:
        `wss://chrome.browserless.io?token=${BROWSERLESS_KEY}`,
    });

    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36'
    );

    // ── CDP: capture ALL requests including nested iframes ────────
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    await cdp.send('Network.setRequestInterception', {
      patterns: [{ urlPattern: '*' }],
    });

    cdp.on('Network.requestIntercepted', async ({
      interceptionId, request
    }) => {
      const url  = request.url;
      const hdrs = request.headers || {};

      if (url.includes('.m3u8')) {
        if (!sources.find(s => s.url === url)) {
          console.log(`[CDP] m3u8: ${url.slice(0, 100)}`);
          sources.push({
            url,
            quality:  'auto',
            mimeType: 'application/x-mpegURL',
            headers: {
              'Referer':    hdrs['Referer']    || hdrs['referer']    || 'https://vidsrc-embed.ru/',
              'User-Agent': hdrs['User-Agent'] || hdrs['user-agent'] || '',
              'Origin':     hdrs['Origin']     || hdrs['origin']     || '',
            },
            subtitles,
          });
        }
      }

      if (url.match(/\.mp4(\?|$)/i)) {
        if (!sources.find(s => s.url === url)) {
          console.log(`[CDP] mp4: ${url.slice(0, 100)}`);
          sources.push({
            url,
            quality:  'auto',
            mimeType: 'video/mp4',
            headers: {
              'Referer': hdrs['referer'] || 'https://vidsrc-embed.ru/',
            },
            subtitles,
          });
        }
      }

      if (url.includes('.vtt')) {
        if (!subtitles.find(s => s.url === url)) {
          subtitles.push({ url, language: 'en', label: 'Subtitle' });
        }
      }

      try {
        await cdp.send('Network.continueInterceptedRequest', {
          interceptionId,
        });
      } catch (_) {}
    });

    // ── Capture JSON source API responses ─────────────────────────
    cdp.on('Network.responseReceived', async ({
      requestId, response
    }) => {
      const url         = response.url;
      const contentType = response.headers['content-type'] || '';

      if (
        contentType.includes('json') &&
        (url.includes('/source') || url.includes('/api/'))
      ) {
        try {
          const body = await cdp.send('Network.getResponseBody', {
            requestId,
          });
          const json = JSON.parse(body.body);
          const list = json?.source || json?.sources || json?.data || [];
          if (Array.isArray(list)) {
            list.forEach(s => {
              const streamUrl = s.file || s.url || s.src;
              if (streamUrl && !sources.find(x => x.url === streamUrl)) {
                console.log(`[CDP] JSON source: ${streamUrl.slice(0, 80)}`);
                sources.push({
                  url:      streamUrl,
                  quality:  s.label || 'auto',
                  mimeType: streamUrl.includes('.m3u8')
                    ? 'application/x-mpegURL' : 'video/mp4',
                  headers:  {
                    'Referer': 'https://vidsrc-embed.ru/',
                  },
                  subtitles: [],
                });
              }
            });
          }
        } catch (_) {}
      }
    });

    // ── Try each mirror ───────────────────────────────────────────
    let loaded = false;
    for (const mirror of MIRRORS) {
      try {
        // Use clean path format: /embed/movie/{imdbId}
        const embedUrl = season
          ? `${mirror}/embed/tv/${imdb}?season=${season}&episode=${episode}`
          : `${mirror}/embed/movie/${imdb}`;

        console.log(`[proxy] Loading: ${embedUrl}`);

        await page.goto(embedUrl, {
          waitUntil: 'domcontentloaded',
          timeout:   30000,
        });
        loaded = true;
        console.log(`[proxy] Loaded from ${mirror}`);
        break;
      } catch (e) {
        console.log(`[proxy] ${mirror} failed: ${e.message}`);
      }
    }

    if (!loaded) {
      return res.status(502).json({
        error: 'All mirrors failed', sources: [],
      });
    }

    // ── Click play button if present ──────────────────────────────
    try {
      await page.waitForSelector(
        '.play-btn, button.play, [aria-label="Play"], '  +
        '.jw-icon-playback, .plyr__control--overlaid',
        { timeout: 5000 }
      );
      await page.click(
        '.play-btn, button.play, [aria-label="Play"], ' +
        '.jw-icon-playback, .plyr__control--overlaid'
      );
      console.log('[proxy] Clicked play');
    } catch (_) {
      // No play button — autoplay may handle it
      console.log('[proxy] No play button, waiting for autoplay...');
    }

    // ── Poll up to 20s for stream ─────────────────────────────────
    let waited = 0;
    while (sources.length === 0 && waited < 20000) {
      await new Promise(r => setTimeout(r, 1000));
      waited += 1000;
      console.log(
        `[proxy] ${waited / 1000}s | sources: ${sources.length}`
      );
    }

    // ── Last resort: performance API ──────────────────────────────
    if (sources.length === 0) {
      console.log('[proxy] Trying performance API fallback...');
      const perfUrls = await page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .map(r => r.name)
          .filter(u => u.includes('.m3u8') || u.includes('.mp4'))
      );
      console.log('[proxy] perf URLs:', perfUrls);
      perfUrls.forEach(url => {
        if (!sources.find(s => s.url === url)) {
          sources.push({
            url,
            quality:  'auto',
            mimeType: url.includes('m3u8')
              ? 'application/x-mpegURL' : 'video/mp4',
            headers:  { 'Referer': 'https://vidsrc-embed.ru/' },
            subtitles: [],
          });
        }
      });
    }

    console.log(`[proxy] Final: ${sources.length} source(s)`);
    res.json({ sources });

  } catch (err) {
    console.error('[proxy] Fatal:', err.message);
    res.status(500).json({ error: err.message, sources: [] });
  } finally {
    if (browser) await browser.disconnect();
  }
});

// Keep Render awake
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    require('https').get(
      process.env.RENDER_EXTERNAL_URL + '/health', () => {}
    );
  }, 840000);
}

app.listen(PORT, () =>
  console.log(`[proxy] Running on port ${PORT}`));