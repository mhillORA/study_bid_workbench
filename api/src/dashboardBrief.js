/**
 * Commercial Dashboard brief — structured chase / watch / concentration pack
 * refreshed after nightly sync so leadership and BD open to numbers, not a blank ask box.
 *
 * Dollars = Total Ora Net Revenue (never SF Amount / contract).
 * No company-distress framing — operational commercial OS only.
 */

const {
  buildSalesforceBuddyContext
} = require("./salesforceTables");
const { getIntelligenceHealth } = require("./intelligence");

const BRIEF_ID = "dashboard_weekly_brief";
const ATTENTION_CLOSE_DAYS = 14;

function weekLabel(d = new Date()) {
  const day = d.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + mondayOffset));
  const opts = { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" };
  return `Week of ${monday.toLocaleDateString("en-US", opts)}`;
}

function daysUntilClose(closeDate, now = new Date()) {
  if (!closeDate) return null;
  const s = String(closeDate).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const close = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((close - today) / 86400000);
}

function moneyRound(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x) : 0;
}

function pickRevenue(o) {
  if (!o || typeof o !== "object") return null;
  const candidates = [
    process.env.SF_OPP_REVENUE_FIELD,
    "Total_Ora_Net_Revenue__c",
    "Total_Ora_Net_Rev__c",
    "Ora_Net_Revenue__c",
    "Total_Ora_Net_Revenue"
  ].filter(Boolean);
  for (const f of candidates) {
    if (o[f] != null && o[f] !== "") {
      const n = Number(o[f]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function isOpenOpp(o) {
  if (o.IsClosed === true || o.IsClosed === "true") return false;
  const stage = String(o.StageName || "").toLowerCase();
  if (/^closed\b/.test(stage)) return false;
  return true;
}

async function queryAll(container, query, parameters = []) {
  const out = [];
  const iter = container.items.query(
    { query, parameters },
    { maxItemCount: 500 }
  );
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (resources?.length) out.push(...resources);
  }
  return out;
}

async function loadOpenOpportunities(getDb) {
  const database = getDb();
  const rows = await queryAll(
    database.container("ora_sf_opportunity"),
    `SELECT c.id, c.Name, c.StageName, c.Amount, c.Total_Ora_Net_Revenue__c, c.CloseDate,
            c.AccountId, c.OwnerName, c.IsClosed, c.IsWon
     FROM c WHERE c.docType = @t`,
    [{ name: "@t", value: "ora_sf_opportunity" }]
  );
  const open = rows.filter(isOpenOpp);
  const accountIds = [...new Set(open.map((o) => o.AccountId).filter(Boolean))];
  const nameById = new Map();
  if (accountIds.length) {
    const accts = await queryAll(
      database.container("ora_sf_account"),
      `SELECT c.id, c.Name FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_sf_account" }]
    );
    for (const a of accts) {
      if (a.id) nameById.set(a.id, a.Name || null);
    }
  }
  return open.map((o) => ({
    id: o.id,
    name: o.Name,
    stage: o.StageName || null,
    owner: o.OwnerName || null,
    accountId: o.AccountId || null,
    accountName: (o.AccountId && nameById.get(o.AccountId)) || null,
    amount: pickRevenue(o),
    closeDate: o.CloseDate || null
  }));
}

async function readSyncStamp(database, id) {
  try {
    const { resource } = await database.container("syncState").item(id, id).read();
    if (!resource) return null;
    return {
      lastSuccessfulSync: resource.lastSuccessfulSync || null,
      lastRunAt: resource.lastRunAt || null,
      mode: resource.mode || null
    };
  } catch (_) {
    return null;
  }
}

async function loadCachedBrief(getDb) {
  try {
    const database = getDb();
    const { resource } = await database.container("syncState").item(BRIEF_ID, BRIEF_ID).read();
    if (!resource || !resource.brief) return null;
    return {
      ...resource.brief,
      cached: true,
      cacheId: BRIEF_ID,
      cachedAt: resource.generatedAt || resource.brief.generatedAt || null
    };
  } catch (_) {
    return null;
  }
}

async function saveCachedBrief(getDb, brief) {
  const database = getDb();
  const generatedAt = brief.generatedAt || new Date().toISOString();
  const doc = {
    id: BRIEF_ID,
    docType: "syncState",
    job: BRIEF_ID,
    generatedAt,
    brief: { ...brief, cached: undefined, cacheId: undefined, cachedAt: undefined }
  };
  await database.container("syncState").items.upsert(doc);
  return { ...brief, cached: true, cacheId: BRIEF_ID, cachedAt: generatedAt };
}

/**
 * Build a fresh weekly commercial brief from SF + bid portfolio + data freshness.
 * @param {Function} getDb
 * @param {{ buildPortfolioContext?: Function, triggeredBy?: string }} opts
 */
async function buildDashboardBrief(getDb, opts = {}) {
  const started = Date.now();
  const triggeredBy = opts.triggeredBy || "api";
  const now = new Date();

  const sfPromise = buildSalesforceBuddyContext(getDb, {
    question: "open pipeline opportunities Total Ora Net Revenue by owner account"
  });
  const healthPromise = getIntelligenceHealth(getDb).catch((err) => ({
    ok: false,
    error: String(err.message || err)
  }));
  const portfolioPromise =
    typeof opts.buildPortfolioContext === "function"
      ? opts.buildPortfolioContext({ limit: 500 }).catch((err) => ({
          error: String(err.message || err)
        }))
      : Promise.resolve(null);
  const openPromise = loadOpenOpportunities(getDb).catch((err) => {
    console.warn("[dashboardBrief] open opps", err.message || err);
    return [];
  });

  const database = getDb();
  const [sf, health, portfolio, openOpps, veevaStamp] = await Promise.all([
    sfPromise,
    healthPromise,
    portfolioPromise,
    openPromise,
    readSyncStamp(database, "veeva_tables")
  ]);

  const chase = [...openOpps]
    .sort((a, b) => moneyRound(b.amount) - moneyRound(a.amount))
    .slice(0, 12)
    .map((o) => {
      const days = daysUntilClose(o.closeDate, now);
      return {
        id: o.id,
        name: o.name,
        accountName: o.accountName || null,
        stage: o.stage || null,
        owner: o.owner || null,
        oraNetRevenue: moneyRound(o.amount),
        closeDate: o.closeDate || null,
        daysToClose: days
      };
    });

  const attention = [];
  for (const o of openOpps) {
    const days = daysUntilClose(o.closeDate, now);
    const rev = o.amount;
    const owner = String(o.owner || "").trim();
    const flags = [];
    if (!owner || /^unknown$/i.test(owner)) flags.push("no_owner");
    if (rev == null || !Number.isFinite(Number(rev)) || Number(rev) <= 0) flags.push("missing_ora_net_revenue");
    if (days != null && days < 0) flags.push("close_date_past");
    else if (days != null && days <= ATTENTION_CLOSE_DAYS) flags.push("close_soon");
    if (!flags.length) continue;
    attention.push({
      id: o.id,
      name: o.name,
      accountName: o.accountName || null,
      stage: o.stage || null,
      owner: o.owner || null,
      oraNetRevenue: moneyRound(o.amount),
      closeDate: o.closeDate || null,
      daysToClose: days,
      flags
    });
  }
  attention.sort((a, b) => {
    const rank = (f) =>
      (f.includes("close_date_past") ? 40 : 0) +
      (f.includes("no_owner") ? 30 : 0) +
      (f.includes("missing_ora_net_revenue") ? 20 : 0) +
      (f.includes("close_soon") ? 10 : 0);
    return rank(b.flags) - rank(a.flags) || moneyRound(b.oraNetRevenue) - moneyRound(a.oraNetRevenue);
  });

  const owners = (sf.pipelineSummary?.openByOwner || sf.ownerBreakdown || [])
    .slice(0, 10)
    .map((r) => ({
      owner: r.owner,
      openCount: r.n,
      oraNetRevenue: moneyRound(r.amountSum)
    }));

  const accounts = (sf.openAccounts || [])
    .slice(0, 12)
    .map((a) => ({
      accountId: a.accountId,
      accountName: a.accountName,
      openOppCount: a.openOppCount,
      oraNetRevenue: moneyRound(a.openAmountSum)
    }));

  const ps = sf.pipelineSummary || {};
  const ytdYear = now.getUTCFullYear();
  const wonYtd = (ps.closedWonByYear || []).find((r) => Number(r.year) === ytdYear) || null;

  const bidClients = (portfolio?.byClient || [])
    .slice(0, 10)
    .map((c) => ({
      client: c.clientName || c.client || c.name,
      studyCount: c.n || c.studyCount || 0,
      grandTotal: moneyRound(c.grandTotal),
      serviceFees: moneyRound(c.serviceFees),
      pctOfGrandTotal: c.pctOfGrandTotal != null ? Number(c.pctOfGrandTotal) : null
    }));

  const dataFreshness = {
    ctgov: health?.ctgov?.sync || null,
    salesforce: health?.salesforce?.sync || null,
    veeva: veevaStamp,
    counts: {
      sfOpportunities: health?.liveCounts?.ora_sf_opportunity ?? ps.universe ?? null,
      sfAccounts: health?.liveCounts?.ora_sf_account ?? null,
      veevaStudies: health?.liveCounts?.ora_veeva_study ?? null,
      veevaSites: health?.liveCounts?.ora_veeva_site ?? null,
      ctgovTrials: health?.liveCounts?.ora_ctgov_trials ?? null,
      bidStudies: portfolio?.matchedStudyCount ?? portfolio?.databaseStudyCount ?? null
    },
    healthOk: health?.ok !== false && !health?.error
  };

  const headline = {
    openPipelineOraNet: moneyRound(ps.openAmountSum),
    openOppCount: ps.openCount != null ? Number(ps.openCount) : openOpps.length,
    closedWonYtdOraNet: wonYtd ? moneyRound(wonYtd.amountSum) : null,
    closedWonYtdCount: wonYtd ? Number(wonYtd.n) : null,
    closedWonYtdYear: ytdYear,
    bidPortfolioGrandTotal: moneyRound(portfolio?.totals?.grandTotal),
    bidStudyCount: portfolio?.matchedStudyCount ?? portfolio?.databaseStudyCount ?? null,
    revenueField: ps.revenueField || "Total_Ora_Net_Revenue__c",
    revenueFieldLabel: ps.revenueFieldLabel || "Total Ora Net Revenue"
  };

  const loops = [
    {
      id: "chase",
      title: "Chase this week",
      blurb: "Highest open Ora Net Revenue opportunities — protect BD time here first.",
      count: chase.length,
      metric: headline.openPipelineOraNet
    },
    {
      id: "watch",
      title: "Watch / reassess",
      blurb: "Open deals missing owner, missing Ora Net Revenue, or with a close date at risk.",
      count: attention.length,
      metric: attention.length
    },
    {
      id: "owners",
      title: "Owner coverage",
      blurb: "Open pipeline by Salesforce owner (Ora Net Revenue).",
      count: owners.length,
      metric: owners.reduce((s, o) => s + o.oraNetRevenue, 0)
    },
    {
      id: "concentration",
      title: "Client concentration",
      blurb: "Top open accounts (SF) and top clients by uploaded bid fees (portfolio).",
      count: Math.max(accounts.length, bidClients.length),
      metric: accounts[0]?.oraNetRevenue ?? bidClients[0]?.grandTotal ?? 0
    },
    {
      id: "data",
      title: "Data ready for bids",
      blurb: "Nightly CT.gov / Veeva / Salesforce freshness — feasibility and pipeline numbers you can trust.",
      count: dataFreshness.healthOk ? 1 : 0,
      metric: dataFreshness.counts.veevaSites
    }
  ];

  const brief = {
    ok: true,
    generatedAt: now.toISOString(),
    weekLabel: weekLabel(now),
    triggeredBy,
    headline,
    chase,
    attention: attention.slice(0, 20),
    owners,
    accounts,
    bidConcentration: bidClients,
    highestBudgetStudies: (portfolio?.highestBudgetStudies || []).slice(0, 6).map((s) => ({
      studyId: s.studyId,
      clientName: s.clientName,
      grandTotal: moneyRound(s.grandTotal),
      enrolledSubjects: s.enrolledSubjects
    })),
    dataFreshness,
    loops,
    salesforceEmpty: Boolean(sf.empty),
    salesforceError: sf.error || null,
    portfolioError: portfolio?.error || null,
    notes: [
      "Pipeline $ = Total Ora Net Revenue (Total_Ora_Net_Revenue__c), never Amount/contract.",
      "Uploaded bid fees (portfolio) are a different source from Salesforce pipeline.",
      "Brief is rebuilt after nightly intelligence sync and on Dashboard refresh.",
      "Use Produce leadership visual for a shareable HTML leave-behind."
    ],
    elapsedMs: Date.now() - started
  };

  return brief;
}

/**
 * GET path helper: return cache unless refresh or stale/missing.
 * @param {number} maxAgeHours — treat cache fresher than this as OK (default 20h so morning users see overnight build)
 */
async function getOrBuildDashboardBrief(getDb, opts = {}) {
  const refresh = opts.refresh === true;
  const maxAgeHours = opts.maxAgeHours != null ? Number(opts.maxAgeHours) : 20;
  if (!refresh) {
    const cached = await loadCachedBrief(getDb);
    if (cached?.generatedAt) {
      const ageMs = Date.now() - new Date(cached.generatedAt).getTime();
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < maxAgeHours * 3600 * 1000) {
        return cached;
      }
    }
  }
  const brief = await buildDashboardBrief(getDb, opts);
  try {
    return await saveCachedBrief(getDb, brief);
  } catch (err) {
    return { ...brief, cached: false, cacheError: String(err.message || err) };
  }
}

module.exports = {
  BRIEF_ID,
  weekLabel,
  loadCachedBrief,
  saveCachedBrief,
  buildDashboardBrief,
  getOrBuildDashboardBrief
};
