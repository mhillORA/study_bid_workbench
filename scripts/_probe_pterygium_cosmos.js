/**
 * Cosmos + live CT.gov pterygium pack (Ora Veeva / TrialHub / CT.gov).
 */
const fs = require("fs");
const path = require("path");

function loadEnv() {
  for (const p of [
    path.join(__dirname, "..", "api", "local.settings.json"),
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", "api", ".env")
  ]) {
    try {
      if (p.endsWith(".json")) {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        Object.assign(process.env, j.Values || {});
      } else {
        for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
          const m = line.match(/^([^#=]+)=(.*)$/);
          if (!m) continue;
          const k = m[1].trim();
          let v = m[2].trim();
          if (
            (v.startsWith('"') && v.endsWith('"')) ||
            (v.startsWith("'") && v.endsWith("'"))
          ) {
            v = v.slice(1, -1);
          }
          if (!process.env[k]) process.env[k] = v;
        }
      }
    } catch (_) {
      /* skip */
    }
  }
}

async function main() {
  loadEnv();
  if (!process.env.COSMOS_ENDPOINT || !process.env.COSMOS_KEY) {
    console.log(JSON.stringify({ ok: false, error: "no cosmos env" }));
    process.exit(1);
  }
  const { getDb } = require("../api/src/cosmosLoad");
  const {
    buildIntelligenceContext,
    extractIndicationFromQuestion
  } = require("../api/src/intelligence");

  const db = getDb();
  const ind = extractIndicationFromQuestion("Ora pterygium prep for Cloudbreak");
  const pack = await buildIntelligenceContext(getDb, {
    indication: ind,
    question: "Ora pterygium prep for Cloudbreak — CT.gov recruiting + Ora experience",
    attachmentText: ""
  });

  const out = {
    ok: true,
    indication: ind,
    query: pack?.query || null,
    ctgov: {
      trialCount: pack?.ctgov?.trialCount,
      matchedIndicationCount: pack?.ctgov?.matchedIndicationCount,
      recruitingCount: pack?.ctgov?.recruitingCount,
      live: pack?.ctgov?.liveCtgovSearch || null,
      sample: (pack?.ctgov?.sample || pack?.ctgov?.recruitingSample || []).slice(0, 5).map((t) => ({
        nct: t.nct,
        status: t.status,
        title: String(t.title || "").slice(0, 80),
        oraIndication: t.oraIndication
      }))
    },
    ora: {
      studyCount: pack?.indicationBenchmark?.ora?.studyCount,
      siteCount: pack?.indicationBenchmark?.ora?.siteCount,
      sampleStudies: (pack?.indicationBenchmark?.ora?.sampleStudies || []).slice(0, 5).map((s) => ({
        study: s.study_number || s.id,
        indication: s.indication,
        title: String(s.title || s.name || "").slice(0, 60)
      }))
    },
    trialhub: {
      trialCount: pack?.indicationBenchmark?.trialhub?.trialCount,
      psmMedian: pack?.indicationBenchmark?.trialhub?.psmMedian
    },
    liveGapNote: pack?.ctgov?.note || null
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
