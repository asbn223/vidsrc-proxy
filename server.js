const express = require("express");
const rateLimit = require("express-rate-limit");
const { chromium } = require("playwright-chromium");

const app = express();
const PORT = process.env.PORT || 3000;

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Too many requests, slow down." }
});
app.use(limiter);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  next();
});

app.get("/health", (_, res) => res.json({ ok: true }));

async function extractStreams(embedUrl) {
  const sources   = [];
  const subtitles = [];
  const allUrls   = [];

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-gpu", "--single-process", "--no-zygote"]
  });

  try {
    const ctx = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      ignoreHTTPSErrors: true,
    });

    ctx.on("response", async response => {
      const url = response.url();
      const ct  = response.headers()["content-type"] || "";
      const ref = response.headers()["referer"] || "";

      allUrls.push({ url, contentType: ct });

      const isHLS  = url.includes(".m3u8") || ct.includes("mpegURL") || ct.includes("x-mpegurl");
      const isMp4  = url.includes(".mp4")  || ct.includes("video/mp4");
      const isDash = url.includes(".mpd")  || ct.includes("dash+xml");
      const isVtt  = url.includes(".vtt")  || ct.includes("text/vtt");

      if ((isHLS || isMp4 || isDash) && !sources.find(s => s.url === url)) {
        sources.push({
          url,
          quality: "auto",
          mimeType: isHLS ? "application/x-mpegURL" : isMp4 ? "video/mp4" : "application/dash+xml",
          headers: { "Referer": ref || embedUrl }
        });
        console.log("[proxy] Stream: " + url);
      }

      if (isVtt && !subtitles.find(s => s.url === url)) {
        const lang = url.includes("english") || url.includes("en.") ? "en" : "un";
        subtitles.push({ url, language: lang, label: "Subtitle" });
      }
    });

    await ctx.route("**/*", async route => {
      const rt = route.request().resourceType();
      if (["image", "font", "stylesheet"].includes(rt)) return route.abort();
      await route.continue();
    });

    const page = await ctx.newPage();
    await page.goto(embedUrl, { timeout: 45000, waitUntil: "networkidle" });
    await page.waitForTimeout(10000);

    return { sources, subtitles, allUrls };
  } finally {
    await browser.close();
  }
}

app.get("/sources", async (req, res) => {
  const { imdb, season, episode } = req.query;
  if (!imdb || typeof imdb !== "string")
    return res.status(400).json({ error: "?imdb=tt... is required" });

  const embedUrl = season
    ? "https://vidsrcme.ru/embed/tv?imdb=" + imdb + "&season=" + season + "&episode=" + episode
    : "https://vidsrcme.ru/embed/movie?imdb=" + imdb;

  console.log("[proxy] Extracting: " + embedUrl);
  try {
    const { sources, subtitles } = await extractStreams(embedUrl);
    res.json({ sources, subtitles });
  } catch (err) {
    console.error("[proxy] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Use this to see every URL the page loads — helps diagnose empty sources
// GET /debug?imdb=tt0111161
app.get("/debug", async (req, res) => {
  const { imdb, season, episode } = req.query;
  if (!imdb || typeof imdb !== "string")
    return res.status(400).json({ error: "?imdb=tt... is required" });

  const embedUrl = season
    ? "https://vidsrcme.ru/embed/tv?imdb=" + imdb + "&season=" + season + "&episode=" + episode
    : "https://vidsrcme.ru/embed/movie?imdb=" + imdb;

  console.log("[proxy] Debug: " + embedUrl);
  try {
    const { sources, subtitles, allUrls } = await extractStreams(embedUrl);
    res.json({ sources, subtitles, allUrls });
  } catch (err) {
    console.error("[proxy] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () =>
  console.log("[proxy] Stream extractor running on port " + PORT)
);