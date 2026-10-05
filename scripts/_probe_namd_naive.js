/**
 * Probe CT.gov for treatment-naïve nAMD (prior aVEGF exclusion in eligibility).
 */
const { analyzeAvegfTreatmentNaive } = require("../api/src/ctgovEligibility");

async function fetchPage(pageToken) {
  const params = new URLSearchParams({
    format: "json",
    pageSize: "100",
    countTotal: "true",
    "query.cond": "neovascular AMD OR wet AMD OR nAMD OR macular degeneration",
    "filter.advanced": "AREA[StartDate]RANGE[2014-01-01,MAX]",
    fields: "NCTId,BriefTitle,OverallStatus,Phase,EligibilityCriteria,LeadSponsorName,Condition"
  });
  if (pageToken) params.set("pageToken", pageToken);
  const url = `https://clinicaltrials.gov/api/v2/studies?${params}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "OraStudyBidWorkbench/1.0" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  let token = null;
  let pages = 0;
  const all = [];
  while (pages < 5) {
    const data = await fetchPage(token);
    if (pages === 0) console.log("totalCount", data.totalCount);
    const studies = data.studies || [];
    all.push(...studies);
    pages += 1;
    token = data.nextPageToken || null;
    if (!token || !studies.length) break;
  }
  console.log("fetched", all.length);

  let withElig = 0;
  let naive = 0;
  let experienced = 0;
  const examples = [];
  const missExamples = [];

  for (const s of all) {
    const ps = s.protocolSection || {};
    const nct = ps.identificationModule?.nctId;
    const title = ps.identificationModule?.briefTitle || "";
    const status = ps.statusModule?.overallStatus;
    const elig = ps.eligibilityModule?.eligibilityCriteria || "";
    const conds = (ps.conditionsModule?.conditions || []).join("; ");
    if (elig) withElig += 1;
    const a = analyzeAvegfTreatmentNaive(elig);
    if (a.requiresPriorAvegf) experienced += 1;
    if (a.likely) {
      naive += 1;
      if (examples.length < 12) {
        examples.push({
          nct,
          status,
          reason: a.reason,
          evidence: a.evidence,
          title: title.slice(0, 90)
        });
      }
    } else if (elig && missExamples.length < 5 && /anti[- ]?vegf|aflibercept|ranibizumab/i.test(elig)) {
      missExamples.push({
        nct,
        status,
        title: title.slice(0, 70),
        snip: elig.replace(/\s+/g, " ").slice(0, 180)
      });
    }
  }

  console.log(JSON.stringify({ withElig, naive, experienced, of: all.length }, null, 2));
  console.log("NAIVE EXAMPLES");
  console.log(JSON.stringify(examples, null, 2));
  console.log("HAS AVEGF BUT NOT FLAGGED");
  console.log(JSON.stringify(missExamples, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
