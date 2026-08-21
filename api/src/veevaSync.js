/**
 * Veeva Vault → Cosmos sync.
 *
 * Live mirrors (canonical going forward):
 *   ora_veeva_study, ora_veeva_site, ora_veeva_organization,
 *   ora_veeva_sponsor, ora_veeva_milestone
 *
 * Also projects into legacy-shaped packs Buddy already reads:
 *   ora_fact_study, ora_fact_site  (source=veeva_live)
 *   ora_veeva_milestones           (wide site×study gaps when computable; source=veeva_live)
 *
 * Mike Watson / Claude Excel packs remain until overwritten by live projection;
 * intelligence prefers source=veeva_live when present.
 */

const {
  veevaConfig,
  getVeevaSession,
  vqlQuery,
  flattenVeevaRecord
} = require("./veevaClient");

const SYNC_ID = "veeva_tables";
const TIME_BUDGET_MS = Number(process.env.VEEVA_SYNC_BUDGET_MS || 110000);

/** Live Vault object → Cosmos mirror (+ optional fact projection). */
const VEEVA_TABLES = [
  {
    vaultObject: "study__v",
    container: "ora_veeva_study",
    docType: "ora_veeva_study",
    fields: [
      "id",
      "name__v",
      "alternate_study_number__vs",
      "study_name__v",
      "sponsor__c",
      "sponsor_organization__v",
      "indication__v",
      "indication__c",
      "study_phase__v",
      "study_status__v",
      "status__v",
      "therapeutic_area__c",
      "enrollment__vs",
      "number_of_sites__c",
      "country__c",
      "current_project_phase__c",
      "modified_date__v"
    ],
    projectFact: "study"
  },
  {
    vaultObject: "site__v",
    container: "ora_veeva_site",
    docType: "ora_veeva_site",
    fields: [
      "id",
      "name__v",
      "site_name__v",
      "study__v",
      "study_number__v",
      "study_name__v",
      "organization__clin",
      "country__v",
      "site_status__v",
      "status__v",
      "indication__c",
      "study_phase__c",
      "study_sponsor__c",
      "no_subjects_enrolled__v",
      "site_selected_date__v",
      "modified_date__v"
    ],
    projectFact: "site"
  },
  {
    vaultObject: "organization__v",
    container: "ora_veeva_organization",
    docType: "ora_veeva_organization",
    fields: [
      "id",
      "name__v",
      "full_name__v",
      "status__v",
      "available_as_study_site__v",
      "organization__clin",
      "modified_date__v"
    ]
  },
  {
    vaultObject: "sponsor__c",
    container: "ora_veeva_sponsor",
    docType: "ora_veeva_sponsor",
    fields: ["id", "name__v", "status__v", "modified_date__v"]
  },
  {
    vaultObject: "milestone__v",
    container: "ora_veeva_milestone",
    docType: "ora_veeva_milestone",
    fields: [
      "id",
      "name__v",
      "status__v",
      "study__v",
      "site__v",
      "study_country__v",
      "milestone_type__v",
      "object_type__v",
      "planned_start_date__v",
      "planned_finish_date__v",
      "actual_start_date__v",
      "actual_finish_date__v",
      "baseline_start_date__v",
      "baseline_finish_date__v",
      "complete__v",
      "milestone_category__v",
      "study_indication__c",
      "modified_date__v"
    ],
    projectFact: "milestone"
  }
];

async function ensureContainer(database, containerId, partitionPath = "/id") {
  try {
    await database.containers.createIfNotExists({
      id: containerId,
      partitionKey: { paths: [partitionPath] }
    });
  } catch (_) {
    /* exists */
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
  await ensureContainer(database, "syncState");
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

function toMirrorDoc(rec, docType, syncedAt) {
  const flat = flattenVeevaRecord(rec);
  const id = String(flat.id || "").trim();
  if (!id) return null;
  return {
    ...flat,
    id,
    veevaId: id,
    docType,
    dataset: "veeva_vault_live",
    schemaVersion: 1,
    veevaSyncedAt: syncedAt,
    veevaSyncSource: "vault_api",
    source: "veeva_live"
  };
}

function picklistLabel(v) {
  if (v == null) return null;
  const s = String(v);
  // proliferative_diabetic_retinopathy__c → readable-ish
  return s.replace(/__/g, " ").replace(/_/g, " ").replace(/\s+c$/i, "").trim() || s;
}

function projectFactStudy(mirror, sponsorNameById) {
  const studyNumber =
    mirror.alternate_study_number__vs || mirror.name__v || mirror.id;
  const indicationRaw = mirror.indication__v || mirror.indication__c || null;
  const indication = indicationRaw ? picklistLabel(indicationRaw) : "_unknown";
  const sponsor =
    (mirror.sponsor__c && sponsorNameById.get(mirror.sponsor__c)) ||
    mirror.sponsor_organization__v ||
    null;
  return {
    id: `live-${mirror.id}`,
    docType: "ora_fact_study",
    dataset: "ora_clinical_intelligence",
    schemaVersion: 1,
    source: "veeva_live",
    veeva_study_id: mirror.id,
    study_number: studyNumber,
    sponsor,
    indication: indication || "_unknown",
    phase: picklistLabel(mirror.study_phase__v) || null,
    lifecycle_state: picklistLabel(mirror.status__v || mirror.study_status__v) || null,
    total_enrolled: mirror.enrollment__vs != null ? Number(mirror.enrollment__vs) : null,
    n_contributing_sites:
      mirror.number_of_sites__c != null ? Number(mirror.number_of_sites__c) : null,
    psm: null,
    study_rate_pt_mo: null,
    countries: mirror.country__c || null,
    importedAt: mirror.veevaSyncedAt,
    veevaSyncedAt: mirror.veevaSyncedAt
  };
}

function projectFactSite(mirror, orgNameById, countryNameById) {
  const org =
    (mirror.organization__clin && orgNameById.get(mirror.organization__clin)) ||
    mirror.site_name__v ||
    mirror.name__v ||
    null;
  const country =
    (mirror.country__v && countryNameById.get(mirror.country__v)) ||
    mirror.country__v ||
    "_unknown";
  const indication = picklistLabel(mirror.indication__c) || "_unknown";
  return {
    id: `live-${mirror.id}`,
    docType: "ora_fact_site",
    dataset: "ora_clinical_intelligence",
    schemaVersion: 1,
    source: "veeva_live",
    veeva_site_id: mirror.id,
    study_name: mirror.study_name__v || mirror.study_number__v || mirror.study__v || null,
    org_clean: org,
    organization: org,
    country: country || "_unknown",
    indication,
    site_psm: null,
    total_enrolled:
      mirror.no_subjects_enrolled__v != null ? Number(mirror.no_subjects_enrolled__v) : null,
    site_enroll_months: null,
    fsi_trust: null,
    screen_fail_rate: null,
    importedAt: mirror.veevaSyncedAt,
    veevaSyncedAt: mirror.veevaSyncedAt
  };
}

/** Classify milestone name/type into startup gap keys used by Mike Watson pack. */
function classifyMilestoneKey(name, type) {
  const s = `${name || ""} ${type || ""}`.toLowerCase();
  if (/\bsiv\b|site initiated|ir_site_initiated|first study site initiated/.test(s)) return "siv";
  if (/\bfsi\b|\bfpi\b|first subject|first patient|ready to enroll/.test(s)) return "fsi";
  if (/\birb\b|ethics|ec approval|irb submission|irb approv/.test(s)) return "irb";
  if (/cta signed|contract|site financial|financial docs/.test(s)) return "contract";
  if (/site selected|selected_site|site selection/.test(s)) return "selected";
  return null;
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.round((db - da) / 86400000);
}

/**
 * Build/refresh wide milestone docs from live ora_veeva_milestone (+ site/org names).
 * Bounded: only processes milestones touched this sync if provided, else sample recent.
 */
async function projectWideMilestones(database, opts = {}) {
  const milestoneContainer = database.container("ora_veeva_milestone");
  const wideContainer = await ensureContainer(database, "ora_veeva_milestones", "/country");
  const siteContainer = database.container("ora_veeva_site");
  const orgContainer = database.container("ora_veeva_organization");

  const siteRows = await queryAll(
    siteContainer,
    `SELECT c.id, c.name__v, c.site_name__v, c.study__v, c.study_name__v, c.organization__clin, c.country__v FROM c WHERE c.docType = @t`,
    [{ name: "@t", value: "ora_veeva_site" }]
  );
  const orgRows = await queryAll(
    orgContainer,
    `SELECT c.id, c.name__v, c.full_name__v FROM c WHERE c.docType = @t`,
    [{ name: "@t", value: "ora_veeva_organization" }]
  );
  const orgName = new Map(orgRows.map((o) => [o.id, o.full_name__v || o.name__v]));
  const siteById = new Map(siteRows.map((s) => [s.id, s]));

  // Prefer site-level milestones with an actual finish/start date
  const ms = await queryAll(
    milestoneContainer,
    `SELECT c.id, c.name__v, c.milestone_type__v, c.study__v, c.site__v, c.actual_finish_date__v, c.actual_start_date__v, c.planned_finish_date__v, c.complete__v
     FROM c WHERE c.docType = @t AND IS_DEFINED(c.site__v) AND c.site__v != null`,
    [{ name: "@t", value: "ora_veeva_milestone" }]
  );

  const bySiteStudy = new Map();
  for (const m of ms) {
    const site = siteById.get(m.site__v);
    if (!site) continue;
    const key = `${m.site__v}|${m.study__v || site.study__v || ""}`;
    if (!bySiteStudy.has(key)) {
      const org =
        (site.organization__clin && orgName.get(site.organization__clin)) ||
        site.site_name__v ||
        site.name__v ||
        "unknown";
      bySiteStudy.set(key, {
        organization: org,
        study_name: site.study_name__v || site.study__v || m.study__v,
        country: site.country__v || "_unknown",
        dates: {},
        veeva_site_id: m.site__v,
        veeva_study_id: m.study__v || site.study__v
      });
    }
    const pack = bySiteStudy.get(key);
    const kind = classifyMilestoneKey(m.name__v, m.milestone_type__v);
    const when = m.actual_finish_date__v || m.actual_start_date__v || m.planned_finish_date__v;
    if (kind && when && !pack.dates[kind]) pack.dates[kind] = when;
  }

  const syncedAt = opts.syncedAt || new Date().toISOString();
  let upserted = 0;
  for (const pack of bySiteStudy.values()) {
    const d = pack.dates;
    const gaps_days = {
      selected_to_contract: daysBetween(d.selected, d.contract),
      contract_to_irb: daysBetween(d.contract, d.irb),
      irb_to_siv: daysBetween(d.irb, d.siv),
      siv_to_fsi: daysBetween(d.siv, d.fsi),
      contract_to_siv: daysBetween(d.contract, d.siv),
      contract_to_fsi: daysBetween(d.contract, d.fsi)
    };
    const hasGap = Object.values(gaps_days).some((n) => typeof n === "number");
    if (!hasGap && Object.keys(d).length < 2) continue;

    const id = `live-${pack.veeva_site_id}-${pack.veeva_study_id || "x"}`;
    const year = Object.values(d)
      .map((x) => String(x || "").slice(0, 4))
      .find((y) => /^20\d{2}$/.test(y));
    const doc = {
      id,
      docType: "ora_veeva_milestones",
      dataset: "ora_clinical_intelligence",
      schemaVersion: 1,
      source: "veeva_live",
      organization: pack.organization,
      study_name: pack.study_name,
      country: pack.country || "_unknown",
      dates: d,
      gaps_days,
      activity_2023_plus: !year || Number(year) >= 2023,
      outlier_gap_gt_730: Object.values(gaps_days).some((n) => typeof n === "number" && n > 730),
      veeva_site_id: pack.veeva_site_id,
      veeva_study_id: pack.veeva_study_id,
      importedAt: syncedAt,
      veevaSyncedAt: syncedAt
    };
    try {
      await wideContainer.items.upsert(doc);
      upserted += 1;
    } catch (_) {
      /* continue */
    }
  }
  return { upserted, siteStudyKeys: bySiteStudy.size };
}

async function loadNameMaps(database) {
  const sponsorNameById = new Map();
  const orgNameById = new Map();
  try {
    const sponsors = await queryAll(
      database.container("ora_veeva_sponsor"),
      `SELECT c.id, c.name__v FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_veeva_sponsor" }]
    );
    for (const s of sponsors) sponsorNameById.set(s.id, s.name__v);
  } catch (_) {}
  try {
    const orgs = await queryAll(
      database.container("ora_veeva_organization"),
      `SELECT c.id, c.name__v, c.full_name__v FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_veeva_organization" }]
    );
    for (const o of orgs) orgNameById.set(o.id, o.full_name__v || o.name__v);
  } catch (_) {}
  return { sponsorNameById, orgNameById };
}

/**
 * Full or delta sync of Vault objects into Cosmos.
 */
async function runVeevaTablesSync(getDb, opts = {}) {
  const started = Date.now();
  const cfg = veevaConfig();
  if (!cfg.configured) {
    return {
      ok: false,
      skipped: true,
      reason: "not_configured",
      error:
        "Veeva App Settings missing on ora-buddy-api (VEEVA_DNS, VEEVA_USERNAME, VEEVA_PASSWORD, VEEVA_CLIENT_ID).",
      elapsedMs: 0
    };
  }

  let session;
  try {
    session = await getVeevaSession(cfg);
  } catch (err) {
    return { ok: false, error: String(err.message || err), elapsedMs: Date.now() - started };
  }

  const database = getDb();
  const prev = (await readSyncState(database)) || {};
  const deltaMode = opts.full === true ? false : opts.delta !== false && Boolean(prev.lastSuccessfulSync);
  const watermark = deltaMode ? prev.lastSuccessfulSync : null;

  const only = Array.isArray(opts.only) && opts.only.length
    ? opts.only.map((s) => String(s).toLowerCase())
    : null;
  const tables = only
    ? VEEVA_TABLES.filter(
        (t) =>
          only.includes(t.vaultObject.toLowerCase()) ||
          only.includes(t.container.toLowerCase()) ||
          only.includes(String(t.projectFact || "").toLowerCase())
      )
    : VEEVA_TABLES;

  // Sponsors/orgs first helps fact projection
  tables.sort((a, b) => {
    const rank = (t) =>
      t.vaultObject === "sponsor__c"
        ? 0
        : t.vaultObject === "organization__v"
          ? 1
          : t.vaultObject === "study__v"
            ? 2
            : t.vaultObject === "site__v"
              ? 3
              : 4;
    return rank(a) - rank(b);
  });

  const results = [];
  let incomplete = false;
  const syncedAt = new Date().toISOString();

  for (const table of tables) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      incomplete = true;
      results.push({
        object: table.vaultObject,
        container: table.container,
        skipped: true,
        reason: "time_budget"
      });
      continue;
    }
    const t0 = Date.now();
    try {
      const container = await ensureContainer(database, table.container);
      const fieldList = table.fields.join(", ");
      let q = `SELECT ${fieldList} FROM ${table.vaultObject}`;
      if (watermark) {
        q += ` WHERE modified_date__v > '${watermark}'`;
      }
      const pulled = await vqlQuery(session, q, {
        maxRecords: opts.maxRecords || null
      });

      let upserted = 0;
      const errors = [];
      const mirrors = [];
      for (const rec of pulled.records) {
        if (Date.now() - started > TIME_BUDGET_MS) {
          incomplete = true;
          break;
        }
        const doc = toMirrorDoc(rec, table.docType, syncedAt);
        if (!doc) continue;
        try {
          await container.items.upsert(doc);
          upserted += 1;
          mirrors.push(doc);
        } catch (err) {
          errors.push(`${doc.id}: ${err.message || err}`);
          if (errors.length > 20) break;
        }
      }

      // Project into Buddy fact packs
      let projected = 0;
      if (table.projectFact && mirrors.length) {
        const maps = await loadNameMaps(database);
        if (table.projectFact === "study") {
          const fact = await ensureContainer(database, "ora_fact_study", "/indication");
          for (const m of mirrors) {
            try {
              await fact.items.upsert(projectFactStudy(m, maps.sponsorNameById));
              projected += 1;
            } catch (_) {}
          }
        } else if (table.projectFact === "site") {
          const fact = await ensureContainer(database, "ora_fact_site", "/country");
          for (const m of mirrors) {
            try {
              await fact.items.upsert(projectFactSite(m, maps.orgNameById, new Map()));
              projected += 1;
            } catch (_) {}
          }
        }
      }

      results.push({
        object: table.vaultObject,
        container: table.container,
        mode: watermark ? "delta" : "full",
        fetched: pulled.records.length,
        upserted,
        projected,
        totalHint: pulled.total,
        pages: pulled.pages,
        truncated: pulled.truncated || incomplete,
        errorCount: errors.length,
        errors: errors.slice(0, 5),
        elapsedMs: Date.now() - t0
      });
    } catch (err) {
      results.push({
        object: table.vaultObject,
        container: table.container,
        ok: false,
        error: String(err.message || err),
        elapsedMs: Date.now() - t0
      });
    }
  }

  let milestoneWide = null;
  const didMilestones = results.some(
    (r) => r.object === "milestone__v" && (r.upserted > 0 || r.fetched > 0)
  );
  if (didMilestones && Date.now() - started < TIME_BUDGET_MS) {
    try {
      milestoneWide = await projectWideMilestones(database, { syncedAt });
    } catch (err) {
      milestoneWide = { error: String(err.message || err) };
    }
  }

  const hardFail = results.length > 0 && results.every((r) => r.error || r.ok === false);
  const state = await writeSyncState(database, {
    lastRunAt: syncedAt,
    lastSuccessfulSync: hardFail ? prev.lastSuccessfulSync : syncedAt,
    mode: watermark ? "delta" : "full",
    triggeredBy: opts.triggeredBy || "api",
    lastDeltas: { results, incomplete, milestoneWide },
    note: incomplete
      ? "Time budget hit — re-run Ingest Veeva to continue."
      : watermark
        ? "Veeva delta sync into ora_veeva_* (+ fact projection)."
        : "Veeva full sync into ora_veeva_* (+ fact projection). Mike Watson Excel packs superseded where source=veeva_live."
  });

  return {
    ok: !hardFail,
    mode: watermark ? "delta" : "full",
    incomplete,
    results,
    milestoneWide,
    elapsedMs: Date.now() - started,
    sync: state
  };
}

async function getVeevaSyncStatus(getDb) {
  const cfg = veevaConfig();
  const database = getDb();
  const sync = await readSyncState(database);
  const tables = [];
  for (const t of VEEVA_TABLES) {
    tables.push({
      vaultObject: t.vaultObject,
      container: t.container,
      count: await countDocType(database, t.container, t.docType)
    });
  }
  let factStudyLive = null;
  let factSiteLive = null;
  let milestonesLive = null;
  try {
    const rows = await queryAll(
      database.container("ora_fact_study"),
      `SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t AND c.source = @s`,
      [
        { name: "@t", value: "ora_fact_study" },
        { name: "@s", value: "veeva_live" }
      ]
    );
    factStudyLive = rows[0] || 0;
  } catch (_) {}
  try {
    const rows = await queryAll(
      database.container("ora_fact_site"),
      `SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t AND c.source = @s`,
      [
        { name: "@t", value: "ora_fact_site" },
        { name: "@s", value: "veeva_live" }
      ]
    );
    factSiteLive = rows[0] || 0;
  } catch (_) {}
  try {
    const rows = await queryAll(
      database.container("ora_veeva_milestones"),
      `SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t AND c.source = @s`,
      [
        { name: "@t", value: "ora_veeva_milestones" },
        { name: "@s", value: "veeva_live" }
      ]
    );
    milestonesLive = rows[0] || 0;
  } catch (_) {}

  return {
    configured: cfg.configured,
    dns: cfg.dns || null,
    usernameHint: cfg.username
      ? cfg.username.replace(/(.{2}).+(@.+)/, "$1***$2")
      : null,
    clientId: cfg.clientId,
    apiVersion: cfg.apiVersion,
    tables,
    projections: {
      ora_fact_study_live: factStudyLive,
      ora_fact_site_live: factSiteLive,
      ora_veeva_milestones_live: milestonesLive
    },
    sync: sync
      ? {
          lastSuccessfulSync: sync.lastSuccessfulSync || null,
          lastRunAt: sync.lastRunAt || null,
          mode: sync.mode || null,
          note: sync.note || null,
          lastDeltas: sync.lastDeltas || null
        }
      : null
  };
}

module.exports = {
  SYNC_ID,
  VEEVA_TABLES,
  runVeevaTablesSync,
  getVeevaSyncStatus,
  projectWideMilestones
};
