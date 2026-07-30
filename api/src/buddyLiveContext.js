/**
 * Live Buddy context additions — editable without redeploy.
 * Cosmos doc buddy-live-context-v1 in container buddy_live_context.
 * Appended to always-on Ora playbook on every /api/ask.
 */

const DOC_ID = "buddy-live-context-v1";
const CONTAINER = "buddy_live_context";
const SCHEMA_VERSION = 1;
const MAX_CHARS = 80000;

function contextKeyOk(password) {
  const expected = String(process.env.BUDDY_CONTEXT_KEY || "").trim();
  if (!expected || expected.includes("SET_IN")) {
    return { ok: false, reason: "BUDDY_CONTEXT_KEY not configured in SWA App Settings" };
  }
  const got = String(password || "").trim();
  if (!got || got !== expected) return { ok: false, reason: "Invalid context password" };
  return { ok: true };
}

async function ensureContainer(database) {
  try {
    await database.containers.createIfNotExists({
      id: CONTAINER,
      partitionKey: { paths: ["/id"] }
    });
  } catch (_) {}
}

function emptyDoc() {
  return {
    id: DOC_ID,
    docType: "buddy_live_context",
    schemaVersion: SCHEMA_VERSION,
    updatedAt: null,
    updatedBy: null,
    title: "Buddy live context",
    text: "",
    entries: []
  };
}

async function loadLiveContext(getDb) {
  try {
    const database = getDb();
    await ensureContainer(database);
    const { resource } = await database.container(CONTAINER).item(DOC_ID, DOC_ID).read();
    if (resource) {
      return {
        id: DOC_ID,
        title: resource.title || "Buddy live context",
        text: String(resource.text || "").slice(0, MAX_CHARS),
        entries: Array.isArray(resource.entries) ? resource.entries.slice(-50) : [],
        updatedAt: resource.updatedAt || null,
        updatedBy: resource.updatedBy || null,
        source: "cosmos",
        charCount: String(resource.text || "").length
      };
    }
  } catch (err) {
    if (err.code !== 404) {
      return { ...emptyDoc(), source: "error", error: String(err.message || err) };
    }
  }
  return { ...emptyDoc(), source: "empty", charCount: 0 };
}

/**
 * Replace or append live context text.
 * @param {Function} getDb
 * @param {{ text?: string, append?: string, password: string, user?: object, title?: string }} opts
 */
async function saveLiveContext(getDb, opts = {}) {
  const auth = contextKeyOk(opts.password);
  if (!auth.ok) return { ok: false, error: auth.reason };

  const database = getDb();
  await ensureContainer(database);
  const prev = await loadLiveContext(getDb);
  const now = new Date().toISOString();
  const who =
    (opts.user && (opts.user.email || opts.user.displayName || opts.user.firstName)) || "user";

  let text = prev.text || "";
  if (opts.text != null) text = String(opts.text);
  if (opts.append) {
    const chunk = String(opts.append).trim();
    if (chunk) {
      text = `${text ? `${text.trim()}\n\n` : ""}---\nAdded ${now} by ${who}\n${chunk}\n`;
    }
  }
  text = text.slice(0, MAX_CHARS);

  const entries = Array.isArray(prev.entries) ? [...prev.entries] : [];
  if (opts.append && String(opts.append).trim()) {
    entries.push({
      at: now,
      by: who,
      chars: String(opts.append).trim().length,
      preview: String(opts.append).trim().slice(0, 160)
    });
  }

  const doc = {
    id: DOC_ID,
    docType: "buddy_live_context",
    schemaVersion: SCHEMA_VERSION,
    title: opts.title || prev.title || "Buddy live context",
    text,
    entries: entries.slice(-50),
    updatedAt: now,
    updatedBy: who
  };
  await database.container(CONTAINER).items.upsert(doc);
  return {
    ok: true,
    id: DOC_ID,
    charCount: text.length,
    updatedAt: now,
    updatedBy: who,
    note: "Live context saved to Cosmos — Buddy picks it up on the next ask (no redeploy)."
  };
}

module.exports = {
  DOC_ID,
  loadLiveContext,
  saveLiveContext,
  contextKeyOk
};
