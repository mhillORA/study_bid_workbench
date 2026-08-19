/**
 * Progressive Cosmos fetch — load only what the intent router planned (tools[]).
 */

const {
  buildIntelligenceContext,
  buildReconciliationIntelContext,
  buildSlimBuddyIntelContext,
  isTrialhubQuestion,
  extractYearFromQuestion,
  extractTherapeuticFilterFromQuestion
} = require("./intelligence");

function toolSet(tools) {
  return new Set(Array.isArray(tools) ? tools : []);
}

/**
 * Fetch intelligence context per router tool plan.
 * @returns {Promise<object|null>}
 */
async function fetchBuddyIntelligence(getDb, opts = {}) {
  const {
    intelBase = {},
    routerTools = [],
    routerDepth = "fast",
    question = "",
    cosmosReconciliation = false
  } = opts;

  const tools = toolSet(routerTools);
  const started = Date.now();
  const fetchPlan = [];

  const wantsReconciliation =
    cosmosReconciliation || tools.has("cosmos_reconciliation");
  const wantsFullIntel = tools.has("cosmos_intel_full");
  const wantsAttachments = tools.has("attachments");
  const hasIndication = Boolean(intelBase.indication);

  if (wantsReconciliation) {
    fetchPlan.push("cosmos_reconciliation");
    const intel = await buildReconciliationIntelContext(getDb, intelBase);
    return finalizeIntel(intel, fetchPlan, started);
  }

  if (wantsFullIntel) {
    fetchPlan.push("cosmos_intel_full");
    const needsYearList =
      Boolean(extractYearFromQuestion(question)) ||
      Boolean(extractTherapeuticFilterFromQuestion(question)) ||
      isTrialhubQuestion(question);
    const intelTimeoutMs = Number(
      process.env.BUDDY_INTEL_TIMEOUT_MS ||
        (needsYearList ? 38000 : routerDepth === "fast" ? 20000 : 30000)
    );
    try {
      const intelPromise = buildIntelligenceContext(getDb, { ...intelBase, force: true });
      const intel = await Promise.race([
        intelPromise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`intelligence pack timed out after ${intelTimeoutMs}ms`)),
            intelTimeoutMs
          )
        )
      ]);
      return finalizeIntel(intel, fetchPlan, started);
    } catch (err) {
      fetchPlan.push("fallback_slim");
      const fallback = await buildSlimBuddyIntelContext(getDb, intelBase);
      if (fallback && !fallback.error) {
        fallback.note =
          (fallback.note || "") +
          ` Full intel timed out (${String(err.message || err)}); using slim inventory.`;
        return finalizeIntel(fallback, fetchPlan, started);
      }
      return {
        source: "ora_clinical_intelligence_error",
        error: String(err.message || err),
        fetchPlan,
        note: "Cosmos query failed — do not invent benchmarks."
      };
    }
  }

  // Attachment analyze: indication known → slim benchmark pack (not full reconciliation verb)
  if (wantsAttachments && hasIndication) {
    fetchPlan.push("attachment_indication_benchmark");
    const intel = await buildReconciliationIntelContext(getDb, intelBase);
    if (intel && !intel.error) {
      intel.attachedFrom = "cosmos_attachment_indication";
      intel.note =
        (intel.note || "") +
        " Progressive fetch: indication benchmark for attached doc analysis (not full reconciliation).";
    }
    return finalizeIntel(intel, fetchPlan, started);
  }

  if (tools.has("cosmos_default") || fetchPlan.length === 0) {
    fetchPlan.push("cosmos_slim_inventory");
    const intel = await buildSlimBuddyIntelContext(getDb, intelBase);
    return finalizeIntel(intel, fetchPlan, started);
  }

  return null;
}

function finalizeIntel(intel, fetchPlan, started) {
  if (!intel || typeof intel !== "object") return intel;
  if (!intel.error) {
    intel.fetchPlan = fetchPlan;
    intel.progressiveFetch = true;
    intel.elapsedMs = intel.elapsedMs ?? Date.now() - started;
    intel.attachedFrom = intel.attachedFrom || "cosmos_query";
    intel.note =
      intel.note ||
      "Queried live from Cosmos on this turn (progressive fetch). Prefer these numbers over invented benchmarks.";
  } else {
    intel.fetchPlan = fetchPlan;
  }
  return intel;
}

/** Load portfolio rollup only when router planned the portfolio tool. */
async function fetchBuddyPortfolio(buildPortfolioContext, { routerTools = [], hints = {} }) {
  const tools = toolSet(routerTools);
  if (!tools.has("portfolio")) {
    return {
      portfolio: {
        source: "cosmos_portfolio_skipped",
        skipped: true,
        progressiveFetch: true,
        note: "Portfolio skipped (progressive fetch) — not needed for this intent. Router can add portfolio tool on budget/hybrid/portfolio asks."
      },
      clientDirectory: []
    };
  }

  try {
    const portfolioFull = await buildPortfolioContext({ limit: 500 });
    let portfolio = portfolioFull;
    const clientDirectory = portfolioFull.clientNamesInDatabase || [];

    if (
      portfolioFull &&
      portfolioFull.source === "cosmos_portfolio" &&
      (hints.clientName || hints.year)
    ) {
      const filtered = await buildPortfolioContext({
        clientName: hints.clientName,
        year: hints.year,
        limit: 500
      });
      if (hints.clientName && filtered.matchedStudyCount === 0) {
        portfolio = {
          ...portfolioFull,
          filters: {
            ...(portfolioFull.filters || {}),
            clientNameRequested: hints.clientName,
            year: hints.year || null,
            matched: false
          },
          note: `No studies matched client filter "${hints.clientName}". Showing full database portfolio.`,
          progressiveFetch: true
        };
      } else {
        portfolio = { ...filtered, progressiveFetch: true };
      }
    } else if (portfolio && typeof portfolio === "object") {
      portfolio.progressiveFetch = true;
    }

    return { portfolio, clientDirectory, portfolioFull };
  } catch (err) {
    return {
      portfolio: {
        source: "cosmos_portfolio_error",
        error: String(err.message || err),
        progressiveFetch: true
      },
      clientDirectory: [],
      portfolioFull: null
    };
  }
}

module.exports = {
  fetchBuddyIntelligence,
  fetchBuddyPortfolio
};
