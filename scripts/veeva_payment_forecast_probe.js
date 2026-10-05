/**
 * Probe Veeva payment + metrics objects for investigator-fee forecasting.
 * Env: VEEVA_DNS, VEEVA_USERNAME, VEEVA_PASSWORD, VEEVA_CLIENT_ID, VEEVA_API_VERSION
 */
const https = require("https");

const dns = String(process.env.VEEVA_DNS || "")
  .replace(/^https?:\/\//i, "")
  .replace(/\/$/, "");
const user = process.env.VEEVA_USERNAME || process.env.VEEVA_USER;
const pass = process.env.VEEVA_PASSWORD || process.env.VEEVA_PASS;
const clientId = process.env.VEEVA_CLIENT_ID || "ora-intelligence";
const apiVersion = (process.env.VEEVA_API_VERSION || "v26.1").replace(/^\/+/, "");
const studyNeedle = String(process.argv[2] || "25-150-0006").trim();

if (!dns || !user || !pass) {
  console.error("Set VEEVA_* env");
  process.exit(1);
}

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(body);
    const r = https.request(
      {
        hostname: dns,
        path,
        method,
        headers: {
          Accept: "application/json",
          "X-VaultAPI-ClientID": clientId,
          ...headers,
          ...(data ? { "Content-Length": data.length } : {})
        }
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(buf);
          } catch (_) {}
          resolve({ status: res.statusCode, json, raw: buf.slice(0, 4000) });
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
  if (res.json?.responseStatus !== "SUCCESS") throw new Error(JSON.stringify(res.json).slice(0, 300));
  return res.json.sessionId;
}

async function vql(sid, q) {
  const res = await req("POST", `/api/${apiVersion}/query`, "q=" + encodeURIComponent(q), {
    Authorization: sid,
    "Content-Type": "application/x-www-form-urlencoded"
  });
  return res.json;
}

async function tryDescribe(sid, objectName) {
  const res = await req("GET", `/api/${apiVersion}/metadata/vobjects/${objectName}`, null, {
    Authorization: sid
  });
  if (res.json?.responseStatus !== "SUCCESS") {
    const res2 = await req("GET", `/api/${apiVersion}/metadata/objects/${objectName}`, null, {
      Authorization: sid
    });
    return res2.json;
  }
  return res.json;
}

function fieldNames(meta) {
  const fields = meta?.object?.fields || meta?.fields || [];
  return fields.map((f) => f.name || f.name__v).filter(Boolean).slice(0, 80);
}

(async () => {
  const sid = await auth();
  const out = { studyNeedle, objects: {}, study: null };

  const esc = studyNeedle.replace(/'/g, "\\'");
  const studyQ = await vql(
    sid,
    `SELECT id, name__v, alternate_study_number__vs, ora_project_code__c, enrollment__vs, status__v FROM study__v WHERE alternate_study_number__vs = '${esc}' OR name__v = '${esc}' OR ora_project_code__c = '${esc}'`
  );
  out.study = studyQ?.data?.[0] || null;
  const studyId = out.study?.id;

  const objects = [
    "payable_item__v",
    "payment__v",
    "metrics__ctms",
    "fee_schedule__v",
    "site_fee_schedule__v",
    "study_fee_schedule__v",
    "payment_definition__v",
    "visit_definition__v",
    "procedure_definition__v",
    "site_fee_definition__v"
  ];

  for (const obj of objects) {
    const count = await vql(sid, `SELECT id FROM ${obj}`);
    const entry = {
      object: obj,
      countOk: count?.responseStatus === "SUCCESS",
      total: count?.responseDetails?.total ?? (count?.data || []).length,
      error: count?.responseStatus === "SUCCESS" ? null : JSON.stringify(count?.errors || count).slice(0, 200)
    };

    if (entry.countOk) {
      const meta = await tryDescribe(sid, obj);
      entry.fields = fieldNames(meta);
      entry.metaOk = meta?.responseStatus === "SUCCESS";

      // sample rows scoped to study when possible
      const tryQueries = [];
      if (studyId) {
        tryQueries.push(`SELECT id, name__v, study__v, site__v, status__v, amount__v, modified_date__v FROM ${obj} WHERE study__v = '${studyId}'`);
        tryQueries.push(`SELECT id, name__v, study__v, site__v, status__v, modified_date__v FROM ${obj} WHERE study__v = '${studyId}'`);
        tryQueries.push(`SELECT id, name__v, study__v, status__v FROM ${obj} WHERE study__v = '${studyId}'`);
      }
      tryQueries.push(`SELECT id, name__v, status__v, modified_date__v FROM ${obj}`);

      for (const q of tryQueries) {
        const r = await vql(sid, q);
        if (r?.responseStatus === "SUCCESS") {
          entry.sampleQuery = q;
          entry.sampleN = (r.data || []).length;
          entry.sampleTotal = r.responseDetails?.total ?? null;
          entry.sample = (r.data || []).slice(0, 3);
          break;
        }
        entry.lastSampleError = JSON.stringify(r?.errors || r).slice(0, 180);
      }
    }
    out.objects[obj] = entry;
    console.error(obj, entry.countOk ? `total=${entry.total}` : entry.error);
  }

  // Metrics planned vs actual for this study
  if (studyId) {
    const mq = await vql(
      sid,
      `SELECT id, name__v, metric_type__v, metrics_type__v, planned__v, actual__v, study__v, site__v, status__v FROM metrics__ctms WHERE study__v = '${studyId}'`
    );
    out.metricsForStudy = {
      ok: mq?.responseStatus === "SUCCESS",
      total: mq?.responseDetails?.total,
      n: (mq?.data || []).length,
      sample: (mq?.data || []).slice(0, 8),
      error: mq?.responseStatus === "SUCCESS" ? null : JSON.stringify(mq?.errors || mq).slice(0, 200)
    };
  }

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(String(e.stack || e));
  process.exit(1);
});
