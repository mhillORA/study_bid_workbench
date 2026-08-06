/**
 * Salesforce JWT Bearer client for Ora Intelligence Tool.
 * Env (SWA App Settings):
 *   SF_CLIENT_ID          Connected/External Client App Consumer Key
 *   SF_USERNAME           Integration user username (email)
 *   SF_LOGIN_URL          https://login.salesforce.com (prod) or https://test.salesforce.com
 *   SF_JWT_PRIVATE_KEY    PEM private key matching the cert uploaded to SF
 *   SF_API_VERSION        optional, default 59.0
 *   SF_TIER_FIELD         optional Account field API name, default Tier__c
 *   SF_GROUPING_FIELD     optional Account field API name, default Ora_Grouping__c
 */

const crypto = require("crypto");

function env(name) {
  const v = String(process.env[name] || "").trim();
  if (!v || v.includes("SET_IN")) return "";
  return v;
}

function normalizePem(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  // Azure App Settings often store newlines as \n
  s = s.replace(/\\n/g, "\n");
  if (!s.includes("BEGIN") && !s.includes("\n")) {
    // Bare base64 body — wrap as PKCS#8
    const body = s.replace(/\s+/g, "");
    const lines = body.match(/.{1,64}/g) || [body];
    s = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
  }
  return s;
}

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function safeApiField(name, fallback) {
  const cleaned = String(name || fallback || "")
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "");
  return cleaned || fallback;
}

function salesforceConfig() {
  const clientId = env("SF_CLIENT_ID");
  const username = env("SF_USERNAME");
  const loginUrl = (env("SF_LOGIN_URL") || "https://login.salesforce.com").replace(/\/$/, "");
  const privateKey = normalizePem(env("SF_JWT_PRIVATE_KEY"));
  const apiVersion = env("SF_API_VERSION") || "59.0";
  const tierField = safeApiField(env("SF_TIER_FIELD") || "Tier__c", "Tier__c");
  const groupingField = safeApiField(env("SF_GROUPING_FIELD") || "Ora_Grouping__c", "Ora_Grouping__c");
  const configured = Boolean(clientId && username && privateKey);
  return { clientId, username, loginUrl, privateKey, apiVersion, tierField, groupingField, configured };
}

function buildJwtAssertion(cfg) {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: cfg.clientId,
    sub: cfg.username,
    aud: cfg.loginUrl,
    exp: now + 3 * 60
  };
  const enc = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(enc);
  sign.end();
  const sig = sign.sign(cfg.privateKey);
  return `${enc}.${b64url(sig)}`;
}

async function getSalesforceAccessToken(cfg = salesforceConfig()) {
  if (!cfg.configured) {
    const missing = [];
    if (!cfg.clientId) missing.push("SF_CLIENT_ID");
    if (!cfg.username) missing.push("SF_USERNAME");
    if (!cfg.privateKey) missing.push("SF_JWT_PRIVATE_KEY");
    throw new Error(`Salesforce not configured — set ${missing.join(", ")} in SWA App Settings`);
  }
  const assertion = buildJwtAssertion(cfg);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  });
  const res = await fetch(`${cfg.loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error(`Salesforce token non-JSON (${res.status}): ${text.slice(0, 240)}`);
  }
  if (!res.ok) {
    throw new Error(
      `Salesforce token failed (${res.status}): ${json.error || ""} ${json.error_description || text}`.trim()
    );
  }
  if (!json.access_token || !json.instance_url) {
    throw new Error("Salesforce token response missing access_token / instance_url");
  }
  return {
    accessToken: json.access_token,
    instanceUrl: String(json.instance_url).replace(/\/$/, ""),
    issuedAt: json.issued_at || null,
    apiVersion: cfg.apiVersion,
    tierField: cfg.tierField,
    groupingField: cfg.groupingField
  };
}

async function sfGet(session, pathAndQuery) {
  const url = pathAndQuery.startsWith("http")
    ? pathAndQuery
    : `${session.instanceUrl}${pathAndQuery}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      Accept: "application/json"
    }
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error(`Salesforce GET non-JSON (${res.status}): ${text.slice(0, 240)}`);
  }
  if (!res.ok) {
    const msg = Array.isArray(json)
      ? json.map((e) => e.message || e.errorCode).join("; ")
      : json.message || json.error || text;
    throw new Error(`Salesforce GET failed (${res.status}): ${msg}`);
  }
  return json;
}

/** Describe an sObject; returns queryable field API names (capped). */
async function describeSObject(session, objectName) {
  const name = String(objectName || "").trim();
  if (!name) throw new Error("describeSObject requires objectName");
  const data = await sfGet(session, `/services/data/v${session.apiVersion}/sobjects/${encodeURIComponent(name)}/describe`);
  const skipTypes = new Set([
    "base64",
    "address",
    "location",
    "complexvalue",
    "datacategorygroupreference"
  ]);
  const fields = [];
  for (const f of data.fields || []) {
    if (!f || !f.queryable || f.deprecatedAndHidden) continue;
    if (skipTypes.has(String(f.type || "").toLowerCase())) continue;
    // Avoid huge long-text blobs by default (still allow custom __c)
    if (f.type === "textarea" && f.length > 8000 && !String(f.name).endsWith("__c")) continue;
    fields.push(f.name);
  }
  // Prefer Id + Name first
  fields.sort((a, b) => {
    if (a === "Id") return -1;
    if (b === "Id") return 1;
    if (a === "Name") return -1;
    if (b === "Name") return 1;
    return a.localeCompare(b);
  });
  const allQueryable = fields.slice(); // before cap — used for must-have joins
  const maxFields = Number(process.env.SF_MAX_FIELDS || 90);
  return {
    name: data.name || name,
    label: data.label || name,
    fields: fields.slice(0, maxFields),
    allQueryable,
    fieldCountAvailable: fields.length,
    queryable: Boolean(data.queryable)
  };
}

/** Run SOQL; follows nextRecordsUrl until done. Optional maxRecords cap. */
async function soqlQuery(session, soql, opts = {}) {
  const maxRecords = opts.maxRecords != null ? Number(opts.maxRecords) : null;
  const q = encodeURIComponent(soql);
  let data = await sfGet(session, `/services/data/v${session.apiVersion}/query?q=${q}`);
  const records = [...(data.records || [])];
  while (!data.done && data.nextRecordsUrl) {
    if (maxRecords != null && records.length >= maxRecords) break;
    data = await sfGet(session, data.nextRecordsUrl);
    records.push(...(data.records || []));
  }
  return maxRecords != null ? records.slice(0, maxRecords) : records;
}

/** Pull all (or capped) rows for an object using describe-selected fields. */
async function queryFullObject(session, objectName, opts = {}) {
  const desc = await describeSObject(session, objectName);
  if (!desc.queryable || !desc.fields.length) {
    throw new Error(`${objectName} is not queryable or has no fields`);
  }
  let fieldSet = new Set(desc.fields);
  if (objectName === "OpportunityLineItem") {
    for (const must of [
      "OpportunityId",
      "Product2Id",
      "PricebookEntryId",
      "Quantity",
      "TotalPrice",
      "UnitPrice",
      "Name",
      "ProductCode"
    ]) {
      if ((desc.allQueryable || []).includes(must)) fieldSet.add(must);
    }
  }
  const fieldList = [...fieldSet];
  const soql = `SELECT ${fieldList.join(",")} FROM ${objectName}`;
  try {
    const records = await soqlQuery(session, soql, { maxRecords: opts.maxRecords });
    return { objectName, fields: fieldList, records, describe: desc };
  } catch (err) {
    const lean = [
      "Id",
      ...fieldList.filter((f) => f === "Name" || f.endsWith("__c") || f.endsWith("Id")).slice(0, 40)
    ];
    const uniq = [...new Set(lean)];
    const records = await soqlQuery(session, `SELECT ${uniq.join(",")} FROM ${objectName}`, {
      maxRecords: opts.maxRecords
    });
    return { objectName, fields: uniq, records, describe: desc, note: String(err.message || err) };
  }
}

/**
 * Fetch Accounts by Id list.
 * Returns Map id -> { id, name, ownerName, tier, oraGrouping, isDeleted }
 */
async function fetchAccountsByIds(session, ids, opts = {}) {
  const tierField = opts.tierField || session.tierField || "Tier__c";
  const groupingField = opts.groupingField || session.groupingField || "Ora_Grouping__c";
  const unique = [...new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean))];
  const byId = new Map();
  const chunkSize = 100;

  async function queryChunk(chunk, fields) {
    const inList = chunk.map((id) => `'${id.replace(/'/g, "\\'")}'`).join(",");
    const soql = `SELECT ${fields.join(", ")} FROM Account WHERE Id IN (${inList})`;
    return soqlQuery(session, soql);
  }

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    let fields = ["Id", "Name", "IsDeleted", "Owner.Name", tierField, groupingField];
    let records;
    try {
      records = await queryChunk(chunk, fields);
    } catch (err) {
      const msg = String(err.message || err);
      // Drop custom fields that aren't visible / don't exist, retry leaner
      if (msg.includes(groupingField)) {
        fields = fields.filter((f) => f !== groupingField);
        try {
          records = await queryChunk(chunk, fields);
        } catch (err2) {
          if (String(err2.message || err2).includes(tierField)) {
            fields = fields.filter((f) => f !== tierField);
            records = await queryChunk(chunk, fields);
          } else {
            throw err2;
          }
        }
      } else if (msg.includes(tierField)) {
        fields = fields.filter((f) => f !== tierField);
        try {
          records = await queryChunk(chunk, fields);
        } catch (err2) {
          if (String(err2.message || err2).includes(groupingField)) {
            fields = fields.filter((f) => f !== groupingField);
            records = await queryChunk(chunk, fields);
          } else {
            throw err2;
          }
        }
      } else {
        throw err;
      }
    }
    for (const r of records) {
      const id = r.Id;
      if (!id) continue;
      byId.set(id, {
        id,
        name: r.Name || null,
        ownerName: (r.Owner && r.Owner.Name) || null,
        tier: r[tierField] != null ? r[tierField] : null,
        oraGrouping: r[groupingField] != null ? r[groupingField] : null,
        isDeleted: Boolean(r.IsDeleted)
      });
    }
  }
  return byId;
}

module.exports = {
  salesforceConfig,
  getSalesforceAccessToken,
  soqlQuery,
  describeSObject,
  queryFullObject,
  fetchAccountsByIds,
  normalizePem,
  sfGet
};
