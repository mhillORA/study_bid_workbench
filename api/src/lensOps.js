/**
 * Ora Data Lens ops packs — NetSuite project profitability + Insights RM star schema.
 * Source map: Ora_Resource_Model_1.xlsx (FleetView export → Power BI star schema).
 * Cosmos: lens_ns_projects + lens_rm_* (camelCase fields; docTypes are singular).
 */

const NS_CONTAINER = "lens_ns_projects";
const NS_DOC_TYPE = "lens_ns_project";

/** Star-schema + useful raw export tables from the RM workbook / Cosmos landing. */
const RM_TABLES = [
  { container: "lens_rm_studies", docType: "lens_rm_study", kind: "dim", excel: "Dim_Study" },
  { container: "lens_rm_roles", docType: "lens_rm_role", kind: "dim", excel: "Dim_Role" },
  { container: "lens_rm_employees", docType: "lens_rm_employee", kind: "dim", excel: "Dim_Employee" },
  { container: "lens_rm_activities", docType: "lens_rm_activity", kind: "dim", excel: "Dim_Activity" },
  { container: "lens_rm_departments", docType: "lens_rm_department", kind: "dim", excel: "Dim_Department" },
  { container: "lens_rm_organizations", docType: "lens_rm_organization", kind: "dim", excel: "Dim_Organization" },
  { container: "lens_rm_domains", docType: "lens_rm_domain", kind: "dim", excel: "Dim_Domain" },
  { container: "lens_rm_users", docType: "lens_rm_user", kind: "dim", excel: "Dim_User" },
  { container: "lens_rm_actuals", docType: "lens_rm_actual", kind: "fact", excel: "Fact_Actuals" },
  { container: "lens_rm_assignments", docType: "lens_rm_assignment", kind: "fact", excel: "Fact_Assignments" },
  { container: "lens_rm_projections", docType: "lens_rm_projection", kind: "fact", excel: "Fact_Projections" },
  { container: "lens_rm_headcount", docType: "lens_rm_headcount", kind: "fact", excel: "Fact_Headcount" },
  { container: "lens_rm_dq", docType: "lens_rm_dq", kind: "dq", excel: "DQ_*" },
  { container: "lens_rm_schedule", docType: "lens_rm_schedule", kind: "export", excel: null },
  { container: "lens_rm_roster", docType: "lens_rm_roster", kind: "export", excel: null },
  { container: "lens_rm_export_assignments", docType: "lens_rm_export_assignment", kind: "export", excel: null },
  { container: "lens_rm_staffing_employee", docType: "lens_rm_staffing_employee", kind: "export", excel: null },
  { container: "lens_rm_staffing_workitem", docType: "lens_rm_staffing_workitem", kind: "export", excel: null },
  { container: "lens_rm_runs", docType: "lens_rm_run", kind: "meta", excel: null }
];

async function queryAll(container, query, parameters = []) {
  const { resources } = await container.items
    .query({ query, parameters }, { enableCrossPartitionQuery: true })
    .fetchAll();
  return resources || [];
}

async function safeCountByDocType(database, containerId, docType) {
  try {
    const rows = await queryAll(
      database.container(containerId),
      "SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t",
      [{ name: "@t", value: docType }]
    );
    return rows[0] ?? 0;
  } catch (err) {
    const code = err && (err.code || err.statusCode);
    const msg = String(err.message || err);
    if (code === 404 || /NotFound|Resource Not Found|does not exist/i.test(msg)) {
      return 0;
    }
    return { error: msg.slice(0, 180) };
  }
}

function isNetSuiteQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  return (
    /\b(net\s*suite|netsuite|\bns\b)\b/.test(q) ||
    /\b(project profitability|budgeted\s*gm|actual\s*gm|gm\s*%|gm\s*pct|gm\s*variance)\b/.test(q) ||
    /\b(cost per billable|billable\s*hr|change\s*order\s*status|eos\s*gm)\b/.test(q) ||
    /\b(project manager|service line).{0,30}\b(project|gm|margin)\b/.test(q)
  );
}

function isRmQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  return (
    /\b(insights?\s*rm|resource\s*model|fleet\s*view|fleetview)\b/.test(q) ||
    /\b(fte|headcount|staffing|over[- ]?allocat|timesheet)\b/.test(q) ||
    /\b(assignment|assignments|projection|projections|actuals)\b.{0,40}\b(fte|role|study|staff)\b/.test(
      q
    ) ||
    /\b(who is (?:assigned|staffed)|staffed on|assigned to)\b/.test(q) ||
    /\b(capacity|role\s*demand|resource\s*(?:plan|demand|capacity))\b/.test(q)
  );
}

function isLensOpsQuestion(question) {
  return isNetSuiteQuestion(question) || isRmQuestion(question);
}

function extractProjectHint(question) {
  const q = String(question || "");
  const m = q.match(/\b(\d{2}-\d{3}-\d{4})\b/);
  if (m) return m[1];
  const named = q.match(
    /\b(?:project|study)\s+([A-Za-z0-9][A-Za-z0-9 .,&'+/-]{1,48?}?)(?:\s+gm|\s+fte|\s+staff|\s+margin|\?|$)/i
  );
  if (named) return named[1].trim().replace(/[?.!,;:]+$/, "");
  return null;
}

async function buildNetSuitePack(getDb, opts = {}) {
  const database = getDb();
  const hint = String(opts.projectHint || extractProjectHint(opts.question) || "").trim();
  const count = await safeCountByDocType(database, NS_CONTAINER, NS_DOC_TYPE);
  if (typeof count !== "number" || count === 0) {
    return {
      empty: true,
      count: typeof count === "number" ? count : 0,
      countError: count && count.error ? count.error : undefined,
      note: "lens_ns_projects empty — NetSuite project profitability not loaded yet."
    };
  }

  let sample = [];
  let matched = [];
  try {
    if (hint) {
      matched = await queryAll(
        database.container(NS_CONTAINER),
        `SELECT TOP 25 c.project_number, c.project_name, c.project_manager, c.customer_name,
          c.project_status, c.service_line, c.change_order_status,
          c.budgeted_gm_pct, c.actual_gm_pct_prior_month, c.gm_pct_variance,
          c.projected_eos_gm_pct_prior_month,
          c.cost_per_billable_hr_actual, c.cost_per_billable_hr_budgeted, c.syncedAt
         FROM c WHERE c.docType = @t
           AND (CONTAINS(LOWER(c.project_number), @h, true)
             OR CONTAINS(LOWER(c.project_name), @h, true)
             OR CONTAINS(LOWER(c.customer_name), @h, true)
             OR CONTAINS(LOWER(c.project_manager), @h, true))`,
        [
          { name: "@t", value: NS_DOC_TYPE },
          { name: "@h", value: hint.toLowerCase() }
        ]
      );
    }
    const raw = await queryAll(
      database.container(NS_CONTAINER),
      `SELECT TOP 40 c.project_number, c.project_name, c.project_manager, c.customer_name,
        c.project_status, c.service_line, c.change_order_status,
        c.budgeted_gm_pct, c.actual_gm_pct_prior_month, c.gm_pct_variance,
        c.projected_eos_gm_pct_prior_month,
        c.cost_per_billable_hr_actual, c.cost_per_billable_hr_budgeted, c.syncedAt
       FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: NS_DOC_TYPE }]
    );
    sample = [...raw]
      .sort((a, b) => {
        const av = typeof a.gm_pct_variance === "number" ? Math.abs(a.gm_pct_variance) : -1;
        const bv = typeof b.gm_pct_variance === "number" ? Math.abs(b.gm_pct_variance) : -1;
        return bv - av;
      })
      .slice(0, 20);
  } catch (err) {
    return { error: String(err.message || err), count };
  }

  const statusRank = {};
  const serviceRank = {};
  for (const row of sample) {
    const st = row.project_status || "(blank)";
    const sl = row.service_line || "(blank)";
    statusRank[st] = (statusRank[st] || 0) + 1;
    serviceRank[sl] = (serviceRank[sl] || 0) + 1;
  }

  return {
    empty: false,
    count,
    projectHint: hint || null,
    matchedCount: matched.length,
    matched: matched.slice(0, 15),
    highVarianceSample: sample.slice(0, 12),
    statusRankFromSample: Object.entries(statusRank)
      .map(([k, n]) => ({ status: k, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8),
    note:
      "NetSuite Project Profitability (SuiteQL → lens_ns_projects). GM $ fields are pct. Prefer matched rows when projectHint set; else highVarianceSample is |gm_pct_variance| ranked from a TOP-20 scan — not a full universe sort."
  };
}

async function buildRmPack(getDb, opts = {}) {
  const database = getDb();
  const hint = String(opts.projectHint || extractProjectHint(opts.question) || "").trim();
  const counts = {};
  for (const t of RM_TABLES) {
    counts[t.container] = await safeCountByDocType(database, t.container, t.docType);
  }
  const studyCount =
    typeof counts.lens_rm_studies === "number" ? counts.lens_rm_studies : 0;
  if (!studyCount) {
    return {
      empty: true,
      counts,
      note: "lens_rm_* empty — Insights RM / FleetView export not loaded yet."
    };
  }

  let studies = [];
  let assignments = [];
  let actuals = [];
  let dqSummary = [];
  let latestRun = null;
  try {
    if (hint) {
      studies = await queryAll(
        database.container("lens_rm_studies"),
        `SELECT TOP 20 c.studyKey, c.projectId, c.studyName, c.studyLabel, c.sponsor,
          c.indication, c.therapeuticArea, c.status, c.currentProjectStatus,
          c.numSites, c.numCountries, c.countries, c.probability, c.syncedAt
         FROM c WHERE c.docType = @t
           AND (CONTAINS(LOWER(c.studyKey), @h, true)
             OR CONTAINS(LOWER(c.studyName), @h, true)
             OR CONTAINS(LOWER(c.sponsor), @h, true)
             OR CONTAINS(LOWER(c.indication), @h, true))`,
        [
          { name: "@t", value: "lens_rm_study" },
          { name: "@h", value: hint.toLowerCase() }
        ]
      );
      const keys = studies.map((s) => s.studyKey).filter(Boolean).slice(0, 5);
      if (keys.length) {
        // Cosmos IN with params — pull per key (small N)
        for (const key of keys) {
          const a = await queryAll(
            database.container("lens_rm_assignments"),
            `SELECT TOP 30 c.studyKey, c.employeeKey, c.activityNameRaw, c.roleId,
              c.valueFTE, c.status, c.beginDate, c.endDate, c.label
             FROM c WHERE c.docType = @t AND c.studyKey = @k`,
            [
              { name: "@t", value: "lens_rm_assignment" },
              { name: "@k", value: key }
            ]
          );
          assignments.push(...a);
          const act = await queryAll(
            database.container("lens_rm_actuals"),
            `SELECT TOP 20 c.studyKey, c.employeeNameRaw, c.activityNameRaw, c.roleCodeRaw,
              c.valueFTE, c.beginDate, c.endDate
             FROM c WHERE c.docType = @t AND c.studyKey = @k
             ORDER BY c.beginDate DESC`,
            [
              { name: "@t", value: "lens_rm_actual" },
              { name: "@k", value: key }
            ]
          );
          actuals.push(...act);
        }
      }
    } else {
      studies = await queryAll(
        database.container("lens_rm_studies"),
        `SELECT TOP 15 c.studyKey, c.projectId, c.studyName, c.sponsor, c.indication,
          c.therapeuticArea, c.status, c.currentProjectStatus, c.numSites, c.numCountries,
          c.probability, c.syncedAt
         FROM c WHERE c.docType = @t`,
        [{ name: "@t", value: "lens_rm_study" }]
      );
    }

    dqSummary = await queryAll(
      database.container("lens_rm_dq"),
      `SELECT TOP 12 c.sheet, c.severity, c.rowsFound, c.finding, c.detail
       FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "lens_rm_dq" }]
    );

    const runs = await queryAll(
      database.container("lens_rm_runs"),
      `SELECT TOP 3 c.id, c.runDate, c.startedAt, c.finishedAt, c.ok, c.counts, c.sourceBlob
       FROM c WHERE c.docType = @t ORDER BY c.runDate DESC`,
      [{ name: "@t", value: "lens_rm_run" }]
    );
    latestRun = runs[0] || null;
  } catch (err) {
    return { error: String(err.message || err), counts };
  }

  return {
    empty: false,
    model:
      "Ora Resource Management star schema (Dim_Study/Role/Employee/Activity + Fact_Actuals/Assignments/Projections/Headcount). Join on StudyKey / RoleId / EmployeeKey / ActivityId.",
    counts,
    studyHint: hint || null,
    studies: studies.slice(0, 15),
    assignments: assignments.slice(0, 40),
    recentActuals: actuals.slice(0, 30),
    dqSummary: dqSummary.slice(0, 10),
    latestRun,
    note:
      "Insights RM from Cosmos lens_rm_*. Actuals = timesheet FTE; Assignments = booked FTE; Projections = role demand (no employee); Headcount = role capacity. Prefer StudyKey (Ora project id)."
  };
}

async function getLensHealthSlice(getDb) {
  const database = getDb();
  const netsuite = await safeCountByDocType(database, NS_CONTAINER, NS_DOC_TYPE);
  const rm = {};
  for (const t of RM_TABLES) {
    rm[t.container] = await safeCountByDocType(database, t.container, t.docType);
  }
  let latestRmRun = null;
  try {
    const runs = await queryAll(
      database.container("lens_rm_runs"),
      `SELECT TOP 1 c.runDate, c.finishedAt, c.ok, c.counts FROM c WHERE c.docType = @t ORDER BY c.runDate DESC`,
      [{ name: "@t", value: "lens_rm_run" }]
    );
    latestRmRun = runs[0] || null;
  } catch (_) {
    latestRmRun = null;
  }
  return {
    netsuite: {
      projects: netsuite,
      note: "NetSuite Project Profitability → lens_ns_projects (docType lens_ns_project)."
    },
    insightsRm: {
      counts: rm,
      latestRun: latestRmRun,
      note:
        "Insights RM / FleetView star schema in lens_rm_* (see Ora_Resource_Model_1.xlsx)."
    }
  };
}

async function attachLensOpsData(intel, getDb, opts = {}) {
  if (!intel || typeof intel !== "object" || intel.error) return intel;
  const q = opts.question || "";
  const wantNs = Boolean(opts.force || opts.forceNetSuite || isNetSuiteQuestion(q));
  const wantRm = Boolean(opts.force || opts.forceRm || isRmQuestion(q));
  if (!wantNs && !wantRm) return intel;
  try {
    if (wantNs) intel.netsuiteData = await buildNetSuitePack(getDb, opts);
  } catch (err) {
    intel.netsuiteData = { error: String(err.message || err) };
  }
  try {
    if (wantRm) intel.insightsRmData = await buildRmPack(getDb, opts);
  } catch (err) {
    intel.insightsRmData = { error: String(err.message || err) };
  }
  if (intel.query) {
    intel.query.netsuiteIntent = wantNs;
    intel.query.insightsRmIntent = wantRm;
  }
  return intel;
}

module.exports = {
  NS_CONTAINER,
  NS_DOC_TYPE,
  RM_TABLES,
  isNetSuiteQuestion,
  isRmQuestion,
  isLensOpsQuestion,
  extractProjectHint,
  safeCountByDocType,
  getLensHealthSlice,
  buildNetSuitePack,
  buildRmPack,
  attachLensOpsData
};
