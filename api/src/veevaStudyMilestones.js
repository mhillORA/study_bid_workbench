/**
 * Study-level Veeva milestone timelines — canonical step order aligned with
 * vw_veeva_milestones_calculations (study-level rows only; not every Vault type).
 */

const { vaultIndicationLabel, milestoneSingleDayActualDate } = require("./veevaPsm");

/** Canonical study lifecycle milestones (type → display + order). */
const CANONICAL_STUDY_MILESTONES = [
  { types: ["initial_sow_execution__c"], displayName: "Initial SOW Execution", stepOrder: 1 },
  { types: ["protocol_approved__c"], displayName: "Protocol Approved", stepOrder: 2 },
  { types: ["study_greenlight_approval__c"], displayName: "Study Greenlight Approval", stepOrder: 3 },
  { types: ["ip_availability__c"], displayName: "IP Availability", stepOrder: 4 },
  { types: ["edc_go_live__c"], displayName: "EDC Go Live", stepOrder: 5 },
  { types: ["fsi__ctms"], displayName: "First Subject In", stepOrder: 6 },
  {
    types: ["first_subject_started_treatment__v", "first_subject_treated__v"],
    displayName: "First Subject Started Treatment",
    stepOrder: 7
  },
  { types: ["lsi__ctms"], displayName: "Last Subject In", stepOrder: 8 },
  {
    types: ["last_subject_started_treatment__v", "last_subject_treated__v"],
    displayName: "Last Subject Started Treatment",
    stepOrder: 9
  },
  { types: ["first_subject_out__v"], displayName: "First Subject Out", stepOrder: 10 },
  { types: ["lso__ctms"], displayName: "Last Subject Out", stepOrder: 11 },
  { types: ["dbl__c"], displayName: "DBL", stepOrder: 12 },
  { types: ["topline_tlf__c"], displayName: "Topline TLF", stepOrder: 13 },
  { types: ["final_tlf__c"], displayName: "Final TLF", stepOrder: 14 },
  { types: ["draft_csr__c"], displayName: "Draft CSR", stepOrder: 15 },
  { types: ["final_csr__c"], displayName: "Final CSR", stepOrder: 16 },
  { types: ["tmf_transfer__c"], displayName: "TMF Transfer", stepOrder: 17 },
  { types: ["financially_closed__c"], displayName: "Financially Closed", stepOrder: 18 }
];

const TYPE_TO_CANONICAL = new Map();
for (const def of CANONICAL_STUDY_MILESTONES) {
  for (const t of def.types) TYPE_TO_CANONICAL.set(t, def);
}

const ALL_CANONICAL_TYPES = [...TYPE_TO_CANONICAL.keys()];

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

function milestoneActualDate(m) {
  return milestoneSingleDayActualDate(m);
}

function parseDateMs(iso) {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  return Number.isFinite(t) ? t : null;
}

function daysBetween(fromIso, toIso) {
  const a = parseDateMs(fromIso);
  const b = parseDateMs(toIso);
  if (a == null || b == null) return null;
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

function isStudyLevelMilestone(row) {
  return row.site__v == null || row.site__v === "";
}

function studyMatchesFilter(study, { indication, aliases, related, studyNeedle }) {
  if (studyNeedle) {
    const blob = `${study.study_number || ""} ${study.study_name || ""} ${study.name || ""}`.toLowerCase();
    if (!blob.includes(studyNeedle.toLowerCase())) return false;
  }
  if (!indication) return true;
  const ind = study.indication || "_unknown";
  const { indicationCompatible, indicationAliases } = require("./intelligence");
  if (indicationCompatible(ind, indication, aliases || [])) return true;
  return (related || []).some((rel) =>
    indicationCompatible(ind, rel, indicationAliases(rel))
  );
}

/**
 * Build study milestone boards with step order + day intervals between consecutive steps.
 */
async function buildStudyMilestoneBoard(getDb, opts = {}) {
  const database = getDb();
  const limit = Math.min(Number(opts.limit) || 25, 50);
  const studyNeedle = String(opts.study || opts.studyQ || "").trim() || null;
  const indication = String(opts.indication || opts.q || "").trim() || null;
  const { indicationAliases, relatedIndicationLabels, preferredIndicationLabel } = require("./intelligence");
  const aliases = indication ? indicationAliases(indication) : [];
  const related = indication ? relatedIndicationLabels(indication) : [];
  const preferred = indication ? preferredIndicationLabel(indication) || indication : null;

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

  const studyById = new Map();
  for (const s of studyRows) {
    const name = String(s.study_name__v || s.name__v || "").toUpperCase();
    if (name.includes("TEST")) continue;
    const indicationLabel = vaultIndicationLabel(s.indication__v || s.indication__c);
    const row = {
      id: s.id,
      study_number: s.alternate_study_number__vs || s.name__v || s.id,
      study_name: s.study_name__v || s.name__v || null,
      sponsor:
        (s.sponsor__c && sponsorNameById.get(s.sponsor__c)) || s.sponsor_organization__v || null,
      indication: indicationLabel,
      phase: picklistLabel(s.study_phase__v),
      status: picklistLabel(s.status__v || s.study_status__v),
      enrollment: s.enrollment__vs != null ? Number(s.enrollment__vs) : null
    };
    if (!studyMatchesFilter(row, { indication: preferred, aliases, related, studyNeedle })) continue;
    studyById.set(s.id, row);
  }

  if (!studyById.size) {
    return {
      empty: true,
      studies: [],
      note: indication
        ? `No Veeva studies matched "${indication}".`
        : "No Veeva studies in Cosmos — run Ingest Veeva."
    };
  }

  const typeParams = ALL_CANONICAL_TYPES.map((t, i) => ({ name: `@t${i}`, value: t }));
  const typeClause = ALL_CANONICAL_TYPES.map((_, i) => `@t${i}`).join(", ");
  const msRows = await queryAll(
    database.container("ora_veeva_milestone"),
    `SELECT c.study__v, c.name__v, c.milestone_type__v, c.site__v,
            c.actual_finish_date__v, c.actual_start_date__v,
            c.planned_finish_date__v, c.planned_start_date__v
     FROM c WHERE c.docType = @doc
       AND c.milestone_type__v IN (${typeClause})
       AND (NOT IS_DEFINED(c.site__v) OR c.site__v = null)`,
    [{ name: "@doc", value: "ora_veeva_milestone" }, ...typeParams]
  );

  const byStudy = new Map();
  for (const m of msRows) {
    if (!isStudyLevelMilestone(m)) continue;
    if (!studyById.has(m.study__v)) continue;
    const canon = TYPE_TO_CANONICAL.get(m.milestone_type__v);
    if (!canon) continue;
    const actual = milestoneActualDate(m);
    if (!actual) continue;
    if (!byStudy.has(m.study__v)) byStudy.set(m.study__v, new Map());
    const bucket = byStudy.get(m.study__v);
    const key = canon.stepOrder;
    const prev = bucket.get(key);
    const whenMs = parseDateMs(actual);
    if (!prev || whenMs > parseDateMs(prev.actualDate)) {
      bucket.set(key, {
        stepOrder: canon.stepOrder,
        displayName: canon.displayName,
        milestoneType: m.milestone_type__v,
        milestoneName: m.name__v || null,
        actualDate: actual,
        plannedFinish: m.planned_finish_date__v || null,
        plannedStart: m.planned_start_date__v || null
      });
    }
  }

  const studies = [];
  for (const [studyId, stepMap] of byStudy.entries()) {
    const meta = studyById.get(studyId);
    if (!meta) continue;
    const milestones = [...stepMap.values()].sort((a, b) => a.stepOrder - b.stepOrder);
    if (milestones.length < 2) continue;

    const intervals = [];
    for (let i = 0; i < milestones.length - 1; i += 1) {
      const from = milestones[i];
      const to = milestones[i + 1];
      const days = daysBetween(from.actualDate, to.actualDate);
      if (days == null) continue;
      intervals.push({
        fromDisplay: from.displayName,
        toDisplay: to.displayName,
        fromOrder: from.stepOrder,
        toOrder: to.stepOrder,
        fromDate: from.actualDate,
        toDate: to.actualDate,
        days
      });
    }

    const last = milestones[milestones.length - 1];
    studies.push({
      ...meta,
      milestonesCompleted: milestones.length,
      lastCompleted: { displayName: last.displayName, date: last.actualDate },
      lastActivityMs: parseDateMs(last.actualDate) || 0,
      milestones,
      intervals
    });
  }

  studies.sort((a, b) => (b.lastActivityMs || 0) - (a.lastActivityMs || 0));
  const trimmed = studies.slice(0, limit).map(({ lastActivityMs, ...rest }) => rest);

  return {
    empty: !trimmed.length,
    indication: preferred || indication || null,
    studyFilter: studyNeedle,
    studies: trimmed,
    studyCount: trimmed.length,
    canonicalSteps: CANONICAL_STUDY_MILESTONES.map((m) => ({
      displayName: m.displayName,
      stepOrder: m.stepOrder
    })),
    note:
      "Study-level Veeva milestones only (no site/country rows). Intervals = days between consecutive actual finish/start dates in the canonical lifecycle order — same step list as Insights RM vw_veeva_milestones_calculations."
  };
}

module.exports = {
  CANONICAL_STUDY_MILESTONES,
  buildStudyMilestoneBoard
};
