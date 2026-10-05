/**
 * NetSuite study intel pull — Buddy-owned, 1:1 with netsuite-pull-excel-v2/runs.py
 * build_study_cosmos_pack + SuiteQL domains (Cosmos primary).
 */

const {
  getNetSuiteAccessToken,
  suiteqlAll,
  netsuiteConfig,
  notConfiguredPayload
} = require("./netsuiteClient");
const {
  upsertNetSuiteStudyIntel,
  getNetSuiteStudySyncStatus,
  readSyncState,
  writeSyncState
} = require("./netsuiteStudySync");

// Function App timeout is 60m — leave headroom for upsert.
const TIME_BUDGET_MS = Number(process.env.NS_STUDY_PULL_BUDGET_MS || 170000);
const STUDY_PREFIX = String(process.env.STUDY_NUMBER_PREFIX || "2").trim() || "2";
const CHUNK = Number(process.env.NS_STUDY_ID_CHUNK || 40);
const BATCH_PROJECTS = Number(process.env.NS_STUDY_BATCH || 12);

function num(v) {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowGet(row, key) {
  if (!row) return null;
  if (row[key] != null) return row[key];
  const want = String(key).toLowerCase();
  for (const [k, v] of Object.entries(row)) {
    if (String(k).toLowerCase() === want) return v;
  }
  return null;
}

function normId(v) {
  if (v == null || v === "") return "";
  return String(v).trim();
}

function shortProjectNumber(project) {
  const acct = String(rowGet(project, "project_accountnumber") || "").trim();
  if (acct) return acct;
  const entity = String(rowGet(project, "project_number") || "").trim();
  if (entity) return entity.split(/\s+/)[0];
  return "";
}

function isMilestone(task) {
  const f = rowGet(task, "is_milestone");
  if (f === true || f === 1) return true;
  const s = String(f == null ? "" : f)
    .trim()
    .toUpperCase();
  return s === "T" || s === "TRUE" || s === "YES" || s === "1" || s === "Y";
}

function currentBudgetHours(task) {
  return num(rowGet(task, "budgeted_hours"));
}

function nsBudgetHours(task) {
  const orig = num(rowGet(task, "original_budget_hours"));
  if (orig > 0) return orig;
  return currentBudgetHours(task);
}

function remainingHours(bud, act, etc) {
  return bud - (act + etc);
}

const VISIT_TYPE_MAP = [
  ["study visit away", "Study Visit"],
  ["cra - imv on-site", "Study Visit"],
  ["cra - imv remote", "Study Visit"],
  ["cra - siv on-site", "Study Visit"],
  ["cra - sqv on-site", "Study Visit"],
  ["cra - sev on-site", "Study Visit"],
  ["cra - cov on-site", "Study Visit"],
  ["study visit follow-up", "Follow-up"],
  ["cra - visit report/follow-up", "Follow-up"],
  ["cra - report", "Follow-up"],
  ["lcra - report review/approval", "Follow-up"],
  ["study visit prep", "Prep"],
  ["cra - visit prep/admin", "Prep"],
  ["cra - prep/admin", "Prep"],
  ["study visit travel", "Travel"],
  ["cra/lcra - monitoring visit travel", "Travel"],
  ["cra/lcra - visit travel", "Travel"]
];

function mapVisitType(taskName) {
  if (!taskName) return null;
  const tn = String(taskName).trim().toLowerCase();
  for (const [key, vtype] of VISIT_TYPE_MAP) {
    if (tn.includes(key)) return vtype;
  }
  if (tn.includes("visit") && tn.includes("travel")) return "Travel";
  if (tn.includes("visit") && (tn.includes("prep") || tn.includes("admin"))) return "Prep";
  if (tn.includes("visit") && (tn.includes("report") || tn.includes("follow"))) return "Follow-up";
  if (
    tn.includes("visit") &&
    (tn.includes("imv") ||
      tn.includes("siv") ||
      tn.includes("sqv") ||
      tn.includes("sev") ||
      tn.includes("cov") ||
      tn.includes("away"))
  ) {
    return "Study Visit";
  }
  return null;
}

function computeElapsedPct(project) {
  try {
    const sd = rowGet(project, "start_date");
    const ed = rowGet(project, "calculated_end_date");
    if (!sd || !ed) return null;
    const parse = (v) => {
      const s = String(v);
      if (s.includes("/")) {
        const [m, d, y] = s.split("/");
        return new Date(Number(y), Number(m) - 1, Number(d));
      }
      return new Date(s.slice(0, 10));
    };
    const start = parse(sd);
    const end = parse(ed);
    const today = new Date();
    const total = Math.max(1, (end - start) / 86400000);
    const elapsed = Math.min((today - start) / 86400000, total);
    return Math.max(0, Math.min(elapsed / total, 1));
  } catch (_) {
    return null;
  }
}

function regionFromServiceLine(sline) {
  const s = String(sline || "");
  if (s.includes("-US") || s.includes("Ops-US")) return "US";
  if (s.includes("-EU") || s.includes("Ops-EU")) return "EU";
  if (s.includes("-APAC") || s.includes("Ops-APAC")) return "APAC";
  if (s.includes("-LATAM") || s.includes("Ops-LATAM")) return "LATAM";
  if (s.includes("China")) return "China";
  if (s.includes("(AU)")) return "AU";
  return "Unknown";
}

function activeStudyWhere(extra = "") {
  return (
    `BUILTIN.DF(j.entitystatus) = 'In Progress' AND ` +
    `NVL(j.accountnumber, j.entityid) LIKE '${STUDY_PREFIX}%'` +
    (extra ? ` AND ${extra}` : "")
  );
}

function sqlProjects(projectNumber = null) {
  let filter = activeStudyWhere();
  if (projectNumber) {
    const pn = String(projectNumber).replace(/'/g, "''");
    filter = `(j.accountnumber = '${pn}' OR j.entityid LIKE '${pn} %' OR j.entityid = '${pn}')`;
  }
  return (
    "SELECT " +
    "j.id AS project_id, " +
    "j.entityid AS project_number, " +
    "j.accountnumber AS project_accountnumber, " +
    "j.companyname AS project_name, " +
    "BUILTIN.DF(j.projectmanager) AS project_manager, " +
    "BUILTIN.DF(j.custentity5) AS project_manager_alt, " +
    "BUILTIN.DF(j.custentity3) AS service_line, " +
    "BUILTIN.DF(j.entitystatus) AS project_status, " +
    "j.startdate AS start_date, " +
    "j.calculatedenddate AS calculated_end_date, " +
    "j.custentity_nsacs_ptc_budget AS ptc_budget, " +
    "j.custentity_nsacs_inv_budget AS investigator_fee_budget " +
    "FROM job j " +
    `WHERE ${filter}`
  );
}

/** Exact templates from netsuite-pull-excel-v2/runs.py */
function sqlTasksByIds(idsCsv) {
  return (
    "SELECT " +
    "t.id AS task_id, " +
    "t.project AS project_id, " +
    "j.entityid AS project_number, " +
    "t.title AS task_name, " +
    "BUILTIN.DF(t.id) AS task_name_df, " +
    "t.ismilestone AS is_milestone, " +
    "t.status AS task_status, " +
    "t.estimatedwork AS budgeted_hours, " +
    "t.custevent1 AS estimate_to_complete_hours, " +
    "t.custevent_ora_acs_original_budget AS original_budget_hours, " +
    "t.actualwork AS ns_actual_hours, " +
    "t.enddate AS estimated_completion_date, " +
    "t.custevent_amount_projectmilestone AS milestone_amount " +
    "FROM projecttask t " +
    "JOIN job j ON j.id = t.project " +
    `WHERE t.project IN (${idsCsv})`
  );
}

function sqlActualsByIds(idsCsv) {
  return (
    "SELECT " +
    "tb.casetaskevent AS task_id, " +
    "j.id AS project_id, " +
    "j.entityid AS project_number, " +
    "tb.employee AS employee_id, " +
    "BUILTIN.DF(tb.employee) AS employee_name, " +
    "e.title AS job_title, " +
    "BUILTIN.DF(tb.billingclass) AS billing_class, " +
    "SUM(tb.hours) AS actual_hours, " +
    "SUM(tb.laborcost) AS actual_cost " +
    "FROM timebill tb " +
    "JOIN projecttask t ON t.id = tb.casetaskevent " +
    "JOIN job j ON j.id = t.project " +
    "JOIN employee e ON e.id = tb.employee " +
    `WHERE t.project IN (${idsCsv}) ` +
    "AND tb.approvalstatus = 3 " +
    "GROUP BY tb.casetaskevent, j.id, j.entityid, tb.employee, " +
    "BUILTIN.DF(tb.employee), e.title, BUILTIN.DF(tb.billingclass)"
  );
}

function sqlBillingByIds(idsCsv) {
  return (
    "SELECT " +
    "j.id AS project_id, " +
    "j.entityid AS project_number, " +
    "SUM(CASE WHEN tr.type = 'CustInvc' THEN -tl.netamount ELSE 0 END) AS invoiced_amount, " +
    "SUM(CASE WHEN a.accttype = 'Income' THEN -tl.netamount ELSE 0 END) AS revenue_recognized, " +
    "SUM(CASE WHEN a.accttype = 'COGS' THEN tl.netamount ELSE 0 END) AS cost_of_sales " +
    "FROM transactionline tl " +
    "JOIN transaction tr ON tr.id = tl.transaction " +
    "JOIN job j ON j.id = tl.entity " +
    "LEFT JOIN account a ON a.id = tl.account " +
    `WHERE j.id IN (${idsCsv}) ` +
    "GROUP BY j.id, j.entityid"
  );
}

function sqlCostDetailByIds(idsCsv) {
  return (
    "SELECT " +
    "j.id AS project_id, " +
    "j.entityid AS project_number, " +
    "a.accttype AS account_type, " +
    "a.acctnumber AS account_number, " +
    "a.fullname AS account_name, " +
    "SUM(tl.netamount) AS amount " +
    "FROM transactionline tl " +
    "JOIN transaction tr ON tr.id = tl.transaction " +
    "JOIN job j ON j.id = tl.entity " +
    "JOIN account a ON a.id = tl.account " +
    `WHERE j.id IN (${idsCsv}) ` +
    "AND a.accttype = 'COGS' " +
    "GROUP BY j.id, j.entityid, a.accttype, a.acctnumber, a.fullname"
  );
}

function sqlPctHistoryByIds(idsCsv) {
  return (
    "SELECT " +
    "pco.project AS project_id, " +
    "BUILTIN.DF(pco.period) AS period_name, " +
    "pco.period AS period_id, " +
    "pco.percent AS submitted_pct_complete, " +
    "pco.calculatedpercentcomplete AS calculated_pct_complete, " +
    "pco.revenueplans AS revenue_recognized, " +
    "pco.comments AS comments " +
    "FROM percentcompleteoverride pco " +
    `WHERE pco.project IN (${idsCsv}) ` +
    "ORDER BY pco.project, pco.period"
  );
}

function sqlMonthlyTimeByIds(idsCsv) {
  return (
    "SELECT " +
    "t.project AS project_id, " +
    "j.entityid AS project_number, " +
    "TO_CHAR(tb.trandate, 'YYYY-MM') AS period, " +
    "tb.casetaskevent AS task_id, " +
    "t.title AS task_name, " +
    "tb.employee AS employee_id, " +
    "BUILTIN.DF(tb.employee) AS employee_name, " +
    "e.title AS job_title, " +
    "BUILTIN.DF(tb.custcol_nsacs_site) AS site_name, " +
    "SUM(tb.hours) AS hours, " +
    "SUM(tb.laborcost) AS cost " +
    "FROM timebill tb " +
    "JOIN projecttask t ON t.id = tb.casetaskevent " +
    "JOIN job j ON j.id = t.project " +
    "JOIN employee e ON e.id = tb.employee " +
    `WHERE t.project IN (${idsCsv}) ` +
    "AND tb.approvalstatus = 3 " +
    "GROUP BY t.project, j.entityid, TO_CHAR(tb.trandate, 'YYYY-MM'), " +
    "tb.casetaskevent, t.title, tb.employee, BUILTIN.DF(tb.employee), e.title, " +
    "BUILTIN.DF(tb.custcol_nsacs_site)"
  );
}

const SQL_PERIOD_STATUS =
  "SELECT BUILTIN.DF(t.postingperiod) AS period_name, " +
  "t.postingperiod AS period_id, " +
  "COUNT(*) AS rev_rec_journals " +
  "FROM transaction t " +
  "JOIN transactionline tl ON tl.transaction = t.id " +
  "JOIN account a ON a.id = tl.account " +
  "WHERE t.type = 'Journal' AND a.accttype = 'Income' " +
  "GROUP BY BUILTIN.DF(t.postingperiod), t.postingperiod " +
  "ORDER BY t.postingperiod DESC " +
  "FETCH FIRST 2 ROWS ONLY";

function normalizeTaskRow(row, pid = null) {
  const out = { ...row };
  if (pid) out.project_id = pid;
  else if (rowGet(out, "project_id") != null) out.project_id = normId(rowGet(out, "project_id"));
  const name = rowGet(out, "task_name") || rowGet(out, "task_name_df");
  if (name) out.task_name = String(name).trim();
  out.budgeted_hours = num(rowGet(out, "budgeted_hours"));
  out.original_budget_hours = num(rowGet(out, "original_budget_hours"));
  out.estimate_to_complete_hours = num(rowGet(out, "estimate_to_complete_hours"));
  if (rowGet(out, "ns_actual_hours") != null) {
    out.ns_actual_hours = num(rowGet(out, "ns_actual_hours"));
  }
  out.task_id = normId(rowGet(out, "task_id"));
  return out;
}

function indexByProject(rows) {
  const byId = new Map();
  const byNum = new Map();
  for (const row of rows || []) {
    const pid = normId(rowGet(row, "project_id"));
    const pnum = String(rowGet(row, "project_number") || "").trim();
    if (pid) {
      if (!byId.has(pid)) byId.set(pid, []);
      byId.get(pid).push(row);
    }
    if (pnum) {
      const key = pnum.split(/\s+/)[0];
      if (!byNum.has(key)) byNum.set(key, []);
      byNum.get(key).push(row);
    }
  }
  return { byId, byNum };
}

function rowsForProject(project, byId, byNum) {
  const pid = normId(rowGet(project, "project_id"));
  if (pid && byId.has(pid)) return byId.get(pid);
  const pn = shortProjectNumber(project);
  if (pn && byNum.has(pn)) return byNum.get(pn);
  return [];
}

/**
 * Same formulas/categories as Excel / runs.py build_study_cosmos_pack.
 */
function buildStudyCosmosPack(
  project,
  tasks,
  actuals,
  costDetail,
  billing,
  monthlyTime,
  periodWarning = null,
  pctHistory = null
) {
  const taskActual = new Map();
  const taskCost = new Map();
  for (const a of actuals || []) {
    const tid = normId(rowGet(a, "task_id"));
    taskActual.set(tid, (taskActual.get(tid) || 0) + num(rowGet(a, "actual_hours")));
    taskCost.set(tid, (taskCost.get(tid) || 0) + num(rowGet(a, "actual_cost")));
  }
  for (const t of tasks || []) {
    const tid = normId(rowGet(t, "task_id"));
    t.actual_hours_on_task = taskActual.has(tid)
      ? taskActual.get(tid)
      : num(rowGet(t, "actual_hours_on_task"));
  }

  const nonMs = (tasks || []).filter((t) => !isMilestone(t));
  const totalBudgetSow = nonMs.reduce((s, t) => s + nsBudgetHours(t), 0);
  const totalBudgetCur = nonMs.reduce((s, t) => s + currentBudgetHours(t), 0);
  let totalActual = 0;
  for (const v of taskActual.values()) totalActual += v;
  if (!totalActual) {
    totalActual = (tasks || []).reduce((s, t) => s + num(rowGet(t, "actual_hours_on_task")), 0);
  }
  const totalEtc = nonMs.reduce((s, t) => s + num(rowGet(t, "estimate_to_complete_hours")), 0);
  const totalProjected = totalActual + totalEtc;
  let totalActualCost = 0;
  for (const v of taskCost.values()) totalActualCost += v;
  const realization = totalProjected ? totalBudgetSow / totalProjected : null;
  const pctNs = totalProjected ? totalActual / totalProjected : null;
  const pctVsBudget = totalBudgetSow ? totalActual / totalBudgetSow : null;
  const budgetRemaining =
    totalBudgetSow || totalActual ? Math.round((totalBudgetSow - totalActual) * 10) / 10 : null;
  const qtlRemaining = Math.round((totalBudgetCur - totalProjected) * 10) / 10;
  const avgRate = totalActual ? totalActualCost / totalActual : 0;
  const elapsedPct = computeElapsedPct(project);

  const ptcCategories = {};
  let laborTotal = 0;
  let travelTotal = 0;
  for (const cd of costDetail || []) {
    const acct = String(rowGet(cd, "account_name") || "");
    const amt = num(rowGet(cd, "amount"));
    if (acct.includes("Pass Through") || acct.includes("PTC")) {
      const parts = acct.split(":");
      let cat = parts[parts.length - 1]
        .trim()
        .replace("COS - PTC", "")
        .replace("COS -", "")
        .trim()
        .replace(/^:+|:+$/g, "")
        .trim();
      if (!cat) cat = "Other PTC";
      ptcCategories[cat] = (ptcCategories[cat] || 0) + amt;
    } else if (acct.includes("Payroll")) {
      laborTotal += amt;
    } else if (acct.includes("Travel") && !acct.includes("PTC")) {
      travelTotal += amt;
    }
  }
  const ptcActual = Object.keys(ptcCategories).length
    ? Object.values(ptcCategories).reduce((a, b) => a + b, 0)
    : null;
  let invFeeActual = ptcCategories["Investigator Compensation"];
  if (invFeeActual != null) invFeeActual = Math.round(invFeeActual * 100) / 100;
  const ptcCatCompact = Object.fromEntries(
    Object.entries(ptcCategories)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 20)
      .map(([k, v]) => [k, Math.round(v * 100) / 100])
  );

  const vtBudget = {};
  const vtOrig = {};
  const vtEtc = {};
  const vtActual = {};
  const vtCost = {};
  const taskVisit = {};
  for (const t of nonMs) {
    const vtype = mapVisitType(rowGet(t, "task_name"));
    if (!vtype) continue;
    const tid = normId(rowGet(t, "task_id"));
    taskVisit[tid] = vtype;
    vtBudget[vtype] = (vtBudget[vtype] || 0) + num(rowGet(t, "budgeted_hours"));
    vtOrig[vtype] = (vtOrig[vtype] || 0) + num(rowGet(t, "original_budget_hours"));
    vtEtc[vtype] = (vtEtc[vtype] || 0) + num(rowGet(t, "estimate_to_complete_hours"));
  }
  for (const a of actuals || []) {
    const tid = normId(rowGet(a, "task_id"));
    const vtype = taskVisit[tid];
    if (!vtype) continue;
    vtActual[vtype] = (vtActual[vtype] || 0) + num(rowGet(a, "actual_hours"));
    vtCost[vtype] = (vtCost[vtype] || 0) + num(rowGet(a, "actual_cost"));
  }
  const region = regionFromServiceLine(rowGet(project, "service_line"));
  const visitTypes = ["Study Visit", "Prep", "Follow-up", "Travel"].map((vtype) => {
    const orig = vtOrig[vtype] || 0;
    const cur = vtBudget[vtype] || 0;
    const act = vtActual[vtype] || 0;
    const etc = vtEtc[vtype] || 0;
    const plan = orig > 0 ? orig : cur;
    const proj = act + etc;
    const expected =
      elapsedPct != null && plan ? Math.round(plan * elapsedPct * 10) / 10 : null;
    return {
      visit_type: vtype,
      region,
      original_budget_hrs: Math.round(orig * 10) / 10,
      current_budget_hrs: Math.round(cur * 10) / 10,
      actual_hours: Math.round(act * 10) / 10,
      estimate_to_complete: Math.round(etc * 10) / 10,
      total_projected: Math.round(proj * 10) / 10,
      expected_hours_to_date: expected,
      vs_expected_hrs: expected != null ? Math.round((expected - act) * 10) / 10 : null,
      pct_of_budget: plan ? Math.round((act / plan) * 10000) / 10000 : null,
      pct_complete_ns: proj ? Math.round((act / proj) * 10000) / 10000 : null,
      actual_cost: Math.round((vtCost[vtype] || 0) * 100) / 100
    };
  });

  const hoursByMonthMap = {};
  for (const mt of monthlyTime || []) {
    const period = String(rowGet(mt, "period") || "");
    if (!period) continue;
    if (!hoursByMonthMap[period]) hoursByMonthMap[period] = { hours: 0, cost: 0 };
    hoursByMonthMap[period].hours += num(rowGet(mt, "hours"));
    hoursByMonthMap[period].cost += num(rowGet(mt, "cost"));
  }
  const hoursByMonth = Object.keys(hoursByMonthMap)
    .sort()
    .map((p) => ({
      period: p,
      hours: Math.round(hoursByMonthMap[p].hours * 10) / 10,
      cost: Math.round(hoursByMonthMap[p].cost * 100) / 100
    }));

  const pctCompleteHistory = (pctHistory || [])
    .slice()
    .sort((a, b) => num(rowGet(a, "period_id")) - num(rowGet(b, "period_id")))
    .map((h) => ({
      period_id: rowGet(h, "period_id"),
      period_name: rowGet(h, "period_name"),
      submitted_pct_complete: numOrNull(rowGet(h, "submitted_pct_complete")),
      calculated_pct_complete: numOrNull(rowGet(h, "calculated_pct_complete")),
      revenue_recognized: numOrNull(rowGet(h, "revenue_recognized")),
      comments: rowGet(h, "comments") || null
    }));

  const pn = shortProjectNumber(project) || rowGet(project, "project_number");
  const inv = billing ? numOrNull(rowGet(billing, "invoiced_amount")) : null;
  const rev = billing ? numOrNull(rowGet(billing, "revenue_recognized")) : null;
  const cogs = billing ? numOrNull(rowGet(billing, "cost_of_sales")) : null;
  const gp = billing && (rev != null || cogs != null) ? (rev || 0) - (cogs || 0) : null;
  const gm = rev ? Math.round((gp / rev) * 10000) / 10000 : null;
  const atRisk = nonMs.filter((t) => {
    const tid = normId(rowGet(t, "task_id"));
    return (
      remainingHours(
        currentBudgetHours(t),
        taskActual.get(tid) || num(t.actual_hours_on_task),
        num(rowGet(t, "estimate_to_complete_hours"))
      ) < 0
    );
  }).length;

  const study = {
    project_number: pn,
    project_name: rowGet(project, "project_name"),
    project_manager: rowGet(project, "project_manager") || rowGet(project, "project_manager_alt"),
    service_line: rowGet(project, "service_line"),
    project_status: rowGet(project, "project_status"),
    start_date: rowGet(project, "start_date"),
    calculated_end_date: rowGet(project, "calculated_end_date"),
    region,
    total_budgeted: Math.round(totalBudgetSow * 10) / 10,
    total_budgeted_current: Math.round(totalBudgetCur * 10) / 10,
    total_actual: Math.round(totalActual * 10) / 10,
    total_etc: Math.round(totalEtc * 10) / 10,
    total_projected: Math.round(totalProjected * 10) / 10,
    budget_remaining_hours: budgetRemaining,
    remaining_hours: qtlRemaining,
    at_risk_task_count: atRisk,
    realization_rate: realization != null ? Math.round(realization * 10000) / 10000 : null,
    percent_complete: pctNs != null ? Math.round(pctNs * 10000) / 10000 : null,
    percent_complete_vs_budget: pctVsBudget != null ? Math.round(pctVsBudget * 10000) / 10000 : null,
    elapsed_pct: elapsedPct != null ? Math.round(elapsedPct * 10000) / 10000 : null,
    avg_labor_rate: avgRate ? Math.round(avgRate * 100) / 100 : null,
    inv_fee_budget: numOrNull(rowGet(project, "investigator_fee_budget")),
    inv_fee_actual: invFeeActual,
    ptc_budget: numOrNull(rowGet(project, "ptc_budget")),
    ptc_actual: ptcActual != null ? Math.round(ptcActual * 100) / 100 : null,
    oopc_labor_actual: laborTotal ? Math.round(laborTotal * 100) / 100 : null,
    oopc_travel_actual: travelTotal ? Math.round(travelTotal * 100) / 100 : null,
    ptc_categories: Object.keys(ptcCatCompact).length ? ptcCatCompact : null,
    visit_types: visitTypes,
    hours_by_month: hoursByMonth.length ? hoursByMonth : null,
    pct_complete_history: pctCompleteHistory.length ? pctCompleteHistory : null,
    invoiced_amount: inv,
    revenue_recognized: rev,
    cost_of_sales: cogs,
    gross_profit: gp,
    gross_margin_pct: gm,
    period_warning: periodWarning || null,
    workbook_blob: null,
    formulas: {
      budgeted: "original SOW when set else estimatedwork (non-milestone)",
      budget_remaining: "budgeted − actual (projection baseline)",
      qtl_remaining: "current CO budget − (actual + ETC)",
      percent_complete_ns: "actual ÷ (actual + ETC)",
      percent_complete_vs_budget: "actual ÷ budgeted",
      expected_hours_to_date: "budgeted × elapsed calendar %",
      ptc_categories: "COS Pass Through account name rollup",
      visit_types: "task name → Study Visit / Prep / Follow-up / Travel",
      hours_by_month: "approved timebill hours by YYYY-MM",
      pct_complete_history: "percentcompleteoverride by accounting period"
    }
  };

  const taskPayloads = (tasks || [])
    .map((t) => {
      const isMs = isMilestone(t);
      const tid = normId(rowGet(t, "task_id"));
      const bud = currentBudgetHours(t);
      const sow = nsBudgetHours(t);
      const plan = sow > 0 ? sow : bud;
      const act = taskActual.get(tid) || num(t.actual_hours_on_task);
      const etc = num(rowGet(t, "estimate_to_complete_hours"));
      const proj = act + etc;
      const expected =
        elapsedPct != null && plan && !isMs ? Math.round(plan * elapsedPct * 10) / 10 : null;
      return {
        project_number: pn,
        task_id: rowGet(t, "task_id"),
        task_name: rowGet(t, "task_name"),
        task_status: rowGet(t, "task_status"),
        is_milestone: isMs,
        milestone_amount: numOrNull(rowGet(t, "milestone_amount")),
        budgeted_hours: bud,
        original_budget_hours: numOrNull(rowGet(t, "original_budget_hours")),
        current_budget_hrs: bud,
        actual_hours: act,
        estimate_to_complete_hours: etc,
        total_projected: isMs ? null : proj,
        remaining_hours: isMs ? null : remainingHours(bud, act, etc),
        percent_complete: !isMs && proj ? Math.round((act / proj) * 10000) / 10000 : null,
        pct_of_budget: !isMs && plan ? Math.round((act / plan) * 10000) / 10000 : null,
        expected_hours_to_date: expected,
        vs_expected_hrs: expected != null ? Math.round((expected - act) * 10) / 10 : null,
        visit_type: taskVisit[tid] || null,
        actual_cost: isMs ? null : Math.round((taskCost.get(tid) || 0) * 100) / 100
      };
    })
    .sort((a, b) => {
      if (a.is_milestone !== b.is_milestone) return a.is_milestone ? -1 : 1;
      const am = a.milestone_amount != null ? 0 : 1;
      const bm = b.milestone_amount != null ? 0 : 1;
      if (am !== bm) return am - bm;
      return String(a.task_name || "").localeCompare(String(b.task_name || ""));
    })
    .slice(0, 250);

  return { study, tasks: taskPayloads };
}

async function chunkedPull(token, cfg, projectIds, sqlFn, label, chunkSize = CHUNK, warnings) {
  const all = [];
  for (let i = 0; i < projectIds.length; i += chunkSize) {
    const chunk = projectIds.slice(i, i + chunkSize);
    const idsCsv = chunk.join(",");
    try {
      const rows = await suiteqlAll(token, cfg, sqlFn(idsCsv), {
        label: `${label}_${i}`
      });
      all.push(...rows);
    } catch (err) {
      const msg = `${label}_${i}: ${String(err.message || err)}`;
      if (warnings) warnings.push(msg);
      else throw err;
    }
  }
  return all;
}

async function resolvePeriodWarning(token, cfg) {
  try {
    const periods = await suiteqlAll(token, cfg, SQL_PERIOD_STATUS, {
      label: "period_status",
      pageSize: 10
    });
    if (!periods.length) return null;
    const closedName = String(rowGet(periods[0], "period_name") || "");
    const currentMonth = new Date().toLocaleString("en-US", {
      month: "short",
      year: "numeric"
    });
    if (!closedName.includes(currentMonth)) {
      return (
        `Current period (${currentMonth}) has not been closed — latest closed: ${closedName}. ` +
        "Financial data may be preliminary."
      );
    }
    return null;
  } catch (_) {
    return "Unable to verify period closure status";
  }
}

/**
 * Pull SuiteQL study intel into Cosmos — job-parity packs.
 * Batched under App Gateway ~230s limit; auto-resume via syncState.resumeOffset.
 */
async function runNetSuiteStudyPull(getDb, opts = {}) {
  const cfgCheck = netsuiteConfig();
  if (!cfgCheck.configured) return notConfiguredPayload();

  const started = Date.now();
  const projectNumber = opts.projectNumber ? String(opts.projectNumber).trim() : null;
  const triggeredBy = opts.triggeredBy || "buddy_api";
  const warnings = [];
  const database = getDb();

  let tokenPack;
  try {
    tokenPack = await getNetSuiteAccessToken();
  } catch (err) {
    return { ok: false, configured: true, error: String(err.message || err) };
  }
  const { accessToken, cfg } = tokenPack;

  let projects;
  try {
    projects = await suiteqlAll(accessToken, cfg, sqlProjects(projectNumber), {
      label: "study_projects"
    });
  } catch (err) {
    return { ok: false, configured: true, error: `projects: ${String(err.message || err)}` };
  }

  if (!projects.length) {
    return {
      ok: true,
      configured: true,
      studiesUpserted: 0,
      tasksUpserted: 0,
      projectsFound: 0,
      note: projectNumber
        ? `No NetSuite job matched ${projectNumber}`
        : `No In Progress studies with prefix ${STUDY_PREFIX}%`
    };
  }

  const prev = (await readSyncState(database)) || {};
  let offset = 0;
  if (!projectNumber) {
    if (opts.resume === true || opts._asyncKick === true) {
      offset = Number(prev.resumeOffset || 0) || 0;
    } else if (opts.restart === true || opts.full === true) {
      offset = 0;
    } else if (Number(prev.resumeOffset) > 0 && Number(prev.resumeOffset) < projects.length) {
      offset = Number(prev.resumeOffset);
    }
  }
  if (offset >= projects.length) offset = 0;

  const periodWarning = await resolvePeriodWarning(accessToken, cfg);

  let studyUpserted = 0;
  let taskUpserted = 0;
  let processed = 0;
  let incomplete = false;
  const sample = [];
  const domainTotals = {
    tasks: 0,
    actuals: 0,
    billing: 0,
    cost: 0,
    pct_history: 0,
    monthly: 0
  };

  for (let i = offset; i < projects.length; i += BATCH_PROJECTS) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      incomplete = true;
      offset = i;
      break;
    }

    const projChunk = projects.slice(i, i + BATCH_PROJECTS);
    const idChunk = projChunk.map((p) => normId(rowGet(p, "project_id"))).filter(Boolean);

    let allTasks = [];
    try {
      allTasks = (
        await chunkedPull(accessToken, cfg, idChunk, sqlTasksByIds, "tasks", CHUNK, null)
      ).map((r) => normalizeTaskRow(r));
    } catch (err) {
      warnings.push(`tasks@${i}: ${String(err.message || err)}`);
      // don't abort whole sync — skip this batch
      continue;
    }

    const soft = true;
    const [actualRows, billingRows, costRows, pctRows, monthRows] = await Promise.all([
      chunkedPull(accessToken, cfg, idChunk, sqlActualsByIds, "actuals", CHUNK, soft ? warnings : null),
      chunkedPull(accessToken, cfg, idChunk, sqlBillingByIds, "billing", 10, soft ? warnings : null),
      chunkedPull(accessToken, cfg, idChunk, sqlCostDetailByIds, "cost", 10, soft ? warnings : null),
      chunkedPull(accessToken, cfg, idChunk, sqlPctHistoryByIds, "pct_history", CHUNK, soft ? warnings : null),
      chunkedPull(accessToken, cfg, idChunk, sqlMonthlyTimeByIds, "monthly", 12, soft ? warnings : null)
    ]);

    domainTotals.tasks += allTasks.length;
    domainTotals.actuals += actualRows.length;
    domainTotals.billing += billingRows.length;
    domainTotals.cost += costRows.length;
    domainTotals.pct_history += pctRows.length;
    domainTotals.monthly += monthRows.length;

    const tasksIdx = indexByProject(allTasks);
    const actualsIdx = indexByProject(actualRows);
    const billingIdx = indexByProject(billingRows);
    const costIdx = indexByProject(costRows);
    const pctIdx = indexByProject(pctRows);
    const monthIdx = indexByProject(monthRows);

    const studies = [];
    const tasks = [];

    for (const project of projChunk) {
      const pid = normId(rowGet(project, "project_id"));
      let taskList = rowsForProject(project, tasksIdx.byId, tasksIdx.byNum).map((t) =>
        normalizeTaskRow(t, pid)
      );
      const actuals = rowsForProject(project, actualsIdx.byId, actualsIdx.byNum);

      if (!taskList.length && actuals.length) {
        const seen = new Set();
        for (const a of actuals) {
          const tid = normId(rowGet(a, "task_id"));
          if (!tid || seen.has(tid)) continue;
          seen.add(tid);
          taskList.push(
            normalizeTaskRow(
              {
                task_id: tid,
                project_id: pid,
                task_name: `Task ${tid}`,
                task_status: null,
                is_milestone: "F",
                budgeted_hours: 0,
                estimate_to_complete_hours: 0
              },
              pid
            )
          );
        }
      }

      const pack = buildStudyCosmosPack(
        project,
        taskList,
        actuals,
        rowsForProject(project, costIdx.byId, costIdx.byNum),
        rowsForProject(project, billingIdx.byId, billingIdx.byNum)[0] || null,
        rowsForProject(project, monthIdx.byId, monthIdx.byNum),
        periodWarning,
        rowsForProject(project, pctIdx.byId, pctIdx.byNum)
      );
      studies.push(pack.study);
      tasks.push(...pack.tasks);
      processed += 1;
    }

    const upsert = await upsertNetSuiteStudyIntel(getDb, {
      studies,
      tasks,
      source: "buddy-netsuite-sync",
      pulledAt: new Date().toISOString(),
      triggeredBy
    });
    studyUpserted += upsert.studyUpserted || 0;
    taskUpserted += upsert.taskUpserted || 0;
    for (const pn of upsert.sampleProjectNumbers || []) {
      if (sample.length < 5) sample.push(pn);
    }

    offset = i + BATCH_PROJECTS;
    await writeSyncState(database, {
      resumeOffset: incomplete ? offset : Math.min(offset, projects.length),
      resumeTotal: projects.length,
      lastBatchAt: new Date().toISOString(),
      lastTriggeredBy: triggeredBy,
      lastSource: "buddy-netsuite-sync"
    });
  }

  if (!incomplete) {
    offset = projects.length;
    await writeSyncState(database, {
      resumeOffset: 0,
      resumeTotal: projects.length,
      lastSuccessfulSync: new Date().toISOString(),
      lastTriggeredBy: triggeredBy,
      lastSource: "buddy-netsuite-sync",
      lastStudyUpserted: studyUpserted,
      lastTaskUpserted: taskUpserted,
      sampleProjectNumbers: sample,
      note:
        "Buddy SuiteQL → Cosmos (job-parity pack: hours_by_month + pct_complete_history + formulas)."
    });
  } else {
    await writeSyncState(database, {
      resumeOffset: offset,
      resumeTotal: projects.length,
      lastTriggeredBy: triggeredBy,
      lastSource: "buddy-netsuite-sync",
      lastStudyUpserted: studyUpserted,
      lastTaskUpserted: taskUpserted,
      sampleProjectNumbers: sample,
      note: `In progress ${offset}/${projects.length} — auto-resume will continue.`
    });
  }

  const needsContinue = incomplete && !projectNumber && offset < projects.length;

  return {
    ok: studyUpserted > 0 || processed > 0,
    configured: true,
    mode: "buddy_suiteql",
    parity: "netsuite-pull-excel-v2/build_study_cosmos_pack",
    projectsFound: projects.length,
    processed,
    resumeOffset: incomplete ? offset : 0,
    incomplete,
    needsContinue,
    domainRows: domainTotals,
    studyUpserted,
    taskUpserted,
    sampleProjectNumbers: sample,
    warnings: warnings.length ? warnings.slice(0, 20) : undefined,
    periodWarning,
    elapsedMs: Date.now() - started,
    note: needsContinue
      ? `Batched ${processed} studies (${offset}/${projects.length}) — chaining next kick.`
      : `Pulled ${processed}/${projects.length} studies SuiteQL → Cosmos (job-parity + history).`
  };
}

async function getNetSuitePullStatus(getDb) {
  const cfg = netsuiteConfig();
  const sync = await getNetSuiteStudySyncStatus(getDb);
  return {
    ...sync,
    configured: cfg.configured,
    pullMode: "buddy_suiteql",
    note: cfg.configured
      ? "Buddy SuiteQL → Cosmos (1:1 with netsuite-pull-job study pack). Lens Sync NetSuite → /api/netsuite/sync."
      : notConfiguredPayload().error
  };
}

module.exports = {
  runNetSuiteStudyPull,
  getNetSuitePullStatus,
  buildStudyCosmosPack
};
