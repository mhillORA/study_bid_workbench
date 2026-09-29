/**
 * Per-PM dashboard from ora_ns_study (+ optional Veeva join hints).
 * Groups active / open studies by project_manager for Ops and "my studies".
 */

const { matchStudyStaffRole, personNamesMatch, normalizePersonName } = require("./personMatch");

const STUDY_CONTAINER = "ora_ns_study";
const STUDY_DOC_TYPE = "ora_ns_study";

function isActiveStatus(status) {
  const s = String(status || "").toLowerCase().trim();
  if (!s) return true;
  if (/financ|closed|complete|cancelled|canceled|inactive|archived/.test(s)) {
    return false;
  }
  // Unknown / In Progress / Active / On Hold — still show on PM board
  return true;
}

function money(n) {
  if (n == null || n === "") return null;
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

function pct(n) {
  if (n == null || n === "") return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  // NetSuite sometimes stores 0–1, sometimes 0–100
  return v > 1 ? Math.round(v * 10) / 10 : Math.round(v * 1000) / 10;
}

async function queryAll(container, query, parameters = []) {
  const { resources } = await container.items
    .query({ query, parameters }, { enableCrossPartitionQuery: true })
    .fetchAll();
  return resources || [];
}

function studyCard(r, principal) {
  const role = matchStudyStaffRole(principal, r);
  return {
    project_number: r.project_number || "",
    project_name: r.project_name || "",
    project_status: r.project_status || "",
    project_manager: r.project_manager || "",
    project_director: r.project_director || "",
    service_line: r.service_line || "",
    study_dept: r.study_dept || null,
    study_year_full: r.study_year_full || null,
    percent_complete: pct(r.percent_complete),
    inv_fee_budget: money(r.inv_fee_budget),
    inv_fee_actual: money(r.inv_fee_actual),
    ptc_budget: money(r.ptc_budget),
    ptc_actual: money(r.ptc_actual),
    realization_rate: pct(r.realization_rate),
    start_date: r.start_date || null,
    calculated_end_date: r.calculated_end_date || null,
    mine: Boolean(role),
    my_role: role
  };
}

/**
 * @param {() => import("@azure/cosmos").Database} getDb
 * @param {{ principal?: object, pm?: string, activeOnly?: boolean, limit?: number }} [opts]
 */
async function buildPmDashboard(getDb, opts = {}) {
  const principal = opts.principal || null;
  const pmFilter = String(opts.pm || "").trim();
  const activeOnly = opts.activeOnly !== false;
  const limit = Math.min(Math.max(Number(opts.limit) || 800, 50), 2000);

  const database = getDb();
  let rows = [];
  try {
    rows = await queryAll(
      database.container(STUDY_CONTAINER),
      `SELECT TOP ${limit} c.project_number, c.project_name, c.project_manager, c.project_director,
        c.project_status, c.service_line, c.study_dept, c.study_year_full, c.percent_complete,
        c.inv_fee_budget, c.inv_fee_actual, c.ptc_budget, c.ptc_actual, c.realization_rate,
        c.start_date, c.calculated_end_date
       FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: STUDY_DOC_TYPE }]
    );
  } catch (err) {
    return {
      ok: false,
      error: String(err.message || err),
      pms: [],
      selected: null,
      mine: null,
      study_count: 0
    };
  }

  const studies = rows
    .map((r) => studyCard(r, principal))
    .filter((r) => (activeOnly ? isActiveStatus(r.project_status) : true));

  const byPm = new Map();
  for (const s of studies) {
    const key = String(s.project_manager || "").trim() || "(unassigned)";
    if (!byPm.has(key)) {
      byPm.set(key, {
        name: key,
        study_count: 0,
        active_count: 0,
        inv_fee_budget: 0,
        inv_fee_actual: 0,
        ptc_budget: 0,
        ptc_actual: 0,
        depts: new Set(),
        studies: []
      });
    }
    const g = byPm.get(key);
    g.study_count += 1;
    if (isActiveStatus(s.project_status)) g.active_count += 1;
    g.inv_fee_budget += s.inv_fee_budget || 0;
    g.inv_fee_actual += s.inv_fee_actual || 0;
    g.ptc_budget += s.ptc_budget || 0;
    g.ptc_actual += s.ptc_actual || 0;
    if (s.study_dept) g.depts.add(String(s.study_dept));
    g.studies.push(s);
  }

  const pms = [...byPm.values()]
    .map((g) => {
      g.studies.sort((a, b) => {
        const ap = a.percent_complete == null ? -1 : a.percent_complete;
        const bp = b.percent_complete == null ? -1 : b.percent_complete;
        return bp - ap;
      });
      return {
        name: g.name,
        study_count: g.study_count,
        active_count: g.active_count,
        inv_fee_budget: money(g.inv_fee_budget),
        inv_fee_actual: money(g.inv_fee_actual),
        ptc_budget: money(g.ptc_budget),
        ptc_actual: money(g.ptc_actual),
        depts: [...g.depts].sort(),
        studies: g.studies,
        is_viewer:
          Boolean(principal) &&
          g.name !== "(unassigned)" &&
          personNamesMatch(principal, g.name)
      };
    })
    .sort((a, b) => {
      if (a.is_viewer !== b.is_viewer) return a.is_viewer ? -1 : 1;
      return b.active_count - a.active_count || a.name.localeCompare(b.name);
    });

  let selected = null;
  if (pmFilter) {
    selected =
      pms.find((p) => normalizePersonName(p.name) === normalizePersonName(pmFilter)) ||
      pms.find((p) => personNamesMatch(pmFilter, p.name)) ||
      null;
  } else {
    selected = pms.find((p) => p.is_viewer) || null;
  }

  const mineStudies = studies.filter((s) => s.mine);
  const mine = principal
    ? {
        viewer_name: principal.displayName || principal.email || null,
        study_count: mineStudies.length,
        studies: mineStudies.sort((a, b) =>
          String(a.project_number).localeCompare(String(b.project_number))
        )
      }
    : null;

  return {
    ok: true,
    active_only: activeOnly,
    study_count: studies.length,
    pm_count: pms.length,
    viewer_name: principal?.displayName || principal?.email || null,
    mine,
    selected: selected
      ? {
          name: selected.name,
          study_count: selected.study_count,
          active_count: selected.active_count,
          inv_fee_budget: selected.inv_fee_budget,
          inv_fee_actual: selected.inv_fee_actual,
          ptc_budget: selected.ptc_budget,
          ptc_actual: selected.ptc_actual,
          depts: selected.depts,
          is_viewer: selected.is_viewer,
          studies: selected.studies
        }
      : null,
    pms: pms.map((p) => ({
      name: p.name,
      study_count: p.study_count,
      active_count: p.active_count,
      inv_fee_budget: p.inv_fee_budget,
      inv_fee_actual: p.inv_fee_actual,
      ptc_budget: p.ptc_budget,
      ptc_actual: p.ptc_actual,
      depts: p.depts,
      is_viewer: p.is_viewer
    })),
    note:
      "Active studies from ora_ns_study grouped by NetSuite project_manager. Sign in to pin your PM row via Entra name match."
  };
}

module.exports = {
  buildPmDashboard,
  isActiveStatus
};
