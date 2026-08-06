/**
 * Refresh ora_sponsor_crosswalk from live Salesforce Accounts (JWT).
 * Updates sf_account_name, sf_owner, tier — does NOT change crosswalk_status
 * (that field is the Cosmos partition key).
 */

const {
  salesforceConfig,
  getSalesforceAccessToken,
  fetchAccountsByIds
} = require("./salesforceClient");

const SYNC_ID = "salesforce_crosswalk";
const DOC_TYPE = "ora_sponsor_crosswalk";

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
  const container = database.container("syncState");
  const prev = (await readSyncState(database)) || {};
  const doc = {
    ...prev,
    id: SYNC_ID,
    docType: "syncState",
    job: SYNC_ID,
    ...patch
  };
  await container.items.upsert(doc);
  return doc;
}

function collectCrosswalkIds(rows) {
  const ids = [];
  for (const r of rows) {
    const id = String(r.sf_account_id || r.sfAccountId || "").trim();
    if (id) ids.push(id);
  }
  return [...new Set(ids)];
}

/**
 * @param {Function} getDb
 * @param {{ triggeredBy?: string, dryRun?: boolean }} opts
 */
async function runSalesforceCrosswalkSync(getDb, opts = {}) {
  const started = Date.now();
  const cfg = salesforceConfig();
  if (!cfg.configured) {
    return {
      ok: false,
      skipped: true,
      reason: "not_configured",
      error:
        "Salesforce App Settings missing (SF_CLIENT_ID, SF_USERNAME, SF_JWT_PRIVATE_KEY). See docs/salesforce-azure-sync.md",
      elapsedMs: Date.now() - started
    };
  }

  const database = getDb();
  const container = database.container("ora_sponsor_crosswalk");

  const rows = await queryAll(
    container,
    `SELECT * FROM c WHERE c.docType = @t AND IS_DEFINED(c.sf_account_id) AND c.sf_account_id != null AND c.sf_account_id != ""`,
    [{ name: "@t", value: DOC_TYPE }]
  );

  const accountIds = collectCrosswalkIds(rows);
  if (!accountIds.length) {
    const state = await writeSyncState(database, {
      lastRunAt: new Date().toISOString(),
      lastSuccessfulSync: new Date().toISOString(),
      mode: "crosswalk_refresh",
      triggeredBy: opts.triggeredBy || "api",
      lastUpserted: 0,
      lastDeltas: { matched: 0, updated: 0, missingInSf: 0, withSfId: 0 },
      note: "No crosswalk rows with sf_account_id — nothing to refresh."
    });
    return {
      ok: true,
      mode: "crosswalk_refresh",
      withSfId: 0,
      updated: 0,
      missingInSf: 0,
      elapsedMs: Date.now() - started,
      sync: state
    };
  }

  let session;
  try {
    session = await getSalesforceAccessToken(cfg);
  } catch (err) {
    await writeSyncState(database, {
      lastRunAt: new Date().toISOString(),
      mode: "crosswalk_refresh",
      triggeredBy: opts.triggeredBy || "api",
      lastError: String(err.message || err),
      note: "Token/auth failed — check JWT cert, Consumer Key, username, pre-authorization."
    });
    return {
      ok: false,
      error: String(err.message || err),
      elapsedMs: Date.now() - started
    };
  }

  let accounts;
  try {
    accounts = await fetchAccountsByIds(session, accountIds, {
      tierField: cfg.tierField,
      groupingField: cfg.groupingField
    });
  } catch (err) {
    await writeSyncState(database, {
      lastRunAt: new Date().toISOString(),
      mode: "crosswalk_refresh",
      triggeredBy: opts.triggeredBy || "api",
      lastError: String(err.message || err),
      note: "SOQL failed — check Account read permission and SF_TIER_FIELD."
    });
    return {
      ok: false,
      error: String(err.message || err),
      elapsedMs: Date.now() - started
    };
  }

  const nowIso = new Date().toISOString();
  let updated = 0;
  let missingInSf = 0;
  let unchanged = 0;
  const errors = [];
  const dryRun = Boolean(opts.dryRun);

  for (const row of rows) {
    const sfId = String(row.sf_account_id || "").trim();
    if (!sfId) continue;
    const acct = accounts.get(sfId);
    const next = { ...row, sfLastSyncedAt: nowIso, sfSyncSource: "salesforce_jwt" };

    if (!acct || acct.isDeleted) {
      missingInSf += 1;
      next.sfAccountActive = false;
      next.sf_sync_note = acct && acct.isDeleted ? "Account IsDeleted in Salesforce" : "sf_account_id not found in Salesforce";
      // Keep crosswalk_status (partition key) unchanged
    } else {
      next.sfAccountActive = true;
      next.sf_sync_note = null;
      if (acct.name) next.sf_account_name = acct.name;
      if (acct.ownerName) next.sf_owner = acct.ownerName;
      if (acct.tier != null && String(acct.tier).trim() !== "") next.tier = acct.tier;
      if (acct.oraGrouping != null && String(acct.oraGrouping).trim() !== "") {
        next.ora_grouping = acct.oraGrouping;
      }
    }

    const changed =
      next.sf_account_name !== row.sf_account_name ||
      next.sf_owner !== row.sf_owner ||
      next.tier !== row.tier ||
      next.ora_grouping !== row.ora_grouping ||
      next.sfAccountActive !== row.sfAccountActive ||
      next.sf_sync_note !== row.sf_sync_note;

    if (!changed) {
      unchanged += 1;
      // Still stamp last sync time lightly
      if (!dryRun) {
        try {
          await container.items.upsert({ ...row, sfLastSyncedAt: nowIso, sfSyncSource: "salesforce_jwt" });
        } catch (err) {
          errors.push(`${row.id || sfId}: ${err.message || err}`);
        }
      }
      continue;
    }

    updated += 1;
    if (dryRun) continue;
    try {
      await container.items.upsert(next);
    } catch (err) {
      errors.push(`${row.id || sfId}: ${err.message || err}`);
    }
  }

  const deltas = {
    withSfId: accountIds.length,
    crosswalkRows: rows.length,
    matchedInSf: accounts.size,
    updated,
    unchanged,
    missingInSf,
    errorCount: errors.length,
    tierField: cfg.tierField,
    groupingField: cfg.groupingField,
    dryRun
  };

  const ok = errors.length === 0;
  const state = await writeSyncState(database, {
    lastRunAt: nowIso,
    lastSuccessfulSync: ok ? nowIso : undefined,
    mode: dryRun ? "crosswalk_refresh_dry_run" : "crosswalk_refresh",
    triggeredBy: opts.triggeredBy || "api",
    lastUpserted: dryRun ? 0 : updated + unchanged,
    lastDeltas: deltas,
    lastError: errors.length ? errors.slice(0, 5).join(" | ") : null,
    note: ok
      ? `Refreshed owner/tier/grouping/name from Salesforce (${cfg.tierField}, ${cfg.groupingField}). crosswalk_status unchanged (Cosmos PK).`
      : "Completed with upsert errors — see lastError."
  });

  return {
    ok,
    mode: dryRun ? "crosswalk_refresh_dry_run" : "crosswalk_refresh",
    ...deltas,
    errors: errors.slice(0, 10),
    elapsedMs: Date.now() - started,
    instanceUrl: session.instanceUrl,
    sync: state
  };
}

async function getSalesforceSyncStatus(getDb) {
  const cfg = salesforceConfig();
  const database = getDb();
  const state = await readSyncState(database);
  let withSfId = 0;
  try {
    const rows = await queryAll(
      database.container("ora_sponsor_crosswalk"),
      `SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t AND IS_DEFINED(c.sf_account_id) AND c.sf_account_id != null AND c.sf_account_id != ""`,
      [{ name: "@t", value: DOC_TYPE }]
    );
    withSfId = rows[0] || 0;
  } catch (_) {}
  return {
    configured: cfg.configured,
    loginUrl: cfg.loginUrl,
    tierField: cfg.tierField,
    groupingField: cfg.groupingField,
    usernameSet: Boolean(cfg.username),
    clientIdSet: Boolean(cfg.clientId),
    privateKeySet: Boolean(cfg.privateKey),
    crosswalkWithSfId: withSfId,
    sync: state
      ? {
          lastSuccessfulSync: state.lastSuccessfulSync || null,
          lastRunAt: state.lastRunAt || null,
          lastUpserted: state.lastUpserted || null,
          lastDeltas: state.lastDeltas || null,
          mode: state.mode || null,
          triggeredBy: state.triggeredBy || null,
          note: state.note || null,
          lastError: state.lastError || null
        }
      : null
  };
}

module.exports = {
  runSalesforceCrosswalkSync,
  getSalesforceSyncStatus,
  SYNC_ID
};
