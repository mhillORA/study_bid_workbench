/**
 * Append indication-coding playbook to Buddy live context (Cosmos).
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

function loadEnv() {
  const p = path.join(root, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnv();

const { CosmosClient } = require(path.join(root, "api", "node_modules", "@azure", "cosmos"));
const { saveLiveContext } = require(path.join(root, "api", "src", "buddyLiveContext"));

const text = fs.readFileSync(
  path.join(root, "docs", "indication-coding-search-methodology.txt"),
  "utf8"
);

const client = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key: process.env.COSMOS_KEY
});
const getDb = () => client.database(process.env.COSMOS_DATABASE || "bd-budgets");

(async () => {
  const result = await saveLiveContext(getDb, {
    append: text,
    dept: "feasibility",
    category: "playbook",
    user: { email: "ingest-script", displayName: "indication-coding ingest" }
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
