/**
 * Discover Vault Documents API for TMF Cross Check.
 * Buddy today only syncs CTMS objects (study__v / site__v / …) — not document files.
 * This probe finds document VQL fields, classifications, and a working download URL.
 *
 * Env (same as ora-buddy-api):
 *   VEEVA_DNS, VEEVA_USERNAME|VEEVA_USER, VEEVA_PASSWORD|VEEVA_PASS,
 *   VEEVA_CLIENT_ID (default ora-intelligence), VEEVA_API_VERSION (default v26.1)
 *
 * Usage:
 *   node scripts/veeva_tmf_document_probe.js
 *   node scripts/veeva_tmf_document_probe.js 25-150-0006
 *
 * Does not print passwords. Writes summary JSON to stdout.
 */
const https = require("https");
const fs = require("fs");
const path = require("path");

const dns = String(process.env.VEEVA_DNS || "")
  .replace(/^https?:\/\//i, "")
  .replace(/\/$/, "");
const user = process.env.VEEVA_USERNAME || process.env.VEEVA_USER;
const pass = process.env.VEEVA_PASSWORD || process.env.VEEVA_PASS;
const clientId = process.env.VEEVA_CLIENT_ID || "ora-intelligence";
const apiVersion = (process.env.VEEVA_API_VERSION || "v26.1").replace(/^\/+/, "");
const studyNeedle = String(process.argv[2] || "").trim();

if (!dns || !user || !pass) {
  console.error("Set VEEVA_DNS, VEEVA_USERNAME, VEEVA_PASSWORD (same as ora-buddy-api).");
  process.exit(1);
}

function req(method, reqPath, body, headers = {}, binary = false) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const r = https.request(
      {
        hostname: dns,
        path: reqPath,
        method,
        headers: {
          Accept: binary ? "*/*" : "application/json",
          "X-VaultAPI-ClientID": clientId,
          ...headers,
          ...(data ? { "Content-Length": data.length } : {})
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (binary) {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              buffer: buf,
              bytes: buf.length
            });
            return;
          }
          const raw = buf.toString("utf8");
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch (_) {}
          resolve({ status: res.statusCode, json, raw: raw.slice(0, 8000), headers: res.headers });
        });
      }
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function auth() {
  const res = await req(
    "POST",
    `/api/${apiVersion}/auth`,
    new URLSearchParams({ username: user, password: pass }).toString(),
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  if (res.json?.responseStatus !== "SUCCESS" || !res.json?.sessionId) {
    throw new Error(`AUTH FAIL: ${JSON.stringify(res.json || res.raw).slice(0, 400)}`);
  }
  return res.json.sessionId;
}

async function vqlAll(sid, query, { maxPages = 5, maxRecords = 200 } = {}) {
  const records = [];
  let pages = 0;
  let total = null;
  let nextPath = `/api/${apiVersion}/query`;
  let method = "POST";
  let body = "q=" + encodeURIComponent(query);

  while (pages < maxPages) {
    pages += 1;
    const res = await req(method, nextPath, method === "POST" ? body : null, {
      Authorization: sid,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
    });
    if (res.json?.responseStatus !== "SUCCESS") {
      const err =
        res.json?.errors?.[0]?.message || res.json?.errorType || res.raw?.slice(0, 400);
      throw new Error(`VQL failed: ${err}`);
    }
    const batch = res.json.data || [];
    records.push(...batch);
    if (res.json.responseDetails?.total != null) total = res.json.responseDetails.total;
    if (records.length >= maxRecords) {
      return { records: records.slice(0, maxRecords), total, pages, truncated: true };
    }
    const next = res.json.responseDetails?.next_page;
    if (!next) break;
    if (String(next).startsWith("http")) {
      const u = new URL(next);
      nextPath = u.pathname + u.search;
    } else {
      nextPath = String(next).startsWith("/") ? String(next) : `/${String(next)}`;
    }
    method = "GET";
    body = null;
  }
  return { records, total, pages, truncated: false };
}

async function tryVql(sid, query) {
  try {
    const r = await vqlAll(sid, query, { maxPages: 2, maxRecords: 50 });
    return { ok: true, query, ...r };
  } catch (err) {
    return { ok: false, query, error: String(err.message || err).slice(0, 500) };
  }
}

function pickStudyFolderId(study) {
  return (
    study?.ora_project_code__c ||
    study?.alternate_study_number__vs ||
    study?.name__v ||
    study?.id ||
    null
  );
}

function uniq(vals) {
  return [...new Set(vals.filter((v) => v != null && String(v).trim() !== ""))].slice(0, 40);
}

(async () => {
  const out = {
    generatedAt: new Date().toISOString(),
    apiVersion,
    dns,
    clientId,
    buddyNote:
      "Buddy syncs study__v/site__v/metrics/milestones only — no documents download yet. This probe discovers TMF document paths.",
    study: null,
    studyVql: null,
    documentAttempts: [],
    workingDocumentVql: null,
    sampleDocument: null,
    classificationSamples: { type__v: [], subtype__v: [], classification__v: [] },
    downloadAttempts: [],
    recommendedDownloadPath: null,
    pagination: "POST /query then GET responseDetails.next_page (Buddy vqlQuery)"
  };

  const sid = await auth();
  console.error("AUTH OK");

  // --- Studies (Buddy-aligned) ---
  const studyFields =
    "id, name__v, alternate_study_number__vs, study_name__v, ora_project_code__c, status__v, study_status__v, enrollment__vs, modified_date__v";
  let studyQ = `SELECT ${studyFields} FROM study__v`;
  if (studyNeedle) {
    const esc = studyNeedle.replace(/'/g, "\\'");
    studyQ += ` WHERE ora_project_code__c = '${esc}' OR name__v = '${esc}' OR alternate_study_number__vs = '${esc}'`;
  }
  const studies = await tryVql(sid, studyQ);
  out.studyVql = studies;
  if (!studies.ok) {
    // resilient: drop ora_project_code if missing
    const fallback = await tryVql(
      sid,
      studyNeedle
        ? `SELECT id, name__v, alternate_study_number__vs, study_name__v, status__v FROM study__v WHERE name__v = '${studyNeedle.replace(
            /'/g,
            "\\'"
          )}' OR alternate_study_number__vs = '${studyNeedle.replace(/'/g, "\\'")}'`
        : `SELECT id, name__v, alternate_study_number__vs, study_name__v, status__v FROM study__v`
    );
    out.studyVql = fallback;
  }
  const studyRow = (out.studyVql.records || [])[0] || null;
  if (studyRow) {
    out.study = {
      id: studyRow.id,
      folderId: pickStudyFolderId(studyRow),
      name__v: studyRow.name__v,
      ora_project_code__c: studyRow.ora_project_code__c || null,
      alternate_study_number__vs: studyRow.alternate_study_number__vs || null,
      study_name__v: studyRow.study_name__v || null
    };
  }
  console.error("STUDY", out.study || "none");

  // --- Document VQL candidates ---
  const studyId = out.study?.id;
  const docFieldSets = [
    "id, name__v, type__v, subtype__v, classification__v, major_version_number__v, minor_version_number__v, status__v, study__v",
    "id, name__v, type__v, subtype__v, classification__v, major_version_number__v, minor_version_number__v, status__v, binder__v",
    "id, name__v, type__v, subtype__v, classification__v, major_version_number__v, minor_version_number__v, status__v",
    "id, name__v, type__v, subtype__v, major_version_number__v, minor_version_number__v, status__v",
    "id, name__v, status__v, major_version_number__v, minor_version_number__v"
  ];
  const wheres = studyId
    ? [
        `study__v = '${studyId}'`,
        `study__vr.id = '${studyId}'`,
        "" // unscoped sample
      ]
    : [""];

  let working = null;
  for (const fields of docFieldSets) {
    for (const where of wheres) {
      const q =
        `SELECT ${fields} FROM documents` + (where ? ` WHERE ${where}` : "");
      const attempt = await tryVql(sid, q);
      out.documentAttempts.push({
        ok: attempt.ok,
        query: q,
        error: attempt.error || null,
        n: attempt.ok ? (attempt.records || []).length : 0,
        total: attempt.total ?? null
      });
      if (attempt.ok && (attempt.records || []).length) {
        working = attempt;
        break;
      }
      if (attempt.ok && !working) working = attempt; // empty but valid schema
    }
    if (working?.ok && (working.records || []).length) break;
  }
  out.workingDocumentVql = working?.ok
    ? { query: working.query, total: working.total, n: (working.records || []).length }
    : null;
  out.sampleDocument = (working?.records || [])[0] || null;

  if (working?.ok && (working.records || []).length) {
    const rows = working.records;
    out.classificationSamples = {
      type__v: uniq(rows.map((r) => r.type__v)),
      subtype__v: uniq(rows.map((r) => r.subtype__v)),
      classification__v: uniq(rows.map((r) => r.classification__v))
    };
  }

  // Metadata describe (best-effort)
  const meta = await req("GET", `/api/${apiVersion}/metadata/objects/documents`, null, {
    Authorization: sid
  });
  out.documentsMetadataStatus = meta.status;
  out.documentsMetadataOk = meta.json?.responseStatus === "SUCCESS";
  if (out.documentsMetadataOk && meta.json?.object) {
    out.documentsObjectName = meta.json.object.name || meta.json.object.label || null;
  }

  // --- Download attempts ---
  const doc = out.sampleDocument;
  if (doc?.id != null) {
    const major = doc.major_version_number__v ?? doc.major_version__v ?? 1;
    const minor = doc.minor_version_number__v ?? doc.minor_version__v ?? 0;
    const paths = [
      `/api/${apiVersion}/objects/documents/${doc.id}/versions/${major}/${minor}/file`,
      `/api/${apiVersion}/objects/documents/${doc.id}/file`,
      `/api/${apiVersion}/objects/documents/${doc.id}/versions/latest/file`
    ];
    for (const p of paths) {
      const dl = await req("GET", p, null, { Authorization: sid }, true);
      const ctype = String(dl.headers?.["content-type"] || "");
      const ok =
        dl.status === 200 &&
        dl.bytes > 64 &&
        !ctype.includes("application/json");
      out.downloadAttempts.push({
        path: p,
        status: dl.status,
        bytes: dl.bytes,
        contentType: ctype.slice(0, 80),
        ok
      });
      if (ok && !out.recommendedDownloadPath) {
        out.recommendedDownloadPath = p;
        // keep a tiny sample file locally for proof (optional)
        try {
          const sampleDir = path.join(__dirname, "..", ".veeva-probe");
          fs.mkdirSync(sampleDir, { recursive: true });
          const fp = path.join(sampleDir, `doc_${doc.id}_v${major}-${minor}.bin`);
          fs.writeFileSync(fp, dl.buffer.slice(0, Math.min(dl.bytes, 2_000_000)));
          out.sampleFileSaved = fp;
        } catch (_) {}
      }
    }
  }

  // Buddy clinical VQL reminder for the TMF chat
  out.buddyClinicalStudySelect = `SELECT id, name__v, alternate_study_number__vs, study_name__v, sponsor__c, ora_project_code__c, status__v, study_status__v, enrollment__vs, modified_date__v FROM study__v`;
  out.buddyClinicalSiteSelect = `SELECT id, name__v, site_name__v, study__v, study_number__v, country__v, country__vr.name__v, ora_project_code__c, no_subjects_enrolled__v FROM site__v`;
  out.blobContract = {
    storageSecret: "NETSUITE_STORAGE or TMF_STORAGE",
    container: "tmf-cross-check",
    layout: "landing/YYYY/MM/DD/HHMM → curated/ → delete landing"
  };

  console.log(JSON.stringify(out, null, 2));
})().catch((err) => {
  console.error(String(err.stack || err));
  process.exit(1);
});
