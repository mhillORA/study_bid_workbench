/**
 * Ora Clinical Intelligence — Cosmos reference tables (Veeva live + TrialHub + CT.gov).
 * Buddy feasibility uses ora_veeva_* (+ milestone PSM). ora_fact_* kept but not queried.
 *
 * Containers: ora_veeva_*, ora_trialhub_trials, ora_sponsor_crosswalk, ora_ctgov_trials, …
 * See docs/ora-intelligence.md
 */

const DATASET = "ora_clinical_intelligence";

/** Synonym groups — used to expand search aliases. Matched label is kept as-is (not remapped to group[0]). */
const INDICATION_GROUPS = [
  [
    "Dry Eye",
    "Dry Eye Disease",
    "DED",
    "Keratoconjunctivitis Sicca"
  ],
  ["Devices-Dry Eye", "Devices - Dry Eye"],
  ["Cataract", "Cataracts"],
  ["Diabetic Macular Edema (DME)", "DME", "Diabetic Macular Edema"],
  [
    "Wet AMD",
    "Neovascular (Wet) Age-Related Macular Degeneration",
    "nAMD",
    "Wet Age-Related Macular Degeneration"
  ],
  [
    "Geographic Atrophy / Dry AMD",
    "Geographic Atrophy",
    "Dry AMD",
    "GA",
    "Age-Related Macular Degeneration with Geographic Atrophy"
  ],
  [
    "Glaucoma / Ocular Hypertension",
    "Glaucoma",
    "Primary Open-Angle Glaucoma or Ocular Hypertension",
    "Ocular Hypertension",
    "POAG",
    "OHT"
  ],
  ["Devices - Glaucoma", "Devices-Glaucoma"],
  ["Retinitis Pigmentosa", "RP"],
  ["Presbyopia"],
  ["Allergic Conjunctivitis", "Allergy", "Allergic Conjunctivitis (CAC)", "CAC"],
  ["Eye Redness", "Ocular Redness", "Redness"],
  ["Diabetic Retinopathy", "DR", "Proliferative Diabetic Retinopathy"],
  ["Thyroid Eye Disease", "TED", "Graves Orbitopathy", "Graves' Ophthalmopathy"],
  ["Myopia", "Pathologic Myopia", "Myopic CNV"],
  ["Blepharitis", "Demodex Blepharitis"],
  [
    "Neuroprotection",
    "Optic Nerve Neuroprotection",
    "Retinal Neuroprotection",
    "Glaucoma Neuroprotection",
    "Neuroprotective"
  ],
  [
    "Optic Neuropathy",
    "Optic neuropathies",
    "Optic neuropathies POAG and NAION"
  ],
  ["Optic Neuritis"],
  ["NAION"],
  [
    "LHON",
    "Leber Hereditary Optic Neuropathy",
    "New: Leber Hereditary Optic Disease"
  ],
  ["New: Optic Neuromyelitis Spectrum Disease"],
  ["Uveitis", "Anterior Uveitis", "Intermediate Uveitis", "Posterior Uveitis", "Panuveitis"],
  ["Keratoconus"],
  [
    "Retinal Vein Occlusion",
    "RVO",
    "Macular Edema due to Retinal Vein Occlusion (RVO)",
    "Macular Edema due to Retinal Vein Occlusion",
    "Retinal Vascular Diseases"
  ],
  ["Central Retinal Vein Occlusion", "CRVO"],
  ["Branch Retinal Vein Occlusion", "BRVO"],
  ["Neurotrophic Keratitis", "Neurotrophic Keratopathy"],
  ["Meibomian Gland Dysfunction", "MGD"],
  [
    "Stargardt's Disease",
    "Stargardt",
    "Stargardt Disease",
    "Stargardt's",
    "Stargardt's Macular Dystrophy",
    "Stargardt Macular Dystrophy",
    "STGD1",
    "Stargardt Disease Type 1"
  ],
  ["Inherited Retinal Disease", "IRD"],
  [
    "Leber Congenital Amaurosis",
    "Leber congenital amaurosis",
    "LCA"
  ],
  ["Choroideremia"],
  ["Achromatopsia"],
  ["Best Disease", "Vitelliform", "Best Vitelliform Macular Dystrophy"],
  ["X-linked Retinoschisis", "Retinoschisis"],
  ["Devices", "Devices-Diagnostic", "Devices - Other"],
  ["Ocular Surface / Cornea", "Corneal Dystrophy"],
  ["Fuchs Endothelial Dystrophy", "Fuchs Dystrophy"],
  ["Infectious Keratitis"],
  ["Macular Hole / ERM", "Macular Hole", "Epiretinal Membrane", "ERM"],
  ["Central Serous Chorioretinopathy", "CSCR", "CSC"],
  ["Amblyopia"],
  ["Strabismus"],
  ["Uveal Melanoma", "Ocular Melanoma", "Choroidal Melanoma"],
  ["Safety", "Safety study"]
];

/** Preferred labels for UI pills (Intelligence + Scorecard). */
const INDICATION_UI_LABELS = [
  "Dry Eye",
  "Glaucoma / Ocular Hypertension",
  "Cataract",
  "Diabetic Macular Edema (DME)",
  "Wet AMD",
  "Geographic Atrophy / Dry AMD",
  "Neuroprotection",
  "Optic Neuropathy",
  "NAION",
  "LHON",
  "Diabetic Retinopathy",
  "Retinal Vein Occlusion",
  "Central Retinal Vein Occlusion",
  "Branch Retinal Vein Occlusion",
  "Retinitis Pigmentosa",
  "Inherited Retinal Disease",
  "Stargardt's Disease",
  "Leber Congenital Amaurosis",
  "Choroideremia",
  "Achromatopsia",
  "Uveitis",
  "Presbyopia",
  "Allergic Conjunctivitis",
  "Myopia",
  "Thyroid Eye Disease",
  "Blepharitis",
  "Meibomian Gland Dysfunction",
  "Neurotrophic Keratitis",
  "Keratoconus",
  "Ocular Surface / Cornea",
  "Macular Hole / ERM",
  "Central Serous Chorioretinopathy",
  "Amblyopia",
  "Strabismus",
  "Uveal Melanoma",
  "Eye Redness"
];

function normText(s) {
  return String(s || "")
    .toLowerCase()
    // Collapse possessives so Stargardt's ≈ stargardt
    .replace(/['’]s\b/g, "s")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compactNorm(s) {
  return normText(s).replace(/\s+/g, "");
}

/**
 * Token-bounded phrase match (after normText).
 * "dry eye" matches "severe dry eye disease"; "dry" does NOT match "dry eye" or "dry amd".
 */
function phraseIncludes(haystack, needle) {
  const h = normText(haystack);
  const n = normText(needle);
  if (!h || !n) return false;
  if (h === n) return true;
  return ` ${h} `.includes(` ${n} `);
}

/**
 * Shared words that belong to many indications — never use alone to pick a family.
 * Exclusive matching: one request → one INDICATION_GROUPS row only.
 */
const AMBIGUOUS_INDICATION_TOKENS = new Set([
  "dry",
  "amd",
  "eye",
  "ocular",
  "macular",
  "retinal",
  "optic",
  "vein",
  "edema",
  "disease",
  "syndrome",
  "disorder",
  "age",
  "related",
  "degeneration",
  "neuropathy",
  "neuritis",
  "surface",
  "cornea",
  "corneal",
  "primary",
  "open",
  "angle",
  "vascular",
  "inherited",
  "congenital"
]);

function familyIdForGroup(groupIndex) {
  const group = INDICATION_GROUPS[groupIndex];
  if (!group || !group.length) return null;
  return `g${groupIndex}:${normText(group[0]).slice(0, 40)}`;
}

/**
 * Resolve to exactly ONE indication group (exclusive).
 * Match rules (no reverse substring — that caused Glaucoma → Glaucoma Neuroprotection):
 *  1) exact norm equality with a group label
 *  2) short code (≤3 chars) only when the whole query IS that code
 *  3) query contains the full label as a token phrase (longest label wins)
 * Never assign two groups. Never expand across groups.
 */
function resolveIndicationGroup(raw) {
  const requested = String(raw || "").trim();
  if (!requested) return null;
  const n = normText(requested);
  if (!n) return null;
  if (AMBIGUOUS_INDICATION_TOKENS.has(n)) return null;

  // Vault indication picklist API names: dry_eye__c → dry eye; devicesdry_eye__c → devicesdry eye
  const fromPicklist = normText(
    String(requested)
      .replace(/__/g, " ")
      .replace(/_/g, " ")
      .replace(/\s+c$/i, "")
  );
  const compact = compactNorm(requested.replace(/__/g, " ").replace(/_/g, " ").replace(/\s+c$/i, ""));

  let best = null; // { index, score, matchedLabel }

  for (let i = 0; i < INDICATION_GROUPS.length; i++) {
    const group = INDICATION_GROUPS[i];
    for (const label of group) {
      const ng = normText(label);
      if (!ng) continue;
      const lc = compactNorm(label);
      let score = 0;
      if (ng === n || (fromPicklist && ng === fromPicklist)) {
        score = 10000 + ng.length;
      } else if (lc && compact && lc === compact && lc.length >= 6) {
        // devicesdryeye ↔ Devices-Dry Eye (Vault often drops separators)
        score = 9500 + lc.length;
      } else if (ng.length <= 3) {
        // Short codes ONLY when the whole query IS that code (DED, GA, RP, …)
        if (n === ng || fromPicklist === ng) score = 9000 + ng.length;
        else continue;
      } else if (phraseIncludes(n, ng) || (fromPicklist && phraseIncludes(fromPicklist, ng))) {
        score = 8000 + ng.length;
      } else {
        continue;
      }
      if (!best || score > best.score) {
        best = { index: i, score, matchedLabel: label };
      }
    }
  }

  if (!best) return null;
  const group = INDICATION_GROUPS[best.index];
  return {
    index: best.index,
    family: familyIdForGroup(best.index),
    matchedLabel: best.matchedLabel,
    // Always surface the UI/canonical group head for Vault picklist → Buddy
    preferred: group[0],
    labels: [...group]
  };
}

function indicationFamily(raw) {
  const resolved = resolveIndicationGroup(raw);
  if (resolved) return resolved.family;
  const n = normText(raw);
  return n ? `other:${n.slice(0, 40)}` : null;
}

function indicationAliases(raw) {
  if (!raw) return [];
  const requested = String(raw).trim();
  const resolved = resolveIndicationGroup(requested);
  if (!resolved) {
    // Unknown free-text — do not invent sister indications
    return requested ? [requested] : [];
  }
  // Exclusive: synonyms from THIS group only
  const out = new Set([requested, ...resolved.labels]);
  return [...out];
}

/**
 * Vault study__v "Indication" picklist (indication__v) → canonical Buddy label.
 * dry_eye__c → Dry Eye; devicesdry_eye__c → Devices-Dry Eye.
 */
function canonicalIndicationFromVaultPicklist(raw) {
  if (raw == null) return "_unknown";
  let s = raw;
  if (Array.isArray(s)) s = s[0];
  if (s && typeof s === "object") {
    s = s.name__v || s.label || s.value || s.n || null;
  }
  s = String(s || "").trim();
  if (!s) return "_unknown";
  const resolved = resolveIndicationGroup(s);
  if (resolved?.preferred) return resolved.preferred;
  // Humanize leftover API names
  const human = s
    .replace(/__/g, " ")
    .replace(/_/g, " ")
    .replace(/\s+c$/i, "")
    .trim();
  if (!human) return "_unknown";
  const titled = human.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
  return titled || "_unknown";
}

/** Exact-match aliases including Vault picklist spellings + lowercase partitions. */
function indicationQueryAliases(raw) {
  const base = indicationAliases(raw);
  const out = new Set(base);
  for (const a of base) {
    const n = normText(a);
    if (!n) continue;
    out.add(n);
    out.add(n.replace(/\s+/g, "_"));
    out.add(`${n.replace(/\s+/g, "_")}__c`);
    const compact = compactNorm(a);
    if (compact && compact.length >= 4) out.add(compact);
  }
  // Also accept the raw Vault picklist form of the preferred label
  const preferred = resolveIndicationGroup(raw)?.preferred;
  if (preferred) {
    const slug = normText(preferred).replace(/\s+/g, "_");
    out.add(`${slug}__c`);
  }
  return [...out].filter(Boolean);
}

/** True when a Cosmos/Veeva indication string belongs with the requested indication family only. */
function indicationCompatible(rowIndication, requestedIndication, aliases = []) {
  const ri = String(rowIndication || "").trim();
  const req = String(requestedIndication || "").trim();
  if (!ri || !req) return false;
  const reqResolved = resolveIndicationGroup(req);
  const rowResolved = resolveIndicationGroup(ri);

  // Both known: must be the same exclusive group
  if (reqResolved && rowResolved) {
    return reqResolved.index === rowResolved.index;
  }

  // Requested known, row free-text: accept only if row phrase-matches a synonym from that one group
  if (reqResolved && !rowResolved) {
    return reqResolved.labels.some(
      (a) => normText(a) === normText(ri) || phraseIncludes(ri, a)
    );
  }

  // Fallback: exact / phrase against provided aliases, but never if aliases span multiple groups
  const aliasList = (aliases && aliases.length ? aliases : indicationAliases(req)).map(String);
  const fams = new Set(
    aliasList.map((a) => resolveIndicationGroup(a)?.index).filter((x) => x != null)
  );
  if (fams.size > 1) return false;
  const riN = normText(ri);
  return aliasList.some((a) => {
    const na = normText(a);
    if (!na || na.length < 4) return na && na === riN;
    return na === riN || phraseIncludes(ri, a);
  });
}

/**
 * Related labels for narrative only — NEVER merge into primary Cosmos queries.
 * Exclusive indication matching forbids cross-group coverage.
 */
function relatedIndicationLabels(_indication) {
  return [];
}

function isCtgovQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  return (
    /\b(clinical\s*trials?\.?\s*gov|clinicaltrials|ct\s*\.?\s*gov|ctgov|ct\-gov)\b/.test(q) ||
    /\b(registry|public registry)\b.{0,50}\b(trial|study|ophthalm|ocular|eye|dashboard|data|overview|feed)\b/.test(q) ||
    /\b(dashboard|overview|landscape|feed|data)\b.{0,40}\b(registry|clinical\s*trials?)\b/.test(q) ||
    /\b(ophthalm|ocular|eye)\b.{0,40}\b(registry|clinical\s*trials?)\b/.test(q) ||
    /\b(dashboard|overview|landscape)\b.{0,40}\b(ct\s*\.?\s*gov|ctgov|registry|clinical\s*trials?)\b/.test(q)
  );
}

function isTrialhubQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  return (
    /\btrial\s*hub\b/.test(q) ||
    /\btrialhub\b/.test(q) ||
    /\btrialhuh\b/.test(q) ||
    /\btrial\s*hu[h\b]\b/.test(q) ||
    /\btrial[-_]?hub\b/.test(q) ||
    /\btrialhub\.com\b/.test(q) ||
    /\bwww\.trialhub\b/.test(q) ||
    /\bfrom\s+trial\s*hu/i.test(q) ||
    /\bindustry\s+(benchmark|trial|psm|landscape|dashboard|data|feed)\b/.test(q) ||
    /\b(competitive|industry)\s+(database|landscape|feed)\b/.test(q) ||
    /\b(dashboard|overview|landscape|data|feed)\b.{0,40}\b(trial\s*hub|trialhub|trialhuh|industry)\b/.test(q)
  );
}

function isVeevaQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  return (
    /\bveeva\b/.test(q) ||
    /\bora\s+(histor(?:y|ical)|performance|veeva|fact[_ ]?stud|fact[_ ]?site)\b/.test(q) ||
    /\b(ora_fact_study|ora_fact_site|fact_study|fact_site)\b/.test(q) ||
    /\b(dashboard|overview|landscape)\b.{0,40}\b(veeva|ora\s+histor|ora\s+performance|ora\s+sites?)\b/.test(q) ||
    /\b(veeva|ora\s+histor|ora\s+sites?)\b.{0,40}\b(dashboard|overview|data|feed)\b/.test(q)
  );
}

function isCrosswalkQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  return (
    /\b(crosswalk|sponsor\s+crosswalk|sf\s+match|salesforce)\b/.test(q) ||
    /\b(no_sf_match|confirmed_new|previously_confirmed|in_sf_inactive)\b/.test(q) ||
    /\b(sf\s+(account|owner|tier)|salesforce\s+(account|owner|tier))\b/.test(q) ||
    /\b(who|whose|owner|owns)\b.{0,50}\b(sf|salesforce|account)\b/.test(q) ||
    /\b(bd\s+owner|account\s+owner|sf\s+owner)\b/.test(q) ||
    /\b(tier)\b.{0,40}\b(sf|salesforce|sponsor|client|account)\b/.test(q) ||
    /\b(which|what)\b.{0,40}\b(sponsors?|clients?)\b.{0,40}\b(sf|salesforce|crosswalk)\b/.test(q)
  );
}

function isSourceOverviewQuestion(question) {
  return (
    isCtgovQuestion(question) ||
    isTrialhubQuestion(question) ||
    isVeevaQuestion(question) ||
    isCrosswalkQuestion(question)
  );
}

/** Year cue for TrialHub actual_start / CT.gov startDate — not portfolio budget year alone. */
function extractYearFromQuestion(question) {
  const q = String(question || "");
  if (/\blast\s+year\b/i.test(q)) return new Date().getFullYear() - 1;
  if (/\bthis\s+year\b/i.test(q)) return new Date().getFullYear();
  const ym = q.match(
    /\b(?:in|for|during|year|fy|calendar\s+year|cy|started(?:\s+in)?)\s*(20\d{2})\b|\b(20\d{2})\s+(?:studies|trials|bids?|budgets?|portfolio|ingest|uploads?|started)\b|\byear\s*[=:]\s*(20\d{2})\b|\bstarted\s+(?:in\s+)?(20\d{2})\b/i
  );
  if (ym) return Number(ym[1] || ym[2] || ym[3] || ym[4]);
  return null;
}

function yearFromActualStart(raw) {
  if (raw == null || raw === "") return null;
  // Excel serial date (days since 1899-12-30)
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 20000 && raw < 80000) {
    const d = new Date(Math.round((raw - 25569) * 86400 * 1000));
    const y = d.getUTCFullYear();
    return y >= 1990 && y <= 2100 ? y : null;
  }
  const s = String(raw).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/]/);
  if (m) return Number(m[1]);
  m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return Number(m[3]);
  m = s.match(/(\d{4})$/);
  if (m && m[1].startsWith("20")) return Number(m[1]);
  m = s.match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

/** Service-line filters for TrialHub (broader than exclusive indication groups). */
const TRIALHUB_THERAPEUTIC_FILTERS = {
  retina: {
    label: "Retina / posterior segment",
    phrases: [
      "retina",
      "retinal",
      "macular",
      "amd",
      "geographic atrophy",
      "dme",
      "diabetic macular",
      "diabetic retinopathy",
      "vein occlusion",
      "crvo",
      "brvo",
      "rvo",
      "stargardt",
      "inherited retinal",
      "leber congenital",
      "choroideremia",
      "achromatopsia",
      "retinoschisis",
      "retinitis pigmentosa",
      "uveitis",
      "macular hole",
      "epiretinal",
      "central serous",
      "myopic cnv",
      "uveal melanoma",
      "vitelliform",
      "cscr"
    ]
  }
};

function extractTherapeuticFilterFromQuestion(question) {
  const q = normText(question);
  if (!q) return null;
  if (/\bretina\b|\bretinal\b|\bposterior segment\b/.test(q)) return "retina";
  return null;
}

function trialhubMatchesTherapeuticFilter(trial, filterKey) {
  const filter = TRIALHUB_THERAPEUTIC_FILTERS[filterKey];
  if (!filter) return true;
  const blob = normText(
    `${trial.indication || ""} ${trial.indications || ""} ${trial.primary_raw || ""} ${trial.title || ""}`
  );
  if (!blob) return false;
  return filter.phrases.some((p) => {
    const np = normText(p);
    if (!np) return false;
    if (np.length <= 3) return ` ${blob} `.includes(` ${np} `);
    return phraseIncludes(blob, np);
  });
}

/** Count TrialHub trials whose actual_start falls in calendar year (Actual Start Date column). */
async function trialhubStartedTrialsQuery(database, opts = {}) {
  const year = opts.year != null ? Number(opts.year) : null;
  const therapeuticFilter = opts.therapeuticFilter || null;
  // List asks need room — compact rows; hard cap 500 to keep prompts usable
  const maxTrials = Math.min(Math.max(Number(opts.maxTrials) || 150, 1), 500);
  if (year != null && (year < 2000 || year > 2100)) return null;
  try {
    const container = database.container("ora_trialhub_trials");
    // Prefer year-prefixed ISO dates in Cosmos (fast path); fall back to full scan for other formats
    let rows = [];
    if (year) {
      const y = String(year);
      rows = await queryAll(
        container,
        `SELECT c.nct, c.title, c.sponsor, c.indication, c.indications, c.primary_raw, c.status,
                c.phase, c.patients, c.actual_start
         FROM c WHERE c.docType = @t AND IS_DEFINED(c.actual_start) AND c.actual_start != null
           AND (
             STARTSWITH(c.actual_start, @y)
             OR CONTAINS(c.actual_start, @ySlash, true)
             OR CONTAINS(c.actual_start, @yDash, true)
           )`,
        [
          { name: "@t", value: "ora_trialhub_trials" },
          { name: "@y", value: y },
          { name: "@ySlash", value: `/${y}` },
          { name: "@yDash", value: `-${y}` }
        ]
      );
    }
    if (!rows.length) {
      rows = await queryAll(
        container,
        `SELECT c.nct, c.title, c.sponsor, c.indication, c.indications, c.primary_raw, c.status,
                c.phase, c.patients, c.actual_start
         FROM c WHERE c.docType = @t AND IS_DEFINED(c.actual_start) AND c.actual_start != null`,
        [{ name: "@t", value: "ora_trialhub_trials" }]
      );
    }
    const trials = [];
    for (const r of rows) {
      if (year != null && yearFromActualStart(r.actual_start) !== year) continue;
      if (therapeuticFilter && !trialhubMatchesTherapeuticFilter(r, therapeuticFilter)) continue;
      trials.push({
        nct: r.nct,
        title: String(r.title || "").slice(0, 90) || null,
        sponsor: r.sponsor,
        indication: r.indication,
        status: r.status,
        phase: r.phase,
        patients: r.patients,
        actual_start: r.actual_start
      });
    }
    trials.sort((a, b) => String(a.actual_start || "").localeCompare(String(b.actual_start || "")));
    const filterLabel = therapeuticFilter
      ? TRIALHUB_THERAPEUTIC_FILTERS[therapeuticFilter]?.label || therapeuticFilter
      : null;
    const listed = trials.slice(0, maxTrials);
    return {
      year,
      therapeuticFilter,
      therapeuticFilterLabel: filterLabel,
      startedCount: trials.length,
      listedCount: listed.length,
      trialsWithActualStart: rows.length,
      trials: listed,
      truncated: trials.length > maxTrials,
      field: "actual_start",
      note:
        trials.length > maxTrials
          ? `COMPLETE COUNT = startedCount (${trials.length}). Listed ${listed.length} of ${trials.length} in trials[]. Say "showing ${listed.length} of ${trials.length}" — NEVER say data was cut off, unread, or incomplete in Cosmos.`
          : `COMPLETE LIST for this filter — startedCount ${trials.length} = listedCount. Enumerate every row. NEVER say records were cut off or unread.`
    };
  } catch (err) {
    return {
      year,
      therapeuticFilter,
      error: String(err.message || err),
      startedCount: null,
      trials: []
    };
  }
}

/** @deprecated use trialhubStartedTrialsQuery */
async function trialhubStartsInYearStats(database, year) {
  return trialhubStartedTrialsQuery(database, { year, maxTrials: 25 });
}

function isSalesforceDataQuestion(question) {
  try {
    const { isSalesforceDataQuestion: fn } = require("./salesforceTables");
    return fn(question);
  } catch (_) {
    const q = String(question || "").toLowerCase();
    return /\b(salesforce|\bsf\b|opportunit|activity request|\bars?\b|ora grouping)\b/.test(q);
  }
}

function isIntelligenceQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  return (
    isSourceOverviewQuestion(q) ||
    isSalesforceDataQuestion(q) ||
    /\b(psm|patients?\s*per\s*site|pts?\s*\/\s*site|enrollment rate|enrolment rate)\b/.test(q) ||
    /\b(feasibility|site (mix|selection|performance|capacity)|competing trials?|competitor|competitive landscape)\b/.test(
      q
    ) ||
    /\b(win\s+themes?|meeting\s+prep|call\s+prep|why\s+ora|talking\s+points?)\b/.test(q) ||
    /\b(which|best|top|recommend(?:ed)?|list|name|suggest)\b.{0,40}\b(sites?|countries|country)\b/.test(q) ||
    /\b(sites?|countries)\b.{0,40}\b(for|in|with|under|outside|ous)\b/.test(q) ||
    /\b(preferred|high[- ]performing|perform(?:ing)?)\s+sites?\b/.test(q) ||
    /\bnct\d*\b/.test(q) ||
    /\b(screen[- ]?fail|dropout|recruit(ment)? (rate|days|benchmark))\b/.test(q) ||
    /\b(indication).{0,40}\b(benchmark|histor(y|ical)|industry|ora studies)\b/.test(q) ||
    /\b(how (fast|quickly)|typical).{0,40}\b(enroll|recruit|site)\b/.test(q) ||
    /\b(country|countries|region|geography|united states|usa|uk|europe|eu|japan|china|canada|australia|ous|outside)\b/.test(
      q
    ) ||
    /\b(rfp|rfi|pricing|ballpark|goal bid|cost per patient)\b/.test(q) ||
    /\b\d+\s*(patients?|sites?|months?)\b/.test(q) ||
    /\b(protocol|punctal|dry\s*eye|device\s+study)\b/.test(q) ||
    (/\b(studies|trials)\b/.test(q) &&
      /\b(started|starting|began|start date)\b/.test(q) &&
      Boolean(extractYearFromQuestion(q))) ||
    (/\b(trialhub|trialhuh|trial\s*hu)\b/.test(q) && /\b(studies|trials)\b/.test(q))
  );
}

/** Country / region aliases for site + CT.gov geography filters. */
const COUNTRY_ALIASES = {
  us: "United States",
  usa: "United States",
  "u s": "United States",
  "u s a": "United States",
  "united states": "United States",
  "united states of america": "United States",
  america: "United States",
  uk: "United Kingdom",
  gb: "United Kingdom",
  gbr: "United Kingdom",
  "u k": "United Kingdom",
  "united kingdom": "United Kingdom",
  britain: "United Kingdom",
  "great britain": "United Kingdom",
  england: "United Kingdom",
  ca: "Canada",
  can: "Canada",
  canada: "Canada",
  mx: "Mexico",
  mex: "Mexico",
  mexico: "Mexico",
  de: "Germany",
  deu: "Germany",
  deutschland: "Germany",
  germany: "Germany",
  fr: "France",
  fra: "France",
  france: "France",
  es: "Spain",
  esp: "Spain",
  spain: "Spain",
  it: "Italy",
  ita: "Italy",
  italy: "Italy",
  pt: "Portugal",
  prt: "Portugal",
  portugal: "Portugal",
  nl: "Netherlands",
  nld: "Netherlands",
  netherlands: "Netherlands",
  holland: "Netherlands",
  be: "Belgium",
  bel: "Belgium",
  belgium: "Belgium",
  ch: "Switzerland",
  che: "Switzerland",
  switzerland: "Switzerland",
  at: "Austria",
  aut: "Austria",
  austria: "Austria",
  pl: "Poland",
  pol: "Poland",
  poland: "Poland",
  cz: "Czechia",
  cze: "Czechia",
  czechia: "Czechia",
  "czech republic": "Czechia",
  sk: "Slovakia",
  svk: "Slovakia",
  slovakia: "Slovakia",
  hu: "Hungary",
  hun: "Hungary",
  hungary: "Hungary",
  ro: "Romania",
  rou: "Romania",
  romania: "Romania",
  bg: "Bulgaria",
  bgr: "Bulgaria",
  bulgaria: "Bulgaria",
  gr: "Greece",
  grc: "Greece",
  greece: "Greece",
  se: "Sweden",
  swe: "Sweden",
  sweden: "Sweden",
  no: "Norway",
  nor: "Norway",
  norway: "Norway",
  dk: "Denmark",
  dnk: "Denmark",
  denmark: "Denmark",
  fi: "Finland",
  fin: "Finland",
  finland: "Finland",
  ie: "Ireland",
  irl: "Ireland",
  ireland: "Ireland",
  tr: "Turkey",
  tur: "Turkey",
  turkey: "Turkey",
  turkiye: "Turkey",
  "türkiye": "Turkey",
  ru: "Russia",
  rus: "Russia",
  russia: "Russia",
  "russian federation": "Russia",
  ua: "Ukraine",
  ukr: "Ukraine",
  ukraine: "Ukraine",
  il: "Israel",
  isr: "Israel",
  israel: "Israel",
  sa: "Saudi Arabia",
  sau: "Saudi Arabia",
  "saudi arabia": "Saudi Arabia",
  ae: "United Arab Emirates",
  are: "United Arab Emirates",
  uae: "United Arab Emirates",
  "united arab emirates": "United Arab Emirates",
  eg: "Egypt",
  egy: "Egypt",
  egypt: "Egypt",
  za: "South Africa",
  zaf: "South Africa",
  "south africa": "South Africa",
  ng: "Nigeria",
  nga: "Nigeria",
  nigeria: "Nigeria",
  ke: "Kenya",
  ken: "Kenya",
  kenya: "Kenya",
  jp: "Japan",
  jpn: "Japan",
  japan: "Japan",
  cn: "China",
  chn: "China",
  prc: "China",
  china: "China",
  hk: "Hong Kong",
  hkg: "Hong Kong",
  "hong kong": "Hong Kong",
  tw: "Taiwan",
  twn: "Taiwan",
  taiwan: "Taiwan",
  kr: "Korea, Republic of",
  kor: "Korea, Republic of",
  korea: "Korea, Republic of",
  "south korea": "Korea, Republic of",
  "republic of korea": "Korea, Republic of",
  in: "India",
  ind: "India",
  india: "India",
  pk: "Pakistan",
  pak: "Pakistan",
  pakistan: "Pakistan",
  bd: "Bangladesh",
  bgd: "Bangladesh",
  bangladesh: "Bangladesh",
  th: "Thailand",
  tha: "Thailand",
  thailand: "Thailand",
  vn: "Vietnam",
  vnm: "Vietnam",
  vietnam: "Vietnam",
  "viet nam": "Vietnam",
  sg: "Singapore",
  sgp: "Singapore",
  singapore: "Singapore",
  my: "Malaysia",
  mys: "Malaysia",
  malaysia: "Malaysia",
  id: "Indonesia",
  idn: "Indonesia",
  indonesia: "Indonesia",
  ph: "Philippines",
  phl: "Philippines",
  philippines: "Philippines",
  au: "Australia",
  aus: "Australia",
  australia: "Australia",
  nz: "New Zealand",
  nzl: "New Zealand",
  "new zealand": "New Zealand",
  br: "Brazil",
  bra: "Brazil",
  brazil: "Brazil",
  ar: "Argentina",
  arg: "Argentina",
  argentina: "Argentina",
  cl: "Chile",
  chl: "Chile",
  chile: "Chile",
  co: "Colombia",
  col: "Colombia",
  colombia: "Colombia",
  pe: "Peru",
  per: "Peru",
  peru: "Peru",
  pr: "Puerto Rico",
  pri: "Puerto Rico",
  "puerto rico": "Puerto Rico"
};

function countryKey(raw) {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\./g, "")
    .replace(/['’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isGlobalCountryToken(raw) {
  const k = countryKey(raw);
  return k === "global" || k === "worldwide" || k === "world" || k === "all countries" || k === "all";
}

function normalizeCountryName(raw) {
  if (!raw) return null;
  if (isGlobalCountryToken(raw)) return null;
  const key = countryKey(raw);
  if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key];
  // Title-case leftover
  return String(raw)
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Parse country filter from query/body.
 * Returns null for Global / empty (no geo filter), or unique canonical names[].
 */
function parseCountryFilter(input) {
  if (input == null || input === false) return null;
  if (typeof input === "boolean" && input) return null; // global:true
  const parts = Array.isArray(input)
    ? input
    : String(input)
        .split(/[,|;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((p) => isGlobalCountryToken(p))) return null;
  const out = [];
  for (const p of parts) {
    const n = normalizeCountryName(p);
    if (n && !out.includes(n)) out.push(n);
  }
  return out.length ? out : null;
}

/** Short ISO/alias codes that collide with English stopwords — only match with geo cues. */
const AMBIGUOUS_COUNTRY_KEYS = new Set([
  "in", // India vs "in our feed"
  "us", // United States vs "tell us"
  "is", // Iceland vs "is there"
  "no", // Norway vs "no data"
  "at", // Austria vs "at sites"
  "be", // Belgium vs "be careful"
  "id", // Indonesia vs "id"
  "me", // Montenegro
  "to", // Tonga
  "do", // Dominican Republic
  "so", // Somalia
  "as", // American Samoa
  "by", // Belarus
  "or", // "or"
  "an", // Netherlands Antilles-ish
  "it", // Italy vs "it"
  "on", // Ontario-ish
  "if",
  "am", // Armenia
  "pm",
  "can", // Canada vs "can you"
  "are", // UAE vs "are there"
  "per", // Peru vs "per site"
  "my", // Malaysia vs "my sites"
  "nor", // Norway vs "nor"
  "fin", // Finland vs "fin"
  "pol", // Poland
  "col", // Colombia vs "col"
  "arm", // if present
  "and" // Andorra if present
]);

function extractCountryFromQuestion(question) {
  const q = String(question || "");
  const lower = q.toLowerCase();
  if (/\b(global|worldwide|all countries)\b/.test(lower)) return null;

  // Strip leading "the " so "in the US" / "in the United Kingdom" normalize
  const stripThe = (s) => String(s || "").trim().replace(/^the\s+/i, "").trim();

  // Explicit geo patterns first (safer than bare alias scan)
  const explicit = q.match(
    /\b(?:in|for|across|within|from|country|region|geography|based in)\s+([A-Za-z][A-Za-z .'-]{1,40?}?)(?:\s+for|\s+indication|\s+psm|\s+sites?|\s+trials?|\s+studies?|\?|$|,)/i
  );
  if (explicit) {
    const cand = stripThe(explicit[1]);
    const key = countryKey(cand);
    // Reject English filler after "in/for" (and bare ambiguous ISO codes — "for us", "country is")
    const filler =
      /^(our|the|a|an|this|that|these|those|any|all|my|your|their|its|feed|data|cosmos|question|ask|dashboard|overview|context|veeva|trialhub|ct\.?gov)\b/i.test(
        cand
      );
    if (!filler && !AMBIGUOUS_COUNTRY_KEYS.has(key)) {
      if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key];
      // Free-text country names (Germany, Japan, …) — require length so "in data" does not invent
      if (key.length >= 4) {
        const n = normalizeCountryName(cand);
        if (n && (COUNTRY_ALIASES[countryKey(n)] || key.length >= 4)) {
          // Prefer alias canonical form when known; else title-cased name
          return COUNTRY_ALIASES[countryKey(n)] || n;
        }
      }
    }
  }

  // Longest alias keys first — ambiguous short codes need strong geo cues (not "for us" / "country is")
  const keys = Object.keys(COUNTRY_ALIASES).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (AMBIGUOUS_COUNTRY_KEYS.has(k)) {
      if (k === "us") {
        // Pronoun "us" is extremely common — require "the US" / "US sites" / explicit country=
        if (
          !/\b(?:in|across|within|from|to)\s+the\s+us\b/.test(lower) &&
          !/\b(?:country|region|geography)\s*(?:[=:]\s*|\s+is\s+)?\s*us\b/.test(lower) &&
          !/\bus\s+sites?\b/.test(lower) &&
          !/\bsites?\s+in\s+(?:the\s+)?us\b/.test(lower) &&
          !/\btrials?\s+in\s+(?:the\s+)?us\b/.test(lower) &&
          !/\b(?:located|based)\s+in\s+(?:the\s+)?us\b/.test(lower)
        ) {
          continue;
        }
        return COUNTRY_ALIASES[k];
      }
      if (k === "in") {
        // ISO "IN" (India) — never match English preposition "in"
        if (!/\b(?:country|iso(?:\s*code)?)\s*(?:[=:]\s*|\s+is\s+|code\s+)?in\b/.test(lower)) continue;
        return COUNTRY_ALIASES[k];
      }
      if (k === "is") {
        // Iceland ISO — never match English "is" / "country is Germany"
        if (!/\b(?:country|iso(?:\s*code)?)\s*(?:[=:]\s*|code\s+)is\b/.test(lower)) continue;
        return COUNTRY_ALIASES[k];
      }
      if (k === "can" || k === "are" || k === "per" || k === "my" || k === "nor") {
        // English auxiliaries / "per site" / "my sites" — require country/iso label
        const reAux = new RegExp(
          `(?:country|region|geography|iso(?:\\s*code)?)\\s*(?:[=:]\\s*|\\s+is\\s+|code\\s+)?${k}\\b`,
          "i"
        );
        if (!reAux.test(lower)) continue;
        return COUNTRY_ALIASES[k];
      }
      // Other stopword codes: require country/iso/region label, not bare in/for
      const reAmb = new RegExp(
        `(?:country|region|geography|iso(?:\\s*code)?)\\s*(?:[=:]\\s*|\\s+is\\s+|code\\s+)?${k.replace(/\s+/g, "\\s+")}\\b`,
        "i"
      );
      if (!reAmb.test(lower)) continue;
      return COUNTRY_ALIASES[k];
    }
    if (k.length <= 2) {
      // Other 2-letter codes: require a light geo cue (not pronoun phrases)
      const reShort = new RegExp(
        `(?:country|region|geography|in|across|within)\\s+(?:the\\s+)?${k}\\b`,
        "i"
      );
      if (!reShort.test(lower)) continue;
      return COUNTRY_ALIASES[k];
    }
    if (new RegExp(`\\b${k.replace(/\s+/g, "\\s+")}\\b`, "i").test(lower)) return COUNTRY_ALIASES[k];
  }
  return null;
}

function preferredIndicationLabel(matchedAlias) {
  const raw = String(matchedAlias || "").trim();
  if (!raw) return raw;
  const n = normText(raw);
  for (const group of INDICATION_GROUPS) {
    const hit = group.find((g) => normText(g) === n);
    // Keep the specific matched label (canonical casing) — do NOT remap to group[0]
    if (hit) return hit;
  }
  return raw;
}

function extractIndicationFromQuestion(question) {
  const q = String(question || "");
  const qNorm = normText(q);
  const qCompact = compactNorm(q);
  // Bare "dry" / "amd" alone is ambiguous — do not guess Dry Eye vs Dry AMD
  if (AMBIGUOUS_INDICATION_TOKENS.has(qNorm)) return null;
  // Prefer known labels (longest first); compactNorm so "neuro protection" ≈ Neuroprotection
  // Exclusive: first / longest phrase win — never return a label that would resolve to a different group than intended
  const labeled = INDICATION_GROUPS.flatMap((group, groupIndex) =>
    group.map((label) => ({ label, groupIndex, len: compactNorm(label).length }))
  ).sort((a, b) => b.len - a.len);
  for (const { label, groupIndex } of labeled) {
    const ln = normText(label);
    const lc = compactNorm(label);
    if (!lc || lc.length < 3) continue;
    // Short codes: whole-query only (handled above via resolve) / word boundary when query is exactly that
    if (ln.length <= 3) {
      if (qNorm === ln) return label;
      continue;
    }
    if (phraseIncludes(qNorm, ln) || (lc.length >= 6 && qCompact.includes(lc))) {
      // Guard: resolved group must be this group (no two-group coverage)
      const resolved = resolveIndicationGroup(label);
      if (resolved && resolved.index !== groupIndex) continue;
      return label;
    }
  }
  // Only explicit "indication …" — bare "in …" false-positives (in Cosmos, in the US, in our feed)
  const m = q.match(/\bindication\s*[:=]?\s+([A-Za-z][A-Za-z0-9 /()-]{2,60})/i);
  if (!m) return null;
  const raw = m[1].trim().replace(/[?.!,;]+$/, "");
  if (AMBIGUOUS_INDICATION_TOKENS.has(normText(raw))) return null;
  const preferred = preferredIndicationLabel(raw);
  // Prefer known labels; refuse free-text that looks like filler/geo/source names
  if (preferred && preferred !== raw) return preferred;
  if (
    /^(our|the|a|an|this|cosmos|veeva|trialhub|ct\.?gov|dashboard|overview|global|worldwide)\b/i.test(
      raw
    )
  ) {
    return null;
  }
  return preferred || raw;
}

function parseCountryList(raw) {
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  return String(raw || "")
    .split(/[,|;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isUsCountryName(name) {
  const n = normText(name);
  return n === "united states" || n === "usa" || n === "us" || n === "united states of america";
}

/**
 * Rank countries by how often they appear on TrialHub/CT.gov trial country lists.
 * @param {object[]} trials
 * @param {{ ousOnly?: boolean, limit?: number }} opts
 */
function rankCountriesFromTrials(trials, opts = {}) {
  const ousOnly = Boolean(opts.ousOnly);
  const limit = opts.limit || 12;
  const counts = new Map();
  let trialCount = 0;
  for (const t of trials || []) {
    const list = parseCountryList(t.countries);
    if (!list.length) continue;
    const filtered = ousOnly ? list.filter((c) => !isUsCountryName(c)) : list;
    if (!filtered.length) continue;
    trialCount += 1;
    for (const c of filtered) {
      const key = normalizeCountryName(c) || c;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const ranked = [...counts.entries()]
    .map(([country, trialMentions]) => ({ country, trialMentions }))
    .sort((a, b) => b.trialMentions - a.trialMentions)
    .slice(0, limit);
  return {
    ousOnly,
    trialsWithCountries: trialCount,
    ranked
  };
}

/** Finish enrollment math once patients + months + psm are known. */
function finalizeEnrollmentPlan(plan) {
  const out = { ...(plan || {}) };
  const patients = out.patients;
  const months = out.months;
  const psm = out.psm;
  if (patients && months && psm && psm > 0 && months > 0) {
    const exact = patients / (psm * months);
    out.sitesExact = round(exact, 2);
    out.sitesCeil = Math.ceil(exact);
    out.sitesRecommendedWith20pctBuffer = Math.ceil(exact * 1.2);
    out.patientsPerSiteOverWindow = round(psm * months, 2);
    out.formula = "sites = patients / (psm * months); buffer = ceil(sites * 1.2)";
  }
  return out;
}

/**
 * When the user asks for sites/PSM math but did not state a PSM, fill from
 * Ora site median → Ora study median → TrialHub median so Buddy can calculate.
 */
function enrichEnrollmentPlanWithBenchmark(plan, indicationBenchmark) {
  if (!plan) return null;
  let out = { ...plan };
  if (out.psm == null || !(out.psm > 0)) {
    const siteMed = indicationBenchmark?.sites?.sitePsmMedian;
    const oraMed = indicationBenchmark?.ora?.psmMedian;
    const thMed = indicationBenchmark?.trialhub?.psmMedian;
    if (typeof siteMed === "number" && siteMed > 0) {
      out.psm = siteMed;
      out.psmSource = "ora_site_median";
    } else if (typeof oraMed === "number" && oraMed > 0) {
      out.psm = oraMed;
      out.psmSource = "ora_study_median";
    } else if (typeof thMed === "number" && thMed > 0) {
      out.psm = thMed;
      out.psmSource = "trialhub_median";
    }
  }
  out = finalizeEnrollmentPlan(out);
  return out;
}

/** Parse N patients / months / PSM from a planning question. */
function extractEnrollmentPlan(question) {
  const q = String(question || "");
  let patients = null;
  let months = null;
  let psm = null;
  const pMatch =
    q.match(/\b(\d{1,4})\s*patients?\b/i) ||
    q.match(/\bneed\s+(\d{1,4})\b/i) ||
    q.match(/\b(\d{1,4})\s*(?:pts?|subjects?)\b/i);
  if (pMatch) patients = Number(pMatch[1]);
  if (/\b(?:1|one)\s*year\b/i.test(q) || /\b12\s*months?\b/i.test(q)) months = 12;
  else {
    const yMatch = q.match(/\b(\d+)\s*years?\b/i);
    const mMatch = q.match(/\b(\d+)\s*(?:months?|mos?)\b/i);
    if (yMatch) months = Number(yMatch[1]) * 12;
    else if (mMatch) months = Number(mMatch[1]);
  }
  // Capture .5 / 0.5 / 1.2 — avoid matching the "5" inside ".5"
  const num = String.raw`((?:\d+\.\d+|\.\d+|\d+))`;
  const psmMatch =
    q.match(new RegExp(String.raw`${num}\s*(?:p\s*/\s*s\s*/\s*m|psm)\b`, "i")) ||
    q.match(new RegExp(String.raw`\bassume\s+${num}\b`, "i")) ||
    q.match(new RegExp(String.raw`\bat\s+${num}\s*psm\b`, "i"));
  if (psmMatch) psm = Number(psmMatch[1]);
  return finalizeEnrollmentPlan({ patients, months, psm });
}

/** site_psm = enrolled / months when stored PSM is missing but inputs exist. */
function deriveSitePsm(row) {
  if (typeof row?.site_psm === "number" && !Number.isNaN(row.site_psm)) return row.site_psm;
  const enrolled = Number(row?.total_enrolled);
  const months = Number(row?.site_enroll_months);
  if (!(enrolled >= 0) || !(months > 0)) return null;
  if (enrolled === 0) return 0;
  return round(enrolled / months);
}

function wantsOusOnly(question) {
  const q = String(question || "").toLowerCase();
  return /\b(ous|outside\s+(of\s+)?(the\s+)?u\.?s\.?a?|ex-?us|non-?us|exclud(?:e|ing)\s+(the\s+)?u\.?s|international\s+only|ex-america)\b/.test(
    q
  );
}

/**
 * How many named sites the user wants listed (e.g. "top 40 sites", "give me 40").
 * Default null = use feasibility default cap in callers.
 */
function extractSiteListLimit(question) {
  const q = String(question || "");
  const m =
    q.match(/\b(?:top|list|give\s+me|show\s+me|need|want|recommend(?:ed)?)\s+(\d{1,3})\s+sites?\b/i) ||
    q.match(/\b(\d{1,3})\s+sites?\b/i) ||
    q.match(/\bsite\s+(?:list|slate|leaderboard)\s+(?:of\s+)?(\d{1,3})\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return null;
  // Hard ceiling so context stays bounded
  return Math.min(80, Math.max(5, Math.floor(n)));
}

/** Substring needles for fuzzy Cosmos — ONLY phrases from the resolved exclusive group. */
function indicationContainsNeedles(indication) {
  const resolved = resolveIndicationGroup(indication);
  const preferred =
    (resolved && resolved.preferred) ||
    preferredIndicationLabel(indication) ||
    String(indication || "").trim();
  const needles = new Set();
  const labels = resolved ? resolved.labels : preferred ? [preferred] : [];
  for (const label of labels) {
    const ln = normText(label);
    if (!ln || ln.length < 4) continue;
    if (AMBIGUOUS_INDICATION_TOKENS.has(ln)) continue;
    needles.add(ln);
  }
  const pn = normText(preferred);
  if (pn.length >= 4 && !AMBIGUOUS_INDICATION_TOKENS.has(pn)) needles.add(pn);
  return [...needles]
    .filter((x) => {
      const t = normText(x);
      return t.length >= 4 && !AMBIGUOUS_INDICATION_TOKENS.has(t);
    })
    .slice(0, 8);
}

function countriesMatch(rawCountries, countryNorm) {
  if (!countryNorm) return true;
  const list = Array.isArray(countryNorm) ? countryNorm : [countryNorm];
  if (!list.length) return true;
  const blob = Array.isArray(rawCountries)
    ? rawCountries.join(" | ")
    : String(rawCountries || "");
  if (!blob.trim()) return false;
  const lower = blob.toLowerCase();
  for (const c of list) {
    const needle = String(c).toLowerCase().trim();
    if (!needle) continue;
    if (lower.includes(needle)) return true;
    if (needle === "united states" && /\busa\b|\bu\.?s\.?\b|\bunited states\b/.test(lower)) return true;
    if (needle === "united kingdom" && /\buk\b|\bu\.?k\.?\b|\bunited kingdom\b|\bgreat britain\b/.test(lower)) {
      return true;
    }
    if (needle === "turkey" && /\bturkey\b|\btürkiye\b|\bturkiye\b/.test(lower)) return true;
    if (needle === "korea, republic of" && /\bkorea\b|\bsouth korea\b/.test(lower)) return true;
  }
  return false;
}

function countrySqlClause(fieldExpr, countries, paramPrefix = "c") {
  if (!countries || !countries.length) return { sql: "", params: [] };
  if (countries.length === 1) {
    return {
      sql: ` AND ${fieldExpr} = @${paramPrefix}0`,
      params: [{ name: `@${paramPrefix}0`, value: countries[0] }]
    };
  }
  // ARRAY_CONTAINS(@list, field) → field is one of the selected countries
  return {
    sql: ` AND ARRAY_CONTAINS(@${paramPrefix}List, ${fieldExpr})`,
    params: [{ name: `@${paramPrefix}List`, value: countries }]
  };
}

function ctgovCountrySqlClause(countries, paramPrefix = "cg") {
  if (!countries || !countries.length) return { sql: "", params: [] };
  const parts = [];
  const params = [];
  countries.forEach((c, i) => {
    const name = `@${paramPrefix}${i}`;
    parts.push(`ARRAY_CONTAINS(c.countries, ${name})`);
    params.push({ name, value: c });
  });
  return { sql: ` AND (${parts.join(" OR ")})`, params };
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

const MILESTONE_GAP_KEYS = [
  "selected_to_contract",
  "contract_to_irb",
  "irb_to_siv",
  "siv_to_fsi",
  "contract_to_siv",
  "contract_to_fsi"
];

function trustRank(t) {
  const s = String(t || "").toLowerCase();
  if (s === "high") return 3;
  if (s === "medium") return 2;
  if (s === "low") return 1;
  return 0;
}

/** Median allowing zeros (startup gaps can be 0 days). */
function medianGaps(nums) {
  const a = nums
    .filter((n) => typeof n === "number" && !Number.isNaN(n) && n >= 0 && n <= 730)
    .sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function gapMedianPack(rows) {
  const out = {};
  for (const k of MILESTONE_GAP_KEYS) {
    const vals = rows
      .map((r) => r.gaps_days?.[k])
      .filter((n) => typeof n === "number" && !Number.isNaN(n) && n >= 0 && n <= 730);
    out[k] = round(medianGaps(vals), 1);
    out[`${k}_n`] = vals.length;
  }
  return out;
}

/**
 * Startup gap medians from live ora_veeva_milestone (FSI/SIV/contract/IRB/selected).
 * Does not use Excel Site Level packs or ora_fact_*.
 */
async function queryStartupTimelines(
  database,
  { countries = null, orgNames = [], studyNames = [] } = {}
) {
  try {
    const { loadVeevaStartupGapRows } = require("./veevaLiveIntel");
    let rows = await loadVeevaStartupGapRows(database);
    rows = rows.filter(
      (r) =>
        (r.activity_2023_plus !== false) &&
        !r.outlier_gap_gt_730
    );
    const sourceUsed = "ora_veeva_milestone";

    let universe = rows;
    if (countries) {
      universe = universe.filter((r) => countriesMatch(r.country, countries));
    }

    const orgNeedles = orgNames
      .map((o) => String(o || "").trim().toLowerCase())
      .filter((o) => o.length >= 3);
    const studySet = new Set(
      studyNames.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean)
    );

    let scoped = universe;
    if (orgNeedles.length || studySet.size) {
      const matched = universe.filter((r) => {
        const org = String(r.organization || "").toLowerCase();
        const study = String(r.study_name || "").toLowerCase();
        if (studySet.size && studySet.has(study)) return true;
        if (orgNeedles.some((n) => org.includes(n) || n.includes(org))) return true;
        return false;
      });
      if (matched.length >= 5) scoped = matched;
    }

    const byOrg = new Map();
    for (const r of scoped) {
      const org = String(r.organization || "").trim();
      if (!org) continue;
      const key = `${org.toLowerCase()}|${String(r.country || "").toLowerCase()}`;
      if (!byOrg.has(key)) {
        byOrg.set(key, {
          organization: org,
          country: r.country || null,
          principal_investigator: r.principal_investigator || null,
          studies: [],
          gaps: []
        });
      }
      const g = byOrg.get(key);
      if (r.study_name) g.studies.push(r.study_name);
      if (r.gaps_days) g.gaps.push(r.gaps_days);
      if (!g.principal_investigator && r.principal_investigator) {
        g.principal_investigator = r.principal_investigator;
      }
    }

    const topSitesByStartup = [...byOrg.values()]
      .map((g) => {
        const contractToFsi = g.gaps
          .map((x) => x.contract_to_fsi)
          .filter((n) => typeof n === "number" && n >= 0 && n <= 730);
        const sivToFsi = g.gaps
          .map((x) => x.siv_to_fsi)
          .filter((n) => typeof n === "number" && n >= 0 && n <= 730);
        return {
          organization: g.organization,
          country: g.country,
          principal_investigator: g.principal_investigator,
          studyCount: new Set(g.studies).size,
          contract_to_fsi_median: round(medianGaps(contractToFsi), 1),
          siv_to_fsi_median: round(medianGaps(sivToFsi), 1),
          n_contract_to_fsi: contractToFsi.length,
          n_siv_to_fsi: sivToFsi.length
        };
      })
      .filter((s) => s.n_contract_to_fsi > 0 || s.n_siv_to_fsi > 0)
      .sort((a, b) => {
        const aa = a.contract_to_fsi_median ?? a.siv_to_fsi_median ?? 9999;
        const bb = b.contract_to_fsi_median ?? b.siv_to_fsi_median ?? 9999;
        return aa - bb;
      })
      .slice(0, 25);

    return {
      scope: "ora_veeva_milestone",
      source: sourceUsed,
      filters: {
        activity_2023_plus: true,
        outlier_gap_gt_730: false,
        country: countries
      },
      n: scoped.length,
      nUniverse: universe.length,
      scopedToSites: scoped.length !== universe.length,
      gapMedians: gapMedianPack(scoped),
      topSitesByStartup,
      note:
        scoped.length > 0
          ? "Startup gap medians from live ora_veeva_milestone (Vault milestone__v). Excel Site Level packs not used."
          : "No live milestone gap rows matched filters — still use ora_veeva_site slate when present."
    };
  } catch (err) {
    return {
      scope: "ora_veeva_milestone",
      error: String(err.message || err),
      note: "ora_veeva_milestone startup query failed — do not invent startup timelines."
    };
  }
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
    // Missing container (pre-first Veeva/SF ingest) → 0, not a fatal health failure.
    // Never return full Cosmos SDK blobs — they blow SWA response size → HTTP 500 in UI.
    const code = err && (err.code || err.statusCode);
    const msg = String(err.message || err);
    if (code === 404 || /NotFound|Resource Not Found|does not exist/i.test(msg)) {
      return 0;
    }
    return { error: msg.slice(0, 180) };
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
    "ora_ctgov_trials",
    "ora_veeva_milestones",
    "ora_sf_account",
    "ora_sf_opportunity",
    "ora_sf_activity_request",
    "ora_veeva_study",
    "ora_veeva_site",
    "ora_veeva_study_country",
    "ora_veeva_organization",
    "ora_veeva_sponsor",
    "ora_veeva_milestone",
    "ora_veeva_metric",
    "ora_veeva_subject"
  ];
  const counts = {};
  for (const id of containers) {
    counts[id] = await safeCount(database, id);
  }
  // Fixed pack sizes are legacy reference only — Buddy uses ora_veeva_*.
  const expected = {
    ora_sponsor_crosswalk: 642,
    ora_site_alias_table: 46
  };
  const liveVault =
    (typeof counts.ora_veeva_study === "number" && counts.ora_veeva_study > 0) ||
    (typeof counts.ora_veeva_site === "number" && counts.ora_veeva_site > 0);
  const liveCounts = {
    ora_trialhub_trials: counts.ora_trialhub_trials,
    ora_ctgov_trials: counts.ora_ctgov_trials,
    ora_sf_account: counts.ora_sf_account,
    ora_sf_opportunity: counts.ora_sf_opportunity,
    ora_sf_activity_request: counts.ora_sf_activity_request,
    ora_veeva_study: counts.ora_veeva_study,
    ora_veeva_site: counts.ora_veeva_site,
    ora_veeva_study_country: counts.ora_veeva_study_country,
    ora_veeva_organization: counts.ora_veeva_organization,
    ora_veeva_sponsor: counts.ora_veeva_sponsor,
    ora_veeva_milestone: counts.ora_veeva_milestone,
    ora_veeva_metric: counts.ora_veeva_metric,
    ora_veeva_subject: counts.ora_veeva_subject
  };
  const fixedOk = liveVault
    ? true
    : Object.keys(expected).every((id) => {
        const c = counts[id];
        return typeof c === "number" && c === expected[id];
      });
  const readErrors = Object.entries(counts)
    .filter(([, v]) => v && typeof v === "object" && v.error)
    .map(([id, v]) => `${id}: ${v.error}`);
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
  let sfSyncState = null;
  try {
    const { resource } = await database.container("syncState").item("salesforce_tables", "salesforce_tables").read();
    sfSyncState = resource
      ? {
          lastSuccessfulSync: resource.lastSuccessfulSync || null,
          lastRunAt: resource.lastRunAt || null,
          mode: resource.mode || null,
          note: resource.note || null
        }
      : null;
  } catch (_) {
    sfSyncState = null;
  }
  return {
    dataset: DATASET,
    // ok = health endpoint succeeded; countsMatch = Excel pack sizes still align (legacy check)
    ok: true,
    countsMatch: fixedOk,
    counts,
    expected,
    liveCounts,
    readErrors: readErrors.length ? readErrors : undefined,
    trialhub: {
      count: counts.ora_trialhub_trials,
      note: "Grows via TrialHub .xlsx upload on this page — upsert by NCT, no duplicates."
    },
    ctgov: {
      count: counts.ora_ctgov_trials,
      sync: syncState,
      note: "Growing feed — daily delta ~6AM EST; no fixed expected count."
    },
    salesforce: {
      accounts: counts.ora_sf_account,
      opportunities: counts.ora_sf_opportunity,
      activityRequests: counts.ora_sf_activity_request,
      sync: sfSyncState,
      note: "Live SF mirrors via Ingest SF + crosswalk — Account / Opportunity / Activity_Request__c."
    },
    veeva: {
      studies: counts.ora_veeva_study,
      sites: counts.ora_veeva_site,
      studyCountries: counts.ora_veeva_study_country,
      organizations: counts.ora_veeva_organization,
      sponsors: counts.ora_veeva_sponsor,
      milestones: counts.ora_veeva_milestone,
      metrics: counts.ora_veeva_metric,
      subjects: counts.ora_veeva_subject,
      livePreferred: liveVault,
      note: liveVault
        ? "Live Vault mirrors preferred. Feasibility taxonomy: study vs site grain × metrics (enrollment) × milestones (startup) × subjects/geography."
        : "Run Data Status → Ingest Veeva for study, country, site, metrics, subjects, milestones."
    },
    note: liveVault
      ? "Live Veeva Vault sync present — Buddy feasibility uses ora_veeva_* (not ora_fact_*)."
      : fixedOk
        ? "Core intelligence containers loaded. Veeva live mirrors empty until Ingest Veeva."
        : "Veeva live mirrors empty — run Ingest Veeva."
  };
}

async function prefersLiveVeevaFacts(database) {
  try {
    const rows = await queryAll(
      database.container("ora_veeva_study"),
      "SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t",
      [{ name: "@t", value: "ora_veeva_study" }]
    );
    return (rows[0] || 0) > 0;
  } catch (_) {
    return false;
  }
}

function keepFactRowForSource(row, preferLive) {
  const src = row && row.source;
  if (preferLive) return src === "veeva_live";
  return src !== "veeva_live";
}

/** Query fact rows: when live Vault exists, pull source=veeva_live first (legacy TOP-N was drowning live). */
async function queryFactRowsPreferLive(container, baseSql, baseParams, preferLive, mapRow) {
  const run = async (sourceFilter) => {
    let q = baseSql;
    const params = [...baseParams];
    if (sourceFilter === "veeva_live") {
      q += ` AND c.source = @srcLive`;
      params.push({ name: "@srcLive", value: "veeva_live" });
    } else if (sourceFilter === "legacy") {
      q += ` AND (NOT IS_DEFINED(c.source) OR c.source != @srcLive)`;
      params.push({ name: "@srcLive", value: "veeva_live" });
    }
    return queryAll(container, q, params);
  };
  if (!preferLive) {
    const rows = await run(null);
    return rows.filter((r) => keepFactRowForSource(r, false));
  }
  let rows = await run("veeva_live");
  if (!rows.length) rows = await run("legacy");
  return mapRow ? rows.filter(mapRow) : rows;
}

async function lookupSponsorCrosswalk(database, sponsorOrClient) {
  if (!sponsorOrClient) return null;
  const needle = String(sponsorOrClient).trim();
  if (!needle) return null;
  const container = database.container("ora_sponsor_crosswalk");
  // Exact on renamed field, then CONTAINS both ways (bounded)
  let rows = await queryAll(
    container,
    `SELECT TOP 5 c.trialhub_veeva_sponsor, c.sf_account_name, c.sf_account_id, c.sf_owner, c.tier, c.ora_grouping, c.crosswalk_status, c.score
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
      `SELECT TOP 8 c.trialhub_veeva_sponsor, c.sf_account_name, c.sf_account_id, c.sf_owner, c.tier, c.ora_grouping, c.crosswalk_status, c.score
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

async function benchmarkIndication(database, indication, country = null, opts = {}) {
  const aliases = indicationAliases(indication);
  if (!aliases.length) return null;
  const countries = parseCountryFilter(country);
  const resolved = resolveIndicationGroup(indication);
  const preferred = (resolved && resolved.preferred) || preferredIndicationLabel(indication) || indication;
  const queryAliases = indicationQueryAliases(preferred);
  const ousOnly = Boolean(opts.ousOnly);
  const relatedLabels = relatedIndicationLabels(preferred);
  const siteListLimit = Math.min(
    80,
    Math.max(25, Number(opts.siteListLimit) || Number(opts.siteCap) || 40)
  );

  const thContainer = database.container("ora_trialhub_trials");
  const { loadVeevaLiveFeasibility } = require("./veevaLiveIntel");

  const mergeRow = (list, row, keyFn) => {
    const k = keyFn(row);
    if (!k) return;
    if (!list.some((x) => keyFn(x) === k)) list.push(row);
  };

  const passesGeo = (rowCountries, rowCountry) => {
    if (countries && !countriesMatch(rowCountries != null ? rowCountries : rowCountry, countries)) {
      return false;
    }
    if (ousOnly) {
      if (rowCountry && isUsCountryName(rowCountry)) return false;
      const list = parseCountryList(rowCountries);
      if (list.length && list.every((c) => isUsCountryName(c))) return false;
    }
    return true;
  };

  const matchesIndication = (ind) => {
    if (indicationCompatible(ind, preferred, aliases)) return true;
    for (const rel of relatedLabels) {
      if (indicationCompatible(ind, rel, indicationAliases(rel))) return true;
    }
    return false;
  };

  // Live Vault only — ora_fact_* ignored for Buddy feasibility
  let livePack = { studies: [], sites: [], note: null, error: null };
  try {
    livePack = await loadVeevaLiveFeasibility(database);
  } catch (err) {
    livePack = { studies: [], sites: [], error: String(err.message || err) };
  }

  const oraStudies = [];
  for (const r of livePack.studies || []) {
    if (!matchesIndication(r.indication)) continue;
    if (!passesGeo(r.countries, null)) continue;
    mergeRow(oraStudies, r, (x) => x.study_number || x.id);
  }

  const thTrials = [];
  const thQueryLabels = [...new Set([...aliases.slice(0, 8), ...relatedLabels])];
  for (const alias of thQueryLabels.slice(0, 10)) {
    const rows = await queryAll(
      thContainer,
      `SELECT c.nct, c.title, c.sponsor, c.indication, c.phase, c.status, c.patients,
              c.planned_sites, c.actual_sites, c.psm_common, c.th_actual_psm, c.recruit_days,
              c.n_countries, c.in_ora_indication, c.lead_sponsor_type, c.countries
       FROM c WHERE c.docType = @t AND c.indication = @ind`,
      [
        { name: "@t", value: "ora_trialhub_trials" },
        { name: "@ind", value: alias }
      ]
    );
    for (const r of rows) {
      if (countries && !countriesMatch(r.countries, countries)) continue;
      mergeRow(thTrials, r, (x) => x.nct);
    }
  }

  // Site PSM from milestones (already computed on live pack)
  const sitePsms = [];
  const topSites = [];
  const pushSites = (rows, { requirePsm = true } = {}) => {
    const sorted = [...rows].sort((a, b) => {
      const pa = typeof a.site_psm === "number" ? a.site_psm : -1;
      const pb = typeof b.site_psm === "number" ? b.site_psm : -1;
      if (pb !== pa) return pb - pa;
      const ta = trustRank(a.fsi_trust);
      const tb = trustRank(b.fsi_trust);
      if (tb !== ta) return tb - ta;
      return (Number(b.total_enrolled) || 0) - (Number(a.total_enrolled) || 0);
    });
    for (const r of sorted) {
      if (ousOnly && r.country && isUsCountryName(r.country)) continue;
      if (countries && !countriesMatch(r.country, countries)) continue;
      if (!matchesIndication(r.indication)) continue;
      if (typeof r.site_psm === "number" && r.site_psm > 0) sitePsms.push(r.site_psm);
      if (requirePsm && !(typeof r.site_psm === "number" && r.site_psm > 0)) continue;
      const orgName = String(r.org_clean || r.organization || "").trim();
      if (!orgName) continue;
      if (topSites.length < siteListLimit) {
        if (!topSites.some((x) => x.org_clean === orgName && x.country === r.country)) {
          topSites.push({
            org_clean: orgName,
            country: r.country,
            indication: r.indication || null,
            site_psm: round(r.site_psm),
            psm_zero_enrolled: r.site_psm === 0 || r.psm_zero_enrolled === true,
            total_enrolled: r.total_enrolled,
            site_enroll_months: r.site_enroll_months ?? null,
            fsi_date: r.fsi_date || null,
            lsi_date: r.lsi_date || null,
            fsi_trust: r.fsi_trust,
            study_name: r.study_name,
            source: r.source || "ora_veeva_site",
            rankedBy:
              typeof r.site_psm === "number" && r.site_psm > 0
                ? "site_psm"
                : "total_enrolled_or_presence"
          });
        }
      }
    }
  };

  pushSites(livePack.sites || [], { requirePsm: true });
  pushSites(livePack.sites || [], { requirePsm: false });

  // Fuzzy TrialHub only (Veeva already full-scanned in memory)
  let fuzzyUsed = [];
  {
    const needles = indicationContainsNeedles(preferred);
    for (const needle of needles.slice(0, 6)) {
      if (!needle || needle.length < 4) continue;
      fuzzyUsed.push(needle);
      {
        const rows = await queryAll(
          thContainer,
          `SELECT TOP 120 c.nct, c.title, c.sponsor, c.indication, c.phase, c.status, c.patients,
                  c.planned_sites, c.actual_sites, c.psm_common, c.th_actual_psm, c.recruit_days,
                  c.n_countries, c.in_ora_indication, c.lead_sponsor_type, c.countries
           FROM c WHERE c.docType = @t AND (
             CONTAINS(LOWER(c.indication), @n) OR
             (IS_DEFINED(c.indications) AND CONTAINS(LOWER(c.indications), @n)) OR
             (IS_DEFINED(c.primary_raw) AND CONTAINS(LOWER(c.primary_raw), @n))
           )`,
          [
            { name: "@t", value: "ora_trialhub_trials" },
            { name: "@n", value: needle.toLowerCase() }
          ]
        );
        for (const r of rows) {
          if (countries && !countriesMatch(r.countries, countries)) continue;
          if (!indicationCompatible(r.indication, preferred, aliases)) continue;
          mergeRow(thTrials, r, (x) => x.nct);
        }
      }
    }
  }

  const oraPsm = oraStudies.map((s) => s.psm).filter((n) => typeof n === "number" && n > 0);
  const thPsm = thTrials
    .map((t) => (typeof t.psm_common === "number" ? t.psm_common : t.th_actual_psm))
    .filter((n) => typeof n === "number" && n > 0 && n < 500);

  const recruiting = thTrials.filter((t) => /recruit/i.test(String(t.status || "")));
  const completed = thTrials.filter((t) => /completed/i.test(String(t.status || "")));
  const countryRankAll = rankCountriesFromTrials(thTrials, { ousOnly: false, limit: 12 });
  const countryRankOus = rankCountriesFromTrials(thTrials, { ousOnly: true, limit: 12 });

  const sitesWithPsm = topSites.filter((s) => typeof s.site_psm === "number" && s.site_psm > 0);
  const ousSites = topSites.filter((s) => s.country && !isUsCountryName(s.country));

  const startupTimelines = await queryStartupTimelines(database, {
    countries,
    orgNames: topSites.map((s) => s.org_clean),
    studyNames: oraStudies.map((s) => s.study_number).filter(Boolean)
  });

  return {
    indicationRequested: preferred,
    countryFilter: countries,
    countryFilterLabel: countries ? countries.join(", ") : ousOnly ? "OUS (ex-US)" : "Global",
    ousOnly,
    aliasesUsed: aliases,
    relatedIndicationsQueried: relatedLabels.length ? relatedLabels : undefined,
    fuzzyContainsUsed: fuzzyUsed.length ? fuzzyUsed : undefined,
    ora: {
      studyCount: oraStudies.length,
      studiesWithPsm: oraPsm.length,
      psmMedian: round(median(oraPsm)),
      psmP25: round(percentile(oraPsm, 25)),
      psmP75: round(percentile(oraPsm, 75)),
      note:
        oraStudies.length && !oraPsm.length
          ? "Veeva has studies for this indication but site PSM is missing (need FSI+LSI milestones and enrolled). List study_number, sponsor, enrolled — do NOT say there is no Veeva data."
          : oraStudies.length
            ? "From ora_veeva_study (+ site PSM median from FSI→LSI milestones). Prefer median PSM when studiesWithPsm > 0."
            : livePack.error
              ? `Veeva live load error: ${livePack.error}`
              : "No ora_veeva_study rows matched this indication.",
      sampleStudies: [...oraStudies]
        .sort((a, b) => {
          const pa = typeof a.psm === "number" ? a.psm : -1;
          const pb = typeof b.psm === "number" ? b.psm : -1;
          if (pb !== pa) return pb - pa;
          return (Number(b.total_enrolled) || 0) - (Number(a.total_enrolled) || 0);
        })
        .slice(0, 12)
        .map((s) => ({
          study_number: s.study_number,
          sponsor: s.sponsor,
          phase: s.phase,
          indication: s.indication,
          psm: typeof s.psm === "number" ? round(s.psm) : null,
          total_enrolled: s.total_enrolled,
          n_contributing_sites: s.n_contributing_sites,
          lifecycle_state: s.lifecycle_state,
          countries: s.countries
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
      note:
        relatedLabels.length
          ? `Includes related indications (${relatedLabels.join("; ")}) for country frequency when ${preferred} is thin. Prefer median over mean.`
          : "psm stats exclude values >= 500 (outlier guard). Prefer median over mean.",
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
          indication: t.indication,
          patients: t.patients,
          sites: t.actual_sites ?? t.planned_sites,
          psm_common: round(t.psm_common),
          recruit_days: t.recruit_days,
          countries: t.countries
        })),
      recruitingSample: recruiting.slice(0, 6).map((t) => ({
        nct: t.nct,
        title: t.title,
        sponsor: t.sponsor,
        phase: t.phase,
        patients: t.patients,
        planned_sites: t.planned_sites,
        countries: t.countries
      })),
      countryRank: ousOnly ? countryRankOus : countryRankAll,
      countryRankOus,
      countryRankGlobal: countryRankAll
    },
    sites: {
      sitesWithPsmSampled: sitePsms.length,
      sitePsmMedian: round(median(sitePsms)),
      sitePsmP75: round(percentile(sitePsms, 75)),
      siteListLimit,
      returnedCount: Math.min(siteListLimit, topSites.length),
      topSitesByPsm: sitesWithPsm.slice(0, siteListLimit),
      topSites: topSites.slice(0, siteListLimit),
      topOusSites: ousSites.slice(0, siteListLimit),
      countryFilter: countries,
      countryFilterLabel: countries ? countries.join(", ") : ousOnly ? "OUS (ex-US)" : "Global",
      note: sitesWithPsm.length
        ? `Ora Veeva named sites from ora_veeva_* (up to ${siteListLimit}). PSM = enrolled / months(FSI→LSI milestones). Never say Cosmos only has 10 if returnedCount is higher.`
        : topSites.length
          ? `No computable site PSM yet (missing FSI/LSI or enrolled) — listed ${Math.min(siteListLimit, topSites.length)} real org rows from ora_veeva_site. This IS the site slate.`
          : "No Ora Veeva site rows for this indication. Use trialhub.countryRank + ctgov country ranks to prioritize geographies; do not invent PI names.",
      dataSource: "ora_veeva_site+milestone",
      livePackNote: livePack.note || undefined,
      harmonize: {
        veeva: "Named Ora sites (org + country + site PSM) — primary slate for site selection.",
        trialhub:
          "Study-level industry landscape + countryRank / recruitingSample — not site-level PSM. Use to fill country mix when Veeva slate is short of the requested N.",
        ctgov:
          "Registry trials + countries — public landscape. Use country frequencies / recruiting trials to complement; do not invent site names from CT.gov unless facilities are in context."
      }
    },
    startupTimelines
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

/**
 * Portfolio-wide CT.gov snapshot when the user asks for CT.gov / registry dashboard
 * without naming an indication. Still ophthalmology feed only (ora_ctgov_trials).
 * Avoid ORDER BY — Cosmos cross-partition ORDER BY often fails without a composite index.
 */
async function ctgovOverview(database, country = null) {
  const countries = parseCountryFilter(country);
  try {
    const totalRows = await queryAll(
      database.container("ora_ctgov_trials"),
      "SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t",
      [{ name: "@t", value: "ora_ctgov_trials" }]
    );
    const totalCount = totalRows[0] ?? 0;

    let sampleQ = `SELECT TOP 100 c.nct, c.title, c.oraIndication, c.status, c.phase, c.sponsor, c.sponsorClass,
              c.enrollment, c.countries, c.startDate, c.lastUpdatePostDate, c.hasResults
       FROM c WHERE c.docType = @t`;
    const params = [{ name: "@t", value: "ora_ctgov_trials" }];
    const geo = ctgovCountrySqlClause(countries, "cgo");
    sampleQ += geo.sql;
    params.push(...geo.params);
    let sample = [];
    try {
      sample = await queryAll(database.container("ora_ctgov_trials"), sampleQ, params);
    } catch (err) {
      // Retry without geo clause if ARRAY/EXISTS geo SQL fails on some docs
      sample = await queryAll(
        database.container("ora_ctgov_trials"),
        `SELECT TOP 100 c.nct, c.title, c.oraIndication, c.status, c.phase, c.sponsor, c.sponsorClass,
                c.enrollment, c.countries, c.startDate, c.lastUpdatePostDate, c.hasResults
         FROM c WHERE c.docType = @t`,
        [{ name: "@t", value: "ora_ctgov_trials" }]
      );
    }
    sample = [...sample].sort((a, b) =>
      String(b.lastUpdatePostDate || "").localeCompare(String(a.lastUpdatePostDate || ""))
    );

    const byIndication = {};
    const byStatus = {};
    for (const t of sample) {
      const ind = t.oraIndication || "_unknown";
      byIndication[ind] = (byIndication[ind] || 0) + 1;
      const st = t.status || "_unknown";
      byStatus[st] = (byStatus[st] || 0) + 1;
    }
    const indicationRank = Object.entries(byIndication)
      .map(([indication, count]) => ({ indication, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
    const statusRank = Object.entries(byStatus)
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);
    const recruiting = sample.filter((t) => /recruit/i.test(String(t.status || "")));
    const countryRank = rankCountriesFromTrials(sample, { ousOnly: false, limit: 15 });
    const countryRankOus = rankCountriesFromTrials(sample, { ousOnly: true, limit: 12 });

    let sync = null;
    try {
      const { resource } = await database
        .container("syncState")
        .item("ctgov_ophthalmology", "ctgov_ophthalmology")
        .read();
      sync = resource
        ? {
            lastSuccessfulSync: resource.lastSuccessfulSync || null,
            lastUpserted: resource.lastUpserted || null,
            mode: resource.mode || null
          }
        : null;
    } catch (_) {}

    return {
      scope: "ophthalmology_feed",
      totalCount,
      sampleCount: sample.length,
      countryFilter: countries,
      countryFilterLabel: countries ? countries.join(", ") : "Global",
      indicationRank,
      statusRank,
      recruitingCount: recruiting.length,
      recruitingSample: recruiting.slice(0, 12),
      recentSample: sample.slice(0, 15),
      countryRank,
      countryRankOus,
      sync,
      note:
        totalCount > 0
          ? "Live from Cosmos ora_ctgov_trials (ophthalmology CT.gov feed). indicationRank/statusRank are from the sample window; totalCount is full container. Use for CT.gov dashboards even with no indication."
          : "ora_ctgov_trials is empty — run CT.gov sync from the Intelligence tab."
    };
  } catch (err) {
    return { error: String(err.message || err), totalCount: 0 };
  }
}

/**
 * Portfolio-wide TrialHub snapshot (ora_trialhub_trials) when no indication is named.
 */
async function trialhubOverview(database, country = null) {
  const countries = parseCountryFilter(country);
  try {
    const totalRows = await queryAll(
      database.container("ora_trialhub_trials"),
      "SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t",
      [{ name: "@t", value: "ora_trialhub_trials" }]
    );
    const totalCount = totalRows[0] ?? 0;

    let sampleQ = `SELECT TOP 100 c.nct, c.title, c.sponsor, c.indication, c.phase, c.status, c.patients,
              c.planned_sites, c.actual_sites, c.psm_common, c.th_actual_psm, c.recruit_days,
              c.countries, c.in_ora_indication, c.lead_sponsor_type
       FROM c WHERE c.docType = @t`;
    const params = [{ name: "@t", value: "ora_trialhub_trials" }];
    // Soft country filter via post-filter (TrialHub countries field shapes vary)
    let sample = await queryAll(database.container("ora_trialhub_trials"), sampleQ, params);
    if (countries && countries.length) {
      const filtered = sample.filter((t) => countriesMatch(t.countries, countries));
      if (filtered.length) sample = filtered;
    }

    const byIndication = {};
    const byStatus = {};
    const bySponsor = {};
    const psmVals = [];
    for (const t of sample) {
      const ind = t.indication || "_unknown";
      byIndication[ind] = (byIndication[ind] || 0) + 1;
      const st = t.status || "_unknown";
      byStatus[st] = (byStatus[st] || 0) + 1;
      const sp = t.sponsor || "_unknown";
      bySponsor[sp] = (bySponsor[sp] || 0) + 1;
      const psm = t.psm_common != null ? Number(t.psm_common) : t.th_actual_psm != null ? Number(t.th_actual_psm) : null;
      if (psm != null && !Number.isNaN(psm) && psm > 0) psmVals.push(psm);
    }
    psmVals.sort((a, b) => a - b);
    const mid = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null);
    const indicationRank = Object.entries(byIndication)
      .map(([indication, count]) => ({ indication, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
    const statusRank = Object.entries(byStatus)
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);
    const sponsorRank = Object.entries(bySponsor)
      .map(([sponsor, count]) => ({ sponsor, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);
    const recruiting = sample.filter((t) => /recruit/i.test(String(t.status || "")));
    const countryRank = rankCountriesFromTrials(sample, { ousOnly: false, limit: 15 });
    const countryRankOus = rankCountriesFromTrials(sample, { ousOnly: true, limit: 12 });

    return {
      scope: "trialhub_feed",
      totalCount,
      sampleCount: sample.length,
      countryFilter: countries,
      countryFilterLabel: countries ? countries.join(", ") : "Global",
      indicationRank,
      statusRank,
      sponsorRank,
      trialsWithPsm: psmVals.length,
      psmMedian: mid(psmVals),
      recruitingCount: recruiting.length,
      recruitingSample: recruiting.slice(0, 12),
      recentSample: sample.slice(0, 15),
      countryRank,
      countryRankOus,
      note:
        totalCount > 0
          ? "Live from Cosmos ora_trialhub_trials. Use for TrialHub / industry dashboards even with no indication. totalCount is full container; ranks are from sample."
          : "ora_trialhub_trials is empty — upload a TrialHub export on the Intelligence tab."
    };
  } catch (err) {
    return { error: String(err.message || err), totalCount: 0 };
  }
}

/** Ora/Veeva feed-wide snapshot from live mirrors (ora_veeva_*), not ora_fact_*. */
async function veevaOverview(database) {
  try {
    const { loadVeevaLiveFeasibility } = require("./veevaLiveIntel");
    const pack = await loadVeevaLiveFeasibility(database);
    const studies = pack.studies || [];
    const sites = pack.sites || [];
    const byIndication = {};
    const psmVals = [];
    for (const s of studies) {
      const ind = s.indication || "_unknown";
      byIndication[ind] = (byIndication[ind] || 0) + 1;
      if (typeof s.psm === "number" && s.psm > 0) psmVals.push(s.psm);
    }
    psmVals.sort((a, b) => a - b);
    const mid = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null);
    const indicationRank = Object.entries(byIndication)
      .map(([indication, count]) => ({ indication, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
    const topSites = [...sites]
      .filter((s) => s.org_clean)
      .sort((a, b) => (b.site_psm || 0) - (a.site_psm || 0))
      .slice(0, 40)
      .map((s) => ({
        org_clean: s.org_clean,
        country: s.country,
        indication: s.indication,
        site_psm: s.site_psm,
        total_enrolled: s.total_enrolled,
        site_enroll_months: s.site_enroll_months,
        fsi_date: s.fsi_date,
        lsi_date: s.lsi_date,
        fsi_trust: s.fsi_trust,
        study_name: s.study_name
      }));
    const sampleStudies = [...studies]
      .sort((a, b) => (b.psm || 0) - (a.psm || 0))
      .slice(0, 15)
      .map((s) => ({
        study_number: s.study_number,
        sponsor: s.sponsor,
        indication: s.indication,
        phase: s.phase,
        psm: s.psm,
        total_enrolled: s.total_enrolled
      }));

    return {
      scope: "ora_veeva",
      studyCount: pack.studyCount ?? studies.length,
      siteCount: pack.siteCount ?? sites.length,
      sampleStudyCount: studies.length,
      studiesWithPsm: pack.studiesWithPsm ?? psmVals.length,
      sitesWithPsm: pack.sitesWithPsm ?? null,
      psmMedian: mid(psmVals),
      indicationRank,
      sampleStudies,
      topSites,
      note:
        studies.length || sites.length
          ? "Live from ora_veeva_study / ora_veeva_site / ora_veeva_milestone. Site PSM = enrolled / months(FSI→LSI). ora_fact_* not used."
          : "Ora Veeva mirrors are empty — run Ingest Veeva."
    };
  } catch (err) {
    return { error: String(err.message || err), studyCount: 0, siteCount: 0 };
  }
}

/** Sponsor crosswalk rollup when user asks about Salesforce / crosswalk without a named sponsor. */
async function crosswalkOverview(database) {
  try {
    const totalRows = await queryAll(
      database.container("ora_sponsor_crosswalk"),
      "SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t",
      [{ name: "@t", value: "ora_sponsor_crosswalk" }]
    );
    const sample = await queryAll(
      database.container("ora_sponsor_crosswalk"),
      `SELECT TOP 120 c.trialhub_veeva_sponsor, c.sf_account_name, c.sf_owner, c.tier, c.crosswalk_status, c.score
       FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_sponsor_crosswalk" }]
    );
    const byStatus = {};
    const byTier = {};
    for (const r of sample) {
      const st = r.crosswalk_status || "_unknown";
      byStatus[st] = (byStatus[st] || 0) + 1;
      const tier = r.tier || "_unknown";
      byTier[tier] = (byTier[tier] || 0) + 1;
    }
    const statusRank = Object.entries(byStatus)
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);
    const tierRank = Object.entries(byTier)
      .map(([tier, count]) => ({ tier, count }))
      .sort((a, b) => b.count - a.count);
    const noSf = sample.filter((r) => /no_sf_match/i.test(String(r.crosswalk_status || ""))).slice(0, 15);
    const totalCount = totalRows[0] ?? 0;
    return {
      scope: "sponsor_crosswalk",
      totalCount,
      sampleCount: sample.length,
      statusRank,
      tierRank,
      noSfMatchSample: noSf.map((r) => ({
        trialhub_veeva_sponsor: r.trialhub_veeva_sponsor,
        sf_account_name: r.sf_account_name,
        sf_owner: r.sf_owner,
        tier: r.tier,
        crosswalk_status: r.crosswalk_status
      })),
      recentSample: sample.slice(0, 15).map((r) => ({
        trialhub_veeva_sponsor: r.trialhub_veeva_sponsor,
        sf_account_name: r.sf_account_name,
        sf_owner: r.sf_owner,
        tier: r.tier,
        crosswalk_status: r.crosswalk_status
      })),
      note:
        totalCount > 0
          ? "Live from Cosmos ora_sponsor_crosswalk. Use for Salesforce/crosswalk dashboards. Never say crosswalk is empty if totalCount > 0."
          : "Sponsor crosswalk container is empty."
    };
  } catch (err) {
    return { error: String(err.message || err), totalCount: 0 };
  }
}

async function ctgovByIndication(database, indication, country = null) {
  const aliases = indicationAliases(indication);
  if (!aliases.length) return null;
  const preferred = preferredIndicationLabel(indication) || indication;
  const countries = parseCountryFilter(country);
  try {
    const trials = [];
    const merge = (r) => {
      if (!trials.some((x) => x.nct === r.nct)) trials.push(r);
    };
    for (const alias of aliases.slice(0, 6)) {
      const params = [
        { name: "@t", value: "ora_ctgov_trials" },
        { name: "@ind", value: alias }
      ];
      let q = `SELECT TOP 40 c.nct, c.title, c.oraIndication, c.status, c.phase, c.sponsor, c.sponsorClass,
                c.enrollment, c.countries, c.startDate, c.lastUpdatePostDate, c.hasResults,
                c.hasMentionedDollars, c.mentionedDollars, c.briefSummary, c.conditions
         FROM c WHERE c.docType = @t AND c.oraIndication = @ind`;
      const geo = ctgovCountrySqlClause(countries, "cg");
      q += geo.sql;
      params.push(...geo.params);
      const rows = await queryAll(database.container("ora_ctgov_trials"), q, params);
      for (const r of rows) merge(r);
    }
    // Also match condition text (legacy rows may still have oraIndication=Glaucoma for Neuroprotection)
    if (trials.length < 8) {
      const needles = indicationContainsNeedles(preferred);
      for (const needle of needles.slice(0, 3)) {
        if (!needle || needle.length < 4) continue;
        const params = [
          { name: "@t", value: "ora_ctgov_trials" },
          { name: "@n", value: needle.toLowerCase() }
        ];
        let q = `SELECT TOP 40 c.nct, c.title, c.oraIndication, c.status, c.phase, c.sponsor, c.sponsorClass,
                  c.enrollment, c.countries, c.startDate, c.lastUpdatePostDate, c.hasResults,
                  c.hasMentionedDollars, c.mentionedDollars, c.briefSummary, c.conditions
           FROM c WHERE c.docType = @t AND (
             CONTAINS(LOWER(c.oraIndication), @n) OR
             EXISTS (SELECT VALUE x FROM x IN c.conditions WHERE CONTAINS(LOWER(x), @n))
           )`;
        const geo = ctgovCountrySqlClause(countries, "cgf");
        q += geo.sql;
        params.push(...geo.params);
        const rows = await queryAll(database.container("ora_ctgov_trials"), q, params);
        for (const r of rows) {
          const label = r.oraIndication || (Array.isArray(r.conditions) ? r.conditions.join(" ") : "");
          if (!indicationCompatible(label, preferred, aliases)) continue;
          merge(r);
        }
      }
    }
    const recruiting = trials.filter((t) => /recruit/i.test(String(t.status || "")));
    const withDollars = trials.filter((t) => t.hasMentionedDollars || (t.mentionedDollars || []).length);
    return {
      trialCount: trials.length,
      recruitingCount: recruiting.length,
      countryFilter: countries,
      countryFilterLabel: countries ? countries.join(", ") : "Global",
      sample: trials.slice(0, 10),
      recruitingSample: recruiting.slice(0, 8),
      dollarMentions: {
        available: withDollars.length > 0,
        trialCountWithMentions: withDollars.length,
        sample: withDollars.slice(0, 6).map((t) => ({
          nct: t.nct,
          title: t.title,
          enrollment: t.enrollment,
          mentionedDollars: t.mentionedDollars || [],
          note: "Free-text $ mentions in BriefSummary — NOT structured CRO bid pricing"
        })),
        note:
          withDollars.length > 0
            ? "CT.gov has no structured bid/cost fields. These are rare free-text dollar mentions only — cite NCT and say they are not Ora bid comps."
            : "CT.gov usually has no dollar amounts. Do not invent costs from CT.gov; use past Ora bids for pricing tiers."
      },
      note: "From ClinicalTrials.gov daily ophthalmology feed (ora_ctgov_trials). Matches oraIndication aliases and condition text."
    };
  } catch (err) {
    return { error: String(err.message || err), note: "CT.gov container may be empty until first pull." };
  }
}

/**
 * Slim live Cosmos pack for document verification / reconciliation.
 * Pulls indication benchmark (+ CT.gov slice) without heavy overviews/SF/inventory
 * that routinely timeout on attachment + analyze asks under SWA.
 */
async function buildReconciliationIntelContext(getDb, opts = {}) {
  const {
    question = "",
    indication = null,
    country = null,
    attachmentText = "",
    clientName = null,
    sponsor = null
  } = opts;

  const database = getDb();
  const started = Date.now();
  const blob = `${String(question || "")}\n${String(attachmentText || "")}`;
  const qInd = extractIndicationFromQuestion(blob);
  const resolvedIndication = indication || qInd || null;
  const resolvedCountries =
    parseCountryFilter(country) ||
    (() => {
      const fromQ = extractCountryFromQuestion(blob);
      return fromQ ? [fromQ] : null;
    })();

  const out = {
    source: "ora_clinical_intelligence",
    attachedFrom: "cosmos_reconciliation",
    query: {
      indication: resolvedIndication,
      country: resolvedCountries ? resolvedCountries.join(", ") : null,
      countries: resolvedCountries,
      reconciliation: true
    },
    note:
      "Live Cosmos reconciliation pack — compare each ATTACHED DOCUMENT claim to indicationBenchmark (Ora Veeva + TrialHub + sites). Do NOT say Cosmos was not queried when this block is present."
  };

  try {
    if (resolvedIndication) {
      out.indicationBenchmark = await benchmarkIndication(database, resolvedIndication, resolvedCountries, {});
      out.ctgov = await ctgovByIndication(database, resolvedIndication, resolvedCountries);
      if (out.ctgov && !out.ctgov.error) {
        out.ctgov.countryRank = rankCountriesFromTrials(out.ctgov.sample || [], { limit: 8 });
      }
    } else {
      out.indicationMissing = true;
      out.note +=
        " Could not infer indication from question/attachment — still use trialhubOverview/veevaOverview below for generic checks, or ask which indication to verify.";
      out.trialhubOverview = await trialhubOverview(database, resolvedCountries);
      out.veevaOverview = await veevaOverview(database);
    }

    const who = sponsor || clientName;
    if (who) {
      out.sponsorCrosswalk = await lookupSponsorCrosswalk(database, who);
    }

    try {
      const { attachSalesforceData } = require("./salesforceTables");
      await attachSalesforceData(out, getDb, {
        question: blob,
        clientName: who,
        sponsor: who
      });
    } catch (_) {
      /* optional */
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

/**
 * Minimal live Cosmos touch — inventory / container counts only (~1–2s).
 * Used when the router plans cosmos_default without full intel or reconciliation.
 */
async function buildSlimBuddyIntelContext(getDb, opts = {}) {
  const { question = "", clientName = null, sponsor = null } = opts;
  const database = getDb();
  const started = Date.now();
  try {
    const inventory = await getIntelligenceHealth(getDb);
    const out = {
      source: "ora_clinical_intelligence",
      attachedFrom: "cosmos_slim_inventory",
      query: { slimInventory: true },
      inventory,
      note:
        "Live Cosmos inventory (progressive fetch). DB was queried on this turn — use container counts. Say 'go deeper' or ask for indication benchmarks for full intel.",
      elapsedMs: Date.now() - started
    };
    const who = sponsor || clientName;
    if (who) {
      out.sponsorCrosswalk = await lookupSponsorCrosswalk(database, who);
    }
    try {
      const { attachSalesforceData } = require("./salesforceTables");
      await attachSalesforceData(out, getDb, { question, clientName: who, sponsor: who });
    } catch (_) {
      /* optional */
    }
    return out;
  } catch (err) {
    return {
      source: "ora_clinical_intelligence_error",
      error: String(err.message || err),
      elapsedMs: Date.now() - started
    };
  }
}

/**
 * Default live Cosmos pack — attached on EVERY Buddy turn.
 * If indication is known, delegates to the slim reconciliation pack.
 * Otherwise returns inventory + feed overviews so the model never claims DB is missing.
 */
async function buildDefaultBuddyIntelContext(getDb, opts = {}) {
  const {
    question = "",
    indication = null,
    country = null,
    attachmentText = "",
    clientName = null,
    sponsor = null
  } = opts;

  const blob = `${String(question || "")}\n${String(attachmentText || "")}`;
  const resolvedIndication = indication || extractIndicationFromQuestion(blob) || null;

  if (resolvedIndication) {
    return buildReconciliationIntelContext(getDb, {
      ...opts,
      indication: resolvedIndication,
      attachmentText
    });
  }

  const database = getDb();
  const started = Date.now();
  const resolvedCountries =
    parseCountryFilter(country) ||
    (() => {
      const fromQ = extractCountryFromQuestion(blob);
      return fromQ ? [fromQ] : null;
    })();

  try {
    const [inventory, veevaPack, trialhubPack] = await Promise.all([
      getIntelligenceHealth(getDb),
      veevaOverview(database),
      trialhubOverview(database, resolvedCountries)
    ]);

    const out = {
      source: "ora_clinical_intelligence",
      attachedFrom: "cosmos_default",
      query: {
        indication: null,
        country: resolvedCountries ? resolvedCountries.join(", ") : null,
        defaultPack: true
      },
      inventory,
      veevaOverview: veevaPack,
      trialhubOverview: trialhubPack,
      note:
        "Live Cosmos default pack — DB was queried on this turn. Use inventory counts and overviews. Never say Cosmos/DB was not present in context.",
      elapsedMs: Date.now() - started
    };

    const who = sponsor || clientName;
    if (who) {
      out.sponsorCrosswalk = await lookupSponsorCrosswalk(database, who);
    }
    try {
      const { attachSalesforceData } = require("./salesforceTables");
      await attachSalesforceData(out, getDb, {
        question: blob,
        clientName: who,
        sponsor: who
      });
    } catch (_) {
      /* optional */
    }
    return out;
  } catch (err) {
    return {
      source: "ora_clinical_intelligence_error",
      error: String(err.message || err),
      elapsedMs: Date.now() - started
    };
  }
}

/**
 * Build a bounded intelligence context for Buddy.
 */
async function buildIntelligenceContext(getDb, opts = {}) {
  const {
    question = "",
    indication = null,
    country = null,
    countries = null,
    global = false,
    clientName = null,
    sponsor = null,
    force = false
  } = opts;

  const wantsIntel = force || isIntelligenceQuestion(question);
  const wantsCtgov = isCtgovQuestion(question);
  const wantsTrialhub = isTrialhubQuestion(question);
  const wantsVeeva = isVeevaQuestion(question);
  const wantsCrosswalk = isCrosswalkQuestion(question);
  const wantsSalesforce = isSalesforceDataQuestion(question);
  const wantsSourceOverview = isSourceOverviewQuestion(question);
  const nct = extractNct(question);
  const qIndication = extractIndicationFromQuestion(question);
  const ousOnly = wantsOusOnly(question);
  const enrollmentPlan = extractEnrollmentPlan(question);
  const siteListLimitAsked = extractSiteListLimit(question);
  const startYear = extractYearFromQuestion(question);
  const therapeuticFilter = extractTherapeuticFilterFromQuestion(question);
  const wantsStartedList = /\b(all|every|list|tell me|show me|give me)\b/i.test(question);
  const resolvedCountries = global
    ? null
    : parseCountryFilter(countries != null ? countries : country) ||
      (() => {
        const fromQ = extractCountryFromQuestion(question);
        return fromQ ? [fromQ] : null;
      })();
  const resolvedIndication = indication || qIndication;

  // Skip entirely if nothing to hang a query on and question isn't intelligence-shaped
  if (
    !wantsIntel &&
    !resolvedIndication &&
    !nct &&
    !clientName &&
    !sponsor &&
    !resolvedCountries &&
    !wantsSalesforce &&
    !startYear &&
    !therapeuticFilter
  ) {
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
      "ctgov = ClinicalTrials.gov ophthalmology feed (daily delta).",
      "salesforce / salesforceData = Cosmos mirrors of SF Account, Opportunity, Activity_Request__c only. Use for pipeline / owner / AR asks after tables sync.",
      "ctgovOverview / trialhubOverview / veevaOverview / crosswalkOverview = feed-wide snapshots when no indication was named — use for dashboards. Never say a feed is missing if its totalCount/studyCount > 0 or recentSample has rows.",
      "When countryFilter is set (array), site/CT.gov/TrialHub results match ANY of those countries. Null/Global = all geographies.",
      "For OUS / outside-US asks: use trialhub.countryRankOus (or countryRank) for ranked countries with trialMentions counts — that IS the country leaderboard.",
      "sites.topSites / topSitesByPsm / topOusSites are the site slate. If site_psm is null, still name org_clean. Never say you lack a site leaderboard when these arrays have rows OR countryRank.ranked has rows.",
      "enrollmentPlan (when present) already computed sitesExact / sitesRecommendedWith20pctBuffer — use those numbers; do not invent different math.",
      "Do not invent PI names or site names that are not in Cosmos context or the Ora always-on playbook. Prefer Cosmos org_clean and TrialHub country ranks."
    ],
    query: {
      indication: resolvedIndication || null,
      country: resolvedCountries ? resolvedCountries.join(", ") : null,
      countries: resolvedCountries,
      global: !resolvedCountries,
      ousOnly,
      nct: nct || null,
      clientName: clientName || null,
      sponsor: sponsor || null,
      intelligenceIntent: wantsIntel,
      ctgovIntent: wantsCtgov,
      trialhubIntent: wantsTrialhub,
      veevaIntent: wantsVeeva,
      crosswalkIntent: wantsCrosswalk,
      salesforceIntent: wantsSalesforce,
      startYear: startYear || null,
      therapeuticFilter: therapeuticFilter || null,
      enrollmentPlan,
      siteListLimit: siteListLimitAsked || 40
    }
  };

  try {
    // Always attach container inventory so Buddy can never claim feeds "don't exist"
    // when Cosmos has rows.
    try {
      out.inventory = await getIntelligenceHealth(getDb);
    } catch (invErr) {
      out.inventory = { error: String(invErr.message || invErr) };
    }

    if (nct) {
      out.nctLookup = await lookupNct(database, nct);
      out.ctgovNct = await lookupCtgovNct(database, nct);
    }

    if (
      resolvedIndication ||
      wantsIntel ||
      resolvedCountries ||
      ousOnly ||
      wantsCtgov ||
      wantsTrialhub ||
      wantsVeeva ||
      wantsCrosswalk ||
      wantsSalesforce
    ) {
      const ind = resolvedIndication || qIndication;
      if (ind) {
        out.indicationBenchmark = await benchmarkIndication(database, ind, resolvedCountries, {
          ousOnly,
          siteListLimit: siteListLimitAsked || 40
        });
        out.ctgov = await ctgovByIndication(database, ind, resolvedCountries);
        if (out.ctgov && !out.ctgov.error) {
          out.ctgov.countryRank = rankCountriesFromTrials(out.ctgov.sample || [], {
            ousOnly,
            limit: 12
          });
          out.ctgov.countryRankOus = rankCountriesFromTrials(out.ctgov.sample || [], {
            ousOnly: true,
            limit: 12
          });
        }
      } else if (resolvedCountries) {
        // Country-only: live Veeva sites with milestone PSM
        const { loadVeevaLiveFeasibility } = require("./veevaLiveIntel");
        let pack = { sites: [] };
        try {
          pack = await loadVeevaLiveFeasibility(database);
        } catch (_) {
          pack = { sites: [] };
        }
        const sorted = [...(pack.sites || [])]
          .filter((s) => countriesMatch(s.country, resolvedCountries))
          .sort((a, b) => (b.site_psm || 0) - (a.site_psm || 0));
        const countrySiteCap = Math.min(80, Math.max(25, siteListLimitAsked || 40));
        out.countrySites = {
          countries: resolvedCountries,
          country: resolvedCountries.join(", "),
          sampleCount: sorted.length,
          siteListLimit: countrySiteCap,
          returnedCount: Math.min(countrySiteCap, sorted.length),
          topSites: sorted.slice(0, countrySiteCap).map((s) => ({
            org_clean: s.org_clean,
            country: s.country,
            indication: s.indication,
            site_psm: s.site_psm,
            total_enrolled: s.total_enrolled,
            site_enroll_months: s.site_enroll_months,
            fsi_date: s.fsi_date,
            lsi_date: s.lsi_date,
            fsi_trust: s.fsi_trust,
            study_name: s.study_name
          })),
          note:
            sorted.length && sorted.every((s) => s.site_psm == null || s.site_psm === 0)
              ? "Sites from ora_veeva_site; site PSM missing (need FSI+LSI + enrolled) — still name sites."
              : "Sites from ora_veeva_*; PSM = enrolled / months(FSI→LSI)."
        };
      }

      // Feed-wide overviews for source dashboards / indication-less intel
      const needFeedOverview = wantsSourceOverview || (!ind && wantsIntel);
      if (needFeedOverview || wantsCtgov) {
        out.ctgovOverview = await ctgovOverview(database, resolvedCountries);
      }
      if (needFeedOverview || wantsTrialhub || startYear || therapeuticFilter) {
        // Year/TA list asks: skip bulky overview sample — startedTrials is the deliverable
        if (!(startYear || therapeuticFilter) || needFeedOverview || wantsTrialhub) {
          if (!startYear && !therapeuticFilter) {
            out.trialhubOverview = await trialhubOverview(database, resolvedCountries);
          } else if (needFeedOverview || (wantsTrialhub && !startYear)) {
            out.trialhubOverview = await trialhubOverview(database, resolvedCountries);
          }
        }
        if (startYear || therapeuticFilter) {
          out.trialhubStartedTrials = await trialhubStartedTrialsQuery(database, {
            year: startYear,
            therapeuticFilter,
            maxTrials: wantsStartedList || therapeuticFilter ? 500 : 120
          });
          if (!out.trialhubOverview) {
            out.trialhubOverview = {
              totalCount: null,
              note: "Overview sample skipped — use trialhubStartedTrials for this year/TA ask."
            };
          }
        }
      }
      if (needFeedOverview || wantsVeeva) {
        out.veevaOverview = await veevaOverview(database);
      }
      if (needFeedOverview || wantsCrosswalk) {
        out.crosswalkOverview = await crosswalkOverview(database);
      }
    }

    if (enrollmentPlan && (enrollmentPlan.sitesExact != null || enrollmentPlan.patients || enrollmentPlan.months)) {
      out.enrollmentPlan = enrichEnrollmentPlanWithBenchmark(
        enrollmentPlan,
        out.indicationBenchmark
      );
      if (out.query) out.query.enrollmentPlan = out.enrollmentPlan;
    } else if (
      out.indicationBenchmark &&
      (/\bpsm\b|patients?\s*per\s*site|enrol(?:l)?ment\s+rate|how\s+fast|sites?\s+needed/i.test(
        question
      ) ||
        siteListLimitAsked)
    ) {
      // PSM / site-count ask with no patients/months yet — still surface the benchmark PSM to calculate from
      const filled = enrichEnrollmentPlanWithBenchmark(
        { patients: null, months: null, psm: null },
        out.indicationBenchmark
      );
      if (filled?.psm != null) {
        out.enrollmentPlan = {
          ...filled,
          note: "PSM filled from indicationBenchmark median — use for site math when the user gives patients/months, or cite as the indication PSM."
        };
        if (out.query) out.query.enrollmentPlan = out.enrollmentPlan;
      }
    }

    const who = sponsor || clientName;
    if (who) {
      out.sponsorCrosswalk = await lookupSponsorCrosswalk(database, who);
    }

    // Always attach Salesforce mirrors when available (Buddy must not fall back to portfolio.byClient for CRM).
    try {
      const { attachSalesforceData } = require("./salesforceTables");
      await attachSalesforceData(out, getDb, {
        question,
        clientName: who || clientName,
        sponsor: who || sponsor
      });
    } catch (sfErr) {
      out.salesforceData = { error: String(sfErr.message || sfErr) };
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

/**
 * Site scorecard from live ora_veeva_* (milestone PSM).
 * source=ora → Ora scores only
 * source=compare → Ora score + industry (TrialHub country) score side-by-side
 */
async function buildSiteScorecard(getDb, opts = {}) {
  const indication = String(opts.indication || "").trim() || null;
  const countries = opts.global ? null : parseCountryFilter(opts.countries || opts.country);
  const rawSource = String(opts.source || "ora").toLowerCase();
  const source =
    rawSource === "all" || rawSource === "compare" || rawSource === "industry"
      ? "compare"
      : "ora";
  const includeLegacy = Boolean(opts.includeLegacy);
  const aliases = indication ? indicationAliases(indication) : [];
  const related = indication ? relatedIndicationLabels(indication) : [];
  const preferred = indication ? preferredIndicationLabel(indication) || indication : null;
  const database = getDb();
  const started = Date.now();

  if (!indication && !countries) {
    return { error: "indication and/or country is required", source };
  }

  const siteRows = [];
  const mergeSite = (r) => {
    if (!r) return;
    if (preferred && r.indication && !indicationCompatible(r.indication, preferred, aliases)) {
      const relatedOk = related.some((rel) =>
        indicationCompatible(r.indication, rel, indicationAliases(rel))
      );
      if (!relatedOk) return;
    }
    const org = r.org_clean || r.organization;
    if (!org) return;
    if (countries && !countriesMatch(r.country, countries)) return;
    const key = `${org}||${r.country || "_unknown"}||${r.study_name || ""}||${r.site_psm || ""}`;
    if (siteRows.some((x) => `${x.org_clean || x.organization}||${x.country || "_unknown"}||${x.study_name || ""}||${x.site_psm || ""}` === key)) {
      return;
    }
    siteRows.push(r);
  };

  const { loadVeevaLiveFeasibility } = require("./veevaLiveIntel");
  let pack = { sites: [] };
  try {
    pack = await loadVeevaLiveFeasibility(database);
  } catch (err) {
    return {
      source,
      error: String(err.message || err),
      note: "Failed to load ora_veeva_* for scorecard."
    };
  }

  const liveSites = pack.sites || [];
  // Prefer sites with positive PSM, then fill with null-PSM rows
  for (const r of liveSites) {
    if (typeof r.site_psm === "number" && r.site_psm > 0) mergeSite(r);
  }
  if (!siteRows.length) {
    for (const r of liveSites) mergeSite(r);
  }

  // Aggregate by org_clean + country
  const byKey = new Map();
  for (const r of siteRows) {
    const org = r.org_clean || r.organization;
    if (!org) continue;
    const key = `${org}||${r.country || "_unknown"}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        org_clean: org,
        country: r.country || "_unknown",
        studyCount: 0,
        psms: [],
        enrolled: [],
        months: [],
        sfr: [],
        highTrust: 0,
        trustHigh: 0,
        trustLow: 0,
        trustMedium: 0,
        trustUnknown: 0,
        indications: new Set()
      };
      byKey.set(key, g);
    }
    g.studyCount += 1;
    if (typeof r.site_psm === "number" && r.site_psm > 0) g.psms.push(r.site_psm);
    if (typeof r.total_enrolled === "number" && r.total_enrolled > 0) g.enrolled.push(r.total_enrolled);
    if (typeof r.site_enroll_months === "number" && r.site_enroll_months > 0) g.months.push(r.site_enroll_months);
    if (typeof r.screen_fail_rate === "number" && r.screen_fail_rate >= 0) g.sfr.push(r.screen_fail_rate);
    const trust = String(r.fsi_trust || "")
      .trim()
      .toLowerCase();
    if (trust === "high") g.trustHigh += 1;
    else if (trust === "low") g.trustLow += 1;
    else if (trust === "medium" || trust === "med" || trust === "moderate") g.trustMedium += 1;
    else g.trustUnknown += 1;
    if (r.indication) g.indications.add(r.indication);
  }

  const aggregates = [...byKey.values()].map((g) => {
    const trustKnown = g.trustHigh + g.trustLow + g.trustMedium;
    const highTrustShare = trustKnown > 0 ? round(g.trustHigh / trustKnown, 3) : null;
    return {
      org_clean: g.org_clean,
      country: g.country,
      studyCount: g.studyCount,
      sitePsmMedian: round(median(g.psms)),
      totalEnrolledSum: g.enrolled.reduce((a, b) => a + b, 0) || null,
      enrollMonthsMedian: round(median(g.months), 2),
      screenFailMedian: round(median(g.sfr), 3),
      highTrustShare,
      trustHigh: g.trustHigh,
      trustLow: g.trustLow,
      trustMedium: g.trustMedium,
      trustUnknown: g.trustUnknown,
      trustKnown,
      trustHighOfKnown: trustKnown > 0 ? `${g.trustHigh}/${trustKnown}` : null,
      indications: [...g.indications].slice(0, 6)
    };
  });

  const psmVals = aggregates.map((a) => a.sitePsmMedian).filter((n) => typeof n === "number");
  const volVals = aggregates.map((a) => a.totalEnrolledSum).filter((n) => typeof n === "number");
  const sfrVals = aggregates.map((a) => a.screenFailMedian).filter((n) => typeof n === "number");
  const psmMin = Math.min(...(psmVals.length ? psmVals : [0]));
  const psmMax = Math.max(...(psmVals.length ? psmVals : [1]));
  const volMin = Math.min(...(volVals.length ? volVals : [0]));
  const volMax = Math.max(...(volVals.length ? volVals : [1]));
  const sfrMin = Math.min(...(sfrVals.length ? sfrVals : [0]));
  const sfrMax = Math.max(...(sfrVals.length ? sfrVals : [1]));

  function normAsc(v, lo, hi) {
    if (v == null || hi === lo) return 50;
    return Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  }
  function normDesc(v, lo, hi) {
    if (v == null || hi === lo) return 50;
    return Math.max(0, Math.min(100, (1 - (v - lo) / (hi - lo)) * 100));
  }

  // Industry by country (compare mode) — TrialHub country medians
  const industryByCountry = {};
  const thLabels = [...new Set([...aliases.slice(0, 4), ...related.slice(0, 3)])];
  if (source === "compare" && thLabels.length) {
    for (const alias of thLabels) {
      const thRows = await queryAll(
        database.container("ora_trialhub_trials"),
        `SELECT c.countries, c.psm_common, c.th_actual_psm, c.status
         FROM c WHERE c.docType = @t AND c.indication = @ind`,
        [
          { name: "@t", value: "ora_trialhub_trials" },
          { name: "@ind", value: alias }
        ]
      );
      for (const t of thRows) {
        const list = parseCountryList(t.countries);
        const psm =
          typeof t.psm_common === "number" && t.psm_common > 0 && t.psm_common < 500
            ? t.psm_common
            : typeof t.th_actual_psm === "number" && t.th_actual_psm > 0 && t.th_actual_psm < 500
              ? t.th_actual_psm
              : null;
        const recruiting = /recruit/i.test(String(t.status || ""));
        for (const cRaw of list) {
          const c = normalizeCountryName(cRaw);
          if (!c) continue;
          if (countries && !countries.includes(c)) continue;
          if (!industryByCountry[c]) industryByCountry[c] = { psms: [], recruiting: 0, trials: 0 };
          industryByCountry[c].trials += 1;
          if (psm != null) industryByCountry[c].psms.push(psm);
          if (recruiting) industryByCountry[c].recruiting += 1;
        }
      }
    }
  }

  const industryCountryMedians = Object.values(industryByCountry)
    .map((x) => median(x.psms))
    .filter((n) => typeof n === "number" && n > 0);
  const indPsmMin = Math.min(...(industryCountryMedians.length ? industryCountryMedians : [0]));
  const indPsmMax = Math.max(...(industryCountryMedians.length ? industryCountryMedians : [1]));

  const scored = aggregates.map((a) => {
    const psmScore = normAsc(a.sitePsmMedian, psmMin, psmMax);
    const volScore = normAsc(a.totalEnrolledSum, volMin, volMax);
    const sfrScore = normDesc(a.screenFailMedian, sfrMin, sfrMax);
    let trustScore = 50;
    if (a.trustKnown > 0 && a.highTrustShare != null) {
      const raw = a.highTrustShare * 100;
      const w = Math.min(1, a.trustKnown / 3);
      trustScore = round(50 + (raw - 50) * w, 1);
    }
    const oraScore = round(
      0.4 * psmScore + 0.25 * volScore + 0.2 * sfrScore + 0.15 * trustScore,
      1
    );
    const industry = industryByCountry[a.country] || null;
    const industryMedianPsm = industry ? round(median(industry.psms)) : null;
    const recruitingTrials = industry ? industry.recruiting : null;
    const industryScore =
      source === "compare" && industryMedianPsm != null
        ? round(normAsc(industryMedianPsm, indPsmMin, indPsmMax), 1)
        : null;
    let vsIndustryRatio = null;
    let scoreDelta = null;
    if (source === "compare" && industryMedianPsm != null && a.sitePsmMedian != null && industryMedianPsm > 0) {
      vsIndustryRatio = round(a.sitePsmMedian / industryMedianPsm, 2);
    }
    if (source === "compare" && industryScore != null) {
      scoreDelta = round(oraScore - industryScore, 1);
    }
    const monthlyCapacity =
      typeof a.sitePsmMedian === "number" && a.sitePsmMedian > 0
        ? a.sitePsmMedian
        : a.totalEnrolledSum && a.enrollMonthsMedian
          ? round(a.totalEnrolledSum / a.enrollMonthsMedian, 3)
          : null;
    return {
      ...a,
      score: oraScore,
      oraScore,
      industryScore,
      scoreDelta,
      components: {
        psm: round(psmScore, 1),
        volume: round(volScore, 1),
        screenFail: round(sfrScore, 1),
        trust: round(trustScore, 1)
      },
      industryMedianPsm: source === "compare" ? industryMedianPsm : undefined,
      recruitingTrials: source === "compare" ? recruitingTrials : undefined,
      vsIndustry: source === "compare" ? vsIndustryRatio : undefined,
      monthlyCapacity,
      dataSource: "veeva"
    };
  });

  scored.sort((a, b) => (b.oraScore || b.score || 0) - (a.oraScore || a.score || 0));

  let sites = scored.slice(0, 80);
  let legacyMeta = null;
  if (includeLegacy) {
    try {
      const { enrichSitesWithLegacy } = require("./legacyAnterior");
      const enriched = await enrichSitesWithLegacy(database, sites, {
        indication,
        indicationAliases: aliases
      });
      sites = enriched.sites;
      legacyMeta = enriched.meta;
    } catch (err) {
      legacyMeta = { error: String(err.message || err) };
    }
  }

  const usedRelated = related.length && aliases.every((a) => !siteRows.some((r) => r.indication === a));
  return {
    source,
    indication,
    countries: countries,
    countryFilterLabel: countries ? countries.join(", ") : "Global",
    aliasesUsed: aliases,
    relatedIndicationsQueried: related.length ? related : undefined,
    siteCount: sites.length,
    includeLegacy,
    legacy: legacyMeta,
    weights: { psm: 0.4, volume: 0.25, screenFail: 0.2, trust: 0.15 },
    trustNote:
      "Trust = share of Veeva rows with a known fsi_trust label that are \"high\" (missing labels excluded). Display is high/known. Score component shrinks toward neutral when fewer than 3 labeled studies — a single high row is not 100% trust weight.",
    note:
      sites.length === 0
        ? `No Ora Veeva site rows matched "${indication || "filter"}". Try a broader indication (e.g. Glaucoma) or Global geography.`
        : usedRelated || related.length
          ? `Matched via related/fuzzy Veeva labels when exact "${indication}" had few/no site_psm rows. Ora scores from ora_veeva_* (milestone PSM).`
          : source === "ora"
            ? "Ora scores from live Veeva site history (ora_veeva_site + FSI→LSI milestones)."
            : "Ora site score vs industry country score (TrialHub PSM by country). Industry has no named competitor sites — country-level benchmark only.",
    sites,
    elapsedMs: Date.now() - started
  };
}

/** Legacy recruitment board (optionally filtered by indication). */
async function buildLegacyRecruitmentBoard(getDb, opts = {}) {
  const started = Date.now();
  const database = await getDb();
  const indication = String(opts.indication || "").trim() || null;
  const aliases = indication ? indicationAliases(indication) : [];
  try {
    const { enrichSitesWithLegacy } = require("./legacyAnterior");
    const enriched = await enrichSitesWithLegacy(database, [], {
      indication,
      indicationAliases: aliases
    });
    return {
      includeLegacy: true,
      legacyOnly: true,
      indication,
      aliasesUsed: aliases,
      siteCount: 0,
      sites: [],
      legacy: enriched.meta,
      note: indication
        ? `Legacy anterior-segment sites for indication "${indication}" (matched via study indication).`
        : "Legacy anterior-segment sites ranked by enrolled. Pass an indication (e.g. Dry Eye) to filter.",
      elapsedMs: Date.now() - started
    };
  } catch (err) {
    return {
      includeLegacy: true,
      legacyOnly: true,
      indication,
      siteCount: 0,
      sites: [],
      legacy: { error: String(err.message || err) },
      elapsedMs: Date.now() - started
    };
  }
}

module.exports = {
  DATASET,
  INDICATION_GROUPS,
  INDICATION_UI_LABELS,
  isIntelligenceQuestion,
  isCtgovQuestion,
  isTrialhubQuestion,
  isVeevaQuestion,
  isCrosswalkQuestion,
  isSalesforceDataQuestion,
  isSourceOverviewQuestion,
  extractYearFromQuestion,
  extractTherapeuticFilterFromQuestion,
  trialhubStartedTrialsQuery,
  trialhubStartsInYearStats,
  indicationAliases,
  indicationFamily,
  indicationCompatible,
  resolveIndicationGroup,
  canonicalIndicationFromVaultPicklist,
  phraseIncludes,
  extractIndicationFromQuestion,
  extractCountryFromQuestion,
  normalizeCountryName,
  parseCountryFilter,
  getIntelligenceHealth,
  buildIntelligenceContext,
  buildReconciliationIntelContext,
  buildDefaultBuddyIntelContext,
  buildSlimBuddyIntelContext,
  buildSiteScorecard,
  buildLegacyRecruitmentBoard,
  benchmarkIndication,
  queryStartupTimelines,
  lookupSponsorCrosswalk,
  preferredIndicationLabel,
  indicationContainsNeedles,
  extractEnrollmentPlan,
  extractSiteListLimit,
  enrichEnrollmentPlanWithBenchmark,
  wantsOusOnly,
  rankCountriesFromTrials
};
