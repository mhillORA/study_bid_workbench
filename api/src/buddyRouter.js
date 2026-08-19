/**
 * Buddy intent router — single structured decision for each /api/ask turn.
 * Replaces scattered regex gates in index.js with { intent, tools, depth, flags }.
 */

const { inferModelTier } = require("./askClaude");
const { isPricingQuestion } = require("./rfpPricing");
const {
  isIntelligenceQuestion,
  isSourceOverviewQuestion,
  isTrialhubQuestion,
  isCtgovQuestion,
  isVeevaQuestion,
  isSalesforceDataQuestion,
  extractYearFromQuestion,
  extractTherapeuticFilterFromQuestion
} = require("./intelligence");
const { wantsHtmlVisual, isLegacyTableAsk, isLegacyAnteriorQuestion, isLegacyOverviewQuestion, userConsentedLegacyEnrollment } = require("./legacyAnterior");
const { wantsDocumentExport } = require("./buddyDocExport");

function reconcileVerbInQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (
    /\b(reconcil\w*|fact\s*check|fact[-\s]*check|verify|verification|validate|validation|confirm|accurate|accuracy)\b/.test(
      q
    )
  ) {
    return true;
  }
  if (
    /\b(compare|comparison|contrast|cross[-\s]?check|match|check against|benchmark against)\b/.test(q) &&
    /\b(cosmos|ora|our data|internal data|database|trialhub|ct\.?\s*gov|veeva|benchmark|intelligence|intel)\b/.test(
      q
    )
  ) {
    return true;
  }
  if (/\bagainst\s+(our\s+)?(data|cosmos|ora|database|benchmarks?|internal)\b/.test(q)) {
    return true;
  }
  if (/\b(cosmos|ora)\s+(reconcil\w*|data|intel|intelligence|benchmarks?)\b/.test(q)) {
    return true;
  }
  return false;
}

function assistantAskedToReconcile(history) {
  const turns = Array.isArray(history) ? history : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    if (String(turns[i]?.role || "").toLowerCase() !== "assistant") continue;
    const t = String(turns[i].content || "").toLowerCase();
    if (
      /\breconcil\w*\b/.test(t) &&
      /\b(cosmos|ora|our data|database|trialhub|ct\.?\s*gov|intel|intelligence|benchmark)\b/.test(t)
    ) {
      return true;
    }
    if (
      /\b(verify|fact[-\s]?check|cross[-\s]?check|compare)\b/.test(t) &&
      /\b(cosmos|ora|attachment|document|upload|our data|database)\b/.test(t)
    ) {
      return true;
    }
    if (/\b(say|reply|type|send)\b.{0,40}\b(reconcil\w*|verify)\b/.test(t)) {
      return true;
    }
    return false;
  }
  return false;
}

function historyHasAttachmentCue(history) {
  const turns = Array.isArray(history) ? history : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    if (String(turns[i]?.role || "").toLowerCase() !== "user") continue;
    const t = String(turns[i].content || "");
    if (/\n\n📎\s/.test(t) || /\battached file/i.test(t)) return true;
  }
  return false;
}

function isAffirmativeFollowUp(question) {
  return /^(yes|yep|yeah|sure|ok|okay|go ahead|please do|do it|proceed|sounds good)\.?$/i.test(
    String(question || "").trim()
  );
}

function isAttachmentCosmosCompareAsk(question, hasOkUpload, history, body) {
  const reconcileVerb = reconcileVerbInQuestion(question);
  const priorAttachments = Array.isArray(body?.priorAttachments) && body.priorAttachments.length > 0;
  const pendingReconcile = body?.pendingTask?.type === "reconcile";
  const reconcileFollowUp =
    body?.reconcileFollowUp === true ||
    pendingReconcile ||
    (reconcileVerb &&
      !hasOkUpload &&
      (priorAttachments || assistantAskedToReconcile(history) || historyHasAttachmentCue(history)));

  if (reconcileFollowUp) return { yes: true, reconcileFollowUp: true };

  if (!hasOkUpload) return { yes: false, reconcileFollowUp: false };

  const q = String(question || "").toLowerCase();
  if (
    /\b(cosmos|trialhub|ct\.?\s*gov|veeva|our data|internal data|ora data|ora intel|database)\b/.test(q)
  ) {
    return { yes: true, reconcileFollowUp: false };
  }
  if (reconcileVerb) return { yes: true, reconcileFollowUp: false };
  return { yes: false, reconcileFollowUp: false };
}

function inferMoneyIntent(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return null;
  const publicCue =
    /\b(their|company|corporate|market\s*cap|10-?k|sec\s*filing|biggest\s+pharma|largest\s+(pharma|biotech)|public(ly)?\s+trad|wall\s*street)\b/.test(
      q
    );
  const oraCue =
    /\b(we(?:'ve| have)?\s+(?:made|earned|billed|won)|our\s+(?:revenue|fees|billings)|how much (?:we|we've|ora)|ora(?:'s)?\s+(?:revenue|fees)|made off|rank(?:ed)? by (?:revenue|fees|dollars)|by (?:revenue|fees).{0,40}(?:client|sponsor|stud)|(?:client|sponsor)s?.{0,40}by (?:revenue|fees)|studies?\s+(?:we(?:'ve| have)?\s+)?(?:run|done|worked).{0,80}(?:revenue|fees)|(?:revenue|fees).{0,80}studies?\s+(?:with|we|we've))\b/.test(
      q
    ) ||
    (/\b(revenue|fees|billings|dollars|spend|billed)\b/.test(q) &&
      /\b(studies?|clients?|sponsors?|portfolio|by client|each|concentration|rank)\b/.test(q) &&
      !publicCue) ||
    (/\b(top|biggest|largest|rank(?:ed)?|concentration)\b.{0,40}\b(client|sponsor)s?\b/.test(q) &&
      /\b(revenue|fees|dollars|billings|money|spend|paid|pay)\b/.test(q) &&
      !publicCue) ||
    /\b(who\s+pays\s+us|pays?\s+us\s+the\s+most|client\s+concentration)\b/.test(q);
  if (oraCue && !publicCue) return "ora_earned";
  if (publicCue) return "public_company";
  return null;
}

function inferBuddyWorkflow(question, body = {}) {
  const forced = String(body.buddyWorkflow || body.workflow || "")
    .toLowerCase()
    .trim();
  if (forced === "budget" || forced === "feasibility" || forced === "teach") return forced;

  const q = String(question || "").toLowerCase();
  if (!q) return "auto";

  if (
    /^(remember|learn|save(?:\s+this|\s+that)?|add to (?:buddy )?context|teach buddy)\b/i.test(q) ||
    /\b(remember this|learn this|save (?:this|that) (?:to|for) (?:buddy )?context|add to (?:the )?playbook|keep this in (?:buddy )?context)\b/i.test(
      q
    )
  ) {
    return "teach";
  }

  const feasCue =
    isIntelligenceQuestion(question) ||
    /\b(feasib|psm|patients?\s*per\s*site|site (?:mix|slate|selection|performance)|competing trials?|trialhub|ct\.?\s*gov|scorecard|enrollment rate|recruit(?:ment)? rate|win themes?)\b/i.test(
      q
    );

  const budgetCue =
    isPricingQuestion(question) ||
    /\b(hlbp|ballpark|budget|quote|rfp|pricing|internal budget|service fees?|pass[- ]?through|line items?|drivers?|grand total|opportunity)\b/i.test(
      q
    ) ||
    /\b(create|new)\s+(study|draft|opportunity|hlbp)\b/i.test(q) ||
    /\b(set|fill|change|update|apply)\b.{0,50}\b(enrolled|screened|core sites|enrollment months|driver|field|notes)\b/i.test(
      q
    );

  if (feasCue && !budgetCue) return "feasibility";
  if (budgetCue && !feasCue) return "budget";
  if (feasCue && budgetCue) {
    const hasFeasTerms = /\b(feasib|psm|site slate|competing|trialhub|scorecard|win themes?|enrollment rate)\b/i.test(
      q
    );
    const hasBudgetTerms = /\b(budget|hlbp|ballpark|pricing|rfp|quote|service fees?|internal budget|grand total)\b/i.test(
      q
    );
    if (hasFeasTerms && hasBudgetTerms) return "hybrid";
    if (/\b(feasib|psm|site slate|competing|trialhub|scorecard|win themes?)\b/i.test(q)) {
      return "feasibility";
    }
    if (/\b(budget|hlbp|ballpark|pricing|rfp|quote|service fees?|internal budget)\b/i.test(q)) {
      return "budget";
    }
  }
  return "auto";
}

function lastAssistantAskedForFill(history) {
  const turns = Array.isArray(history) ? history : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    if (String(turns[i]?.role || "").toLowerCase() !== "assistant") continue;
    const t = String(turns[i].content || "").toLowerCase();
    if (assistantAskedToReconcile(t)) return false;
    return (
      /\bwhat i need\b/.test(t) ||
      /\bi will autofill\b/.test(t) ||
      /\bi will fill\b/.test(t) ||
      /\bi(?:'|')ll fill\b/.test(t) ||
      /\bstill need/.test(t) ||
      /\b(give me|send me|tell me)\b.{0,80}\b(client|sponsor|indication|phase|enrolled|details|info)\b/.test(t)
    );
  }
  return false;
}

function isCompareTwoStudiesQuestion(question, body = {}) {
  if (Array.isArray(body.compareStudyIds) && body.compareStudyIds.filter(Boolean).length >= 2) {
    return true;
  }
  if (body.compareMode === true) return true;
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  if (/\b(ora\s+vs\.?\s+industry|vs\.?\s+industry|industry\s+psm)\b/.test(q)) return false;
  const twoIds = (String(question).match(/\b(O-\d{3,})\b/gi) || []).length >= 2;
  return (
    /\b(these two studies|two studies|both studies)\b/.test(q) ||
    (/\bwhat(?:'s|s| is) different\b/.test(q) && (/\bstud/.test(q) || twoIds)) ||
    /\b(differences? between|differ from|how (?:do they|does this) differ)\b/.test(q) ||
    /\bcompare\b.{0,60}\bstud(y|ies)\b/.test(q) ||
    /\bthis (?:study|one)\b.{0,50}\b(vs\.?|versus|compared to|different from)\b/.test(q) ||
    (twoIds && /\b(compar|differ|vs\.?|versus|delta)\b/.test(q))
  );
}

function isCrossStudyQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  if (isCompareTwoStudiesQuestion(question)) return false;
  if (
    /\b(all studies|across (all )?studies|every study|entire portfolio|whole portfolio|portfolio)\b/.test(q) ||
    /\b(across|among|between)\b.{0,40}\bstudies\b/.test(q) ||
    /\b(how many studies|which study|which studies|largest study|biggest study|most expensive|highest budget)\b/.test(q) ||
    /\b(largest|biggest|highest|top)\b.{0,40}\b(budget|fee|enrollment|study|studies|client|sponsor)\b/.test(q) ||
    /\b(average|avg|mean|median|total|sum|rollup)\b.{0,60}\b(across|all|every|portfolio|studies)\b/.test(q) ||
    /\b(enroll|patient|subject|budget|fee).{0,40}\b(across|all studies|every study)\b/.test(q) ||
    /\bstudies\b.{0,40}\b(last year|this year|in 20\d{2}|overall|combined)\b/.test(q) ||
    /\b(client|sponsor)\s+concentration\b/.test(q) ||
    /\b(rank|ranking|leaderboard)\b.{0,40}\b(client|sponsor|fees?|revenue)\b/.test(q) ||
    /\b(by\s+year|year\s+over\s+year|yoy|ingest(?:ion)?\s+freshness|what(?:'s| is) in (?:the )?(?:db|database|cosmos))\b/.test(
      q
    )
  ) {
    return true;
  }
  return false;
}

function isCatalogAsk(question) {
  return /\b(what(?:'s| is) in (?:the )?(?:db|database|cosmos)|data\s+catalog|container\s+counts?|ingest(?:ion)?\s+freshness|how many (?:trials|studies|sites) (?:in|does) (?:cosmos|the db|the database))\b/i.test(
    String(question || "")
  );
}

function isAttachmentAnalyzeVerb(question, hasOkUpload) {
  return (
    hasOkUpload &&
    /\b(analyze|analyse|review|read|summarize|summarise|what does|what'?s in|what is in|explain|extract|check|look at|go through|tell me about|describe|assess|evaluate)\b/i.test(
      question
    )
  );
}

function pickPrimaryIntent(ctx) {
  const {
    workflow,
    cosmosReconciliation,
    compareAsk,
    fillFollowUp,
    docExportAsk,
    hasOkUpload,
    attachmentAnalyzeVerb,
    answerFocus,
    pendingTask
  } = ctx;

  if (workflow === "teach") return "teach";
  if (cosmosReconciliation) return "reconcile";
  if (compareAsk) return "compare_studies";
  if (fillFollowUp || pendingTask?.type === "fill" || pendingTask?.type === "hlbp") return "fill_fields";
  if (docExportAsk) return "document_export";
  if (workflow === "hybrid") return "hybrid";
  if (workflow === "budget") return "budget";
  if (workflow === "feasibility") return "feasibility";
  if (hasOkUpload && attachmentAnalyzeVerb) return "analyze_attachment";
  if (answerFocus === "portfolio") return "portfolio";
  if (hasOkUpload) return "analyze_attachment";
  if (answerFocus === "single_study") return "single_study";
  return "general";
}

function wantsLegacyAnteriorFetch(ctx) {
  const { question, body = {}, history = [], compareAsk, workflow } = ctx;
  if (compareAsk || workflow === "budget" || workflow === "teach") return false;
  const legacyHint = body.legacyHint && typeof body.legacyHint === "object" ? body.legacyHint : {};
  const legacyOverviewAsk = isLegacyOverviewQuestion(question);
  const enrollmentConsent =
    body.includeLegacyEnrollment === true ||
    body.useLegacyEnrollment === true ||
    userConsentedLegacyEnrollment(question, history) ||
    isLegacyTableAsk(question) ||
    legacyOverviewAsk ||
    (wantsHtmlVisual(question) && isLegacyAnteriorQuestion(question));
  return (
    isLegacyAnteriorQuestion(question) ||
    isLegacyTableAsk(question) ||
    legacyOverviewAsk ||
    Boolean(
      legacyHint.siteName ||
        legacyHint.studyName ||
        legacyHint.siteId ||
        legacyHint.studyId
    ) ||
    Boolean(body.legacyPack && body.legacyPack.source === "legacy_anterior_segment") ||
    enrollmentConsent
  );
}

function inferSuggestedPendingTask(ctx) {
  const {
    intent,
    hasOkUpload,
    reconcileFollowUp,
    fillFollowUp,
    docExportAsk,
    visualAsk,
    cosmosReconciliation
  } = ctx;
  if (cosmosReconciliation || reconcileFollowUp || intent === "reconcile") {
    return { type: "reconcile", source: "router" };
  }
  if (fillFollowUp || intent === "fill_fields") {
    return { type: "fill", source: "router" };
  }
  if (hasOkUpload && (intent === "analyze_attachment" || intent === "reconcile")) {
    return { type: "analyze", source: "router" };
  }
  if (docExportAsk || (visualAsk && hasOkUpload)) {
    return { type: "report", source: "router" };
  }
  if (
    (intent === "budget" || ctx.pendingTask?.type === "hlbp") &&
    ctx.buddyMode === "do" &&
    (fillFollowUp || ctx.pendingTask?.type === "hlbp")
  ) {
    return { type: "hlbp", source: "router" };
  }
  return null;
}

function pickTools(ctx) {
  const {
    intent,
    workflow,
    cosmosReconciliation,
    compareAsk,
    skipHeavyPortfolio,
    needsFullIntel,
    visualAsk,
    moneyIntent,
    hasOkUpload,
    buddyMode
  } = ctx;
  const tools = new Set(["cosmos_default"]);

  if (cosmosReconciliation || intent === "reconcile") {
    tools.add("cosmos_reconciliation");
  } else if (needsFullIntel || workflow === "feasibility" || workflow === "hybrid") {
    tools.add("cosmos_intel_full");
  }
  if (hasOkUpload) tools.add("attachments");
  if (moneyIntent === "ora_earned") {
    tools.add("portfolio");
  } else if (
    !skipHeavyPortfolio &&
    (workflow === "budget" || workflow === "hybrid" || intent === "portfolio")
  ) {
    tools.add("portfolio");
  }
  if (compareAsk || intent === "compare_studies") tools.add("study_compare");
  if (workflow === "budget" || workflow === "hybrid" || isPricingQuestion(ctx.question)) {
    tools.add("pricing_scenarios");
  }
  if (wantsLegacyAnteriorFetch(ctx)) tools.add("legacy_anterior");
  if (intent === "fill_fields" && buddyMode === "do") tools.add("study_apply");
  if (visualAsk || intent === "document_export") tools.add("html_export");
  if (workflow === "teach" || intent === "teach") tools.add("live_context");
  if (
    /\b(buddy context|live context|what(?:'s| is) (?:in|already in) (?:buddy|the) context|summarize (?:buddy )?context)\b/i.test(
      String(ctx.question || "")
    )
  ) {
    tools.add("live_context");
  }
  if (moneyIntent === "public_company") tools.add("web_search");
  tools.add("dept_context");

  return [...tools];
}

function computeAnswerFocus(ctx) {
  const { compareAsk, workflow, attachmentDriven, forcePortfolio, crossStudy, studyId, body } = ctx;
  if (compareAsk) return "compare";
  if (workflow === "teach") return "teach";
  if (workflow === "feasibility") return "feasibility";
  if (attachmentDriven) {
    return studyId || body.studySnapshot ? "single_study" : "attachments";
  }
  if (forcePortfolio || crossStudy) return "portfolio";
  return studyId || body.studySnapshot ? "single_study" : "portfolio";
}

/**
 * Route a Buddy ask. Pass hints after portfolio/client directory is available for full routing.
 * @returns {{ intent, tools, depth, workflow, flags, answerFocus?, reasons, confidence }}
 */
function routeBuddyAsk(input) {
  const {
    question,
    body = {},
    history = [],
    hasOkUpload = false,
    hints = null
  } = input;

  const reasons = [];
  const buddyMode = String(body.buddyMode || "chat").toLowerCase() === "do" ? "do" : "chat";
  const workflow = inferBuddyWorkflow(question, body);
  const moneyIntent = inferMoneyIntent(question);
  const reconcile = isAttachmentCosmosCompareAsk(question, hasOkUpload, history, body);
  const cosmosReconciliation = reconcile.yes;
  const reconcileFollowUp = reconcile.reconcileFollowUp;
  const compareAsk = isCompareTwoStudiesQuestion(question, body);
  const externalFeedAsk =
    isSourceOverviewQuestion(question) ||
    isTrialhubQuestion(question) ||
    isCtgovQuestion(question) ||
    isVeevaQuestion(question);
  const catalogAsk = isCatalogAsk(question);
  const attachmentAnalyzeVerb = isAttachmentAnalyzeVerb(question, hasOkUpload);
  const depth = inferModelTier(question, body, workflow);
  const pendingTask = body.pendingTask && body.pendingTask.type ? body.pendingTask : null;

  const skipHeavyPortfolio =
    workflow === "teach" ||
    depth === "fast" ||
    ((externalFeedAsk || catalogAsk) &&
      workflow !== "budget" &&
      workflow !== "hybrid" &&
      !isPricingQuestion(question) &&
      moneyIntent !== "ora_earned" &&
      !/\b(portfolio|budget|fee|revenue|hlbp|ballpark|bid|pricing)\b/i.test(question));

  if (skipHeavyPortfolio) reasons.push("skip_heavy_portfolio");
  if (cosmosReconciliation) reasons.push("cosmos_reconciliation");
  if (reconcileFollowUp) reasons.push("reconcile_follow_up");
  if (compareAsk) reasons.push("compare_two_studies");
  if (workflow === "hybrid") reasons.push("hybrid_workflow");

  const fillFollowUp =
    buddyMode === "do" &&
    !cosmosReconciliation &&
    (Boolean(body.fillFollowUp) ||
      lastAssistantAskedForFill(history) ||
      pendingTask?.type === "fill" ||
      pendingTask?.type === "hlbp");

  const visualAsk =
    !attachmentAnalyzeVerb &&
    (wantsHtmlVisual(question) ||
      wantsDocumentExport(question) ||
      (hasOkUpload && /\b(create|make|produce|build|generate|draft|export|write)\b/i.test(question)));
  const docExportAsk =
    !attachmentAnalyzeVerb && (wantsDocumentExport(question) || Boolean(visualAsk && hasOkUpload));

  const early = {
    workflow,
    moneyIntent,
    depth,
    skipHeavyPortfolio,
    externalFeedAsk,
    catalogAsk,
    cosmosReconciliation,
    reconcileFollowUp,
    compareAsk,
    attachmentAnalyzeVerb,
    fillFollowUp,
    visualAsk,
    docExportAsk,
    buddyMode,
    pendingTask
  };

  if (!hints) {
    return {
      phase: "early",
      ...early,
      reasons
    };
  }

  const attachmentDriven = hasOkUpload;
  const crossStudy =
    !compareAsk &&
    !attachmentDriven &&
    (Boolean(hints.crossStudy) ||
      isCrossStudyQuestion(question) ||
      body.noStudy === true ||
      moneyIntent === "ora_earned");
  const forcePortfolio =
    !compareAsk &&
    workflow !== "teach" &&
    workflow !== "feasibility" &&
    !attachmentDriven &&
    (body.noStudy === true ||
      Boolean(hints.crossStudy) ||
      moneyIntent === "ora_earned" ||
      (!body.studyId && !body.studySnapshot));

  const studyId = forcePortfolio
    ? (String(question).match(/\b(O-\d{3,})\b/i) || [])[1] || null
    : hints.studyId;

  const answerFocus = computeAnswerFocus({
    compareAsk,
    workflow,
    attachmentDriven,
    forcePortfolio,
    crossStudy,
    studyId,
    body
  });

  const needsFullIntel =
    externalFeedAsk ||
    isSalesforceDataQuestion(question) ||
    catalogAsk ||
    isIntelligenceQuestion(question) ||
    wantsDocumentExport(question) ||
    wantsHtmlVisual(question) ||
    isPricingQuestion(question) ||
    Boolean(String(question).match(/\b(NCT\d{8})\b/i)) ||
    Boolean(extractYearFromQuestion(question)) ||
    Boolean(extractTherapeuticFilterFromQuestion(question)) ||
    isTrialhubQuestion(question) ||
    workflow === "feasibility" ||
    workflow === "hybrid" ||
    cosmosReconciliation;

  const routeCtx = {
    question,
    workflow,
    cosmosReconciliation,
    compareAsk,
    fillFollowUp,
    docExportAsk,
    hasOkUpload,
    attachmentAnalyzeVerb,
    answerFocus,
    pendingTask,
    skipHeavyPortfolio,
    needsFullIntel,
    visualAsk,
    moneyIntent,
    buddyMode
  };

  const intent = pickPrimaryIntent(routeCtx);
  const tools = pickTools({ ...routeCtx, question, body, history, compareAsk, workflow });
  const suggestedPendingTask = inferSuggestedPendingTask({
    ...routeCtx,
    intent,
    reconcileFollowUp,
    cosmosReconciliation,
    pendingTask
  });

  let confidence = "high";
  if (workflow === "auto" && intent === "general") confidence = "medium";
  if (intent === "analyze_attachment" && cosmosReconciliation) confidence = "high";
  if (pendingTask?.type && !reconcileVerbInQuestion(question) && !isAffirmativeFollowUp(question)) {
    if (pendingTask.type === "reconcile" && intent === "reconcile") confidence = "high";
  }

  return {
    phase: "full",
    intent,
    tools,
    depth,
    workflow,
    moneyIntent,
    buddyMode,
    answerFocus,
    studyId,
    forcePortfolio,
    crossStudy,
    compareAsk,
    cosmosReconciliation,
    reconcileFollowUp,
    attachmentAnalyzeVerb,
    attachmentDriven,
    fillFollowUp,
    skipHeavyPortfolio,
    externalFeedAsk,
    catalogAsk,
    needsFullIntel,
    visualAsk,
    docExportAsk,
    pendingTask,
    suggestedPendingTask,
    confidence,
    reasons: [...reasons, `intent=${intent}`, `tools=${tools.join(",")}`]
  };
}

module.exports = {
  routeBuddyAsk,
  isCompareTwoStudiesQuestion,
  isCrossStudyQuestion,
  inferBuddyWorkflow,
  inferMoneyIntent,
  isAttachmentCosmosCompareAsk,
  lastAssistantAskedForFill,
  reconcileVerbInQuestion,
  inferSuggestedPendingTask,
  wantsLegacyAnteriorFetch
};
