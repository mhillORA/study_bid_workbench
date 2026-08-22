/**
 * One-shot: store SF Consumer Key + username in Cosmos (syncState/salesforce_connection).
 * Same pattern as set-sf-jwt-key.js — survives missing App Settings on ora-buddy-api.
 *
 * Usage (from repo root, values in .env — do NOT commit them):
 *   SF_CLIENT_ID=... SF_USERNAME=... node scripts/set-sf-connection.js
 *
 * Or set in .env / api/.env / api/local.settings.json Values, then:
 *   node scripts/set-sf-connection.js
 */
const fs = require("fs");
const path = require("path");
const { CosmosClient } = require("../api/node_modules/@azure/cosmos");
const { saveCosmosSfConnection } = require("../api/src/salesforceClient");

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
  const clientId = String(process.env.SF_CLIENT_ID || process.env.SF_CONSUMER_KEY || "").trim();
  const username = String(process.env.SF_USERNAME || process.env.SF_USER || "").trim();
  const loginUrl = String(process.env.SF_LOGIN_URL || "https://login.salesforce.com").trim();
  if (!clientId || !username) {
    console.error(
      JSON.stringify({
        ok: false,
        error:
          "Set SF_CLIENT_ID (Consumer Key) and SF_USERNAME in .env, then re-run. Do not paste them in chat."
      })
    );
    process.exit(1);
  }

  const endpoint = (process.env.COSMOS_ENDPOINT || "").trim();
  const key = (process.env.COSMOS_KEY || "").trim();
  const dbName = (process.env.COSMOS_DATABASE || "bd-budgets").trim();
  if (!endpoint || !key || key.includes("SET_IN")) {
    console.error(JSON.stringify({ ok: false, error: "COSMOS_ENDPOINT / COSMOS_KEY missing in local env" }));
    process.exit(1);
  }

  const client = new CosmosClient({ endpoint, key });
  const database = client.database(dbName);
  const getDb = () => database;
  const result = await saveCosmosSfConnection(getDb, {
    clientId,
    username,
    loginUrl,
    updatedBy: "local:set-sf-connection.js"
  });
  console.log(
    JSON.stringify({
      ok: true,
      ...result,
      note: "ora-buddy-api will read these from Cosmos on next Ingest SF (JWT key already in Cosmos)."
    })
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err.message || err) }));
  process.exit(1);
});
