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
 *   ora_veeva_metric, ora_veeva_subject, ora_veeva_milestone
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
  siteEnrollMonthsFromFpfvLpfv,
  computeSitePsm,
  classifyPsmWindowMilestone
} = require("./veevaPsm");

const SYNC_ID = "veeva_tables";
// Function App can run longer than SWA — leave room for milestone__v (~large).
const TIME_BUDGET_MS = Number(process.env.VEEVA_SYNC_BUDGET_MS || 240000);

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
      "study_country__v",
      "site_status__v",
      "status__v",
      "indication__c",
      "study_phase__c",
      "study_sponsor__c",
      "location_city__v",
      "location_stateprovince__v",
      "principal_investigator__v",
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
    // CTMS Metrics — enrollment performance dimension of feasibility
    vaultObject: "metrics__ctms",
    container: "ora_veeva_metric",
    docType: "ora_veeva_metric",
    fields: [
      "id",
      "name__v",
      "status__v",
      "metric_type__v",
      "metrics_type__v",
      "planned__v",
      "actual__v",
      "study__v",
      "study_country__v",
      "site__v",
      "modified_date__v"
    ],
    feasibilityMetricFilter: true
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

/** Drop unknown fields from VQL until the query succeeds (Vault configs differ). */
async function vqlSelectResilient(session, vaultObject, fields, { whereExtra = "", watermark = null } = {}) {
  let active = [...fields];
  const dropped = [];
  for (let attempt = 0; attempt < 12; attempt++) {
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
      const m =
        msg.match(/Unknown (?:field|Field)\s+['`]?([a-z0-9_]+)['`]?/i) ||
        msg.match(/Invalid (?:field|Field)\s+['`]?([a-z0-9_]+)['`]?/i) ||
        msg.match(/field\s+['`]([a-z0-9_]+)['`]/i) ||
        msg.match(/\b([a-z][a-z0-9_]*(?:__v|__c|__clin|__ctms|__vs))\b.*(?:not found|unknown|invalid)/i);
      const bad = m && active.includes(m[1]) ? m[1] : null;
      if (bad) {
        active = active.filter((f) => f !== bad);
        dropped.push(bad);
        continue;
      }
      // If WHERE references a missing field (e.g. metric_type), clear filter once
      if (whereExtra && /WHERE|metric_type|metrics_type/i.test(msg) && attempt === 0) {
        whereExtra = "";
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
    return `TONAME(metric_type__v) = '${esc}' OR name__v = '${esc}'`;
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
    const withActual = await countWithField(database, table.container, table.docType, "actual__v");
    const withSite = await countWithField(database, table.container, table.docType, "site__v");
    return withActual === 0 && withSite === 0;
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
    const when = m.actual_finish_date__v || m.actual_start_date__v;
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
      case "study__v":
        return 3;
      case "study_country__v":
        return 4;
      case "metrics__ctms":
        return 5;
      case "milestone__v":
        return 6;
      case "site__v":
        return 7;
      case "subject__clin":
      case "subject__v":
        return 8;
      default:
        return 9;
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
      const whereExtra = table.feasibilityMetricFilter ? feasibilityMetricWhere() : "";
      // Empty mirrors must full-pull even in delta mode — watermark would skip history.
      const existing = countsByContainer[table.container] || 0;
      const needsFull = await mirrorNeedsFullResync(database, table, existing);
      const tableWatermark = existing === 0 || needsFull ? null : watermark;
      const pulled = await vqlSelectResilient(session, table.vaultObject, table.fields, {
        watermark: tableWatermark,
        whereExtra
      });
      const criticalDropped = (pulled.fieldsDropped || []).filter((f) =>
        ["site__v", "study__v", "actual__v", "subject_status__v"].includes(f)
      );

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

  let milestoneWide = null;
  let sitePsmProjection = null;
  const didMilestones = results.some(
    (r) =>
      (r.object === "milestone__v" || r.container === "ora_veeva_milestone") &&
      (r.upserted > 0 || r.fetched > 0)
  );
  if (didMilestones && Date.now() - started < TIME_BUDGET_MS) {
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

  const hardFail = results.length > 0 && results.every((r) => r.error || r.ok === false);
  // Do not advance the watermark while incomplete — otherwise empty mirrors
  // (metrics/subjects/milestones) never get a historical full pull on delta.
  const advanceWatermark = !hardFail && !incomplete;
  const state = await writeSyncState(database, {
    lastRunAt: syncedAt,
    lastSuccessfulSync: advanceWatermark ? syncedAt : prev.lastSuccessfulSync || null,
    incomplete: Boolean(incomplete),
    mode: watermark ? "delta" : "full",
    triggeredBy: opts.triggeredBy || "api",
    lastDeltas: { results, incomplete, milestoneWide, sitePsmProjection, prioritizeEmpty },
    note: incomplete
      ? "Time budget hit — re-run Ingest Veeva; empty mirrors (metrics/milestones/subjects) are filled first."
      : watermark
        ? "Veeva delta sync into ora_veeva_* (+ fact projection)."
        : "Veeva full sync into ora_veeva_* (+ fact projection). Mike Watson Excel packs superseded where source=veeva_live."
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
          lastDeltas: sync.lastDeltas || null
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
  projectWideMilestones
};
