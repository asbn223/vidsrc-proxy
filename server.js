const express   = require('express');
const puppeteer = require('puppeteer');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.get('/sources', async (req, res) => {
  const { imdb, season, episode } = req.query;
  if (!imdb) return res.status(400).json({ error: 'imdb required' });

  const embedUrl = season
    ? `https://vidsrc.me/embed/tv?imdb=${imdb}&season=${season}&episode=${episode}`
    : `https://vidsrc.me/embed/movie?imdb=${imdb}`;

  console.log(`[proxy] Visiting: ${embedUrl}`);

  let browser;
  const sources   = [];
  const subtitles = [];

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath:
        process.env.CHROME_BIN ||
        '/usr/bin/google-chrome-stable' ||
        '/usr/bin/chromium-browser' ||
        '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
      ],
    });

    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.setRequestInterception(true);

    page.on('request', interceptedReq => {
      const url = interceptedReq.url();

      if (url.includes('.m3u8')) {
        const hdrs = interceptedReq.headers();
        if (!sources.find(s => s.url === url)) {
          sources.push({
            url,
            quality:  'auto',
            mimeType: 'application/x-mpegURL',
            headers: {
              'Referer':    hdrs['referer']    || 'https://vidsrc.me/',
              'User-Agent': hdrs['user-agent'] || '',
            },
            subtitles,
          });
        }
      }

      if (url.includes('.vtt')) {
        if (!subtitles.find(s => s.url === url)) {
          subtitles.push({
            url,
            language: 'en',
            label: 'Subtitle',
          });
        }
      }

      interceptedReq.continue();
    });

    await page.goto(embedUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Wait for JS player to fire the stream request
    await new Promise(r => setTimeout(r, 7000));

    console.log(`[proxy] Found ${sources.length} source(s)`);
    res.json({ sources });

  } catch (err) {
    console.error('[proxy] Error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// Keep Render free tier awake
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    require('https').get(
      process.env.RENDER_EXTERNAL_URL + '/health',
      () => console.log('[keepalive] pinged self')
    );
  }, 840000);
}

app.listen(PORT, () =>
  console.log(`[proxy] Running on port ${PORT}`));