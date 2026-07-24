/**
 * Ora Clinical Intelligence — Cosmos reference tables (Veeva + TrialHub).
 * Summaries only for Buddy; never dump full collections into the LLM context.
 *
 * Containers: ora_fact_site, ora_fact_study, ora_trialhub_trials,
 *             ora_sponsor_crosswalk, ora_site_alias_table
 * See docs/ora-intelligence.md
 */

const DATASET = "ora_clinical_intelligence";

/** Synonym groups — first entry is preferred display label when matched. */
const INDICATION_GROUPS = [
  ["Dry Eye", "Dry Eye Disease", "DED"],
  ["Cataract", "Cataracts"],
  ["Diabetic Macular Edema (DME)", "DME", "Diabetic Macular Edema"],
  ["Wet AMD", "Neovascular (Wet) Age-Related Macular Degeneration", "nAMD", "Wet Age-Related Macular Degeneration"],
  ["Geographic Atrophy / Dry AMD", "Geographic Atrophy", "Dry AMD", "GA"],
  ["Glaucoma / Ocular Hypertension", "Glaucoma", "Primary Open-Angle Glaucoma or Ocular Hypertension", "Ocular Hypertension", "POAG"],
  ["Retinitis Pigmentosa", "RP"],
  ["Presbyopia"],
  ["Allergic Conjunctivitis"],
  ["Diabetic Retinopathy", "DR"],
  ["Thyroid Eye Disease", "TED"],
  ["Myopia"],
  ["Blepharitis"]
];

function normText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function indicationAliases(raw) {
  if (!raw) return [];
  const n = normText(raw);
  const tokens = new Set(n.split(/\s+/).filter(Boolean));
  const out = new Set([String(raw).trim()]);
  for (const group of INDICATION_GROUPS) {
    const hit = group.some((g) => {
      const ng = normText(g);
      if (!ng) return false;
      if (ng === n) return true;
      // Short codes (DR, GA, RP, …): exact token only — never substring
      if (ng.length <= 3) return tokens.has(ng);
      // Longer labels: either side may contain the other as a phrase
      return n.includes(ng) || ng.includes(n);
    });
    if (hit) for (const g of group) out.add(g);
  }
  return [...out];
}

function isIntelligenceQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  return (
    /\b(psm|patients?\s*per\s*site|pts?\s*\/\s*site|enrollment rate|enrolment rate)\b/.test(q) ||
    /\b(feasibility|site (mix|selection|performance|capacity)|competing trials?|competitor|competitive landscape)\b/.test(
      q
    ) ||
    /\b(trialhub|trial hub|industry (benchmark|trial|psm)|nct\d*|clinicaltrials\.gov|ct\.gov|ctgov)\b/.test(q) ||
    /\b(screen[- ]?fail|dropout|recruit(ment)? (rate|days|benchmark))\b/.test(q) ||
    /\b(indication).{0,40}\b(benchmark|histor(y|ical)|industry|ora studies)\b/.test(q) ||
    /\b(how (fast|quickly)|typical).{0,40}\b(enroll|recruit|site)\b/.test(q) ||
    /\b(veeva|ora (histor|performance|sites?))\b/.test(q)
  );
}

function extractIndicationFromQuestion(question) {
  const q = String(question || "");
  // Prefer known labels (longest first)
  const labels = INDICATION_GROUPS.flat().sort((a, b) => b.length - a.length);
  const lower = q.toLowerCase();
  for (const label of labels) {
    if (lower.includes(label.toLowerCase())) return label;
  }
  const m = q.match(/\b(?:indication|in)\s+([A-Za-z][A-Za-z0-9 /()-]{2,60})/i);
  return m ? m[1].trim().replace(/[?.!,;]+$/, "") : null;
}

function extractNct(question) {
  const m = String(question || "").match(/\b(NCT\d{8})\b/i);
  return m ? m[1].toUpperCase() : null;
}

function median(nums) {
  const a = nums.filter((n) => typeof n === "number" && !Number.isNaN(n) && n > 0).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function round(n, d = 3) {
  if (n == null || Number.isNaN(n)) return null;
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

function percentile(nums, p) {
  const a = nums.filter((n) => typeof n === "number" && !Number.isNaN(n) && n > 0).sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = Math.min(a.length - 1, Math.max(0, Math.floor((p / 100) * (a.length - 1))));
  return a[idx];
}

async function queryAll(container, query, parameters = []) {
  const { resources } = await container.items
    .query({ query, parameters }, { enableCrossPartitionQuery: true })
    .fetchAll();
  return resources || [];
}

async function safeCount(database, containerId) {
  try {
    const rows = await queryAll(
      database.container(containerId),
      "SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t",
      [{ name: "@t", value: containerId }]
    );
    return rows[0] ?? 0;
  } catch (err) {
    return { error: String(err.message || err) };
  }
}

async function getIntelligenceHealth(getDb) {
  const database = getDb();
  const containers = [
    "ora_fact_site",
    "ora_fact_study",
    "ora_trialhub_trials",
    "ora_sponsor_crosswalk",
    "ora_site_alias_table",
    "ora_ctgov_trials"
  ];
  const counts = {};
  for (const id of containers) {
    counts[id] = await safeCount(database, id);
  }
  const expected = {
    ora_fact_site: 3613,
    ora_fact_study: 249,
    ora_trialhub_trials: 1682,
    ora_sponsor_crosswalk: 642,
    ora_site_alias_table: 46
  };
  const fixedOk = Object.keys(expected).every((id) => counts[id] === expected[id]);
  let syncState = null;
  try {
    const { resource } = await database.container("syncState").item("ctgov_ophthalmology", "ctgov_ophthalmology").read();
    syncState = resource
      ? {
          lastSuccessfulSync: resource.lastSuccessfulSync,
          lastUpserted: resource.lastUpserted,
          mode: resource.mode,
          lastTotalCount: resource.lastTotalCount
        }
      : null;
  } catch (_) {
    syncState = null;
  }
  return {
    dataset: DATASET,
    ok: fixedOk,
    counts,
    expected,
    ctgov: {
      count: counts.ora_ctgov_trials,
      sync: syncState,
      note: "Growing feed — daily delta ~5AM Eastern; no fixed expected count."
    },
    note: fixedOk
      ? "Core intelligence containers loaded."
      : "Count mismatch or containers missing — run ingest/load_ora_intelligence.py"
  };
}

async function lookupSponsorCrosswalk(database, sponsorOrClient) {
  if (!sponsorOrClient) return null;
  const needle = String(sponsorOrClient).trim();
  if (!needle) return null;
  const container = database.container("ora_sponsor_crosswalk");
  // Exact on renamed field, then CONTAINS both ways (bounded)
  let rows = await queryAll(
    container,
    `SELECT TOP 5 c.trialhub_veeva_sponsor, c.sf_account_name, c.sf_account_id, c.sf_owner, c.tier, c.crosswalk_status, c.score
     FROM c WHERE c.docType = @t AND (
       c.trialhub_veeva_sponsor = @n OR c.sf_account_name = @n OR c.sf_canonical_name = @n OR c.sponsor_name = @n
     )`,
    [
      { name: "@t", value: "ora_sponsor_crosswalk" },
      { name: "@n", value: needle }
    ]
  );
  if (!rows.length) {
    rows = await queryAll(
      container,
      `SELECT TOP 8 c.trialhub_veeva_sponsor, c.sf_account_name, c.sf_account_id, c.sf_owner, c.tier, c.crosswalk_status, c.score
       FROM c WHERE c.docType = @t AND (
         CONTAINS(c.trialhub_veeva_sponsor, @n, true) OR
         CONTAINS(c.sf_account_name, @n, true)
       )`,
      [
        { name: "@t", value: "ora_sponsor_crosswalk" },
        { name: "@n", value: needle }
      ]
    );
  }
  return rows.slice(0, 5);
}

async function benchmarkIndication(database, indication) {
  const aliases = indicationAliases(indication);
  if (!aliases.length) return null;

  const studyContainer = database.container("ora_fact_study");
  const siteContainer = database.container("ora_fact_site");
  const thContainer = database.container("ora_trialhub_trials");

  // Pull studies for any alias (cross-partition)
  const oraStudies = [];
  for (const alias of aliases.slice(0, 8)) {
    const rows = await queryAll(
      studyContainer,
      `SELECT c.study_number, c.sponsor, c.indication, c.phase, c.psm, c.study_rate_pt_mo,
              c.total_enrolled, c.enroll_months, c.n_contributing_sites, c.screen_fail_rate_recomputed,
              c.lifecycle_state, c.countries
       FROM c WHERE c.docType = @t AND c.indication = @ind`,
      [
        { name: "@t", value: "ora_fact_study" },
        { name: "@ind", value: alias }
      ]
    );
    for (const r of rows) {
      if (!oraStudies.some((x) => x.study_number === r.study_number)) oraStudies.push(r);
    }
  }

  const thTrials = [];
  for (const alias of aliases.slice(0, 8)) {
    const rows = await queryAll(
      thContainer,
      `SELECT c.nct, c.title, c.sponsor, c.indication, c.phase, c.status, c.patients,
              c.planned_sites, c.actual_sites, c.psm_common, c.th_actual_psm, c.recruit_days,
              c.n_countries, c.in_ora_indication, c.lead_sponsor_type
       FROM c WHERE c.docType = @t AND c.indication = @ind`,
      [
        { name: "@t", value: "ora_trialhub_trials" },
        { name: "@ind", value: alias }
      ]
    );
    for (const r of rows) {
      if (!thTrials.some((x) => x.nct === r.nct)) thTrials.push(r);
    }
  }

  // Site PSM for aliases (cap scan — prefer high trust)
  const sitePsms = [];
  const topSites = [];
  for (const alias of aliases.slice(0, 4)) {
    const rows = await queryAll(
      siteContainer,
      `SELECT TOP 200 c.org_clean, c.organization, c.country, c.indication, c.phase,
              c.site_psm, c.total_enrolled, c.site_enroll_months, c.fsi_trust, c.study_name
       FROM c WHERE c.docType = @t AND c.indication = @ind AND IS_DEFINED(c.site_psm) AND c.site_psm > 0`,
      [
        { name: "@t", value: "ora_fact_site" },
        { name: "@ind", value: alias }
      ]
    );
    const sorted = [...rows].sort((a, b) => (b.site_psm || 0) - (a.site_psm || 0));
    for (const r of sorted) {
      if (typeof r.site_psm === "number") sitePsms.push(r.site_psm);
      if (topSites.length < 12 && r.org_clean) {
        if (!topSites.some((x) => x.org_clean === r.org_clean && x.country === r.country)) {
          topSites.push({
            org_clean: r.org_clean,
            country: r.country,
            site_psm: round(r.site_psm),
            total_enrolled: r.total_enrolled,
            fsi_trust: r.fsi_trust,
            study_name: r.study_name
          });
        }
      }
    }
  }

  const oraPsm = oraStudies.map((s) => s.psm).filter((n) => typeof n === "number" && n > 0);
  const thPsm = thTrials
    .map((t) => (typeof t.psm_common === "number" ? t.psm_common : t.th_actual_psm))
    .filter((n) => typeof n === "number" && n > 0 && n < 500); // drop absurd outliers from summary stats

  const recruiting = thTrials.filter((t) => /recruit/i.test(String(t.status || "")));
  const completed = thTrials.filter((t) => /completed/i.test(String(t.status || "")));

  return {
    indicationRequested: indication,
    aliasesUsed: aliases,
    ora: {
      studyCount: oraStudies.length,
      studiesWithPsm: oraPsm.length,
      psmMedian: round(median(oraPsm)),
      psmP25: round(percentile(oraPsm, 25)),
      psmP75: round(percentile(oraPsm, 75)),
      sampleStudies: oraStudies
        .filter((s) => typeof s.psm === "number" && s.psm > 0)
        .sort((a, b) => b.psm - a.psm)
        .slice(0, 8)
        .map((s) => ({
          study_number: s.study_number,
          sponsor: s.sponsor,
          phase: s.phase,
          psm: round(s.psm),
          total_enrolled: s.total_enrolled,
          n_contributing_sites: s.n_contributing_sites,
          lifecycle_state: s.lifecycle_state
        }))
    },
    trialhub: {
      trialCount: thTrials.length,
      inOraIndicationCount: thTrials.filter((t) => t.in_ora_indication).length,
      recruitingCount: recruiting.length,
      completedCount: completed.length,
      trialsWithPsm: thPsm.length,
      psmMedian: round(median(thPsm)),
      psmP25: round(percentile(thPsm, 25)),
      psmP75: round(percentile(thPsm, 75)),
      note: "psm stats exclude values >= 500 (outlier guard). Prefer median over mean.",
      sampleTrials: thTrials
        .filter((t) => typeof (t.psm_common ?? t.th_actual_psm) === "number")
        .sort((a, b) => (b.psm_common || b.th_actual_psm || 0) - (a.psm_common || a.th_actual_psm || 0))
        .slice(0, 8)
        .map((t) => ({
          nct: t.nct,
          title: t.title,
          sponsor: t.sponsor,
          phase: t.phase,
          status: t.status,
          patients: t.patients,
          sites: t.actual_sites ?? t.planned_sites,
          psm_common: round(t.psm_common),
          recruit_days: t.recruit_days
        })),
      recruitingSample: recruiting.slice(0, 6).map((t) => ({
        nct: t.nct,
        title: t.title,
        sponsor: t.sponsor,
        phase: t.phase,
        patients: t.patients,
        planned_sites: t.planned_sites
      }))
    },
    sites: {
      sitesWithPsmSampled: sitePsms.length,
      sitePsmMedian: round(median(sitePsms)),
      sitePsmP75: round(percentile(sitePsms, 75)),
      topSitesByPsm: topSites.slice(0, 10),
      note: "High null rates on site_psm are expected Veeva gaps — null ≠ 0."
    }
  };
}

async function lookupNct(database, nct) {
  if (!nct) return null;
  const rows = await queryAll(
    database.container("ora_trialhub_trials"),
    `SELECT TOP 3 c.nct, c.title, c.sponsor, c.indication, c.phase, c.status, c.patients,
            c.planned_sites, c.actual_sites, c.psm_common, c.th_actual_psm, c.recruit_days,
            c.countries, c.drop_rate, c.treatment_duration_months, c.in_ora_indication
     FROM c WHERE c.docType = @t AND c.nct = @nct`,
    [
      { name: "@t", value: "ora_trialhub_trials" },
      { name: "@nct", value: nct }
    ]
  );
  return rows[0] || null;
}

async function lookupCtgovNct(database, nct) {
  if (!nct) return null;
  try {
    const rows = await queryAll(
      database.container("ora_ctgov_trials"),
      `SELECT TOP 3 c.nct, c.title, c.oraIndication, c.status, c.phase, c.sponsor, c.sponsorClass,
              c.enrollment, c.enrollmentType, c.conditions, c.countries, c.startDate,
              c.primaryCompletionDate, c.lastUpdatePostDate, c.hasResults, c.interventions
       FROM c WHERE c.docType = @t AND c.nct = @nct`,
      [
        { name: "@t", value: "ora_ctgov_trials" },
        { name: "@nct", value: nct }
      ]
    );
    return rows[0] || null;
  } catch (_) {
    return null;
  }
}

async function ctgovByIndication(database, indication) {
  const aliases = indicationAliases(indication);
  if (!aliases.length) return null;
  try {
    const trials = [];
    for (const alias of aliases.slice(0, 6)) {
      const rows = await queryAll(
        database.container("ora_ctgov_trials"),
        `SELECT TOP 40 c.nct, c.title, c.oraIndication, c.status, c.phase, c.sponsor, c.sponsorClass,
                c.enrollment, c.countries, c.startDate, c.lastUpdatePostDate, c.hasResults
         FROM c WHERE c.docType = @t AND c.oraIndication = @ind`,
        [
          { name: "@t", value: "ora_ctgov_trials" },
          { name: "@ind", value: alias }
        ]
      );
      for (const r of rows) {
        if (!trials.some((x) => x.nct === r.nct)) trials.push(r);
      }
    }
    const recruiting = trials.filter((t) => /recruit/i.test(String(t.status || "")));
    return {
      trialCount: trials.length,
      recruitingCount: recruiting.length,
      sample: trials.slice(0, 10),
      recruitingSample: recruiting.slice(0, 8),
      note: "From ClinicalTrials.gov daily ophthalmology feed (ora_ctgov_trials)."
    };
  } catch (err) {
    return { error: String(err.message || err), note: "CT.gov container may be empty until first pull." };
  }
}

/**
 * Build a bounded intelligence context for Buddy.
 */
async function buildIntelligenceContext(getDb, opts = {}) {
  const {
    question = "",
    indication = null,
    clientName = null,
    sponsor = null,
    force = false
  } = opts;

  const wantsIntel = force || isIntelligenceQuestion(question);
  const nct = extractNct(question);
  const qIndication = extractIndicationFromQuestion(question);
  const resolvedIndication = indication || qIndication;

  // Skip entirely if nothing to hang a query on and question isn't intelligence-shaped
  if (!wantsIntel && !resolvedIndication && !nct && !clientName && !sponsor) {
    return null;
  }

  const database = getDb();
  const started = Date.now();
  const out = {
    source: "ora_clinical_intelligence",
    dataset: DATASET,
    rules: [
      "Use medians for PSM; never invent rates from nulls.",
      "null enrollment/PSM means missing Veeva data — not zero.",
      "TrialHub vs Ora vs CT.gov indication labels may differ; aliasesUsed lists what was queried.",
      "Prefer fsi_trust=high when comparing site_psm.",
      "ctgov = ClinicalTrials.gov ophthalmology feed (daily delta)."
    ],
    query: {
      indication: resolvedIndication || null,
      nct: nct || null,
      clientName: clientName || null,
      sponsor: sponsor || null,
      intelligenceIntent: wantsIntel
    }
  };

  try {
    if (nct) {
      out.nctLookup = await lookupNct(database, nct);
      out.ctgovNct = await lookupCtgovNct(database, nct);
    }

    if (resolvedIndication || wantsIntel) {
      const ind = resolvedIndication || qIndication;
      if (ind) {
        out.indicationBenchmark = await benchmarkIndication(database, ind);
        out.ctgov = await ctgovByIndication(database, ind);
      }
    }

    const who = sponsor || clientName;
    if (who) {
      out.sponsorCrosswalk = await lookupSponsorCrosswalk(database, who);
    }

    // Compact inventory so Buddy knows data exists even on thin matches
    if (wantsIntel && !out.indicationBenchmark && !out.nctLookup) {
      out.inventory = await getIntelligenceHealth(getDb);
    }

    out.elapsedMs = Date.now() - started;
    return out;
  } catch (err) {
    return {
      source: "ora_clinical_intelligence_error",
      error: String(err.message || err),
      elapsedMs: Date.now() - started
    };
  }
}

module.exports = {
  DATASET,
  INDICATION_GROUPS,
  isIntelligenceQuestion,
  indicationAliases,
  extractIndicationFromQuestion,
  getIntelligenceHealth,
  buildIntelligenceContext,
  benchmarkIndication,
  lookupSponsorCrosswalk
};
