/**
 * ClinicalTrials.gov ophthalmology delta → Cosmos ora_ctgov_trials.
 * Runs inside the SWA API (uses App Settings COSMOS_* — no GitHub Cosmos secrets).
 *
 * Default = incremental (LastUpdatePostDate since watermark).
 * Full 10y backfill stays on python ingest/pull_ctgov_ophthalmology.py --full
 * (too large for a single HTTP function invocation).
 */

const SYNC_ID = "ctgov_ophthalmology";
const DATASET = "clinicaltrials_gov";
const DOC_TYPE = "ora_ctgov_trials";
const SCHEMA_VERSION = 1;
const API_BASE = "https://clinicaltrials.gov/api/v2/studies";
const PAGE_SIZE = 100;
const OVERLAP_HOURS = 36;
const USER_AGENT = "OraStudyBidWorkbench/1.0 (ctgov-delta-api)";

const COND_QUERY =
  "(eye diseases OR ophthalmology OR dry eye OR macular degeneration OR glaucoma OR " +
  "cataract OR diabetic macular OR diabetic retinopathy OR geographic atrophy OR " +
  "retinitis pigmentosa OR uveitis OR myopia OR allergic conjunctivitis OR " +
  "thyroid eye OR keratoconus OR presbyopia OR blepharitis OR ocular hypertension OR " +
  "retinal vein OR corneal OR conjunctivitis OR AMD OR nAMD)";

const INDICATION_RULES = [
  [/dry eye/i, "Dry Eye"],
  [/keratoconjunctivitis sicca/i, "Dry Eye"],
  [/glaucoma/i, "Glaucoma"],
  [/ocular hypertension/i, "Glaucoma / Ocular Hypertension"],
  [/cataract/i, "Cataract"],
  [/diabetic macular/i, "Diabetic Macular Edema (DME)"],
  [/\bdme\b/i, "Diabetic Macular Edema (DME)"],
  [/diabetic retinopathy/i, "Diabetic Retinopathy"],
  [/geographic atrophy/i, "Geographic Atrophy / Dry AMD"],
  [/dry amd/i, "Geographic Atrophy / Dry AMD"],
  [/wet amd/i, "Wet AMD"],
  [/neovascular.*macular/i, "Wet AMD"],
  [/age.?related macular/i, "Wet AMD"],
  [/macular degeneration/i, "Wet AMD"],
  [/retinitis pigmentosa/i, "Retinitis Pigmentosa"],
  [/presbyopia/i, "Presbyopia"],
  [/allergic conjunctivitis/i, "Allergic Conjunctivitis"],
  [/thyroid eye/i, "Thyroid Eye Disease"],
  [/graves.*orbit/i, "Thyroid Eye Disease"],
  [/myopia/i, "Myopia"],
  [/uveitis/i, "Uveitis"],
  [/blepharitis/i, "Blepharitis"],
  [/keratoconus/i, "Keratoconus"]
];

const FIELDS = [
  "NCTId",
  "BriefTitle",
  "OfficialTitle",
  "OverallStatus",
  "Phase",
  "StudyType",
  "StartDate",
  "PrimaryCompletionDate",
  "CompletionDate",
  "LastUpdatePostDate",
  "StudyFirstPostDate",
  "Condition",
  "InterventionName",
  "LeadSponsorName",
  "LeadSponsorClass",
  "EnrollmentCount",
  "EnrollmentType",
  "LocationCountry",
  "LocationFacility",
  "WhyStopped",
  "HasResults"
].join(",");

function dig(obj, ...path) {
  let cur = obj;
  for (const p of path) {
    if (!cur || typeof cur !== "object") return null;
    cur = cur[p];
  }
  return cur == null ? null : cur;
}

function asList(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function mapOraIndication(conditions) {
  const blob = (conditions || []).join(" | ");
  for (const [re, label] of INDICATION_RULES) {
    if (re.test(blob)) return label;
  }
  if (conditions && conditions[0]) return String(conditions[0]).trim().slice(0, 120) || "_unknown";
  return "_unknown";
}

function lookbackStart() {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 10);
  return d.toISOString().slice(0, 10);
}

function flattenStudy(raw, importedAt) {
  const ps = raw.protocolSection || {};
  const nct = dig(ps, "identificationModule", "nctId") || "";
  const conditions = asList(dig(ps, "conditionsModule", "conditions")).map(String);
  const phases = asList(dig(ps, "designModule", "phases"));
  const locations = asList(dig(ps, "contactsLocationsModule", "locations"));
  const countries = [
    ...new Set(
      locations
        .filter((loc) => loc && loc.country)
        .map((loc) => String(loc.country).trim())
        .filter(Boolean)
    )
  ].sort();
  const interventions = asList(dig(ps, "armsInterventionsModule", "interventions"))
    .filter((i) => i && i.name)
    .map((i) => String(i.name).trim())
    .slice(0, 20);
  const enroll = dig(ps, "designModule", "enrollmentInfo") || {};
  const id = String(nct).toUpperCase();
  return {
    id,
    nct: id,
    oraIndication: mapOraIndication(conditions),
    title: dig(ps, "identificationModule", "briefTitle"),
    officialTitle: dig(ps, "identificationModule", "officialTitle"),
    status: dig(ps, "statusModule", "overallStatus"),
    phases,
    phase: phases[0] || null,
    studyType: dig(ps, "designModule", "studyType"),
    startDate: dig(ps, "statusModule", "startDateStruct", "date"),
    primaryCompletionDate: dig(ps, "statusModule", "primaryCompletionDateStruct", "date"),
    completionDate: dig(ps, "statusModule", "completionDateStruct", "date"),
    lastUpdatePostDate:
      dig(ps, "statusModule", "lastUpdatePostDateStruct", "date") ||
      dig(ps, "statusModule", "statusVerifiedDate"),
    studyFirstPostDate: dig(ps, "statusModule", "studyFirstPostDateStruct", "date"),
    conditions,
    interventions,
    sponsor: dig(ps, "sponsorCollaboratorsModule", "leadSponsor", "name"),
    sponsorClass: dig(ps, "sponsorCollaboratorsModule", "leadSponsor", "class"),
    enrollment: enroll.count ?? null,
    enrollmentType: enroll.type ?? null,
    countries,
    nCountries: countries.length,
    nLocations: locations.length,
    whyStopped: dig(ps, "statusModule", "whyStopped"),
    hasResults: Boolean(raw.hasResults),
    docType: DOC_TYPE,
    dataset: DATASET,
    schemaVersion: SCHEMA_VERSION,
    source: "clinicaltrials.gov/api/v2",
    importedAt
  };
}

async function httpGetJson(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CT.gov HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function buildSearchUrl(advanced, pageToken) {
  const params = new URLSearchParams({
    format: "json",
    countTotal: "true",
    pageSize: String(PAGE_SIZE),
    "query.cond": COND_QUERY,
    "filter.advanced": advanced,
    fields: FIELDS
  });
  if (pageToken) params.set("pageToken", pageToken);
  return `${API_BASE}?${params.toString()}`;
}

async function ensureContainers(database) {
  try {
    await database.containers.createIfNotExists({
      id: "ora_ctgov_trials",
      partitionKey: { paths: ["/oraIndication"] }
    });
  } catch (_) {}
  try {
    await database.containers.createIfNotExists({
      id: "syncState",
      partitionKey: { paths: ["/id"] }
    });
  } catch (_) {}
}

async function readSyncState(database) {
  try {
    const { resource } = await database.container("syncState").item(SYNC_ID, SYNC_ID).read();
    return resource || null;
  } catch (_) {
    return null;
  }
}

async function writeSyncState(database, doc) {
  await database.container("syncState").items.upsert(doc);
}

/**
 * @param {Function} getDb
 * @param {{ full?: boolean, maxPages?: number, triggeredBy?: string }} opts
 */
async function runCtgovSync(getDb, opts = {}) {
  const full = Boolean(opts.full);
  const maxPages = opts.maxPages != null ? Number(opts.maxPages) : full ? 5 : 50;
  // Full via HTTP is capped — use python --full for complete 10y backfill
  if (full && opts.allowLargeFull !== true) {
    return {
      ok: false,
      skipped: true,
      reason:
        "Full 10-year backfill is too large for the web API. Use delta sync here, or run: python ingest/pull_ctgov_ophthalmology.py --full",
      hint: "POST /api/ctgov/sync without full=true for Mon–Fri incremental refresh."
    };
  }

  const database = getDb();
  await ensureContainers(database);
  const importedAt = new Date().toISOString();
  const state = full ? null : await readSyncState(database);
  const lookback = lookbackStart();

  let advanced;
  let mode;
  if (state && state.lastSuccessfulSync && !full) {
    const last = new Date(state.lastSuccessfulSync);
    const since = new Date(last.getTime() - OVERLAP_HOURS * 3600 * 1000).toISOString().slice(0, 10);
    advanced = `AREA[LastUpdatePostDate]RANGE[${since},MAX]`;
    mode = "delta";
  } else {
    advanced = `AREA[StartDate]RANGE[${lookback},MAX]`;
    mode = full ? "full_capped" : "full_bootstrap";
  }

  const t0 = Date.now();
  const studies = [];
  let token = null;
  let total = 0;
  let page = 0;
  while (page < maxPages) {
    page += 1;
    const data = await httpGetJson(buildSearchUrl(advanced, token));
    if (page === 1) total = Number(data.totalCount || 0);
    const batch = data.studies || [];
    studies.push(...batch);
    token = data.nextPageToken || null;
    if (!token || !batch.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const byId = new Map();
  for (const raw of studies) {
    const doc = flattenStudy(raw, importedAt);
    if (doc.id) byId.set(doc.id, doc);
  }
  const docs = [...byId.values()];

  const container = database.container("ora_ctgov_trials");
  let upserted = 0;
  const errors = [];
  // Sequential upserts — safer under SWA concurrency limits
  for (const doc of docs) {
    try {
      await container.items.upsert(doc);
      upserted += 1;
    } catch (err) {
      errors.push(`${doc.id}: ${err.message || err}`);
      if (errors.length >= 20) break;
    }
  }

  const incomplete = Boolean(token);
  if (!errors.length && !incomplete) {
    await writeSyncState(database, {
      id: SYNC_ID,
      docType: "syncState",
      job: SYNC_ID,
      source: "clinicaltrials.gov",
      mode,
      filterAdvanced: advanced,
      condQuery: COND_QUERY,
      lastSuccessfulSync: importedAt,
      lastRunAt: importedAt,
      lastTotalCount: total,
      lastUpserted: upserted,
      lookbackStart: lookback,
      dataset: DATASET,
      schemaVersion: SCHEMA_VERSION,
      triggeredBy: opts.triggeredBy || "api",
      seconds: Math.round((Date.now() - t0) / 1000)
    });
  } else if (!errors.length && incomplete) {
    // Partial progress — still record lastRunAt but keep prior watermark
    const prev = state || {};
    await writeSyncState(database, {
      ...prev,
      id: SYNC_ID,
      docType: "syncState",
      lastRunAt: importedAt,
      lastPartialUpserted: upserted,
      lastPartialTotalCount: total,
      note: "Partial page fetch — watermark not advanced; next run will retry overlap window.",
      triggeredBy: opts.triggeredBy || "api"
    });
  }

  return {
    ok: errors.length === 0,
    mode,
    filterAdvanced: advanced,
    apiTotalCount: total,
    pagesFetched: page,
    incomplete,
    prepared: docs.length,
    upserted,
    errorCount: errors.length,
    errors: errors.slice(0, 10),
    elapsedMs: Date.now() - t0,
    watermarkAdvanced: !errors.length && !incomplete,
    triggeredBy: opts.triggeredBy || "api"
  };
}

async function getCtgovSyncStatus(getDb) {
  const database = getDb();
  const state = await readSyncState(database);
  let count = 0;
  try {
    const { resources } = await database
      .container("ora_ctgov_trials")
      .items.query({
        query: "SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t",
        parameters: [{ name: "@t", value: DOC_TYPE }]
      })
      .fetchAll();
    count = resources[0] || 0;
  } catch (_) {}
  return {
    count,
    sync: state
      ? {
          lastSuccessfulSync: state.lastSuccessfulSync || null,
          lastRunAt: state.lastRunAt || null,
          lastUpserted: state.lastUpserted || null,
          mode: state.mode || null,
          triggeredBy: state.triggeredBy || null,
          note: state.note || null
        }
      : null
  };
}

module.exports = {
  runCtgovSync,
  getCtgovSyncStatus,
  SYNC_ID,
  COND_QUERY
};
