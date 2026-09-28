/**
 * Buddy tool registry — executable Cosmos / intel / portfolio / hunt steps.
 * Router labels map 1:1 to these tools. The hunt loop calls them mid-turn.
 */

const {
  buildIntelligenceContext,
  buildReconciliationIntelContext,
  buildSlimBuddyIntelContext,
  extractIndicationFromQuestion,
  extractCountryFromQuestion,
  wantsTreatmentNaivePopulation,
  wantsTreatmentNaiveInConversation
} = require("./intelligence");
const { fetchBuddyPortfolio } = require("./buddyCosmosFetch");
const { runGapFill } = require("./gapFill");

const TOOL_LABELS = {
  cosmos_default: "Slim Cosmos inventory",
  cosmos_intel_full: "Full clinical intelligence",
  cosmos_reconciliation: "Cosmos reconciliation pack",
  portfolio: "Ora portfolio rollup",
  study_compare: "Two-study compare",
  pricing_scenarios: "Past-bid pricing",
  legacy_anterior: "Legacy anterior-segment",
  feasibility_artemis: "Artemis feasibility sites/surveys",
  live_context: "Buddy live context",
  dept_context: "Department playbook",
  web_search: "Web search (public)",
  attachments: "Attached documents",
  query_intelligence: "Indication intelligence",
  query_portfolio: "Portfolio query",
  query_inventory: "DB inventory",
  extract_indication: "Extract indication from text",
  live_ctgov_naive: "Live CT.gov treatment-naïve (go get it)",
  live_ctgov_nct: "Live CT.gov NCT lookup (go get it)",
  live_ctgov_recruiting: "Live CT.gov recruiting (go get it)"
};

function labelFor(tool) {
  return TOOL_LABELS[tool] || tool;
}

/** Merge a live gap-fill pack into intelligence so Buddy answers from it (Claude-like). */
function mergeGapFillIntoIntelligence(intel, fill, { indication } = {}) {
  const base =
    intel && typeof intel === "object"
      ? { ...intel }
      : {
          source: "ora_clinical_intelligence",
          attachedFrom: "gap_fill_live",
          query: {}
        };
  base.query = {
    ...(base.query || {}),
    indication: indication || base.query?.indication || fill?.indication || null,
    treatmentNaive:
      fill?.filler === "ctgov_treatment_naive" ? true : base.query?.treatmentNaive,
    liveGapFill: true
  };
  base.gapFill = {
    filler: fill?.filler,
    live: true,
    counts: fill?.counts || null,
    note: fill?.note || null,
    elapsedMs: fill?.elapsedMs
  };

  if (fill?.filler === "ctgov_treatment_naive") {
    const recruit = fill.recruitingTreatmentNaiveSample || [];
    const naive = fill.treatmentNaiveSample || [];
    base.ctgov = {
      ...(base.ctgov || {}),
      treatmentNaiveFilter: true,
      treatmentNaiveCount: fill.counts?.treatmentNaive ?? naive.length,
      recruitingTreatmentNaiveCount:
        fill.counts?.recruitingTreatmentNaive ?? recruit.length,
      treatmentNaiveSample: naive,
      recruitingTreatmentNaiveSample: recruit,
      liveCtgovSearch: { searched: true, fromGapFill: true },
      note:
        "Live CT.gov gap-fill (not limited to Cosmos). Prefer recruitingTreatmentNaiveSample."
    };
    base.ctgovRecruitingTreatmentNaiveSample = recruit;
    base.recruitingTreatmentNaiveCount =
      fill.counts?.recruitingTreatmentNaive ?? recruit.length;
    base.treatmentNaiveTrials = {
      indication: indication || fill.indication,
      filter: true,
      eligibilitySource: "clinicaltrials.gov",
      sources: { ctgov: naive, ctgovRecruiting: recruit },
      counts: {
        ctgovNaive: fill.counts?.treatmentNaive ?? naive.length,
        ctgovRecruitingNaive: fill.counts?.recruitingTreatmentNaive ?? recruit.length
      },
      note: "Live gap-fill — Node fetched CT.gov because Cosmos was thin/missing."
    };
  }

  if (fill?.filler === "ctgov_recruiting") {
    const sample = fill.recruitingSample || [];
    base.ctgov = {
      ...(base.ctgov || {}),
      recruitingCount: fill.counts?.recruiting ?? sample.length,
      recruitingSample: sample,
      sample: sample,
      note: "Live CT.gov recruiting gap-fill."
    };
  }

  if (fill?.filler === "ctgov_nct" && fill.trial) {
    base.ctgovNct = fill.trial;
    base.nctLookup = { ...(base.nctLookup || {}), live: fill.trial };
  }

  base.note =
    (base.note || "") +
    " Live gap-fill ran this turn (Claude-style: go get public registry data when Cosmos is thin).";
  return base;
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
    buildFeasibilityArtemisContext,
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
      case "feasibility_artemis": {
        if (!buildFeasibilityArtemisContext) {
          throw new Error("buildFeasibilityArtemisContext missing");
        }
        const pack = await buildFeasibilityArtemisContext(getDb, {
          question: args.question || "",
          indication: args.intelBase?.indication || args.indication || null,
          includeMatch: true,
          includeQuestions: true
        });
        return {
          result: { feasibilityArtemis: pack },
          trace: traceStep(
            "feasibility_artemis",
            pack && !pack.error,
            pack?.error ||
              `sites=${pack?.sites?.length ?? 0} · questions=${pack?.questions?.length ?? 0} · dupClusters=${pack?.match?.duplicateClusterCount ?? 0}`,
            {
              elapsedMs: Date.now() - started,
              round,
              n: pack?.sites?.length ?? null,
              resultKey: "feasibilityArtemis"
            }
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
      case "live_ctgov_naive": {
        if (!getDb) throw new Error("getDb missing");
        const indication =
          args.intelBase?.indication ||
          args.indication ||
          extractIndicationFromQuestion(args.question || "") ||
          "Wet AMD";
        const fill = await runGapFill(getDb, {
          filler: "ctgov_treatment_naive",
          indication,
          upsert: args.upsert === true,
          limit: args.limit || 25,
          maxPages: args.maxPages || 3,
          triggeredBy: "buddy_live_tool"
        });
        const intelligence = mergeGapFillIntoIntelligence(args.intelligence || null, fill, {
          indication
        });
        return {
          result: { intelligence, gapFill: fill, liveFetched: true },
          trace: traceStep(
            "live_ctgov_naive",
            Boolean(fill?.ok),
            fill?.ok
              ? `live naïve=${fill.counts?.treatmentNaive ?? "—"} recruiting=${fill.counts?.recruitingTreatmentNaive ?? "—"}`
              : fill?.error || "failed",
            {
              elapsedMs: Date.now() - started,
              round,
              n: fill?.counts?.recruitingTreatmentNaive ?? null,
              resultKey: "intelligence"
            }
          )
        };
      }
      case "live_ctgov_nct": {
        if (!getDb) throw new Error("getDb missing");
        const nct =
          args.nct ||
          (String(args.question || "").match(/\b(NCT\d{8})\b/i) || [])[1] ||
          null;
        if (!nct) {
          return {
            result: null,
            trace: traceStep("live_ctgov_nct", false, "no NCT in question", {
              elapsedMs: Date.now() - started,
              round
            })
          };
        }
        const fill = await runGapFill(getDb, {
          filler: "ctgov_nct",
          nct,
          upsert: args.upsert !== false,
          force: args.force === true,
          triggeredBy: "buddy_live_tool"
        });
        return {
          result: { gapFill: fill, liveFetched: true, ctgovNctLive: fill?.trial || null },
          trace: traceStep(
            "live_ctgov_nct",
            Boolean(fill?.ok),
            fill?.ok ? `${nct} ${fill.fromCosmos ? "cosmos+live" : "live"}` : fill?.error || "failed",
            { elapsedMs: Date.now() - started, round, resultKey: "gapFill" }
          )
        };
      }
      case "live_ctgov_recruiting": {
        if (!getDb) throw new Error("getDb missing");
        const indication =
          args.intelBase?.indication ||
          args.indication ||
          extractIndicationFromQuestion(args.question || "") ||
          "Wet AMD";
        const fill = await runGapFill(getDb, {
          filler: "ctgov_recruiting",
          indication,
          upsert: args.upsert === true,
          limit: args.limit || 25,
          triggeredBy: "buddy_live_tool"
        });
        const intelligence = mergeGapFillIntoIntelligence(args.intelligence || null, fill, {
          indication
        });
        return {
          result: { intelligence, gapFill: fill, liveFetched: true },
          trace: traceStep(
            "live_ctgov_recruiting",
            Boolean(fill?.ok),
            fill?.ok
              ? `live recruiting=${fill.counts?.recruiting ?? "—"}`
              : fill?.error || "failed",
            {
              elapsedMs: Date.now() - started,
              round,
              n: fill?.counts?.recruiting ?? null,
              resultKey: "intelligence"
            }
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
 * Live CT.gov tools = Claude-style "go get it" when Cosmos is thin.
 */
function planGapFillTools({ context, question, huntReason, history = [] }) {
  const tools = [];
  const q = String(question || "");
  const intel = context?.intelligence;
  const naiveAsk =
    wantsTreatmentNaivePopulation(q) ||
    wantsTreatmentNaiveInConversation(q, history, "") ||
    Boolean(intel?.query?.treatmentNaive);
  const recruitNaiveN =
    Number(intel?.ctgov?.recruitingTreatmentNaiveCount) ||
    Number(intel?.recruitingTreatmentNaiveCount) ||
    (intel?.ctgov?.recruitingTreatmentNaiveSample || []).length ||
    0;
  const nct = (q.match(/\b(NCT\d{8})\b/i) || [])[1];

  if (huntReason === "feasibility_no_indication" || !intel?.query?.indication) {
    tools.push("extract_indication");
  }

  // Claude-like: go live to CT.gov when naïve/recruiting ask has empty Cosmos pack
  if (naiveAsk && recruitNaiveN === 0) {
    tools.push("live_ctgov_naive");
  } else if (
    /\b(recruiting|open\s+trials?)\b/i.test(q) &&
    !(intel?.ctgov?.recruitingSample || []).length &&
    !(intel?.ctgov?.recruitingCount > 0)
  ) {
    tools.push("live_ctgov_recruiting");
  }

  if (nct && !intel?.ctgovNct && !intel?.nctLookup) {
    tools.push("live_ctgov_nct");
  }

  if (
    huntReason === "not_in_cosmos" ||
    huntReason === "high_gaps_weak_answer" ||
    huntReason === "said_missing_public_data"
  ) {
    if (naiveAsk) tools.push("live_ctgov_naive");
    else if (/\brecruit/i.test(q)) tools.push("live_ctgov_recruiting");
    if (nct) tools.push("live_ctgov_nct");
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
    (!context?.intelligence?.salesforceData || context.intelligence.salesforceData.error)
  ) {
    tools.push("query_intelligence");
  }

  if (context?.moneyIntent === "public_company") {
    tools.push("web_search");
  }

  if (/\b(what(?:'s| is) in|catalog|inventory|how many)\b/i.test(q)) {
    tools.push("query_inventory");
  }

  if (
    /\b(feasibility|survey|duplicate\s+sites?|site\s+match)\b/i.test(q) &&
    !context?.feasibilityArtemis
  ) {
    tools.push("feasibility_artemis");
  }

  // Always try inventory as last-resort grounded facts if nothing else
  if (!tools.length) tools.push("query_inventory");

  return [...new Set(tools)];
}

/**
 * Prefetch live public data before the model answers (Claude-style: go get it first).
 */
async function prefetchLiveGapFill(getDb, { question, history = [], intelligence = null } = {}) {
  const tools = planGapFillTools({
    context: { intelligence },
    question,
    history,
    huntReason: "prefetch"
  }).filter((t) => t.startsWith("live_"));
  if (!tools.length || !getDb) {
    return { intelligence, toolTrace: [], liveFetched: false };
  }
  const { merged, toolTrace } = await runHuntTools(tools, { getDb }, {
    question,
    intelligence,
    intelBase: {
      indication:
        intelligence?.query?.indication ||
        extractIndicationFromQuestion(question) ||
        null,
      question
    },
    upsert: false,
    round: 0
  });
  return {
    intelligence: merged.intelligence || intelligence,
    gapFill: merged.gapFill || null,
    toolTrace,
    liveFetched: Boolean(merged.liveFetched)
  };
}

module.exports = {
  runBuddyTool,
  runHuntTools,
  planGapFillTools,
  prefetchLiveGapFill,
  mergeGapFillIntoIntelligence,
  TOOL_LABELS,
  labelFor
};
