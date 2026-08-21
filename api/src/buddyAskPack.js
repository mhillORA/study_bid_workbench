/**
 * Short-lived Buddy ask packs — store prepare-phase Cosmos context so
 * /api/ask/answer and /api/ask/visual can each finish under SWA's ~45s ceiling.
 */

const crypto = require("crypto");

const CONTAINER = "buddy_ask_packs";
const TTL_SECONDS = Number(process.env.BUDDY_ASK_PACK_TTL_SEC || 60 * 20); // 20 min
const MAX_DOC_CHARS = Number(process.env.BUDDY_ASK_PACK_MAX_CHARS || 900000);

function newPackId() {
  return `ask-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

async function ensurePackContainer(database) {
  try {
    await database.containers.createIfNotExists({
      id: CONTAINER,
      partitionKey: { paths: ["/id"] },
      defaultTtl: TTL_SECONDS
    });
  } catch (_) {
    /* may lack create rights */
  }
}

function slimContextForPack(context) {
  if (!context || typeof context !== "object") return context;
  const c = { ...context };
  if (c.portfolio?.studies && Array.isArray(c.portfolio.studies)) {
    c.portfolio = {
      ...c.portfolio,
      studies: c.portfolio.studies.slice(0, 80)
    };
  }
  if (c.intelligence && typeof c.intelligence === "object") {
    const intel = { ...c.intelligence };
    if (Array.isArray(intel.sites)) intel.sites = intel.sites.slice(0, 40);
    if (Array.isArray(intel.trials)) intel.trials = intel.trials.slice(0, 40);
    c.intelligence = intel;
  }
  if (c.uploadedDocuments?.files) {
    c.uploadedDocuments = {
      ...c.uploadedDocuments,
      files: c.uploadedDocuments.files.map((f) =>
        f && f.text
          ? { ...f, text: String(f.text).slice(0, 40000) }
          : f
      )
    };
  }
  if (c.buddyLiveContext?.text) {
    c.buddyLiveContext = {
      ...c.buddyLiveContext,
      text: String(c.buddyLiveContext.text).slice(0, 40000)
    };
  }
  return c;
}

function fitDoc(doc) {
  let json = JSON.stringify(doc);
  if (json.length <= MAX_DOC_CHARS) return doc;
  const next = { ...doc, context: slimContextForPack(doc.context) };
  if (next.context?.portfolio?.studies) {
    next.context = {
      ...next.context,
      portfolio: {
        ...next.context.portfolio,
        studies: next.context.portfolio.studies.slice(0, 30),
        note:
          (next.context.portfolio.note || "") +
          " Pack trimmed for Cosmos size — prefer byClient / aggregates."
      }
    };
  }
  json = JSON.stringify(next);
  if (json.length <= MAX_DOC_CHARS) return next;
  if (next.context) {
    next.context = {
      ...next.context,
      uploadedDocuments: next.context.uploadedDocuments
        ? {
            ...next.context.uploadedDocuments,
            files: (next.context.uploadedDocuments.files || []).map((f) =>
              f && f.text ? { ...f, text: String(f.text).slice(0, 12000) } : f
            )
          }
        : next.context.uploadedDocuments,
      packTrimmed: true
    };
  }
  return next;
}

/**
 * @returns {Promise<{ contextId: string, stored: boolean, error?: string }>}
 */
async function storeAskPack(getDb, opts = {}) {
  const database = getDb();
  await ensurePackContainer(database);
  const container = database.container(CONTAINER);
  const contextId = String(opts.contextId || newPackId());
  const now = new Date().toISOString();
  let doc = {
    id: contextId,
    contextId,
    question: String(opts.question || "").slice(0, 8000),
    history: Array.isArray(opts.history) ? opts.history.slice(-8) : [],
    context: slimContextForPack(opts.context),
    meta: opts.meta || {},
    createdAt: now,
    ttl: TTL_SECONDS
  };
  doc = fitDoc(doc);
  try {
    await container.items.upsert(doc);
    return { contextId, stored: true };
  } catch (err) {
    return {
      contextId: null,
      stored: false,
      error: String(err.message || err).slice(0, 240)
    };
  }
}

/**
 * @returns {Promise<object|null>}
 */
async function loadAskPack(getDb, contextId) {
  const id = String(contextId || "").trim();
  if (!id) return null;
  const database = getDb();
  await ensurePackContainer(database);
  try {
    const { resource } = await database.container(CONTAINER).item(id, id).read();
    return resource || null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  storeAskPack,
  loadAskPack,
  slimContextForPack,
  CONTAINER,
  TTL_SECONDS
};
