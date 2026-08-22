/**
 * Sponsor news crawl — Google News RSS for Salesforce / crosswalk account names.
 * Stores recent headlines in Cosmos ora_sponsor_news (not ZoomInfo-grade).
 */

const NEWS_CONTAINER = "ora_sponsor_news";
const NEWS_DOC_TYPE = "ora_sponsor_news";
const SYNC_ID = "sponsor_news";

async function queryAll(container, query, parameters = []) {
  const { resources } = await container.items
    .query({ query, parameters }, { enableCrossPartitionQuery: true })
    .fetchAll();
  return resources || [];
}

async function ensureNewsContainer(database) {
  await database.containers.createIfNotExists({
    id: NEWS_CONTAINER,
    partitionKey: { paths: ["/sponsorKey"] }
  });
}

function slugKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80);
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRssItems(xml, limit = 8) {
  const items = [];
  const blocks = String(xml || "").match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    if (items.length >= limit) break;
    const title = stripHtml((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
    const link = stripHtml((block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || "");
    const pubDate = stripHtml((block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] || "");
    const source = stripHtml(
      (block.match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [])[1] || ""
    );
    if (!title) continue;
    items.push({ title, link, pubDate, source });
  }
  return items;
}

async function fetchGoogleNews(sponsorName) {
  const q = encodeURIComponent(`"${sponsorName}" (clinical OR trial OR FDA OR ophthalmology OR biotech)`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, {
    headers: { "User-Agent": "OraStudyBidWorkbench/1.0 (sponsor-news)" }
  });
  if (!res.ok) throw new Error(`Google News RSS HTTP ${res.status}`);
  const xml = await res.text();
  return parseRssItems(xml, 8);
}

async function loadWatchlist(database, { limit = 40 } = {}) {
  const names = new Map();
  try {
    const accounts = await queryAll(
      database.container("ora_sf_account"),
      `SELECT TOP @lim c.Name, c.Id FROM c WHERE c.docType = @t`,
      [
        { name: "@t", value: "ora_sf_account" },
        { name: "@lim", value: limit }
      ]
    );
    for (const a of accounts) {
      const n = String(a.Name || "").trim();
      if (n.length >= 3) names.set(n.toLowerCase(), { name: n, sfAccountId: a.Id || null });
    }
  } catch (_) {
    /* empty SF ok */
  }
  if (names.size < 10) {
    try {
      const xw = await queryAll(
        database.container("ora_sponsor_crosswalk"),
        `SELECT TOP @lim c.sf_account_name, c.trialhub_veeva_sponsor, c.sf_account_id FROM c WHERE c.docType = @t`,
        [
          { name: "@t", value: "ora_sponsor_crosswalk" },
          { name: "@lim", value: limit }
        ]
      );
      for (const row of xw) {
        const n = String(row.sf_account_name || row.trialhub_veeva_sponsor || "").trim();
        if (n.length >= 3 && !names.has(n.toLowerCase())) {
          names.set(n.toLowerCase(), {
            name: n,
            sfAccountId: row.sf_account_id || null
          });
        }
      }
    } catch (_) {
      /* empty crosswalk ok */
    }
  }
  return [...names.values()].slice(0, limit);
}

async function runSponsorNewsCrawl(getDb, opts = {}) {
  const database = getDb();
  await ensureNewsContainer(database);
  const maxSponsors = Math.min(Number(opts.maxSponsors) || 25, 60);
  const watchlist = await loadWatchlist(database, { limit: maxSponsors });
  if (!watchlist.length) {
    return {
      ok: false,
      error: "No SF accounts or crosswalk sponsors to crawl",
      upserted: 0
    };
  }

  const now = new Date().toISOString();
  let upserted = 0;
  let errors = 0;
  const samples = [];

  for (const sponsor of watchlist) {
    try {
      const headlines = await fetchGoogleNews(sponsor.name);
      const sponsorKey = slugKey(sponsor.name) || "unknown";
      const id = `news-${sponsorKey}`;
      await database.container(NEWS_CONTAINER).items.upsert({
        id,
        sponsorKey,
        docType: NEWS_DOC_TYPE,
        sponsorName: sponsor.name,
        sfAccountId: sponsor.sfAccountId || null,
        headlines,
        headlineCount: headlines.length,
        crawledAt: now,
        source: "google_news_rss"
      });
      upserted += 1;
      if (samples.length < 5) {
        samples.push({
          sponsor: sponsor.name,
          n: headlines.length,
          top: headlines[0]?.title || null
        });
      }
      // Be polite to Google RSS
      await new Promise((r) => setTimeout(r, 350));
    } catch (_) {
      errors += 1;
    }
  }

  try {
    await database.containers.createIfNotExists({
      id: "syncState",
      partitionKey: { paths: ["/id"] }
    });
    await database.container("syncState").items.upsert({
      id: SYNC_ID,
      docType: "sync_state",
      lastSuccessfulSync: now,
      lastRunAt: now,
      upserted,
      errors,
      watchlistSize: watchlist.length,
      mode: "google_news_rss",
      note: "Sponsor headlines from Google News RSS (not ZoomInfo)."
    });
  } catch (_) {
    /* syncState optional */
  }

  return {
    ok: upserted > 0,
    upserted,
    errors,
    watchlistSize: watchlist.length,
    samples,
    crawledAt: now,
    note: "Stored in ora_sponsor_news. Not a commercial intel product — headlines only."
  };
}

async function getSponsorNewsStatus(getDb) {
  const database = getDb();
  let sync = null;
  try {
    const { resource } = await database.container("syncState").item(SYNC_ID, SYNC_ID).read();
    sync = resource
      ? {
          lastSuccessfulSync: resource.lastSuccessfulSync || null,
          lastRunAt: resource.lastRunAt || null,
          upserted: resource.upserted,
          errors: resource.errors,
          watchlistSize: resource.watchlistSize
        }
      : null;
  } catch (_) {
    sync = null;
  }
  let count = 0;
  try {
    const rows = await queryAll(
      database.container(NEWS_CONTAINER),
      "SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t",
      [{ name: "@t", value: NEWS_DOC_TYPE }]
    );
    count = rows[0] ?? 0;
  } catch (_) {
    count = 0;
  }
  return { count, sync, note: "Google News RSS crawl → ora_sponsor_news" };
}

async function buildSponsorNewsPack(getDb, opts = {}) {
  const database = getDb();
  const hint = String(opts.sponsor || opts.clientName || "").trim().toLowerCase();
  try {
    let rows;
    if (hint) {
      rows = await queryAll(
        database.container(NEWS_CONTAINER),
        `SELECT TOP 10 c.sponsorName, c.headlines, c.crawledAt, c.sfAccountId
         FROM c WHERE c.docType = @t
           AND (CONTAINS(LOWER(c.sponsorName), @h, true) OR CONTAINS(c.sponsorKey, @h, true))`,
        [
          { name: "@t", value: NEWS_DOC_TYPE },
          { name: "@h", value: hint }
        ]
      );
    } else {
      rows = await queryAll(
        database.container(NEWS_CONTAINER),
        `SELECT TOP 15 c.sponsorName, c.headlines, c.crawledAt FROM c WHERE c.docType = @t`,
        [{ name: "@t", value: NEWS_DOC_TYPE }]
      );
    }
    return {
      empty: !rows.length,
      count: rows.length,
      sponsors: rows.map((r) => ({
        sponsorName: r.sponsorName,
        crawledAt: r.crawledAt,
        headlines: (r.headlines || []).slice(0, 5)
      })),
      note: "Recent Google News headlines for watched sponsors (ora_sponsor_news)."
    };
  } catch (err) {
    return { error: String(err.message || err) };
  }
}

function isSponsorNewsQuestion(question) {
  const q = String(question || "").toLowerCase();
  return /\b(sponsor news|news about|headlines?|press (release|coverage)|in the news)\b/.test(q);
}

module.exports = {
  NEWS_CONTAINER,
  NEWS_DOC_TYPE,
  runSponsorNewsCrawl,
  getSponsorNewsStatus,
  buildSponsorNewsPack,
  isSponsorNewsQuestion
};
