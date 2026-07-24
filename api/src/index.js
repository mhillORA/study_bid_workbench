const { app } = require("@azure/functions");
const AdmZip = require("adm-zip");
const { parseWorkbookBuffer } = require("./parseWorkbook");
const { upsertCanonical, createManualStudy, listStudies, getStudy, listVersions, getVersion, listLineItems, compareVersions, compareStudies, listQuarantine, getParseLearningsSummary, loadLearnings, getDb, buildPortfolioContext } = require("./cosmosLoad");
const { askAi, getStudyContext, providerStatus } = require("./askClaude");
const {
  buildIntelligenceContext,
  getIntelligenceHealth,
  isIntelligenceQuestion,
  extractIndicationFromQuestion
} = require("./intelligence");

function nctFromQuestion(question) {
  const m = String(question || "").match(/\b(NCT\d{8})\b/i);
  return m ? m[1].toUpperCase() : null;
}

function json(status, body) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    jsonBody: body
  };
}

function headerGet(request, name) {
  return (
    request.headers.get(name) ||
    request.headers.get(name.toLowerCase()) ||
    request.headers.get(name.toUpperCase()) ||
    ""
  );
}

/** Infer studyId / client / year from the question + known client list. */
function isCrossStudyQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  // Explicit multi-study / portfolio intent
  if (
    /\b(all studies|across (all )?studies|every study|entire portfolio|whole portfolio|portfolio)\b/.test(q) ||
    /\b(across|among|between)\b.{0,40}\bstudies\b/.test(q) ||
    /\b(how many studies|which study|which studies|largest study|biggest study|most expensive|highest budget)\b/.test(q) ||
    /\b(largest|biggest|highest|top)\b.{0,40}\b(budget|fee|enrollment|study|studies)\b/.test(q) ||
    /\b(average|avg|mean|median|total|sum|rollup)\b.{0,60}\b(across|all|every|portfolio|studies)\b/.test(q) ||
    /\b(enroll|patient|subject|budget|fee).{0,40}\b(across|all studies|every study)\b/.test(q) ||
    /\bstudies\b.{0,40}\b(last year|this year|in 20\d{2}|overall|combined)\b/.test(q) ||
    /\bcompare\b.{0,40}\bstud(y|ies)\b/.test(q)
  ) {
    return true;
  }
  return false;
}

function inferAskHints(question, body, clientNames) {
  const q = String(question || "");
  const crossStudy = isCrossStudyQuestion(q) || body.portfolio === true;
  // Explicit O-##### in the question wins; otherwise open-study id from the UI
  // must NOT bind cross-study / "all studies" questions to one workbook.
  const explicitStudy =
    (q.match(/\b(O-\d{3,})\b/i) || q.match(/\b(FILE-[A-Za-z0-9._-]{4,})\b/))?.[1] || null;

  let studyId = explicitStudy;
  if (!studyId && !crossStudy && body.studyId) {
    studyId = String(body.studyId).trim();
  }

  let clientName = body.clientName ? String(body.clientName).trim() : null;
  let year = body.year != null && body.year !== "" ? Number(body.year) : null;

  if (!year || Number.isNaN(year)) {
    if (/\blast\s+year\b/i.test(q)) year = new Date().getFullYear() - 1;
    else {
      const ym = q.match(/\b(20\d{2})\b/);
      if (ym) year = Number(ym[1]);
      else year = null;
    }
  }

  if (!clientName && Array.isArray(clientNames) && clientNames.length) {
    const lower = q.toLowerCase();
    const sorted = [...clientNames].sort((a, b) => String(b).length - String(a).length);
    for (const name of sorted) {
      if (name && lower.includes(String(name).toLowerCase())) {
        clientName = name;
        break;
      }
    }
  }

  if (!clientName) {
    const m = q.match(
      /\b(?:with|for|client|sponsor|customer)\s+([A-Za-z][A-Za-z0-9 .&'-]{1,40?}?)(?:\s+last|\s+in\s+20|\s+studies|\s+patients|\s+enrollment|\?|$)/i
    );
    if (m) clientName = m[1].trim();
  }

  return { studyId, clientName, year, crossStudy };
}

function claimMap(claims) {
  const map = {};
  if (!Array.isArray(claims)) return map;
  for (const c of claims) {
    if (!c || c.typ == null) continue;
    map[String(c.typ)] = c.val;
    const short = String(c.typ).split("/").pop();
    if (short && map[short] == null) map[short] = c.val;
  }
  return map;
}

function firstNameFrom(displayName, email, givenName) {
  if (givenName && String(givenName).trim()) {
    return String(givenName).trim().split(/\s+/)[0];
  }
  if (displayName && String(displayName).trim()) {
    const d = String(displayName).trim();
    if (!d.includes("@")) return d.split(/[\s,]+/)[0];
  }
  if (email && String(email).includes("@")) {
    const local = String(email).split("@")[0];
    const token = local.split(/[._-]/)[0];
    if (token) return token.charAt(0).toUpperCase() + token.slice(1);
  }
  return null;
}

/** Prefer SWA Easy Auth headers; never trust client-supplied identity alone. */
function signedInUserFromRequest(request, bodyUser) {
  const encoded = headerGet(request, "x-ms-client-principal");
  if (encoded) {
    try {
      const raw = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      const claims = claimMap(raw.claims);
      const email =
        raw.userDetails ||
        claims.preferred_username ||
        claims.email ||
        claims.emails ||
        headerGet(request, "x-ms-client-principal-name") ||
        null;
      const displayName =
        claims.name ||
        claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"] ||
        null;
      const givenName =
        claims.given_name ||
        claims.givenname ||
        claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname"] ||
        null;
      const firstName = firstNameFrom(displayName, email, givenName);
      return {
        userId: raw.userId || headerGet(request, "x-ms-client-principal-id") || null,
        identityProvider: raw.identityProvider || headerGet(request, "x-ms-client-principal-idp") || "aad",
        email: email || null,
        displayName: displayName || email || null,
        firstName,
        source: "swa_principal"
      };
    } catch (_) {
      /* fall through */
    }
  }

  const headerName = headerGet(request, "x-ms-client-principal-name");
  if (headerName) {
    return {
      userId: headerGet(request, "x-ms-client-principal-id") || null,
      identityProvider: headerGet(request, "x-ms-client-principal-idp") || "aad",
      email: headerName.includes("@") ? headerName : null,
      displayName: headerName,
      firstName: firstNameFrom(headerName, headerName, null),
      source: "swa_headers"
    };
  }

  // Local / pre-auth preview only — optional hint from browser /.auth/me
  if (bodyUser && (bodyUser.email || bodyUser.displayName || bodyUser.firstName)) {
    const email = bodyUser.email || null;
    const displayName = bodyUser.displayName || email;
    return {
      userId: bodyUser.userId || null,
      identityProvider: bodyUser.identityProvider || "client",
      email,
      displayName,
      firstName: bodyUser.firstName || firstNameFrom(displayName, email, null),
      source: "client_hint"
    };
  }

  return null;
}

async function collectXlsxFromRequest(request) {
  const files = [];
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    for (const [key, value] of form.entries()) {
      if (key === "mode" || key === "requestedBy") continue;
      if (value && typeof value.arrayBuffer === "function") {
        const name = value.name || key;
        const buf = Buffer.from(await value.arrayBuffer());
        files.push({ name, buffer: buf });
      }
    }
    return {
      files,
      mode: String(form.get("mode") || "load"),
      requestedBy: String(form.get("requestedBy") || "anonymous")
    };
  }

  // Raw single file body with filename header
  const buf = Buffer.from(await request.arrayBuffer());
  const name = request.headers.get("x-file-name") || "upload.xlsx";
  files.push({ name, buffer: buf });
  return { files, mode: "load", requestedBy: "anonymous" };
}

function zipBaseName(entryName) {
  const parts = String(entryName || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function isParseableExcel(name) {
  const low = String(name || "").toLowerCase();
  return low.endsWith(".xlsx") || low.endsWith(".xlsm");
}

function expandArchives(files, depth = 0) {
  const out = [];
  for (const f of files) {
    const lower = String(f.name || "").toLowerCase();
    if (lower.endsWith(".zip")) {
      if (depth > 3) continue;
      const zip = new AdmZip(f.buffer);
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const full = String(entry.entryName || "").replace(/\\/g, "/");
        if (full.includes("__MACOSX/") || full.endsWith(".DS_Store")) continue;
        const en = zipBaseName(full);
        if (!en || en.startsWith("~$")) continue;
        const enLow = en.toLowerCase();
        if (enLow.endsWith(".zip")) {
          out.push(
            ...expandArchives([{ name: en, buffer: entry.getData() }], depth + 1)
          );
          continue;
        }
        if (!isParseableExcel(en)) continue;
        // Preserve folder uniqueness in the study/file name
        const folderPrefix = full
          .slice(0, Math.max(0, full.length - en.length))
          .replace(/\/+$/, "")
          .replace(/[\\/]+/g, "_");
        const name = folderPrefix ? `${folderPrefix}_${en}` : en;
        out.push({ name, buffer: entry.getData() });
      }
    } else if (isParseableExcel(f.name)) {
      out.push(f);
    }
  }
  return out;
}

app.http("import", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "import",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "content-type"
        }
      };
    }

    const jobId = `job-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    const report = {
      jobId,
      loaded: [],
      quarantined: [],
      failed: []
    };

    try {
      const { files, mode } = await collectXlsxFromRequest(request);
      const workbooks = expandArchives(files);
      if (!workbooks.length) {
        return json(400, { error: "No .xlsx/.xlsm workbooks found in upload (nested zip folders are scanned)" });
      }

      const dryRun = mode === "dry";
      let learnings = null;
      try {
        learnings = await loadLearnings(getDb);
      } catch (_) {
        learnings = null;
      }

      for (const wb of workbooks) {
        try {
          const canonical = await parseWorkbookBuffer(wb.buffer, wb.name, { learnings });
          const entry = {
            file: wb.name,
            studyId: canonical.study.studyId,
            confidence: canonical.confidence,
            lineItems: canonical.version.lineItemCount,
            warnings: canonical.warnings,
            quarantineReasons: canonical.quarantineReasons || [],
            missingSheets: canonical.fingerprint?.missingSheets || [],
            learnHints: canonical.learnHints || null
          };
          if (dryRun) {
            entry.cosmosStatus = canonical.quarantine ? "quarantined" : "dry_run_ok";
            (canonical.quarantine ? report.quarantined : report.loaded).push(entry);
          } else {
            const summary = await upsertCanonical(canonical, jobId);
            entry.cosmosStatus = summary.status;
            entry.versionId = summary.versionId;
            entry.learningPromoted = summary.learningPromoted || 0;
            // Refresh learnings so later files in the same batch benefit
            try {
              learnings = await loadLearnings(getDb);
            } catch (_) {}
            (summary.status === "quarantined" ? report.quarantined : report.loaded).push(entry);
          }
          context.log(`OK ${wb.name} -> ${entry.studyId} (${entry.cosmosStatus})`);
        } catch (err) {
          context.error(`FAIL ${wb.name}`, err);
          let msg = String(err.message || err);
          if (/firewall|blocked by your Cosmos|through public internet/i.test(msg)) {
            msg = "COSMOS_FIREWALL: Azure blocked the API IP. Cosmos → Networking → allow Azure datacenters (or All networks).";
          }
          if (/Entity with the specified id already exists|Request size is too large|Timeout|timed out/i.test(msg)) {
            msg = `COSMOS_WRITE: ${msg.slice(0, 300)}`;
          }
          report.failed.push({
            file: wb.name,
            error: msg,
            errorName: err.name || null,
            stack: String(err.stack || "").split("\n").slice(0, 4)
          });
        }
      }

      report.counts = {
        loaded: report.loaded.length,
        quarantined: report.quarantined.length,
        failed: report.failed.length,
        files: workbooks.length
      };
      report.mode = dryRun ? "dry" : "load";
      return json(200, report);
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err), jobId });
    }
  }
});

app.http("studies", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "studies",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "content-type"
        }
      };
    }
    try {
      if (request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const result = await createManualStudy(body || {});
        return json(200, result);
      }
      const studies = await listStudies(Number(new URL(request.url).searchParams.get("limit") || 500));
      return json(200, { studies });
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("studyById", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "studies/{studyId}",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS"
        }
      };
    }
    try {
      const studyId = request.params.studyId;
      const study = await getStudy(studyId);
      if (!study) return json(404, { error: `Study ${studyId} not found` });
      const versions = await listVersions(studyId);
      let version = null;
      let lineItems = [];
      const versionId = study.currentVersionId || (versions[0] && versions[0].id);
      if (versionId) {
        version = await getVersion(studyId, versionId);
        lineItems = await listLineItems(studyId, versionId, { limit: 400 });
      }
      return json(200, { study, versions, version, lineItems });
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("studyVersions", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "studies/{studyId}/versions",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS"
        }
      };
    }
    try {
      const studyId = request.params.studyId;
      const versions = await listVersions(studyId);
      return json(200, { studyId, versions });
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("studyVersionById", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "studies/{studyId}/versions/{versionId}",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS"
        }
      };
    }
    try {
      const { studyId, versionId } = request.params;
      const version = await getVersion(studyId, versionId);
      if (!version) return json(404, { error: "Version not found" });
      const lineItems = await listLineItems(studyId, versionId, { limit: 400 });
      return json(200, { version, lineItems });
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("studyCompare", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "studies/{studyId}/compare",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS"
        }
      };
    }
    try {
      const studyId = request.params.studyId;
      const url = new URL(request.url);
      const older = url.searchParams.get("older");
      const newer = url.searchParams.get("newer");
      if (!older || !newer) {
        return json(400, { error: "Query params older & newer (version ids) are required" });
      }
      const diff = await compareVersions(studyId, older, newer);
      return json(200, diff);
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("budgetsCompare", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "compare",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS"
        }
      };
    }
    try {
      const url = new URL(request.url);
      const left = url.searchParams.get("left");
      const right = url.searchParams.get("right");
      const leftVersion = url.searchParams.get("leftVersion");
      const rightVersion = url.searchParams.get("rightVersion");
      if (!left || !right) {
        return json(400, { error: "Query params left & right (study ids) are required" });
      }
      const diff = await compareStudies(left, right, leftVersion, rightVersion);
      return json(200, diff);
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("GetRoles", {
  methods: ["POST", "GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "GetRoles",
  handler: async (request) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "content-type"
        }
      };
    }
    // SWA calls this after Entra login to assign custom roles.
    // Returning "reader" for any successful auth; Entra group assignment still gates who can sign in.
    try {
      if (request.method === "POST") {
        await request.json().catch(() => ({}));
      }
    } catch (_) {
      /* ignore body parse errors */
    }
    return json(200, { roles: ["reader"] });
  }
});

app.http("health", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: async () => {
    const llm = providerStatus();
    return json(200, {
      ok: true,
      service: "study-bid-workbench-api",
      llm
    });
  }
});

app.http("intelligenceHealth", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "intelligence",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "content-type"
        }
      };
    }
    try {
      const health = await getIntelligenceHealth(getDb);
      return json(200, health);
    } catch (err) {
      context.error(err);
      return json(500, { ok: false, error: String(err.message || err) });
    }
  }
});

app.http("intelligenceIndication", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "intelligence/indication",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "content-type"
        }
      };
    }
    try {
      const q = request.query.get("q") || request.query.get("indication") || "";
      if (!String(q).trim()) {
        return json(400, { error: "query param q (indication) is required" });
      }
      const pack = await buildIntelligenceContext(getDb, {
        question: `benchmark ${q}`,
        indication: String(q).trim(),
        force: true
      });
      return json(200, pack);
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("quarantine", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "quarantine",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "content-type"
        }
      };
    }
    try {
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get("limit") || 200);
      const items = await listQuarantine(limit);
      const reasonBuckets = {};
      for (const q of items) {
        const reasons = Array.isArray(q.reason) ? q.reason : [String(q.reason || "unknown")];
        for (const r of reasons) {
          const key = String(r).slice(0, 120);
          reasonBuckets[key] = (reasonBuckets[key] || 0) + 1;
        }
      }
      let learnings = null;
      try {
        learnings = await getParseLearningsSummary();
      } catch (err) {
        learnings = { error: String(err.message || err) };
      }
      return json(200, { count: items.length, reasonBuckets, learnings, items });
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("ask", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "ask",
  handler: async (request, context) => handleAskRequest(request, context, { requireCopilotKey: false })
});

/** Copilot Studio entry — same Buddy context builder; requires x-copilot-key. */
app.http("copilotAsk", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "copilot/ask",
  handler: async (request, context) => handleAskRequest(request, context, { requireCopilotKey: true })
});

async function handleAskRequest(request, context, { requireCopilotKey }) {
  if (request.method === "OPTIONS") {
    return {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, x-copilot-key"
      }
    };
  }

  try {
    if (requireCopilotKey) {
      const expected = String(process.env.COPILOT_ASK_KEY || "").trim();
      const got = String(headerGet(request, "x-copilot-key") || "").trim();
      if (!expected || expected.includes("SET_IN") || got !== expected) {
        return json(401, { error: "Invalid or missing x-copilot-key" });
      }
    }

    const body = await request.json();
    const question = String(body.question || "").trim();
    if (!question) return json(400, { error: "question is required" });

    // ALWAYS query Cosmos for the full portfolio — Buddy must not be limited to the open UI study.
    let portfolioFull = null;
    let clientDirectory = [];
    try {
      portfolioFull = await buildPortfolioContext({ limit: 500 });
      clientDirectory = portfolioFull.clientNamesInDatabase || [];
    } catch (err) {
      portfolioFull = { source: "cosmos_portfolio_error", error: String(err.message || err) };
      clientDirectory = [];
    }

    const hints = inferAskHints(question, body, clientDirectory);
    // noStudy / empty selection = portfolio only. portfolio:true alone still allows single-study when studyId/snapshot sent.
    const forcePortfolio =
      body.noStudy === true ||
      Boolean(hints.crossStudy) ||
      (!body.studyId && !body.studySnapshot);
    const studyId = forcePortfolio
      ? (String(question).match(/\b(O-\d{3,})\b/i) || [])[1] || null
      : hints.studyId;
    const crossStudy = Boolean(hints.crossStudy) || forcePortfolio;
    const history = body.history || [];
    const user = signedInUserFromRequest(request, body.user || null);
    const activeTab = body.activeTab ? String(body.activeTab) : null;
    const activeTabLabel = body.activeTabLabel ? String(body.activeTabLabel) : null;
    const editableFields = Array.isArray(body.editableFields) ? body.editableFields : null;
    const fieldsByTab = body.fieldsByTab && typeof body.fieldsByTab === "object" ? body.fieldsByTab : null;

    const answerFocus =
      forcePortfolio || crossStudy
        ? "portfolio"
        : studyId || body.studySnapshot
          ? "single_study"
          : "portfolio";

    // Browser working copy only for single-study questions
    const clientStudy = answerFocus === "portfolio" ? null : body.studySnapshot || null;

    let cosmosContext = null;
    if (studyId && answerFocus === "single_study") {
      cosmosContext = await getStudyContext(studyId, { getDb });
    }

    // Prefer filtered portfolio when the question names a client/year; else full DB rollup
    let portfolio = portfolioFull;
    if (
      portfolioFull &&
      portfolioFull.source === "cosmos_portfolio" &&
      (hints.clientName || hints.year)
    ) {
      try {
        const filtered = await buildPortfolioContext({
          clientName: hints.clientName,
          year: hints.year,
          limit: 500
        });
        if (hints.clientName && filtered.matchedStudyCount === 0) {
          portfolio = {
            ...portfolioFull,
            filters: {
              ...(portfolioFull.filters || {}),
              clientNameRequested: hints.clientName,
              year: hints.year || null,
              matched: false
            },
            note: `No studies matched client filter "${hints.clientName}". Showing full database portfolio.`
          };
        } else {
          portfolio = filtered;
        }
      } catch (err) {
        portfolio = { ...portfolioFull, filterError: String(err.message || err) };
      }
    }

    // Ora Clinical Intelligence (Veeva + TrialHub) — summaries only when relevant
    let intelligence = null;
    try {
      const snap = body.studySnapshot || clientStudy || null;
      const snapIndication =
        (snap && snap.indication) ||
        (cosmosContext && cosmosContext.study && cosmosContext.study.indication) ||
        null;
      const snapClient =
        (snap && snap.clientName) ||
        (cosmosContext && cosmosContext.study && cosmosContext.study.clientName) ||
        null;
      const qIndication = extractIndicationFromQuestion(question);
      const indication = qIndication || snapIndication || null;
      const forceIntel = isIntelligenceQuestion(question) || Boolean(nctFromQuestion(question));
      if (forceIntel || indication || hints.clientName || snapIndication) {
        intelligence = await buildIntelligenceContext(getDb, {
          question,
          indication,
          clientName: hints.clientName || snapClient || null,
          sponsor: hints.clientName || snapClient || null,
          force: forceIntel || Boolean(indication)
        });
      }
    } catch (err) {
      intelligence = { source: "ora_clinical_intelligence_error", error: String(err.message || err) };
    }

    const openStudyId = body.studyId ? String(body.studyId).trim() : null;
    const contextPayload = {
      askedAt: new Date().toISOString(),
      source: requireCopilotKey ? "copilot_studio" : "workbench",
      answerFocus,
      dataSources: {
        cosmosPortfolioQueried: Boolean(portfolio && portfolio.source === "cosmos_portfolio"),
        databaseStudyCount: portfolio?.databaseStudyCount ?? null,
        matchedStudyCount: portfolio?.matchedStudyCount ?? null,
        intelligenceAttached: Boolean(intelligence && intelligence.source === "ora_clinical_intelligence"),
        note: "portfolio = budget studies. intelligence = Ora Veeva + TrialHub reference (PSM/feasibility)."
      },
      user,
      activeTab,
      activeTabLabel,
      queryHints: {
        studyId: studyId || null,
        clientName: hints.clientName || null,
        year: hints.year || null,
        crossStudy,
        intelligence: Boolean(intelligence && !intelligence.error)
      },
      openStudyInUi: openStudyId
        ? {
            studyId: openStudyId,
            note:
              answerFocus === "portfolio"
                ? "Open in UI only — IGNORE. Answer from context.portfolio (Cosmos)."
                : "Study currently open in the workbench UI."
          }
        : null,
      cosmos: cosmosContext,
      portfolio,
      intelligence,
      workingStudy:
        answerFocus === "portfolio" || !clientStudy
          ? null
          : {
              source: "browser_working_copy",
              studyId: clientStudy.studyId,
              clientName: clientStudy.clientName,
              title: clientStudy.title,
              protocol: clientStudy.protocol,
              phase: clientStudy.phase,
              indication: clientStudy.indication,
              versionLabel: clientStudy.versionLabel,
              drivers: clientStudy.drivers,
              sectionStatus: clientStudy.sectionStatus,
              assumptions: clientStudy.assumptions
            },
      editableFields:
        answerFocus === "portfolio"
          ? []
          : (editableFields || []).slice(0, 200).map((f) => ({
              path: f.path,
              label: f.label,
              tab: f.tab,
              tabLabel: f.tabLabel,
              group: f.group,
              value: f.value
            })),
      fieldsByTab: answerFocus === "portfolio" ? null : fieldsByTab
    };

    const result = await askAi({ question, context: contextPayload, history });
    return json(200, {
      answer: result.answer,
      model: result.model,
      provider: result.provider,
      usage: result.usage,
      studyId: answerFocus === "portfolio" ? null : studyId || clientStudy?.studyId || null,
      clientName: hints.clientName || null,
      year: hints.year || null,
      answerFocus,
      portfolioMatched: portfolio?.matchedStudyCount ?? null,
      databaseStudyCount: portfolio?.databaseStudyCount ?? null,
      greetedAs: user?.firstName || user?.displayName || null
    });
  } catch (err) {
    context.error(err);
    const msg = String(err.message || err);
    const status = msg.includes("not configured") ? 503 : 500;
    return json(status, { error: msg });
  }
}
