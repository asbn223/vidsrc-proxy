const express = require("express");
const rateLimit = require("express-rate-limit");
const { chromium } = require("playwright-chromium");

const app = express();
const PORT = process.env.PORT || 3000;

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Too many requests, slow down." },
});
app.use(limiter);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  next();
});

app.get("/health", (_, res) => res.json({ ok: true }));

// ─── Embed providers (tried in order until one yields sources) ────────────────
function getProviders(imdb, season, episode) {
  const ep = episode || "1";
  const isTV = !!season;

  return [
    // 1. vidsrc.to
    {
      name: "vidsrc.to",
      url: isTV
        ? `https://vidsrc.to/embed/tv/${imdb}/${season}/${ep}`
        : `https://vidsrc.to/embed/movie/${imdb}`,
    },
    // 2. vidsrc.xyz
    {
      name: "vidsrc.xyz",
      url: isTV
        ? `https://vidsrc.xyz/embed/tv?imdb=${imdb}&season=${season}&episode=${ep}`
        : `https://vidsrc.xyz/embed/movie?imdb=${imdb}`,
    },
    // 3. 2embed.cc
    {
      name: "2embed.cc",
      url: isTV
        ? `https://www.2embed.cc/embedtv/${imdb}&s=${season}&e=${ep}`
        : `https://www.2embed.cc/embed/${imdb}`,
    },
    // 4. autoembed.cc
    {
      name: "autoembed.cc",
      url: isTV
        ? `https://player.autoembed.cc/embed/tv/${imdb}/${season}/${ep}`
        : `https://player.autoembed.cc/embed/movie/${imdb}`,
    },
    // 5. vidsrcme.ru (last resort — most obfuscated)
    {
      name: "vidsrcme.ru",
      url: isTV
        ? `https://vidsrcme.ru/embed/tv?imdb=${imdb}&season=${season}&episode=${ep}`
        : `https://vidsrcme.ru/embed/movie?imdb=${imdb}`,
    },
  ];
}

// ─── Stream classifier ────────────────────────────────────────────────────────
function isStream(url, ct) {
  const u = url.toLowerCase();
  const c = (ct || "").toLowerCase();
  return (
    u.includes(".m3u8") || c.includes("mpegurl") ||
    u.includes(".mp4")  || c.includes("video/mp4") ||
    u.includes(".mpd")  || c.includes("dash+xml")
  );
}
function getMimeType(url, ct) {
  const u = url.toLowerCase();
  const c = (ct || "").toLowerCase();
  if (u.includes(".m3u8") || c.includes("mpegurl")) return "application/x-mpegURL";
  if (u.includes(".mp4")  || c.includes("video/mp4")) return "video/mp4";
  return "application/dash+xml";
}

// ─── Click every likely play button in a frame ───────────────────────────────
async function clickPlay(frame) {
  const selectors = [
    ".jw-icon-display",
    ".vjs-big-play-button",
    ".plyr__control--overlaid",
    ".fp-play",
    "[class*='play']",
    "button",
    "video",
    "body",
  ];
  for (const sel of selectors) {
    try { await frame.click(sel, { timeout: 1000, force: true }); break; } catch (_) {}
  }
}

// ─── Core extractor for one provider URL ─────────────────────────────────────
async function extractFromProvider(providerName, embedUrl) {
  const sources   = [];
  const subtitles = [];
  const allUrls   = [];

  console.log(`\n[${providerName}] Trying: ${embedUrl}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-gpu", "--no-sandbox",
      "--disable-setuid-sandbox",
      "--single-process", "--no-zygote",
    ],
  });

  try {
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/124.0.0.0 Safari/537.36",
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 720 },
    });

    // Capture ALL network responses across every frame in this context
    ctx.on("response", response => {
      const url = response.url();
      const ct  = response.headers()["content-type"] || "";
      const ref = response.headers()["referer"]      || "";

      allUrls.push({ url, contentType: ct });

      if (isStream(url, ct) && !sources.find(s => s.url === url)) {
        sources.push({
          url,
          quality: "auto",
          mimeType: getMimeType(url, ct),
          headers: { Referer: ref || embedUrl },
        });
        console.log(`[${providerName}] Stream found:`, url);
      }

      const isVtt = url.includes(".vtt") || ct.includes("text/vtt");
      if (isVtt && !subtitles.find(s => s.url === url)) {
        const lang = /english|[._-]en[._-]/.test(url) ? "en" : "un";
        subtitles.push({ url, language: lang, label: "Subtitle" });
      }
    });

    // Block things that can't contain stream URLs
    await ctx.route("**/*", async route => {
      const rt = route.request().resourceType();
      if (["image", "font", "stylesheet"].includes(rt)) return route.abort();
      await route.continue();
    });

    const page = await ctx.newPage();
    await page.goto(embedUrl, { timeout: 45000, waitUntil: "domcontentloaded" });

    // Three rounds: wait → click all frames → check for sources
    for (let round = 0; round < 3; round++) {
      await page.waitForTimeout(4000);

      // page.frames() gives us the main frame + ALL nested iframes natively
      for (const frame of page.frames()) {
        try { await clickPlay(frame); } catch (_) {}
      }

      if (sources.length > 0) break;
    }

    if (sources.length === 0) await page.waitForTimeout(6000);

    console.log(`[${providerName}] Done — sources: ${sources.length}`);
    return { sources, subtitles, allUrls, provider: providerName };

  } finally {
    await browser.close();
  }
}

// ─── Try all providers until one returns sources ──────────────────────────────
async function extractStreams(imdb, season, episode) {
  const providers = getProviders(imdb, season, episode);

  for (const { name, url } of providers) {
    try {
      const result = await extractFromProvider(name, url);
      if (result.sources.length > 0) return result;
      console.log(`[proxy] ${name} returned no sources, trying next...`);
    } catch (err) {
      console.warn(`[proxy] ${name} threw: ${err.message}, trying next...`);
    }
  }

  return { sources: [], subtitles: [], allUrls: [], provider: "none" };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /sources?imdb=tt1375666
// GET /sources?imdb=tt1375666&season=1&episode=2
app.get("/sources", async (req, res) => {
  const { imdb, season, episode } = req.query;
  if (!imdb || typeof imdb !== "string")
    return res.status(400).json({ error: "?imdb=tt... is required" });

  try {
    const { sources, subtitles, provider } = await extractStreams(imdb, season, episode);
    res.json({ sources, subtitles, provider });
  } catch (err) {
    console.error("[proxy] Fatal:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /debug?imdb=tt0111161  — full dump including all captured URLs
app.get("/debug", async (req, res) => {
  const { imdb, season, episode } = req.query;
  if (!imdb || typeof imdb !== "string")
    return res.status(400).json({ error: "?imdb=tt... is required" });

  try {
    const result = await extractStreams(imdb, season, episode);
    res.json(result);
  } catch (err) {
    console.error("[proxy] Fatal:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /try?url=https://vidsrc.to/embed/movie/tt1375666  — test any embed URL directly
app.get("/try", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "?url=... is required" });

  try {
    const result = await extractFromProvider("manual", decodeURIComponent(url));
    res.json(result);
  } catch (err) {
    console.error("[proxy] Fatal:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () =>
  console.log(`[proxy] Multi-provider stream extractor on port ${PORT}`)
);