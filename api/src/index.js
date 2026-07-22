const { app } = require("@azure/functions");
const AdmZip = require("adm-zip");
const { parseWorkbookBuffer } = require("./parseWorkbook");
const { upsertCanonical, listStudies } = require("./cosmosLoad");

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
            warnings: canonical.warnings
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
          report.failed.push({ file: wb.name, error: String(err.message || err) });
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

app.http("health", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: async () => json(200, { ok: true, service: "study-bid-workbench-api" })
});
