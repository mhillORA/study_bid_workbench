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
      docType: "quarantine",
      reason: canonical.quarantineReasons || canonical.warnings || ["low confidence"],
      warnings: canonical.warnings || [],
      confidence: canonical.confidence,
      source: canonical.source,
      fingerprint: canonical.fingerprint,
      sheetInventory: canonical.sheetInventory || [],
      preview: {
        clientName: study.clientName,
        title: study.title,
        protocol: study.protocol,
        lineItemCount: version.lineItemCount,
        inputFieldCount: (study.inputFields || []).length,
        siteCount: (study.sites || []).length
      },
      createdAt: now
    });
    summary.status = "quarantined";
    summary.quarantineReasons = canonical.quarantineReasons || [];
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
    source: canonical.source,
    // Snapshot study inputs on the version so history/compare works after later uploads
    snapshot: {
      header: study.header || {},
      drivers: study.drivers || {},
      sites: study.sites || [],
      inputFields: study.inputFields || [],
      resourceLeads: study.resourceLeads || [],
      monitoring: study.monitoring || {},
      vendors: study.vendors || [],
      payments: study.payments || {},
      clientName: study.clientName,
      title: study.title,
      protocol: study.protocol,
      phase: study.phase,
      therapeuticArea: study.therapeuticArea,
      indication: study.indication,
      enrollmentType: study.enrollmentType,
      budgetType: study.budgetType
    }
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

  if (Array.isArray(canonical.rates) && canonical.rates.length) {
    await database.container("rateCards").items.upsert({
      id: `rates-${studyId}-${version.id}`,
      rateCardId: `rates-${studyId}`,
      studyId,
      versionId: version.id,
      docType: "rateCard",
      rates: canonical.rates,
      updatedAt: now
    });
  }

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

async function getStudy(studyId) {
  const database = getDb();
  const { resources } = await database.container("studies").items
    .query({
      query: "SELECT * FROM c WHERE c.studyId = @id AND c.docType = @t",
      parameters: [
        { name: "@id", value: studyId },
        { name: "@t", value: "study" }
      ]
    })
    .fetchAll();
  return resources[0] || null;
}

async function listVersions(studyId) {
  const database = getDb();
  const { resources } = await database.container("versions").items
    .query({
      query:
        "SELECT c.id, c.studyId, c.label, c.sourceFileName, c.sourceSha256, c.lineItemCount, c.rateCount, c.totals, c.createdAt, c.confidence FROM c WHERE c.studyId = @id AND c.docType = @t",
      parameters: [
        { name: "@id", value: studyId },
        { name: "@t", value: "version" }
      ]
    })
    .fetchAll();
  return resources.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

async function getVersion(studyId, versionId) {
  const database = getDb();
  try {
    const { resource } = await database.container("versions").item(versionId, studyId).read();
    return resource || null;
  } catch (_) {
    const { resources } = await database.container("versions").items
      .query({
        query: "SELECT * FROM c WHERE c.id = @vid AND c.studyId = @id",
        parameters: [
          { name: "@vid", value: versionId },
          { name: "@id", value: studyId }
        ]
      })
      .fetchAll();
    return resources[0] || null;
  }
}

async function listLineItems(studyId, versionId, { department, limit = 500 } = {}) {
  const database = getDb();
  let query;
  let parameters;
  if (department) {
    query =
      "SELECT TOP @lim c.oraCode, c.department, c.service, c.units, c.hoursPerUnit, c.totalHours, c.charge, c.directCost, c.phase, c.section FROM c WHERE c.studyId = @id AND c.versionId = @vid AND c.department = @dept";
    parameters = [
      { name: "@id", value: studyId },
      { name: "@vid", value: versionId },
      { name: "@dept", value: department },
      { name: "@lim", value: limit }
    ];
  } else {
    query =
      "SELECT TOP @lim c.oraCode, c.department, c.service, c.units, c.hoursPerUnit, c.totalHours, c.charge, c.directCost, c.phase, c.section FROM c WHERE c.studyId = @id AND c.versionId = @vid";
    parameters = [
      { name: "@id", value: studyId },
      { name: "@vid", value: versionId },
      { name: "@lim", value: limit }
    ];
  }
  const { resources } = await database.container("lineItems").items.query({ query, parameters }).fetchAll();
  return resources;
}

function flattenForCompare(versionDoc, studyFallback) {
  const snap = versionDoc?.snapshot || {};
  const drivers = snap.drivers || studyFallback?.drivers || {};
  const header = snap.header || studyFallback?.header || {};
  const totals = versionDoc?.totals || versionDoc?.execSum?.totals || {};
  const flat = {
    clientName: snap.clientName || studyFallback?.clientName || null,
    title: snap.title || studyFallback?.title || null,
    protocol: snap.protocol || studyFallback?.protocol || null,
    phase: snap.phase || studyFallback?.phase || null,
    therapeuticArea: snap.therapeuticArea || studyFallback?.therapeuticArea || null,
    indication: snap.indication || studyFallback?.indication || null,
    enrollmentType: snap.enrollmentType || studyFallback?.enrollmentType || null,
    budgetType: snap.budgetType || studyFallback?.budgetType || null,
    versionLabel: versionDoc?.label || null,
    lineItemCount: versionDoc?.lineItemCount ?? null,
    sourceFileName: versionDoc?.sourceFileName || null
  };
  for (const [k, v] of Object.entries(header)) {
    flat[`header.${k}`] = v;
  }
  for (const [k, v] of Object.entries(drivers)) {
    flat[`driver.${k}`] = v;
  }
  for (const [k, v] of Object.entries(totals)) {
    flat[`total.${k}`] = v;
  }
  return flat;
}

function valuesEqual(a, b) {
  if (a == null && b == null) return true;
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) < 1e-9;
  }
  return String(a) === String(b);
}

async function compareVersions(studyId, olderVersionId, newerVersionId) {
  const study = await getStudy(studyId);
  const older = await getVersion(studyId, olderVersionId);
  const newer = await getVersion(studyId, newerVersionId);
  if (!older || !newer) {
    throw new Error("One or both versions were not found");
  }
  const a = flattenForCompare(older, study);
  const b = flattenForCompare(newer, study);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const changes = [];
  const unchanged = [];
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if (valuesEqual(left, right)) {
      unchanged.push({ key, value: right });
    } else {
      changes.push({ key, previous: left ?? null, current: right ?? null });
    }
  }

  // Line-item rollup by department charge
  const [oldLines, newLines] = await Promise.all([
    listLineItems(studyId, olderVersionId, { limit: 2000 }),
    listLineItems(studyId, newerVersionId, { limit: 2000 })
  ]);
  const roll = (items) => {
    const m = {};
    for (const li of items) {
      const d = li.department || "Other";
      if (!m[d]) m[d] = { department: d, count: 0, charge: 0, hours: 0 };
      m[d].count += 1;
      m[d].charge += Number(li.charge) || 0;
      m[d].hours += Number(li.totalHours) || 0;
    }
    return m;
  };
  const oldR = roll(oldLines);
  const newR = roll(newLines);
  const deptKeys = [...new Set([...Object.keys(oldR), ...Object.keys(newR)])].sort();
  const departmentDiffs = deptKeys.map((d) => ({
    department: d,
    previous: oldR[d] || { department: d, count: 0, charge: 0, hours: 0 },
    current: newR[d] || { department: d, count: 0, charge: 0, hours: 0 },
    changed:
      !oldR[d] ||
      !newR[d] ||
      oldR[d].count !== newR[d].count ||
      Math.abs((oldR[d].charge || 0) - (newR[d].charge || 0)) > 0.01
  }));

  // Ora-code level diffs (subset: changed/added/removed)
  const byCode = (items) => {
    const m = {};
    for (const li of items) {
      if (!li.oraCode) continue;
      m[li.oraCode] = li;
    }
    return m;
  };
  const oldC = byCode(oldLines);
  const newC = byCode(newLines);
  const codeKeys = [...new Set([...Object.keys(oldC), ...Object.keys(newC)])];
  const lineItemDiffs = [];
  for (const code of codeKeys) {
    const p = oldC[code];
    const c = newC[code];
    if (!p && c) {
      lineItemDiffs.push({ oraCode: code, change: "added", previous: null, current: c });
    } else if (p && !c) {
      lineItemDiffs.push({ oraCode: code, change: "removed", previous: p, current: null });
    } else if (
      p &&
      c &&
      (!valuesEqual(p.units, c.units) ||
        !valuesEqual(p.charge, c.charge) ||
        !valuesEqual(p.totalHours, c.totalHours) ||
        !valuesEqual(p.service, c.service))
    ) {
      lineItemDiffs.push({ oraCode: code, change: "changed", previous: p, current: c });
    }
  }

  return {
    studyId,
    older: { id: older.id, label: older.label, createdAt: older.createdAt, sourceFileName: older.sourceFileName },
    newer: { id: newer.id, label: newer.label, createdAt: newer.createdAt, sourceFileName: newer.sourceFileName },
    fieldChanges: changes,
    fieldUnchangedCount: unchanged.length,
    departmentDiffs,
    lineItemDiffs: lineItemDiffs.slice(0, 300),
    lineItemDiffCount: lineItemDiffs.length,
    notes: older.snapshot ? null : "Older version has no input snapshot (uploaded before versioning fix). Field compare may be limited to totals."
  };
}

async function listQuarantine(limit = 200) {
  const database = getDb();
  const lim = Math.min(Number(limit) || 200, 500);
  const { resources } = await database.container("quarantine").items
    .query({ query: "SELECT * FROM c" })
    .fetchAll();
  return resources
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, lim)
    .map((q) => ({
      id: q.id,
      jobId: q.jobId,
      studyId: q.studyId,
      fileName: q.source?.fileName || null,
      confidence: q.confidence,
      reason: q.reason,
      warnings: q.warnings || [],
      missingSheets: q.fingerprint?.missingSheets || [],
      resolvedSheets: q.fingerprint?.resolvedSheets || {},
      preview: q.preview || {},
      createdAt: q.createdAt
    }));
}

module.exports = {
  upsertCanonical,
  listStudies,
  getStudy,
  listVersions,
  getVersion,
  listLineItems,
  compareVersions,
  listQuarantine,
  getDb
};
