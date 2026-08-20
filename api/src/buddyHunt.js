/**
 * Buddy hunt loop — after the first model answer, optionally run gap-fill tools
 * and re-ask once with denser context. Foundry cannot take custom tools, so the
 * Node orchestrator does the hunting.
 */

const { shouldHuntAgain, buildEvidenceEnvelope } = require("./buddyEvidence");
const { planGapFillTools, runHuntTools } = require("./buddyTools");
const {
  extractIndicationFromQuestion,
  extractCountryFromQuestion
} = require("./intelligence");

function mergeContext(base, patch) {
  const next = { ...(base || {}) };
  if (!patch) return next;
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) continue;
    if (k === "intelligence" && v && !v.error) next.intelligence = v;
    else if (k === "portfolio" && v && !v.skipped) next.portfolio = v;
    else if (k === "indication" || k === "country") {
      /* handled via intelBase below */
    } else next[k] = v;
  }
  return next;
}

/**
 * @param {object} opts
 * @param {function} opts.askAi
 * @param {object} opts.context — first-pass contextPayload
 * @param {object} opts.firstResult — askAi result
 * @param {string} opts.question
 * @param {array} opts.history
 * @param {string} opts.tier
 * @param {object} opts.body
 * @param {array} opts.initialToolTrace
 * @param {object} opts.toolDeps — getDb, buildPortfolioContext, etc.
 */
async function maybeHuntAndRetry(opts) {
  const {
    askAi,
    context,
    firstResult,
    question,
    history,
    tier,
    body,
    initialToolTrace = [],
    toolDeps
  } = opts;

  const answer = firstResult?.answer || "";
  const decision = shouldHuntAgain({ answer, context, toolTrace: initialToolTrace });

  if (!decision.yes || !toolDeps?.getDb) {
    const evidence = buildEvidenceEnvelope({
      context,
      question,
      answer,
      toolTrace: initialToolTrace
    });
    return {
      result: firstResult,
      context,
      evidence,
      hunted: false,
      huntReason: null
    };
  }

  const gapTools = planGapFillTools({
    context,
    question,
    huntReason: decision.reason
  });

  // Prefer indication from attachments if extract finds one
  let intelBase = {
    ...(context.intelligence?.query
      ? {
          indication: context.intelligence.query.indication,
          country: context.intelligence.query.country
        }
      : {}),
    question
  };

  const attachText = (context.uploadedDocuments?.files || [])
    .filter((f) => f.ok && f.text)
    .map((f) => f.text)
    .join("\n")
    .slice(0, 20000);

  const extractPack = await runHuntTools(["extract_indication"], toolDeps, {
    question: attachText ? `${question}\n${attachText}` : question,
    text: attachText || question,
    round: 2
  });

  const foundInd =
    extractPack.merged.indication ||
    extractIndicationFromQuestion(question) ||
    extractIndicationFromQuestion(attachText);
  const foundCountry =
    extractPack.merged.country ||
    extractCountryFromQuestion(question) ||
    context.intelligence?.query?.country ||
    null;

  if (foundInd) {
    intelBase = {
      ...intelBase,
      indication: foundInd,
      country: foundCountry,
      question: attachText
        ? `${question}\n\n--- ATTACHED ---\n${attachText.slice(0, 8000)}`
        : question
    };
  }

  const fillTools = gapTools.filter((t) => t !== "extract_indication");
  const hunt = await runHuntTools(fillTools, toolDeps, {
    intelBase,
    hints: context.queryHints || {},
    buddyDept: context.buddyDept,
    question,
    round: 2
  });

  const toolTrace = [
    ...initialToolTrace.map((t) => ({ ...t, round: t.round || 1 })),
    ...extractPack.toolTrace,
    ...hunt.toolTrace
  ];

  let nextContext = mergeContext(context, hunt.merged);
  if (hunt.merged.intelligence) {
    nextContext.intelligence = hunt.merged.intelligence;
    nextContext.dataSources = {
      ...(nextContext.dataSources || {}),
      intelligenceAttached: Boolean(
        hunt.merged.intelligence &&
          hunt.merged.intelligence.source === "ora_clinical_intelligence" &&
          !hunt.merged.intelligence.error
      )
    };
  }
  if (hunt.merged.portfolio) {
    nextContext.portfolio = hunt.merged.portfolio;
  }

  nextContext.huntRound = 2;
  nextContext.huntNote =
    `Second hunt (${decision.reason}): ran ${[...extractPack.toolTrace, ...hunt.toolTrace]
      .map((t) => t.tool)
      .join(", ")}. Prefer freshly attached packs; say missing if still empty.`;

  // Only re-ask if we actually got new useful data
  const gainedIntel =
    hunt.merged.intelligence &&
    !hunt.merged.intelligence.error &&
    (!context.intelligence ||
      context.intelligence.error ||
      (!context.intelligence.query?.indication && hunt.merged.intelligence.query?.indication));
  const gainedPortfolio =
    hunt.merged.portfolio &&
    hunt.merged.portfolio.source === "cosmos_portfolio" &&
    (!context.portfolio || context.portfolio.skipped || context.portfolio.error);

  if (!gainedIntel && !gainedPortfolio && !hunt.merged.webSearchPlanned) {
    const evidence = buildEvidenceEnvelope({
      context: nextContext,
      question,
      answer,
      toolTrace
    });
    return {
      result: firstResult,
      context: nextContext,
      evidence,
      hunted: true,
      huntReason: decision.reason,
      huntRetry: false
    };
  }

  const retry = await askAi({
    question,
    context: {
      ...nextContext,
      priorAttempt: {
        tier: firstResult.modelTier || tier,
        answer: String(answer).slice(0, 2000),
        note: "Prior answer was weak/ungrounded — finish using the second-hunt packs."
      }
    },
    history,
    tier: tier === "deep" ? "deep" : "fast",
    body
  });

  const finalResult = {
    ...retry,
    hunted: true,
    huntReason: decision.reason,
    priorProvider: firstResult.provider
  };

  const evidence = buildEvidenceEnvelope({
    context: nextContext,
    question,
    answer: finalResult.answer,
    toolTrace
  });

  return {
    result: finalResult,
    context: nextContext,
    evidence,
    hunted: true,
    huntReason: decision.reason,
    huntRetry: true
  };
}

/**
 * Build initial toolTrace from packs already loaded by progressive fetch.
 */
function toolTraceFromPrefetch({
  portfolio,
  intelligence,
  legacyAnterior,
  pricingScenarios,
  buddyLiveContext,
  buddyDeptContexts,
  routerTools = []
}) {
  const trace = [];
  const tools = new Set(routerTools);

  if (tools.has("portfolio") || (portfolio && !portfolio.skipped)) {
    trace.push({
      tool: "portfolio",
      label: "Ora portfolio rollup",
      ok: portfolio?.source === "cosmos_portfolio" && !portfolio?.error && !portfolio?.skipped,
      detail: portfolio?.skipped
        ? "skipped"
        : portfolio?.error ||
          `matched ${portfolio?.matchedStudyCount ?? "?"} / ${portfolio?.databaseStudyCount ?? "?"}`,
      n: portfolio?.matchedStudyCount ?? null,
      elapsedMs: null,
      round: 1
    });
  }

  if (intelligence) {
    const plan = intelligence.fetchPlan || ["intelligence"];
    trace.push({
      tool: plan.includes("cosmos_reconciliation")
        ? "cosmos_reconciliation"
        : plan.includes("cosmos_intel_full")
          ? "cosmos_intel_full"
          : "cosmos_default",
      label: "Clinical intelligence",
      ok: intelligence.source === "ora_clinical_intelligence" && !intelligence.error,
      detail:
        intelligence.error ||
        intelligence.query?.indication ||
        plan.join("→") ||
        "queried",
      n: intelligence.indicationBenchmark?.ora?.studyCount ?? null,
      elapsedMs: intelligence.elapsedMs ?? null,
      round: 1
    });
  }

  if (legacyAnterior) {
    trace.push({
      tool: "legacy_anterior",
      label: "Legacy anterior-segment",
      ok: !legacyAnterior.error,
      detail: legacyAnterior.error || legacyAnterior.note || "loaded",
      round: 1
    });
  }

  if (pricingScenarios) {
    trace.push({
      tool: "pricing_scenarios",
      label: "Past-bid pricing",
      ok: Boolean(pricingScenarios.tiers) && !pricingScenarios.error,
      detail: pricingScenarios.error || "tiers",
      round: 1
    });
  }

  if (buddyLiveContext) {
    trace.push({
      tool: "live_context",
      label: "Buddy live context",
      ok: Boolean(buddyLiveContext.text) && !buddyLiveContext.error,
      detail: buddyLiveContext.error || (buddyLiveContext.empty ? "empty" : "loaded"),
      round: 1
    });
  }

  if (buddyDeptContexts) {
    trace.push({
      tool: "dept_context",
      label: "Department playbook",
      ok: !buddyDeptContexts.error,
      detail: buddyDeptContexts.lens || "loaded",
      round: 1
    });
  }

  if (tools.has("web_search")) {
    trace.push({
      tool: "web_search",
      label: "Web search (public)",
      ok: true,
      detail: "planned for Foundry agent",
      round: 1
    });
  }

  return trace;
}

module.exports = {
  maybeHuntAndRetry,
  toolTraceFromPrefetch,
  mergeContext
};
