/**
 * Veeva Vault API client (username/password → sessionId + VQL).
 * App Settings on Function App ora-buddy-api:
 *   VEEVA_DNS            oraclinical-etmf.veevavault.com (no https://)
 *   VEEVA_USERNAME       integration user
 *   VEEVA_PASSWORD       integration password
 *   VEEVA_CLIENT_ID      ora-intelligence (X-VaultAPI-ClientID)
 *   VEEVA_API_VERSION    optional, default v26.1
 */

const https = require("https");

function env(name) {
  const v = String(process.env[name] || "").trim();
  if (!v || v.includes("SET_IN")) return "";
  return v;
}

function veevaConfig() {
  const dns = env("VEEVA_DNS")
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
  const username = env("VEEVA_USERNAME") || env("VEEVA_USER");
  const password = env("VEEVA_PASSWORD") || env("VEEVA_PASS");
  const clientId = env("VEEVA_CLIENT_ID") || "ora-intelligence";
  const apiVersion = (env("VEEVA_API_VERSION") || "v26.1").replace(/^\/+/, "");
  return {
    dns,
    username,
    password,
    clientId,
    apiVersion,
    configured: Boolean(dns && username && password)
  };
}

function httpsJson(opts, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(body);
    const headers = {
      Accept: "application/json",
      ...(opts.headers || {}),
      ...(data ? { "Content-Length": data.length } : {})
    };
    const req = https.request(
      {
        hostname: opts.hostname,
        path: opts.path,
        method: opts.method || "GET",
        headers
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(buf);
          } catch (_) {}
          resolve({ status: res.statusCode, json, raw: buf, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Authenticate → { sessionId, vaultId, userId, cfg }
 */
async function getVeevaSession(cfg = veevaConfig()) {
  if (!cfg.configured) {
    throw new Error(
      "Veeva App Settings missing (VEEVA_DNS, VEEVA_USERNAME, VEEVA_PASSWORD). See docs/veeva-vault-setup-checklist.md"
    );
  }
  const path = `/api/${cfg.apiVersion}/auth`;
  const body = new URLSearchParams({
    username: cfg.username,
    password: cfg.password
  }).toString();
  const res = await httpsJson(
    {
      hostname: cfg.dns,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-VaultAPI-ClientID": cfg.clientId
      }
    },
    body
  );
  if (res.json?.responseStatus !== "SUCCESS" || !res.json?.sessionId) {
    const err =
      res.json?.errors?.[0]?.message ||
      res.json?.errorType ||
      res.raw?.slice(0, 300) ||
      `HTTP ${res.status}`;
    throw new Error(`Veeva auth failed: ${err}`);
  }
  return {
    sessionId: res.json.sessionId,
    vaultId: res.json.vaultId,
    userId: res.json.userId,
    vaultIds: res.json.vaultIds || [],
    cfg
  };
}

/**
 * Run a VQL query; follows next_page until done or maxRecords.
 * @returns {{ records: object[], total: number|null, pages: number }}
 */
async function vqlQuery(session, query, opts = {}) {
  const cfg = session.cfg || veevaConfig();
  const maxRecords = opts.maxRecords != null ? Number(opts.maxRecords) : null;
  const maxPages = opts.maxPages != null ? Number(opts.maxPages) : 500;
  const records = [];
  let pages = 0;
  let total = null;
  let nextPath = `/api/${cfg.apiVersion}/query`;
  let nextHost = cfg.dns;
  let body = "q=" + encodeURIComponent(query);
  let method = "POST";

  while (pages < maxPages) {
    pages += 1;
    const res = await httpsJson(
      {
        hostname: nextHost,
        path: nextPath,
        method,
        headers: {
          Authorization: session.sessionId,
          "X-VaultAPI-ClientID": cfg.clientId,
          ...(method === "POST"
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {})
        }
      },
      method === "POST" ? body : null
    );

    if (res.json?.responseStatus !== "SUCCESS") {
      const err =
        res.json?.errors?.[0]?.message ||
        res.json?.errorType ||
        res.raw?.slice(0, 400) ||
        `HTTP ${res.status}`;
      throw new Error(`VQL failed: ${err}`);
    }

    const batch = res.json.data || [];
    records.push(...batch);
    if (res.json.responseDetails?.total != null) total = res.json.responseDetails.total;

    if (maxRecords != null && records.length >= maxRecords) {
      return { records: records.slice(0, maxRecords), total, pages, truncated: true };
    }

    const next = res.json.responseDetails?.next_page;
    if (!next) break;
    if (String(next).startsWith("http")) {
      const u = new URL(next);
      nextHost = u.hostname;
      nextPath = u.pathname + u.search;
    } else {
      nextPath = String(next).startsWith("/") ? String(next) : `/${String(next)}`;
    }
    method = "GET";
    body = null;
  }

  return { records, total, pages, truncated: false };
}

/** Scalarize Vault picklists / arrays for Cosmos. */
function flattenVeevaValue(v) {
  if (v == null) return null;
  if (Array.isArray(v)) {
    if (!v.length) return null;
    if (v.length === 1) return flattenVeevaValue(v[0]);
    return v.map(flattenVeevaValue).join("; ");
  }
  if (typeof v === "object") {
    if (v.name__v != null) return v.name__v;
    if (v.value != null) return v.value;
    return JSON.stringify(v);
  }
  return v;
}

function flattenVeevaRecord(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec || {})) {
    out[k] = flattenVeevaValue(v);
  }
  return out;
}

module.exports = {
  veevaConfig,
  getVeevaSession,
  vqlQuery,
  flattenVeevaRecord,
  flattenVeevaValue
};
