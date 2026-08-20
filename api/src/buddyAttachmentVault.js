/**
 * Short-lived attachment vault — store extracted Buddy uploads in Cosmos
 * so reconcile follow-ups use attachmentIds instead of replaying base64.
 */

const crypto = require("crypto");

const CONTAINER = "buddy_attachment_vault";
const TTL_SECONDS = Number(process.env.BUDDY_ATTACHMENT_TTL_SEC || 60 * 60 * 24); // 24h
const MAX_FILES_PER_SESSION = 8;

function newSessionId() {
  return `att-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

async function ensureVault(database) {
  try {
    await database.containers.createIfNotExists({
      id: CONTAINER,
      partitionKey: { paths: ["/id"] },
      defaultTtl: TTL_SECONDS
    });
  } catch (_) {
    /* may lack create rights — read/write may still work */
  }
}

/**
 * Persist normalized upload files (with text). Returns { sessionId, files: [{id,name,...}] }.
 */
async function storeAttachments(getDb, uploaded, opts = {}) {
  const files = (uploaded?.files || []).filter((f) => f && f.ok && f.text);
  if (!files.length) return { sessionId: null, files: [], stored: false };

  const sessionId = String(opts.sessionId || newSessionId());
  const database = getDb();
  await ensureVault(database);
  const container = database.container(CONTAINER);
  const now = new Date().toISOString();
  const saved = [];

  for (const f of files.slice(0, MAX_FILES_PER_SESSION)) {
    const id = `${sessionId}:${crypto.randomBytes(3).toString("hex")}`;
    const doc = {
      id,
      sessionId,
      name: f.name,
      mimeType: f.mimeType || null,
      charCount: f.charCount || String(f.text || "").length,
      text: String(f.text || "").slice(0, 80000),
      createdAt: now,
      createdBy: opts.userId || null,
      ttl: TTL_SECONDS
    };
    try {
      await container.items.upsert(doc);
      saved.push({
        id,
        name: doc.name,
        mimeType: doc.mimeType,
        charCount: doc.charCount,
        ok: true
      });
    } catch (err) {
      saved.push({
        id: null,
        name: f.name,
        ok: false,
        error: String(err.message || err)
      });
    }
  }

  return {
    sessionId: saved.some((s) => s.id) ? sessionId : null,
    files: saved,
    stored: saved.some((s) => s.id)
  };
}

/**
 * Load by attachment ids or session id. Returns shape compatible with normalizeBuddyAttachments output.
 */
async function loadAttachments(getDb, { attachmentIds = [], sessionId = null } = {}) {
  const database = getDb();
  await ensureVault(database);
  const container = database.container(CONTAINER);
  const files = [];

  const ids = [...new Set((attachmentIds || []).map((x) => String(x || "").trim()).filter(Boolean))];
  for (const id of ids.slice(0, MAX_FILES_PER_SESSION)) {
    try {
      const { resource } = await container.item(id, id).read();
      if (resource?.text) {
        files.push({
          name: resource.name || "attachment",
          mimeType: resource.mimeType || "text/plain",
          ok: true,
          charCount: resource.charCount || String(resource.text).length,
          text: resource.text,
          attachmentId: resource.id,
          fromVault: true
        });
      }
    } catch (_) {
      files.push({
        name: id,
        ok: false,
        error: "attachment expired or not found — re-attach the file"
      });
    }
  }

  if (!files.length && sessionId) {
    try {
      const query = {
        query: "SELECT * FROM c WHERE c.sessionId = @sid",
        parameters: [{ name: "@sid", value: String(sessionId) }]
      };
      const { resources } = await container.items.query(query).fetchAll();
      for (const resource of (resources || []).slice(0, MAX_FILES_PER_SESSION)) {
        if (!resource?.text) continue;
        files.push({
          name: resource.name || "attachment",
          mimeType: resource.mimeType || "text/plain",
          ok: true,
          charCount: resource.charCount || String(resource.text).length,
          text: resource.text,
          attachmentId: resource.id,
          fromVault: true
        });
      }
    } catch (_) {
      /* ignore */
    }
  }

  const okFiles = files.filter((f) => f.ok);
  return {
    files,
    totalChars: okFiles.reduce((n, f) => n + (f.charCount || 0), 0),
    sessionId: sessionId || null,
    fromVault: true
  };
}

module.exports = {
  storeAttachments,
  loadAttachments,
  newSessionId,
  CONTAINER,
  TTL_SECONDS
};
