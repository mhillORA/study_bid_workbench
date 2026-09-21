/**
 * CT.gov eligibility → treatment-naïve (anti-VEGF / aVEGF) classification.
 *
 * Treatment-naïve nAMD = protocol population has NOT previously been treated
 * with anti-VEGF. Prefer eligibilityCriteria text:
 *   - Inclusion: treatment-naïve / previously untreated / no prior anti-VEGF
 *   - Exclusion: any prior / history of anti-VEGF (not just a short washout)
 *
 * Do NOT use title keywords alone. TrialHub has no eligibility fields.
 */

const AVEGF_RE =
  /\b(anti[- ]?vegf|a[- ]?vegf|anti\s*vascular\s*endothelial(?:\s*growth\s*factor)?|ranibizumab|aflibercept|bevacizumab|faricimab|brolucizumab|pegaptanib|conbercept|lucentis|eylea|avastin|vabysmo|beovu)\b/i;

const EXPLICIT_NAIVE_RE =
  /\b(treatment[- ]?na[iï]ve|tx[- ]?naive|anti[- ]?vegf[- ]?naive|a[- ]?vegf[- ]?naive|vegf[- ]?naive|previously\s+untreated|treatment[- ]?naive\s+(?:for\s+)?(?:n?amd|wet\s*amd|neovascular)|no\s+prior\s+(?:anti[- ]?vegf|a[- ]?vegf|intravitreal\s+anti[- ]?vegf)|never\s+(?:been\s+)?(?:treated\s+with|received)\s+(?:an?\s+)?anti[- ]?vegf)\b/i;

const EXPERIENCED_RE =
  /\b(prior\s+anti[- ]?vegf\s+(?:treated|treatment|therapy|exposure)|previously\s+treated\s+with\s+anti[- ]?vegf|inadequate\s+response\s+to\s+(?:prior\s+)?anti[- ]?vegf|switch(?:ing)?\s+(?:from\s+)?anti[- ]?vegf|anti[- ]?vegf[- ]?experienced|treatment[- ]?experienced)\b/i;

/** Short washout windows ≠ treatment-naïve lifetime exclusion. */
const WASHOUT_ONLY_RE =
  /\bwithin\s+(?:the\s+)?\d+\s*(?:days?|weeks?|months?)\b|\bin\s+the\s+(?:\d+\s*)?(?:days?|weeks?|months?)\s+prior\b|\blast\s+\d+\s*(?:days?|weeks?|months?)\b|\b\d+\s*(?:days?|weeks?|months?)\s+prior\s+to\b/i;

const CTGOV_API = "https://clinicaltrials.gov/api/v2/studies";
const USER_AGENT = "OraStudyBidWorkbench/1.0 (ctgov-eligibility)";

function splitInclusionExclusion(raw) {
  const text = String(raw || "");
  if (!text.trim()) return { inclusion: "", exclusion: "", raw: "" };
  const lower = text.toLowerCase();
  const exclIdx = lower.search(/\bexclusion(?:\s+criteria)?\s*:/);
  const inclIdx = lower.search(/\binclusion(?:\s+criteria)?\s*:/);
  let inclusion = text;
  let exclusion = "";
  if (exclIdx >= 0 && inclIdx >= 0) {
    if (inclIdx < exclIdx) {
      inclusion = text.slice(inclIdx, exclIdx);
      exclusion = text.slice(exclIdx);
    } else {
      exclusion = text.slice(exclIdx, inclIdx);
      inclusion = text.slice(inclIdx);
    }
  } else if (exclIdx >= 0) {
    inclusion = text.slice(0, exclIdx);
    exclusion = text.slice(exclIdx);
  } else if (inclIdx >= 0) {
    inclusion = text.slice(inclIdx);
  }
  return { inclusion, exclusion, raw: text };
}

function clipEvidence(s, max = 220) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function lineLooksWashoutOnly(line) {
  return WASHOUT_ONLY_RE.test(line) && !/\b(any\s+prior|never|no\s+prior|history\s+of\s+prior|previously\s+untreated)\b/i.test(line);
}

function lineExcludesPriorAvegf(line) {
  if (!line || !AVEGF_RE.test(line)) return false;
  if (/\bother\s+than\s+anti[- ]?vegf\b/i.test(line)) return false;
  if (/\bexcept\b.{0,60}\b(aflibercept|ranibizumab|bevacizumab|anti[- ]?vegf)\b/i.test(line)) return false;
  if (lineLooksWashoutOnly(line)) return false;
  // Strong: any prior / history of / previous treatment with aVEGF
  if (
    /\b(any\s+prior|no\s+history|history\s+of|previous(?:ly)?\s+(?:ocular\s+)?(?:treatment|therapy|use|injection)|prior\s+(?:ocular\s+)?(?:treatment|therapy|use|injection|anti)|never\s+received|have\s+not\s+received|not\s+have\s+received)\b/i.test(
      line
    ) &&
    AVEGF_RE.test(line)
  ) {
    return true;
  }
  // Exclusion bullet: prior/previous + aVEGF drug name without washout-only
  if (PRIOR_LIFETIME_RE.test(line) && AVEGF_RE.test(line) && !lineLooksWashoutOnly(line)) {
    return true;
  }
  return false;
}

const PRIOR_LIFETIME_RE =
  /\b(any\s+prior|prior|previous|previously|history\s+of|previous\s+treatment|prior\s+treatment|previously\s+treated|treated\s+with|exposure\s+to)\b/i;

/**
 * Classify whether eligibility implies an anti-VEGF–naïve population.
 */
function analyzeAvegfTreatmentNaive(eligibilityCriteria) {
  const empty = {
    likely: false,
    confidence: "none",
    reason: null,
    evidence: null,
    excludesPriorAvegf: false,
    requiresPriorAvegf: false
  };
  const { inclusion, exclusion, raw } = splitInclusionExclusion(eligibilityCriteria);
  if (!raw.trim()) return empty;

  if (EXPERIENCED_RE.test(inclusion)) {
    return {
      likely: false,
      confidence: "high",
      reason: "inclusion_requires_prior_avegf",
      evidence: clipEvidence(inclusion.match(EXPERIENCED_RE)?.[0] || inclusion),
      excludesPriorAvegf: false,
      requiresPriorAvegf: true
    };
  }

  // Explicit naïve language
  if (EXPLICIT_NAIVE_RE.test(raw)) {
    const m = raw.match(EXPLICIT_NAIVE_RE);
    return {
      likely: true,
      confidence: "high",
      reason: "explicit_treatment_naive_language",
      evidence: clipEvidence(m?.[0] || raw),
      excludesPriorAvegf: true,
      requiresPriorAvegf: false
    };
  }

  // Inclusion: no prior anti-VEGF
  if (
    /\b(no|without|never|not\s+have|have\s+not|must\s+not\s+have)\b.{0,50}\b(prior|previous|previously|history)/i.test(
      inclusion
    ) &&
    AVEGF_RE.test(inclusion)
  ) {
    return {
      likely: true,
      confidence: "high",
      reason: "inclusion_no_prior_avegf",
      evidence: clipEvidence(inclusion),
      excludesPriorAvegf: true,
      requiresPriorAvegf: false
    };
  }

  // Exclusion lines that bar prior aVEGF (lifetime), not washout-only
  const exclLines = exclusion
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 8);
  for (const line of exclLines.length ? exclLines : [exclusion]) {
    if (lineExcludesPriorAvegf(line)) {
      return {
        likely: true,
        confidence: "high",
        reason: "exclusion_prior_avegf",
        evidence: clipEvidence(line),
        excludesPriorAvegf: true,
        requiresPriorAvegf: false
      };
    }
  }

  return empty;
}

function applyAvegfNaiveFields(doc) {
  const analysis = analyzeAvegfTreatmentNaive(doc?.eligibilityCriteria);
  return {
    ...doc,
    excludesPriorAvegf: analysis.excludesPriorAvegf,
    requiresPriorAvegf: analysis.requiresPriorAvegf,
    treatmentNaiveLikely: analysis.likely,
    treatmentNaiveConfidence: analysis.confidence,
    treatmentNaiveReason: analysis.reason,
    treatmentNaiveEvidence: analysis.evidence
  };
}

async function fetchEligibilityCriteriaForNct(nct) {
  const id = String(nct || "").toUpperCase().trim();
  if (!/^NCT\d{8}$/.test(id)) return null;
  const url = `${CTGOV_API}/${encodeURIComponent(id)}?format=json&fields=NCTId,EligibilityCriteria`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT }
  });
  if (!res.ok) return null;
  const data = await res.json();
  const criteria = data?.protocolSection?.eligibilityModule?.eligibilityCriteria || null;
  return criteria ? String(criteria) : null;
}

async function enrichTrialsWithEligibility(trials, opts = {}) {
  const list = Array.isArray(trials) ? trials : [];
  const limit = Math.min(50, Math.max(0, Number(opts.limit) || 30));
  const concurrency = Math.min(6, Math.max(1, Number(opts.concurrency) || 4));
  const need = list
    .filter((t) => t && t.nct && !String(t.eligibilityCriteria || "").trim())
    .slice(0, limit);
  if (!need.length) {
    return list.map((t) => applyAvegfNaiveFields({ ...t }));
  }

  let i = 0;
  const byNct = new Map();
  async function worker() {
    while (i < need.length) {
      const idx = i++;
      const t = need[idx];
      try {
        const criteria = await fetchEligibilityCriteriaForNct(t.nct);
        if (criteria) byNct.set(String(t.nct).toUpperCase(), criteria);
      } catch (_) {
        /* skip */
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return list.map((t) => {
    const nct = String(t.nct || "").toUpperCase();
    const criteria = t.eligibilityCriteria || byNct.get(nct) || null;
    return applyAvegfNaiveFields({
      ...t,
      eligibilityCriteria: criteria ? String(criteria).slice(0, 6000) : t.eligibilityCriteria || null,
      eligibilityEnrichedLive: Boolean(!t.eligibilityCriteria && byNct.has(nct))
    });
  });
}

/**
 * Live CT.gov search for an indication — pulls eligibility and flags treatment-naïve.
 * Used when Cosmos rows lack eligibilityCriteria (pre-ingest) or return 0 naïve.
 */
async function searchCtgovTreatmentNaiveLive(indication, opts = {}) {
  const maxPages = Math.min(4, Math.max(1, Number(opts.maxPages) || 3));
  const pageSize = 100;
  const limit = Math.min(40, Math.max(10, Number(opts.limit) || 25));
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
      pageSize: String(pageSize),
      countTotal: "true",
      "query.cond": qCond,
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
      const row = applyAvegfNaiveFields({
        nct: String(nct).toUpperCase(),
        title: ps.identificationModule?.briefTitle || null,
        status: ps.statusModule?.overallStatus || null,
        phase: (ps.designModule?.phases || [])[0] || null,
        sponsor: ps.sponsorCollaboratorsModule?.leadSponsor?.name || null,
        enrollment: ps.designModule?.enrollmentInfo?.count ?? null,
        startDate: ps.statusModule?.startDateStruct?.date || null,
        conditions: ps.conditionsModule?.conditions || [],
        eligibilityCriteria: elig ? String(elig).slice(0, 6000) : null,
        source: "clinicaltrials.gov/api/v2/live"
      });
      studies.push(row);
    }
    token = data.nextPageToken || null;
    if (!token) break;
  }

  const naive = studies.filter((t) => t.treatmentNaiveLikely);
  return {
    searched: true,
    queryCond: qCond,
    scannedCount: studies.length,
    registryTotalCount: totalCount,
    treatmentNaiveCount: naive.length,
    treatmentNaiveSample: naive.slice(0, limit).map((t) => ({
      nct: t.nct,
      title: t.title,
      status: t.status,
      phase: t.phase,
      sponsor: t.sponsor,
      enrollment: t.enrollment,
      startDate: t.startDate,
      excludesPriorAvegf: t.excludesPriorAvegf === true,
      treatmentNaiveReason: t.treatmentNaiveReason,
      treatmentNaiveEvidence: t.treatmentNaiveEvidence,
      treatmentNaiveConfidence: t.treatmentNaiveConfidence
    })),
    sample: studies.slice(0, limit),
    note: `Live CT.gov search (${qCond}). Scanned ${studies.length} studies; ${naive.length} flagged treatment-naïve from Eligibility Criteria (prior aVEGF exclusion / explicit naïve language). Not TrialHub.`
  };
}

module.exports = {
  analyzeAvegfTreatmentNaive,
  applyAvegfNaiveFields,
  fetchEligibilityCriteriaForNct,
  enrichTrialsWithEligibility,
  searchCtgovTreatmentNaiveLive,
  splitInclusionExclusion,
  AVEGF_RE
};
