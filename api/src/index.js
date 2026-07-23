const { app } = require("@azure/functions");
const AdmZip = require("adm-zip");
const { parseWorkbookBuffer } = require("./parseWorkbook");
const { upsertCanonical, listStudies, getStudy, listVersions, getVersion, listLineItems, compareVersions, compareStudies, listQuarantine, getDb } = require("./cosmosLoad");
const { askAi, getStudyContext, providerStatus } = require("./askClaude");

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

function expandArchives(files) {
  const out = [];
  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (lower.endsWith(".zip")) {
      const zip = new AdmZip(f.buffer);
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const en = entry.entryName.split("/").pop();
        if (!en || en.startsWith("~$")) continue;
        if (!en.toLowerCase().endsWith(".xlsx")) continue;
        out.push({ name: en, buffer: entry.getData() });
      }
    } else if (lower.endsWith(".xlsx")) {
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
        return json(400, { error: "No .xlsx or .zip files found in upload" });
      }

      const dryRun = mode === "dry";
      for (const wb of workbooks) {
        try {
          const canonical = await parseWorkbookBuffer(wb.buffer, wb.name);
          const entry = {
            file: wb.name,
            studyId: canonical.study.studyId,
            confidence: canonical.confidence,
            lineItems: canonical.version.lineItemCount,
            warnings: canonical.warnings,
            quarantineReasons: canonical.quarantineReasons || [],
            missingSheets: canonical.fingerprint?.missingSheets || []
          };
          if (dryRun) {
            entry.cosmosStatus = canonical.quarantine ? "quarantined" : "dry_run_ok";
            (canonical.quarantine ? report.quarantined : report.loaded).push(entry);
          } else {
            const summary = await upsertCanonical(canonical, jobId);
            entry.cosmosStatus = summary.status;
            entry.versionId = summary.versionId;
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
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "studies",
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
      return json(200, { count: items.length, reasonBuckets, items });
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

    try {
      const body = await request.json();
      const question = String(body.question || "").trim();
      if (!question) return json(400, { error: "question is required" });

      const studyId = body.studyId ? String(body.studyId).trim() : null;
      const clientStudy = body.studySnapshot || null;
      const history = body.history || [];
      const user = signedInUserFromRequest(request, body.user || null);

      let cosmosContext = null;
      if (studyId) {
        cosmosContext = await getStudyContext(studyId, { getDb });
      }

      const contextPayload = {
        askedAt: new Date().toISOString(),
        user,
        cosmos: cosmosContext,
        workingStudy: clientStudy
          ? {
              source: "browser_working_copy",
              studyId: clientStudy.studyId,
              clientName: clientStudy.clientName,
              title: clientStudy.title,
              protocol: clientStudy.protocol,
              phase: clientStudy.phase,
              versionLabel: clientStudy.versionLabel,
              drivers: clientStudy.drivers,
              sectionStatus: clientStudy.sectionStatus,
              assumptions: clientStudy.assumptions
            }
          : null
      };

      const result = await askAi({ question, context: contextPayload, history });
      return json(200, {
        answer: result.answer,
        model: result.model,
        provider: result.provider,
        usage: result.usage,
        studyId: studyId || clientStudy?.studyId || null,
        greetedAs: user?.firstName || user?.displayName || null
      });
    } catch (err) {
      context.error(err);
      const msg = String(err.message || err);
      const status = msg.includes("not configured") ? 503 : 500;
      return json(status, { error: msg });
    }
  }
});
