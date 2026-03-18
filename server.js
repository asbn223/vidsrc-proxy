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

app.get("/sources", async (req, res) => {
  const { imdb, season, episode } = req.query;
  if (!imdb || typeof imdb !== "string") {
    return res.status(400).json({ error: "?imdb=tt... is required" });
  }

  const embedUrl = season
    ? `https://vidsrcme.ru/embed/tv?imdb=${imdb}&season=${season}&episode=${episode}`
    : `https://vidsrcme.ru/embed/movie?imdb=${imdb}`;

  console.log(`[proxy] Extracting: ${embedUrl}`);

  let browser;
  const sources = [];
  const subtitles = [];

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-gpu", "--single-process", "--no-zygote"]
    });

    const ctx = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    });

    // ✅ context.route() catches requests from ALL frames/iframes, not just the top page
    await ctx.route("**/*.m3u8**", async route => {
      const url = route.request().url();
      const hdrs = route.request().headers();
      if (!sources.find(s => s.url === url)) {
        sources.push({
          url,
          quality: "auto",
          mimeType: "application/x-mpegURL",
          headers: {
            "Referer": hdrs["referer"] || "https://vidsrc.me/",
            "User-Agent": hdrs["user-agent"] || "",
          }
        });
        console.log(`[proxy] Captured HLS: ${url}`);
      }
      await route.continue();
    });

    await ctx.route("**/*.vtt**", async route => {
      const url = route.request().url();
      if (!subtitles.find(s => s.url === url)) {
        const lang = url.includes("english") || url.includes("en.") ? "en" : "un";
        subtitles.push({ url, language: lang, label: "Subtitle" });
        console.log(`[proxy] Captured VTT: ${url}`);
      }
      await route.continue();
    });

    // Also listen to raw network responses as a fallback
    ctx.on("response", async response => {
      const url = response.url();
      if (
        (url.includes(".m3u8") || response.headers()["content-type"]?.includes("mpegURL")) &&
        !sources.find(s => s.url === url)
      ) {
        sources.push({
          url,
          quality: "auto",
          mimeType: "application/x-mpegURL",
          headers: { "Referer": "https://vidsrc.me/" }
        });
        console.log(`[proxy] Captured HLS (response event): ${url}`);
      }
    });

    const page = await ctx.newPage();
    await page.goto(embedUrl, { timeout: 30000, waitUntil: "networkidle" });
    await page.waitForTimeout(8000);

    console.log(`[proxy] Found ${sources.length} source(s), ${subtitles.length} subtitle(s)`);
    res.json({ sources, subtitles });

  } catch (err) {
    console.error("[proxy] Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    await browser?.close();
  }
});

app.listen(PORT, () =>
  console.log(`[proxy] Stream extractor running on port ${PORT}`)
);