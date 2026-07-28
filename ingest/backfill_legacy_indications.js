/**
 * Backfill indication on legacy_studies (and optional oraIndication)
 * so Scorecard / Buddy can filter sites by the same indication vocabulary
 * as the budget tool (INDICATION_GROUPS).
 *
 * Usage (from repo root or api/):
 *   node ingest/backfill_legacy_indications.js --dry-run
 *   node ingest/backfill_legacy_indications.js
 */
const path = require("path");
const fs = require("fs");

// Prefer api/node_modules for @azure/cosmos
module.paths.unshift(path.join(__dirname, "..", "api", "node_modules"));
const { CosmosClient } = require("@azure/cosmos");

function loadEnv() {
  const p = path.join(__dirname, "..", ".env");
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** studyName (normalized) → budget-tool indication */
const STUDY_NAME_INDICATION = {
  adelphi: "Dry Eye",
  "adx 019": "Dry Eye",
  "adx 021": "Dry Eye",
  "adx 023": "Dry Eye",
  "adx 024": "Dry Eye",
  "adx 031": "Dry Eye",
  "adx 032": "Dry Eye",
  "alcon c001": "Eye Redness",
  "alcon c003": "Eye Redness",
  "alcon e002 e004": "Dry Eye",
  "alcon e003": "Dry Eye",
  "alcon e005": "Dry Eye",
  "alcon redness": "Eye Redness",
  allergan: "Dry Eye",
  allgenesis: "Dry Eye",
  "azura safety": "Safety",
  "b l biocube": "Dry Eye",
  "b l cac": "Allergic Conjunctivitis",
  "b l lumha 1301": "Eye Redness",
  "b l redness": "Eye Redness",
  "b l safety": "Safety",
  brim: "Dry Eye",
  "comet 2": "Dry Eye",
  "comet 3": "Dry Eye",
  "comet 4": "Dry Eye",
  "cylite biometer": "Cataract",
  hanall: "Dry Eye",
  oculis: "Dry Eye",
  okyo: "Dry Eye",
  palatin: "Dry Eye",
  "saturn 2": "Dry Eye",
  skk: "Dry Eye",
  "stuart australia": "Dry Eye",
  "telios 301": "Allergic Conjunctivitis",
  "telios 302": "Allergic Conjunctivitis",
  "telios 303": "Allergic Conjunctivitis",
  "telios 304 allergy": "Allergic Conjunctivitis",
  "telios 308": "Allergic Conjunctivitis",
  vanda: "Dry Eye",
  "vanda vsj 2202": "Dry Eye",
  yuyu: "Dry Eye"
};

/** Normalize already-stored legacy labels → budget-tool labels. */
const LEGACY_LABEL_MAP = {
  allergy: "Allergic Conjunctivitis",
  "allergic conjunctivitis": "Allergic Conjunctivitis",
  "dry eye": "Dry Eye",
  ded: "Dry Eye",
  "dry eye disease": "Dry Eye",
  redness: "Eye Redness",
  "eye redness": "Eye Redness",
  "ocular redness": "Eye Redness",
  safety: "Safety",
  cataract: "Cataract",
  cataracts: "Cataract"
};

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function resolveIndication(study) {
  const byName = STUDY_NAME_INDICATION[norm(study.studyName || study.name)];
  if (byName) return byName;
  const existing = LEGACY_LABEL_MAP[norm(study.indication)];
  if (existing) return existing;
  const n = norm(study.studyName || study.name);
  if (/\ballergy\b|\bcac\b|\btelios\b/.test(n)) return "Allergic Conjunctivitis";
  if (/\bredness\b|\blumha\b/.test(n)) return "Eye Redness";
  if (/\bsafety\b/.test(n)) return "Safety";
  if (/\bcataract\b|\bbiometer\b/.test(n)) return "Cataract";
  if (/\bdry\s*eye\b|\bded\b|\badx\b|\boculis\b|\bokyo\b|\bvanda\b|\bcomet\b|\bsaturn\b|\bbiocube\b/.test(n)) {
    return "Dry Eye";
  }
  return null;
}

async function main() {
  const dry = process.argv.includes("--dry-run");
  const env = loadEnv();
  if (!env.COSMOS_ENDPOINT || !env.COSMOS_KEY) {
    throw new Error("Missing COSMOS_ENDPOINT / COSMOS_KEY in .env");
  }
  const client = new CosmosClient({
    endpoint: env.COSMOS_ENDPOINT,
    key: env.COSMOS_KEY
  });
  const db = client.database(env.COSMOS_DATABASE || "bd-budgets");
  const container = db.container("legacy_studies");
  const { resources } = await container.items
    .query("SELECT * FROM c", { enableCrossPartitionQuery: true })
    .fetchAll();

  let updated = 0;
  let skipped = 0;
  const byInd = {};
  for (const doc of resources) {
    const next = resolveIndication(doc);
    const prev = doc.indication || null;
    byInd[next || "(unmapped)"] = (byInd[next || "(unmapped)"] || 0) + 1;
    if (!next) {
      console.log(`SKIP (no map): ${doc.studyName || doc.id}`);
      skipped += 1;
      continue;
    }
    if (prev === next && doc.oraIndication === next) {
      skipped += 1;
      continue;
    }
    console.log(`${dry ? "DRY " : ""}SET ${doc.studyName}: ${prev || "—"} → ${next}`);
    if (!dry) {
      doc.indication = next;
      doc.oraIndication = next;
      doc.indicationSource =
        prev && LEGACY_LABEL_MAP[norm(prev)] ? "legacy_label_map" : "study_name_map";
      doc.updatedAt = new Date().toISOString();
      await container.items.upsert(doc);
    }
    updated += 1;
  }
  console.log("\nSummary:", { updated, skipped, dry, byInd });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
