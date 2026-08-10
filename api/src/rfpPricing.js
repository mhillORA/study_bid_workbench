/**
 * RFP / bid pricing scenarios from past uploaded budgets.
 * Tiers: High Level Ballpark (P75), Moderate (median), Goal Bid (P25),
 * scaled to requested patients / sites.
 */

const { indicationAliases, INDICATION_GROUPS } = require("./intelligence");

function isPricingQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  return (
    /\b(rfp|rfi|proposal|pitch|bid|pricing|price|ballpark|quote|costing)\b/.test(q) ||
    /\b(high[- ]?level|moderate|goal)\b.{0,40}\b(bid|price|pricing|ballpark)\b/.test(q) ||
    /\b(ballpark|rough)\b.{0,30}\b(price|cost|fee|budget|number)\b/.test(q) ||
    /\b(how much|what (would|should) (we|it) (cost|price|bid))\b/.test(q) ||
    /\b(three|3)\b.{0,20}\b(sets?|tiers?|options?|scenarios?)\b.{0,40}\b(price|pricing|bid|numbers?)\b/.test(q) ||
    /\b(service fees?|grand total|cost per patient)\b/.test(q)
  );
}

function extractRfpScenarioFromQuestion(question, body = {}) {
  const q = String(question || "");
  const lower = q.toLowerCase();

  let enrolled =
    body.enrolledSubjects != null && body.enrolledSubjects !== ""
      ? Number(body.enrolledSubjects)
      : null;
  let sites =
    body.coreSites != null && body.coreSites !== "" ? Number(body.coreSites) : null;
  let indication =
    (body.indication && String(body.indication).trim()) ||
    (body.therapeuticArea && String(body.therapeuticArea).trim()) ||
    null;

  if (enrolled == null || Number.isNaN(enrolled)) {
    const m =
      q.match(
        /\b(\d{1,5})\s*(?:patients?|subjects?|enrollees?|pts?)\b/i
      ) ||
      q.match(
        /\b(?:patients?|subjects?|enrollees?|pts?)\s*(?:of|=|:)?\s*(\d{1,5})\b/i
      ) ||
      q.match(/\bwith\s+(\d{1,5})\s+(?:patients?|subjects?)\b/i);
    if (m) enrolled = Number(m[1]);
  }

  if (sites == null || Number.isNaN(sites)) {
    const m =
      q.match(/\b(\d{1,4})\s*sites?\b/i) ||
      q.match(/\b(?:over|across|at|with)\s+(\d{1,4})\s*sites?\b/i) ||
      q.match(/\bsites?\s*(?:of|=|:)?\s*(\d{1,4})\b/i);
    if (m) sites = Number(m[1]);
  }

  if (!indication) {
    // Prefer known ophthalmology labels in the question
    for (const group of INDICATION_GROUPS) {
      if (group.some((g) => lower.includes(String(g).toLowerCase()))) {
        indication = group[0];
        break;
      }
    }
  }

  const wantsTiers =
    /\b(ballpark|moderate|goal|high[- ]?level|tier|option|scenario|sets? of numbers)\b/i.test(q) ||
    isPricingQuestion(q);

  return {
    indication: indication || null,
    enrolledSubjects: enrolled != null && !Number.isNaN(enrolled) ? enrolled : null,
    coreSites: sites != null && !Number.isNaN(sites) ? sites : null,
    wantsTiers
  };
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const w = idx - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}

function roundMoney(n) {
  if (n == null || Number.isNaN(n)) return null;
  if (Math.abs(n) >= 100000) return Math.round(n / 1000) * 1000;
  if (Math.abs(n) >= 10000) return Math.round(n / 100) * 100;
  return Math.round(n);
}

function studyMatchesIndication(row, aliasesNorm) {
  const blob = normText(`${row.indication || ""} ${row.therapeuticArea || ""}`);
  if (!blob) return false;
  return aliasesNorm.some((a) => {
    if (!a || a.length < 4) return false;
    if (blob === a) return true;
    // Token-bounded — avoid "dry" ⊂ "dry eye"/"dry amd"
    return ` ${blob} `.includes(` ${a} `);
  });
}

function normText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * @param {object[]} portfolioStudies — rows from buildPortfolioContext().studies
 * @param {object} scenario — { indication, enrolledSubjects, coreSites }
 */
function buildRfpPricingPack(portfolioStudies, scenario = {}) {
  const indication = scenario.indication || null;
  const targetN =
    scenario.enrolledSubjects != null ? Number(scenario.enrolledSubjects) : null;
  const targetSites = scenario.coreSites != null ? Number(scenario.coreSites) : null;

  const aliases = indication ? indicationAliases(indication) : [];
  const aliasesNorm = aliases.map(normText).filter(Boolean);

  const rows = Array.isArray(portfolioStudies) ? portfolioStudies : [];
  let comps = rows.filter(
    (r) => typeof r.serviceFees === "number" || typeof r.grandTotal === "number"
  );
  if (aliasesNorm.length) {
    const matched = comps.filter((r) => studyMatchesIndication(r, aliasesNorm));
    if (matched.length) comps = matched;
  }

  const withCpp = [];
  for (const r of comps) {
    const fees = typeof r.serviceFees === "number" ? r.serviceFees : null;
    const grand = typeof r.grandTotal === "number" ? r.grandTotal : fees;
    const enrolled =
      typeof r.enrolledSubjects === "number" && r.enrolledSubjects > 0
        ? r.enrolledSubjects
        : null;
    const sites = typeof r.coreSites === "number" && r.coreSites > 0 ? r.coreSites : null;
    if (fees == null && grand == null) continue;
    const base = fees != null ? fees : grand;
    const cpp = enrolled != null ? base / enrolled : null;
    const cps = sites != null ? base / sites : null;
    withCpp.push({
      studyId: r.studyId,
      clientName: r.clientName,
      indication: r.indication,
      enrolledSubjects: enrolled,
      coreSites: sites,
      serviceFees: fees,
      grandTotal: grand,
      costPerPatient: cpp != null ? Math.round(cpp) : null,
      costPerSite: cps != null ? Math.round(cps) : null
    });
  }

  const cppList = withCpp
    .map((r) => r.costPerPatient)
    .filter((n) => typeof n === "number" && n > 0)
    .sort((a, b) => a - b);
  const cpsList = withCpp
    .map((r) => r.costPerSite)
    .filter((n) => typeof n === "number" && n > 0)
    .sort((a, b) => a - b);
  const feeList = withCpp
    .map((r) => (typeof r.serviceFees === "number" ? r.serviceFees : r.grandTotal))
    .filter((n) => typeof n === "number" && n > 0)
    .sort((a, b) => a - b);

  const p25 = percentile(cppList, 0.25);
  const p50 = percentile(cppList, 0.5);
  const p75 = percentile(cppList, 0.75);

  let tiers = null;
  if (targetN != null && targetN > 0 && p50 != null) {
    const goalCpp = p25 != null ? p25 : p50 * 0.85;
    const modCpp = p50;
    const highCpp = p75 != null ? p75 : p50 * 1.2;
    tiers = {
      target: {
        indication: indication || "unspecified",
        enrolledSubjects: targetN,
        coreSites: targetSites
      },
      basis: "serviceFees (or grandTotal) per enrolled subject from comparable past bids",
      highLevelBallpark: {
        label: "High Level Ballpark",
        serviceFees: roundMoney(highCpp * targetN),
        costPerPatient: roundMoney(highCpp),
        note: "P75 cost/patient × target N — padded / conservative"
      },
      moderate: {
        label: "Moderate",
        serviceFees: roundMoney(modCpp * targetN),
        costPerPatient: roundMoney(modCpp),
        note: "Median cost/patient × target N"
      },
      goalBid: {
        label: "Goal Bid",
        serviceFees: roundMoney(goalCpp * targetN),
        costPerPatient: roundMoney(goalCpp),
        note: "P25 cost/patient × target N — leaner / competitive target"
      }
    };

    // Optional site-scaled cross-check when both target sites and cps available
    if (targetSites != null && targetSites > 0 && cpsList.length) {
      const cpsMed = percentile(cpsList, 0.5);
      if (cpsMed != null) {
        tiers.siteScaledCheck = {
          moderateServiceFeesFromSites: roundMoney(cpsMed * targetSites),
          medianCostPerSite: roundMoney(cpsMed),
          note: "Cross-check only — patient-scaled tiers above are primary for RFP ballparks"
        };
      }
    }
  }

  return {
    source: "past_bid_pricing",
    scenario: {
      indication: indication || null,
      enrolledSubjects: targetN,
      coreSites: targetSites,
      aliasesUsed: aliases.slice(0, 8)
    },
    comparableCount: withCpp.length,
    studiesWithCostPerPatient: cppList.length,
    costPerPatient: {
      p25: p25 != null ? roundMoney(p25) : null,
      median: p50 != null ? roundMoney(p50) : null,
      p75: p75 != null ? roundMoney(p75) : null
    },
    rawFeeDistribution: {
      p25: feeList.length ? roundMoney(percentile(feeList, 0.25)) : null,
      median: feeList.length ? roundMoney(percentile(feeList, 0.5)) : null,
      p75: feeList.length ? roundMoney(percentile(feeList, 0.75)) : null
    },
    tiers,
    exampleComparables: withCpp
      .slice()
      .sort((a, b) => (b.costPerPatient || 0) - (a.costPerPatient || 0))
      .slice(0, 8),
    rules: [
      "Primary dollars = Ora past uploaded bids (Exec Sum service fees), NOT TrialHub/CT.gov.",
      "Tiers scale median/P25/P75 cost-per-patient to the requested N.",
      "Pass-throughs are excluded from the primary serviceFees tiers unless only grandTotal exists on a comparable.",
      "This is a ballpark for RFP discussion — not a formal bid or GM target.",
      "If comparableCount is low, say so and widen the range / ask for phase or geography."
    ]
  };
}

module.exports = {
  isPricingQuestion,
  extractRfpScenarioFromQuestion,
  buildRfpPricingPack
};
