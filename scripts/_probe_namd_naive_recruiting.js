/**
 * Confirm how many RECRUITING treatment-naïve nAMD trials exist on CT.gov.
 */
const { analyzeAvegfTreatmentNaive } = require("../api/src/ctgovEligibility");

async function fetchPage(pageToken) {
  const params = new URLSearchParams({
    format: "json",
    pageSize: "100",
    countTotal: "true",
    "query.cond":
      'neovascular AMD OR "wet AMD" OR nAMD OR "neovascular age-related macular degeneration"',
    "filter.advanced": "AREA[StartDate]RANGE[2014-01-01,MAX]",
    "filter.overallStatus": "RECRUITING",
    fields:
      "NCTId,BriefTitle,OverallStatus,Phase,EligibilityCriteria,LeadSponsorName,Condition,EnrollmentCount,StartDate"
  });
  if (pageToken) params.set("pageToken", pageToken);
  const res = await fetch(`https://clinicaltrials.gov/api/v2/studies?${params}`, {
    headers: { Accept: "application/json", "User-Agent": "OraStudyBidWorkbench/1.0" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  // Pass 1: status filter RECRUITING only
  let token = null;
  const recruiting = [];
  let totalRecruiting = null;
  for (let p = 0; p < 5; p++) {
    const data = await fetchPage(token);
    if (totalRecruiting == null) totalRecruiting = data.totalCount;
    for (const s of data.studies || []) recruiting.push(s);
    token = data.nextPageToken || null;
    if (!token) break;
  }

  const naiveRecruiting = [];
  for (const s of recruiting) {
    const ps = s.protocolSection || {};
    const elig = ps.eligibilityModule?.eligibilityCriteria || "";
    const a = analyzeAvegfTreatmentNaive(elig);
    if (!a.likely) continue;
    naiveRecruiting.push({
      nct: ps.identificationModule?.nctId,
      title: (ps.identificationModule?.briefTitle || "").slice(0, 100),
      phase: (ps.designModule?.phases || [])[0] || null,
      sponsor: ps.sponsorCollaboratorsModule?.leadSponsor?.name || null,
      enrollment: ps.designModule?.enrollmentInfo?.count ?? null,
      reason: a.reason,
      evidence: a.evidence
    });
  }

  // Pass 2: broader scan (any status) then filter recruiting in code — catch status quirks
  const params2 = new URLSearchParams({
    format: "json",
    pageSize: "100",
    countTotal: "true",
    "query.cond":
      'neovascular AMD OR "wet AMD" OR nAMD OR "neovascular age-related macular degeneration"',
    "filter.advanced": "AREA[StartDate]RANGE[2014-01-01,MAX]",
    fields:
      "NCTId,BriefTitle,OverallStatus,Phase,EligibilityCriteria,LeadSponsorName,EnrollmentCount"
  });
  let anyNaiveRecruiting = 0;
  let scanned = 0;
  let t2 = null;
  const extra = [];
  for (let p = 0; p < 4; p++) {
    if (t2) params2.set("pageToken", t2);
    else params2.delete("pageToken");
    const res = await fetch(`https://clinicaltrials.gov/api/v2/studies?${params2}`, {
      headers: { Accept: "application/json", "User-Agent": "OraStudyBidWorkbench/1.0" }
    });
    const data = await res.json();
    for (const s of data.studies || []) {
      scanned += 1;
      const ps = s.protocolSection || {};
      const status = String(ps.statusModule?.overallStatus || "");
      if (!/^RECRUITING$/i.test(status)) continue;
      const a = analyzeAvegfTreatmentNaive(ps.eligibilityModule?.eligibilityCriteria || "");
      if (!a.likely) continue;
      anyNaiveRecruiting += 1;
      if (extra.length < 15) {
        extra.push({
          nct: ps.identificationModule?.nctId,
          title: (ps.identificationModule?.briefTitle || "").slice(0, 90),
          reason: a.reason,
          evidence: (a.evidence || "").slice(0, 120)
        });
      }
    }
    t2 = data.nextPageToken || null;
    if (!t2) break;
  }

  console.log(
    JSON.stringify(
      {
        recruitingRegistryTotal: totalRecruiting,
        recruitingFetched: recruiting.length,
        recruitingTreatmentNaive: naiveRecruiting.length,
        broadScan: { scanned, recruitingNaive: anyNaiveRecruiting },
        examples: (naiveRecruiting.length ? naiveRecruiting : extra).slice(0, 12)
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
