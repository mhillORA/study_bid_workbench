/**
 * Learn sheet + field aliases from successful parses and quarantine logs.
 * Stored in Cosmos container `parseLearnings` (doc id parse-learnings-v1).
 */

const { CANONICAL_FIELDS, normAlias, resolveCanonicalKey } = require("./fieldRegistry");

const LEARNINGS_ID = "parse-learnings-v1";

/** Built-in extras for older Ora budget filenames / sheet titles. */
const BUILTIN_SHEET_EXTRAS = {
  "Input Tab": [
    "Inputs",
    "Input",
    "Study Inputs",
    "Specifications",
    "Main Specs",
    "Study Assumptions",
    "Assumptions",
    "RFP Inputs",
    "Bid Inputs"
  ],
  "Internal Budget": [
    "Ora Budget",
    "Model Budget",
    "Line Items",
    "Task Budget",
    "Labor Budget",
    "Hours Budget",
    "Fee Schedule",
    "Pricing"
  ],
  "Exec Sum": [
    "Exec Summary",
    "Executive Sum",
    "Summary",
    "Economics",
    "Study Summary",
    "Bid Summary",
    "Financial Summary"
  ],
  Key: ["Rate Key", "Rates", "Rate Card", "Resource Rates", "Key Rates"]
};

let cache = null;
let cacheAt = 0;
const CACHE_MS = 60_000;

function emptyLearnings() {
  return {
    id: LEARNINGS_ID,
    docType: "parseLearnings",
    sheetAliases: {}, // canonical -> [sheetName, ...]
    fieldAliases: {}, // canonicalKey -> [alias, ...]
    proposals: {
      sheets: {}, // `${canon}||${sheet}` -> { count, examples[] }
      fields: {} // `${canon}||${alias}` -> { count, examples[] }
    },
    stats: { loads: 0, quarantines: 0, autoPromoted: 0 },
    updatedAt: null
  };
}

async function ensureLearningsContainer(getDb) {
  const database = getDb();
  try {
    await database.containers.createIfNotExists({
      id: "parseLearnings",
      partitionKey: { paths: ["/id"] }
    });
  } catch (_) {
    /* container may already exist or account may disallow create — read/upsert will surface errors */
  }
}

async function loadLearnings(getDb) {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  try {
    await ensureLearningsContainer(getDb);
    const database = getDb();
    const { resource } = await database.container("parseLearnings").item(LEARNINGS_ID, LEARNINGS_ID).read();
    cache = resource || emptyLearnings();
  } catch (_) {
    cache = emptyLearnings();
  }
  cacheAt = Date.now();
  return cache;
}

async function saveLearnings(getDb, doc) {
  await ensureLearningsContainer(getDb);
  const database = getDb();
  doc.updatedAt = new Date().toISOString();
  doc.id = LEARNINGS_ID;
  doc.docType = "parseLearnings";
  await database.container("parseLearnings").items.upsert(doc);
  cache = doc;
  cacheAt = Date.now();
  return doc;
}

/** Build learnHints for a parse (attached to canonical + quarantine docs). */
function buildLearnHints(canonical) {
  const proposedSheets = [];
  const proposedFields = [];
  const missing = canonical?.fingerprint?.missingSheets || [];
  const sheetNames = (canonical?.sheetInventory || []).map((s) => (typeof s === "string" ? s : s.name)).filter(Boolean);

  for (const sheet of sheetNames) {
    const guess = guessSheetCanonical(sheet);
    if (!guess) continue;
    if (missing.includes(guess) || !(canonical?.fingerprint?.resolvedSheets || {})[guess]) {
      proposedSheets.push({ canonical: guess, sheetName: sheet, reason: "name_heuristic" });
    }
  }

  const seen = new Set();
  for (const f of canonical?.study?.inputFields || []) {
    if (f.normalized && f.canonicalKey) continue;
    const label = f.label || f.key;
    const guess = guessFieldCanonical(label);
    if (!guess) continue;
    const k = `${guess}||${normAlias(label)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    proposedFields.push({ canonicalKey: guess, alias: normAlias(label), label, reason: "label_fuzzy" });
  }

  return {
    proposedSheets,
    proposedFields,
    unmatchedFieldCount: (canonical?.study?.inputFields || []).filter((f) => !f.normalized).length
  };
}

function bumpProposal(bag, key, example) {
  if (!bag[key]) bag[key] = { count: 0, examples: [] };
  bag[key].count += 1;
  if (example && bag[key].examples.length < 8 && !bag[key].examples.includes(example)) {
    bag[key].examples.push(example);
  }
}

function promoteReady(learnings, minCount = 2) {
  let promoted = 0;
  for (const [key, meta] of Object.entries(learnings.proposals.sheets || {})) {
    if (!meta || meta.count < minCount) continue;
    const [canon, sheet] = key.split("||");
    if (!canon || !sheet) continue;
    if (!learnings.sheetAliases[canon]) learnings.sheetAliases[canon] = [];
    if (!learnings.sheetAliases[canon].includes(sheet)) {
      learnings.sheetAliases[canon].push(sheet);
      promoted += 1;
    }
  }
  for (const [key, meta] of Object.entries(learnings.proposals.fields || {})) {
    if (!meta || meta.count < minCount) continue;
    const [canon, alias] = key.split("||");
    if (!canon || !alias || !CANONICAL_FIELDS[canon]) continue;
    if (!learnings.fieldAliases[canon]) learnings.fieldAliases[canon] = [];
    if (!learnings.fieldAliases[canon].includes(alias)) {
      learnings.fieldAliases[canon].push(alias);
      promoted += 1;
    }
  }
  learnings.stats.autoPromoted = (learnings.stats.autoPromoted || 0) + promoted;
  return promoted;
}

/** Fuzzy: sheet name looks like a canonical role. */
function guessSheetCanonical(sheetName) {
  const low = String(sheetName || "").toLowerCase();
  if (!low) return null;
  if (/(^|\b)(input|inputs|spec|assumption|study spec)/.test(low) && !/budget|cost|exec|sum|key|rate/.test(low)) {
    return "Input Tab";
  }
  if (/(budget|cost breakdown|line item|labor|fee schedule|pricing|ora model)/.test(low) && !/exec|summary|economics/.test(low)) {
    return "Internal Budget";
  }
  if (/(exec|economics|summary|financial sum)/.test(low)) return "Exec Sum";
  if (/(^|\b)(key|rate card|rates)\b/.test(low)) return "Key";
  return null;
}

/** Suggest canonical field for an unmatched label. */
function guessFieldCanonical(label) {
  const n = normAlias(label);
  if (!n || n.length < 3) return null;
  const direct = resolveCanonicalKey(n);
  if (direct) return direct;

  let best = null;
  let bestScore = 0;
  for (const [canon, meta] of Object.entries(CANONICAL_FIELDS)) {
    const aliases = [canon, ...(meta.aliases || [])].map(normAlias);
    for (const a of aliases) {
      if (!a) continue;
      let score = 0;
      if (n === a) score = 100;
      else if (n.includes(a) || a.includes(n)) score = 70 + Math.min(20, Math.min(n.length, a.length));
      else {
        // token overlap
        const nt = new Set(n.split(/[^a-z0-9]+/).filter(Boolean));
        const at = new Set(a.split(/[^a-z0-9]+/).filter(Boolean));
        let overlap = 0;
        for (const t of nt) if (at.has(t)) overlap += 1;
        if (overlap >= 2) score = 40 + overlap * 10;
      }
      if (score > bestScore) {
        bestScore = score;
        best = canon;
      }
    }
  }
  return bestScore >= 55 ? best : null;
}

function mergeSheetAliasOptions(baseAliases, learnings) {
  const out = {};
  for (const [canon, list] of Object.entries(baseAliases || {})) {
    const extras = BUILTIN_SHEET_EXTRAS[canon] || [];
    const learned = (learnings && learnings.sheetAliases && learnings.sheetAliases[canon]) || [];
    out[canon] = [...new Set([...(list || []), ...extras, ...learned])];
  }
  return out;
}

function learnedFieldAliasIndex(learnings) {
  const map = new Map();
  if (!learnings || !learnings.fieldAliases) return map;
  for (const [canon, aliases] of Object.entries(learnings.fieldAliases)) {
    for (const a of aliases || []) {
      map.set(normAlias(a), canon);
    }
  }
  return map;
}

function resolveCanonicalWithLearnings(labelOrKey, learnings) {
  const base = resolveCanonicalKey(labelOrKey);
  if (base) return base;
  const idx = learnedFieldAliasIndex(learnings);
  const raw = String(labelOrKey || "");
  const stripped = raw.replace(/^(input|driver|side|section):/i, "");
  return idx.get(normAlias(stripped)) || idx.get(normAlias(raw)) || null;
}

/**
 * After a quarantine write — propose sheet/field learnings from fingerprint + harvest labels.
 */
async function learnFromQuarantine(getDb, canonical) {
  const learnings = await loadLearnings(getDb);
  learnings.stats.quarantines = (learnings.stats.quarantines || 0) + 1;

  const fileName = canonical?.source?.fileName || "unknown";
  const hints = canonical.learnHints || buildLearnHints(canonical);

  for (const p of hints.proposedSheets || []) {
    if (p.canonical && p.sheetName) {
      bumpProposal(learnings.proposals.sheets, `${p.canonical}||${p.sheetName}`, fileName);
    }
  }
  for (const p of hints.proposedFields || []) {
    if (p.canonicalKey && p.alias) {
      bumpProposal(learnings.proposals.fields, `${p.canonicalKey}||${p.alias}`, fileName);
    }
  }

  // Fallback: mine sheet names + unmatched fields when hints empty
  if (!(hints.proposedSheets || []).length) {
    const missing = canonical?.fingerprint?.missingSheets || [];
    const sheetNames = (canonical?.sheetInventory || []).map((s) => (typeof s === "string" ? s : s.name)).filter(Boolean);
    for (const sheet of sheetNames) {
      const guess = guessSheetCanonical(sheet);
      if (!guess) continue;
      if (missing.includes(guess) || !(canonical?.fingerprint?.resolvedSheets || {})[guess]) {
        bumpProposal(learnings.proposals.sheets, `${guess}||${sheet}`, fileName);
      }
    }
  }
  if (!(hints.proposedFields || []).length) {
    for (const f of canonical?.study?.inputFields || []) {
      if (f.normalized && f.canonicalKey) continue;
      const label = f.label || f.key;
      const guess = guessFieldCanonical(label);
      if (!guess) continue;
      bumpProposal(learnings.proposals.fields, `${guess}||${normAlias(label)}`, fileName);
    }
  }

  const promoted = promoteReady(learnings, 2);
  await saveLearnings(getDb, learnings);
  return { promoted, learnings, hints };
}

/**
 * After a successful Cosmos load — reinforce resolved sheet names + normalized fields.
 */
async function learnFromSuccess(getDb, canonical) {
  const learnings = await loadLearnings(getDb);
  learnings.stats.loads = (learnings.stats.loads || 0) + 1;
  const fileName = canonical?.source?.fileName || "unknown";
  const resolved = canonical?.fingerprint?.resolvedSheets || {};

  for (const [canon, actual] of Object.entries(resolved)) {
    if (!actual || actual === canon) continue;
    bumpProposal(learnings.proposals.sheets, `${canon}||${actual}`, fileName);
    if (!learnings.sheetAliases[canon]) learnings.sheetAliases[canon] = [];
    if (!learnings.sheetAliases[canon].includes(actual)) {
      // Promote immediately on successful load (high signal)
      learnings.sheetAliases[canon].push(actual);
      learnings.stats.autoPromoted = (learnings.stats.autoPromoted || 0) + 1;
    }
  }

  for (const f of canonical?.study?.inputFields || []) {
    if (!f.canonicalKey || !f.label) continue;
    const alias = normAlias(f.label);
    const known = (CANONICAL_FIELDS[f.canonicalKey]?.aliases || []).map(normAlias);
    if (known.includes(alias) || alias === normAlias(f.canonicalKey)) continue;
    bumpProposal(learnings.proposals.fields, `${f.canonicalKey}||${alias}`, fileName);
    if (!learnings.fieldAliases[f.canonicalKey]) learnings.fieldAliases[f.canonicalKey] = [];
    if (!learnings.fieldAliases[f.canonicalKey].includes(alias)) {
      learnings.fieldAliases[f.canonicalKey].push(alias);
      learnings.stats.autoPromoted = (learnings.stats.autoPromoted || 0) + 1;
    }
  }

  promoteReady(learnings, 2);
  await saveLearnings(getDb, learnings);
  return learnings;
}

function learningsSummary(doc) {
  if (!doc) return null;
  return {
    sheetAliasCount: Object.values(doc.sheetAliases || {}).reduce((n, a) => n + (a?.length || 0), 0),
    fieldAliasCount: Object.values(doc.fieldAliases || {}).reduce((n, a) => n + (a?.length || 0), 0),
    sheetProposals: Object.keys(doc.proposals?.sheets || {}).length,
    fieldProposals: Object.keys(doc.proposals?.fields || {}).length,
    stats: doc.stats || {},
    updatedAt: doc.updatedAt
  };
}

module.exports = {
  BUILTIN_SHEET_EXTRAS,
  loadLearnings,
  saveLearnings,
  mergeSheetAliasOptions,
  resolveCanonicalWithLearnings,
  learnFromQuarantine,
  learnFromSuccess,
  learningsSummary,
  buildLearnHints,
  guessSheetCanonical,
  guessFieldCanonical
};
