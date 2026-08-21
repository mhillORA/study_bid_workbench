/**
 * Short-lived Buddy session tokens.
 * SWA (Entra-gated) mints; external Function App verifies so /api/ask*
 * is not left wide open when called outside the SWA proxy.
 */

const crypto = require("crypto");

const DEFAULT_TTL_SEC = Number(process.env.BUDDY_SESSION_TTL_SEC || 60 * 60); // 1h

function sessionSecret() {
  return String(process.env.BUDDY_SESSION_SECRET || "").trim();
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}

function fromB64url(str) {
  const s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, "base64").toString("utf8");
}

function mintBuddySession(claims = {}) {
  const secret = sessionSecret();
  if (!secret) {
    return { ok: false, error: "BUDDY_SESSION_SECRET not configured" };
  }
  const now = Math.floor(Date.now() / 1000);
  const ttl = DEFAULT_TTL_SEC;
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: "study-bid-workbench",
    aud: "buddy-api",
    iat: now,
    exp: now + ttl,
    sub: String(claims.sub || claims.email || claims.userId || "buddy-user").slice(0, 200),
    email: claims.email ? String(claims.email).slice(0, 200) : undefined,
    name: claims.name ? String(claims.name).slice(0, 200) : undefined
  };
  const body = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = crypto.createHmac("sha256", secret).update(body).digest();
  const token = `${body}.${b64url(sig)}`;
  return {
    ok: true,
    token,
    expiresAt: new Date((now + ttl) * 1000).toISOString(),
    expiresIn: ttl
  };
}

function verifyBuddySessionToken(token) {
  const secret = sessionSecret();
  if (!secret) {
    return { ok: false, error: "BUDDY_SESSION_SECRET not configured" };
  }
  const raw = String(token || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3) return { ok: false, error: "malformed_token" };
  const [h, p, s] = parts;
  const body = `${h}.${p}`;
  const expected = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  const a = Buffer.from(expected);
  const b = Buffer.from(String(s));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: "bad_signature" };
  }
  let payload;
  try {
    payload = JSON.parse(fromB64url(p));
  } catch {
    return { ok: false, error: "bad_payload" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > Number(payload.exp)) {
    return { ok: false, error: "expired" };
  }
  if (payload.aud && payload.aud !== "buddy-api") {
    return { ok: false, error: "bad_audience" };
  }
  return { ok: true, payload };
}

/**
 * When BUDDY_REQUIRE_SESSION=1 (set on external Function App), ask routes need Bearer token.
 */
function buddySessionRequired() {
  const flag = String(process.env.BUDDY_REQUIRE_SESSION || "")
    .trim()
    .toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

function bearerFromRequest(request, headerGet) {
  const auth = String(headerGet(request, "authorization") || "").trim();
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  const alt = String(headerGet(request, "x-buddy-session") || "").trim();
  return alt || null;
}

function assertBuddySession(request, headerGet) {
  if (!buddySessionRequired()) {
    return { ok: true, skipped: true };
  }
  if (!sessionSecret()) {
    return { ok: false, status: 503, error: "Buddy API session secret missing" };
  }
  const token = bearerFromRequest(request, headerGet);
  if (!token) {
    return { ok: false, status: 401, error: "Buddy session required" };
  }
  const verified = verifyBuddySessionToken(token);
  if (!verified.ok) {
    return { ok: false, status: 401, error: `Buddy session invalid (${verified.error})` };
  }
  return { ok: true, payload: verified.payload };
}

module.exports = {
  mintBuddySession,
  verifyBuddySessionToken,
  buddySessionRequired,
  assertBuddySession,
  sessionSecret,
  bearerFromRequest
};
