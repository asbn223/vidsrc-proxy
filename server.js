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

// ─── helpers ──────────────────────────────────────────────────────────────────

function classifyUrl(url, ct) {
  const u = url.toLowerCase();
  const c = ct.toLowerCase();
  return {
    isHLS:  u.includes(".m3u8") || c.includes("mpegurl"),
    isMp4:  u.includes(".mp4")  || c.includes("video/mp4"),
    isDash: u.includes(".mpd")  || c.includes("dash+xml"),
    isVtt:  u.includes(".vtt")  || c.includes("text/vtt"),
  };
}

async function tryClick(page) {
  // Try a cascade of likely play-button selectors
  const selectors = [
    "video",
    ".play-btn", ".play-button", "#play-btn", "#play-button",
    "[class*='play']", "[id*='play']",
    "button",
    ".jw-icon-display",        // JW Player
    ".plyr__control--overlaid", // Plyr
    ".vjs-big-play-button",    // Video.js
    ".fp-play",                // Flowplayer
  ];
  for (const sel of selectors) {
    try { await page.click(sel, { timeout: 1500 }); } catch (_) {}
  }
}

// ─── core extractor ───────────────────────────────────────────────────────────

async function extractStreams(embedUrl) {
  const sources   = [];
  const subtitles = [];
  const allUrls   = [];

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-gpu",
      "--single-process",
      "--no-zygote",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ]
  });

  try {
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/124.0.0.0 Safari/537.36",
      ignoreHTTPSErrors: true,
      // Pretend we have a real viewport so players don't hide
      viewport: { width: 1280, height: 720 },
    });

    // ── response listener (fires for ALL pages / iframes in this context) ──
    ctx.on("response", response => {
      const url = response.url();
      const ct  = response.headers()["content-type"] || "";
      const ref = response.headers()["referer"]      || "";

      allUrls.push({ url, contentType: ct });

      const { isHLS, isMp4, isDash, isVtt } = classifyUrl(url, ct);

      if ((isHLS || isMp4 || isDash) && !sources.find(s => s.url === url)) {
        sources.push({
          url,
          quality: "auto",
          mimeType: isHLS ? "application/x-mpegURL"
                  : isMp4 ? "video/mp4"
                  :          "application/dash+xml",
          headers: { Referer: ref || embedUrl },
        });
        console.log("[proxy] ✅ Stream:", url);
      }

      if (isVtt && !subtitles.find(s => s.url === url)) {
        const lang = url.includes("english") || url.includes("en.") ? "en" : "un";
        subtitles.push({ url, language: lang, label: "Subtitle" });
      }
    });

    // ── block heavy resources we don't need ──
    await ctx.route("**/*", async route => {
      const rt = route.request().resourceType();
      // Keep scripts & XHR — they load the player and stream URLs
      if (["image", "font", "stylesheet", "media"].includes(rt))
        return route.abort();
      await route.continue();
    });

    // ── Step 1: load the top-level embed page ──
    const page = await ctx.newPage();
    console.log("[proxy] Loading embed:", embedUrl);
    await page.goto(embedUrl, { timeout: 45000, waitUntil: "networkidle" });

    // Short pause to let JS settle
    await page.waitForTimeout(3000);

    // ── Step 2: collect iframe srcs before clicking anything ──
    const iframeSrcs = await page
      .$$eval("iframe", frames =>
        frames
          .map(f => f.src || f.getAttribute("src"))
          .filter(s => s && s.startsWith("http"))
      )
      .catch(() => []);

    console.log("[proxy] Found iframes:", iframeSrcs);

    // ── Step 3: try clicking play on the top page ──
    await tryClick(page);
    await page.waitForTimeout(5000);

    // ── Step 4: open every iframe URL in its own page so its JS runs ──
    for (const src of iframeSrcs) {
      console.log("[proxy] Opening iframe page:", src);
      try {
        const iPage = await ctx.newPage();
        await iPage.goto(src, { timeout: 30000, waitUntil: "networkidle" });
        await iPage.waitForTimeout(3000);
        await tryClick(iPage);
        await iPage.waitForTimeout(8000);  // wait for HLS manifest to be requested
        await iPage.close();
      } catch (e) {
        console.warn("[proxy] iframe page error:", e.message);
      }
    }

    // ── Step 5: if we still have nothing, try the cloudnestra RCP URL directly ──
    if (sources.length === 0) {
      const rcpEntry = allUrls.find(u =>
        u.url.includes("cloudnestra.com/rcp/") && u.contentType.includes("text/html")
      );
      if (rcpEntry) {
        console.log("[proxy] Falling back to RCP page:", rcpEntry.url);
        try {
          const rcpPage = await ctx.newPage();
          await rcpPage.goto(rcpEntry.url, { timeout: 30000, waitUntil: "networkidle" });
          await rcpPage.waitForTimeout(3000);
          await tryClick(rcpPage);
          await rcpPage.waitForTimeout(10000);
          await rcpPage.close();
        } catch (e) {
          console.warn("[proxy] RCP page error:", e.message);
        }
      }
    }

    // Final settle
    await page.waitForTimeout(2000);

    console.log("[proxy] Done — sources:", sources.length, "subtitles:", subtitles.length);
    return { sources, subtitles, allUrls };

  } finally {
    await browser.close();
  }
}

// ─── routes ───────────────────────────────────────────────────────────────────

function buildEmbedUrl(imdb, season, episode) {
  if (season) {
    return (
      "https://vidsrcme.ru/embed/tv?imdb=" + imdb +
      "&season=" + season +
      "&episode=" + (episode || "1")
    );
  }
  return "https://vidsrcme.ru/embed/movie?imdb=" + imdb;
}

app.get("/sources", async (req, res) => {
  const { imdb, season, episode } = req.query;
  if (!imdb || typeof imdb !== "string")
    return res.status(400).json({ error: "?imdb=tt... is required" });

  const embedUrl = buildEmbedUrl(imdb, season, episode);
  console.log("[proxy] /sources ->", embedUrl);
  try {
    const { sources, subtitles } = await extractStreams(embedUrl);
    res.json({ sources, subtitles });
  } catch (err) {
    console.error("[proxy] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /debug?imdb=tt0111161  — see every URL the player touches
app.get("/debug", async (req, res) => {
  const { imdb, season, episode } = req.query;
  if (!imdb || typeof imdb !== "string")
    return res.status(400).json({ error: "?imdb=tt... is required" });

  const embedUrl = buildEmbedUrl(imdb, season, episode);
  console.log("[proxy] /debug ->", embedUrl);
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