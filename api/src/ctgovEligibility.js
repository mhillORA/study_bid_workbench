/**
 * CT.gov eligibility → treatment-naïve (anti-VEGF / aVEGF) classification.
 *
 * Treatment-naïve nAMD means the protocol population has NOT been previously
 * treated with anti-VEGF — usually stated as:
 *   - Inclusion: treatment-naïve / previously untreated / no prior anti-VEGF
 *   - Exclusion: prior / previous anti-VEGF (ranibizumab, aflibercept, …)
 *
 * Do NOT use title keywords alone. Prefer eligibilityCriteria text.
 */

const AVEGF_RE =
  /\b(anti[- ]?vegf|a[- ]?vegf|anti\s*vascular\s*endothelial|ranibizumab|aflibercept|bevacizumab|faricimab|brolucizumab|pegaptanib|conbercept|lucentis|eylea|avastin|vabysmo|beovu)\b/i;

const PRIOR_RE =
  /\b(prior|previous|previously|history\s+of|prior\s+treatment|previous\s+treatment|previously\s+treated|received|treated\s+with|exposure\s+to|any\s+prior)\b/i;

const EXPLICIT_NAIVE_RE =
  /\b(treatment[- ]?na[iï]ve|tx[- ]?naive|anti[- ]?vegf[- ]?naive|vegf[- ]?naive|previously\s+untreated|treatment[- ]?naive\s+(?:n?amd|wet\s*amd|neovascular)|no\s+prior\s+(?:anti[- ]?vegf|a[- ]?vegf|intravitreal\s+anti))\b/i;

/** Experienced / switch studies — NOT naïve. */
const EXPERIENCED_RE =
  /\b(prior\s+anti[- ]?vegf\s+(?:treated|treatment|therapy|exposure)|previously\s+treated\s+with\s+anti[- ]?vegf|inadequate\s+response\s+to\s+(?:prior\s+)?anti[- ]?vegf|switch(?:ing)?\s+(?:from\s+)?anti[- ]?vegf|anti[- ]?vegf[- ]?experienced|treatment[- ]?experienced)\b/i;

const CTGOV_STUDY_URL = "https://clinicaltrials.gov/api/v2/studies";
const USER_AGENT = "OraStudyBidWorkbench/1.0 (ctgov-eligibility)";

function splitInclusionExclusion(raw) {
  const text = String(raw || "");
  if (!text.trim()) return { inclusion: "", exclusion: "", raw: "" };
  const lower = text.toLowerCase();
  const exclIdx = lower.search(/\bexclusion\s+criteria\b/);
  const inclIdx = lower.search(/\binclusion\s+criteria\b/);
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
  }
  return { inclusion, exclusion, raw: text };
}

function clipEvidence(s, max = 220) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Classify whether a trial's eligibility implies an anti-VEGF–naïve population.
 * @returns {{ likely: boolean, confidence: 'high'|'medium'|'low'|'none', reason: string|null, evidence: string|null, excludesPriorAvegf: boolean, requiresPriorAvegf: boolean }}
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

  // Explicit experienced / switch population in inclusion → not naïve
  if (EXPERIENCED_RE.test(inclusion) || (EXPERIENCED_RE.test(raw) && !EXPLICIT_NAIVE_RE.test(raw))) {
    if (EXPERIENCED_RE.test(inclusion) || /\brequires?\b.{0,40}\bprior\s+anti[- ]?vegf\b/i.test(inclusion)) {
      return {
        likely: false,
        confidence: "high",
        reason: "inclusion_requires_prior_avegf",
        evidence: clipEvidence(inclusion.match(EXPERIENCED_RE)?.[0] || inclusion),
        excludesPriorAvegf: false,
        requiresPriorAvegf: true
      };
    }
  }

  // Inclusion requires prior aVEGF (treated population)
  if (
    AVEGF_RE.test(inclusion) &&
    PRIOR_RE.test(inclusion) &&
    !/\b(no|without|never|not)\b.{0,30}\b(prior|previous)/i.test(inclusion) &&
    /\b(must\s+have|required|require[sd]?|history\s+of\s+prior|prior\s+treatment\s+with)\b/i.test(inclusion)
  ) {
    return {
      likely: false,
      confidence: "high",
      reason: "inclusion_requires_prior_avegf",
      evidence: clipEvidence(inclusion),
      excludesPriorAvegf: false,
      requiresPriorAvegf: true
    };
  }

  // Explicit naïve language anywhere
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
    AVEGF_RE.test(inclusion) &&
    /\b(no|without|never|not\s+have|have\s+not)\b.{0,40}\b(prior|previous|previously|history)/i.test(inclusion)
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

  // Exclusion: prior anti-VEGF (classic naïve gate)
  const exclLines = exclusion.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (const line of exclLines.length ? exclLines : [exclusion]) {
    if (!AVEGF_RE.test(line) || !PRIOR_RE.test(line)) continue;
    // Skip "inadequate response to prior anti-VEGF" as sole cue in experienced studies
    if (/\binadequate\s+response\b/i.test(line) && !/\bexclu/i.test(exclusion.slice(0, 40))) {
      continue;
    }
    return {
      likely: true,
      confidence: "high",
      reason: "exclusion_prior_avegf",
      evidence: clipEvidence(line),
      excludesPriorAvegf: true,
      requiresPriorAvegf: false
    };
  }

  // Whole-text fallback: exclusion-ish prior aVEGF near "exclu"
  if (AVEGF_RE.test(exclusion) && PRIOR_RE.test(exclusion)) {
    return {
      likely: true,
      confidence: "medium",
      reason: "exclusion_section_prior_avegf",
      evidence: clipEvidence(exclusion),
      excludesPriorAvegf: true,
      requiresPriorAvegf: false
    };
  }

  return empty;
}

/** Attach derived fields onto a CT.gov trial document. */
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
  const url = `${CTGOV_STUDY_URL}/${encodeURIComponent(id)}?format=json&fields=NCTId,EligibilityCriteria`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT }
  });
  if (!res.ok) return null;
  const data = await res.json();
  const criteria =
    data?.protocolSection?.eligibilityModule?.eligibilityCriteria ||
    data?.eligibilityModule?.eligibilityCriteria ||
    null;
  return criteria ? String(criteria) : null;
}

/**
 * Enrich trial rows missing eligibilityCriteria by hitting CT.gov study endpoint.
 * Bounded concurrency; mutates copies, returns new array.
 */
async function enrichTrialsWithEligibility(trials, opts = {}) {
  const list = Array.isArray(trials) ? trials : [];
  const limit = Math.min(40, Math.max(0, Number(opts.limit) || 25));
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
    const next = {
      ...t,
      eligibilityCriteria: criteria
        ? String(criteria).slice(0, 6000)
        : t.eligibilityCriteria || null,
      eligibilityEnrichedLive: Boolean(!t.eligibilityCriteria && byNct.has(nct))
    };
    return applyAvegfNaiveFields(next);
  });
}

module.exports = {
  analyzeAvegfTreatmentNaive,
  applyAvegfNaiveFields,
  fetchEligibilityCriteriaForNct,
  enrichTrialsWithEligibility,
  splitInclusionExclusion,
  AVEGF_RE
};
