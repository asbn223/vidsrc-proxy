const express = require("express");
const rateLimit = require("express-rate-limit");
const {
    chromium
} = require("playwright-chromium");
const app = express();
const PORT = process.env.PORT || 3000;
// Rate limit: max 20 requests per minute per IP
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: {
        error: "Too many requests, slow down."
    }
});
app.use(limiter);
// CORS — restrict to your app's origin in production
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET");
    next();
});
app.get("/health", (_, res) => res.json({
    ok: true
}));
app.get("/sources", async (req, res) => {
    const {
        imdb,
        season,
        episode
    } = req.query;
    if (!imdb || typeof imdb !== "string") {
        return res.status(400).json({
            error: "?imdb=tt... is required"
        });
    }
    const embedUrl = season ?
        `https://vidsrc.me/embed/tv?imdb=${imdb}&season=${season}&episode=${episode}` :
        `https://vidsrc.me/embed/movie?imdb=${imdb}`;
    console.log(`[proxy] Extracting: ${embedUrl}`);
    let browser;
    const sources = [];
    const subtitles = [];
    try {
        browser = await chromium.launch({
            headless: true
        });
        const ctx = await browser.newContext({
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        });
        const page = await ctx.newPage();
        // Intercept HLS manifest requests
        await page.route("**/*.m3u8**", async route => {
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
                    },
                });
                subtitles,
                await route.continue();
            }
        });
        // Intercept subtitle files
        await page.route("**/*.vtt**", async route => {
            const url = route.request().url();
            if (!subtitles.find(s => s.url === url)) {
                // Attempt to guess language from URL
                const lang = url.includes("english") || url.includes("en.") ? "en" : "un";
                subtitles.push({
                    url,
                    language: lang,
                    label: "Subtitle"
                });
                await route.continue();
            }
        });
        await page.goto(embedUrl, {
            timeout: 30000,
            waitUntil: "networkidle"
        });
        // Give JS player extra time to initialise and request the manifest
        await page.waitForTimeout(6000);
        console.log(`[proxy] Found ${sources.length} source(s)`);
        res.json({
            sources
        });
    } catch (err) {
        console.error("[proxy] Error:", err.message);
        res.status(500).json({
            error: err.message
        });
    } finally {
        await browser?.close();
    }
});
app.listen(PORT, () =>
    console.log(`[proxy] Stream extractor running on port ${PORT}`));