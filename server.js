const express = require('express');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const app  = express();
const PORT = process.env.PORT || 3000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    + 'AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://vidsrc.me/',
  'Origin':  'https://vidsrc.me',
};

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.get('/sources', async (req, res) => {
  const { imdb, season, episode } = req.query;
  if (!imdb) return res.status(400).json({ error: 'imdb required' });

  try {
    // Step 1: Load the embed page HTML
    const embedUrl = season
      ? `https://vidsrc.me/embed/tv?imdb=${imdb}&season=${season}&episode=${episode}`
      : `https://vidsrc.me/embed/movie?imdb=${imdb}`;

    console.log(`[proxy] Fetching embed: ${embedUrl}`);
    const embedRes = await fetch(embedUrl, { headers: HEADERS });
    const html     = await embedRes.text();
    const $        = cheerio.load(html);

    // Step 2: Find the source data-id from the embed page
    // VidSrc stores the media id in a script tag or data attribute
    const sources = [];

    // Extract any script that contains a source/stream URL pattern
    $('script').each((_, el) => {
      const text = $(el).html() || '';

      // Look for .m3u8 URLs embedded in the script
      const m3u8Matches = text.match(
        /https?:\/\/[^\s'"]+\.m3u8[^\s'"]*/g
      );
      if (m3u8Matches) {
        m3u8Matches.forEach(url => {
          if (!sources.find(s => s.url === url)) {
            sources.push({
              url,
              quality:  'auto',
              mimeType: 'application/x-mpegURL',
              headers:  { 'Referer': 'https://vidsrc.me/' },
              subtitles: [],
            });
          }
        });
      }
    });

    // Step 3: If no m3u8 found in HTML, try VidSrc's internal API
    if (sources.length === 0) {
      console.log('[proxy] No m3u8 in HTML, trying internal API...');

      // Extract the data-id or media hash from the page
      const dataId = $('[data-id]').first().attr('data-id')
        || $('script[src*="source"]').first().attr('src');

      if (dataId) {
        const apiUrl = `https://vidsrc.me/api/source/${dataId}`;
        console.log(`[proxy] Calling internal API: ${apiUrl}`);

        const apiRes  = await fetch(apiUrl, { headers: HEADERS });
        const apiData = await apiRes.json();

        // VidSrc internal API returns array of sources
        const apiSources = apiData?.source || apiData?.sources || [];
        apiSources.forEach(s => {
          if (s.file || s.url) {
            sources.push({
              url:      s.file || s.url,
              quality:  s.label || 'auto',
              mimeType: (s.file || s.url || '').includes('.m3u8')
                ? 'application/x-mpegURL' : 'video/mp4',
              headers:  { 'Referer': 'https://vidsrc.me/' },
              subtitles: [],
            });
          }
        });
      }
    }

    console.log(`[proxy] Found ${sources.length} source(s)`);
    res.json({ sources });

  } catch (err) {
    console.error('[proxy] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Keep Render free tier awake
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    require('https').get(
      process.env.RENDER_EXTERNAL_URL + '/health',
      () => {}
    );
  }, 840000);
}

app.listen(PORT, () =>
  console.log(`[proxy] Running on port ${PORT}`));
