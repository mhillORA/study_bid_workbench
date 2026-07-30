/**
 * Live Buddy context additions — editable without redeploy.
 * Cosmos doc buddy-live-context-v1 in container buddy_live_context.
 * Append-only (never full replace). Organized by department + category.
 * Appended to always-on Ora playbook on every /api/ask.
 */

const crypto = require("crypto");

const DOC_ID = "buddy-live-context-v1";
const CONTAINER = "buddy_live_context";
const SCHEMA_VERSION = 2;
const MAX_CHARS = 80000;
const MAX_ENTRIES = 200;

const DEPARTMENTS = [
  { id: "general", name: "General" },
  { id: "bd", name: "BD" },
  { id: "ops", name: "Ops" },
  { id: "recruitment", name: "Recruitment" },
  { id: "clinops", name: "ClinOps" },
  { id: "monitoring", name: "Monitoring" },
  { id: "smo", name: "SMO" },
  { id: "analyst", name: "Analyst" },
  { id: "leadership", name: "Leadership" },
  { id: "feasibility", name: "Feasibility / Intelligence" },
  { id: "pricing", name: "Pricing / RFP" }
];

const CATEGORIES = [
  { id: "playbook", name: "Playbook / process" },
  { id: "talking-points", name: "Talking points" },
  { id: "ous", name: "OUS / geography" },
  { id: "sites", name: "Sites / PIs" },
  { id: "indication", name: "Indication notes" },
  { id: "pricing", name: "Pricing / comps" },
  { id: "ops", name: "Ops / workflow" },
  { id: "other", name: "Other" }
];

function slugId(v, fallback) {
  const s = String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || fallback;
}

function deptMeta(idOrName) {
  const raw = String(idOrName || "").trim();
  if (!raw) return DEPARTMENTS[0];
  const lower = raw.toLowerCase();
  const hit =
    DEPARTMENTS.find((d) => d.id === lower) ||
    DEPARTMENTS.find((d) => d.name.toLowerCase() === lower);
  if (hit) return hit;
  return { id: slugId(raw, "general"), name: raw };
}

function categoryMeta(idOrName) {
  const raw = String(idOrName || "").trim();
  if (!raw) return CATEGORIES[CATEGORIES.length - 1];
  const lower = raw.toLowerCase();
  const hit =
    CATEGORIES.find((c) => c.id === lower) ||
    CATEGORIES.find((c) => c.name.toLowerCase() === lower);
  if (hit) return hit;
  return { id: slugId(raw, "other"), name: raw };
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

function normalizeEntry(raw = {}) {
  const dept = deptMeta(raw.dept || raw.department || raw.deptId);
  const category = categoryMeta(raw.category || raw.categoryId);
  const text = String(raw.text || raw.body || raw.append || "").trim();
  return {
    id: String(raw.id || crypto.randomUUID()),
    at: raw.at || raw.updatedAt || null,
    by: raw.by || raw.updatedBy || null,
    dept: dept.id,
    deptName: dept.name,
    category: category.id,
    categoryName: category.name,
    text,
    chars: text.length,
    preview: text.slice(0, 160)
  };
}

/** Rebuild flat text Buddy consumes on every ask — grouped by dept then category. */
function rebuildText(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.text);
  if (!list.length) return "";

  const byDept = new Map();
  for (const e of list) {
    const key = e.dept || "general";
    if (!byDept.has(key)) byDept.set(key, []);
    byDept.get(key).push(e);
  }

  const parts = [];
  for (const [deptId, deptEntries] of byDept) {
    const deptName = deptEntries[0]?.deptName || deptMeta(deptId).name;
    parts.push(`## ${deptName}`);
    const byCat = new Map();
    for (const e of deptEntries) {
      const c = e.category || "other";
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(e);
    }
    for (const [catId, catEntries] of byCat) {
      const catName = catEntries[0]?.categoryName || categoryMeta(catId).name;
      parts.push(`### ${catName}`);
      for (const e of catEntries) {
        const meta = [e.at, e.by].filter(Boolean).join(" · ");
        parts.push(meta ? `---\n[${meta}]\n${e.text}` : `---\n${e.text}`);
      }
    }
  }
  return parts.join("\n\n").slice(0, MAX_CHARS);
}

function organizeEntries(entries) {
  const list = Array.isArray(entries) ? entries.map(normalizeEntry).filter((e) => e.text) : [];
  const byDepartment = [];
  const deptOrder = [];
  const deptMap = new Map();

  for (const e of list) {
    if (!deptMap.has(e.dept)) {
      deptMap.set(e.dept, {
        id: e.dept,
        name: e.deptName,
        categories: [],
        _catMap: new Map(),
        entryCount: 0,
        charCount: 0
      });
      deptOrder.push(e.dept);
    }
    const d = deptMap.get(e.dept);
    d.entryCount += 1;
    d.charCount += e.chars;
    if (!d._catMap.has(e.category)) {
      d._catMap.set(e.category, {
        id: e.category,
        name: e.categoryName,
        entries: [],
        entryCount: 0,
        charCount: 0
      });
      d.categories.push(d._catMap.get(e.category));
    }
    const c = d._catMap.get(e.category);
    c.entries.push(e);
    c.entryCount += 1;
    c.charCount += e.chars;
  }

  for (const id of deptOrder) {
    const d = deptMap.get(id);
    delete d._catMap;
    byDepartment.push(d);
  }

  return {
    byDepartment,
    entryCount: list.length,
    charCount: list.reduce((n, e) => n + e.chars, 0)
  };
}

/**
 * Migrate legacy flat-text docs into a single General/Other entry.
 */
function coerceEntries(resource) {
  const rawEntries = Array.isArray(resource.entries) ? resource.entries : [];
  const structured = rawEntries
    .map(normalizeEntry)
    .filter((e) => e.text);

  if (structured.length) return structured;

  const legacyText = String(resource.text || "").trim();
  if (!legacyText) return [];

  return [
    normalizeEntry({
      id: "legacy-flat-text",
      at: resource.updatedAt || null,
      by: resource.updatedBy || "legacy",
      dept: "general",
      category: "other",
      text: legacyText
    })
  ];
}

function packFromResource(resource, source) {
  const entries = coerceEntries(resource || {});
  const text = rebuildText(entries);
  const organized = organizeEntries(entries);
  return {
    id: DOC_ID,
    title: (resource && resource.title) || "Buddy live context",
    text,
    entries: entries.slice(-MAX_ENTRIES),
    organized,
    departments: DEPARTMENTS,
    categories: CATEGORIES,
    updatedAt: (resource && resource.updatedAt) || null,
    updatedBy: (resource && resource.updatedBy) || null,
    source,
    charCount: text.length,
    entryCount: entries.length,
    appendOnly: true,
    note: "Append-only. Additions are grouped by department and category. Full replace is disabled."
  };
}

async function loadLiveContext(getDb) {
  try {
    const database = getDb();
    await ensureContainer(database);
    const { resource } = await database.container(CONTAINER).item(DOC_ID, DOC_ID).read();
    if (resource) return packFromResource(resource, "cosmos");
  } catch (err) {
    if (err.code !== 404) {
      return {
        ...packFromResource(emptyDoc(), "error"),
        error: String(err.message || err)
      };
    }
  }
  return packFromResource(emptyDoc(), "empty");
}

/**
 * Append-only live context. Rejects full replace.
 * @param {Function} getDb
 * @param {{ append?: string, text?: string, dept?: string, category?: string, user?: object, title?: string }} opts
 */
async function saveLiveContext(getDb, opts = {}) {
  // Full replace intentionally disabled
  if (opts.text != null && !opts.append) {
    return {
      ok: false,
      error:
        "Full replace is disabled. Append new material with department + category instead."
    };
  }

  const chunk = String(opts.append || "").trim();
  if (!chunk) {
    return { ok: false, error: "append text is required" };
  }

  const database = getDb();
  await ensureContainer(database);
  const prev = await loadLiveContext(getDb);
  const now = new Date().toISOString();
  const who =
    (opts.user && (opts.user.email || opts.user.displayName || opts.user.firstName)) || "user";

  const dept = deptMeta(opts.dept || opts.department);
  const category = categoryMeta(opts.category);

  const entries = Array.isArray(prev.entries) ? prev.entries.map(normalizeEntry) : [];
  entries.push(
    normalizeEntry({
      id: crypto.randomUUID(),
      at: now,
      by: who,
      dept: dept.id,
      category: category.id,
      text: chunk
    })
  );

  const trimmed = entries.slice(-MAX_ENTRIES);
  const text = rebuildText(trimmed);

  const doc = {
    id: DOC_ID,
    docType: "buddy_live_context",
    schemaVersion: SCHEMA_VERSION,
    title: opts.title || prev.title || "Buddy live context",
    text,
    entries: trimmed,
    updatedAt: now,
    updatedBy: who
  };
  await database.container(CONTAINER).items.upsert(doc);

  const organized = organizeEntries(trimmed);
  return {
    ok: true,
    id: DOC_ID,
    charCount: text.length,
    entryCount: trimmed.length,
    updatedAt: now,
    updatedBy: who,
    dept: dept.id,
    deptName: dept.name,
    category: category.id,
    categoryName: category.name,
    organized,
    appendOnly: true,
    note: `Appended to ${dept.name} · ${category.name}. Buddy picks it up on the next ask (no redeploy).`
  };
}

module.exports = {
  DOC_ID,
  DEPARTMENTS,
  CATEGORIES,
  loadLiveContext,
  saveLiveContext,
  rebuildText,
  organizeEntries
};
