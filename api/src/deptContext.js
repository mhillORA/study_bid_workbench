/**
 * Department Buddy contexts — editable in the Context tab.
 * Source of truth: Cosmos `buddy_dept_contexts` (single doc id buddy-dept-contexts-v1).
 * Mirror: docs/buddy-dept-contexts.json (seed + optional GitHub commit on save).
 */

const fs = require("fs");
const path = require("path");

const DOC_ID = "buddy-dept-contexts-v1";
const CONTAINER = "buddy_dept_contexts";
const GIT_PATH = "docs/buddy-dept-contexts.json";
const SCHEMA_VERSION = 1;

const DEFAULT_DEPARTMENTS = [
  { id: "ops", name: "Ops", context: "", relatedTo: ["bd", "recruitment", "clinops"], relationshipNotes: "" },
  { id: "bd", name: "BD", context: "", relatedTo: ["ops", "leadership"], relationshipNotes: "" },
  {
    id: "recruitment",
    name: "Recruitment",
    context: "",
    relatedTo: ["clinops", "smo", "ops"],
    relationshipNotes: ""
  },
  { id: "clinops", name: "ClinOps", context: "", relatedTo: ["recruitment", "monitoring"], relationshipNotes: "" },
  { id: "monitoring", name: "Monitoring", context: "", relatedTo: ["clinops"], relationshipNotes: "" },
  { id: "smo", name: "SMO", context: "", relatedTo: ["recruitment", "ops"], relationshipNotes: "" },
  { id: "analyst", name: "Analyst", context: "", relatedTo: ["bd", "ops"], relationshipNotes: "" },
  { id: "leadership", name: "Leadership", context: "", relatedTo: ["bd", "ops"], relationshipNotes: "" }
];

function slugDept(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || `dept-${Date.now()}`;
}

function normalizeDept(raw = {}) {
  const name = String(raw.name || raw.dept || raw.department || "").trim();
  const id = String(raw.id || slugDept(name)).trim() || slugDept(name);
  const relatedTo = Array.isArray(raw.relatedTo)
    ? raw.relatedTo.map((x) => String(x).trim()).filter(Boolean)
    : String(raw.relatedTo || "")
        .split(/[,;]/)
        .map((x) => x.trim())
        .filter(Boolean);
  return {
    id,
    name: name || id,
    context: String(raw.context || raw.body || "").trim(),
    relatedTo,
    relationshipNotes: String(raw.relationshipNotes || raw.relationships || "").trim(),
    updatedAt: raw.updatedAt || null,
    updatedBy: raw.updatedBy || null
  };
}

function emptyPack() {
  const now = new Date().toISOString();
  return {
    id: DOC_ID,
    docType: "buddy_dept_contexts",
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now,
    departments: DEFAULT_DEPARTMENTS.map((d) => ({
      ...d,
      updatedAt: now,
      updatedBy: "seed"
    }))
  };
}

function seedPath() {
  return path.join(__dirname, "..", "..", "docs", "buddy-dept-contexts.json");
}

function readSeedFile() {
  try {
    const p = seedPath();
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!raw || !Array.isArray(raw.departments)) return null;
    return {
      id: DOC_ID,
      docType: "buddy_dept_contexts",
      schemaVersion: SCHEMA_VERSION,
      updatedAt: raw.updatedAt || new Date().toISOString(),
      departments: raw.departments.map(normalizeDept),
      source: "seed_file"
    };
  } catch (_) {
    return null;
  }
}

async function ensureContainer(database) {
  try {
    await database.containers.createIfNotExists({
      id: CONTAINER,
      partitionKey: { paths: ["/id"] }
    });
  } catch (_) {
    /* may already exist / no create rights */
  }
}

async function loadDeptContexts(getDb) {
  try {
    const database = getDb();
    await ensureContainer(database);
    const { resource } = await database.container(CONTAINER).item(DOC_ID, DOC_ID).read();
    if (resource && Array.isArray(resource.departments)) {
      return {
        id: DOC_ID,
        docType: "buddy_dept_contexts",
        schemaVersion: resource.schemaVersion || SCHEMA_VERSION,
        updatedAt: resource.updatedAt || null,
        departments: resource.departments.map(normalizeDept),
        source: "cosmos",
        gitSync: resource.gitSync || null
      };
    }
  } catch (err) {
    if (err.code !== 404) {
      /* fall through to seed */
    }
  }
  const seed = readSeedFile() || emptyPack();
  seed.source = seed.source || "default";
  return seed;
}

function contextKeyOk(password) {
  const expected = String(process.env.BUDDY_CONTEXT_KEY || "").trim();
  if (!expected || expected.includes("SET_IN")) return { ok: false, reason: "BUDDY_CONTEXT_KEY not configured" };
  const got = String(password || "").trim();
  if (!got || got !== expected) return { ok: false, reason: "Invalid context password" };
  return { ok: true };
}

async function commitToGitHub(pack) {
  const token = String(process.env.CONTEXT_GIT_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  const repo = String(process.env.CONTEXT_GIT_REPO || process.env.GITHUB_REPO || "mhillORA/study_bid_workbench").trim();
  const branch = String(process.env.CONTEXT_GIT_BRANCH || "main").trim();
  if (!token || token.includes("SET_IN")) {
    return { ok: false, skipped: true, reason: "CONTEXT_GIT_TOKEN / GITHUB_TOKEN not set — Cosmos saved; git mirror skipped" };
  }

  const body = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: pack.updatedAt,
    departments: pack.departments
  };
  const content = Buffer.from(JSON.stringify(body, null, 2) + "\n", "utf8").toString("base64");
  const apiBase = `https://api.github.com/repos/${repo}/contents/${GIT_PATH}`;

  let sha = null;
  try {
    const getRes = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "study-bid-workbench-context"
      }
    });
    if (getRes.ok) {
      const cur = await getRes.json();
      sha = cur.sha || null;
    }
  } catch (_) {
    /* create new file */
  }

  const putRes = await fetch(apiBase, {
    method: "PUT",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "study-bid-workbench-context"
    },
    body: JSON.stringify({
      message: `Update Buddy department contexts (${pack.departments.length} depts)`,
      content,
      branch,
      sha: sha || undefined
    })
  });
  const putBody = await putRes.json().catch(() => ({}));
  if (!putRes.ok) {
    return {
      ok: false,
      reason: putBody.message || `GitHub ${putRes.status}`,
      status: putRes.status
    };
  }
  return {
    ok: true,
    path: GIT_PATH,
    branch,
    commit: putBody.commit?.sha || null,
    htmlUrl: putBody.content?.html_url || null
  };
}

/**
 * Upsert full pack or merge one department.
 * opts.password required when requirePassword true (Buddy learn path).
 */
async function saveDeptContexts(getDb, payload = {}, opts = {}) {
  const requirePassword = opts.requirePassword !== false;
  if (requirePassword) {
    const auth = contextKeyOk(payload.password || opts.password);
    if (!auth.ok) return { ok: false, error: auth.reason, status: 401 };
  }

  const now = new Date().toISOString();
  const existing = await loadDeptContexts(getDb);
  let departments = Array.isArray(existing.departments) ? existing.departments.map(normalizeDept) : [];

  if (Array.isArray(payload.departments)) {
    departments = payload.departments.map(normalizeDept);
  } else if (payload.department || payload.dept) {
    const incoming = normalizeDept(payload.department || payload.dept);
    if (payload.mode === "append" && incoming.context) {
      const idx = departments.findIndex((d) => d.id === incoming.id || d.name.toLowerCase() === incoming.name.toLowerCase());
      if (idx >= 0) {
        const prev = departments[idx];
        incoming.context = [prev.context, incoming.context].filter(Boolean).join("\n\n");
        incoming.relatedTo = [...new Set([...(prev.relatedTo || []), ...(incoming.relatedTo || [])])];
        if (!incoming.relationshipNotes) incoming.relationshipNotes = prev.relationshipNotes;
        incoming.name = prev.name || incoming.name;
        incoming.id = prev.id;
      }
    }
    const idx = departments.findIndex((d) => d.id === incoming.id || d.name.toLowerCase() === incoming.name.toLowerCase());
    incoming.updatedAt = now;
    incoming.updatedBy = opts.updatedBy || payload.updatedBy || "ui";
    if (idx >= 0) departments[idx] = { ...departments[idx], ...incoming };
    else departments.push(incoming);
  } else if (payload.deleteId) {
    departments = departments.filter((d) => d.id !== payload.deleteId);
  } else {
    return { ok: false, error: "Provide departments[] or department/dept", status: 400 };
  }

  const pack = {
    id: DOC_ID,
    docType: "buddy_dept_contexts",
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now,
    departments,
    updatedBy: opts.updatedBy || payload.updatedBy || "ui"
  };

  const database = getDb();
  await ensureContainer(database);
  let gitSync = null;
  try {
    gitSync = await commitToGitHub(pack);
  } catch (err) {
    gitSync = { ok: false, reason: String(err.message || err) };
  }
  pack.gitSync = gitSync;

  await database.container(CONTAINER).items.upsert(pack);

  // Best-effort local write (dev machines / not SWA)
  try {
    const p = seedPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, updatedAt: now, departments }, null, 2) + "\n",
      "utf8"
    );
    pack.localFileWritten = true;
  } catch (_) {
    pack.localFileWritten = false;
  }

  return {
    ok: true,
    pack: {
      ...pack,
      source: "cosmos"
    },
    gitSync
  };
}

/** Slim pack for Buddy system context. */
function buddyContextSummary(pack) {
  if (!pack || !Array.isArray(pack.departments)) return null;
  return {
    source: pack.source || "buddy_dept_contexts",
    updatedAt: pack.updatedAt || null,
    departments: pack.departments.map((d) => ({
      id: d.id,
      name: d.name,
      context: d.context || "",
      relatedTo: d.relatedTo || [],
      relationshipNotes: d.relationshipNotes || "",
      hasContent: Boolean(String(d.context || "").trim())
    })),
    thinDepts: pack.departments.filter((d) => !String(d.context || "").trim()).map((d) => d.name),
    note:
      "Department contexts authored in the Context tab. Prefer these over guessing how Ops/BD/Recruitment work. If thinDepts is non-empty, ask 1–2 learning questions. To propose a learned addition end with LEARN_CONTEXT:{\"dept\":\"Ops\",\"addition\":\"…\",\"relatedTo\":[\"BD\"]} — user must confirm in the Buddy Context tab before it saves."
  };
}

/** Map workbench / Entra department labels → buddy dept ids. */
const WORKBENCH_DEPT_TO_BUDDY = {
  recruitment: "recruitment",
  clinops: "clinops",
  monitoring: "monitoring",
  smo: "smo",
  analyst: "analyst",
  bd: "bd",
  ops: "ops",
  leadership: "leadership",
  feasibility: "recruitment",
  admin: "auto",
  tah: "analyst"
};

function resolveBuddyDeptId(input) {
  const raw = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!raw || raw === "auto" || raw === "all" || raw === "*") return "auto";
  if (WORKBENCH_DEPT_TO_BUDDY[raw]) return WORKBENCH_DEPT_TO_BUDDY[raw];
  if (DEFAULT_DEPARTMENTS.some((d) => d.id === raw)) return raw;
  return raw.slice(0, 48) || "auto";
}

const MAX_DEPT_CONTEXT_CHARS = 12000;

/** Focused dept pack for /api/ask — primary dept + related + index of all. */
function buildDeptContextForAsk(pack, activeDeptId = "auto") {
  const summary = buddyContextSummary(pack);
  if (!summary) return null;

  const lens = resolveBuddyDeptId(activeDeptId);
  const trimCtx = (text, max = 4000) => {
    const s = String(text || "").trim();
    if (s.length <= max) return s;
    return `${s.slice(0, max)}… [trimmed]`;
  };

  if (lens === "auto") {
    const withContent = summary.departments.filter((d) => d.hasContent);
    let total = 0;
    const departments = [];
    for (const d of withContent) {
      const ctx = trimCtx(d.context, 2500);
      total += ctx.length + (d.relationshipNotes || "").length;
      if (total > MAX_DEPT_CONTEXT_CHARS) break;
      departments.push({
        ...d,
        context: ctx,
        relationshipNotes: trimCtx(d.relationshipNotes, 800)
      });
    }
    return {
      ...summary,
      lens: "auto",
      activeDept: null,
      departments,
      deptIndex: summary.departments.map((d) => ({
        id: d.id,
        name: d.name,
        hasContent: d.hasContent,
        relatedTo: d.relatedTo
      })),
      note:
        "Dept lens=auto (all departments with playbook content). Tailor tone to the user's question; cite related departments when handoffs matter."
    };
  }

  const primary = summary.departments.find((d) => d.id === lens);
  const relatedIds = primary?.relatedTo || [];
  const relatedDepts = summary.departments
    .filter((d) => relatedIds.includes(d.id) && d.hasContent)
    .map((d) => ({
      id: d.id,
      name: d.name,
      context: trimCtx(d.context, 1800),
      relationshipNotes: trimCtx(d.relationshipNotes, 600)
    }));

  return {
    source: summary.source,
    updatedAt: summary.updatedAt,
    lens,
    activeDept: primary
      ? {
          id: primary.id,
          name: primary.name,
          context: trimCtx(primary.context, 6000),
          relationshipNotes: trimCtx(primary.relationshipNotes, 1200),
          relatedTo: primary.relatedTo,
          hasContent: primary.hasContent
        }
      : { id: lens, name: lens, context: "", relationshipNotes: "", relatedTo: [], hasContent: false },
    relatedDepts,
    thinDepts: summary.thinDepts,
    deptIndex: summary.departments.map((d) => ({
      id: d.id,
      name: d.name,
      hasContent: d.hasContent,
      relatedTo: d.relatedTo
    })),
    note: primary?.hasContent
      ? `Dept lens=${primary.name}: answer in their voice and priorities; pull related dept notes for handoffs.`
      : `Dept lens=${lens} but playbook is thin — ask 1–2 clarifying questions about how ${lens} works here before guessing.`
  };
}

module.exports = {
  DOC_ID,
  GIT_PATH,
  DEFAULT_DEPARTMENTS,
  loadDeptContexts,
  saveDeptContexts,
  buddyContextSummary,
  buildDeptContextForAsk,
  resolveBuddyDeptId,
  WORKBENCH_DEPT_TO_BUDDY,
  contextKeyOk,
  normalizeDept,
  slugDept,
  emptyPack
};
