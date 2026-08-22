/**
 * Commercial yearly goal — Total Ora Net Revenue target stored in Cosmos syncState.
 * Used on Data Status + Dashboard for % to goal and suggested open opps to close the gap.
 */

const GOAL_DOC_ID = "commercial_yearly_goal";

function moneyRound(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x) : 0;
}

function round1(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x * 10) / 10 : null;
}

async function ensureSyncState(database) {
  await database.containers.createIfNotExists({
    id: "syncState",
    partitionKey: { paths: ["/id"] }
  });
}

async function getYearlyGoalSettings(getDb) {
  const database = getDb();
  const year = new Date().getUTCFullYear();
  try {
    const { resource } = await database.container("syncState").item(GOAL_DOC_ID, GOAL_DOC_ID).read();
    if (!resource) {
      return { year, goalOraNet: null, updatedAt: null, updatedBy: null };
    }
    const goalOraNet =
      resource.goalOraNet != null && resource.goalOraNet !== ""
        ? moneyRound(resource.goalOraNet)
        : null;
    return {
      year: Number(resource.year) || year,
      goalOraNet: goalOraNet > 0 ? goalOraNet : null,
      updatedAt: resource.updatedAt || null,
      updatedBy: resource.updatedBy || null,
      note: "Total Ora Net Revenue (SF Total_Ora_Net_Revenue__c) — not contract Amount."
    };
  } catch (_) {
    return { year, goalOraNet: null, updatedAt: null, updatedBy: null };
  }
}

async function saveYearlyGoal(getDb, opts = {}) {
  const database = getDb();
  await ensureSyncState(database);
  const year = Number(opts.year) || new Date().getUTCFullYear();
  const raw = opts.goalOraNet ?? opts.goal ?? opts.yearlyGoal;
  const goalOraNet = raw != null && raw !== "" ? moneyRound(raw) : null;
  if (goalOraNet != null && !(goalOraNet > 0)) {
    return { ok: false, error: "Yearly goal must be a positive number (Total Ora Net Revenue)." };
  }
  const now = new Date().toISOString();
  const doc = {
    id: GOAL_DOC_ID,
    docType: "sync_state",
    job: GOAL_DOC_ID,
    year,
    goalOraNet,
    updatedAt: now,
    updatedBy: opts.updatedBy || opts.userId || null,
    note: "Commercial yearly goal — Total Ora Net Revenue only."
  };
  await database.container("syncState").items.upsert(doc);
  return {
    ok: true,
    year,
    goalOraNet,
    updatedAt: now,
    updatedBy: doc.updatedBy
  };
}

/**
 * @param {{ goalOraNet: number, year?: number, closedWonYtdOraNet?: number|null, openOpportunities?: Array }} params
 */
function computeGoalProgress(params = {}) {
  const goalOraNet = moneyRound(params.goalOraNet);
  if (!(goalOraNet > 0)) return null;

  const year = Number(params.year) || new Date().getUTCFullYear();
  const closedWonYtdOraNet = moneyRound(params.closedWonYtdOraNet ?? 0);
  const gapRemaining = Math.max(0, goalOraNet - closedWonYtdOraNet);
  const percentToGoal = round1(Math.min(999.9, (closedWonYtdOraNet / goalOraNet) * 100));
  const atGoal = gapRemaining <= 0;

  const open = (params.openOpportunities || [])
    .map((o) => ({
      id: o.id,
      name: o.name,
      accountName: o.accountName || null,
      stage: o.stage || null,
      owner: o.owner || null,
      oraNetRevenue: moneyRound(o.amount ?? o.oraNetRevenue),
      closeDate: o.closeDate || null
    }))
    .filter((o) => o.oraNetRevenue > 0)
    .sort((a, b) => b.oraNetRevenue - a.oraNetRevenue);

  const openPipelineOraNet = open.reduce((s, o) => s + o.oraNetRevenue, 0);

  const suggestedWins = [];
  let suggestedTotal = 0;
  if (!atGoal) {
    for (const o of open) {
      suggestedWins.push(o);
      suggestedTotal += o.oraNetRevenue;
      if (suggestedTotal >= gapRemaining) break;
    }
  }

  const avgOpen =
    open.length > 0 ? moneyRound(openPipelineOraNet / open.length) : null;
  const oppsNeededEstimate =
    !atGoal && avgOpen > 0 ? Math.ceil(gapRemaining / avgOpen) : atGoal ? 0 : null;

  return {
    year,
    goalOraNet,
    closedWonYtdOraNet,
    gapRemaining,
    percentToGoal,
    atGoal,
    openPipelineOraNet,
    openOppCount: open.length,
    suggestedWins,
    suggestedWinsCount: suggestedWins.length,
    suggestedWinsTotal: suggestedTotal,
    coversGapWithSuggested: atGoal || suggestedTotal >= gapRemaining,
    avgOpenOraNet: avgOpen,
    estimatedOppsToClose: oppsNeededEstimate,
    revenueFieldLabel: "Total Ora Net Revenue",
    note: atGoal
      ? `Closed Won YTD ${year} meets or exceeds the yearly goal.`
      : suggestedWins.length
        ? `If the top ${suggestedWins.length} open opportunit${suggestedWins.length === 1 ? "y" : "ies"} below close, you cover the remaining $${gapRemaining.toLocaleString()} gap (greedy by Ora Net $).`
        : gapRemaining > 0
          ? "No open opportunities with Ora Net Revenue — ingest SF or add pipeline to model path to goal."
          : null
  };
}

async function buildYearlyGoalPack(getDb, opts = {}) {
  const settings = await getYearlyGoalSettings(getDb);
  if (!settings.goalOraNet) {
    return {
      ok: true,
      settings,
      progress: null,
      note: "Set a yearly goal (Total Ora Net Revenue) to track % to goal and suggested wins."
    };
  }

  let closedWonYtdOraNet = opts.closedWonYtdOraNet;
  let openOpportunities = opts.openOpportunities;

  if (closedWonYtdOraNet == null || openOpportunities == null) {
    const { buildSalesforceBuddyContext } = require("./salesforceTables");
    const { loadOpenOpportunities } = require("./dashboardBrief");
    const ytdYear = settings.year || new Date().getUTCFullYear();
    const [sf, openOpps] = await Promise.all([
      buildSalesforceBuddyContext(getDb, { question: "open pipeline closed won ytd" }).catch(
        () => ({})
      ),
      loadOpenOpportunities(getDb).catch(() => [])
    ]);
    if (closedWonYtdOraNet == null) {
      const wonYtd = (sf.pipelineSummary?.closedWonByYear || []).find(
        (r) => Number(r.year) === ytdYear
      );
      closedWonYtdOraNet = wonYtd ? moneyRound(wonYtd.amountSum) : 0;
    }
    if (openOpportunities == null) {
      openOpportunities = openOpps;
    }
  }

  const progress = computeGoalProgress({
    goalOraNet: settings.goalOraNet,
    year: settings.year,
    closedWonYtdOraNet,
    openOpportunities
  });

  return { ok: true, settings, progress };
}

module.exports = {
  GOAL_DOC_ID,
  getYearlyGoalSettings,
  saveYearlyGoal,
  computeGoalProgress,
  buildYearlyGoalPack
};
