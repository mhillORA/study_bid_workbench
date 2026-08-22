/**
 * Salesforce JWT Bearer client for Ora Intelligence Tool.
 * Env (SWA App Settings):
 *   SF_CLIENT_ID             Connected/External Client App Consumer Key
 *   SF_USERNAME              Integration user username (email)
 *   SF_LOGIN_URL             https://login.salesforce.com (prod) or https://test.salesforce.com
 *   SF_JWT_PRIVATE_KEY       PEM private key matching the cert uploaded to SF
 *   SF_JWT_PRIVATE_KEY_B64   Preferred: base64 of the entire .key file (avoids Azure newline mangling)
 *   SF_API_VERSION           optional, default 59.0
 *   SF_TIER_FIELD            optional Account field API name, default Tier__c
 *   SF_GROUPING_FIELD        optional Account field API name, default Ora_Grouping__c
 */

const crypto = require("crypto");

function env(name) {
  const v = String(process.env[name] || "").trim();
  if (!v || v.includes("SET_IN")) return "";
  return v;
}

function stripWrappingQuotes(s) {
  let out = String(s || "").trim();
  if (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith("'") && out.endsWith("'"))
  ) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

function normalizePem(raw) {
  let s = stripWrappingQuotes(raw);
  if (!s) return "";
  // Azure App Settings: literal \n / \\n, CRLF
  s = s.replace(/\\\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // BOM / zero-width junk from copy-paste
  s = s.replace(/^\uFEFF/, "").replace(/[\u200B-\u200D\u2060]/g, "");

  if (/BEGIN\s+CERTIFICATE/i.test(s) && !/PRIVATE KEY/i.test(s)) {
    return s; // leave as-is; loader will reject with a clear message
  }

  // Match PKCS#8 ("PRIVATE KEY") and PKCS#1 ("RSA PRIVATE KEY")
  if (!/BEGIN\s+(?:RSA\s+)?PRIVATE KEY/i.test(s)) {
    // Bare base64 body — wrap as PKCS#8
    const body = s.replace(/\s+/g, "");
    if (!body) return "";
    const lines = body.match(/.{1,64}/g) || [body];
    s = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
  } else {
    // Loose BEGIN/END match (Azure may alter END label spacing/case)
    const m = s.match(/-----BEGIN ([^-]+)-----([\s\S]*?)-----END ([^-]+)-----/i);
    if (m) {
      let label = m[1].toUpperCase().replace(/\s+/g, " ").trim();
      if (!/PRIVATE KEY/i.test(label)) label = "PRIVATE KEY";
      const body = m[2].replace(/\s+/g, "");
      const lines = body.match(/.{1,64}/g) || [body];
      s = `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
    }
  }
  return s;
}

const JWT_KEY_DOC_ID = "salesforce_jwt_key";

/**
 * Resolve key material from App Settings.
 * Prefer SF_JWT_PRIVATE_KEY_B64 (base64 of whole .key file) — Azure won't mangle it.
 * @returns {{ pem?: string, der?: Buffer, source: string }}
 */
function resolveJwtKeyMaterialFromEnv() {
  const b64raw = stripWrappingQuotes(env("SF_JWT_PRIVATE_KEY_B64"));
  if (b64raw) {
    const cleaned = b64raw.replace(/\s+/g, "");
    let buf;
    try {
      buf = Buffer.from(cleaned, "base64");
    } catch (_) {
      throw new Error("SF_JWT_PRIVATE_KEY_B64 is not valid base64");
    }
    if (!buf.length) throw new Error("SF_JWT_PRIVATE_KEY_B64 decoded to empty");
    const asText = buf.toString("utf8");
    if (/BEGIN[\s\w]*PRIVATE KEY/i.test(asText)) {
      return { pem: normalizePem(asText), source: "SF_JWT_PRIVATE_KEY_B64(pem)" };
    }
    // Raw DER bytes (pkcs8 or pkcs1)
    return { der: buf, source: "SF_JWT_PRIVATE_KEY_B64(der)" };
  }

  const pemRaw = env("SF_JWT_PRIVATE_KEY");
  if (!pemRaw) return { source: "none" };
  return { pem: normalizePem(pemRaw), source: "SF_JWT_PRIVATE_KEY" };
}

/** @deprecated sync alias — prefer resolveJwtKeyMaterialAsync(getDb) */
function resolveJwtKeyMaterial() {
  return resolveJwtKeyMaterialFromEnv();
}

async function readCosmosJwtKey(getDb) {
  if (!getDb) return null;
  try {
    const database = getDb();
    const { resource } = await database.container("syncState").item(JWT_KEY_DOC_ID, JWT_KEY_DOC_ID).read();
    if (!resource || !resource.keyB64) return null;
    return resource;
  } catch (err) {
    if (err.code === 404) return null;
    return null;
  }
}

async function saveCosmosJwtKey(getDb, opts = {}) {
  const database = getDb();
  try {
    await database.containers.createIfNotExists({
      id: "syncState",
      partitionKey: { paths: ["/id"] }
    });
  } catch (_) {
    /* exists */
  }

  let pemText = "";
  if (opts.keyB64) {
    const buf = Buffer.from(String(opts.keyB64).replace(/\s+/g, ""), "base64");
    pemText = buf.toString("utf8");
  } else if (opts.pem) {
    pemText = String(opts.pem);
  } else {
    throw new Error("Provide pem or keyB64");
  }

  const material = { pem: normalizePem(pemText), source: "upload" };
  // Prove it loads before saving
  loadJwtPrivateKey(material);

  const keyB64 = Buffer.from(material.pem, "utf8").toString("base64");
  const doc = {
    id: JWT_KEY_DOC_ID,
    docType: "syncState",
    job: JWT_KEY_DOC_ID,
    keyB64,
    updatedAt: new Date().toISOString(),
    updatedBy: opts.updatedBy || "api",
    note: "Salesforce JWT RSA private key (PEM as base64). Used when App Settings PEM is mangled."
  };
  await database.container("syncState").items.upsert(doc);
  return {
    ok: true,
    source: "cosmos:salesforce_jwt_key",
    updatedAt: doc.updatedAt,
    parseOk: true
  };
}

async function resolveJwtKeyMaterialAsync(getDb) {
  const fromEnv = resolveJwtKeyMaterialFromEnv();
  if (fromEnv.source !== "none" && (fromEnv.pem || fromEnv.der)) {
    // Prefer env only if it actually loads — mangled Azure PEM should fall through to Cosmos
    try {
      loadJwtPrivateKey(fromEnv);
      return fromEnv;
    } catch (_) {
      /* fall through to Cosmos */
    }
  }

  const stored = await readCosmosJwtKey(getDb);
  if (stored?.keyB64) {
    const buf = Buffer.from(String(stored.keyB64).replace(/\s+/g, ""), "base64");
    const asText = buf.toString("utf8");
    if (/BEGIN[\s\w]*PRIVATE KEY/i.test(asText)) {
      return { pem: normalizePem(asText), source: "cosmos:salesforce_jwt_key" };
    }
    return { der: buf, source: "cosmos:salesforce_jwt_key(der)" };
  }

  if (fromEnv.source !== "none") return fromEnv; // return mangled so caller sees real error
  return { source: "none" };
}

function tryCreatePrivateKey(opts) {
  return crypto.createPrivateKey(opts);
}

/**
 * Load RSA private key for JWT signing.
 * Handles PKCS#8 / PKCS#1 PEM, DER, and Azure paste mangling.
 */
function loadJwtPrivateKey(materialOrPem) {
  const material =
    materialOrPem && typeof materialOrPem === "object" && (materialOrPem.pem || materialOrPem.der)
      ? materialOrPem
      : { pem: typeof materialOrPem === "string" ? materialOrPem : "", source: "arg" };

  if (material.der && Buffer.isBuffer(material.der)) {
    for (const type of ["pkcs8", "pkcs1"]) {
      try {
        const key = tryCreatePrivateKey({ key: material.der, format: "der", type });
        if (key.asymmetricKeyType && key.asymmetricKeyType !== "rsa") {
          throw new Error(`Key type is ${key.asymmetricKeyType}; Salesforce JWT needs RSA (RS256)`);
        }
        return key;
      } catch (_) {
        /* try next */
      }
    }
  }

  const normalized = normalizePem(material.pem || "");
  if (!normalized) {
    throw new Error(
      "No Salesforce private key set. Prefer SF_JWT_PRIVATE_KEY_B64 (base64 of ora_intel_sf.key). See docs/salesforce-azure-sync.md"
    );
  }
  if (/BEGIN\s+CERTIFICATE/i.test(normalized) && !/PRIVATE KEY/i.test(normalized)) {
    throw new Error(
      "SF_JWT_PRIVATE_KEY looks like a .crt certificate. Paste the matching .key private key (or its base64 as SF_JWT_PRIVATE_KEY_B64)."
    );
  }
  if (/ENCRYPTED PRIVATE KEY/i.test(normalized)) {
    throw new Error(
      "Private key is encrypted. Convert with: openssl pkcs8 -topk8 -nocrypt -in ora_intel_sf.key -out ora_intel_sf_pkcs8.key"
    );
  }
  if (/OPENSSH PRIVATE KEY/i.test(normalized)) {
    throw new Error("OpenSSH private keys are not supported. Use an RSA PEM from openssl.");
  }
  if (/EC PRIVATE KEY/i.test(normalized)) {
    throw new Error("EC private keys are not supported for Salesforce JWT. Use RSA (openssl genrsa).");
  }

  const candidates = [normalized];
  if (/BEGIN RSA PRIVATE KEY/i.test(normalized)) {
    candidates.push(
      normalized
        .replace(/BEGIN RSA PRIVATE KEY/gi, "BEGIN PRIVATE KEY")
        .replace(/END RSA PRIVATE KEY/gi, "END PRIVATE KEY")
    );
  } else if (/BEGIN PRIVATE KEY/i.test(normalized)) {
    candidates.push(
      normalized
        .replace(/BEGIN PRIVATE KEY/gi, "BEGIN RSA PRIVATE KEY")
        .replace(/END PRIVATE KEY/gi, "END RSA PRIVATE KEY")
    );
  }

  let lastErr = null;
  for (const keyPem of candidates) {
    try {
      const key = tryCreatePrivateKey({ key: keyPem, format: "pem" });
      if (key.asymmetricKeyType && key.asymmetricKeyType !== "rsa") {
        throw new Error(`Key type is ${key.asymmetricKeyType}; Salesforce JWT needs RSA (RS256)`);
      }
      return key;
    } catch (err) {
      lastErr = err;
    }
  }

  // Last resort: DER from PEM body
  const bodyMatch = normalized.match(/-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/i);
  if (bodyMatch) {
    const der = Buffer.from(bodyMatch[1].replace(/\s+/g, ""), "base64");
    for (const type of ["pkcs8", "pkcs1"]) {
      try {
        const key = tryCreatePrivateKey({ key: der, format: "der", type });
        if (key.asymmetricKeyType && key.asymmetricKeyType !== "rsa") {
          throw new Error(`Key type is ${key.asymmetricKeyType}; Salesforce JWT needs RSA (RS256)`);
        }
        return key;
      } catch (err) {
        lastErr = err;
      }
    }
  }

  const msg = String(lastErr && lastErr.message ? lastErr.message : lastErr);
  throw new Error(
    `SF JWT private key could not be loaded (${msg}). ` +
      `Azure often mangles PEM newlines — set SF_JWT_PRIVATE_KEY_B64 to base64 of the whole .key file instead ` +
      `(PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes('ora_intel_sf.key'))). ` +
      `Key must be unencrypted RSA matching the .crt on the External Client App.`
  );
}

/** Safe diagnostics for Data Status (never returns key material). */
async function diagnoseJwtPrivateKey(getDb = null) {
  const out = {
    pemSet: Boolean(env("SF_JWT_PRIVATE_KEY")),
    b64Set: Boolean(env("SF_JWT_PRIVATE_KEY_B64")),
    cosmosKeySet: false,
    source: null,
    parseOk: false,
    keyType: null,
    header: null,
    charLength: null,
    error: null
  };
  try {
    const stored = await readCosmosJwtKey(getDb);
    out.cosmosKeySet = Boolean(stored?.keyB64);
  } catch (_) {}
  try {
    const material = await resolveJwtKeyMaterialAsync(getDb);
    out.source = material.source;
    if (material.pem) {
      out.charLength = material.pem.length;
      const hm = material.pem.match(/-----BEGIN ([^-]+)-----/i);
      out.header = hm ? hm[1].trim() : null;
    } else if (material.der) {
      out.charLength = material.der.length;
      out.header = "DER";
    }
    const key = loadJwtPrivateKey(material);
    out.parseOk = true;
    out.keyType = key.asymmetricKeyType || "rsa";
  } catch (err) {
    out.error = String(err.message || err);
  }
  return out;
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
  let privateKey = "";
  let keySource = "none";
  try {
    const material = resolveJwtKeyMaterialFromEnv();
    keySource = material.source;
    privateKey = material.pem || (material.der ? "__DER__" : "");
  } catch (_) {
    privateKey = "";
  }
  const apiVersion = env("SF_API_VERSION") || "59.0";
  const tierField = safeApiField(env("SF_TIER_FIELD") || "Tier__c", "Tier__c");
  const groupingField = safeApiField(env("SF_GROUPING_FIELD") || "Ora_Grouping__c", "Ora_Grouping__c");
  // Client + username required; JWT key may come from App Settings OR Cosmos upload
  const configured = Boolean(clientId && username);
  return {
    clientId,
    username,
    loginUrl,
    privateKey,
    keySource,
    apiVersion,
    tierField,
    groupingField,
    configured,
    envKeySet: Boolean(env("SF_JWT_PRIVATE_KEY") || env("SF_JWT_PRIVATE_KEY_B64"))
  };
}

async function buildJwtAssertion(cfg, getDb) {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: cfg.clientId,
    sub: cfg.username,
    aud: cfg.loginUrl,
    exp: now + 3 * 60
  };
  const enc = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const material = await resolveJwtKeyMaterialAsync(getDb);
  if (material.source === "none") {
    throw new Error(
      "No Salesforce JWT private key. Upload ora_intel_sf.key on Data Status, or set SF_JWT_PRIVATE_KEY_B64."
    );
  }
  const keyObject = loadJwtPrivateKey(material);
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(enc);
  sign.end();
  const sig = sign.sign(keyObject);
  return `${enc}.${b64url(sig)}`;
}

async function getSalesforceAccessToken(cfg = salesforceConfig(), getDb = null) {
  if (!cfg.configured) {
    const missing = [];
    if (!cfg.clientId) missing.push("SF_CLIENT_ID");
    if (!cfg.username) missing.push("SF_USERNAME");
    throw new Error(`Salesforce not configured — set ${missing.join(", ")} on ora-buddy-api Application settings`);
  }
  const assertion = await buildJwtAssertion(cfg, getDb);
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
  // Opportunity often has 120+ queryable fields; 90 was truncating Total_Ora_Net_Revenue__c.
  const maxFields = Number(process.env.SF_MAX_FIELDS || 160);
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

/** Lean field lists when describe returns nothing (common for Integration users). */
const LEAN_OBJECT_FIELDS = {
  Account: [
    "Id",
    "Name",
    "Owner.Name",
    "OwnerId",
    "Type",
    "Industry",
    "Website",
    "Phone",
    "Tier__c",
    "Ora_Grouping__c",
    "CreatedDate",
    "LastModifiedDate"
  ],
  Opportunity: [
    "Id",
    "Name",
    "AccountId",
    "StageName",
    "Amount",
    "Total_Ora_Net_Revenue__c",
    "CloseDate",
    "Owner.Name",
    "OwnerId",
    "Type",
    "IsClosed",
    "IsWon",
    "CreatedDate",
    "LastModifiedDate"
  ],
  Activity_Request__c: [
    "Id",
    "Name",
    "Account__c",
    "AccountId",
    "Status__c",
    "Status",
    "Subject__c",
    "CreatedDate",
    "LastModifiedDate"
  ]
};

/** Always keep these even when describe is capped / SOQL shrink peels fields. */
const MUST_HAVE_FIELDS = {
  Account: ["Id", "Name", "Owner.Name", "OwnerId", "Tier__c", "Ora_Grouping__c"],
  Opportunity: [
    "Id",
    "Name",
    "AccountId",
    "StageName",
    "Amount",
    "Total_Ora_Net_Revenue__c",
    "CloseDate",
    "Owner.Name",
    "OwnerId",
    "IsClosed",
    "IsWon"
  ],
  Activity_Request__c: ["Id", "Name", "Account__c", "AccountId", "Status__c", "Status", "Subject__c"]
};

function mergeMustHaveFields(objectName, fieldList, maxFields) {
  const must = MUST_HAVE_FIELDS[objectName] || LEAN_OBJECT_FIELDS[objectName] || ["Id", "Name"];
  const lean = LEAN_OBJECT_FIELDS[objectName] || [];
  const seen = new Set();
  const out = [];
  for (const f of [...must, ...lean, ...(fieldList || [])]) {
    if (!f || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  const cap = Number(maxFields) > 0 ? Number(maxFields) : 160;
  if (out.length <= cap) return out;
  // Cap extras but never drop must-haves
  const mustSet = new Set(must);
  const keptMust = out.filter((f) => mustSet.has(f));
  const extras = out.filter((f) => !mustSet.has(f));
  return [...keptMust, ...extras.slice(0, Math.max(0, cap - keptMust.length))];
}

/** Pull all (or capped) rows — describe when possible, else lean known fields. */
async function queryFullObject(session, objectName, opts = {}) {
  const maxFields = Number(process.env.SF_MAX_FIELDS || 160);
  let desc = null;
  let fieldList = [];
  try {
    desc = await describeSObject(session, objectName);
    if (desc.fields?.length) fieldList = [...desc.fields];
    // If describe capped away must-haves, pull them from allQueryable when present
    const must = MUST_HAVE_FIELDS[objectName] || [];
    const allQ = new Set(desc.allQueryable || []);
    for (const f of must) {
      // Relationship paths like Owner.Name are not in describe field names — keep anyway
      if (f.includes(".") || allQ.has(f) || fieldList.includes(f)) {
        if (!fieldList.includes(f)) fieldList.push(f);
      } else if (!f.includes(".") && !allQ.has(f)) {
        // still try — FLS may allow query even when not in our filtered list
        fieldList.push(f);
      }
    }
  } catch (err) {
    desc = { error: String(err.message || err), queryable: false, fields: [] };
  }

  if (!fieldList.length) {
    fieldList = [...(LEAN_OBJECT_FIELDS[objectName] || ["Id", "Name"])];
  }

  fieldList = mergeMustHaveFields(objectName, fieldList, maxFields);

  async function tryQuery(fields) {
    const uniq = [...new Set(fields.filter(Boolean))];
    const soql = `SELECT ${uniq.join(",")} FROM ${objectName}`;
    const records = await soqlQuery(session, soql, { maxRecords: opts.maxRecords });
    return { objectName, fields: uniq, records, describe: desc };
  }

  // Prefer lean+must first for Opportunity — full describe lists are huge and used to drop revenue.
  if (objectName === "Opportunity" || objectName === "Account" || objectName === "Activity_Request__c") {
    const leanTry = mergeMustHaveFields(
      objectName,
      LEAN_OBJECT_FIELDS[objectName] || [],
      maxFields
    );
    try {
      const out = await tryQuery(leanTry);
      // If lean worked, still try the richer list so we keep extra custom fields when possible
      try {
        const rich = await tryQuery(fieldList);
        rich.note =
          `Used ${rich.fields.length} fields (describe+must-have; available=${desc?.fieldCountAvailable ?? "?"})`;
        return rich;
      } catch (_) {
        out.note = `Used lean+must-have (${leanTry.length} fields)` +
          (desc?.error ? ` (describe: ${desc.error})` : "");
        return out;
      }
    } catch (_) {
      /* fall through to shrink loop on full list */
    }
  }

  // Shrink field list until SOQL works (drop unknown custom fields, etc.)
  let lastErr = null;
  let attempt = fieldList;
  const mustProtect = new Set(MUST_HAVE_FIELDS[objectName] || ["Id", "Name"]);
  for (let round = 0; round < 12; round++) {
    try {
      const out = await tryQuery(attempt);
      if (round > 0 || (desc && !desc.fields?.length)) {
        out.note =
          `Used ${attempt.length} fields` +
          (desc?.error ? ` (describe: ${desc.error})` : " (after shrink)");
      }
      return out;
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || err);
      const m =
        msg.match(/No such column '([^']+)'/i) ||
        msg.match(/field\s+([A-Za-z0-9_.]+)\s+does not exist/i) ||
        msg.match(/'\s*([A-Za-z][A-Za-z0-9_.]*)\s*'/);
      if (m && m[1] && attempt.includes(m[1])) {
        // Named bad field — drop it (even must-have if SF rejects the API name)
        attempt = attempt.filter((f) => f !== m[1]);
      } else if (attempt.length > mustProtect.size + 1) {
        // Peel non-protected from the end
        let peeled = 0;
        const next = [...attempt];
        for (let i = next.length - 1; i >= 0 && peeled < 8; i--) {
          if (mustProtect.has(next[i]) || next[i] === "Id") continue;
          next.splice(i, 1);
          peeled += 1;
        }
        if (!peeled) break;
        attempt = next;
      } else {
        break;
      }
      if (!attempt.includes("Id")) attempt = ["Id", ...attempt];
    }
  }

  // Last resort — must-have / lean, then Id + Name
  try {
    return await tryQuery(mergeMustHaveFields(objectName, LEAN_OBJECT_FIELDS[objectName] || ["Id", "Name"], 40));
  } catch (err1) {
    try {
      return await tryQuery(["Id", "Name"]);
    } catch (err) {
      throw lastErr || err1 || err;
    }
  }
}

/**
 * Fetch Accounts by Id list.
 * Returns Map id -> { id, name, ownerName, tier, oraGrouping, isDeleted }
 */
async function fetchAccountsByIds(session, ids, opts = {}) {
  const tierField = opts.tierField || session.tierField || "Tier__c";
  const groupingField = opts.groupingField || session.groupingField || "Ora_Grouping__c";
  // Only real Salesforce Ids (15/18). Crosswalk junk → MALFORMED_QUERY / 400.
  const unique = [
    ...new Set(
      (ids || [])
        .map((id) => String(id || "").trim())
        .filter((id) => /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(id))
    )
  ];
  const byId = new Map();
  if (!unique.length) return byId;
  const chunkSize = 80;

  async function queryChunk(chunk, fields) {
    const inList = chunk.map((id) => `'${id.replace(/'/g, "\\'")}'`).join(",");
    const soql = `SELECT ${fields.join(", ")} FROM Account WHERE Id IN (${inList})`;
    return soqlQuery(session, soql);
  }

  // Prefer lean fields first — IsDeleted often 400s on Account for non-admin / some APIs.
  const fieldAttempts = [
    ["Id", "Name", "Owner.Name", tierField, groupingField],
    ["Id", "Name", "Owner.Name", tierField],
    ["Id", "Name", "Owner.Name", groupingField],
    ["Id", "Name", "Owner.Name"],
    ["Id", "Name", "OwnerId", tierField, groupingField],
    ["Id", "Name", "OwnerId"],
    ["Id", "Name"]
  ];

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    let records = null;
    let lastErr = null;
    for (const fields of fieldAttempts) {
      const clean = [...new Set(fields.filter(Boolean))];
      try {
        records = await queryChunk(chunk, clean);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
    for (const r of records || []) {
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
  loadJwtPrivateKey,
  resolveJwtKeyMaterial,
  resolveJwtKeyMaterialAsync,
  saveCosmosJwtKey,
  diagnoseJwtPrivateKey,
  JWT_KEY_DOC_ID,
  sfGet
};
