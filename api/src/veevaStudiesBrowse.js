/**
 * Browse Ora Veeva studies in Cosmos — list + drill-down detail (milestones).
 */

const { vaultIndicationLabel } = require("./veevaPsm");
const { buildStudyMilestoneBoard } = require("./veevaStudyMilestones");

async function queryAll(container, query, parameters = []) {
  const { resources } = await container.items
    .query({ query, parameters }, { enableCrossPartitionQuery: true })
    .fetchAll();
  return resources || [];
}

function picklistLabel(v) {
  if (v == null || v === "") return null;
  if (typeof v === "object") return v.label || v.name || v.value || null;
  const s = String(v).trim();
  return s || null;
}

function studySearchBlob(row) {
  return `${row.study_number || ""} ${row.study_name || ""} ${row.sponsor || ""} ${row.indication || ""}`.toLowerCase();
}

/**
 * Lightweight Veeva study catalog for the Studies tab.
 */
async function listVeevaStudies(getDb, opts = {}) {
  const database = getDb();
  const limit = Math.min(Number(opts.limit) || 250, 500);
  const q = String(opts.q || opts.search || "").trim().toLowerCase();

  const studyRows = await queryAll(
    database.container("ora_veeva_study"),
    `SELECT c.id, c.name__v, c.alternate_study_number__vs, c.study_name__v,
            c.sponsor__c, c.sponsor_organization__v, c.indication__v, c.indication__c,
            c.study_phase__v, c.status__v, c.study_status__v, c.enrollment__vs
     FROM c WHERE c.docType = @t`,
    [{ name: "@t", value: "ora_veeva_study" }]
  );

  const sponsorNameById = new Map();
  try {
    const sponsors = await queryAll(
      database.container("ora_veeva_sponsor"),
      `SELECT c.id, c.name__v FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_veeva_sponsor" }]
    );
    for (const s of sponsors) sponsorNameById.set(s.id, s.name__v || null);
  } catch (_) {
    /* optional */
  }

  const studies = [];
  for (const s of studyRows) {
    const name = String(s.study_name__v || s.name__v || "").toUpperCase();
    if (name.includes("TEST")) continue;
    const row = {
      id: s.id,
      study_number: s.alternate_study_number__vs || s.name__v || s.id,
      study_name: s.study_name__v || s.name__v || null,
      sponsor:
        (s.sponsor__c && sponsorNameById.get(s.sponsor__c)) || s.sponsor_organization__v || null,
      indication: vaultIndicationLabel(s.indication__v || s.indication__c),
      phase: picklistLabel(s.study_phase__v),
      status: picklistLabel(s.status__v || s.study_status__v),
      enrollment: s.enrollment__vs != null ? Number(s.enrollment__vs) : null
    };
    if (q && !studySearchBlob(row).includes(q)) continue;
    studies.push(row);
  }

  studies.sort((a, b) =>
    String(a.study_number || "").localeCompare(String(b.study_number || ""), undefined, {
      sensitivity: "base"
    })
  );

  return {
    ok: true,
    studies: studies.slice(0, limit),
    studyCount: studies.length,
    truncated: studies.length > limit,
    note: "Ora Veeva studies from Cosmos — drill in for milestone timelines."
  };
}

/**
 * Single-study detail with milestone board (same canonical steps as Study Info).
 */
async function getVeevaStudyDetail(getDb, studyKey) {
  const key = String(studyKey || "").trim();
  if (!key) return { ok: false, error: "study id required" };

  const board = await buildStudyMilestoneBoard(getDb, { study: key, limit: 1 });
  const study = (board.studies || [])[0] || null;
  if (!study) {
    const list = await listVeevaStudies(getDb, { q: key, limit: 5 });
    const meta = (list.studies || []).find(
      (s) => s.id === key || String(s.study_number || "").toLowerCase() === key.toLowerCase()
    );
    if (!meta) {
      return { ok: false, error: `No Veeva study matched "${key}".` };
    }
    return {
      ok: true,
      study: { ...meta, milestones: [], intervals: [], milestonesCompleted: 0 },
      note: "Study found but fewer than two milestone dates — run Ingest Veeva or check milestone sync."
    };
  }
  return { ok: true, study, note: board.note || null };
}

module.exports = {
  listVeevaStudies,
  getVeevaStudyDetail
};
