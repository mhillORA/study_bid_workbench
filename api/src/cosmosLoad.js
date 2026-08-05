const { CosmosClient } = require("@azure/cosmos");
const {
  loadLearnings,
  learnFromQuarantine,
  learnFromSuccess,
  learningsSummary
} = require("./parseLearning");

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
    let learning = null;
    try {
      learning = await learnFromQuarantine(getDb, canonical);
    } catch (_) {
      /* learnings optional — quarantine still lands */
    }
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
      learnHints: canonical.learnHints || null,
      learningPromoted: learning?.promoted || 0,
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
    summary.learnHints = canonical.learnHints || null;
    summary.learningPromoted = learning?.promoted || 0;
    return summary;
  }

  try {
    await learnFromSuccess(getDb, canonical);
  } catch (_) {
    /* non-fatal */
  }

  await database.container("studies").items.upsert({
    ...study,
    currentVersionId: version.id,
    updatedAt: now,
    docType: "study"
  });

  // Never persist full sheetHarvest cell dumps on the version doc (Cosmos 2MB limit).
  // Keep summary + inventory only; full harvest was blowing writes and leaving studies half-empty.
  const { sheetHarvest: _omitHarvest, ...versionRest } = version;
  await database.container("versions").items.upsert({
    ...versionRest,
    docType: "version",
    confidence: canonical.confidence,
    profileId: canonical.profileId,
    source: canonical.source,
    sheetHarvestSummary: study.sheetHarvestSummary || null,
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
      sheetHarvestSummary: study.sheetHarvestSummary || null,
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

async function listStudies(limit = 200) {
  const database = getDb();
  const { resources } = await database.container("studies").items
    .query({
      query:
        "SELECT c.studyId, c.clientName, c.title, c.protocol, c.phase, c.therapeuticArea, c.indication, c.status, c.budgetType, c.category, c.currentVersionId, c.importedAt, c.updatedAt FROM c WHERE c.docType = @t",
      parameters: [{ name: "@t", value: "study" }]
    })
    .fetchAll();
  return resources
    .sort((a, b) => String(b.updatedAt || b.importedAt || "").localeCompare(String(a.updatedAt || a.importedAt || "")))
    .slice(0, Math.min(Number(limit) || 200, 500));
}

/** Studies with drivers for portfolio / Copilot cross-study questions. */
async function listStudiesWithDrivers(limit = 500) {
  const database = getDb();
  const { resources } = await database.container("studies").items
    .query({
      query:
        "SELECT c.studyId, c.clientName, c.title, c.protocol, c.phase, c.therapeuticArea, c.indication, c.status, c.drivers, c.currentVersionId, c.importedAt, c.updatedAt FROM c WHERE c.docType = @t",
      parameters: [{ name: "@t", value: "study" }]
    })
    .fetchAll();
  return resources
    .sort((a, b) => String(b.updatedAt || b.importedAt || "").localeCompare(String(a.updatedAt || a.importedAt || "")))
    .slice(0, Math.min(Number(limit) || 500, 800));
}

/** Map version id → money fields from Exec Sum totals on version docs. */
async function loadVersionMoneyById(versionIds) {
  const ids = [...new Set((versionIds || []).filter(Boolean))];
  const map = {};
  if (!ids.length) return map;
  const database = getDb();
  // Pull recent versions with totals; join in memory (Cosmos has no efficient large IN for all tenants).
  const { resources } = await database.container("versions").items
    .query({
      query:
        "SELECT c.id, c.studyId, c.totals, c.lineItemCount, c.label FROM c WHERE c.docType = @t",
      parameters: [{ name: "@t", value: "version" }]
    })
    .fetchAll();
  const want = new Set(ids);
  for (const v of resources) {
    if (!want.has(v.id)) continue;
    map[v.id] = extractMoneyFromTotals(v.totals, v.lineItemCount, v.label);
  }
  return map;
}

function extractMoneyFromTotals(totals, lineItemCount, versionLabel) {
  const raw = totals && typeof totals === "object" ? totals : {};
  let serviceFees = null;
  let subtotalServiceFees = null;
  let contingency = null;
  let inflation = null;
  let discount = null;
  let passThroughs = numOrNull(raw.passThroughTotal);

  for (const [k, v] of Object.entries(raw)) {
    const low = String(k).toLowerCase().trim();
    const n = numOrNull(v);
    if (n == null) continue;
    if (low === "total service fees" || low.includes("total service fee")) serviceFees = n;
    else if (low === "subtotal service fees" || low.includes("subtotal service")) subtotalServiceFees = n;
    else if (low.includes("contingency")) contingency = n;
    else if (low === "inflation" || low.includes("inflation")) inflation = n;
    else if (low === "discount" || low.includes("discount")) discount = n;
    else if ((low.includes("pass") && low.includes("through")) || low === "passthroughtotal") {
      passThroughs = n;
    }
  }

  if (serviceFees == null && subtotalServiceFees != null) {
    // Fall back to subtotal + inflation - discount + contingency when total missing
    serviceFees =
      subtotalServiceFees +
      (typeof contingency === "number" ? contingency : 0) +
      (typeof inflation === "number" ? inflation : 0) -
      (typeof discount === "number" ? discount : 0);
  }

  const grandTotal =
    serviceFees != null
      ? serviceFees + (typeof passThroughs === "number" ? passThroughs : 0)
      : null;

  return {
    subtotalServiceFees,
    serviceFees,
    passThroughs,
    contingency,
    inflation,
    discount,
    grandTotal,
    lineItemCount: lineItemCount ?? null,
    versionLabel: versionLabel || null,
    rawTotals: Object.keys(raw).length ? raw : null
  };
}

function studyYear(s) {
  const raw = s.updatedAt || s.importedAt || "";
  const m = String(raw).match(/^(20\d{2})/);
  return m ? Number(m[1]) : null;
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Portfolio rollup for Copilot / Buddy cross-study questions.
 * Filters: clientName (substring, case-insensitive), year (from updatedAt/importedAt).
 * Includes Exec Sum money from each study's current version when available.
 */
async function buildPortfolioContext({ clientName = null, year = null, limit = 500 } = {}) {
  const all = await listStudiesWithDrivers(limit);
  const clientNeedle = clientName ? String(clientName).trim().toLowerCase() : "";
  const yearNum = year != null && year !== "" ? Number(year) : null;

  const moneyByVersion = await loadVersionMoneyById(all.map((s) => s.currentVersionId));

  const rows = [];
  for (const s of all) {
    if (clientNeedle) {
      const cn = String(s.clientName || "").toLowerCase();
      if (!cn.includes(clientNeedle)) continue;
    }
    const y = studyYear(s);
    if (yearNum && y !== yearNum) continue;
    const d = s.drivers || {};
    const money = (s.currentVersionId && moneyByVersion[s.currentVersionId]) || {};
    rows.push({
      studyId: s.studyId,
      clientName: s.clientName || null,
      title: s.title || null,
      protocol: s.protocol || null,
      phase: s.phase || null,
      therapeuticArea: s.therapeuticArea || null,
      indication: s.indication || null,
      status: s.status || null,
      year: y,
      enrolledSubjects: numOrNull(d.enrolledSubjects ?? d.patients),
      screenedSubjects: numOrNull(d.screenedSubjects),
      completedSubjects: numOrNull(d.completedSubjects),
      coreSites: numOrNull(d.coreSites),
      serviceFees: money.serviceFees ?? null,
      subtotalServiceFees: money.subtotalServiceFees ?? null,
      passThroughs: money.passThroughs ?? null,
      grandTotal: money.grandTotal ?? null,
      contingency: money.contingency ?? null,
      inflation: money.inflation ?? null,
      discount: money.discount ?? null,
      lineItemCount: money.lineItemCount ?? null,
      versionLabel: money.versionLabel ?? null,
      importedAt: s.importedAt || null,
      updatedAt: s.updatedAt || null
    });
  }

  const sum = (key) =>
    rows.reduce((acc, r) => acc + (typeof r[key] === "number" ? r[key] : 0), 0);

  const avg = (key) => {
    const nums = rows.map((r) => r[key]).filter((n) => typeof n === "number");
    if (!nums.length) return null;
    return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
  };

  const byClientMap = {};
  for (const r of rows) {
    const key = r.clientName || "(unknown)";
    if (!byClientMap[key]) {
      byClientMap[key] = {
        clientName: key,
        studyCount: 0,
        enrolledSubjects: 0,
        screenedSubjects: 0,
        completedSubjects: 0,
        coreSites: 0,
        serviceFees: 0,
        passThroughs: 0,
        grandTotal: 0,
        studiesWithMoney: 0,
        studiesWithEnrollment: 0
      };
    }
    const b = byClientMap[key];
    b.studyCount += 1;
    b.enrolledSubjects += typeof r.enrolledSubjects === "number" ? r.enrolledSubjects : 0;
    b.screenedSubjects += typeof r.screenedSubjects === "number" ? r.screenedSubjects : 0;
    b.completedSubjects += typeof r.completedSubjects === "number" ? r.completedSubjects : 0;
    b.coreSites += typeof r.coreSites === "number" ? r.coreSites : 0;
    if (typeof r.enrolledSubjects === "number") b.studiesWithEnrollment += 1;
    if (typeof r.serviceFees === "number" || typeof r.grandTotal === "number") {
      b.studiesWithMoney += 1;
      b.serviceFees += typeof r.serviceFees === "number" ? r.serviceFees : 0;
      b.passThroughs += typeof r.passThroughs === "number" ? r.passThroughs : 0;
      b.grandTotal += typeof r.grandTotal === "number" ? r.grandTotal : 0;
    }
  }

  const byClient = Object.values(byClientMap)
    .map((b) => ({
      ...b,
      avgEnrolledSubjects:
        b.studiesWithEnrollment > 0
          ? Math.round((b.enrolledSubjects / b.studiesWithEnrollment) * 100) / 100
          : null
    }))
    .sort(
      (a, b) => b.grandTotal - a.grandTotal || b.serviceFees - a.serviceFees || b.studyCount - a.studyCount
    );

  const withMoney = rows.filter((r) => typeof r.grandTotal === "number" || typeof r.serviceFees === "number");
  const mostExpensive = [...withMoney].sort(
    (a, b) => (b.grandTotal ?? b.serviceFees ?? 0) - (a.grandTotal ?? a.serviceFees ?? 0)
  ).slice(0, 15);

  const clientNames = [
    ...new Set(all.map((s) => s.clientName).filter(Boolean))
  ].sort((a, b) => a.localeCompare(b));

  const enrollmentN = rows.filter((r) => typeof r.enrolledSubjects === "number").length;

  const recentlyIngested = [...rows]
    .filter((r) => r.importedAt || r.updatedAt)
    .sort((a, b) =>
      String(b.importedAt || b.updatedAt || "").localeCompare(String(a.importedAt || a.updatedAt || ""))
    )
    .slice(0, 25)
    .map((r) => ({
      studyId: r.studyId,
      clientName: r.clientName,
      title: r.title,
      importedAt: r.importedAt,
      updatedAt: r.updatedAt
    }));

  return {
    source: "cosmos_portfolio",
    filters: {
      clientName: clientName || null,
      year: yearNum || null
    },
    databaseStudyCount: all.length,
    matchedStudyCount: rows.length,
    studiesWithMoneyCount: withMoney.length,
    studiesWithEnrollmentCount: enrollmentN,
    totals: {
      enrolledSubjects: sum("enrolledSubjects"),
      screenedSubjects: sum("screenedSubjects"),
      completedSubjects: sum("completedSubjects"),
      coreSites: sum("coreSites"),
      serviceFees: sum("serviceFees"),
      passThroughs: sum("passThroughs"),
      grandTotal: sum("grandTotal")
    },
    averages: {
      enrolledSubjects: avg("enrolledSubjects"),
      screenedSubjects: avg("screenedSubjects"),
      completedSubjects: avg("completedSubjects"),
      coreSites: avg("coreSites"),
      serviceFees: avg("serviceFees"),
      grandTotal: avg("grandTotal"),
      note: "Averages are the mean across matched studies that have that field (missing values excluded). Use averages.enrolledSubjects for 'average enrollment across all studies'."
    },
    byClient: byClient.slice(0, 40),
    highestBudgetStudies: mostExpensive.map((r) => ({
      studyId: r.studyId,
      clientName: r.clientName,
      title: r.title,
      serviceFees: r.serviceFees,
      passThroughs: r.passThroughs,
      grandTotal: r.grandTotal,
      enrolledSubjects: r.enrolledSubjects,
      importedAt: r.importedAt,
      updatedAt: r.updatedAt
    })),
    recentlyIngested,
    clientNamesInDatabase: clientNames.slice(0, 100),
    studies: rows.slice(0, 100),
    notes: [
      "Money fields come from Exec Sum totals on each study's current version (Total Service Fees, pass-throughs).",
      "grandTotal ≈ serviceFees + passThroughs when both exist; otherwise serviceFees alone.",
      "byClient.grandTotal / serviceFees = Ora earned bid dollars from that client — NOT the client's corporate revenue.",
      "importedAt = when the study was first ingested/uploaded into Cosmos; updatedAt = last save in the workbench.",
      "recentlyIngested = newest studies by importedAt (fallback updatedAt) — use for 'when did we ingest / upload / add' asks.",
      "We do not have true profit/GM% in this portfolio extract — 'most profitable' should be answered as highest grandTotal/serviceFees unless margin fields appear in a single-study cosmos context.",
      "For average patient enrollment across ALL studies use averages.enrolledSubjects (not workingStudy / openStudyInUi).",
      "Totals sum drivers and money; missing drivers/money on a study contribute 0 to totals but are excluded from averages.",
      "Year filter uses updatedAt/importedAt calendar year when present.",
      "filters.clientName / filters.year are null when the full portfolio was queried — do not invent a client filter."
    ]
  };
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

async function compareBudgetPair(leftStudy, leftVersion, rightStudy, rightVersion) {
  if (!leftVersion || !rightVersion) {
    throw new Error("One or both budget versions were not found");
  }
  const a = flattenForCompare(leftVersion, leftStudy);
  const b = flattenForCompare(rightVersion, rightStudy);
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

  const [oldLines, newLines] = await Promise.all([
    listLineItems(leftStudy.studyId, leftVersion.id, { limit: 2000 }),
    listLineItems(rightStudy.studyId, rightVersion.id, { limit: 2000 })
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

  const sameStudy = leftStudy.studyId === rightStudy.studyId;
  return {
    mode: sameStudy ? "versions" : "studies",
    studyId: sameStudy ? leftStudy.studyId : null,
    leftStudyId: leftStudy.studyId,
    rightStudyId: rightStudy.studyId,
    older: {
      id: leftVersion.id,
      studyId: leftStudy.studyId,
      label: leftVersion.label,
      clientName: leftStudy.clientName,
      createdAt: leftVersion.createdAt,
      sourceFileName: leftVersion.sourceFileName
    },
    newer: {
      id: rightVersion.id,
      studyId: rightStudy.studyId,
      label: rightVersion.label,
      clientName: rightStudy.clientName,
      createdAt: rightVersion.createdAt,
      sourceFileName: rightVersion.sourceFileName
    },
    fieldChanges: changes,
    fieldUnchangedCount: unchanged.length,
    departmentDiffs,
    lineItemDiffs: lineItemDiffs.slice(0, 300),
    lineItemDiffCount: lineItemDiffs.length,
    notes: leftVersion.snapshot
      ? null
      : "Left budget has no input snapshot (uploaded before versioning fix). Field compare may be limited to totals."
  };
}

async function compareVersions(studyId, olderVersionId, newerVersionId) {
  const study = await getStudy(studyId);
  if (!study) throw new Error(`Study ${studyId} not found`);
  const older = await getVersion(studyId, olderVersionId);
  const newer = await getVersion(studyId, newerVersionId);
  return compareBudgetPair(study, older, study, newer);
}

async function compareStudies(leftStudyId, rightStudyId, leftVersionId, rightVersionId) {
  const leftStudy = await getStudy(leftStudyId);
  const rightStudy = await getStudy(rightStudyId);
  if (!leftStudy) throw new Error(`Study ${leftStudyId} not found`);
  if (!rightStudy) throw new Error(`Study ${rightStudyId} not found`);

  const [leftVersions, rightVersions] = await Promise.all([
    listVersions(leftStudyId),
    listVersions(rightStudyId)
  ]);

  const leftVid =
    leftVersionId ||
    leftStudy.currentVersionId ||
    (leftVersions[0] && leftVersions[0].id);
  const rightVid =
    rightVersionId ||
    rightStudy.currentVersionId ||
    (rightVersions[0] && rightVersions[0].id);

  const [leftVersion, rightVersion] = await Promise.all([
    getVersion(leftStudyId, leftVid),
    getVersion(rightStudyId, rightVid)
  ]);

  return compareBudgetPair(leftStudy, leftVersion, rightStudy, rightVersion);
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
      learnHints: q.learnHints || null,
      learningPromoted: q.learningPromoted || 0,
      preview: q.preview || {},
      createdAt: q.createdAt
    }));
}

async function getParseLearningsSummary() {
  const doc = await loadLearnings(getDb);
  return {
    summary: learningsSummary(doc),
    sheetAliases: doc.sheetAliases || {},
    fieldAliases: doc.fieldAliases || {},
    siteHeaderAliases: doc.siteHeaderAliases || [],
    siteHeaderSignatures: doc.siteHeaderSignatures || [],
    countryAliases: doc.countryAliases || {},
    topSheetProposals: Object.entries(doc.proposals?.sheets || {})
      .sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0))
      .slice(0, 25)
      .map(([key, meta]) => ({ mapping: key, count: meta.count, examples: meta.examples || [] })),
    topFieldProposals: Object.entries(doc.proposals?.fields || {})
      .sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0))
      .slice(0, 25)
      .map(([key, meta]) => ({ mapping: key, count: meta.count, examples: meta.examples || [] })),
    topSiteHeaderProposals: Object.entries(doc.proposals?.siteHeaders || {})
      .sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0))
      .slice(0, 25)
      .map(([key, meta]) => ({ mapping: key, count: meta.count, examples: meta.examples || [] }))
  };
}

async function createManualStudy(payload = {}) {
  const database = getDb();
  const now = new Date().toISOString();
  const rawId = String(payload.studyId || payload.opportunityId || "").trim();
  let studyId = rawId;
  if (!studyId) {
    studyId = `NEW-${now.replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  } else if (/^\d{4,5}$/.test(studyId)) {
    studyId = `O-${studyId.padStart(5, "0")}`;
  } else if (/^O\d{4,5}$/i.test(studyId)) {
    studyId = `O-${studyId.slice(1).padStart(5, "0")}`;
  }

  const driversIn = payload.drivers && typeof payload.drivers === "object" ? payload.drivers : {};
  const drivers = {
    screenedSubjects: numOrNull(driversIn.screenedSubjects),
    enrolledSubjects: numOrNull(driversIn.enrolledSubjects ?? driversIn.patients),
    completedSubjects: numOrNull(driversIn.completedSubjects),
    coreSites: numOrNull(driversIn.coreSites ?? driversIn.sites),
    startupMonths: numOrNull(driversIn.startupMonths),
    enrollmentMonths: numOrNull(driversIn.enrollmentMonths),
    treatmentMonths: numOrNull(driversIn.treatmentMonths),
    dblMonths: numOrNull(driversIn.dblMonths),
    closeoutMonths: numOrNull(driversIn.closeoutMonths),
    screenFailRate: numOrNull(driversIn.screenFailRate),
    dropOutRate: numOrNull(driversIn.dropOutRate),
    sdvPercent: numOrNull(driversIn.sdvPercent),
    contingency: numOrNull(driversIn.contingency) ?? 0,
    inflationRate: numOrNull(driversIn.inflationRate) ?? 0,
    discount: numOrNull(driversIn.discount) ?? 0
  };

  const header = {
    clientName: payload.clientName || null,
    title: payload.title || null,
    protocol: payload.protocol || null,
    phase: payload.phase || null,
    therapeuticArea: payload.therapeuticArea || null,
    indication: payload.indication || null,
    enrollmentType: payload.enrollmentType || null,
    budgetType: payload.budgetType || "draft",
    opportunityId: studyId,
    notes: payload.notes || null
  };

  const versionId = `ver-${studyId}-draft`;
  const studyDoc = {
    id: `study-${studyId}`,
    studyId,
    opportunityId: studyId,
    clientName: header.clientName,
    title: header.title,
    protocol: header.protocol,
    phase: header.phase,
    therapeuticArea: header.therapeuticArea,
    indication: header.indication,
    enrollmentType: header.enrollmentType,
    budgetType: header.budgetType,
    category: payload.category || header.budgetType || "draft",
    status: "draft",
    createdAt: now,
    updatedAt: now,
    importedAt: now,
    currentVersionId: versionId,
    header,
    drivers,
    sites: Array.isArray(payload.sites) ? payload.sites : [],
    totals:
      payload.totals && typeof payload.totals === "object"
        ? payload.totals
        : { serviceFees: null, passThroughs: null, grandTotal: null },
    inputFields: [],
    resourceLeads: [],
    monitoring: {},
    vendors: [],
    payments: {},
    docType: "study",
    createdBy: payload.createdBy || "buddy",
    source: "buddy_create"
  };

  const versionDoc = {
    id: versionId,
    studyId,
    label: String(payload.versionLabel || "draft"),
    sourceSha256: `buddy-${studyId}`,
    sourceFileName: "buddy-created",
    totals: studyDoc.totals,
    execSum: { totals: studyDoc.totals, serviceAreas: [] },
    lineItemCount: 0,
    rateCount: 0,
    createdAt: now,
    confidence: 1,
    docType: "version",
    snapshot: {
      header,
      drivers,
      sites: studyDoc.sites,
      totals: studyDoc.totals,
      inputFields: [],
      clientName: header.clientName,
      title: header.title,
      protocol: header.protocol,
      phase: header.phase,
      therapeuticArea: header.therapeuticArea,
      indication: header.indication,
      enrollmentType: header.enrollmentType,
      budgetType: header.budgetType,
      category: studyDoc.category
    }
  };

  await database.container("studies").items.upsert(studyDoc);
  await database.container("versions").items.upsert(versionDoc);

  return {
    status: "created",
    studyId,
    versionId,
    study: studyDoc,
    version: versionDoc
  };
}

function nextVersionLabel(existingLabels = [], preferred) {
  const pref = String(preferred || "").trim();
  if (pref) return pref;
  const nums = (existingLabels || [])
    .map((l) => {
      const m = String(l || "").match(/^v(\d+)$/i);
      return m ? Number(m[1]) : null;
    })
    .filter((n) => n != null);
  const max = nums.length ? Math.max(...nums) : 0;
  return `v${max + 1}`;
}

/**
 * Upsert study header/drivers/sites and write a version snapshot to Cosmos.
 * mode: "update" updates currentVersionId in place; "new" creates a new version (v2, v3…).
 */
async function saveStudyVersion(studyId, payload = {}) {
  const id = String(studyId || payload.studyId || "").trim();
  if (!id) throw new Error("studyId is required");
  const database = getDb();
  const now = new Date().toISOString();
  const existing = await getStudy(id);
  const versions = await listVersions(id);
  const mode = String(payload.mode || "update").toLowerCase() === "new" ? "new" : "update";

  const driversIn = payload.drivers && typeof payload.drivers === "object" ? payload.drivers : existing?.drivers || {};
  const drivers = {
    screenedSubjects: numOrNull(driversIn.screenedSubjects),
    enrolledSubjects: numOrNull(driversIn.enrolledSubjects ?? driversIn.patients),
    completedSubjects: numOrNull(driversIn.completedSubjects),
    coreSites: numOrNull(driversIn.coreSites ?? driversIn.sites),
    startupMonths: numOrNull(driversIn.startupMonths),
    enrollmentMonths: numOrNull(driversIn.enrollmentMonths),
    treatmentMonths: numOrNull(driversIn.treatmentMonths),
    dblMonths: numOrNull(driversIn.dblMonths),
    closeoutMonths: numOrNull(driversIn.closeoutMonths),
    screenFailRate: numOrNull(driversIn.screenFailRate),
    dropOutRate: numOrNull(driversIn.dropOutRate),
    sdvPercent: numOrNull(driversIn.sdvPercent),
    contingency: numOrNull(driversIn.contingency),
    inflationRate: numOrNull(driversIn.inflationRate),
    discount: numOrNull(driversIn.discount)
  };

  const totalsIn = payload.totals && typeof payload.totals === "object" ? payload.totals : existing?.totals || {};
  const serviceFees = numOrNull(totalsIn.serviceFees ?? totalsIn["Total Service Fees"]);
  const passThroughs = numOrNull(totalsIn.passThroughs ?? totalsIn["Pass-Throughs"]);
  const grandTotal =
    numOrNull(totalsIn.grandTotal) ??
    (serviceFees != null ? serviceFees + (passThroughs || 0) : null);
  const totals = {
    ...(typeof totalsIn === "object" ? totalsIn : {}),
    serviceFees,
    passThroughs,
    grandTotal,
    "Total Service Fees": serviceFees,
    "Pass-Throughs": passThroughs
  };

  const header = {
    ...(existing?.header || {}),
    clientName: payload.clientName ?? existing?.clientName ?? null,
    title: payload.title ?? existing?.title ?? null,
    protocol: payload.protocol ?? existing?.protocol ?? null,
    phase: payload.phase ?? existing?.phase ?? null,
    therapeuticArea: payload.therapeuticArea ?? existing?.therapeuticArea ?? null,
    indication: payload.indication ?? existing?.indication ?? null,
    enrollmentType: payload.enrollmentType ?? existing?.enrollmentType ?? null,
    budgetType: payload.budgetType ?? existing?.budgetType ?? "draft",
    opportunityId: id,
    notes: payload.notes ?? existing?.header?.notes ?? null
  };

  const sites = Array.isArray(payload.sites)
    ? payload.sites
    : Array.isArray(existing?.sites)
      ? existing.sites
      : [];

  const label = nextVersionLabel(
    versions.map((v) => v.label),
    payload.versionLabel || (mode === "new" ? null : existing?.versionLabel || payload.label)
  );

  let versionId =
    mode === "update" && existing?.currentVersionId
      ? existing.currentVersionId
      : `ver-${id}-${label.replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase()}-${Date.now().toString(36)}`;

  // If updating but no current version, create one
  if (mode === "update" && !existing?.currentVersionId) {
    versionId = `ver-${id}-${label.replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase()}`;
  }

  const studyDoc = {
    ...(existing || {}),
    id: existing?.id || `study-${id}`,
    studyId: id,
    opportunityId: id,
    clientName: header.clientName,
    title: header.title,
    protocol: header.protocol,
    phase: header.phase,
    therapeuticArea: header.therapeuticArea,
    indication: header.indication,
    enrollmentType: header.enrollmentType,
    budgetType: header.budgetType,
    status: payload.status || existing?.status || "draft",
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    importedAt: existing?.importedAt || now,
    currentVersionId: versionId,
    header,
    drivers,
    sites,
    totals,
    inputFields: Array.isArray(payload.inputFields) ? payload.inputFields : existing?.inputFields || [],
    assumptions: payload.assumptions || existing?.assumptions || {},
    sectionStatus: payload.sectionStatus || existing?.sectionStatus || {},
    docType: "study",
    source: payload.source || existing?.source || "workbench_save",
    category: payload.category || existing?.category || header.budgetType || "draft"
  };

  const prevVersion =
    mode === "new" && existing?.currentVersionId
      ? await getVersion(id, existing.currentVersionId).catch(() => null)
      : null;

  const versionDoc = {
    id: versionId,
    studyId: id,
    label,
    sourceSha256: `save-${id}-${now}`,
    sourceFileName: payload.sourceFileName || "workbench-save",
    totals,
    execSum: { totals, serviceAreas: [] },
    lineItemCount: 0,
    rateCount: 0,
    createdAt: mode === "update" ? existing?.updatedAt || now : now,
    updatedAt: now,
    confidence: 1,
    docType: "version",
    copiedFromVersionId: mode === "new" ? existing?.currentVersionId || null : null,
    parentVersionId: prevVersion?.id || null,
    snapshot: {
      header,
      drivers,
      sites,
      totals,
      inputFields: studyDoc.inputFields,
      assumptions: studyDoc.assumptions,
      clientName: header.clientName,
      title: header.title,
      protocol: header.protocol,
      phase: header.phase,
      therapeuticArea: header.therapeuticArea,
      indication: header.indication,
      enrollmentType: header.enrollmentType,
      budgetType: header.budgetType,
      category: studyDoc.category
    }
  };

  await database.container("studies").items.upsert(studyDoc);
  await database.container("versions").items.upsert(versionDoc);

  return {
    status: mode === "new" ? "version_created" : "saved",
    studyId: id,
    versionId,
    versionLabel: label,
    study: studyDoc,
    version: versionDoc,
    versions: await listVersions(id)
  };
}

const LOCK_TTL_SECONDS = 90;
const LOCK_STALE_MS = LOCK_TTL_SECONDS * 1000;

function lockDocId(studyId, sectionId) {
  return `lock-${studyId}-${sectionId}`;
}

function isLockActive(lock) {
  if (!lock || lock.docType !== "sectionLock") return false;
  const seen = Date.parse(lock.lastSeenAt || lock.lockedAt || 0);
  if (!Number.isFinite(seen)) return false;
  return Date.now() - seen < LOCK_STALE_MS;
}

async function listSectionLocks(studyId) {
  const id = String(studyId || "").trim();
  if (!id) return [];
  const database = getDb();
  const { resources } = await database.container("studies").items
    .query({
      query: "SELECT * FROM c WHERE c.studyId = @id AND c.docType = @t",
      parameters: [
        { name: "@id", value: id },
        { name: "@t", value: "sectionLock" }
      ]
    })
    .fetchAll();
  return (resources || []).filter(isLockActive);
}

async function getSectionLock(studyId, sectionId) {
  const locks = await listSectionLocks(studyId);
  return locks.find((l) => l.sectionId === sectionId) || null;
}

async function claimSectionLock(studyId, sectionId, holder = {}, { takeover = false, force = false } = {}) {
  const sid = String(studyId || "").trim();
  const section = String(sectionId || "").trim();
  if (!sid || !section) throw new Error("studyId and sectionId are required");
  const holderUserId = String(holder.userId || holder.email || "").trim();
  if (!holderUserId) throw new Error("holder userId is required");

  const database = getDb();
  const now = new Date().toISOString();
  const id = lockDocId(sid, section);
  let existing = null;
  try {
    const { resource } = await database.container("studies").item(id, sid).read();
    existing = resource;
  } catch (_) {
    existing = null;
  }

  const active = isLockActive(existing);
  const sameHolder =
    active &&
    (existing.holderUserId === holderUserId ||
      (holder.email && existing.holderEmail && existing.holderEmail === holder.email));

  let savedForPrevious = null;
  if (active && !sameHolder) {
    if (!takeover && !force) {
      const err = new Error(
        `${existing.holderName || existing.holderEmail || "Someone"} is editing ${section}`
      );
      err.status = 409;
      err.lock = existing;
      throw err;
    }
    // Takeover: persist holder draft if present, then steal lock
    if (existing.draft && typeof existing.draft === "object") {
      try {
        savedForPrevious = await saveSectionPatch(sid, section, {
          ...existing.draft,
          mode: "update",
          source: "takeover_force_save",
          createdBy: existing.holderUserId || existing.holderEmail || "takeover"
        });
      } catch (saveErr) {
        savedForPrevious = { error: String(saveErr.message || saveErr) };
      }
    }
  }

  const lockDoc = {
    id,
    studyId: sid,
    sectionId: section,
    docType: "sectionLock",
    holderUserId,
    holderName: holder.displayName || holder.firstName || holder.email || holderUserId,
    holderEmail: holder.email || null,
    lockedAt: sameHolder && existing?.lockedAt ? existing.lockedAt : now,
    lastSeenAt: now,
    draft: sameHolder ? existing?.draft || null : null,
    pendingTakeover: null,
    ttl: LOCK_TTL_SECONDS
  };

  await database.container("studies").items.upsert(lockDoc);
  return {
    status: takeover || force ? "taken_over" : sameHolder ? "heartbeat" : "claimed",
    lock: lockDoc,
    savedForPrevious
  };
}

async function heartbeatSectionLock(studyId, sectionId, holder = {}, draft = null) {
  const sid = String(studyId || "").trim();
  const section = String(sectionId || "").trim();
  const holderUserId = String(holder.userId || holder.email || "").trim();
  const database = getDb();
  const id = lockDocId(sid, section);
  let existing = null;
  try {
    const { resource } = await database.container("studies").item(id, sid).read();
    existing = resource;
  } catch (_) {
    return { status: "missing", lock: null };
  }
  if (!isLockActive(existing)) {
    return { status: "expired", lock: existing };
  }
  const same =
    existing.holderUserId === holderUserId ||
    (holder.email && existing.holderEmail && existing.holderEmail === holder.email);
  if (!same) {
    const err = new Error("You do not hold this lock");
    err.status = 403;
    err.lock = existing;
    throw err;
  }
  const now = new Date().toISOString();
  const lockDoc = {
    ...existing,
    lastSeenAt: now,
    holderName: holder.displayName || holder.firstName || existing.holderName,
    holderEmail: holder.email || existing.holderEmail,
    draft: draft && typeof draft === "object" ? draft : existing.draft || null,
    ttl: LOCK_TTL_SECONDS
  };
  await database.container("studies").items.upsert(lockDoc);
  return {
    status: "ok",
    lock: lockDoc,
    pendingTakeover: lockDoc.pendingTakeover || null
  };
}

async function requestSectionTakeover(studyId, sectionId, by = {}) {
  const sid = String(studyId || "").trim();
  const section = String(sectionId || "").trim();
  const database = getDb();
  const id = lockDocId(sid, section);
  let existing = null;
  try {
    const { resource } = await database.container("studies").item(id, sid).read();
    existing = resource;
  } catch (_) {
    return { status: "free", lock: null };
  }
  if (!isLockActive(existing)) {
    return { status: "free", lock: existing };
  }
  const now = new Date().toISOString();
  const lockDoc = {
    ...existing,
    pendingTakeover: {
      byUserId: by.userId || by.email || null,
      byName: by.displayName || by.firstName || by.email || "Admin",
      at: now
    },
    lastSeenAt: existing.lastSeenAt,
    ttl: LOCK_TTL_SECONDS
  };
  await database.container("studies").items.upsert(lockDoc);
  return { status: "takeover_requested", lock: lockDoc };
}

async function releaseSectionLock(studyId, sectionId, holder = {}, { force = false } = {}) {
  const sid = String(studyId || "").trim();
  const section = String(sectionId || "").trim();
  const holderUserId = String(holder.userId || holder.email || "").trim();
  const database = getDb();
  const id = lockDocId(sid, section);
  let existing = null;
  try {
    const { resource } = await database.container("studies").item(id, sid).read();
    existing = resource;
  } catch (_) {
    return { status: "already_free" };
  }
  if (!force) {
    const same =
      existing.holderUserId === holderUserId ||
      (holder.email && existing.holderEmail && existing.holderEmail === holder.email);
    if (!same && isLockActive(existing)) {
      const err = new Error("You do not hold this lock");
      err.status = 403;
      err.lock = existing;
      throw err;
    }
  }
  try {
    await database.container("studies").item(id, sid).delete();
  } catch (_) {}
  return { status: "released", previous: existing };
}

/** Merge only fields owned by a section into the study + current version. */
async function saveSectionPatch(studyId, sectionId, payload = {}) {
  const existing = await getStudy(studyId);
  if (!existing && payload.mode !== "create") {
    // Fall back to full save path for brand-new studies
    return saveStudyVersion(studyId, { ...payload, mode: payload.mode || "update" });
  }

  const section = String(sectionId || "").trim();
  const merged = { ...(payload || {}), mode: payload.mode || "update" };

  // Start from existing study values; overlay only section-owned keys from payload
  const base = existing || {};
  if (section === "hlbp" || section === "overview") {
    for (const k of [
      "clientName",
      "title",
      "protocol",
      "phase",
      "therapeuticArea",
      "indication",
      "enrollmentType",
      "budgetType",
      "category",
      "versionLabel"
    ]) {
      if (payload[k] !== undefined) merged[k] = payload[k];
      else if (base[k] !== undefined) merged[k] = base[k];
    }
    if (payload.drivers) merged.drivers = { ...(base.drivers || {}), ...payload.drivers };
    else merged.drivers = base.drivers;
    if (section === "hlbp") {
      if (payload.sites) merged.sites = payload.sites;
      else merged.sites = base.sites;
      if (payload.totals) merged.totals = { ...(base.totals || {}), ...payload.totals };
      else merged.totals = base.totals;
    } else {
      merged.sites = payload.sites || base.sites;
      merged.totals = payload.totals || base.totals;
      if (payload.inputFields) merged.inputFields = payload.inputFields;
      else merged.inputFields = base.inputFields;
    }
  } else if (["recruitment", "clinops", "monitoring", "smo"].includes(section)) {
    for (const k of [
      "clientName",
      "title",
      "protocol",
      "phase",
      "therapeuticArea",
      "indication",
      "enrollmentType",
      "budgetType",
      "category",
      "versionLabel",
      "drivers",
      "sites",
      "totals",
      "inputFields"
    ]) {
      merged[k] = payload[k] !== undefined ? payload[k] : base[k];
    }
    // Prefer payload drivers when present (dept tabs edit related drivers)
    if (payload.drivers) merged.drivers = { ...(base.drivers || {}), ...payload.drivers };
    const assumptions = { ...(base.assumptions || {}) };
    if (payload.assumptions && payload.assumptions[section]) {
      assumptions[section] = {
        ...(assumptions[section] || {}),
        ...payload.assumptions[section]
      };
    }
    merged.assumptions = assumptions;
    if (section === "monitoring" && payload.monitoringInputs) {
      merged.monitoring = payload.monitoringInputs;
    }
    if (section === "smo") {
      if (payload.vendors) merged.vendors = payload.vendors;
      if (payload.payments) merged.payments = payload.payments;
    }
  } else {
    return saveStudyVersion(studyId, { ...payload, mode: payload.mode || "update" });
  }

  if (payload.sectionStatus) {
    merged.sectionStatus = { ...(base.sectionStatus || {}), ...payload.sectionStatus };
  } else {
    merged.sectionStatus = base.sectionStatus;
  }
  merged.source = payload.source || "section_save";
  return saveStudyVersion(studyId, merged);
}

module.exports = {
  upsertCanonical,
  createManualStudy,
  saveStudyVersion,
  saveSectionPatch,
  listStudies,
  listStudiesWithDrivers,
  buildPortfolioContext,
  getStudy,
  listVersions,
  getVersion,
  listLineItems,
  compareVersions,
  compareStudies,
  listQuarantine,
  getParseLearningsSummary,
  loadLearnings,
  getDb,
  listSectionLocks,
  getSectionLock,
  claimSectionLock,
  heartbeatSectionLock,
  requestSectionTakeover,
  releaseSectionLock,
  LOCK_TTL_SECONDS
};
