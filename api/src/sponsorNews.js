/**
 * Sponsor news crawl — Google News RSS for Salesforce account names.
 * Watchlist: Closed Won sponsors first, then top open-pipeline SF accounts to fill the cap.
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

function isOppClosedWon(o) {
  if (o.IsWon === true || o.IsWon === "true") return true;
  return /^closed\s*won$/i.test(String(o.StageName || "").trim());
}

function isOppOpen(o) {
  if (o.IsClosed === true || o.IsClosed === "true") return false;
  const stage = String(o.StageName || "").toLowerCase();
  if (/^closed\b/.test(stage)) return false;
  return true;
}

function oppOraNetRevenue(o) {
  const fields = [
    "Total_Ora_Net_Revenue__c",
    "Total_Ora_Net_Rev__c",
    "Ora_Net_Revenue__c",
    "Total_Ora_Net_Revenue"
  ];
  for (const f of fields) {
    if (o[f] != null && o[f] !== "") {
      const n = Number(o[f]);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

/**
 * Closed Won sponsors first; fill remaining cap with top open-pipeline SF accounts
 * (clients in CRM we may not have won with yet).
 */
async function loadWatchlist(database, { limit = 40 } = {}) {
  const watchlistSource = "sf_closed_won_priority";
  const wonByAccount = new Map();
  const openByAccount = new Map();

  let opps = [];
  try {
    opps = await queryAll(
      database.container("ora_sf_opportunity"),
      `SELECT c.AccountId, c.StageName, c.IsWon, c.IsClosed, c.CloseDate,
              c.Total_Ora_Net_Revenue__c, c.Total_Ora_Net_Rev__c
       FROM c WHERE c.docType = @t AND IS_DEFINED(c.AccountId) AND c.AccountId != null`,
      [{ name: "@t", value: "ora_sf_opportunity" }]
    );
  } catch (_) {
    return { watchlist: [], watchlistSource };
  }

  for (const o of opps) {
    const accountId = o.AccountId;
    if (!accountId) continue;
    if (isOppClosedWon(o)) {
      const cur = wonByAccount.get(accountId) || {
        accountId,
        wonCount: 0,
        oraNetSum: 0,
        lastCloseDate: null
      };
      cur.wonCount += 1;
      cur.oraNetSum += oppOraNetRevenue(o);
      const cd = o.CloseDate ? String(o.CloseDate) : null;
      if (cd && (!cur.lastCloseDate || cd > cur.lastCloseDate)) cur.lastCloseDate = cd;
      wonByAccount.set(accountId, cur);
    }
    if (isOppOpen(o)) {
      const cur = openByAccount.get(accountId) || {
        accountId,
        openCount: 0,
        openOraNetSum: 0
      };
      cur.openCount += 1;
      cur.openOraNetSum += oppOraNetRevenue(o);
      openByAccount.set(accountId, cur);
    }
  }

  if (!wonByAccount.size && !openByAccount.size) {
    return { watchlist: [], watchlistSource };
  }

  const nameById = new Map();
  try {
    const accounts = await queryAll(
      database.container("ora_sf_account"),
      `SELECT c.Id, c.Name FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_sf_account" }]
    );
    for (const a of accounts) {
      if (a.Id) nameById.set(a.Id, String(a.Name || "").trim());
    }
  } catch (_) {
    /* account names optional but required for crawl */
  }

  const toEntry = (row, priority) => ({
    name: nameById.get(row.accountId) || "",
    sfAccountId: row.accountId,
    watchPriority: priority,
    closedWonCount: row.wonCount ?? null,
    oraNetWonSum: row.oraNetSum ?? null,
    openOppCount: row.openCount ?? null,
    openOraNetSum: row.openOraNetSum ?? null,
    lastCloseDate: row.lastCloseDate ?? null
  });

  const closedWon = [...wonByAccount.values()]
    .map((row) => toEntry(row, "closed_won"))
    .filter((s) => s.name.length >= 3)
    .sort((a, b) => {
      if (b.closedWonCount !== a.closedWonCount) return b.closedWonCount - a.closedWonCount;
      if (b.oraNetWonSum !== a.oraNetWonSum) return b.oraNetWonSum - a.oraNetWonSum;
      return String(b.lastCloseDate || "").localeCompare(String(a.lastCloseDate || ""));
    });

  const seen = new Set(closedWon.map((s) => s.sfAccountId));
  const openPipeline = [...openByAccount.values()]
    .filter((row) => !wonByAccount.has(row.accountId))
    .map((row) => toEntry(row, "open_pipeline"))
    .filter((s) => s.name.length >= 3 && !seen.has(s.sfAccountId))
    .sort((a, b) => {
      if (b.openOraNetSum !== a.openOraNetSum) return b.openOraNetSum - a.openOraNetSum;
      return b.openOppCount - a.openOppCount;
    });

  const watchlist = [...closedWon, ...openPipeline].slice(0, limit);
  return { watchlist, watchlistSource };
}

async function runSponsorNewsCrawl(getDb, opts = {}) {
  const database = getDb();
  await ensureNewsContainer(database);
  const maxSponsors = Math.min(Number(opts.maxSponsors) || 25, 60);
  const { watchlist, watchlistSource } = await loadWatchlist(database, { limit: maxSponsors });
  if (!watchlist.length) {
    return {
      ok: false,
      error:
        "No Salesforce sponsor watchlist — run Ingest SF first (need Closed Won and/or open pipeline accounts).",
      upserted: 0,
      watchlistSource
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
        watchPriority: sponsor.watchPriority || null,
        closedWonCount: sponsor.closedWonCount ?? null,
        oraNetWonSum: sponsor.oraNetWonSum ?? null,
        openOppCount: sponsor.openOppCount ?? null,
        openOraNetSum: sponsor.openOraNetSum ?? null,
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
      watchlistSource,
      mode: "google_news_rss",
      note:
        "Sponsor headlines from Google News RSS — Closed Won SF accounts first, then open-pipeline fill (not ZoomInfo)."
    });
  } catch (_) {
    /* syncState optional */
  }

  return {
    ok: upserted > 0,
    upserted,
    errors,
    watchlistSize: watchlist.length,
    watchlistSource,
    samples,
    crawledAt: now,
    note:
      "Stored in ora_sponsor_news (Closed Won priority, open-pipeline fill). Not a commercial intel product — headlines only."
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
          watchlistSize: resource.watchlistSize,
          watchlistSource: resource.watchlistSource || null
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
  return {
    count,
    sync,
    note: "Google News RSS crawl (Closed Won priority + open-pipeline fill) → ora_sponsor_news"
  };
}

const BD_HEADLINE_BOOSTS = [
  [/clinical\s+trial|phase\s+[123]|fda|nda|bla|approval|breakthrough/i, 3],
  [/ophthalm|retina|glaucoma|dry\s*eye|macular|uveitis|cataract/i, 3],
  [/partnership|collaborat|acqui|merger|funding|raise|invest/i, 2],
  [/cro|enrollment|site|feasibility|sponsor/i, 2],
  [/biotech|pharma|therapeutic|pipeline|drug/i, 1]
];

function parsePubDateMs(pubDate) {
  if (!pubDate) return null;
  const t = Date.parse(String(pubDate));
  return Number.isFinite(t) ? t : null;
}

function scoreHeadline(title, source) {
  const blob = `${String(title || "")} ${String(source || "")}`.toLowerCase();
  let score = 0;
  for (const [re, w] of BD_HEADLINE_BOOSTS) {
    if (re.test(blob)) score += w;
  }
  if (/stock price|share price|analyst rating|dividend|earnings per share/i.test(blob)) score -= 1;
  return score;
}

/** Strip publisher suffix from Google News titles for a readable one-line overview. */
function headlineOverview(title, source) {
  let t = String(title || "").trim();
  if (!t) return "";
  const src = String(source || "").trim();
  if (src) {
    for (const sep of [" - ", " | ", " — "]) {
      const suffix = `${sep}${src}`;
      if (t.endsWith(suffix)) {
        t = t.slice(0, -suffix.length).trim();
        break;
      }
    }
  }
  return t.length > 240 ? `${t.slice(0, 237)}…` : t;
}

/**
 * Flatten + rank headlines across crawled sponsors for Buddy triage and Dashboard feed.
 */
async function buildTopSponsorNewsFeed(getDb, opts = {}) {
  const limit = Math.min(Number(opts.limit) || 12, 25);
  const hint = String(opts.sponsor || opts.clientName || "").trim().toLowerCase();
  const database = getDb();
  try {
    let rows;
    if (hint) {
      rows = await queryAll(
        database.container(NEWS_CONTAINER),
        `SELECT TOP 20 c.sponsorName, c.headlines, c.crawledAt, c.sfAccountId
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
        `SELECT TOP 40 c.sponsorName, c.headlines, c.crawledAt, c.sfAccountId
         FROM c WHERE c.docType = @t`,
        [{ name: "@t", value: NEWS_DOC_TYPE }]
      );
    }

    const flat = [];
    for (const row of rows) {
      for (const h of row.headlines || []) {
        const ts =
          parsePubDateMs(h.pubDate) ||
          parsePubDateMs(row.crawledAt) ||
          0;
        flat.push({
          sponsorName: row.sponsorName,
          title: h.title,
          overview: headlineOverview(h.title, h.source),
          link: h.link || null,
          pubDate: h.pubDate || null,
          source: h.source || null,
          crawledAt: row.crawledAt || null,
          sfAccountId: row.sfAccountId || null,
          score: scoreHeadline(h.title, h.source),
          ts
        });
      }
    }

    flat.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      return (b.ts || 0) - (a.ts || 0);
    });

    const headlines = flat.slice(0, limit);
    let sync = null;
    try {
      const status = await getSponsorNewsStatus(getDb);
      sync = status.sync || null;
    } catch (_) {
      sync = null;
    }

    const lastCrawledAt =
      headlines[0]?.crawledAt ||
      rows.reduce((best, r) => {
        const t = parsePubDateMs(r.crawledAt);
        return t && t > best ? t : best;
      }, 0) ||
      null;

    return {
      empty: !headlines.length,
      sponsorCount: rows.length,
      headlineCount: flat.length,
      headlines,
      lastCrawledAt: lastCrawledAt ? new Date(lastCrawledAt).toISOString() : null,
      sync,
      note:
        "Ranked Google News RSS headlines for watched SF sponsors (Closed Won priority + open-pipeline fill; ora_sponsor_news). Triage BD signal vs noise — not ZoomInfo."
    };
  } catch (err) {
    return { error: String(err.message || err), empty: true };
  }
}

/** Attach lightweight feed (always) + optional full pack on sponsor-news asks or named sponsor. */
async function attachSponsorNewsToIntel(out, getDb, opts = {}) {
  const { question = "", sponsor = null, clientName = null, feedLimit = 12 } = opts;
  const who = sponsor || clientName;
  try {
    out.sponsorNewsFeed = await buildTopSponsorNewsFeed(getDb, {
      limit: feedLimit,
      sponsor: who,
      clientName: who
    });
    if (isSponsorNewsQuestion(question) || who) {
      out.sponsorNews = await buildSponsorNewsPack(getDb, {
        sponsor: who,
        clientName: who || clientName
      });
    }
  } catch (err) {
    out.sponsorNewsFeed = { error: String(err.message || err), empty: true };
  }
  return out;
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
  return (
    /\b(sponsor news|sponsor headlines?|news crawl|crawl(ed)? news|google news|top news|ora_sponsor_news)\b/.test(
      q
    ) ||
    /\b(news about|headlines?|press (release|coverage)|in the news|what.*news|any news)\b/.test(q) ||
    /\bnews\b.{0,40}\b(sponsor|client|account)\b/.test(q) ||
    /\b(sponsor|client|account)\b.{0,40}\bnews\b/.test(q)
  );
}

module.exports = {
  NEWS_CONTAINER,
  NEWS_DOC_TYPE,
  runSponsorNewsCrawl,
  getSponsorNewsStatus,
  buildTopSponsorNewsFeed,
  attachSponsorNewsToIntel,
  buildSponsorNewsPack,
  isSponsorNewsQuestion,
  headlineOverview
};
