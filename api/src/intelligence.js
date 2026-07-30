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
  [
    "Dry Eye",
    "Dry Eye Disease",
    "DED",
    "Keratoconjunctivitis Sicca",
    "Devices-Dry Eye",
    "Devices - Dry Eye"
  ],
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
    "OHT",
    "Devices - Glaucoma",
    "Devices-Glaucoma"
  ],
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
    "Optic Neuritis",
    "NAION",
    "LHON",
    "Leber Hereditary Optic Neuropathy",
    "Optic neuropathies POAG and NAION",
    "Optic neuropathies",
    "New: Leber Hereditary Optic Disease",
    "New: Optic Neuromyelitis Spectrum Disease"
  ],
  ["Uveitis", "Anterior Uveitis", "Intermediate Uveitis", "Posterior Uveitis", "Panuveitis"],
  ["Keratoconus"],
  [
    "Retinal Vein Occlusion",
    "RVO",
    "CRVO",
    "BRVO",
    "Central Retinal Vein Occlusion",
    "Branch Retinal Vein Occlusion",
    "Macular Edema due to Retinal Vein Occlusion (RVO)",
    "Macular Edema due to Retinal Vein Occlusion",
    "Retinal Vascular Diseases"
  ],
  ["Neurotrophic Keratitis", "Neurotrophic Keratopathy"],
  ["Meibomian Gland Dysfunction", "MGD"],
  [
    "Inherited Retinal Disease",
    "IRD",
    "Stargardt",
    "Stargardt Disease",
    "Stargardt's Disease",
    "Stargardt's",
    "Stargardt's Macular Dystrophy",
    "Stargardt Macular Dystrophy",
    "STGD1",
    "Stargardt Disease Type 1",
    "Leber Congenital Amaurosis",
    "Leber congenital amaurosis",
    "LCA",
    "Choroideremia",
    "Achromatopsia",
    "Best Disease",
    "X-linked Retinoschisis"
  ],
  [
    "Devices",
    "Devices-Diagnostic",
    "Devices - Other",
    "Devices - Glaucoma",
    "Devices-Glaucoma",
    "Devices-Dry Eye",
    "Devices - Dry Eye"
  ],
  ["Ocular Surface / Cornea", "Corneal Dystrophy", "Fuchs Endothelial Dystrophy", "Fuchs Dystrophy", "Infectious Keratitis"],
  ["Macular Hole / ERM", "Macular Hole", "Epiretinal Membrane", "ERM"],
  ["Central Serous Chorioretinopathy", "CSCR", "CSC"],
  ["Amblyopia"],
  ["Strabismus"],
  ["Uveal Melanoma", "Ocular Melanoma", "Choroidal Melanoma"],
  ["Safety", "Safety study"]
];

/** Preferred labels for UI pills (Intelligence + Scorecard). */
const INDICATION_UI_LABELS = INDICATION_GROUPS.map((g) => g[0]).filter((l) => l !== "Safety");

function normText(s) {
  return String(s || "")
    .toLowerCase()
    // Collapse possessives so Stargardt's ≈ stargardt
    .replace(/['’]s\b/g, "s")
    .replace(/['’]/g, "")
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
    /\b(which|best|top|recommend(?:ed)?|list|name|suggest)\b.{0,40}\b(sites?|countries|country)\b/.test(q) ||
    /\b(sites?|countries)\b.{0,40}\b(for|in|with|under|outside|ous)\b/.test(q) ||
    /\b(preferred|high[- ]performing|perform(?:ing)?)\s+sites?\b/.test(q) ||
    /\b(trialhub|trial hub|industry (benchmark|trial|psm)|nct\d*|clinicaltrials\.gov|ct\.gov|ctgov)\b/.test(q) ||
    /\b(screen[- ]?fail|dropout|recruit(ment)? (rate|days|benchmark))\b/.test(q) ||
    /\b(indication).{0,40}\b(benchmark|histor(y|ical)|industry|ora studies)\b/.test(q) ||
    /\b(how (fast|quickly)|typical).{0,40}\b(enroll|recruit|site)\b/.test(q) ||
    /\b(veeva|ora (histor|performance|sites?))\b/.test(q) ||
    /\b(country|countries|region|geography|united states|usa|uk|europe|eu|japan|china|canada|australia|ous|outside)\b/.test(
      q
    ) ||
    /\b(rfp|rfi|pricing|ballpark|goal bid|cost per patient)\b/.test(q) ||
    /\b\d+\s*patients?\b/.test(q)
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

function extractCountryFromQuestion(question) {
  const q = String(question || "");
  const lower = q.toLowerCase();
  if (/\b(global|worldwide|all countries)\b/.test(lower)) return null;
  // Longest alias keys first
  const keys = Object.keys(COUNTRY_ALIASES).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (new RegExp(`\\b${k.replace(/\s+/g, "\\s+")}\\b`, "i").test(lower)) return COUNTRY_ALIASES[k];
  }
  const m = q.match(
    /\b(?:in|for|across|country|region|geography)\s+([A-Za-z][A-Za-z .'-]{1,40?}?)(?:\s+for|\s+indication|\s+psm|\s+sites?|\?|$)/i
  );
  if (m) return normalizeCountryName(m[1]);
  return null;
}

function preferredIndicationLabel(matchedAlias) {
  const n = normText(matchedAlias);
  for (const group of INDICATION_GROUPS) {
    if (group.some((g) => normText(g) === n)) return group[0];
  }
  return matchedAlias;
}

function compactNorm(s) {
  return normText(s).replace(/\s+/g, "");
}

function extractIndicationFromQuestion(question) {
  const q = String(question || "");
  const qNorm = normText(q);
  const qCompact = compactNorm(q);
  // Prefer known labels (longest first); compactNorm so "neuro protection" ≈ Neuroprotection
  const labeled = INDICATION_GROUPS.flatMap((group) =>
    group.map((label) => ({ label, preferred: group[0], len: compactNorm(label).length }))
  ).sort((a, b) => b.len - a.len);
  for (const { label, preferred } of labeled) {
    const ln = normText(label);
    const lc = compactNorm(label);
    if (!lc || lc.length < 3) continue;
    if (
      qCompact.includes(lc) ||
      qNorm.includes(ln) ||
      q.toLowerCase().includes(label.toLowerCase())
    ) {
      return preferred;
    }
  }
  const m = q.match(/\b(?:indication|in)\s+([A-Za-z][A-Za-z0-9 /()-]{2,60})/i);
  if (!m) return null;
  const raw = m[1].trim().replace(/[?.!,;]+$/, "");
  return preferredIndicationLabel(raw) || raw;
}

/** Related Veeva/TrialHub labels when the asked indication is thin in Cosmos. */
function relatedIndicationLabels(indication) {
  const preferred = preferredIndicationLabel(indication) || String(indication || "").trim();
  const n = normText(preferred);
  if (n.includes("neuroprotect")) {
    return ["Glaucoma / Ocular Hypertension", "Optic Neuropathy", "Optic neuropathies POAG and NAION"];
  }
  if (n.includes("optic neuropath")) {
    return ["Glaucoma / Ocular Hypertension", "Neuroprotection"];
  }
  if (n.includes("dry eye")) {
    return ["Meibomian Gland Dysfunction", "Devices-Dry Eye"];
  }
  if (n.includes("meibomian")) {
    return ["Dry Eye", "Devices-Dry Eye"];
  }
  if (n.includes("wet amd") || n === "namd") {
    return ["Geographic Atrophy / Dry AMD"];
  }
  if (n.includes("geographic atrophy") || n.includes("dry amd")) {
    return ["Wet AMD"];
  }
  if (n.includes("glaucoma") || n.includes("ocular hypertension")) {
    return ["Optic Neuropathy", "Optic neuropathies POAG and NAION", "Devices - Glaucoma"];
  }
  return [];
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
  const out = { patients, months, psm };
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

function wantsOusOnly(question) {
  const q = String(question || "").toLowerCase();
  return /\b(ous|outside\s+(of\s+)?(the\s+)?u\.?s\.?a?|ex-?us|non-?us|exclud(?:e|ing)\s+(the\s+)?u\.?s|international\s+only|ex-america)\b/.test(
    q
  );
}

/** Substring needles for fuzzy Cosmos matches when exact indication equality is empty. */
function indicationContainsNeedles(indication) {
  const preferred = preferredIndicationLabel(indication) || String(indication || "").trim();
  const n = normText(preferred);
  const needles = new Set();
  if (n.includes("neuroprotect")) {
    needles.add("neuroprotect");
    needles.add("neuro protection");
    // Veeva often files neuroprotection under optic neuropathy / glaucoma labels
    needles.add("optic neuropath");
    needles.add("naion");
  }
  if (n.includes("optic neuropath") || n === "optic neuropathy") {
    needles.add("optic neuropath");
    needles.add("naion");
    needles.add("lhon");
  }
  if (n.includes("uveitis")) needles.add("uveitis");
  if (n.includes("retinal vein") || n === "rvo") {
    needles.add("retinal vein");
    needles.add("crvo");
    needles.add("brvo");
  }
  if (n.includes("meibomian") || n === "mgd") needles.add("meibomian");
  if (n.includes("inherited retinal") || n === "ird" || n.includes("stargardt")) {
    needles.add("stargardt");
    needles.add("inherited retinal");
    needles.add("choroideremia");
    needles.add("achromatopsia");
  }
  if (n.includes("wet amd") || n === "namd" || n.includes("geographic atrophy") || n.includes("dry amd")) {
    needles.add("macular degeneration");
    needles.add("geographic atrophy");
    needles.add("neovascular");
    needles.add("wet amd");
    needles.add("dry amd");
  }
  if (n.includes("glaucoma") || n.includes("ocular hypertension")) {
    needles.add("glaucoma");
    needles.add("ocular hypertension");
    needles.add("poag");
  }
  if (n.includes("dry eye") || n.includes("meibomian")) {
    needles.add("dry eye");
    needles.add("meibomian");
  }
  if (n.includes("retinal vein") || n === "rvo") {
    needles.add("retinal vein");
    needles.add("vein occlusion");
    needles.add("retinal vascular");
  }
  if (n.includes("diabetic retinopathy")) {
    needles.add("diabetic retinopathy");
    needles.add("proliferative diabetic");
  }
  // Always include a compact form of the preferred label (min length 5)
  if (preferred.replace(/[^a-zA-Z0-9]/g, "").length >= 5) {
    needles.add(preferred.slice(0, 40));
  }
  return [...needles];
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
  // Fixed packs (Veeva/crosswalk). TrialHub + CT.gov grow via upload/sync — not fixed expected.
  const expected = {
    ora_fact_site: 3613,
    ora_fact_study: 249,
    ora_sponsor_crosswalk: 642,
    ora_site_alias_table: 46
  };
  const liveCounts = {
    ora_trialhub_trials: counts.ora_trialhub_trials,
    ora_ctgov_trials: counts.ora_ctgov_trials
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
    liveCounts,
    trialhub: {
      count: counts.ora_trialhub_trials,
      note: "Grows via TrialHub .xlsx upload on this page — upsert by NCT, no duplicates."
    },
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

async function benchmarkIndication(database, indication, country = null, opts = {}) {
  const aliases = indicationAliases(indication);
  if (!aliases.length) return null;
  const countries = parseCountryFilter(country);
  const preferred = preferredIndicationLabel(indication) || indication;
  const ousOnly = Boolean(opts.ousOnly);
  const relatedLabels = relatedIndicationLabels(preferred);

  const studyContainer = database.container("ora_fact_study");
  const siteContainer = database.container("ora_fact_site");
  const thContainer = database.container("ora_trialhub_trials");

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
      if (!passesGeo(r.countries, null)) continue;
      mergeRow(oraStudies, r, (x) => x.study_number);
    }
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

  // Site PSM for aliases (cap scan — prefer high trust); optional country partition(s)
  const sitePsms = [];
  const topSites = [];
  const pushSites = (rows, { requirePsm = true } = {}) => {
    const sorted = [...rows].sort((a, b) => {
      const pa = typeof a.site_psm === "number" ? a.site_psm : -1;
      const pb = typeof b.site_psm === "number" ? b.site_psm : -1;
      if (pb !== pa) return pb - pa;
      return (Number(b.total_enrolled) || 0) - (Number(a.total_enrolled) || 0);
    });
    for (const r of sorted) {
      if (ousOnly && r.country && isUsCountryName(r.country)) continue;
      if (countries && !countriesMatch(r.country, countries)) continue;
      if (requirePsm && !(typeof r.site_psm === "number" && r.site_psm > 0)) continue;
      if (typeof r.site_psm === "number" && r.site_psm > 0) sitePsms.push(r.site_psm);
      if (topSites.length < 20 && r.org_clean) {
        if (!topSites.some((x) => x.org_clean === r.org_clean && x.country === r.country)) {
          topSites.push({
            org_clean: r.org_clean,
            country: r.country,
            indication: r.indication || null,
            site_psm: round(r.site_psm),
            total_enrolled: r.total_enrolled,
            fsi_trust: r.fsi_trust,
            study_name: r.study_name,
            rankedBy: typeof r.site_psm === "number" && r.site_psm > 0 ? "site_psm" : "total_enrolled_or_presence"
          });
        }
      }
    }
  };

  for (const alias of [...aliases, ...relatedLabels].slice(0, 6)) {
    const params = [
      { name: "@t", value: "ora_fact_site" },
      { name: "@ind", value: alias }
    ];
    let q = `SELECT TOP 200 c.org_clean, c.organization, c.country, c.indication, c.phase,
              c.site_psm, c.total_enrolled, c.site_enroll_months, c.fsi_trust, c.study_name
       FROM c WHERE c.docType = @t AND c.indication = @ind AND IS_DEFINED(c.site_psm) AND c.site_psm > 0`;
    const geo = countrySqlClause("c.country", countries, "geo");
    q += geo.sql;
    params.push(...geo.params);
    pushSites(await queryAll(siteContainer, q, params), { requirePsm: true });
  }

  // Fuzzy CONTAINS — always run for known needles (Veeva indication is free-text; exact-only misses variants)
  let fuzzyUsed = [];
  {
    const needles = indicationContainsNeedles(preferred);
    for (const needle of needles.slice(0, 6)) {
      if (!needle || needle.length < 4) continue;
      fuzzyUsed.push(needle);
      {
        const rows = await queryAll(
          studyContainer,
          `SELECT TOP 80 c.study_number, c.sponsor, c.indication, c.phase, c.psm, c.study_rate_pt_mo,
                  c.total_enrolled, c.enroll_months, c.n_contributing_sites, c.screen_fail_rate_recomputed,
                  c.lifecycle_state, c.countries
           FROM c WHERE c.docType = @t AND CONTAINS(LOWER(c.indication), @n)`,
          [
            { name: "@t", value: "ora_fact_study" },
            { name: "@n", value: needle.toLowerCase() }
          ]
        );
        for (const r of rows) {
          if (!passesGeo(r.countries, null)) continue;
          mergeRow(oraStudies, r, (x) => x.study_number);
        }
      }
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
          mergeRow(thTrials, r, (x) => x.nct);
        }
      }
      {
        const params = [
          { name: "@t", value: "ora_fact_site" },
          { name: "@n", value: needle.toLowerCase() }
        ];
        // Include null-PSM rows — Stargardt / IRD / neuroprotection often lack site_psm
        let q = `SELECT TOP 200 c.org_clean, c.organization, c.country, c.indication, c.phase,
                  c.site_psm, c.total_enrolled, c.site_enroll_months, c.fsi_trust, c.study_name
           FROM c WHERE c.docType = @t AND CONTAINS(LOWER(c.indication), @n)`;
        const geo = countrySqlClause("c.country", countries, "geo");
        q += geo.sql;
        params.push(...geo.params);
        pushSites(await queryAll(siteContainer, q, params), { requirePsm: false });
      }
    }
  }

  // Still empty on PSM sites? pull related-label sites without PSM filter
  if (!topSites.length) {
    for (const alias of relatedLabels.slice(0, 4)) {
      const params = [
        { name: "@t", value: "ora_fact_site" },
        { name: "@ind", value: alias }
      ];
      let q = `SELECT TOP 200 c.org_clean, c.organization, c.country, c.indication, c.phase,
                c.site_psm, c.total_enrolled, c.site_enroll_months, c.fsi_trust, c.study_name
         FROM c WHERE c.docType = @t AND c.indication = @ind`;
      const geo = countrySqlClause("c.country", countries, "geo2");
      q += geo.sql;
      params.push(...geo.params);
      pushSites(await queryAll(siteContainer, q, params), { requirePsm: false });
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
          ? "Veeva has studies for this indication but site/study PSM is missing (null ≠ 0). List study_number, sponsor, enrolled — do NOT say there is no Veeva data."
          : oraStudies.length
            ? "From ora_fact_study (Veeva). Prefer median PSM when studiesWithPsm > 0."
            : "No ora_fact_study rows matched aliases / CONTAINS needles.",
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
      topSitesByPsm: sitesWithPsm.slice(0, 15),
      topSites: topSites.slice(0, 15),
      topOusSites: ousSites.slice(0, 15),
      countryFilter: countries,
      countryFilterLabel: countries ? countries.join(", ") : ousOnly ? "OUS (ex-US)" : "Global",
      note: sitesWithPsm.length
        ? "Ranked by site_psm when present."
        : topSites.length
          ? "No site_psm in Veeva for this indication — listed real org_clean rows ranked by total_enrolled / presence. This IS the site slate; do not say there is no leaderboard."
          : "No Ora Veeva site rows for this indication. Use trialhub.countryRank for OUS country priorities; do not invent PI names."
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
        for (const r of rows) merge(r);
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
  const nct = extractNct(question);
  const qIndication = extractIndicationFromQuestion(question);
  const ousOnly = wantsOusOnly(question);
  const enrollmentPlan = extractEnrollmentPlan(question);
  const resolvedCountries = global
    ? null
    : parseCountryFilter(countries != null ? countries : country) ||
      (() => {
        const fromQ = extractCountryFromQuestion(question);
        return fromQ ? [fromQ] : null;
      })();
  const resolvedIndication = indication || qIndication;

  // Skip entirely if nothing to hang a query on and question isn't intelligence-shaped
  if (!wantsIntel && !resolvedIndication && !nct && !clientName && !sponsor && !resolvedCountries) {
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
      enrollmentPlan
    }
  };

  try {
    if (nct) {
      out.nctLookup = await lookupNct(database, nct);
      out.ctgovNct = await lookupCtgovNct(database, nct);
    }

    if (resolvedIndication || wantsIntel || resolvedCountries || ousOnly) {
      const ind = resolvedIndication || qIndication;
      if (ind) {
        out.indicationBenchmark = await benchmarkIndication(database, ind, resolvedCountries, {
          ousOnly
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
        // Country-only: sample Ora sites in those countries
        const params = [{ name: "@t", value: "ora_fact_site" }];
        let q = `SELECT TOP 80 c.org_clean, c.country, c.indication, c.site_psm, c.total_enrolled, c.fsi_trust, c.study_name
           FROM c WHERE c.docType = @t AND IS_DEFINED(c.site_psm) AND c.site_psm > 0`;
        const geo = countrySqlClause("c.country", resolvedCountries, "geo");
        q += geo.sql;
        params.push(...geo.params);
        const rows = await queryAll(database.container("ora_fact_site"), q, params);
        const sorted = [...rows].sort((a, b) => (b.site_psm || 0) - (a.site_psm || 0));
        out.countrySites = {
          countries: resolvedCountries,
          country: resolvedCountries.join(", "),
          sampleCount: sorted.length,
          topSites: sorted.slice(0, 12).map((s) => ({
            org_clean: s.org_clean,
            country: s.country,
            indication: s.indication,
            site_psm: round(s.site_psm),
            total_enrolled: s.total_enrolled,
            fsi_trust: s.fsi_trust,
            study_name: s.study_name
          }))
        };
      }
    }

    if (enrollmentPlan && (enrollmentPlan.sitesExact != null || enrollmentPlan.patients)) {
      out.enrollmentPlan = enrollmentPlan;
    }

    const who = sponsor || clientName;
    if (who) {
      out.sponsorCrosswalk = await lookupSponsorCrosswalk(database, who);
    }

    if (wantsIntel && !out.indicationBenchmark && !out.nctLookup && !out.countrySites) {
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

/**
 * Site scorecard from Veeva (ora_fact_site).
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
    const org = r.org_clean || r.organization;
    if (!org) return;
    const key = `${org}||${r.country || "_unknown"}||${r.study_name || ""}||${r.site_psm || ""}`;
    if (siteRows.some((x) => `${x.org_clean || x.organization}||${x.country || "_unknown"}||${x.study_name || ""}||${x.site_psm || ""}` === key)) {
      return;
    }
    siteRows.push(r);
  };

  const querySites = async ({ exactInd, containsNeedle, requirePsm }) => {
    const params = [{ name: "@t", value: "ora_fact_site" }];
    let q = `SELECT TOP 400 c.org_clean, c.organization, c.country, c.indication, c.phase,
              c.site_psm, c.total_enrolled, c.site_enroll_months, c.fsi_trust, c.screen_fail_rate, c.study_name
       FROM c WHERE c.docType = @t`;
    if (requirePsm) q += ` AND IS_DEFINED(c.site_psm) AND c.site_psm > 0`;
    if (exactInd) {
      q += ` AND c.indication = @ind`;
      params.push({ name: "@ind", value: exactInd });
    } else if (containsNeedle) {
      q += ` AND CONTAINS(LOWER(c.indication), @n)`;
      params.push({ name: "@n", value: String(containsNeedle).toLowerCase() });
    }
    const geo = countrySqlClause("c.country", countries, "geo");
    q += geo.sql;
    params.push(...geo.params);
    const rows = await queryAll(database.container("ora_fact_site"), q, params);
    for (const r of rows) mergeSite(r);
  };

  const indList = aliases.length ? aliases.slice(0, 6) : [null];
  for (const alias of indList) {
    await querySites({ exactInd: alias, requirePsm: true });
  }
  // Related labels (e.g. Neuroprotection → Optic neuropathies / Glaucoma)
  if (!siteRows.length && related.length) {
    for (const alias of related.slice(0, 4)) {
      await querySites({ exactInd: alias, requirePsm: true });
    }
  }
  // Fuzzy CONTAINS when Veeva labels don't match pill names
  if (!siteRows.length && preferred) {
    for (const needle of indicationContainsNeedles(preferred).slice(0, 5)) {
      await querySites({ containsNeedle: needle, requirePsm: true });
    }
  }
  // Last resort: include null-PSM site rows so pills aren't empty
  if (!siteRows.length && (aliases.length || related.length || preferred)) {
    for (const alias of [...aliases, ...related].slice(0, 6)) {
      await querySites({ exactInd: alias, requirePsm: false });
    }
    if (!siteRows.length && preferred) {
      for (const needle of indicationContainsNeedles(preferred).slice(0, 4)) {
        await querySites({ containsNeedle: needle, requirePsm: false });
      }
    }
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
          ? `Matched via related/fuzzy Veeva labels when exact "${indication}" had few/no site_psm rows. Ora scores from ora_fact_site.`
          : source === "ora"
            ? "Ora scores from Veeva site history (ora_fact_site)."
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
  indicationAliases,
  extractIndicationFromQuestion,
  extractCountryFromQuestion,
  normalizeCountryName,
  parseCountryFilter,
  getIntelligenceHealth,
  buildIntelligenceContext,
  buildSiteScorecard,
  buildLegacyRecruitmentBoard,
  benchmarkIndication,
  lookupSponsorCrosswalk,
  preferredIndicationLabel,
  indicationContainsNeedles,
  extractEnrollmentPlan,
  wantsOusOnly,
  rankCountriesFromTrials
};
