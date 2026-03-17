const express = require('express');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const app  = express();
const PORT = process.env.PORT || 3000;

// Try mirrors in order if one fails
const MIRRORS = [
  'https://vidsrc.me',
  'https://vidsrc.in',
  'https://vidsrc.pm',
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    + 'AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': 'https://vidsrc.me/',
};

const JSON_HEADERS = {
  ...HEADERS,
  'Accept': 'application/json, text/plain, */*',
  'X-Requested-With': 'XMLHttpRequest',
};

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.get('/sources', async (req, res) => {
  const { imdb, season, episode } = req.query;
  if (!imdb) return res.status(400).json({ error: 'imdb required' });

  console.log(`[proxy] Request: imdb=${imdb} season=${season} episode=${episode}`);

  // ── Step 1: Try every mirror until one works ──────────────────
  let html = null;
  let baseUrl = MIRRORS[0];

  for (const mirror of MIRRORS) {
    try {
      const url = season
        ? `${mirror}/embed/tv?imdb=${imdb}&season=${season}&episode=${episode}`
        : `${mirror}/embed/movie?imdb=${imdb}`;

      console.log(`[proxy] Trying mirror: ${url}`);
      const r = await fetch(url, {
        headers: { ...HEADERS, 'Referer': `${mirror}/` },
        timeout: 15000,
      });

      if (r.ok) {
        html    = await r.text();
        baseUrl = mirror;
        console.log(`[proxy] Got HTML from ${mirror} (${html.length} bytes)`);
        break;
      }
    } catch (e) {
      console.log(`[proxy] Mirror ${mirror} failed: ${e.message}`);
    }
  }

  if (!html) {
    return res.status(502).json({
      error: 'All mirrors failed. VidSrc may be down.',
      sources: [],
    });
  }

  const sources = [];
  const $ = cheerio.load(html);

  // ── Step 2: Look for .m3u8 / .mp4 URLs directly in the HTML ──
  const allText = html;

  const m3u8Regex = /https?:\/\/[^\s"'<>\\]+\.m3u8(?:[^\s"'<>\\]*)?/g;
  const mp4Regex  = /https?:\/\/[^\s"'<>\\]+\.mp4(?:[^\s"'<>\\]*)?/g;

  (allText.match(m3u8Regex) || []).forEach(url => {
    const clean = url.replace(/\\u0026/g, '&').replace(/\\/g, '');
    if (!sources.find(s => s.url === clean)) {
      sources.push({
        url:      clean,
        quality:  'auto',
        mimeType: 'application/x-mpegURL',
        headers:  { 'Referer': `${baseUrl}/` },
        subtitles: [],
      });
    }
  });

  (allText.match(mp4Regex) || []).forEach(url => {
    const clean = url.replace(/\\u0026/g, '&').replace(/\\/g, '');
    if (!sources.find(s => s.url === clean)) {
      sources.push({
        url:      clean,
        quality:  'auto',
        mimeType: 'video/mp4',
        headers:  { 'Referer': `${baseUrl}/` },
        subtitles: [],
      });
    }
  });

  console.log(`[proxy] Found in HTML: ${sources.length} direct URL(s)`);

  // ── Step 3: Extract real data-id (only from data attributes) ──
  // Never use script src — that caused the previous bug
  const dataId = $('[data-id]').first().attr('data-id')
    || $('[data-hash]').first().attr('data-hash')
    || $('[data-video-id]').first().attr('data-video-id')
    || null;

  console.log(`[proxy] data-id found: ${dataId}`);

  // ── Step 4: Extract media hash from script content ────────────
  let mediaHash = null;
  $('script').each((_, el) => {
    const text = $(el).html() || '';
    // Look for patterns like: var id = "abc123" or mediaId: "abc123"
    const patterns = [
      /(?:var\s+)?(?:id|mediaId|source_id|video_id)\s*[=:]\s*['"]([a-zA-Z0-9]+)['"]/,
      /\/api\/source\/([a-zA-Z0-9]+)/,
      /\/v\/([a-zA-Z0-9]+)/,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m && m[1] && m[1].length > 4 && !m[1].includes('.')) {
        mediaHash = m[1];
        break;
      }
    }
  });

  console.log(`[proxy] mediaHash found: ${mediaHash}`);

  // ── Step 5: Try VidSrc internal API endpoints ─────────────────
  const hashToTry = dataId || mediaHash;

  if (hashToTry && sources.length === 0) {
    const apiEndpoints = [
      `${baseUrl}/api/source/${hashToTry}`,
      `${baseUrl}/ajax/embed/source/${hashToTry}`,
      `${baseUrl}/ajax/source/${hashToTry}`,
    ];

    for (const apiUrl of apiEndpoints) {
      try {
        console.log(`[proxy] Trying API: ${apiUrl}`);
        const apiRes = await fetch(apiUrl, {
          headers: JSON_HEADERS,
          timeout: 10000,
        });

        // Check content-type BEFORE trying to parse as JSON
        const contentType = apiRes.headers.get('content-type') || '';
        if (!contentType.includes('json')) {
          console.log(`[proxy] Skipping ${apiUrl} — not JSON (${contentType})`);
          continue;
        }

        const data = await apiRes.json();
        console.log(`[proxy] API response:`, JSON.stringify(data).slice(0, 200));

        const list = data?.source || data?.sources || data?.data || [];
        if (Array.isArray(list)) {
          list.forEach(s => {
            const url = s.file || s.url || s.src;
            if (url && !sources.find(x => x.url === url)) {
              sources.push({
                url,
                quality:  s.label || s.quality || 'auto',
                mimeType: url.includes('.m3u8')
                  ? 'application/x-mpegURL' : 'video/mp4',
                headers:  { 'Referer': `${baseUrl}/` },
                subtitles: (s.tracks || s.subtitles || [])
                  .filter(t => t.kind === 'captions' || t.kind === 'subtitles')
                  .map(t => ({
                    url:      t.file || t.url,
                    label:    t.label || 'Subtitle',
                    language: t.language || 'en',
                  })),
              });
            }
          });
        }

        if (sources.length > 0) break; // stop trying endpoints

      } catch (e) {
        console.log(`[proxy] API ${apiUrl} error: ${e.message}`);
      }
    }
  }

  // ── Step 6: Try iframe src as a last resort ───────────────────
  if (sources.length === 0) {
    const iframeSrc = $('iframe[src]').first().attr('src')
      || $('iframe[data-src]').first().attr('data-src');

    if (iframeSrc) {
      const fullSrc = iframeSrc.startsWith('http')
        ? iframeSrc
        : `${baseUrl}${iframeSrc}`;
      console.log(`[proxy] Found iframe: ${fullSrc}`);

      try {
        const iframeRes = await fetch(fullSrc, {
          headers: { ...HEADERS, 'Referer': `${baseUrl}/` },
          timeout: 15000,
        });
        const iframeHtml = await iframeRes.text();

        (iframeHtml.match(m3u8Regex) || []).forEach(url => {
          const clean = url.replace(/\\u0026/g, '&');
          if (!sources.find(s => s.url === clean)) {
            sources.push({
              url:      clean,
              quality:  'auto',
              mimeType: 'application/x-mpegURL',
              headers:  { 'Referer': fullSrc },
              subtitles: [],
            });
          }
        });
      } catch (e) {
        console.log(`[proxy] iframe fetch failed: ${e.message}`);
      }
    }
  }

  console.log(`[proxy] Final source count: ${sources.length}`);

  if (sources.length === 0) {
    return res.json({
      sources: [],
      debug: {
        mirror:    baseUrl,
        dataId:    dataId   || 'not found',
        mediaHash: mediaHash || 'not found',
        htmlSize:  html.length,
        note: 'VidSrc uses heavy JS rendering. Sources may only be '
          + 'extractable with a real browser (Browserless option).',
      }
    });
  }

  res.json({ sources });
});

// Keep Render free tier awake
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    require('https').get(
      process.env.RENDER_EXTERNAL_URL + '/health', () => {}
    );
  }, 840000);
}

app.listen(PORT, () =>
  console.log(`[proxy] Running on port ${PORT}`));