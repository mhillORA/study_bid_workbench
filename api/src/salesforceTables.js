/**
 * Full Salesforce table sync → Cosmos + Buddy context packs.
 * Objects (user-confirmed): Account, Opportunity, Activity_Request__c only.
 */

const {
  salesforceConfig,
  getSalesforceAccessToken,
  queryFullObject
} = require("./salesforceClient");

const SYNC_ID = "salesforce_tables";
const TIME_BUDGET_MS = Number(process.env.SF_TABLE_SYNC_BUDGET_MS || 110000);

const SF_TABLES = [
  { sfObject: "Account", container: "ora_sf_account", docType: "ora_sf_account" },
  { sfObject: "Opportunity", container: "ora_sf_opportunity", docType: "ora_sf_opportunity" },
  {
    sfObject: "Activity_Request__c",
    container: "ora_sf_activity_request",
    docType: "ora_sf_activity_request"
  }
];

async function ensureContainer(database, containerId) {
  try {
    await database.containers.createIfNotExists({
      id: containerId,
      partitionKey: { paths: ["/id"] }
    });
  } catch (_) {
    /* may already exist with same PK */
  }
  return database.container(containerId);
}

async function queryAll(container, query, parameters = []) {
  const { resources } = await container.items
    .query({ query, parameters }, { enableCrossPartitionQuery: true })
    .fetchAll();
  return resources || [];
}

async function readSyncState(database) {
  try {
    const { resource } = await database.container("syncState").item(SYNC_ID, SYNC_ID).read();
    return resource || null;
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
  }
}

async function writeSyncState(database, patch) {
  const prev = (await readSyncState(database)) || {};
  const doc = {
    ...prev,
    id: SYNC_ID,
    docType: "syncState",
    job: SYNC_ID,
    ...patch
  };
  await database.container("syncState").items.upsert(doc);
  return doc;
}

function flattenSfRecord(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec || {})) {
    if (k === "attributes") continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      // Owner: { Name, ... } → OwnerName
      if (v.Name != null) out[`${k}Name`] = v.Name;
      if (v.Id != null) out[`${k}Id`] = v.Id;
      continue;
    }
    out[k] = v;
  }
  return out;
}

function toCosmosDoc(rec, docType, syncedAt) {
  const flat = flattenSfRecord(rec);
  const sfId = String(flat.Id || "").trim();
  if (!sfId) return null;
  return {
    ...flat,
    id: sfId,
    sfId,
    docType,
    sfSyncedAt: syncedAt,
    sfSyncSource: "salesforce_tables"
  };
}

/**
 * Sync one or all SF tables into Cosmos.
 * @param {Function} getDb
 * @param {{ triggeredBy?: string, only?: string[], maxRecords?: number }} opts
 */
async function runSalesforceTablesSync(getDb, opts = {}) {
  const started = Date.now();
  const cfg = salesforceConfig();
  if (!cfg.configured) {
    return {
      ok: false,
      skipped: true,
      reason: "not_configured",
      error: "Salesforce not configured on ora-buddy-api — set SF_CLIENT_ID + SF_USERNAME (and JWT key B64 or Data Status key upload).",
      elapsedMs: 0
    };
  }

  let session;
  try {
    session = await getSalesforceAccessToken(cfg, getDb);
  } catch (err) {
    return { ok: false, error: String(err.message || err), elapsedMs: Date.now() - started };
  }

  const database = getDb();
  const only = Array.isArray(opts.only) && opts.only.length
    ? opts.only.map((s) => String(s).toLowerCase())
    : null;
  const tables = only
    ? SF_TABLES.filter(
        (t) =>
          only.includes(t.sfObject.toLowerCase()) ||
          only.includes(t.container.toLowerCase()) ||
          only.includes(t.docType.toLowerCase())
      )
    : SF_TABLES;

  const results = [];
  let incomplete = false;

  for (const table of tables) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      incomplete = true;
      results.push({
        object: table.sfObject,
        container: table.container,
        skipped: true,
        reason: "time_budget"
      });
      continue;
    }
    const t0 = Date.now();
    try {
      const container = await ensureContainer(database, table.container);
      const pulled = await queryFullObject(session, table.sfObject, {
        maxRecords: opts.maxRecords || null
      });
      const syncedAt = new Date().toISOString();
      let upserted = 0;
      const errors = [];
      for (const rec of pulled.records) {
        if (Date.now() - started > TIME_BUDGET_MS) {
          incomplete = true;
          break;
        }
        const doc = toCosmosDoc(rec, table.docType, syncedAt);
        if (!doc) continue;
        try {
          await container.items.upsert(doc);
          upserted += 1;
        } catch (err) {
          errors.push(`${doc.id}: ${err.message || err}`);
          if (errors.length > 15) break;
        }
      }
      results.push({
        object: table.sfObject,
        container: table.container,
        fetched: pulled.records.length,
        upserted,
        fieldsUsed: pulled.fields.length,
        errorCount: errors.length,
        errors: errors.slice(0, 5),
        note: pulled.note || undefined,
        elapsedMs: Date.now() - t0
      });
    } catch (err) {
      results.push({
        object: table.sfObject,
        container: table.container,
        ok: false,
        error: String(err.message || err),
        elapsedMs: Date.now() - t0
      });
    }
  }

  const hardFail = results.length > 0 && results.every((r) => r.error || r.ok === false);
  const state = await writeSyncState(database, {
    lastRunAt: new Date().toISOString(),
    lastSuccessfulSync: hardFail ? undefined : new Date().toISOString(),
    mode: "tables",
    triggeredBy: opts.triggeredBy || "api",
    lastDeltas: { results, incomplete },
    note: incomplete
      ? "Time budget hit — re-run Sync SF tables to continue remaining objects."
      : "Full Salesforce table sync into ora_sf_* (Account, Opportunity, Activity_Request__c)."
  });

  const out = {
    ok: !hardFail,
    mode: "tables",
    incomplete,
    results,
    elapsedMs: Date.now() - started,
    sync: state
  };

  // Default: after ingest, refresh sponsor crosswalk from Cosmos Accounts
  const thenCrosswalk = opts.thenCrosswalk !== false;
  if (thenCrosswalk && !hardFail) {
    try {
      const { runSalesforceCrosswalkSync } = require("./salesforceSync");
      out.crosswalk = await runSalesforceCrosswalkSync(getDb, {
        triggeredBy: opts.triggeredBy || "api",
        dryRun: false
      });
    } catch (err) {
      out.crosswalk = { ok: false, error: String(err.message || err) };
    }
  }

  return out;
}

async function countDocType(database, containerId, docType) {
  try {
    const rows = await queryAll(
      database.container(containerId),
      "SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t",
      [{ name: "@t", value: docType }]
    );
    return rows[0] || 0;
  } catch (_) {
    return null;
  }
}

async function getSalesforceTablesStatus(getDb) {
  const database = getDb();
  const state = await readSyncState(database);
  const counts = {};
  for (const t of SF_TABLES) {
    counts[t.container] = await countDocType(database, t.container, t.docType);
  }
  return {
    tables: SF_TABLES.map((t) => ({
      sfObject: t.sfObject,
      container: t.container,
      count: counts[t.container]
    })),
    sync: state
      ? {
          lastSuccessfulSync: state.lastSuccessfulSync || null,
          lastRunAt: state.lastRunAt || null,
          mode: state.mode || null,
          note: state.note || null,
          lastDeltas: state.lastDeltas || null
        }
      : null
  };
}

function isSalesforceDataQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  return (
    /\b(salesforce|\bsf\b|ora grouping|activity request|\bars?\b)\b/.test(q) ||
    /\b(opportunit(?:y|ies)|pipeline|stage|close date|open opps?)\b/.test(q) ||
    /\b(product2|sf services|opportunity line)\b/.test(q) ||
    /\b(who owns|account owner|bd owner|tier)\b/.test(q) ||
    /\b(accounts? in (sf|salesforce)|sf accounts?)\b/.test(q) ||
    /\b(bd activity|activity requests?)\b/.test(q) ||
    /\b(crm|account tier|sf owner|closed\s*won|closed\s*lost)\b/.test(q)
  );
}

function extractSfNameHint(question) {
  const q = String(question || "");
  const m = q.match(
    /\b(?:account|sponsor|client|company|for|about|with)\s+([A-Za-z0-9][A-Za-z0-9 .,&'+-]{1,50?}?)(?:\s+in\s+|\s+opport|\s+owner|\s+tier|\s+pipeline|\?|$)/i
  );
  if (m) return m[1].trim().replace(/[?.!,;:]+$/, "");
  return null;
}

/** Parse SF opportunity ask intent from natural language. */
function extractSfOppIntent(question) {
  const q = String(question || "").toLowerCase();
  const yearMatch =
    q.match(/\b(?:calendar|fy|fiscal|cy)?\s*(20\d{2})\b/) ||
    q.match(/\b(20\d{2})\s*(?:calendar|fy|fiscal)?\b/);
  let year = yearMatch ? Number(yearMatch[1] || yearMatch[2]) : null;
  if (!year && /\b(this year|calendar year|ytd|year to date)\b/.test(q)) {
    year = new Date().getUTCFullYear();
  }
  if (/\bcalendar\b/.test(q) && !year) year = new Date().getUTCFullYear();

  const closedWon = /\bclosed\s*[- ]?won\b/.test(q);
  const closedLost = /\bclosed\s*[- ]?lost\b/.test(q);
  const openOnly =
    (/\bopen\b/.test(q) || /\bpipeline\b/.test(q) || /\bactive\b/.test(q)) &&
    !closedWon &&
    !closedLost &&
    !/\bclosed\b/.test(q);
  const accountsWithOpen =
    /\baccounts?\b/.test(q) &&
    (/\bopen\b/.test(q) || /\bpipeline\b/.test(q) || /\bopportunit/.test(q));
  const byOwner = /\b(owner|rep|ae|bd lead|who(?:'s| is) doing|by owner)\b/.test(q);

  return {
    year,
    openOnly: openOnly || accountsWithOpen,
    closedWon,
    closedLost,
    accountsWithOpen,
    byOwner,
    calendar: /\bcalendar\b/.test(q)
  };
}

function isOppOpen(o) {
  if (o.IsClosed === true || o.IsClosed === "true") return false;
  const stage = String(o.StageName || "").toLowerCase();
  if (/^closed\b/.test(stage)) return false;
  return true;
}

function isOppClosedWon(o) {
  if (o.IsWon === true || o.IsWon === "true") return true;
  return /^closed\s*won$/i.test(String(o.StageName || "").trim());
}

function closeYear(closeDate) {
  if (!closeDate) return null;
  const s = String(closeDate);
  const m = s.match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

function closeInYear(closeDate, year) {
  if (!year) return true;
  return closeYear(closeDate) === year;
}

/**
 * SF opportunity dollars for Buddy: Total Ora Net Revenue — never standard Amount (contract).
 * Override with SF_OPP_REVENUE_FIELD if the API name differs in the org.
 */
const SF_OPP_REVENUE_FIELD_CANDIDATES = [
  process.env.SF_OPP_REVENUE_FIELD,
  "Total_Ora_Net_Revenue__c",
  "Total_Ora_Net_Rev__c",
  "Ora_Net_Revenue__c",
  "Total_Ora_Net_Revenue"
].filter(Boolean);

function pickOppRevenue(o) {
  if (!o || typeof o !== "object") return { value: null, field: null };
  for (const f of SF_OPP_REVENUE_FIELD_CANDIDATES) {
    if (o[f] != null && o[f] !== "") {
      const n = Number(o[f]);
      if (Number.isFinite(n)) return { value: n, field: f };
    }
  }
  for (const k of Object.keys(o)) {
    if (/^total_?ora_?net_?rev/i.test(k) || /total.?ora.?net.?revenue/i.test(k)) {
      if (o[k] != null && o[k] !== "") {
        const n = Number(o[k]);
        if (Number.isFinite(n)) return { value: n, field: k };
      }
    }
  }
  return { value: null, field: null };
}

function oppRevenueNumber(o) {
  const picked = pickOppRevenue(o);
  return picked.value != null && Number.isFinite(picked.value) ? picked.value : 0;
}

function mapOppRow(o, accountNameById = null) {
  const rev = pickOppRevenue(o);
  return {
    id: o.id || o.Id,
    name: o.Name,
    stage: o.StageName,
    // amount = Total Ora Net Revenue (not Amount / contract)
    amount: rev.value,
    amountField: rev.field || "Total_Ora_Net_Revenue__c",
    contractAmount: o.Amount != null ? Number(o.Amount) : null,
    closeDate: o.CloseDate || null,
    accountId: o.AccountId || null,
    accountName: (accountNameById && o.AccountId && accountNameById.get(o.AccountId)) || null,
    owner: o.OwnerName || null,
    isClosed: o.IsClosed === true || o.IsClosed === "true",
    isWon: o.IsWon === true || o.IsWon === "true",
    isOpen: isOppOpen(o)
  };
}

/**
 * Bounded SF pack for Buddy asks — aggregates over ALL Cosmos opp rows (not a 200-row sample).
 */
async function buildSalesforceBuddyContext(getDb, ops = {}) {
  const opts = ops || {};
  const question = String(opts.question || "");
  const clientName = String(opts.clientName || opts.sponsor || "").trim() || null;
  const nameHint = extractSfNameHint(question) || clientName;
  const intent = extractSfOppIntent(question);
  const database = getDb();
  const started = Date.now();

  const counts = {};
  for (const t of SF_TABLES) {
    counts[t.container] = await countDocType(database, t.container, t.docType);
  }
  const anyData = Object.values(counts).some((n) => typeof n === "number" && n > 0);

  const out = {
    source: "salesforce_cosmos",
    note:
      "Live Salesforce mirrors in Cosmos (ora_sf_*). Opportunity dollars = Total Ora Net Revenue (Total_Ora_Net_Revenue__c) — never Amount/contract. Aggregates scan ALL opportunity rows. Prefer this pack for CRM/pipeline; portfolio.byClient is Ora bid fees only.",
    counts,
    query: { nameHint, clientName, intent },
    accounts: [],
    opportunities: [],
    activityRequests: [],
    openAccounts: [],
    filteredOpportunities: [],
    ownerBreakdown: []
  };

  if (!anyData) {
    out.empty = true;
    out.note =
      "ora_sf_* containers are empty — run Data Status → Ingest SF + crosswalk (after SF_* App Settings). Until then use sponsorCrosswalk for owner/tier/grouping only.";
    out.elapsedMs = Date.now() - started;
    return out;
  }

  try {
    // Full lean scan of opportunities (6k rows is fine for Cosmos SQL)
    const allOpps = await queryAll(
      database.container("ora_sf_opportunity"),
      `SELECT c.id, c.Name, c.StageName, c.Amount, c.Total_Ora_Net_Revenue__c, c.CloseDate,
              c.AccountId, c.OwnerName, c.IsClosed, c.IsWon
       FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_sf_opportunity" }]
    );

    let openCount = 0;
    let openAmount = 0;
    let closedWonCount = 0;
    let closedWonAmount = 0;
    let revenueFieldHits = 0;
    const byStage = {};
    const openByOwner = {};
    const wonByYear = {};
    const openByAccountId = {};

    for (const o of allOpps) {
      const stage = String(o.StageName || "Unknown");
      byStage[stage] = (byStage[stage] || 0) + 1;
      const rev = pickOppRevenue(o);
      if (rev.field) revenueFieldHits += 1;
      const amt = rev.value != null ? rev.value : 0;
      const open = isOppOpen(o);
      if (open) {
        openCount += 1;
        openAmount += amt;
        const owner = String(o.OwnerName || "Unknown");
        if (!openByOwner[owner]) openByOwner[owner] = { owner, n: 0, amountSum: 0 };
        openByOwner[owner].n += 1;
        openByOwner[owner].amountSum += amt;
        const aid = o.AccountId;
        if (aid) {
          if (!openByAccountId[aid]) openByAccountId[aid] = { accountId: aid, n: 0, amountSum: 0 };
          openByAccountId[aid].n += 1;
          openByAccountId[aid].amountSum += amt;
        }
      }
      if (isOppClosedWon(o)) {
        closedWonCount += 1;
        closedWonAmount += amt;
        const y = closeYear(o.CloseDate) || "unknown";
        if (!wonByYear[y]) wonByYear[y] = { year: y, n: 0, amountSum: 0 };
        wonByYear[y].n += 1;
        wonByYear[y].amountSum += amt;
      }
    }

    out.pipelineSummary = {
      universe: allOpps.length,
      scannedAll: true,
      revenueField: "Total_Ora_Net_Revenue__c",
      revenueFieldLabel: "Total Ora Net Revenue",
      revenueFieldHits,
      sampleNote:
        "NOT a sample — counts cover every ora_sf_opportunity row. Dollars = Total Ora Net Revenue (not Amount/contract).",
      openCount,
      openAmountSum: Math.round(openAmount),
      closedWonCount,
      closedWonAmountSum: Math.round(closedWonAmount),
      stageCounts: Object.entries(byStage)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([stage, n]) => ({ stage, n })),
      closedWonByYear: Object.values(wonByYear)
        .sort((a, b) => String(b.year).localeCompare(String(a.year)))
        .slice(0, 15)
        .map((r) => ({ ...r, amountSum: Math.round(r.amountSum) })),
      openByOwner: Object.values(openByOwner)
        .sort((a, b) => b.amountSum - a.amountSum || b.n - a.n)
        .slice(0, 25)
        .map((r) => ({ ...r, amountSum: Math.round(r.amountSum) }))
    };

    // Resolve account names for open-pipeline accounts
    const openAccountIds = Object.keys(openByAccountId);
    const accountNameById = new Map();
    if (openAccountIds.length) {
      // Batch CONTAINS is awkward — pull accounts we need via id IN chunks, or full lean Name map
      const acctRows = await queryAll(
        database.container("ora_sf_account"),
        `SELECT c.id, c.Name, c.OwnerName, c.Tier__c, c.Ora_Grouping__c FROM c WHERE c.docType = @t`,
        [{ name: "@t", value: "ora_sf_account" }]
      );
      for (const a of acctRows) {
        if (a.id) accountNameById.set(a.id, a.Name || null);
      }
      out.openAccounts = Object.values(openByAccountId)
        .map((r) => ({
          accountId: r.accountId,
          accountName: accountNameById.get(r.accountId) || null,
          openOppCount: r.n,
          openAmountSum: Math.round(r.amountSum)
        }))
        .sort((a, b) => b.openAmountSum - a.openAmountSum || b.openOppCount - a.openOppCount)
        .slice(0, 40);
    }

    // Filtered list for the ask
    let filtered = allOpps;
    if (intent.openOnly || intent.accountsWithOpen) {
      filtered = filtered.filter(isOppOpen);
    }
    if (intent.closedWon) {
      filtered = filtered.filter(isOppClosedWon);
    }
    if (intent.closedLost) {
      filtered = filtered.filter((o) => /^closed\s*lost$/i.test(String(o.StageName || "")));
    }
    if (intent.year) {
      filtered = filtered.filter((o) => closeInYear(o.CloseDate, intent.year));
    }

    // Year-specific closed-won rollup always when year asked
    if (intent.year) {
      const yearWon = allOpps.filter((o) => isOppClosedWon(o) && closeInYear(o.CloseDate, intent.year));
      const yearOpen = allOpps.filter((o) => isOppOpen(o) && closeInYear(o.CloseDate, intent.year));
      const byOwnerYear = {};
      for (const o of yearWon) {
        const owner = String(o.OwnerName || "Unknown");
        if (!byOwnerYear[owner]) byOwnerYear[owner] = { owner, n: 0, amountSum: 0 };
        byOwnerYear[owner].n += 1;
        byOwnerYear[owner].amountSum += oppRevenueNumber(o);
      }
      out.yearSlice = {
        year: intent.year,
        calendar: true,
        revenueField: "Total_Ora_Net_Revenue__c",
        closedWonCount: yearWon.length,
        closedWonAmountSum: Math.round(yearWon.reduce((s, o) => s + oppRevenueNumber(o), 0)),
        openWithCloseDateInYear: yearOpen.length,
        closedWonByOwner: Object.values(byOwnerYear)
          .sort((a, b) => b.amountSum - a.amountSum)
          .slice(0, 25)
          .map((r) => ({ ...r, amountSum: Math.round(r.amountSum) })),
        note: `Filtered ALL ${allOpps.length} Cosmos opportunities by CloseDate year=${intent.year}. Dollars = Total Ora Net Revenue (not Amount/contract).`
      };
    }

    out.filteredOpportunities = filtered
      .slice()
      .sort((a, b) => oppRevenueNumber(b) - oppRevenueNumber(a))
      .slice(0, 40)
      .map((o) => mapOppRow(o, accountNameById));

    out.filterMeta = {
      intent,
      matchedCount: filtered.length,
      listedCount: out.filteredOpportunities.length,
      truncated: filtered.length > out.filteredOpportunities.length,
      note:
        filtered.length === allOpps.length && !intent.openOnly && !intent.closedWon && !intent.year
          ? "No stage/year filter inferred — listed top Amount opportunities. Ask open / Closed Won / year for a sharper cut."
          : `Filter matched ${filtered.length} of ${allOpps.length} opportunities.`
    };

    out.ownerBreakdown = out.pipelineSummary.openByOwner;

    if (nameHint) {
      const accts = await queryAll(
        database.container("ora_sf_account"),
        `SELECT TOP 8 c.id, c.Name, c.OwnerName, c.Tier__c, c.Ora_Grouping__c, c.Type, c.Industry, c.Website, c.Phone
         FROM c WHERE c.docType = @t AND CONTAINS(c.Name, @n, true)`,
        [
          { name: "@t", value: "ora_sf_account" },
          { name: "@n", value: nameHint }
        ]
      );
      out.accounts = accts.map((a) => ({
        id: a.id,
        name: a.Name,
        owner: a.OwnerName,
        tier: a.Tier__c,
        oraGrouping: a.Ora_Grouping__c,
        type: a.Type,
        industry: a.Industry
      }));

      const accountIds = out.accounts.map((a) => a.id).filter(Boolean);
      if (accountIds.length) {
        for (const aid of accountIds.slice(0, 5)) {
          const opps = allOpps.filter((o) => o.AccountId === aid);
          out.opportunities.push(...opps.slice(0, 20).map((o) => mapOppRow(o, accountNameById)));
        }
        for (const aid of accountIds.slice(0, 5)) {
          let ars = await queryAll(
            database.container("ora_sf_activity_request"),
            `SELECT TOP 10 c.id, c.Name, c.Subject__c, c.Status__c, c.Status, c.Account__c, c.AccountId
             FROM c WHERE c.docType = @t AND (c.Account__c = @a OR c.AccountId = @a)`,
            [
              { name: "@t", value: "ora_sf_activity_request" },
              { name: "@a", value: aid }
            ]
          );
          for (const ar of ars) {
            out.activityRequests.push({
              id: ar.id || ar.Id,
              name: ar.Name || ar.Subject__c || ar.Subject,
              status: ar.Status__c || ar.Status,
              accountId: ar.Account__c || ar.AccountId
            });
          }
        }
      }
    } else if (intent.accountsWithOpen || intent.openOnly) {
      out.accounts = out.openAccounts.slice(0, 15).map((a) => ({
        id: a.accountId,
        name: a.accountName,
        openOppCount: a.openOppCount,
        openAmountSum: a.openAmountSum
      }));
      out.opportunities = out.filteredOpportunities.slice(0, 25);
    } else if (intent.closedWon || intent.year) {
      out.opportunities = out.filteredOpportunities.slice(0, 25);
    } else {
      out.accounts = out.openAccounts.slice(0, 10).map((a) => ({
        id: a.accountId,
        name: a.accountName,
        openOppCount: a.openOppCount,
        openAmountSum: a.openAmountSum
      }));
      out.opportunities = out.filteredOpportunities.slice(0, 15);
    }
  } catch (err) {
    out.error = String(err.message || err);
  }

  out.elapsedMs = Date.now() - started;
  out.rules = [
    "CRITICAL: pipelineSummary.scannedAll=true means counts are over EVERY Cosmos opportunity — never call this a sample of 200.",
    "CRITICAL: Opportunity dollars / revenue / pipeline $ = Total Ora Net Revenue (Total_Ora_Net_Revenue__c). NEVER use Amount (contract value) for SF revenue.",
    "CRITICAL: Never ask the user for a Salesforce CSV / export when counts > 0. Answer from this pack (openAccounts, filteredOpportunities, yearSlice, pipelineSummary).",
    "Open pipeline = pipelineSummary.openCount / openAccounts / opportunities where isOpen. Closed Won for a year = yearSlice when query.intent.year is set.",
    "PRIORITY: CRM/pipeline/owner/tier/AR → this pack. portfolio.byClient = Ora uploaded bid fees only — different source.",
    "If yearSlice.closedWonCount is 0 for the requested year, say so plainly (no CSV ask). Offer other years from closedWonByYear.",
    "For visuals/HTML_REPORT: use openAccounts, filteredOpportunities, ownerBreakdown, yearSlice — include Owner on every row.",
    "If counts are 0, tell the user to run Ingest SF + crosswalk on Data Status."
  ];
  return out;
}

/** Attach SF pack onto any intelligence context object (full / slim / default / reconcile). */
async function attachSalesforceData(intel, getDb, opts = {}) {
  if (!intel || typeof intel !== "object" || intel.error) return intel;
  try {
    intel.salesforceData = await buildSalesforceBuddyContext(getDb, {
      question: opts.question || "",
      clientName: opts.clientName || opts.sponsor || null,
      sponsor: opts.sponsor || opts.clientName || null
    });
  } catch (err) {
    intel.salesforceData = { error: String(err.message || err) };
  }
  return intel;
}

module.exports = {
  SF_TABLES,
  SYNC_ID,
  runSalesforceTablesSync,
  getSalesforceTablesStatus,
  isSalesforceDataQuestion,
  extractSfOppIntent,
  buildSalesforceBuddyContext,
  attachSalesforceData
};
