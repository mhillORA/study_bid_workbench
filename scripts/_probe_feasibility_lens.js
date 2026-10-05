const fs = require("fs");
const path = require("path");
for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (!process.env[m[1].trim()]) process.env[m[1].trim()] = v;
}
const { getDb } = require("../api/src/cosmosLoad");
const {
  buildFeasibilityLensPack,
  loadPersistedFeasibilityCatalog
} = require("../api/src/feasibilityArtemis");

(async () => {
  const p = await buildFeasibilityLensPack(getDb, {});
  console.log(
    JSON.stringify(
      {
        built: !p.error,
        surveys: p.catalog?.surveyCount,
        persisted: p.catalogPersistedAt,
        persistError: p.catalogPersistError || null
      },
      null,
      2
    )
  );
  const c = await loadPersistedFeasibilityCatalog(getDb);
  console.log(
    JSON.stringify(
      {
        cached: Boolean(c?.catalog),
        updatedAt: c?.updatedAt || null,
        surveys: c?.catalog?.surveyCount,
        sampleTitles: (c?.catalog?.surveys || []).slice(0, 4).map((s) => s.title)
      },
      null,
      2
    )
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
