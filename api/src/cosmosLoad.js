const { CosmosClient } = require("@azure/cosmos");

let client;
let db;

function getDb() {
  const endpoint = (process.env.COSMOS_ENDPOINT || "").trim();
  const key = (process.env.COSMOS_KEY || "").trim();
  const dbName = (process.env.COSMOS_DATABASE || "bd-budgets").trim();
  if (!endpoint || !key || key.includes("SET_IN")) {
    throw new Error("COSMOS_ENDPOINT / COSMOS_KEY not configured in App Settings");
  }
  if (!client) client = new CosmosClient({ endpoint, key });
  if (!db) db = client.database(dbName);
  return db;
}

async function upsertCanonical(canonical, jobId) {
  const database = getDb();
  const now = new Date().toISOString();
  const study = canonical.study;
  const version = canonical.version;
  const studyId = study.studyId;
  jobId = jobId || `job-${studyId}-${version.sourceSha256.slice(0, 8)}`;

  const summary = {
    jobId,
    studyId,
    confidence: canonical.confidence,
    quarantine: canonical.quarantine,
    lineItemCount: version.lineItemCount,
    warnings: canonical.warnings || []
  };

  if (canonical.quarantine) {
    await database.container("quarantine").items.upsert({
      id: `q-${version.sourceSha256.slice(0, 16)}`,
      jobId,
      studyId,
      reason: canonical.warnings || ["low confidence"],
      source: canonical.source,
      fingerprint: canonical.fingerprint,
      preview: {
        clientName: study.clientName,
        title: study.title,
        protocol: study.protocol,
        lineItemCount: version.lineItemCount
      },
      createdAt: now
    });
    summary.status = "quarantined";
    return summary;
  }

  await database.container("studies").items.upsert({
    ...study,
    currentVersionId: version.id,
    updatedAt: now,
    docType: "study"
  });

  await database.container("versions").items.upsert({
    ...version,
    docType: "version",
    confidence: canonical.confidence,
    profileId: canonical.profileId,
    source: canonical.source
  });

  const lineContainer = database.container("lineItems");
  // Batch in chunks to avoid huge payloads / RU spikes
  const chunk = 50;
  for (let i = 0; i < canonical.lineItems.length; i += chunk) {
    const slice = canonical.lineItems.slice(i, i + chunk);
    await Promise.all(
      slice.map((item, offset) =>
        lineContainer.items.upsert({
          id: `${version.id}-li-${i + offset}`,
          studyId,
          versionId: version.id,
          docType: "lineItem",
          ...item
        })
      )
    );
  }

  const depts = [...new Set(canonical.lineItems.map((li) => li.department).filter(Boolean))];
  const sections = database.container("sections");
  await Promise.all(
    depts.map((dept) =>
      sections.items.upsert({
        id: `${version.id}-sec-${dept}`,
        studyId,
        versionId: version.id,
        department: dept,
        status: "not_started",
        assumptions: {},
        notes: "",
        docType: "section",
        updatedAt: now
      })
    )
  );

  await database.container("importJobs").items.upsert({
    id: jobId,
    jobId,
    status: "loaded",
    studyId,
    versionId: version.id,
    confidence: canonical.confidence,
    lineItemCount: version.lineItemCount,
    source: canonical.source,
    createdAt: now
  });

  summary.status = "loaded";
  summary.versionId = version.id;
  return summary;
}

async function listStudies(limit = 100) {
  const database = getDb();
  const { resources } = await database.container("studies").items
    .query({
      query:
        "SELECT c.studyId, c.clientName, c.title, c.protocol, c.phase, c.status, c.currentVersionId, c.importedAt, c.updatedAt FROM c WHERE c.docType = @t",
      parameters: [{ name: "@t", value: "study" }]
    })
    .fetchAll();
  return resources
    .sort((a, b) => String(b.updatedAt || b.importedAt || "").localeCompare(String(a.updatedAt || a.importedAt || "")))
    .slice(0, limit);
}

module.exports = { upsertCanonical, listStudies, getDb };
