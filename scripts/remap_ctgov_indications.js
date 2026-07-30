/**
 * Remap ora_ctgov_trials.oraIndication using current INDICATION_RULES.
 *   node scripts/remap_ctgov_indications.js
 */
const path = require("path");
const fs = require("fs");
module.paths.unshift(path.join(__dirname, "..", "api", "node_modules"));
const { CosmosClient } = require("@azure/cosmos");
const { remapCtgovIndications } = require("../api/src/ctgovSync");

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

(async () => {
  const env = loadEnv();
  if (!env.COSMOS_ENDPOINT || !env.COSMOS_KEY) throw new Error("Missing COSMOS_* in .env");
  const client = new CosmosClient({ endpoint: env.COSMOS_ENDPOINT, key: env.COSMOS_KEY });
  const db = client.database(env.COSMOS_DATABASE || "bd-budgets");
  const result = await remapCtgovIndications(() => db, {});
  console.log(JSON.stringify(result, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
