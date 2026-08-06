/**
 * One-shot: store Salesforce JWT private key in Cosmos (syncState/salesforce_jwt_key).
 * Usage: node scripts/set-sf-jwt-key.js "C:\\path\\to\\ora_intel_sf.key"
 * Loads COSMOS_* from api/.env, .env, or api/local.settings.json Values.
 */
const fs = require("fs");
const path = require("path");
const { CosmosClient } = require("../api/node_modules/@azure/cosmos");
const { saveCosmosJwtKey } = require("../api/src/salesforceClient");

function loadEnv() {
  const files = [
    path.join(__dirname, "..", "api", ".env"),
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", "api", "local.settings.json")
  ];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const raw = fs.readFileSync(f, "utf8");
    if (f.endsWith(".json")) {
      try {
        const j = JSON.parse(raw);
        const vals = j.Values || j.values || {};
        for (const [k, v] of Object.entries(vals)) {
          if (process.env[k]) continue;
          process.env[k] = String(v ?? "");
        }
      } catch (_) {}
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  }
}

async function main() {
  loadEnv();
  const keyPath = process.argv[2] || path.join(process.env.USERPROFILE || "", "Downloads", "ora_intel_sf.key");
  if (!fs.existsSync(keyPath)) {
    console.error(JSON.stringify({ ok: false, error: `Key file not found: ${keyPath}` }));
    process.exit(1);
  }
  const endpoint = (process.env.COSMOS_ENDPOINT || "").trim();
  const key = (process.env.COSMOS_KEY || "").trim();
  const dbName = (process.env.COSMOS_DATABASE || "bd-budgets").trim();
  if (!endpoint || !key || key.includes("SET_IN")) {
    console.error(JSON.stringify({ ok: false, error: "COSMOS_ENDPOINT / COSMOS_KEY missing in local env" }));
    process.exit(1);
  }

  const pem = fs.readFileSync(keyPath, "utf8");
  const client = new CosmosClient({ endpoint, key });
  const database = client.database(dbName);
  const getDb = () => database;
  const result = await saveCosmosJwtKey(getDb, { pem, updatedBy: "local:set-sf-jwt-key.js" });
  console.log(JSON.stringify({ ok: true, ...result, keyPath }));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err.message || err) }));
  process.exit(1);
});
