/**
 * Veeva Vault → Cosmos sync.
 *
 * Feasibility taxonomy (Mike Watson Claude Report — how Ora categorizes feasibility):
 *   Study level  = Study + Metrics + Milestone (country blank on metrics/milestones)
 *   Site level   = Study Site + Metrics + Milestone (site not blank; Ora Project Code)
 * Dimensions: enrollment metrics, startup milestones, geography (study country), subjects.
 *
 * Live mirrors:
 *   ora_veeva_study, ora_veeva_site, ora_veeva_study_country,
 *   ora_veeva_organization, ora_veeva_sponsor,
 *   ora_veeva_metric, ora_veeva_subject, ora_veeva_milestone,
 *   ora_veeva_payable_item, ora_veeva_payment, ora_veeva_fee_schedule,
 *   ora_veeva_person (PI name lookup for site.principal_investigator__v)
 * (Monitoring / trip-report CTMS objects intentionally not synced.)
 *
 * Also projects:
 *   ora_fact_study, ora_fact_site  (source=veeva_live)
 *   ora_veeva_milestones           (wide gaps from live milestone__v when synced)
 *
 * Mike Watson Excel packs remain until overwritten; intelligence prefers source=veeva_live.
 */

const {
  veevaConfig,
  getVeevaSession,
  vqlQuery,
  flattenVeevaRecord
} = require("./veevaClient");
const {
  vaultIndicationLabel,
  parseMilestoneDateIso,
  milestoneSingleDayActualDate,
  siteEnrollMonthsFromFpfvLpfv,
  computeSitePsm,
  classifyPsmWindowMilestone
} = require("./veevaPsm");

const SYNC_ID = "veeva_tables";
// Daily async sync needs headroom for metrics + sites + subjects. Default 55 min;
// host.json functionTimeout must be ≥ this (set to 60 min). Override with VEEVA_SYNC_BUDGET_MS.
const TIME_BUDGET_MS = Number(process.env.VEEVA_SYNC_BUDGET_MS || 55 * 60 * 1000);

/**
 * Feasibility categorization (Mike Watson Claude Report [Study|Site] Level WIP).
 * These are the dimensions Ora uses — not just sync filters.
 */
const FEASIBILITY_LEVELS = {
  study: {
    reportType: "Study with Metrics and Milestone",
    grain: "study",
    requires: ["study", "metrics", "milestones"],
    filters: {
      metricStudyCountryBlank: true,
      milestoneStudyCountryBlank: true,
      oraProjectCodeNotBlank: true
    }
  },
  site: {
    reportType: "Study Site with Metrics and Milestone",
    grain: "site",
    requires: ["site", "metrics", "milestones"],
    filters: {
      metricSiteNotBlank: true,
      milestoneSiteNotBlank: true,
      oraProjectCodeNotBlank: true
    }
  }
};

const FEASIBILITY_METRIC_TYPES = [
  "Drop Out Rate (%)",
  "Enrolment Rate (subjects per month)",
  "Enrollment Rate (subjects per month)",
  "Screen Failure Rate (%)",
  "Total Enrolled",
  "Total Screened",
  "Total Discontinued"
];

/** Site-level milestone types from the Site Level report. */
const FEASIBILITY_MILESTONE_TYPES_SITE = [
  "First Subject First Visit In",
  "First Subject In",
  "First Subject Out",
  "Last Subject First Visit In",
  "Last Subject In",
  "Last Subject Out",
  "Site Selected",
  "Site Contracts Executed",
  "IRB/EC Approval",
  "Site Initiation Monitoring Visit",
  "Contract / Budget",
  "Contract Executed"
];

/** Study-level milestone types from the Study Level report. */
const FEASIBILITY_MILESTONE_TYPES_STUDY = [
  "First Subject First Visit In",
  "First Subject In",
  "Last Subject First Visit In",
  "Last Subject In",
  "Last Subject Out",
  "First Subject Out"
];

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
      "study_type__v",
      "study_status__v",
      "status__v",
      "therapeutic_area__c",
      "enrollment__vs",
      "number_of_sites__c",
      "country__c",
      "current_project_phase__c",
      "route_of_administration__c",
      "enrollment_method__c",
      "ora_project_code__c",
      "modified_date__v"
    ],
    projectFact: "study"
  },
  {
    // Person — resolve site.principal_investigator__v → display name
    vaultObject: "person__v",
    container: "ora_veeva_person",
    docType: "ora_veeva_person",
    fields: [
      "id",
      "name__v",
      "first_name__v",
      "last_name__v",
      "status__v",
      "email__v",
      "modified_date__v"
    ],
    optional: true
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
      // Ora CTMS uses organization__clin — organization__vr is not a valid relationship here
      "organization__clinr.name__v",
      "organization__clinr.full_name__v",
      "country__v",
      "country__vr.name__v",
      "study_country__v",
      "site_status__v",
      "status__v",
      "indication__c",
      "study_phase__c",
      "study_sponsor__c",
      "location_city__v",
      "location_stateprovince__v",
      "principal_investigator__v",
      "principal_investigator__vr.name__v",
      "principal_investigator__vr.first_name__v",
      "principal_investigator__vr.last_name__v",
      // Direct labels when inbound relationship fields are unavailable
      "TONAME(principal_investigator__v)",
      "TONAME(organization__clin)",
      "no_subjects_enrolled__v",
      "site_selected_date__v",
      "ora_project_code__c",
      "modified_date__v"
    ],
    projectFact: "site"
  },
  {
    vaultObject: "country__v",
    container: "ora_veeva_country",
    docType: "ora_veeva_country",
    fields: ["id", "name__v", "abbreviation__v", "modified_date__v"]
  },
  {
    vaultObject: "study_country__v",
    container: "ora_veeva_study_country",
    docType: "ora_veeva_study_country",
    fields: [
      "id",
      "name__v",
      "study__v",
      "country__v",
      "status__v",
      "study_status__v",
      "modified_date__v"
    ]
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
    // CTMS Metrics — enrollment performance (Ora tenant uses __ctms field suffixes)
    vaultObject: "metrics__ctms",
    container: "ora_veeva_metric",
    docType: "ora_veeva_metric",
    fields: [
      "id",
      "name__v",
      "status__v",
      "object_type__v",
      "metric_type__ctms",
      "planned__ctms",
      "actual__ctms",
      "forecast__ctms",
      "study__ctms",
      "study_country__ctms",
      "site__ctms",
      "ora_project_code__c",
      "modified_date__v"
    ],
    feasibilityMetricFilter: true,
    criticalFields: ["actual__ctms", "study__ctms", "site__ctms"]
  },
  {
    // Site / study fee schedules (negotiated budget headers)
    vaultObject: "fee_schedule__v",
    container: "ora_veeva_fee_schedule",
    docType: "ora_veeva_fee_schedule",
    fields: [
      "id",
      "name__v",
      "status__v",
      "state__v",
      "study__v",
      "site__v",
      "study_country__v",
      "start_date__v",
      "end_date__v",
      "version__v",
      "default_holdback_percentage__v",
      "default_overhead_percentage__v",
      "default_currency__v",
      "primary_payee__v",
      "modified_date__v"
    ]
  },
  {
    // Payment Request — groups payable items for a site payment
    vaultObject: "payment__v",
    container: "ora_veeva_payment",
    docType: "ora_veeva_payment",
    fields: [
      "id",
      "name__v",
      "status__v",
      "state__v",
      "amount__v",
      "amount_corp__sys",
      "local_currency__sys",
      "study__v",
      "site__v",
      "study_country__v",
      "payee__v",
      "ora_project_code__c",
      "check_date__v",
      "check_number__v",
      "payment_date__v",
      "visit_fees_total_amount__c",
      "procedure_fees_total_amount__c",
      "site_fees_total_amount__c",
      "additional_fees_total_amount__c",
      "site_invoice_number__v",
      "site_invoice_number__c",
      "finance_approval_date__c",
      "pm_approval_date__c",
      "modified_date__v"
    ]
  },
  {
    // Payable Item — visit / procedure / site-fee line amounts (largest payment table)
    vaultObject: "payable_item__v",
    container: "ora_veeva_payable_item",
    docType: "ora_veeva_payable_item",
    fields: [
      "id",
      "name__v",
      "status__v",
      "state__v",
      "object_type__v",
      "amount__v",
      "amount_corp__sys",
      "base_amount__c",
      "local_currency__sys",
      "study__v",
      "site__v",
      "study_country__v",
      "payment__v",
      "fee_schedule__v",
      "visit__v",
      "visit_name__v",
      "visit_label__v",
      "procedure__v",
      "procedure_name__v",
      "site_fee__v",
      "site_fee_name__v",
      "subject__v",
      "payee__v",
      "payee_name__v",
      "payment_level__v",
      "budget_category__v",
      "item_date__v",
      "payable_event_date__v",
      "fee_subtype__c",
      "holdback_amount__c",
      "overhead_amount__c",
      "project_code__v",
      "modified_date__v"
    ]
  },
  {
    // Subjects — subject counts / status under study + site
    vaultObject: "subject__clin",
    container: "ora_veeva_subject",
    docType: "ora_veeva_subject",
    fields: [
      "id",
      "name__v",
      "status__v",
      "subject_status__v",
      "study__v",
      "study_country__v",
      "site__v",
      "arm__v",
      "modified_date__v"
    ]
  },
  {
    // Startup / timeline dimension of feasibility (study + site grain)
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

/** Drop unknown fields from VQL until the query succeeds (Vault configs differ).
 * Only drop on explicit unknown-field errors — never on generic "invalid query"
 * text that echoes the SELECT list (that was stripping metrics study__/actual__).
 */
async function vqlSelectResilient(session, vaultObject, fields, { whereExtra = "", watermark = null } = {}) {
  let active = [...fields];
  const dropped = [];
  let whereCleared = false;
  for (let attempt = 0; attempt < 16; attempt++) {
    if (!active.length) {
      throw new Error(`No queryable fields left for ${vaultObject}`);
    }
    let q = `SELECT ${active.join(", ")} FROM ${vaultObject}`;
    const wheres = [];
    if (watermark) wheres.push(`modified_date__v > '${watermark}'`);
    if (whereExtra) wheres.push(`(${whereExtra})`);
    if (wheres.length) q += ` WHERE ${wheres.join(" AND ")}`;
    try {
      const pulled = await vqlQuery(session, q, {});
      return { ...pulled, fieldsUsed: active, fieldsDropped: dropped };
    } catch (err) {
      const msg = String(err.message || err);
      // Unknown relationship [organization__vr] → drop all fields on that relationship
      const rel = msg.match(/Unknown relationship\s*\[([a-z0-9_]+)\]/i);
      if (rel) {
        const prefix = `${rel[1]}.`;
        const before = active.length;
        active = active.filter((f) => !f.startsWith(prefix) && f !== rel[1]);
        if (active.length < before) {
          dropped.push(...Array.from({ length: before - active.length }, () => `${rel[1]}.*`));
          continue;
        }
      }
      // e.g. Unknown field 'first_name__v' in 'select fields' (from principal_investigator__vr.first_name__v)
      const shortUnknown = msg.match(/Unknown field\s+'([a-z0-9_]+)'\s+in\s+'select fields'/i);
      if (shortUnknown) {
        const short = shortUnknown[1];
        const before = active.length;
        active = active.filter(
          (f) => f !== short && !f.endsWith(`.${short}`) && !f.includes(`.${short}`)
        );
        if (active.length < before) {
          dropped.push(short);
          continue;
        }
      }
      const m =
        msg.match(/Unknown (?:field|Field)\s+['`]?([a-z0-9_.()]+)['`]?/i) ||
        msg.match(/Invalid (?:field|Field)\s+['`]?([a-z0-9_.()]+)['`]?/i) ||
        msg.match(/field\s+['`]([a-z0-9_.()]+)['`]\s+(?:not found|does not exist|unknown)/i) ||
        msg.match(/\b([a-z][a-z0-9_]*(?:__v|__c|__clin|__ctms|__vs)(?:\.[a-z][a-z0-9_]*(?:__v|__c))?)\b\s+(?:not found|does not exist)/i);
      const bad = m && active.includes(m[1]) ? m[1] : null;
      if (bad) {
        active = active.filter((f) => f !== bad);
        dropped.push(bad);
        continue;
      }
      // Relationship leaf unknown → drop entire principal_investigator__vr.* / organization__clinr.*
      if (/unknown field|invalid field|select fields/i.test(msg)) {
        const before = active.length;
        active = active.filter(
          (f) =>
            !f.startsWith("principal_investigator__vr.") &&
            !f.startsWith("organization__clinr.") &&
            !f.startsWith("organization__vr.") &&
            !f.startsWith("country__vr.")
        );
        if (active.length < before) {
          dropped.push("relationship.*");
          continue;
        }
      }
      // TONAME(...) not supported on this field — drop those expressions
      if (/TONAME/i.test(msg)) {
        const before = active.length;
        active = active.filter((f) => !/^TONAME\(/i.test(f));
        if (active.length < before) {
          dropped.push("TONAME(*)");
          continue;
        }
      }
      // If WHERE references a missing field (e.g. metric_type), clear filter once
      if (whereExtra && !whereCleared && /WHERE|metric_type|metrics_type|TONAME|modified_date/i.test(msg)) {
        whereExtra = "";
        whereCleared = true;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`VQL field fallback exhausted for ${vaultObject}`);
}

function feasibilityMetricWhere() {
  if (String(process.env.VEEVA_FEASIBILITY_FILTERS || "").trim() !== "1") return "";
  // Prefer CONTAINS on name/type — Vault picklist API names vary by tenant
  const bits = FEASIBILITY_METRIC_TYPES.map((t) => {
    const esc = String(t).replace(/'/g, "\\'");
    return (
      `TONAME(metric_type__ctms) = '${esc}' OR TONAME(metric_type__v) = '${esc}' OR name__v = '${esc}'`
    );
  });
  return bits.join(" OR ");
}

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

/** Merge into syncState.progress so Data Status can poll live ingest. */
async function markVeevaSyncProgress(getDb, patch = {}) {
  const database = getDb();
  const prev = (await readSyncState(database)) || {};
  const prevProg = prev.progress && typeof prev.progress === "object" ? prev.progress : {};
  const now = new Date().toISOString();
  return writeSyncState(database, {
    progress: {
      ...prevProg,
      ...patch,
      updatedAt: now
    }
  });
}

async function countWithField(database, containerId, docType, field) {
  try {
    const rows = await queryAll(
      database.container(containerId),
      `SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t AND IS_DEFINED(c.${field}) AND c.${field} != null`,
      [{ name: "@t", value: docType }]
    );
    return rows[0] || 0;
  } catch (_) {
    return 0;
  }
}

/** Mirrors missing link fields — force a full re-pull instead of delta. */
async function mirrorNeedsFullResync(database, table, existingCount) {
  if (!(existingCount > 0)) return false;
  if (table.container === "ora_veeva_subject") {
    const withSite = await countWithField(database, table.container, table.docType, "site__v");
    return withSite === 0;
  }
  if (table.container === "ora_veeva_metric") {
    const withActualCtms = await countWithField(
      database,
      table.container,
      table.docType,
      "actual__ctms"
    );
    const withActual = await countWithField(database, table.container, table.docType, "actual__v");
    const withSiteCtms = await countWithField(database, table.container, table.docType, "site__ctms");
    const withSite = await countWithField(database, table.container, table.docType, "site__v");
    return withActualCtms === 0 && withActual === 0 && withSiteCtms === 0 && withSite === 0;
  }
  return false;
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

function looksLikeVaultId(raw) {
  const s = String(raw || "").trim();
  if (!s || /\s/.test(s)) return false;
  if (/^00[A-Za-z][0-9A-Za-z]{8,}$/i.test(s)) return true;
  if (/^[A-Z]{2,4}[0-9A-Za-z]{10,}$/i.test(s)) return true;
  if (/^person__v\./i.test(s)) return true;
  return false;
}

function personDisplayName(row) {
  if (!row) return null;
  const combined = [row.first_name__v, row.last_name__v].filter(Boolean).join(" ").trim();
  const name = String(row.name__v || combined || "").trim();
  if (!name || looksLikeVaultId(name)) return null;
  return name;
}

async function loadPersonNameMap(database) {
  const map = new Map();
  try {
    const rows = await queryAll(
      database.container("ora_veeva_person"),
      `SELECT c.id, c.veevaId, c.name__v, c.first_name__v, c.last_name__v, c.display_name FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_veeva_person" }]
    );
    for (const r of rows || []) {
      const name = personDisplayName(r) || personDisplayName({ name__v: r.display_name });
      if (!name) continue;
      for (const key of [r.id, r.veevaId]) {
        if (!key) continue;
        const id = String(key).trim();
        map.set(id, name);
        map.set(id.toUpperCase(), name);
        map.set(id.toLowerCase(), name);
      }
    }
  } catch (_) {
    /* person mirror optional until first sync */
  }
  return map;
}

async function loadOrgNameMap(database) {
  const map = new Map();
  try {
    const rows = await queryAll(
      database.container("ora_veeva_organization"),
      `SELECT c.id, c.veevaId, c.name__v, c.full_name__v, c.organization__clin FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_veeva_organization" }]
    );
    for (const r of rows || []) {
      const name = String(r.full_name__v || r.name__v || "").trim();
      if (!name || looksLikeVaultId(name)) continue;
      for (const key of [r.id, r.veevaId, r.organization__clin]) {
        if (!key) continue;
        const id = String(key).trim();
        map.set(id, name);
        map.set(id.toUpperCase(), name);
        map.set(id.toLowerCase(), name);
      }
    }
  } catch (_) {
    /* org mirror optional */
  }
  return map;
}

/** Patch sites that still have PI ids / blank names once person__v is mirrored. */
async function enrichExistingSitePiNames(database, started, budgetMs) {
  const personNameById = await loadPersonNameMap(database);
  if (!personNameById.size) return { patched: 0, scanned: 0, personNames: 0 };
  await ensureContainer(database, "ora_veeva_site");
  const sites = await queryAll(
    database.container("ora_veeva_site"),
    `SELECT TOP 5000 c.id, c.principal_investigator__v, c.principal_investigator_name
     FROM c WHERE c.docType = @t AND IS_DEFINED(c.principal_investigator__v)`,
    [{ name: "@t", value: "ora_veeva_site" }]
  );
  let patched = 0;
  let missed = 0;
  const sampleMiss = [];
  const container = database.container("ora_veeva_site");
  for (const site of sites || []) {
    if (Date.now() - started > budgetMs) break;
    const piId = site.principal_investigator__v != null ? String(site.principal_investigator__v).trim() : "";
    if (!piId) continue;
    const name =
      personNameById.get(piId) ||
      personNameById.get(piId.toUpperCase()) ||
      personNameById.get(piId.toLowerCase());
    if (!name) {
      missed += 1;
      if (sampleMiss.length < 8) sampleMiss.push(piId);
      continue;
    }
    const cur = site.principal_investigator_name != null ? String(site.principal_investigator_name).trim() : "";
    if (cur && !looksLikeVaultId(cur) && cur === name) continue;
    try {
      const { resource } = await container.item(String(site.id), String(site.id)).read();
      if (!resource) continue;
      resource.principal_investigator_name = name;
      resource.veevaPiEnrichedAt = new Date().toISOString();
      await container.items.upsert(resource);
      patched += 1;
    } catch (_) {
      /* skip stubborn rows */
    }
  }
  return {
    patched,
    scanned: (sites || []).length,
    personNames: personNameById.size,
    missed,
    sampleMiss
  };
}

/** Patch sites that still show Vault org/site ids instead of institution names. */
async function enrichExistingSiteOrgNames(database, started, budgetMs) {
  const orgNameById = await loadOrgNameMap(database);
  if (!orgNameById.size) return { patched: 0, scanned: 0, orgNames: 0 };
  await ensureContainer(database, "ora_veeva_site");
  const sites = await queryAll(
    database.container("ora_veeva_site"),
    `SELECT TOP 5000 c.id, c.organization__clin, c.organization__v, c.organization_name, c.site_name__v, c.name__v
     FROM c WHERE c.docType = @t`,
    [{ name: "@t", value: "ora_veeva_site" }]
  );
  let patched = 0;
  const container = database.container("ora_veeva_site");
  for (const site of sites || []) {
    if (Date.now() - started > budgetMs) break;
    const orgId =
      site.organization__clin != null
        ? String(site.organization__clin).trim()
        : site.organization__v != null
          ? String(site.organization__v).trim()
          : "";
    if (!orgId) continue;
    const name =
      orgNameById.get(orgId) ||
      orgNameById.get(orgId.toUpperCase()) ||
      orgNameById.get(orgId.toLowerCase());
    if (!name) continue;
    const curOrg = site.organization_name != null ? String(site.organization_name).trim() : "";
    const curSite = site.site_name__v != null ? String(site.site_name__v).trim() : "";
    const needsOrg = !curOrg || looksLikeVaultId(curOrg);
    const needsSite = !curSite || looksLikeVaultId(curSite);
    if (!needsOrg && !needsSite) continue;
    try {
      const { resource } = await container.item(String(site.id), String(site.id)).read();
      if (!resource) continue;
      if (needsOrg) resource.organization_name = name;
      if (needsSite) resource.site_name__v = name;
      resource.veevaOrgEnrichedAt = new Date().toISOString();
      await container.items.upsert(resource);
      patched += 1;
    } catch (_) {
      /* skip stubborn rows */
    }
  }
  return { patched, scanned: (sites || []).length, orgNames: orgNameById.size };
}

function toMirrorDoc(rec, docType, syncedAt, opts = {}) {
  const flat = flattenVeevaRecord(rec);
  const id = String(flat.id || "").trim();
  if (!id) return null;
  const doc = {
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
  // Flatten relationship labels so consumers never need dotted Vault keys.
  if (docType === "ora_veeva_metric") {
    // Ora tenant uses __ctms suffixes; keep __v aliases for Buddy / Lens readers.
    if (doc.planned__v == null && doc.planned__ctms != null) doc.planned__v = doc.planned__ctms;
    if (doc.actual__v == null && doc.actual__ctms != null) doc.actual__v = doc.actual__ctms;
    if (doc.forecast__v == null && doc.forecast__ctms != null) doc.forecast__v = doc.forecast__ctms;
    if (doc.study__v == null && doc.study__ctms != null) doc.study__v = doc.study__ctms;
    if (doc.site__v == null && doc.site__ctms != null) doc.site__v = doc.site__ctms;
    if (doc.study_country__v == null && doc.study_country__ctms != null) {
      doc.study_country__v = doc.study_country__ctms;
    }
    if (doc.metric_type__v == null && doc.metric_type__ctms != null) {
      doc.metric_type__v = doc.metric_type__ctms;
    }
  }
  if (docType === "ora_veeva_site") {
    const countryName =
      flat["country__vr.name__v"] ||
      (typeof flat.country__vr === "string" ? flat.country__vr : null) ||
      flat.country_name ||
      null;
    if (countryName && !looksLikeVaultId(countryName) && !/^00C/i.test(String(countryName))) {
      doc.country_name = String(countryName).trim();
    }
    const tonameOrg =
      flat["toname(organization__clin)"] ||
      flat["TONAME(organization__clin)"] ||
      flat.toname_organization__clin ||
      null;
    const tonamePi =
      flat["toname(principal_investigator__v)"] ||
      flat["TONAME(principal_investigator__v)"] ||
      flat.toname_principal_investigator__v ||
      null;
    const orgFromRel =
      tonameOrg ||
      flat["organization__clinr.full_name__v"] ||
      flat["organization__clinr.name__v"] ||
      (typeof flat.organization__clinr === "string" ? flat.organization__clinr : null) ||
      flat.organization_name ||
      null;
    const orgId =
      flat.organization__clin != null
        ? String(flat.organization__clin).trim()
        : flat.organization__v != null
          ? String(flat.organization__v).trim()
          : "";
    const orgFromMap =
      orgId && opts.orgNameById && opts.orgNameById.get ? opts.orgNameById.get(orgId) : null;
    const orgName =
      orgFromRel && !looksLikeVaultId(orgFromRel) ? orgFromRel : orgFromMap || null;
    if (orgName && !looksLikeVaultId(orgName)) {
      doc.organization_name = String(orgName).trim();
      // Prefer institution name over Vault site id for site_name__v consumers.
      if (!doc.site_name__v || looksLikeVaultId(doc.site_name__v)) {
        doc.site_name__v = doc.organization_name;
      }
    } else if (doc.organization_name && looksLikeVaultId(doc.organization_name)) {
      delete doc.organization_name;
    }
    if (doc.site_name__v && looksLikeVaultId(doc.site_name__v)) {
      delete doc.site_name__v;
    }
    const piFirst = flat["principal_investigator__vr.first_name__v"];
    const piLast = flat["principal_investigator__vr.last_name__v"];
    const fromRel =
      tonamePi ||
      flat["principal_investigator__vr.name__v"] ||
      (typeof flat.principal_investigator__vr === "string" ? flat.principal_investigator__vr : null) ||
      [piFirst, piLast].filter(Boolean).join(" ").trim() ||
      flat.principal_investigator_name ||
      null;
    const piId = flat.principal_investigator__v != null ? String(flat.principal_investigator__v).trim() : "";
    const fromPerson =
      piId && opts.personNameById && opts.personNameById.get
        ? opts.personNameById.get(piId) ||
          opts.personNameById.get(piId.toUpperCase()) ||
          opts.personNameById.get(piId.toLowerCase())
        : null;
    const piName = fromRel && !looksLikeVaultId(fromRel) ? fromRel : fromPerson || null;
    if (piName && !looksLikeVaultId(piName)) {
      doc.principal_investigator_name = String(piName).trim();
    } else if (doc.principal_investigator_name && looksLikeVaultId(doc.principal_investigator_name)) {
      delete doc.principal_investigator_name;
    }
  }
  if (docType === "ora_veeva_person") {
    const n = personDisplayName(doc);
    if (n) doc.display_name = n;
  }
  if (docType === "ora_veeva_country") {
    const name = flat.name__v || flat.abbreviation__v;
    if (name) doc.country_name = String(name).trim();
  }
  return doc;
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
  // Indication picklist on study__v (indication__v) — not free text
  const indicationRaw = mirror.indication__v || mirror.indication__c || null;
  const indication = indicationRaw ? vaultIndicationLabel(indicationRaw) : "_unknown";
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
    indication_picklist: indicationRaw ? String(indicationRaw) : null,
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

function projectFactSite(mirror, orgNameById, countryNameById, studyIndicationById = null) {
  const org =
    (mirror.organization__clin && orgNameById.get(mirror.organization__clin)) ||
    mirror.site_name__v ||
    mirror.name__v ||
    null;
  const country =
    (mirror.country__v && countryNameById.get(mirror.country__v)) ||
    mirror.country__v ||
    "_unknown";
  const fromSite = mirror.indication__c ? vaultIndicationLabel(mirror.indication__c) : null;
  const fromStudy =
    studyIndicationById && mirror.study__v
      ? studyIndicationById.get(mirror.study__v)
      : null;
  const indication = fromSite || fromStudy || "_unknown";
  const totalEnrolled =
    mirror.no_subjects_enrolled__v != null ? Number(mirror.no_subjects_enrolled__v) : null;
  return {
    id: `live-${mirror.id}`,
    docType: "ora_fact_site",
    dataset: "ora_clinical_intelligence",
    schemaVersion: 1,
    source: "veeva_live",
    veeva_site_id: mirror.id,
    veeva_study_id: mirror.study__v || null,
    study_name: mirror.study_name__v || mirror.study_number__v || mirror.study__v || null,
    org_clean: org,
    organization: org,
    country: country || "_unknown",
    indication,
    site_psm: null,
    total_enrolled: totalEnrolled,
    site_enroll_months: null,
    fsi_date: null,
    lsi_date: null,
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
    const when =
      milestoneSingleDayActualDate(m) || parseMilestoneDateIso(m.planned_finish_date__v);
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

/**
 * Compute site PSM on live ora_fact_site:
 *   site_psm = total_enrolled / site_enroll_months
 *   site_enroll_months = months(FPFV → LPFV), minimum 1
 * FPFV/LPFV = First/Last Subject First Visit — not FSI/LSI (Subject In).
 */
async function projectSitePsmFromMilestones(database, opts = {}) {
  const syncedAt = opts.syncedAt || new Date().toISOString();
  const milestoneContainer = database.container("ora_veeva_milestone");
  const siteContainer = database.container("ora_veeva_site");
  const factContainer = await ensureContainer(database, "ora_fact_site", "/country");

  const sites = await queryAll(
    siteContainer,
    `SELECT c.id, c.study__v, c.no_subjects_enrolled__v, c.name__v, c.site_name__v,
            c.organization__clin, c.country__v, c.study_name__v, c.study_number__v,
            c.indication__c
     FROM c WHERE c.docType = @t`,
    [{ name: "@t", value: "ora_veeva_site" }]
  );
  const siteById = new Map(sites.map((s) => [s.id, s]));

  // Fallback enrolled counts from subject__clin when site.no_subjects_enrolled__v is empty
  const enrolledBySite = new Map();
  try {
    const subjects = await queryAll(
      database.container("ora_veeva_subject"),
      `SELECT c.site__v, c.study__v, c.subject_status__v, c.status__v, c.name__v
       FROM c WHERE c.docType = @t AND IS_DEFINED(c.site__v) AND c.site__v != null`,
      [{ name: "@t", value: "ora_veeva_subject" }]
    );
    for (const sub of subjects) {
      const status = `${sub.subject_status__v || ""} ${sub.status__v || ""}`.toLowerCase();
      // Count randomized/enrolled/active; skip screen-fail / withdrawn when labeled
      if (/\bscreen\s*fail|withdrawn|discontinued|not enrolled\b/.test(status)) continue;
      if (status && !/\benroll|random|active|completed|in treatment|dosed\b/.test(status)) {
        // unlabeled status — still count as enrolled subject row (Vault often sparse)
      }
      const key = sub.site__v;
      enrolledBySite.set(key, (enrolledBySite.get(key) || 0) + 1);
    }
  } catch (_) {
    /* subjects optional */
  }

  const ms = await queryAll(
    milestoneContainer,
    `SELECT c.site__v, c.study__v, c.name__v, c.milestone_type__v, c.actual_finish_date__v, c.actual_start_date__v
     FROM c WHERE c.docType = @t AND IS_DEFINED(c.site__v) AND c.site__v != null`,
    [{ name: "@t", value: "ora_veeva_milestone" }]
  );

  const datesBySite = new Map();
  for (const m of ms) {
    const kind = classifyPsmWindowMilestone(m.name__v, m.milestone_type__v);
    if (!kind) continue;
    const when = milestoneSingleDayActualDate(m);
    if (!when) continue;
    const key = m.site__v;
    if (!datesBySite.has(key)) datesBySite.set(key, {});
    const pack = datesBySite.get(key);
    if (kind === "fpfv") {
      if (!pack.fpfv || Date.parse(when) < Date.parse(pack.fpfv)) pack.fpfv = when;
    } else if (kind === "lpfv") {
      if (!pack.lpfv || Date.parse(when) > Date.parse(pack.lpfv)) pack.lpfv = when;
    }
  }

  let updated = 0;
  let withPsm = 0;
  let zeroPsm = 0;
  let enrolledFromSubjects = 0;
  const maps = await loadNameMaps(database);
  const studyInd = new Map();
  try {
    const studies = await queryAll(
      database.container("ora_veeva_study"),
      `SELECT c.id, c.indication__v, c.indication__c FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_veeva_study" }]
    );
    for (const s of studies) {
      const ind = vaultIndicationLabel(s.indication__v || s.indication__c);
      if (ind && ind !== "_unknown") studyInd.set(s.id, ind);
    }
  } catch (_) {
    /* optional */
  }

  const studyEnrollById = new Map();
  try {
    const enrollRows = await queryAll(
      database.container("ora_veeva_study"),
      `SELECT c.id, c.enrollment__vs FROM c WHERE c.docType = @t AND IS_DEFINED(c.enrollment__vs) AND c.enrollment__vs != null`,
      [{ name: "@t", value: "ora_veeva_study" }]
    );
    for (const s of enrollRows) {
      const n = Number(s.enrollment__vs);
      if (n > 0) studyEnrollById.set(s.id, n);
    }
  } catch (_) {
    /* optional */
  }

  const fpfvLpfvCountByStudy = new Map();
  for (const [siteId, dates] of datesBySite.entries()) {
    if (!dates.fpfv || !dates.lpfv) continue;
    const site = siteById.get(siteId);
    if (!site?.study__v) continue;
    fpfvLpfvCountByStudy.set(site.study__v, (fpfvLpfvCountByStudy.get(site.study__v) || 0) + 1);
  }

  for (const [siteId, dates] of datesBySite.entries()) {
    const site = siteById.get(siteId);
    if (!site) continue;
    const months = siteEnrollMonthsFromFpfvLpfv(dates.fpfv, dates.lpfv);
    let enrolled =
      site.no_subjects_enrolled__v != null ? Number(site.no_subjects_enrolled__v) : null;
    let enrolledSource = enrolled != null ? "site.no_subjects_enrolled__v" : null;
    if (enrolled == null && enrolledBySite.has(siteId)) {
      enrolled = enrolledBySite.get(siteId);
      enrolledSource = "subject_count";
      enrolledFromSubjects += 1;
    }
    if (enrolled == null && site.study__v && dates.fpfv && dates.lpfv) {
      const studyTotal = studyEnrollById.get(site.study__v);
      const nSites = fpfvLpfvCountByStudy.get(site.study__v);
      if (studyTotal > 0 && nSites > 0) {
        enrolled = studyTotal / nSites;
        enrolledSource = "study.enrollment__vs/shared_fpfv_lpfv_sites";
      }
    }
    const sitePsm = months != null && enrolled != null ? computeSitePsm(enrolled, months) : null;

    const id = `live-${siteId}`;
    let existing = null;
    try {
      const found = await queryAll(
        factContainer,
        `SELECT * FROM c WHERE c.id = @id`,
        [{ name: "@id", value: id }]
      );
      existing = found[0] || null;
    } catch (_) {
      existing = null;
    }

    const base =
      existing && existing.source === "veeva_live"
        ? existing
        : projectFactSite(site, maps.orgNameById, new Map(), studyInd);

    const doc = {
      ...base,
      id,
      source: "veeva_live",
      veeva_study_id: site.study__v || base.veeva_study_id || null,
      indication:
        (site.study__v && studyInd.get(site.study__v)) ||
        base.indication ||
        vaultIndicationLabel(site.indication__c) ||
        "_unknown",
      fsi_date: dates.fpfv || base.fsi_date || null,
      lsi_date: dates.lpfv || base.lsi_date || null,
      fpfv_date: dates.fpfv || base.fpfv_date || null,
      lpfv_date: dates.lpfv || base.lpfv_date || null,
      site_enroll_months: months,
      total_enrolled: enrolled != null ? enrolled : base.total_enrolled ?? null,
      enrolled_source: enrolledSource,
      site_psm: sitePsm,
      psm_zero_enrolled: sitePsm === 0,
      psm_formula: "total_enrolled / months(FPFV→LPFV visit milestones only, min 1 month)",
      veevaSyncedAt: syncedAt,
      importedAt: syncedAt
    };

    try {
      if (existing && existing.country && existing.country !== doc.country) {
        try {
          await factContainer.item(id, existing.country).delete();
        } catch (_) {}
      }
      await factContainer.items.upsert(doc);
      updated += 1;
      if (typeof sitePsm === "number" && sitePsm > 0) withPsm += 1;
      if (sitePsm === 0) zeroPsm += 1;
    } catch (_) {
      /* continue */
    }
  }

  return {
    updated,
    withPsm,
    zeroPsm,
    enrolledFromSubjects,
    sitesWithFpfvLpfv: [...datesBySite.values()].filter((d) => d.fpfv && d.lpfv).length,
    note: "site_psm = enrolled / months(FPFV→LPFV visit milestones only; FSI/LSI excluded)"
  };
}

/**
 * Roll site_psm up to ora_fact_study.psm (median of positive site PSMs for that study).
 */
async function projectStudyPsmFromSites(database, opts = {}) {
  const syncedAt = opts.syncedAt || new Date().toISOString();
  const siteFact = database.container("ora_fact_site");
  const studyFact = await ensureContainer(database, "ora_fact_study", "/study_number");
  const rows = await queryAll(
    siteFact,
    `SELECT c.veeva_study_id, c.study_name, c.site_psm, c.source
     FROM c WHERE c.docType = @t AND IS_DEFINED(c.site_psm) AND c.site_psm > 0`,
    [{ name: "@t", value: "ora_fact_site" }]
  );
  const byStudy = new Map();
  for (const r of rows) {
    if (r.source && r.source !== "veeva_live") continue;
    const key = r.veeva_study_id || r.study_name;
    if (!key) continue;
    if (!byStudy.has(key)) byStudy.set(key, []);
    byStudy.get(key).push(Number(r.site_psm));
  }
  let updated = 0;
  for (const [key, psms] of byStudy.entries()) {
    if (!psms.length) continue;
    const sorted = [...psms].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const med =
      sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const psm = Math.round(med * 1000) / 1000;
    try {
      const found = await queryAll(
        studyFact,
        `SELECT * FROM c WHERE c.docType = @t AND (c.veeva_study_id = @k OR c.study_number = @k OR c.id = @id)`,
        [
          { name: "@t", value: "ora_fact_study" },
          { name: "@k", value: key },
          { name: "@id", value: `live-${key}` }
        ]
      );
      for (const doc of found) {
        if (doc.source && doc.source !== "veeva_live") continue;
        await studyFact.items.upsert({
          ...doc,
          psm,
          psm_source: "median_site_psm",
          studies_sites_with_psm: psms.length,
          veevaSyncedAt: syncedAt,
          importedAt: syncedAt
        });
        updated += 1;
      }
    } catch (_) {
      /* continue */
    }
  }
  return { updated, studiesWithSitePsm: byStudy.size };
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
  const results = [];
  let upsertedTotal = 0;
  let incomplete = false;

  // Run name backfills FIRST — milestones/payables often burn the budget before enrich.
  if (opts.enrichOnly === true || opts.prioritizeEmpty === true || opts.full === true || !deltaMode) {
    try {
      await markVeevaSyncProgress(getDb, {
        status: "running",
        message: "Enriching site org + PI display names…",
        currentObject: "site_enrich",
        currentContainer: "ora_veeva_site"
      });
      const orgEnrich = await enrichExistingSiteOrgNames(database, started, TIME_BUDGET_MS);
      if (orgEnrich && (orgEnrich.patched || orgEnrich.orgNames)) {
        results.push({
          object: "site_org_enrich",
          container: "ora_veeva_site",
          upserted: orgEnrich.patched || 0,
          scanned: orgEnrich.scanned,
          orgNames: orgEnrich.orgNames,
          note: "organization__clin → organization__v name (early)"
        });
        upsertedTotal += orgEnrich.patched || 0;
      }
      const piEnrich = await enrichExistingSitePiNames(database, started, TIME_BUDGET_MS);
      if (piEnrich && (piEnrich.patched || piEnrich.personNames)) {
        results.push({
          object: "site_pi_enrich",
          container: "ora_veeva_site",
          upserted: piEnrich.patched || 0,
          scanned: piEnrich.scanned,
          personNames: piEnrich.personNames,
          note: "principal_investigator__v → person__v name (early)",
          sampleMiss: piEnrich.sampleMiss || undefined
        });
        upsertedTotal += piEnrich.patched || 0;
      }
    } catch (err) {
      results.push({
        object: "site_enrich_early",
        ok: false,
        error: String(err.message || err).slice(0, 200)
      });
    }
  }
  if (opts.enrichOnly === true) {
    // Site PI ids are often V0R… (not person__v). Re-pull sites with TONAME so
    // principal_investigator_name / organization_name land without an id join.
    const siteTable = VEEVA_TABLES.find((t) => t.vaultObject === "site__v");
    if (siteTable && Date.now() - started < TIME_BUDGET_MS) {
      try {
        await markVeevaSyncProgress(getDb, {
          status: "running",
          message: "Re-pulling site__v for TONAME PI/org labels…",
          currentObject: "site__v",
          currentContainer: "ora_veeva_site"
        });
        const container = await ensureContainer(database, siteTable.container);
        const pulled = await vqlSelectResilient(session, siteTable.vaultObject, siteTable.fields, {
          watermark: null
        });
        const personNameById = await loadPersonNameMap(database);
        const orgNameById = await loadOrgNameMap(database);
        const syncedAtSites = new Date().toISOString();
        let siteUpserted = 0;
        let withPiName = 0;
        for (const rec of pulled.records || []) {
          if (Date.now() - started > TIME_BUDGET_MS) {
            incomplete = true;
            break;
          }
          const doc = toMirrorDoc(rec, siteTable.docType, syncedAtSites, {
            personNameById,
            orgNameById
          });
          if (!doc) continue;
          await container.items.upsert(doc);
          siteUpserted += 1;
          if (doc.principal_investigator_name) withPiName += 1;
        }
        results.push({
          object: "site__v",
          container: "ora_veeva_site",
          mode: "full",
          fetched: (pulled.records || []).length,
          upserted: siteUpserted,
          withPiName,
          fieldsDropped: pulled.fieldsDropped || [],
          note: "enrichOnly site re-pull for TONAME PI/org names"
        });
        upsertedTotal += siteUpserted;
      } catch (err) {
        results.push({
          object: "site__v",
          container: "ora_veeva_site",
          ok: false,
          error: String(err.message || err).slice(0, 240)
        });
      }
    }
    const syncedAt = new Date().toISOString();
    await writeSyncState(database, {
      lastRunAt: syncedAt,
      note: "Site org/PI enrich + site TONAME re-pull",
      progress: {
        status: incomplete ? "incomplete" : "complete",
        startedAt: new Date(started).toISOString(),
        updatedAt: syncedAt,
        objectsTotal: results.length,
        objectsDone: results.length,
        upsertedTotal,
        message: incomplete ? "Site name enrich partial (time budget)" : "Site name enrich finished",
        results
      }
    });
    return {
      ok: true,
      enrichOnly: true,
      results,
      upsertedTotal,
      incomplete,
      elapsedMs: Date.now() - started,
      sync: await readSyncState(database)
    };
  }

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
    : [...VEEVA_TABLES];

  // Lean feasibility dims before heavy site__v; subjects last (largest).
  // Empty mirrors always sort first so re-runs fill metrics/milestones/subjects
  // instead of burning the budget re-upserting 3k+ sites.
  const rank = (t) => {
    switch (t.vaultObject) {
      case "sponsor__c":
        return 0;
      case "country__v":
        return 1;
      case "organization__v":
        return 2;
      case "person__v":
        return 3;
      case "study__v":
        return 4;
      case "study_country__v":
        return 5;
      case "site__v":
        // Sites early so TONAME + person/org maps stamp names before heavy tables burn budget
        return 6;
      case "metrics__ctms":
        return 7;
      case "milestone__v":
        return 8;
      case "fee_schedule__v":
        return 9;
      case "payment__v":
        return 10;
      case "payable_item__v":
        return 11;
      case "subject__clin":
      case "subject__v":
        return 12;
      default:
        return 13;
    }
  };
  const countsByContainer = {};
  for (const t of tables) {
    countsByContainer[t.container] = await countDocType(database, t.container, t.docType);
  }
  const prioritizeEmpty =
    opts.prioritizeEmpty === true ||
    opts.resume === true ||
    opts.full === true ||
    Boolean(prev.incomplete) ||
    Object.values(countsByContainer).some((c) => typeof c === "number" && c === 0);
  tables.sort((a, b) => {
    if (prioritizeEmpty) {
      const aEmpty = (countsByContainer[a.container] || 0) === 0 ? 0 : 1;
      const bEmpty = (countsByContainer[b.container] || 0) === 0 ? 0 : 1;
      if (aEmpty !== bEmpty) return aEmpty - bEmpty;
    }
    return rank(a) - rank(b);
  });

  const syncedAt = new Date().toISOString();

  await writeSyncState(database, {
    lastRunAt: syncedAt,
    incomplete: true,
    progress: {
      status: "running",
      startedAt: syncedAt,
      updatedAt: syncedAt,
      mode: watermark ? "delta" : "full",
      triggeredBy: opts.triggeredBy || "api",
      currentObject: null,
      currentContainer: null,
      objectsTotal: tables.length,
      objectsDone: 0,
      objectsSkipped: 0,
      upsertedTotal: 0,
      message: `Starting Veeva ${watermark ? "delta" : "full"} sync (${tables.length} objects)…`,
      results: []
    }
  });

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
    await writeSyncState(database, {
      progress: {
        status: "running",
        startedAt: syncedAt,
        updatedAt: new Date().toISOString(),
        mode: watermark ? "delta" : "full",
        triggeredBy: opts.triggeredBy || "api",
        currentObject: table.vaultObject,
        currentContainer: table.container,
        objectsTotal: tables.length,
        objectsDone: results.filter((r) => !r.skipped || r.reason !== "time_budget").length,
        objectsSkipped: results.filter((r) => r.skipped).length,
        upsertedTotal,
        message: `Pulling ${table.vaultObject} → ${table.container}…`,
        results: results.slice(-8)
      }
    });
    const t0 = Date.now();
    try {
      const container = await ensureContainer(database, table.container);
      const whereExtra = table.feasibilityMetricFilter ? feasibilityMetricWhere() : "";
      // Empty mirrors must full-pull even in delta mode — watermark would skip history.
      const existing = countsByContainer[table.container] || 0;
      const needsFull = await mirrorNeedsFullResync(database, table, existing);
      const tableWatermark = existing === 0 || needsFull ? null : watermark;
      const pulled = await vqlSelectResilient(session, table.vaultObject, table.fields, {
        watermark: tableWatermark,
        whereExtra
      });
      const criticalList = Array.isArray(table.criticalFields)
        ? table.criticalFields
        : ["site__v", "study__v", "actual__v", "subject_status__v"];
      const criticalDropped = (pulled.fieldsDropped || []).filter((f) => criticalList.includes(f));

      // Never write stripped mirrors (e.g. metrics without actual__/study__/site__) — that
      // marks the container "full" while useless and burns every subsequent budget.
      if (criticalDropped.length) {
        const optional = table.optional === true;
        if (!optional) incomplete = true;
        results.push({
          object: table.vaultObject,
          container: table.container,
          ok: false,
          optional,
          mode: tableWatermark ? "delta" : "full",
          fetched: pulled.records.length,
          upserted: 0,
          fieldsDropped: pulled.fieldsDropped || [],
          criticalFieldsDropped: criticalDropped,
          error: `Refused upsert — critical fields dropped from VQL: ${criticalDropped.join(", ")}`,
          elapsedMs: Date.now() - t0
        });
        continue;
      }

      let upserted = 0;
      const errors = [];
      const mirrors = [];
      let personNameById = null;
      let orgNameById = null;
      if (table.docType === "ora_veeva_site") {
        personNameById = await loadPersonNameMap(database);
        orgNameById = await loadOrgNameMap(database);
      }
      for (const rec of pulled.records) {
        if (Date.now() - started > TIME_BUDGET_MS) {
          incomplete = true;
          break;
        }
        const doc = toMirrorDoc(rec, table.docType, syncedAt, { personNameById, orgNameById });
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
              const doc = projectFactStudy(m, maps.sponsorNameById);
              // PK=/indication — remove prior live row if picklist canonicalization changed the label
              try {
                const prior = await queryAll(
                  fact,
                  `SELECT c.id, c.indication FROM c WHERE c.id = @id AND c.source = @s`,
                  [
                    { name: "@id", value: doc.id },
                    { name: "@s", value: "veeva_live" }
                  ]
                );
                for (const p of prior) {
                  if (p.indication && p.indication !== doc.indication) {
                    try {
                      await fact.item(p.id, p.indication).delete();
                    } catch (_) {}
                  }
                }
              } catch (_) {}
              await fact.items.upsert(doc);
              projected += 1;
            } catch (_) {}
          }
        } else if (table.projectFact === "site") {
          const fact = await ensureContainer(database, "ora_fact_site", "/country");
          const studyInd = new Map();
          try {
            const studies = await queryAll(
              database.container("ora_veeva_study"),
              `SELECT c.id, c.indication__v, c.indication__c FROM c WHERE c.docType = @t`,
              [{ name: "@t", value: "ora_veeva_study" }]
            );
            for (const s of studies) {
              const ind = vaultIndicationLabel(s.indication__v || s.indication__c);
              if (ind && ind !== "_unknown") studyInd.set(s.id, ind);
            }
          } catch (_) {
            /* optional */
          }
          for (const m of mirrors) {
            try {
              await fact.items.upsert(projectFactSite(m, maps.orgNameById, new Map(), studyInd));
              projected += 1;
            } catch (_) {}
          }
        }
      }

      countsByContainer[table.container] = (countsByContainer[table.container] || 0) + upserted;
      upsertedTotal += upserted;
      results.push({
        object: table.vaultObject,
        container: table.container,
        mode: tableWatermark ? "delta" : "full",
        fetched: pulled.records.length,
        upserted,
        projected,
        totalHint: pulled.total,
        pages: pulled.pages,
        truncated: pulled.truncated || incomplete,
        fieldsDropped: pulled.fieldsDropped || [],
        criticalFieldsDropped: criticalDropped.length ? criticalDropped : undefined,
        degraded: criticalDropped.length > 0 || needsFull,
        resyncMode: needsFull ? "full_for_degraded_mirror" : tableWatermark ? "delta" : "full",
        errorCount: errors.length,
        errors: errors.slice(0, 5),
        elapsedMs: Date.now() - t0
      });
      await writeSyncState(database, {
        progress: {
          status: "running",
          startedAt: syncedAt,
          updatedAt: new Date().toISOString(),
          mode: watermark ? "delta" : "full",
          triggeredBy: opts.triggeredBy || "api",
          currentObject: table.vaultObject,
          currentContainer: table.container,
          objectsTotal: tables.length,
          objectsDone: results.length,
          objectsSkipped: results.filter((r) => r.skipped).length,
          upsertedTotal,
          message: `Finished ${table.vaultObject} (${upserted.toLocaleString()} upserted)`,
          results: results.slice(-8)
        }
      });
    } catch (err) {
      const msg = String(err.message || err);
      // Some Vaults use subject__v instead of subject__clin
      if (
        table.vaultObject === "subject__clin" &&
        /subject__clin|Unknown object|INVALID_DATA|does not exist/i.test(msg)
      ) {
        try {
          const alt = { ...table, vaultObject: "subject__v" };
          const container = await ensureContainer(database, alt.container);
          const pulled = await vqlSelectResilient(session, alt.vaultObject, alt.fields, {
            watermark: (countsByContainer[alt.container] || 0) === 0 ? null : watermark
          });
          let upserted = 0;
          for (const rec of pulled.records) {
            if (Date.now() - started > TIME_BUDGET_MS) {
              incomplete = true;
              break;
            }
            const doc = toMirrorDoc(rec, alt.docType, syncedAt);
            if (!doc) continue;
            await container.items.upsert(doc);
            upserted += 1;
          }
          results.push({
            object: "subject__v",
            container: alt.container,
            mode: watermark ? "delta" : "full",
            fetched: pulled.records.length,
            upserted,
            note: "fell back from subject__clin",
            fieldsDropped: pulled.fieldsDropped || [],
            elapsedMs: Date.now() - t0
          });
          upsertedTotal += upserted;
          continue;
        } catch (err2) {
          results.push({
            object: table.vaultObject,
            container: table.container,
            ok: false,
            error: `${msg} | subject__v: ${err2.message || err2}`,
            elapsedMs: Date.now() - t0
          });
          continue;
        }
      }
      results.push({
        object: table.vaultObject,
        container: table.container,
        ok: false,
        error: msg,
        elapsedMs: Date.now() - t0
      });
    }
  }

  // Backfill institution + PI display names on existing site docs (relationship fields often drop from VQL).
  if (Date.now() - started < TIME_BUDGET_MS) {
    try {
      const orgEnrich = await enrichExistingSiteOrgNames(database, started, TIME_BUDGET_MS);
      if (orgEnrich && orgEnrich.patched) {
        results.push({
          object: "site_org_enrich",
          container: "ora_veeva_site",
          upserted: orgEnrich.patched,
          scanned: orgEnrich.scanned,
          orgNames: orgEnrich.orgNames,
          note: "organization__clin → organization__v name"
        });
      }
    } catch (err) {
      results.push({
        object: "site_org_enrich",
        ok: false,
        error: String(err.message || err).slice(0, 200)
      });
    }
  }
  if (Date.now() - started < TIME_BUDGET_MS) {
    try {
      const piEnrich = await enrichExistingSitePiNames(database, started, TIME_BUDGET_MS);
      if (piEnrich && piEnrich.patched) {
        results.push({
          object: "site_pi_enrich",
          container: "ora_veeva_site",
          upserted: piEnrich.patched,
          scanned: piEnrich.scanned,
          personNames: piEnrich.personNames,
          note: "principal_investigator__v → person__v name"
        });
      }
    } catch (err) {
      results.push({
        object: "site_pi_enrich",
        ok: false,
        error: String(err.message || err).slice(0, 200)
      });
    }
  }

  let milestoneWide = null;
  let sitePsmProjection = null;
  const didMilestones = results.some(
    (r) =>
      (r.object === "milestone__v" || r.container === "ora_veeva_milestone") &&
      (r.upserted > 0 || r.fetched > 0)
  );
  if (didMilestones && Date.now() - started < TIME_BUDGET_MS) {
    await writeSyncState(database, {
      progress: {
        status: "running",
        startedAt: syncedAt,
        updatedAt: new Date().toISOString(),
        mode: watermark ? "delta" : "full",
        triggeredBy: opts.triggeredBy || "api",
        currentObject: "milestone_projection",
        currentContainer: "ora_veeva_milestones",
        objectsTotal: tables.length,
        objectsDone: results.length,
        objectsSkipped: results.filter((r) => r.skipped).length,
        upsertedTotal,
        message: "Projecting milestone / site PSM facts…",
        results: results.slice(-8)
      }
    });
    try {
      milestoneWide = await projectWideMilestones(database, { syncedAt });
    } catch (err) {
      milestoneWide = { error: String(err.message || err) };
    }
    if (Date.now() - started < TIME_BUDGET_MS) {
      try {
        sitePsmProjection = await projectSitePsmFromMilestones(database, { syncedAt });
      } catch (err) {
        sitePsmProjection = { error: String(err.message || err) };
      }
    }
  }

  const coreResults = results.filter((r) => r.optional !== true);
  // Optional CTMS tables (monitoring / trip reports) must not block the watermark —
  // otherwise a bad schema on empty mirrors freezes lastSuccessfulSync forever.
  const hardFail =
    coreResults.length > 0 && coreResults.every((r) => r.error || r.ok === false);
  const onlyOptionalFailed =
    !hardFail &&
    results.length > 0 &&
    results.every((r) => r.optional === true && (r.error || r.ok === false));
  // Do not advance the watermark while incomplete — otherwise empty mirrors
  // (metrics/subjects/milestones) never get a historical full pull on delta.
  const advanceWatermark = !hardFail && !incomplete && !onlyOptionalFailed;
  const progressStatus = hardFail ? "failed" : incomplete ? "incomplete" : "complete";
  const progressMessage = hardFail
    ? "Veeva sync failed — see last object errors."
    : incomplete
      ? "Time budget hit — re-run Ingest Veeva (empty mirrors fill first)."
      : onlyOptionalFailed
        ? "Core Veeva objects OK — optional monitoring/trip-report tables need field mapping."
        : watermark
          ? "Veeva delta sync finished."
          : "Veeva full sync finished.";
  const state = await writeSyncState(database, {
    lastRunAt: syncedAt,
    lastSuccessfulSync: advanceWatermark ? syncedAt : prev.lastSuccessfulSync || null,
    incomplete: Boolean(incomplete),
    mode: watermark ? "delta" : "full",
    triggeredBy: opts.triggeredBy || "api",
    lastDeltas: { results, incomplete, milestoneWide, sitePsmProjection, prioritizeEmpty },
    note: incomplete
      ? "Time budget hit — re-run Ingest Veeva (budget default 55 min). Empty mirrors fill first."
      : onlyOptionalFailed
        ? "Optional CTMS monitoring/trip-report objects failed schema checks — core ora_veeva_* mirrors are unchanged."
        : watermark
          ? "Veeva delta sync into ora_veeva_* (+ fact projection)."
          : "Veeva full sync into ora_veeva_* (+ fact projection). Mike Watson Excel packs superseded where source=veeva_live.",
    progress: {
      status: progressStatus,
      startedAt: syncedAt,
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      mode: watermark ? "delta" : "full",
      triggeredBy: opts.triggeredBy || "api",
      currentObject: null,
      currentContainer: null,
      objectsTotal: tables.length,
      objectsDone: results.length,
      objectsSkipped: results.filter((r) => r.skipped).length,
      upsertedTotal,
      message: progressMessage,
      results: results.slice(-12)
    }
  });

  return {
    ok: !hardFail,
    mode: watermark ? "delta" : "full",
    incomplete,
    prioritizeEmpty,
    results,
    milestoneWide,
    sitePsmProjection,
    elapsedMs: Date.now() - started,
    sync: state
  };
}

async function getVeevaSyncStatus(getDb) {
  const cfg = veevaConfig();
  const database = getDb();
  // Create empty mirrors so Data Status shows 0 instead of Cosmos NotFound noise.
  for (const t of VEEVA_TABLES) {
    await ensureContainer(database, t.container);
  }
  await ensureContainer(database, "ora_veeva_milestones", "/country");
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

  const hasVaultData = tables.some((t) => typeof t.count === "number" && t.count > 0);
  const hasSynced = Boolean(sync?.lastSuccessfulSync || sync?.lastRunAt) || hasVaultData;
  return {
    configured: Boolean(cfg.configured) || hasSynced,
    credentialsOnHost: Boolean(cfg.configured),
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
          incomplete: Boolean(sync.incomplete),
          lastDeltas: sync.lastDeltas || null,
          progress: sync.progress || null
        }
      : null
  };
}

module.exports = {
  SYNC_ID,
  VEEVA_TABLES,
  FEASIBILITY_LEVELS,
  FEASIBILITY_METRIC_TYPES,
  FEASIBILITY_MILESTONE_TYPES_SITE,
  FEASIBILITY_MILESTONE_TYPES_STUDY,
  runVeevaTablesSync,
  getVeevaSyncStatus,
  markVeevaSyncProgress,
  projectWideMilestones
};
