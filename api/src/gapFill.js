/**
 * Gap-fill: live-fetch public data that Cosmos does not (yet) have, return a typed pack,
 * optionally upsert into ora_ctgov_trials so the next ask is cheap.
 *
 * Buddy ask-path and HTTP /api/gap-fill share this module — model narrates packs; Node fetches.
 */

const {
  searchCtgovTreatmentNaiveLive,
  fetchEligibilityCriteriaForNct,
  applyAvegfNaiveFields
} = require("./ctgovEligibility");
const { backfillCtgovEligibility } = require("./ctgovSync");

const CTGOV_API = "https://clinicaltrials.gov/api/v2/studies";
const USER_AGENT = "OraStudyBidWorkbench/1.0 (gap-fill)";
const DOC_TYPE = "ora_ctgov_trials";
const DATASET = "clinicaltrials_gov";

const FILLERS = [
  {
    id: "ctgov_treatment_naive",
    source: "clinicaltrials.gov",
    description:
      "Live CT.gov search for treatment-naïve trials (prior aVEGF exclusion / explicit naïve). Dedicated RECRUITING pass.",
    params: ["indication", "limit", "maxPages", "upsert"],
    cosmosContainer: "ora_ctgov_trials"
  },
  {
    id: "ctgov_nct",
    source: "clinicaltrials.gov",
    description:
      "Fetch one NCT from CT.gov if missing or thin in Cosmos (eligibility + naïve flags).",
    params: ["nct", "upsert"],
    cosmosContainer: "ora_ctgov_trials"
  },
  {
    id: "ctgov_eligibility",
    source: "clinicaltrials.gov",
    description:
      "Backfill eligibilityCriteria + aVEGF-naïve flags onto existing Cosmos rows that lack them.",
    params: ["indication", "max", "concurrency"],
    cosmosContainer: "ora_ctgov_trials"
  },
  {
    id: "ctgov_recruiting",
    source: "clinicaltrials.gov",
    description:
      "Live CT.gov RECRUITING ocular/indication slice — status + eligibility when present (not naïve-filtered).",
    params: ["indication", "limit", "maxPages", "upsert"],
    cosmosContainer: "ora_ctgov_trials"
  }
];

function listGapFillers() {
  return {
    ok: true,
    note:
      "POST /api/gap-fill with { filler, ...params }. Live fetch returns data even when Cosmos is empty. Set upsert:true to write into Cosmos.",
    fillers: FILLERS
  };
}

function mapOraIndication(conditions) {
  const blob = (conditions || []).join(" | ");
  if (/wet\s*amd|neovascular.*macular|nAMD/i.test(blob)) return "Wet AMD";
  if (/geographic atrophy|dry\s*amd/i.test(blob)) return "Geographic Atrophy / Dry AMD";
  if (/dry\s*eye/i.test(blob)) return "Dry Eye";
  if (/glaucoma|ocular hypertension/i.test(blob)) return "Glaucoma / Ocular Hypertension";
  if (/diabetic macular|\bdme\b/i.test(blob)) return "Diabetic Macular Edema (DME)";
  if (/diabetic retinopathy/i.test(blob)) return "Diabetic Retinopathy";
  if (conditions && conditions[0]) return String(conditions[0]).trim().slice(0, 120) || "_unknown";
  return "_unknown";
}

async function readCosmosCtgovNct(database, nct) {
  const id = String(nct || "").toUpperCase();
  if (!id) return null;
  try {
    const { resources } = await database
      .container("ora_ctgov_trials")
      .items.query({
        query: "SELECT * FROM c WHERE c.docType = @t AND (c.id = @id OR c.nct = @id)",
        parameters: [
          { name: "@t", value: DOC_TYPE },
          { name: "@id", value: id }
        ]
      })
      .fetchAll();
    return resources[0] || null;
  } catch (_) {
    return null;
  }
}

async function upsertLiveRows(getDb, rows, { triggeredBy = "gap_fill" } = {}) {
  const database = getDb();
  const container = database.container("ora_ctgov_trials");
  const importedAt = new Date().toISOString();
  let upserted = 0;
  const errors = [];
  for (const row of rows || []) {
    const nct = String(row.nct || row.id || "").toUpperCase();
    if (!nct) continue;
    try {
      const prev = await readCosmosCtgovNct(database, nct);
      const conditions = row.conditions || prev?.conditions || [];
      const oraIndication =
        prev?.oraIndication || row.oraIndication || mapOraIndication(conditions);
      const next = applyAvegfNaiveFields({
        ...(prev || {}),
        ...row,
        id: nct,
        nct,
        oraIndication,
        docType: DOC_TYPE,
        dataset: DATASET,
        schemaVersion: Math.max(Number(prev?.schemaVersion) || 0, 3),
        source: row.source || "clinicaltrials.gov/api/v2/gap-fill",
        importedAt: prev?.importedAt || importedAt,
        gapFilledAt: importedAt,
        gapFilledBy: triggeredBy,
        eligibilityCriteria:
          row.eligibilityCriteria || prev?.eligibilityCriteria || null
      });
      if (prev?.oraIndication && prev.oraIndication !== next.oraIndication) {
        try {
          await container.item(prev.id, prev.oraIndication).delete();
        } catch (_) {
          /* ignore */
        }
      }
      await container.items.upsert(next);
      upserted += 1;
    } catch (err) {
      errors.push({ nct, error: String(err.message || err) });
      if (errors.length >= 15) break;
    }
  }
  return { upserted, errorCount: errors.length, errors: errors.slice(0, 10) };
}

async function fetchCtgovStudyByNct(nct) {
  const id = String(nct || "").toUpperCase();
  if (!/^NCT\d{8}$/.test(id)) {
    return { ok: false, error: "nct must look like NCT01234567" };
  }
  const params = new URLSearchParams({
    format: "json",
    "query.id": id,
    fields:
      "NCTId,BriefTitle,OfficialTitle,OverallStatus,Phase,EligibilityCriteria,LeadSponsorName,Condition,EnrollmentCount,StartDate,BriefSummary"
  });
  const res = await fetch(`${CTGOV_API}?${params}`, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT }
  });
  if (!res.ok) {
    return { ok: false, error: `CT.gov HTTP ${res.status}` };
  }
  const data = await res.json();
  const s = (data.studies || [])[0];
  if (!s) return { ok: false, error: "NCT not found on ClinicalTrials.gov", nct: id };
  const ps = s.protocolSection || {};
  const elig = ps.eligibilityModule?.eligibilityCriteria || "";
  const conditions = ps.conditionsModule?.conditions || [];
  const row = applyAvegfNaiveFields({
    nct: id,
    title: ps.identificationModule?.briefTitle || null,
    officialTitle: ps.identificationModule?.officialTitle || null,
    status: ps.statusModule?.overallStatus || null,
    phase: (ps.designModule?.phases || [])[0] || null,
    sponsor: ps.sponsorCollaboratorsModule?.leadSponsor?.name || null,
    enrollment: ps.designModule?.enrollmentInfo?.count ?? null,
    startDate: ps.statusModule?.startDateStruct?.date || null,
    conditions,
    briefSummary: ps.descriptionModule?.briefSummary
      ? String(ps.descriptionModule.briefSummary).slice(0, 1200)
      : null,
    eligibilityCriteria: elig ? String(elig).slice(0, 8000) : null,
    source: "clinicaltrials.gov/api/v2/gap-fill/nct"
  });
  return { ok: true, nct: id, trial: row };
}

async function searchCtgovRecruitingLive(indication, opts = {}) {
  const maxPages = Math.min(3, Math.max(1, Number(opts.maxPages) || 2));
  const limit = Math.min(40, Math.max(5, Number(opts.limit) || 25));
  const qCond =
    opts.queryCond ||
    (/\b(wet\s*amd|namd|neovascular)/i.test(String(indication || ""))
      ? 'neovascular AMD OR "wet AMD" OR nAMD OR "neovascular age-related macular degeneration"'
      : String(indication || "macular degeneration"));
  const studies = [];
  let token = null;
  let totalCount = null;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      format: "json",
      pageSize: "100",
      countTotal: "true",
      "query.cond": qCond,
      "filter.overallStatus": "RECRUITING",
      "filter.advanced": "AREA[StartDate]RANGE[2014-01-01,MAX]",
      fields:
        "NCTId,BriefTitle,OverallStatus,Phase,EligibilityCriteria,LeadSponsorName,Condition,EnrollmentCount,StartDate"
    });
    if (token) params.set("pageToken", token);
    const res = await fetch(`${CTGOV_API}?${params}`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT }
    });
    if (!res.ok) break;
    const data = await res.json();
    if (totalCount == null) totalCount = data.totalCount ?? null;
    for (const s of data.studies || []) {
      const ps = s.protocolSection || {};
      const nct = ps.identificationModule?.nctId;
      if (!nct) continue;
      const elig = ps.eligibilityModule?.eligibilityCriteria || "";
      studies.push(
        applyAvegfNaiveFields({
          nct: String(nct).toUpperCase(),
          title: ps.identificationModule?.briefTitle || null,
          status: ps.statusModule?.overallStatus || null,
          phase: (ps.designModule?.phases || [])[0] || null,
          sponsor: ps.sponsorCollaboratorsModule?.leadSponsor?.name || null,
          enrollment: ps.designModule?.enrollmentInfo?.count ?? null,
          startDate: ps.statusModule?.startDateStruct?.date || null,
          conditions: ps.conditionsModule?.conditions || [],
          eligibilityCriteria: elig ? String(elig).slice(0, 6000) : null,
          source: "clinicaltrials.gov/api/v2/gap-fill/recruiting"
        })
      );
    }
    token = data.nextPageToken || null;
    if (!token) break;
  }
  return {
    searched: true,
    queryCond: qCond,
    recruitingRegistryTotal: totalCount,
    recruitingCount: studies.length,
    recruitingSample: studies.slice(0, limit),
    note: `Live CT.gov RECRUITING search (${qCond}). Not limited to Cosmos.`
  };
}

/**
 * @param {Function} getDb
 * @param {{ filler: string, indication?: string, nct?: string, upsert?: boolean, limit?: number, maxPages?: number, max?: number, concurrency?: number, triggeredBy?: string }} opts
 */
async function runGapFill(getDb, opts = {}) {
  const filler = String(opts.filler || opts.id || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  const upsert = opts.upsert === true;
  const triggeredBy = opts.triggeredBy || "gap_fill_api";
  const t0 = Date.now();

  if (!filler) {
    return { ok: false, error: "Missing filler id", ...listGapFillers() };
  }

  if (filler === "ctgov_treatment_naive" || filler === "treatment_naive") {
    const indication = opts.indication || "Wet AMD";
    const live = await searchCtgovTreatmentNaiveLive(indication, {
      limit: opts.limit,
      maxPages: opts.maxPages
    });
    let write = null;
    if (upsert) {
      const rows = [
        ...(live.recruitingTreatmentNaiveSample || []),
        ...(live.treatmentNaiveSample || [])
      ];
      const byNct = new Map(rows.map((r) => [r.nct, r]));
      write = await upsertLiveRows(getDb, [...byNct.values()], { triggeredBy });
    }
    return {
      ok: true,
      filler: "ctgov_treatment_naive",
      fromCosmos: false,
      live: true,
      indication,
      counts: {
        treatmentNaive: live.treatmentNaiveCount,
        recruitingTreatmentNaive: live.recruitingTreatmentNaiveCount,
        scanned: live.scannedCount,
        recruitingRegistry: live.recruitingRegistryTotal
      },
      recruitingTreatmentNaiveSample: live.recruitingTreatmentNaiveSample || [],
      treatmentNaiveSample: live.treatmentNaiveSample || [],
      upsert: write,
      elapsedMs: Date.now() - t0,
      note: live.note
    };
  }

  if (filler === "ctgov_nct" || filler === "nct") {
    const nct = String(opts.nct || "")
      .trim()
      .toUpperCase();
    if (!nct) return { ok: false, error: "nct required", filler };
    const database = getDb();
    const existing = await readCosmosCtgovNct(database, nct);
    const hasElig = Boolean(existing?.eligibilityCriteria);
    if (existing && hasElig && opts.force !== true) {
      return {
        ok: true,
        filler: "ctgov_nct",
        fromCosmos: true,
        live: false,
        nct,
        trial: existing,
        elapsedMs: Date.now() - t0,
        note: "Already in Cosmos with eligibility — pass force:true to re-pull from CT.gov."
      };
    }
    const live = await fetchCtgovStudyByNct(nct);
    if (!live.ok) {
      return { ok: false, filler: "ctgov_nct", nct, error: live.error, elapsedMs: Date.now() - t0 };
    }
    let write = null;
    if (upsert || !existing) {
      write = await upsertLiveRows(getDb, [live.trial], { triggeredBy });
    }
    return {
      ok: true,
      filler: "ctgov_nct",
      fromCosmos: Boolean(existing),
      live: true,
      nct,
      trial: live.trial,
      upsert: write,
      elapsedMs: Date.now() - t0,
      note: existing
        ? "Live CT.gov refresh (Cosmos row was missing eligibility or force=true)."
        : "Not in Cosmos — fetched live from CT.gov."
    };
  }

  if (filler === "ctgov_eligibility" || filler === "eligibility") {
    const backfill = await backfillCtgovEligibility(getDb, {
      max: Number(opts.max) || 400,
      indication: opts.indication || null,
      concurrency: Number(opts.concurrency) || 5
    });
    return {
      ok: Boolean(backfill.ok),
      filler: "ctgov_eligibility",
      fromCosmos: true,
      live: true,
      ...backfill,
      elapsedMs: Date.now() - t0
    };
  }

  if (filler === "ctgov_recruiting" || filler === "recruiting") {
    const indication = opts.indication || "Wet AMD";
    const live = await searchCtgovRecruitingLive(indication, {
      limit: opts.limit,
      maxPages: opts.maxPages
    });
    let write = null;
    if (upsert) {
      write = await upsertLiveRows(getDb, live.recruitingSample || [], { triggeredBy });
    }
    return {
      ok: true,
      filler: "ctgov_recruiting",
      fromCosmos: false,
      live: true,
      indication,
      counts: {
        recruiting: live.recruitingCount,
        recruitingRegistry: live.recruitingRegistryTotal
      },
      recruitingSample: live.recruitingSample || [],
      upsert: write,
      elapsedMs: Date.now() - t0,
      note: live.note
    };
  }

  return {
    ok: false,
    error: `Unknown filler "${filler}"`,
    ...listGapFillers()
  };
}

module.exports = {
  listGapFillers,
  runGapFill,
  FILLERS,
  upsertLiveRows,
  fetchCtgovStudyByNct,
  searchCtgovRecruitingLive
};
