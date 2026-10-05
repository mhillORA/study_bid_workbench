/**
 * Smoke-test Artemis feasibility Monet pack (site search, questions, dedupe).
 * Usage: node scripts/_probe_feasibility_buddy.js
 */
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
const { routeBuddyAsk } = require("../api/src/buddyRouter");
const {
  buildFeasibilityArtemisContext,
  clusterSites
} = require("../api/src/feasibilityArtemis");

(async () => {
  const route1 = routeBuddyAsk({
    question: "Show duplicate feasibility sites from Artemis",
    body: {},
    hints: {}
  });
  console.log("ROUTE_DUP", {
    tools: route1.tools,
    workflow: route1.workflow,
    hasFeas: (route1.tools || []).includes("feasibility_artemis")
  });

  const route2 = routeBuddyAsk({
    question: "Feasibility survey questions about enrollment capacity for Dry Eye",
    body: {},
    hints: {}
  });
  console.log("ROUTE_Q", {
    tools: route2.tools,
    workflow: route2.workflow,
    hasFeas: (route2.tools || []).includes("feasibility_artemis")
  });

  const route3 = routeBuddyAsk({
    question: 'Find feasibility site "Total Eye Care" and their survey answers',
    body: {},
    hints: {}
  });
  console.log("ROUTE_SITE", {
    tools: route3.tools,
    hasFeas: (route3.tools || []).includes("feasibility_artemis")
  });

  const pack = await buildFeasibilityArtemisContext(getDb, {
    question: 'Match duplicate sites and find Total Eye Care',
    siteName: "Total Eye Care",
    includeMatch: true,
    includeQuestions: true
  });
  console.log("PACK", {
    error: pack.error || null,
    sites: (pack.sites || []).slice(0, 3).map((s) => ({
      name: s.siteName,
      pi: s.pi,
      score: s.matchScore,
      enrolled: s.enrolled
    })),
    resolved: (pack.match?.resolvedForHint || []).map((c) => ({
      canonical: c.canonicalName,
      n: c.memberCount,
      reasons: c.matchReasons,
      members: c.members.map((m) => m.siteName)
    })),
    dupClusters: pack.match?.duplicateClusterCount,
    questions: (pack.questions || []).slice(0, 5).map((q) => q.label || q.surveyTitle),
    answers: (pack.answers || []).length
  });

  const qPack = await buildFeasibilityArtemisContext(getDb, {
    question: "feasibility survey questions about enrollment",
    questionHint: "enroll",
    indication: "Dry Eye",
    includeQuestions: true
  });
  console.log("QPACK", {
    questions: (qPack.questions || []).slice(0, 8).map((q) => ({
      survey: q.surveyTitle,
      label: q.label,
      score: q.matchScore
    })),
    answers: (qPack.answers || []).slice(0, 3).map((a) => ({
      site: a.siteName || a.siteId,
      answers: a.answers
    }))
  });

  // Direct cluster stats
  const { CosmosClient } = require("../api/node_modules/@azure/cosmos");
  const c = new CosmosClient({
    endpoint: process.env.COSMOS_ENDPOINT,
    key: process.env.COSMOS_KEY
  });
  const db = c.database(process.env.COSMOS_DATABASE || "bd-budgets");
  const { resources: sites } = await db
    .container("feasibility_sites")
    .items.query("SELECT * FROM c")
    .fetchAll();
  const cl = clusterSites(sites);
  console.log("CLUSTER", {
    sites: cl.siteCount,
    clusters: cl.clusterCount,
    dups: cl.duplicateClusterCount,
    dupMembers: cl.duplicateMemberCount,
    top: cl.duplicateClusters.slice(0, 5).map((x) => ({
      canonical: x.canonicalName,
      n: x.memberCount,
      reasons: x.matchReasons,
      aliases: x.members.map((m) => m.siteName)
    }))
  });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
