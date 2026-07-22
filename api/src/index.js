const { app } = require("@azure/functions");
const AdmZip = require("adm-zip");
const { parseWorkbookBuffer } = require("./parseWorkbook");
const { upsertCanonical, listStudies, getStudy, listVersions, getVersion, listLineItems, compareVersions, listQuarantine, getDb } = require("./cosmosLoad");
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
          report.failed.push({ file: wb.name, error: msg });
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
      const studies = await listStudies(200);
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

      let cosmosContext = null;
      if (studyId) {
        cosmosContext = await getStudyContext(studyId, { getDb });
      }

      const contextPayload = {
        askedAt: new Date().toISOString(),
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
        studyId: studyId || clientStudy?.studyId || null
      });
    } catch (err) {
      context.error(err);
      const msg = String(err.message || err);
      const status = msg.includes("not configured") ? 503 : 500;
      return json(status, { error: msg });
    }
  }
});
