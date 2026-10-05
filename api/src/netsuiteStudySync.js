/**
 * NetSuite study intel → Cosmos (bd-budgets).
 *
 * Project number format (Ora): YY-DEPT-SEQ
 *   e.g. 25-150-0005 → year 2025, dept 150, study sequence 0005 that year.
 * Join to Veeva on project_number / Ora project code (same string).
 *
 * Containers:
 *   ora_ns_study  — study summary (Excel Project Summary + inv/PTC + billing KPIs)
 *   ora_ns_task   — task BVA rows (optional batch)
 * syncState id: netsuite_study_intel
 *
 * Writers: netsuite-pull-job POSTs here after SuiteQL/Excel build;
 *          GET status powers Data Status in Buddy / Data Lens.
 */

const SYNC_ID = "netsuite_study_intel";
const STUDY_CONTAINER = "ora_ns_study";
const STUDY_DOC_TYPE = "ora_ns_study";
const TASK_CONTAINER = "ora_ns_task";
const TASK_DOC_TYPE = "ora_ns_task";

function parseProjectNumber(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^(\d{2})-(\d{3})-(\d{4})$/);
  if (!m) {
    return {
      project_number: s,
      study_year: null,
      study_year_full: null,
      study_dept: null,
      study_seq: null,
      project_number_ok: false
    };
  }
  const yy = Number(m[1]);
  return {
    project_number: s,
    study_year: yy,
    study_year_full: 2000 + yy,
    study_dept: m[2],
    study_seq: m[3],
    project_number_ok: true
  };
}

async function ensureContainer(database, id, partitionKeyPath = "/project_number") {
  try {
    await database.containers.createIfNotExists({
      id,
      partitionKey: { paths: [partitionKeyPath] }
    });
  } catch (err) {
    const msg = String(err.message || err);
    if (!/Conflict|already exist/i.test(msg)) {
      // Some accounts pre-create containers; ignore NotFound on create race
      if (!/404|NotFound/i.test(msg)) throw err;
    }
  }
}

async function readSyncState(database) {
  try {
    const { resource } = await database.container("syncState").item(SYNC_ID, SYNC_ID).read();
    return resource || null;
  } catch (_) {
    return null;
  }
}

async function writeSyncState(database, patch) {
  await ensureContainer(database, "syncState", "/id");
  const prev = (await readSyncState(database)) || {};
  const doc = {
    ...prev,
    id: SYNC_ID,
    docType: "syncState",
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await database.container("syncState").items.upsert(doc);
  return doc;
}

async function safeCount(database, containerId, docType) {
  try {
    const { resources } = await database
      .container(containerId)
      .items.query(
        {
          query: "SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t",
          parameters: [{ name: "@t", value: docType }]
        },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();
    return resources[0] ?? 0;
  } catch (err) {
    const code = err && (err.code || err.statusCode);
    if (code === 404) return 0;
    return { error: String(err.message || err).slice(0, 180) };
  }
}

function studyDocFromPayload(row, meta = {}) {
  const pn = String(row.project_number || row.projectNumber || "").trim();
  const parsed = parseProjectNumber(pn);
  const id = `ns_study:${parsed.project_number || pn || "unknown"}`;
  return {
    id,
    docType: STUDY_DOC_TYPE,
    ...parsed,
    project_name: row.project_name ?? row.projectName ?? null,
    project_manager: row.project_manager ?? row.projectManager ?? null,
    service_line: row.service_line ?? row.serviceLine ?? null,
    project_status: row.project_status ?? row.projectStatus ?? null,
    start_date: row.start_date ?? null,
    calculated_end_date: row.calculated_end_date ?? null,
    region: row.region ?? null,
    total_budgeted: row.total_budgeted ?? null,
    total_budgeted_current: row.total_budgeted_current ?? null,
    total_actual: row.total_actual ?? null,
    total_etc: row.total_etc ?? null,
    total_projected: row.total_projected ?? null,
    budget_remaining_hours: row.budget_remaining_hours ?? null,
    remaining_hours: row.remaining_hours ?? null,
    at_risk_task_count: row.at_risk_task_count ?? null,
    realization_rate: row.realization_rate ?? null,
    percent_complete: row.percent_complete ?? null,
    percent_complete_vs_budget: row.percent_complete_vs_budget ?? null,
    elapsed_pct: row.elapsed_pct ?? null,
    avg_labor_rate: row.avg_labor_rate ?? null,
    inv_fee_budget: row.inv_fee_budget ?? row.investigator_fee_budget ?? null,
    inv_fee_actual: row.inv_fee_actual ?? null,
    ptc_budget: row.ptc_budget ?? null,
    ptc_actual: row.ptc_actual ?? null,
    oopc_labor_actual: row.oopc_labor_actual ?? null,
    oopc_travel_actual: row.oopc_travel_actual ?? null,
    ptc_categories: row.ptc_categories ?? null,
    visit_types: Array.isArray(row.visit_types) ? row.visit_types : null,
    hours_by_month: Array.isArray(row.hours_by_month) ? row.hours_by_month : null,
    pct_complete_history: Array.isArray(row.pct_complete_history)
      ? row.pct_complete_history
      : null,
    formulas: row.formulas && typeof row.formulas === "object" ? row.formulas : null,
    period_warning: row.period_warning ?? null,
    invoiced_amount: row.invoiced_amount ?? null,
    revenue_recognized: row.revenue_recognized ?? null,
    cost_of_sales: row.cost_of_sales ?? null,
    gross_profit: row.gross_profit ?? null,
    gross_margin_pct: row.gross_margin_pct ?? null,
    budgeted_gm_pct: row.budgeted_gm_pct ?? null,
    actual_gm_pct_prior_month: row.actual_gm_pct_prior_month ?? null,
    projected_eos_gm_pct_prior_month: row.projected_eos_gm_pct_prior_month ?? null,
    billing_gross_margin_pct: row.billing_gross_margin_pct ?? null,
    workbook_blob: row.workbook_blob ?? null,
    source: meta.source || row.source || "netsuite-pull-job",
    pulledAt: meta.pulledAt || row.pulledAt || new Date().toISOString(),
    veeva_join_key: parsed.project_number
  };
}

function taskDocFromPayload(row, meta = {}) {
  const pn = String(row.project_number || "").trim();
  const tid = String(row.task_id || row.taskId || "").trim() || "unknown";
  const parsed = parseProjectNumber(pn);
  return {
    id: `ns_task:${parsed.project_number || pn}:${tid}`,
    docType: TASK_DOC_TYPE,
    ...parsed,
    task_id: tid,
    task_name: row.task_name ?? null,
    task_status: row.task_status ?? null,
    budget: row.budget ?? row.budgeted_hours ?? null,
    original_budget_hrs: row.original_budget_hrs ?? row.original_budget_hours ?? null,
    current_budget_hrs: row.current_budget_hrs ?? row.budgeted_hours ?? null,
    actual_hours: row.actual_hours ?? null,
    estimate_to_complete: row.estimate_to_complete ?? row.estimate_to_complete_hours ?? null,
    estimate_to_complete_hours: row.estimate_to_complete_hours ?? row.estimate_to_complete ?? null,
    total_projected: row.total_projected ?? null,
    remaining_hours: row.remaining_hours ?? null,
    pct_complete: row.pct_complete ?? row.percent_complete ?? null,
    percent_complete: row.percent_complete ?? row.pct_complete ?? null,
    pct_of_budget: row.pct_of_budget ?? null,
    expected_hours_to_date: row.expected_hours_to_date ?? null,
    vs_expected_hrs: row.vs_expected_hrs ?? null,
    visit_type: row.visit_type ?? null,
    actual_cost: row.actual_cost ?? null,
    is_milestone: row.is_milestone ?? null,
    milestone_amount: row.milestone_amount ?? row.milestoneAmount ?? null,
    source: meta.source || "netsuite-pull-job",
    pulledAt: meta.pulledAt || new Date().toISOString()
  };
}

/**
 * Upsert studies (+ optional tasks). Called by netsuite-pull-job or manual POST.
 */
async function upsertNetSuiteStudyIntel(getDb, body = {}) {
  const database = getDb();
  const studies = Array.isArray(body.studies) ? body.studies : [];
  const tasks = Array.isArray(body.tasks) ? body.tasks : [];
  const meta = {
    source: body.source || "netsuite-pull-job",
    pulledAt: body.pulledAt || new Date().toISOString(),
    triggeredBy: body.triggeredBy || "api"
  };

  if (!studies.length && !tasks.length) {
    return {
      ok: false,
      error: "No studies or tasks in body. POST { studies: [...], tasks?: [...] }."
    };
  }

  await ensureContainer(database, STUDY_CONTAINER, "/project_number");
  if (tasks.length) {
    await ensureContainer(database, TASK_CONTAINER, "/project_number");
  }

  let studyUpserted = 0;
  let taskUpserted = 0;
  const sample = [];
  const errors = [];

  for (const row of studies) {
    try {
      const doc = studyDocFromPayload(row, meta);
      if (!doc.project_number) continue;
      await database.container(STUDY_CONTAINER).items.upsert(doc);
      studyUpserted += 1;
      if (sample.length < 5) sample.push(doc.project_number);
    } catch (err) {
      errors.push(`study ${row.project_number}: ${String(err.message || err).slice(0, 120)}`);
    }
  }

  for (const row of tasks) {
    try {
      const doc = taskDocFromPayload(row, meta);
      if (!doc.project_number) continue;
      await database.container(TASK_CONTAINER).items.upsert(doc);
      taskUpserted += 1;
    } catch (err) {
      errors.push(`task ${row.task_id}: ${String(err.message || err).slice(0, 120)}`);
    }
  }

  const studyCount = await safeCount(database, STUDY_CONTAINER, STUDY_DOC_TYPE);
  const taskCount = await safeCount(database, TASK_CONTAINER, TASK_DOC_TYPE);

  const syncDoc = await writeSyncState(database, {
    lastSuccessfulSync: meta.pulledAt,
    lastTriggeredBy: meta.triggeredBy,
    lastSource: meta.source,
    lastStudyUpserted: studyUpserted,
    lastTaskUpserted: taskUpserted,
    studyCount: typeof studyCount === "number" ? studyCount : null,
    taskCount: typeof taskCount === "number" ? taskCount : null,
    sampleProjectNumbers: sample,
    note:
      "YY-DEPT-SEQ. Cosmos is primary (Excel optional via WRITE_STUDY_EXCEL). Join Veeva on project_number."
  });

  return {
    ok: errors.length === 0,
    studyUpserted,
    taskUpserted,
    studyCount,
    taskCount,
    sampleProjectNumbers: sample,
    sync: syncDoc,
    errors: errors.length ? errors.slice(0, 20) : undefined
  };
}

async function getNetSuiteStudySyncStatus(getDb) {
  const database = getDb();
  const sync = await readSyncState(database);
  const studyCount = await safeCount(database, STUDY_CONTAINER, STUDY_DOC_TYPE);
  const taskCount = await safeCount(database, TASK_CONTAINER, TASK_DOC_TYPE);
  return {
    configured: true,
    syncId: SYNC_ID,
    containers: [
      {
        container: STUDY_CONTAINER,
        docType: STUDY_DOC_TYPE,
        count: typeof studyCount === "number" ? studyCount : 0,
        countError: studyCount && studyCount.error ? studyCount.error : undefined,
        role: "Study summary (BVA KPIs, inv/PTC budget, billing) — join key for Veeva"
      },
      {
        container: TASK_CONTAINER,
        docType: TASK_DOC_TYPE,
        count: typeof taskCount === "number" ? taskCount : 0,
        countError: taskCount && taskCount.error ? taskCount.error : undefined,
        role: "Task-level BVA / % complete rows"
      }
    ],
    lastSuccessfulSync: sync?.lastSuccessfulSync || null,
    lastTriggeredBy: sync?.lastTriggeredBy || null,
    lastSource: sync?.lastSource || null,
    lastStudyUpserted: sync?.lastStudyUpserted ?? null,
    lastTaskUpserted: sync?.lastTaskUpserted ?? null,
    resumeOffset: sync?.resumeOffset ?? 0,
    resumeTotal: sync?.resumeTotal ?? null,
    sampleProjectNumbers: sync?.sampleProjectNumbers || [],
    projectNumberFormat: "YY-DEPT-SEQ (e.g. 25-150-0005 = year 2025, dept 150, study #5)",
    note:
      sync?.note ||
      "Buddy SuiteQL → Cosmos (POST /api/netsuite/sync). Daily cron 5AM EST. Excel opt-in only."
  };
}

module.exports = {
  SYNC_ID,
  STUDY_CONTAINER,
  TASK_CONTAINER,
  parseProjectNumber,
  upsertNetSuiteStudyIntel,
  getNetSuiteStudySyncStatus,
  readSyncState,
  writeSyncState
};
