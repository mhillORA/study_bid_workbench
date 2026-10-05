/**
 * NetSuite SuiteQL client for Buddy (same pattern as salesforceClient).
 *
 * App Settings on ora-buddy-api (Key Vault refs OK):
 *   NS_ACCOUNT_ID     e.g. 1169465
 *   NS_CLIENT_ID      OAuth 2.0 client id (iss)
 *   NS_CERT_ID        certificate id (JWT kid)
 *   NS_PRIVATE_KEY    PEM private key (PS256), or
 *   NS_PRIVATE_KEY_B64 base64 of the .key file
 *
 * Optional aliases match Key Vault secret names used by netsuite-pull-job:
 *   ns-client-id, ns-cert-id, ns-private-key
 */

const crypto = require("crypto");

function env(name) {
  const v = String(process.env[name] || "").trim();
  if (!v || v.includes("SET_IN")) return "";
  return v;
}

function envLoose(...names) {
  for (const name of names) {
    const direct = env(name);
    if (direct) return direct;
    const want = String(name || "").toUpperCase().replace(/-/g, "_");
    for (const [k, raw] of Object.entries(process.env || {})) {
      const norm = String(k).toUpperCase().replace(/-/g, "_");
      if (norm !== want && String(k) !== name) continue;
      const v = String(raw || "").trim();
      if (!v || v.includes("SET_IN")) continue;
      return v;
    }
  }
  return "";
}

function normalizePem(raw) {
  let s = String(raw || "").trim().replace(/^["']|["']$/g, "");
  if (!s) return "";
  s = s.replace(/\\\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  s = s.replace(/^\uFEFF/, "");
  const needsRebuild =
    !/BEGIN\s+(?:RSA\s+)?PRIVATE KEY/i.test(s) ||
    (!s.includes("\n") && /BEGIN/i.test(s));
  if (needsRebuild) {
    const m = s.match(/-----BEGIN\s+((?:RSA\s+)?PRIVATE KEY)-----([\s\S]*?)-----END\s+\1-----/i);
    const label = m ? m[1].toUpperCase().replace(/\s+/g, " ") : "PRIVATE KEY";
    const body = (m ? m[2] : s).replace(/\s+/g, "");
    if (!body) return "";
    const lines = body.match(/.{1,64}/g) || [body];
    s = `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
  }
  return s;
}

function resolvePrivateKey() {
  const b64 = envLoose("NS_PRIVATE_KEY_B64", "ns-private-key-b64");
  if (b64) {
    try {
      return normalizePem(Buffer.from(b64, "base64").toString("utf8"));
    } catch (_) {
      /* fall through */
    }
  }
  return normalizePem(envLoose("NS_PRIVATE_KEY", "ns-private-key"));
}

function netsuiteConfig() {
  const accountId = envLoose("NS_ACCOUNT_ID", "ns-account-id") || "1169465";
  const clientId = envLoose("NS_CLIENT_ID", "ns-client-id");
  const certId = envLoose("NS_CERT_ID", "ns-cert-id");
  const privateKey = resolvePrivateKey();
  const host = String(accountId).replace(/_/g, "-").toLowerCase();
  return {
    accountId,
    clientId,
    certId,
    privateKey,
    configured: Boolean(accountId && clientId && certId && privateKey),
    tokenUrl: `https://${host}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`,
    suiteqlUrl: `https://${host}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`
  };
}

function notConfiguredPayload() {
  const cfg = netsuiteConfig();
  return {
    ok: false,
    configured: false,
    error:
      "NetSuite not configured on ora-buddy-api. Set NS_ACCOUNT_ID, NS_CLIENT_ID, NS_CERT_ID, NS_PRIVATE_KEY (or NS_PRIVATE_KEY_B64) — same values as netsuite-pull-job Key Vault secrets.",
    missing: [
      !cfg.accountId && "NS_ACCOUNT_ID",
      !cfg.clientId && "NS_CLIENT_ID",
      !cfg.certId && "NS_CERT_ID",
      !cfg.privateKey && "NS_PRIVATE_KEY"
    ].filter(Boolean)
  };
}

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signJwtPs256(header, payload, pem) {
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign("sha256", Buffer.from(data, "utf8"), {
    key: pem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  });
  return `${data}.${b64url(sig)}`;
}

async function getNetSuiteAccessToken() {
  const cfg = netsuiteConfig();
  if (!cfg.configured) {
    const err = new Error(notConfiguredPayload().error);
    err.code = "NS_NOT_CONFIGURED";
    throw err;
  }
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwtPs256(
    { typ: "JWT", alg: "PS256", kid: cfg.certId },
    {
      iss: cfg.clientId,
      scope: ["restlets", "rest_webservices"],
      iat: now,
      exp: now + 3600,
      aud: cfg.tokenUrl
    },
    cfg.privateKey
  );
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion
  });
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    json = { raw: text.slice(0, 400) };
  }
  if (!res.ok || !json.access_token) {
    throw new Error(`NetSuite token ${res.status}: ${text.slice(0, 400)}`);
  }
  return { accessToken: json.access_token, cfg };
}

function stripLinks(rows) {
  return (rows || []).map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row || {})) {
      if (k === "links") continue;
      out[String(k).toLowerCase()] = v;
    }
    return out;
  });
}

/**
 * SuiteQL with limit/offset pagination (same rules as netsuite-pull-job).
 */
async function suiteqlAll(accessToken, cfg, sql, { label = "query", pageSize = 1000, maxOffset = 100000 } = {}) {
  const items = [];
  let offset = 0;
  let page = 0;
  while (offset < maxOffset) {
    const url = `${cfg.suiteqlUrl}?limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        Prefer: "transient"
      },
      body: JSON.stringify({ q: sql })
    });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch (_) {
      throw new Error(`SuiteQL ${label} ${res.status}: ${text.slice(0, 400)}`);
    }
    if (!res.ok) {
      throw new Error(`SuiteQL ${label} ${res.status}: ${text.slice(0, 400)}`);
    }
    const batch = payload.items || [];
    const hasMore = Boolean(payload.hasMore);
    items.push(...batch);
    if (!batch.length || !hasMore || batch.length < pageSize) break;
    offset += pageSize;
    page += 1;
    if (page > 500) break;
  }
  return stripLinks(items);
}

module.exports = {
  netsuiteConfig,
  notConfiguredPayload,
  getNetSuiteAccessToken,
  suiteqlAll
};
