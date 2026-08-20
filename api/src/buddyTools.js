/**
 * Buddy tool registry — executable Cosmos / intel / portfolio / hunt steps.
 * Router labels map 1:1 to these tools. The hunt loop calls them mid-turn.
 */

const {
  buildIntelligenceContext,
  buildReconciliationIntelContext,
  buildSlimBuddyIntelContext,
  extractIndicationFromQuestion,
  extractCountryFromQuestion
} = require("./intelligence");
const { fetchBuddyPortfolio } = require("./buddyCosmosFetch");

const TOOL_LABELS = {
  cosmos_default: "Slim Cosmos inventory",
  cosmos_intel_full: "Full clinical intelligence",
  cosmos_reconciliation: "Cosmos reconciliation pack",
  portfolio: "Ora portfolio rollup",
  study_compare: "Two-study compare",
  pricing_scenarios: "Past-bid pricing",
  legacy_anterior: "Legacy anterior-segment",
  live_context: "Buddy live context",
  dept_context: "Department playbook",
  web_search: "Web search (public)",
  attachments: "Attached documents",
  query_intelligence: "Indication intelligence",
  query_portfolio: "Portfolio query",
  query_inventory: "DB inventory",
  extract_indication: "Extract indication from text"
};

function labelFor(tool) {
  return TOOL_LABELS[tool] || tool;
}

function traceStep(tool, ok, detail, extra = {}) {
  return {
    tool,
    label: labelFor(tool),
    ok: Boolean(ok),
    detail: detail || null,
    elapsedMs: extra.elapsedMs ?? null,
    n: extra.n ?? null,
    round: extra.round ?? 1,
    resultKey: extra.resultKey || null
  };
}

/**
 * Run a single named tool. Returns { result, trace }.
 */
async function runBuddyTool(name, deps, args = {}) {
  const started = Date.now();
  const round = args.round || 1;
  const {
    getDb,
    buildPortfolioContext,
    loadLiveContext,
    loadDeptContexts,
    buildDeptContextForAsk,
    compareStudies,
    buildLegacyAnteriorContext,
    buildRfpPricingPack,
    extractRfpScenarioFromQuestion,
    isPricingQuestion
  } = deps;

  try {
    switch (name) {
      case "query_inventory":
      case "cosmos_default": {
        const intel = await buildSlimBuddyIntelContext(getDb, args.intelBase || {});
        return {
          result: { intelligence: intel },
          trace: traceStep(
            "query_inventory",
            intel && !intel.error,
            intel?.error || "slim inventory",
            { elapsedMs: Date.now() - started, round, resultKey: "intelligence" }
          )
        };
      }
      case "query_intelligence":
      case "cosmos_intel_full": {
        const intel = await buildIntelligenceContext(getDb, {
          ...(args.intelBase || {}),
          force: true
        });
        return {
          result: { intelligence: intel },
          trace: traceStep(
            "query_intelligence",
            intel && !intel.error,
            intel?.query?.indication
              ? `${intel.query.indication}${intel.query.country ? ` / ${intel.query.country}` : ""}`
              : intel?.error || "full intel",
            {
              elapsedMs: Date.now() - started,
              round,
              n: intel?.indicationBenchmark?.ora?.studyCount ?? null,
              resultKey: "intelligence"
            }
          )
        };
      }
      case "cosmos_reconciliation": {
        const intel = await buildReconciliationIntelContext(getDb, args.intelBase || {});
        return {
          result: { intelligence: intel },
          trace: traceStep(
            "cosmos_reconciliation",
            intel && !intel.error,
            intel?.query?.indication || intel?.error || "reconciliation pack",
            { elapsedMs: Date.now() - started, round, resultKey: "intelligence" }
          )
        };
      }
      case "query_portfolio":
      case "portfolio": {
        if (!buildPortfolioContext) throw new Error("buildPortfolioContext missing");
        const pack = await fetchBuddyPortfolio(buildPortfolioContext, {
          routerTools: ["portfolio"],
          hints: args.hints || {}
        });
        const p = pack.portfolio;
        return {
          result: {
            portfolio: p,
            portfolioFull: pack.portfolioFull || p,
            clientDirectory: pack.clientDirectory || []
          },
          trace: traceStep(
            "query_portfolio",
            p && p.source === "cosmos_portfolio" && !p.error,
            p?.error ||
              `matched ${p?.matchedStudyCount ?? "?"} / ${p?.databaseStudyCount ?? "?"}`,
            {
              elapsedMs: Date.now() - started,
              round,
              n: p?.matchedStudyCount ?? null,
              resultKey: "portfolio"
            }
          )
        };
      }
      case "extract_indication": {
        const text = String(args.text || args.question || "");
        const indication = extractIndicationFromQuestion(text);
        const country = extractCountryFromQuestion(text);
        return {
          result: { indication, country },
          trace: traceStep(
            "extract_indication",
            Boolean(indication),
            indication ? `${indication}${country ? ` / ${country}` : ""}` : "none found",
            { elapsedMs: Date.now() - started, round }
          )
        };
      }
      case "live_context": {
        if (!loadLiveContext) throw new Error("loadLiveContext missing");
        const live = await loadLiveContext(getDb);
        return {
          result: { buddyLiveContext: live },
          trace: traceStep(
            "live_context",
            Boolean(live?.text),
            live?.text ? "SME notes loaded" : "empty",
            { elapsedMs: Date.now() - started, round, resultKey: "buddyLiveContext" }
          )
        };
      }
      case "dept_context": {
        if (!loadDeptContexts || !buildDeptContextForAsk) {
          throw new Error("dept context deps missing");
        }
        const pack = await loadDeptContexts(getDb);
        const buddyDeptContexts = buildDeptContextForAsk(pack, args.buddyDept || "auto");
        return {
          result: { buddyDeptContexts },
          trace: traceStep(
            "dept_context",
            Boolean(buddyDeptContexts) && !buddyDeptContexts.error,
            buddyDeptContexts?.lens || "loaded",
            { elapsedMs: Date.now() - started, round, resultKey: "buddyDeptContexts" }
          )
        };
      }
      case "web_search": {
        // Foundry agent performs search — we only record the plan.
        return {
          result: { webSearchPlanned: true },
          trace: traceStep(
            "web_search",
            true,
            "delegated to Foundry agent (public facts only)",
            { elapsedMs: Date.now() - started, round }
          )
        };
      }
      default:
        return {
          result: null,
          trace: traceStep(name, false, `unknown tool: ${name}`, {
            elapsedMs: Date.now() - started,
            round
          })
        };
    }
  } catch (err) {
    return {
      result: null,
      trace: traceStep(name, false, String(err.message || err), {
        elapsedMs: Date.now() - started,
        round
      })
    };
  }
}

/**
 * Execute router-planned tools that aren't already satisfied by pre-fetched packs.
 * Used for gap-fill / second hunt round.
 */
async function runHuntTools(toolNames, deps, args = {}) {
  const tools = [...new Set((toolNames || []).filter(Boolean))];
  const trace = [];
  const merged = {};

  for (const name of tools) {
    const { result, trace: step } = await runBuddyTool(name, deps, args);
    trace.push(step);
    if (result && typeof result === "object") {
      Object.assign(merged, result);
    }
  }

  return { merged, toolTrace: trace };
}

/**
 * Decide which tools to run on a second hunt pass given first-pass context + answer.
 */
function planGapFillTools({ context, question, huntReason }) {
  const tools = [];
  const q = String(question || "");
  const intel = context?.intelligence;

  if (huntReason === "feasibility_no_indication" || !intel?.query?.indication) {
    tools.push("extract_indication");
  }

  // If indication might be in attachments / question — re-query intelligence
  if (
    context?.router?.intent === "feasibility" ||
    context?.router?.intent === "reconcile" ||
    context?.router?.intent === "hybrid" ||
    context?.workflow === "feasibility" ||
    context?.workflow === "hybrid"
  ) {
    if (!intel || intel.error || !intel.query?.indication) {
      tools.push("query_intelligence");
    }
  }

  if (
    (context?.moneyIntent === "ora_earned" || context?.answerFocus === "portfolio") &&
    (!context?.portfolio || context.portfolio.skipped || context.portfolio.error)
  ) {
    tools.push("query_portfolio");
  }

  if (context?.moneyIntent === "public_company") {
    tools.push("web_search");
  }

  if (/\b(what(?:'s| is) in|catalog|inventory|how many)\b/i.test(q)) {
    tools.push("query_inventory");
  }

  // Always try inventory as last-resort grounded facts if nothing else
  if (!tools.length) tools.push("query_inventory");

  return [...new Set(tools)];
}

module.exports = {
  runBuddyTool,
  runHuntTools,
  planGapFillTools,
  TOOL_LABELS,
  labelFor
};
