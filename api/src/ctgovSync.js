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

/** Full ophthalmology condition search — MeSH Eye Diseases + broad ocular/retinal terms (not a curated shortlist). */
const COND_QUERY =
  "(Eye Diseases OR Ophthalmology OR ocular OR ophthalmic OR retina OR retinal OR cornea OR corneal OR " +
  "glaucoma OR cataract OR uveitis OR macular OR conjunctivitis OR \"dry eye\" OR \"optic nerve\" OR " +
  "\"optic neuropath\" OR blepharitis OR strabismus OR amblyopia OR keratoconus OR myopia OR presbyopia OR " +
  "Stargardt OR \"retinitis pigmentosa\" OR \"inherited retinal\" OR choroideremia OR achromatopsia OR " +
  "\"Leber congenital\" OR \"Leber hereditary\" OR vitreous OR intraocular OR \"anterior segment\" OR " +
  "\"posterior segment\" OR \"visual impairment\" OR blindness OR nystagmus OR \"thyroid eye\" OR Graves OR " +
  "\"retinal vein\" OR \"geographic atrophy\" OR \"diabetic macular\" OR \"diabetic retinopathy\" OR " +
  "neuroprotection OR NAION OR LHON OR Fuchs OR meibomian OR \"macular hole\" OR epiretinal OR " +
  "\"central serous\" OR \"uveal melanoma\" OR \"ocular melanoma\" OR \"Best disease\" OR \"cone dystrophy\" OR " +
  "\"rod dystrophy\" OR \"X-linked retinoschisis\" OR retinoblastoma)";

const INDICATION_RULES = [
  [/neurotrophic kerat/i, "Neurotrophic Keratitis"],
  [/neuroprotection/i, "Neuroprotection"],
  [/retinal neuroprotect/i, "Neuroprotection"],
  [/optic nerve neuroprotect/i, "Neuroprotection"],
  [/leber.?s?\s*hereditary\s*optic/i, "Optic Neuropathy"],
  [/\blhon\b/i, "Optic Neuropathy"],
  [/\bnaion\b/i, "Optic Neuropathy"],
  [/non.?arteritic.*optic/i, "Optic Neuropathy"],
  [/optic neuritis/i, "Optic Neuropathy"],
  [/optic neuropath/i, "Optic Neuropathy"],
  [/dry eye/i, "Dry Eye"],
  [/keratoconjunctivitis sicca/i, "Dry Eye"],
  [/meibomian gland/i, "Meibomian Gland Dysfunction"],
  [/\bmgd\b/i, "Meibomian Gland Dysfunction"],
  [/ocular hypertension/i, "Glaucoma / Ocular Hypertension"],
  [/glaucoma/i, "Glaucoma / Ocular Hypertension"],
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
  [/central serous/i, "Central Serous Chorioretinopathy"],
  [/\bcscr\b/i, "Central Serous Chorioretinopathy"],
  [/epiretinal membrane/i, "Macular Hole / ERM"],
  [/macular hole/i, "Macular Hole / ERM"],
  [/\berm\b/i, "Macular Hole / ERM"],
  [/stargardt/i, "Inherited Retinal Disease"],
  [/choroideremia/i, "Inherited Retinal Disease"],
  [/achromatopsia/i, "Inherited Retinal Disease"],
  [/best disease|vitelliform/i, "Inherited Retinal Disease"],
  [/retinoschisis/i, "Inherited Retinal Disease"],
  [/cone dystrophy|rod dystrophy|cone-rod/i, "Inherited Retinal Disease"],
  [/leber congenital amaurosis/i, "Inherited Retinal Disease"],
  [/inherited retinal/i, "Inherited Retinal Disease"],
  [/retinoblastoma/i, "Inherited Retinal Disease"],
  [/retinitis pigmentosa/i, "Retinitis Pigmentosa"],
  [/presbyopia/i, "Presbyopia"],
  [/allergic conjunctivitis/i, "Allergic Conjunctivitis"],
  [/thyroid eye/i, "Thyroid Eye Disease"],
  [/graves.*orbit/i, "Thyroid Eye Disease"],
  [/pathologic myopia|myopic cnv/i, "Myopia"],
  [/myopia/i, "Myopia"],
  [/uveitis|panuveitis/i, "Uveitis"],
  [/blepharitis/i, "Blepharitis"],
  [/keratoconus/i, "Keratoconus"],
  [/fuchs/i, "Ocular Surface / Cornea"],
  [/corneal dystroph/i, "Ocular Surface / Cornea"],
  [/infectious keratit|bacterial keratit|fungal keratit/i, "Ocular Surface / Cornea"],
  [/central retinal vein|branch retinal vein|\bcrvo\b|\bbrvo\b|retinal vein occlusion/i, "Retinal Vein Occlusion"],
  [/uveal melanoma|ocular melanoma|choroidal melanoma/i, "Uveal Melanoma"],
  [/amblyopia/i, "Amblyopia"],
  [/strabismus/i, "Strabismus"],
  [/ocular redness|eye redness/i, "Eye Redness"]
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
  "HasResults",
  "BriefSummary"
].join(",");

/** Pull rough dollar mentions from free text (CT.gov has no structured CRO bid $). */
function extractMentionedDollars(text) {
  const src = String(text || "");
  if (!src) return [];
  const out = [];
  const re =
    /\$\s*([\d,]+(?:\.\d+)?)\s*(k|m|b|million|billion)?\b|\b([\d,]+(?:\.\d+)?)\s*(million|billion)\s*(?:usd|dollars?|\$)?\b/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    let amount = null;
    let raw = m[0].trim();
    if (m[1] != null) {
      const n = Number(String(m[1]).replace(/,/g, ""));
      const suf = (m[2] || "").toLowerCase();
      if (!Number.isNaN(n)) {
        if (suf === "k") amount = n * 1e3;
        else if (suf === "m" || suf === "million") amount = n * 1e6;
        else if (suf === "b" || suf === "billion") amount = n * 1e9;
        else amount = n;
      }
    } else if (m[3] != null) {
      const n = Number(String(m[3]).replace(/,/g, ""));
      const suf = (m[4] || "").toLowerCase();
      if (!Number.isNaN(n)) {
        amount = suf === "billion" ? n * 1e9 : n * 1e6;
      }
    }
    if (amount != null && amount > 0) {
      out.push({ raw, amountUsd: Math.round(amount) });
    }
    if (out.length >= 5) break;
  }
  return out;
}

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
  const briefSummary = dig(ps, "descriptionModule", "briefSummary") || "";
  const mentionedDollars = extractMentionedDollars(briefSummary);
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
    briefSummary: briefSummary ? String(briefSummary).slice(0, 800) : null,
    mentionedDollars,
    hasMentionedDollars: mentionedDollars.length > 0,
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

const DELTA_FIELDS = [
  "status",
  "phase",
  "enrollment",
  "sponsor",
  "title",
  "lastUpdatePostDate",
  "oraIndication",
  "hasResults",
  "whyStopped",
  "nCountries",
  "enrollmentType"
];

function normDeltaVal(v) {
  if (v == null || v === "") return null;
  if (Array.isArray(v)) return v.map(String).join("|");
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function diffTrial(prev, next) {
  if (!prev) return null;
  const changes = [];
  for (const field of DELTA_FIELDS) {
    const from = normDeltaVal(prev[field]);
    const to = normDeltaVal(next[field]);
    if (from !== to) changes.push({ field, from, to });
  }
  // countries list (readable)
  const fromC = normDeltaVal((prev.countries || []).slice().sort());
  const toC = normDeltaVal((next.countries || []).slice().sort());
  if (fromC !== toC) {
    changes.push({
      field: "countries",
      from: fromC,
      to: toC
    });
  }
  return changes;
}

async function readExistingTrial(container, nct) {
  const id = String(nct || "").toUpperCase();
  if (!id) return null;
  try {
    const { resources } = await container.items
      .query({
        query: "SELECT * FROM c WHERE c.id = @id AND c.docType = @t",
        parameters: [
          { name: "@id", value: id },
          { name: "@t", value: DOC_TYPE }
        ]
      })
      .fetchAll();
    return resources[0] || null;
  } catch (_) {
    return null;
  }
}

/**
 * Upsert with partition-key migration when oraIndication changes.
 * Cosmos id is unique per partition — changing PK requires delete+create.
 */
async function upsertTrial(container, doc) {
  const prev = await readExistingTrial(container, doc.id);
  if (prev && prev.oraIndication && prev.oraIndication !== doc.oraIndication) {
    try {
      await container.item(prev.id, prev.oraIndication).delete();
    } catch (_) {}
  }
  await container.items.upsert(doc);
  return prev;
}

/**
 * Re-apply INDICATION_RULES to CT.gov docs that look mislabeled
 * (condition needles or legacy short labels like "Glaucoma").
 */
async function remapCtgovIndications(getDb, opts = {}) {
  const database = getDb();
  await ensureContainers(database);
  const container = database.container("ora_ctgov_trials");
  const needles = Array.isArray(opts.needles) && opts.needles.length
    ? opts.needles
    : [
        "neuroprotect",
        "uveitis",
        "meibomian",
        "stargardt",
        "optic neuropath",
        "naion",
        "lhon",
        "neurotrophic",
        "keratoconus",
        "amblyopia",
        "strabismus",
        "uveal melanoma"
      ];

  const seen = new Set();
  const candidates = [];
  for (const needle of needles) {
    const { resources } = await container.items
      .query(
        {
          query: `SELECT c.id, c.nct, c.oraIndication, c.conditions FROM c WHERE c.docType = @t
            AND EXISTS (SELECT VALUE x FROM x IN c.conditions WHERE CONTAINS(LOWER(x), @n))`,
          parameters: [
            { name: "@t", value: DOC_TYPE },
            { name: "@n", value: needle }
          ]
        },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();
    for (const r of resources || []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      candidates.push(r);
    }
  }

  // Legacy short Glaucoma label → preferred "Glaucoma / Ocular Hypertension" (or Neuroprotection)
  const { resources: glaucomaOld } = await container.items
    .query(
      {
        query:
          "SELECT c.id, c.nct, c.oraIndication, c.conditions FROM c WHERE c.docType = @t AND c.oraIndication = @ind",
        parameters: [
          { name: "@t", value: DOC_TYPE },
          { name: "@ind", value: "Glaucoma" }
        ]
      },
      { enableCrossPartitionQuery: true }
    )
    .fetchAll();
  for (const r of glaucomaOld || []) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    candidates.push(r);
  }

  let remapped = 0;
  const samples = [];
  const errors = [];

  for (const row of candidates) {
    const nextInd = mapOraIndication(row.conditions || []);
    if (!nextInd || nextInd === row.oraIndication) continue;
    try {
      const { resources: full } = await container.items
        .query({
          query: "SELECT * FROM c WHERE c.id = @id AND c.docType = @t",
          parameters: [
            { name: "@id", value: row.id },
            { name: "@t", value: DOC_TYPE }
          ]
        })
        .fetchAll();
      const doc = full[0];
      if (!doc) continue;
      const fromInd = doc.oraIndication;
      doc.oraIndication = nextInd;
      doc.indicationRemappedAt = new Date().toISOString();
      doc.indicationRemappedFrom = fromInd;
      if (fromInd && fromInd !== nextInd) {
        try {
          await container.item(doc.id, fromInd).delete();
        } catch (_) {}
      }
      await container.items.upsert(doc);
      remapped += 1;
      if (samples.length < 25) {
        samples.push({ nct: doc.nct || doc.id, from: fromInd, to: nextInd });
      }
    } catch (err) {
      errors.push(`${row.id}: ${err.message || err}`);
      if (errors.length >= 20) break;
    }
  }

  return {
    ok: errors.length === 0,
    scanned: candidates.length,
    remapped,
    samples,
    errorCount: errors.length,
    errors: errors.slice(0, 10),
    note: "Reclassified oraIndication from conditions using current INDICATION_RULES (partition-key safe)."
  };
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
  const added = [];
  const changed = [];
  let unchanged = 0;

  for (const doc of docs) {
    try {
      const prev = await readExistingTrial(container, doc.id);
      if (!prev) {
        added.push({
          nct: doc.nct,
          title: doc.title,
          status: doc.status,
          phase: doc.phase,
          sponsor: doc.sponsor,
          oraIndication: doc.oraIndication,
          enrollment: doc.enrollment,
          lastUpdatePostDate: doc.lastUpdatePostDate
        });
      } else {
        const changes = diffTrial(prev, doc);
        if (changes && changes.length) {
          changed.push({
            nct: doc.nct,
            title: doc.title || prev.title,
            status: doc.status,
            oraIndication: doc.oraIndication || prev.oraIndication,
            changes
          });
        } else {
          unchanged += 1;
        }
      }
      await upsertTrial(container, doc);
      upserted += 1;
    } catch (err) {
      errors.push(`${doc.id}: ${err.message || err}`);
      if (errors.length >= 20) break;
    }
  }

  // After delta, reclassify any remaining mislabeled indications (e.g. Neuroprotection still under Glaucoma)
  let remap = null;
  try {
    remap = await remapCtgovIndications(() => database, { max: 5000 });
  } catch (err) {
    remap = { ok: false, error: String(err.message || err) };
  }

  const deltas = {
    summary: {
      added: added.length,
      changed: changed.length,
      unchanged,
      fetched: docs.length
    },
    // Cap payload size for the UI
    added: added.slice(0, 75),
    changed: changed.slice(0, 75),
    addedTruncated: added.length > 75,
    changedTruncated: changed.length > 75
  };

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
      lastDeltas: deltas.summary,
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
      lastDeltas: deltas.summary,
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
    triggeredBy: opts.triggeredBy || "api",
    deltas,
    remap
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
          lastDeltas: state.lastDeltas || null,
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
  remapCtgovIndications,
  SYNC_ID,
  COND_QUERY
};
