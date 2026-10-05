/**
 * Smoke-test Monet HTTP page scrape (Node fetch, not Firecrawl).
 * Usage: node scripts/_probe_monet_web_scrape.js
 */
const {
  wantsPageScrape,
  extractUrls,
  scrapePagesForAsk,
  fetchPageText
} = require("../api/src/webScrape");
const { routeBuddyAsk } = require("../api/src/buddyRouter");

(async () => {
  const q1 = "Scrape https://example.com and summarize the page";
  const q2 = "what is wet AMD PSM";
  console.log("DETECT", {
    scrapeExample: wantsPageScrape(q1),
    urls: extractUrls(q1),
    pureData: wantsPageScrape(q2)
  });

  const route = routeBuddyAsk({ question: q1, body: {}, hints: {} });
  console.log("ROUTE", { tools: route.tools, hasScrape: (route.tools || []).includes("web_scrape") });

  const pack = await scrapePagesForAsk(q1);
  console.log(
    "SCRAPE",
    JSON.stringify({
      okCount: pack.okCount,
      pages: (pack.pages || []).map((p) => ({
        url: p.url,
        ok: p.ok,
        title: p.title,
        charCount: p.charCount,
        error: p.error || null,
        preview: p.ok ? String(p.text || "").slice(0, 120) : null
      }))
    })
  );

  const blocked = await fetchPageText("http://127.0.0.1/");
  console.log("SSRF", { ok: blocked.ok, error: blocked.error });

  const ok =
    wantsPageScrape(q1) &&
    !wantsPageScrape(q2) &&
    route.tools.includes("web_scrape") &&
    pack.okCount >= 1 &&
    blocked.ok === false;

  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error("FATAL", err && err.message ? err.message : err);
  process.exit(1);
});
