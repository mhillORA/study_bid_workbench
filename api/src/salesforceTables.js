/**
 * Full Salesforce table sync → Cosmos + Buddy context packs.
 * Containers: ora_sf_account, ora_sf_opportunity, ora_sf_activity_request,
 *             ora_sf_opportunity_line, ora_sf_services (Product2)
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
  },
  {
    sfObject: "OpportunityLineItem",
    container: "ora_sf_opportunity_line",
    docType: "ora_sf_opportunity_line"
  },
  { sfObject: "Product2", container: "ora_sf_services", docType: "ora_sf_services" }
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
      error: "Salesforce App Settings missing (SF_CLIENT_ID, SF_USERNAME). JWT key via App Settings or Data Status upload.",
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
      : "Full Salesforce table sync into ora_sf_* containers."
  });

  return {
    ok: !hardFail,
    mode: "tables",
    incomplete,
    results,
    elapsedMs: Date.now() - started,
    sync: state
  };
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
    /\b(opportunit(?:y|ies)|pipeline|stage|close date)\b/.test(q) ||
    /\b(product2|sf services|opportunity line|line items?)\b/.test(q) ||
    /\b(who owns|account owner|bd owner|tier)\b/.test(q) ||
    /\b(accounts? in (sf|salesforce)|sf accounts?)\b/.test(q)
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

/**
 * Bounded SF pack for Buddy asks.
 */
async function buildSalesforceBuddyContext(getDb, opts = {}) {
  const question = String(opts.question || "");
  const clientName = String(opts.clientName || opts.sponsor || "").trim() || null;
  const nameHint = extractSfNameHint(question) || clientName;
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
      "Live Salesforce mirrors in Cosmos (ora_sf_*). Prefer these for Account / Opportunity / AR / services questions after a tables sync. crosswalk still bridges Veeva/TrialHub names → sf_account_id.",
    counts,
    query: { nameHint, clientName },
    accounts: [],
    opportunities: [],
    activityRequests: [],
    opportunityLines: [],
    services: []
  };

  if (!anyData) {
    out.empty = true;
    out.note =
      "ora_sf_* containers are empty — run Intelligence → Sync SF tables (after SF_* App Settings). Until then use sponsorCrosswalk for owner/tier/grouping only.";
    out.elapsedMs = Date.now() - started;
    return out;
  }

  try {
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
        // Opportunities for matched accounts
        for (const aid of accountIds.slice(0, 5)) {
          const opps = await queryAll(
            database.container("ora_sf_opportunity"),
            `SELECT TOP 12 c.id, c.Name, c.StageName, c.Amount, c.CloseDate, c.AccountId, c.OwnerName, c.Type, c.IsClosed, c.IsWon
             FROM c WHERE c.docType = @t AND c.AccountId = @a`,
            [
              { name: "@t", value: "ora_sf_opportunity" },
              { name: "@a", value: aid }
            ]
          );
          out.opportunities.push(
            ...opps.map((o) => ({
              id: o.id,
              name: o.Name,
              stage: o.StageName,
              amount: o.Amount,
              closeDate: o.CloseDate,
              accountId: o.AccountId,
              owner: o.OwnerName,
              isClosed: o.IsClosed,
              isWon: o.IsWon
            }))
          );
        }

        // Activity requests — try Account__c then AccountId
        for (const aid of accountIds.slice(0, 5)) {
          let ars = await queryAll(
            database.container("ora_sf_activity_request"),
            `SELECT TOP 10 * FROM c WHERE c.docType = @t AND (c.Account__c = @a OR c.AccountId = @a)`,
            [
              { name: "@t", value: "ora_sf_activity_request" },
              { name: "@a", value: aid }
            ]
          );
          if (!ars.length) {
            ars = await queryAll(
              database.container("ora_sf_activity_request"),
              `SELECT TOP 8 * FROM c WHERE c.docType = @t AND (CONTAINS(LOWER(c.Name), @n) OR CONTAINS(LOWER(c.Subject__c), @n))`,
              [
                { name: "@t", value: "ora_sf_activity_request" },
                { name: "@n", value: String(nameHint).toLowerCase() }
              ]
            );
          }
          for (const ar of ars) {
            out.activityRequests.push({
              id: ar.id || ar.Id,
              name: ar.Name || ar.Subject__c || ar.Subject,
              status: ar.Status__c || ar.Status,
              accountId: ar.Account__c || ar.AccountId,
              raw: undefined
            });
          }
        }

        const oppIds = [...new Set(out.opportunities.map((o) => o.id))].slice(0, 10);
        for (const oid of oppIds) {
          const lines = await queryAll(
            database.container("ora_sf_opportunity_line"),
            `SELECT TOP 15 c.id, c.Name, c.OpportunityId, c.Product2Id, c.Quantity, c.UnitPrice, c.TotalPrice, c.ProductCode
             FROM c WHERE c.docType = @t AND c.OpportunityId = @o`,
            [
              { name: "@t", value: "ora_sf_opportunity_line" },
              { name: "@o", value: oid }
            ]
          );
          out.opportunityLines.push(
            ...lines.map((l) => ({
              id: l.id,
              name: l.Name,
              opportunityId: l.OpportunityId,
              product2Id: l.Product2Id,
              quantity: l.Quantity,
              unitPrice: l.UnitPrice,
              totalPrice: l.TotalPrice,
              productCode: l.ProductCode
            }))
          );
        }

        const productIds = [
          ...new Set(out.opportunityLines.map((l) => l.product2Id).filter(Boolean))
        ].slice(0, 15);
        for (const pid of productIds) {
          const services = await queryAll(
            database.container("ora_sf_services"),
            `SELECT TOP 5 c.id, c.Name, c.ProductCode, c.Family, c.Description, c.IsActive
             FROM c WHERE c.docType = @t AND c.id = @p`,
            [
              { name: "@t", value: "ora_sf_services" },
              { name: "@p", value: pid }
            ]
          );
          out.services.push(
            ...services.map((s) => ({
              id: s.id,
              name: s.Name,
              productCode: s.ProductCode,
              family: s.Family,
              isActive: s.IsActive
            }))
          );
        }
      }
    } else {
      // Overview samples when no account named
      out.accounts = (
        await queryAll(
          database.container("ora_sf_account"),
          `SELECT TOP 10 c.id, c.Name, c.OwnerName, c.Tier__c, c.Ora_Grouping__c FROM c WHERE c.docType = @t`,
          [{ name: "@t", value: "ora_sf_account" }]
        )
      ).map((a) => ({
        id: a.id,
        name: a.Name,
        owner: a.OwnerName,
        tier: a.Tier__c,
        oraGrouping: a.Ora_Grouping__c
      }));
      out.opportunities = (
        await queryAll(
          database.container("ora_sf_opportunity"),
          `SELECT TOP 10 c.id, c.Name, c.StageName, c.Amount, c.CloseDate, c.OwnerName FROM c WHERE c.docType = @t`,
          [{ name: "@t", value: "ora_sf_opportunity" }]
        )
      ).map((o) => ({
        id: o.id,
        name: o.Name,
        stage: o.StageName,
        amount: o.Amount,
        closeDate: o.CloseDate,
        owner: o.OwnerName
      }));
    }
  } catch (err) {
    out.error = String(err.message || err);
  }

  out.elapsedMs = Date.now() - started;
  out.rules = [
    "Cite Account Name, Owner, Tier__c → tier, Ora_Grouping__c → ora grouping.",
    "Opportunities: Name, Stage, Amount, CloseDate — do not invent pipeline numbers.",
    "Services come from Product2 (ora_sf_services) via opportunity line items.",
    "Activity_Request__c rows are ARs — say Activity Request, not invent statuses.",
    "If counts are 0, tell the user to run Sync SF tables on the Intelligence tab."
  ];
  return out;
}

module.exports = {
  SF_TABLES,
  SYNC_ID,
  runSalesforceTablesSync,
  getSalesforceTablesStatus,
  isSalesforceDataQuestion,
  buildSalesforceBuddyContext
};
