/**
 * Evidence envelope — every Buddy turn exposes sources, gaps, and a next ask.
 * Keeps answers accountable: numbers must come from packs, not vibes.
 */

function sourceRow(id, label, ok, detail = null, meta = {}) {
  return {
    id,
    label,
    ok: Boolean(ok),
    detail: detail || null,
    n: meta.n != null ? meta.n : null,
    indication: meta.indication || null,
    country: meta.country || null,
    elapsedMs: meta.elapsedMs != null ? meta.elapsedMs : null
  };
}

function buildSourcesFromContext(ctx = {}, toolTrace = []) {
  const sources = [];
  const intel = ctx.intelligence;
  const portfolio = ctx.portfolio;
  const legacy = ctx.legacyAnterior;
  const pricing = ctx.pricingScenarios;
  const live = ctx.buddyLiveContext;
  const depts = ctx.buddyDeptContexts;
  const uploaded = ctx.uploadedDocuments;
  const compare = ctx.studyComparison;

  if (uploaded?.count > 0) {
    sources.push(
      sourceRow(
        "attachments",
        "Attached documents",
        uploaded.okCount > 0,
        `${uploaded.okCount || 0}/${uploaded.count} readable · ${(uploaded.totalChars || 0).toLocaleString()} chars`
      )
    );
  }

  if (portfolio && !portfolio.skipped) {
    const ok = portfolio.source === "cosmos_portfolio" && !portfolio.error;
    sources.push(
      sourceRow(
        "portfolio",
        "Ora portfolio (Cosmos)",
        ok,
        ok
          ? `matched ${portfolio.matchedStudyCount ?? "?"} / ${portfolio.databaseStudyCount ?? "?"}`
          : portfolio.error || portfolio.note || "unavailable",
        { n: portfolio.matchedStudyCount ?? portfolio.databaseStudyCount ?? null }
      )
    );
  } else if (portfolio?.skipped) {
    sources.push(
      sourceRow("portfolio", "Ora portfolio (Cosmos)", false, "skipped — not needed for this intent")
    );
  }

  if (intel) {
    const ok = intel.source === "ora_clinical_intelligence" && !intel.error;
    const q = intel.query || {};
    const siteN =
      intel.indicationBenchmark?.sites?.topSitesByPsm?.length ||
      intel.indicationBenchmark?.sites?.topSites?.length ||
      intel.indicationBenchmark?.ora?.studyCount ||
      null;
    sources.push(
      sourceRow(
        "intelligence",
        "Ora clinical intelligence",
        ok,
        ok
          ? [
              q.indication || null,
              q.country || null,
              intel.attachedFrom || intel.fetchPlan?.join("→") || null
            ]
              .filter(Boolean)
              .join(" · ") || "queried"
          : intel.error || intel.note || "unavailable",
        {
          n: siteN,
          indication: q.indication || null,
          country: q.country || null,
          elapsedMs: intel.elapsedMs ?? null
        }
      )
    );
  }

  if (legacy) {
    sources.push(
      sourceRow(
        "legacy_anterior",
        "Legacy anterior-segment",
        legacy.source === "legacy_anterior_segment" && !legacy.error,
        legacy.error || legacy.note || null
      )
    );
  }

  if (pricing) {
    sources.push(
      sourceRow(
        "pricing",
        "Past-bid pricing scenarios",
        Boolean(pricing.tiers) && !pricing.error,
        pricing.error || (pricing.tiers ? "tiers attached" : "no tiers")
      )
    );
  }

  if (compare && !compare.needIds) {
    sources.push(
      sourceRow(
        "study_compare",
        "Two-study comparison",
        !compare.error,
        compare.error || `${compare.leftStudyId || "?"} vs ${compare.rightStudyId || "?"}`
      )
    );
  }

  if (live) {
    sources.push(
      sourceRow(
        "live_context",
        "Buddy live context",
        Boolean(live.text) && !live.error,
        live.error || (live.empty ? "empty" : "SME notes attached")
      )
    );
  }

  if (depts && !depts.error) {
    sources.push(
      sourceRow(
        "dept_playbook",
        "Department playbook",
        true,
        depts.lens === "auto"
          ? `auto · ${(depts.departments || []).filter((d) => d.hasContent).length} depts with content`
          : `${depts.activeDept?.name || depts.lens}${depts.activeDept?.hasContent ? "" : " (thin)"}`
      )
    );
  }

  if (ctx.moneyIntent === "public_company" || (ctx.router?.tools || []).includes("web_search")) {
    sources.push(
      sourceRow(
        "web_search",
        "Web search (public facts)",
        true,
        "Foundry agent may search — not for Ora earned fees"
      )
    );
  }

  for (const step of toolTrace || []) {
    if (!step || sources.some((s) => s.id === step.tool)) continue;
    sources.push(
      sourceRow(step.tool, step.label || step.tool, step.ok !== false, step.detail || null, {
        n: step.n,
        elapsedMs: step.elapsedMs
      })
    );
  }

  return sources;
}

function buildGapsFromContext(ctx = {}, question = "") {
  const gaps = [];
  const q = String(question || "");
  const intel = ctx.intelligence;
  const portfolio = ctx.portfolio;
  const intent = ctx.router?.intent || ctx.answerFocus;

  if (intel?.error) {
    gaps.push({
      code: "intel_error",
      message: `Intelligence query failed: ${intel.error}`,
      severity: "high"
    });
  }
  if (
    (intent === "feasibility" || intent === "reconcile" || intent === "hybrid") &&
    intel &&
    !intel.error &&
    !intel.query?.indication &&
    !/\b(nct\d{8}|what(?:'s| is) in|catalog|inventory)\b/i.test(q)
  ) {
    gaps.push({
      code: "no_indication",
      message: "No indication resolved — PSM/site benchmarks need an indication (e.g. Dry Eye).",
      severity: "medium"
    });
  }
  if (intel && !intel.error && intel.indicationBenchmark) {
    const ora = intel.indicationBenchmark.ora;
    const siteRows =
      intel.indicationBenchmark.sites?.topSitesByPsm ||
      intel.indicationBenchmark.sites?.topSites ||
      [];
    if (ora && ora.studyCount === 0 && !siteRows.length) {
      gaps.push({
        code: "empty_benchmark",
        message: "No Ora Veeva rows for this indication/geo — do not invent PSM or site names.",
        severity: "high"
      });
    }
  }
  if (portfolio?.error) {
    gaps.push({
      code: "portfolio_error",
      message: `Portfolio query failed: ${portfolio.error}`,
      severity: "high"
    });
  }
  if (portfolio?.filters?.matched === false && portfolio?.filters?.clientNameRequested) {
    gaps.push({
      code: "client_unmatched",
      message: `No studies matched client "${portfolio.filters.clientNameRequested}" — showing full portfolio context instead.`,
      severity: "medium"
    });
  }
  if (ctx.cosmosReconciliation && !(ctx.uploadedDocuments?.okCount > 0)) {
    gaps.push({
      code: "reconcile_no_doc",
      message: "Reconcile requested but no readable attachment text — re-attach the file.",
      severity: "high"
    });
  }
  if (ctx.buddyDeptContexts?.activeDept && !ctx.buddyDeptContexts.activeDept.hasContent) {
    gaps.push({
      code: "thin_playbook",
      message: `Department playbook for ${ctx.buddyDeptContexts.activeDept.name || ctx.buddyDept} is thin — ask 1–2 learning questions, don't invent process.`,
      severity: "low"
    });
  }
  if (ctx.studyComparison?.needIds) {
    gaps.push({
      code: "compare_need_ids",
      message: "Two-study compare needs two O-ids or Studies-tab checkboxes.",
      severity: "medium"
    });
  }
  return gaps;
}

function suggestNextAsk(ctx = {}, gaps = []) {
  const codes = new Set(gaps.map((g) => g.code));
  if (codes.has("reconcile_no_doc")) return "Re-attach the document, then say “reconcile”.";
  if (codes.has("no_indication")) return "Name the indication (and country if it matters).";
  if (codes.has("compare_need_ids")) return "Give two O-ids or check two studies on the Studies tab.";
  if (codes.has("empty_benchmark")) {
    return "Try a sister indication, broaden to Global, or ask for TrialHub/CT.gov landscape only.";
  }
  if (codes.has("client_unmatched")) return "Confirm the client/sponsor spelling as it appears in Cosmos.";
  if (codes.has("thin_playbook")) return "Tell Buddy how your dept works here (Teach mode) so next answers improve.";
  if (ctx.cosmosReconciliation) return "Ask about a specific claim in the doc, or switch to Do to fill fields.";
  if (ctx.answerFocus === "portfolio") return "Ask a follow-up by year, client, or “go deeper” for the full list.";
  if (ctx.workflow === "feasibility") return "Ask for a site slate, competing trials, or a feasibility report.";
  return null;
}

function answerLooksWeak(answer) {
  const a = String(answer || "").toLowerCase();
  if (!a.trim()) return true;
  if (/could not complete|internal error|try again|timed out|timeout|not configured/.test(a)) {
    return true;
  }
  if (/don't have|do not have|cannot find|not in (the )?cosmos|no data|i need a bit more/.test(a)) {
    return true;
  }
  if (a.length < 80 && !/\d/.test(a)) return true;
  return false;
}

/**
 * Detect whether a second hunt round is warranted after the first model answer.
 */
function shouldHuntAgain({ answer, context, toolTrace }) {
  const gaps = buildGapsFromContext(context, "");
  const highGaps = gaps.filter((g) => g.severity === "high");
  if (highGaps.length && answerLooksWeak(answer)) return { yes: true, reason: "high_gaps_weak_answer" };
  if (answerLooksWeak(answer) && (toolTrace || []).some((t) => t.ok === false)) {
    return { yes: true, reason: "tool_failure_weak_answer" };
  }
  const intent = context?.router?.intent;
  if (
    (intent === "feasibility" || intent === "reconcile" || intent === "hybrid") &&
    answerLooksWeak(answer) &&
    context?.intelligence &&
    !context.intelligence.error &&
    !context.intelligence.query?.indication
  ) {
    return { yes: true, reason: "feasibility_no_indication" };
  }
  return { yes: false, reason: null };
}

/**
 * Soft verifier: flag invented-looking certainty when packs are empty/error.
 * Does not rewrite prose aggressively — adds warnings into evidence.
 */
function verifyGrounding({ answer, context }) {
  const warnings = [];
  const a = String(answer || "");
  const intel = context?.intelligence;
  const emptyBench =
    intel &&
    !intel.error &&
    intel.indicationBenchmark &&
    (intel.indicationBenchmark.ora?.studyCount === 0 ||
      (!intel.indicationBenchmark.sites?.topSitesByPsm?.length &&
        !intel.indicationBenchmark.sites?.topSites?.length));

  if (emptyBench || intel?.error) {
    if (/\bpsm\b/i.test(a) && /\b0\.\d{2,}\b/.test(a) && !/missing|null|n\s*=\s*0|no ora/i.test(a)) {
      warnings.push({
        code: "psm_without_pack",
        message: "Answer cites PSM but intelligence pack is empty/errored — treat as unverified."
      });
    }
  }

  if (context?.moneyIntent === "ora_earned") {
    if (/\b(chf|billion|market\s*cap|10-?k)\b/i.test(a) && !/ora|portfolio|service fees?|we (?:made|earned)/i.test(a)) {
      warnings.push({
        code: "public_money_on_ora_ask",
        message: "ora_earned ask — public corporate revenue language may be mixed in; prefer portfolio.byClient."
      });
    }
  }

  return { warnings, grounded: warnings.length === 0 };
}

/**
 * Collect numeric tokens that appear in tool/context packs (allowed set).
 */
function allowedNumbersFromContext(context = {}) {
  const allowed = new Set();
  const add = (v) => {
    if (v == null || v === "") return;
    const n = Number(v);
    if (Number.isFinite(n)) {
      allowed.add(String(n));
      allowed.add(n.toFixed(2).replace(/\.?0+$/, ""));
      allowed.add(String(Math.round(n * 100) / 100));
    }
    const s = String(v);
    const m = s.match(/-?\d+(?:\.\d+)?/g);
    if (m) m.forEach((x) => allowed.add(x));
  };

  const walk = (obj, depth = 0) => {
    if (obj == null || depth > 8) return;
    if (typeof obj === "number") {
      add(obj);
      return;
    }
    if (typeof obj === "string") {
      if (obj.length < 40) add(obj);
      return;
    }
    if (Array.isArray(obj)) {
      obj.slice(0, 80).forEach((x) => walk(x, depth + 1));
      return;
    }
    if (typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        if (/note|prompt|error|text|html/i.test(k) && typeof v === "string" && v.length > 80) continue;
        walk(v, depth + 1);
      }
    }
  };

  walk(context.intelligence);
  walk(context.portfolio?.totals);
  walk(context.portfolio?.averages);
  walk(context.portfolio?.byClient?.slice?.(0, 30));
  walk(context.portfolio?.matchedStudyCount);
  walk(context.portfolio?.databaseStudyCount);
  walk(context.pricingScenarios);
  walk(context.legacyAnterior);
  // Common safe literals
  ["0", "1", "2", "3", "4", "5", "10", "12", "20", "100", "2024", "2025", "2026"].forEach((x) =>
    allowed.add(x)
  );
  return allowed;
}

/**
 * Hard grounding: when intel/portfolio packs cannot support PSM-like decimals,
 * rewrite suspicious decimals to "missing (unverified)" and return warnings.
 */
function applyHardGrounding(answer, context = {}) {
  let text = String(answer || "");
  const warnings = [];
  const verify = verifyGrounding({ answer: text, context });
  warnings.push(...verify.warnings);

  const intel = context.intelligence;
  const emptyOrBadIntel =
    !intel ||
    intel.error ||
    (intel.indicationBenchmark &&
      intel.indicationBenchmark.ora?.studyCount === 0 &&
      !(intel.indicationBenchmark.sites?.topSitesByPsm?.length ||
        intel.indicationBenchmark.sites?.topSites?.length));

  const allowed = allowedNumbersFromContext(context);

  if (emptyOrBadIntel) {
    // Replace bare PSM-like decimals near "psm" language
    const before = text;
    text = text.replace(
      /(\bpsm\b[^.\n]{0,40}?)(0\.\d{2,4})\b/gi,
      (m, lead, num) => {
        if (allowed.has(num)) return m;
        warnings.push({
          code: "stripped_psm",
          message: `Removed unverified PSM value ${num} (no supporting intelligence pack).`
        });
        return `${lead}missing (unverified)`;
      }
    );
    text = text.replace(
      /\b(0\.\d{2,4})\b([^.\n]{0,40}\bpsm\b)/gi,
      (m, num, trail) => {
        if (allowed.has(num)) return m;
        warnings.push({
          code: "stripped_psm",
          message: `Removed unverified PSM value ${num}.`
        });
        return `missing (unverified)${trail}`;
      }
    );
    if (text !== before && !/unverified|missing/i.test(text.slice(0, 200))) {
      text +=
        "\n\n[[i]]Some performance figures were unmarked because Cosmos had no matching benchmark — do not treat them as Ora data.[[/i]]";
    }
  }

  if (context.moneyIntent === "ora_earned" && /\b(chf|€|\$)\s?\d+(\.\d+)?\s*(billion|bn)\b/i.test(text)) {
    warnings.push({
      code: "public_billions_on_ora_ask",
      message: "Stripped public-company billions language on an ora_earned ask."
    });
    text = text.replace(
      /\b((?:chf|€|\$)\s?\d+(?:\.\d+)?\s*(?:billion|bn))\b/gi,
      "[Ora portfolio fees — use byClient totals, not public $B]"
    );
  }

  return {
    answer: text,
    warnings,
    grounded: warnings.length === 0,
    rewritten: text !== String(answer || "")
  };
}

function buildEvidenceEnvelope({ context = {}, question = "", answer = "", toolTrace = [] } = {}) {
  const sources = buildSourcesFromContext(context, toolTrace);
  const gaps = buildGapsFromContext(context, question);
  const nextAsk = suggestNextAsk(context, gaps);
  const hard = applyHardGrounding(answer, context);
  const claims = [];

  const okSources = sources.filter((s) => s.ok);
  if (okSources.length) {
    claims.push({
      type: "sources_used",
      text: `Used ${okSources.map((s) => s.label).join(", ")}`
    });
  }
  for (const w of hard.warnings) {
    claims.push({ type: "warning", text: w.message, code: w.code });
  }

  return {
    version: 1,
    sources,
    gaps,
    nextAsk,
    claims,
    grounded: hard.grounded,
    warnings: hard.warnings,
    rewritten: hard.rewritten,
    cleanAnswer: hard.answer,
    toolTrace: (toolTrace || []).map((t) => ({
      tool: t.tool,
      label: t.label || t.tool,
      ok: t.ok !== false,
      detail: t.detail || null,
      elapsedMs: t.elapsedMs ?? null,
      round: t.round ?? 1
    }))
  };
}

module.exports = {
  buildEvidenceEnvelope,
  buildSourcesFromContext,
  buildGapsFromContext,
  suggestNextAsk,
  shouldHuntAgain,
  answerLooksWeak,
  verifyGrounding,
  applyHardGrounding,
  allowedNumbersFromContext
};
