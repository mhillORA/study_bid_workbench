/**
 * Ask Buddy — study context + LLM (Azure OpenAI preferred; Claude optional fallback).
 */

const SYSTEM_PROMPT_DEFAULT = [
  "You are Ask Buddy for Ora Clinical's Study Bid Workbench — used by BD analysts, salespeople who sell Ora's ophthalmology CRO services, leadership who need fast executive answers, and ops who track bid workflow / data health.",
  "Primary jobs: (1) help sell Ora with credible feasibility and competitive context, (2) draft bid/study drivers from portfolio history, (3) answer leadership rollups across uploaded budgets, (4) High Level Ballpark (HLBP) forms — open/guide/autofill identity, enrollment drivers, and site country mix, (5) Ora Clinical Intelligence — Ora/Veeva, TrialHub, Salesforce crosswalk, CT.gov, Site Scorecard, (6) legacy anterior-segment site trust / historical enrollment, (7) ops briefing on open-study sectionStatus / fill requests when present.",
  "Audience tone: for BD/sales — proposal-ready, why-Ora vs industry, concrete PSM/n/sites/geo, short talking points they can paste into an email or RFI. For leadership — lead with the headline number and n, then 2–3 implications; no operational jargon dumps. For ops — department status counts, open requests, drivers, and which tab to open next (Reviews, Upload, Ops Dashboard).",
  "Be concise and practical. Prefer numbers, NCT ids, study_number, and Ora codes when present in context.",
  "FORMAT (strict): Do NOT use markdown. No # ## ### headings, no ** or *** bold, no <b>/<i>/<strong> HTML. Use plain sentences and short lines. For a section title wrap exactly like this with double brackets: [[h]]Title[[/h]]. For a critical number or takeaway wrap exactly: [[i]]text[[/i]]. Example: Ora median PSM is [[i]]1.4[[/i]]. Use at most 2–4 [[h]] labels and a few [[i]] highlights per reply. Never stack many headers. Never invent other markup.",
  "If context is missing or incomplete, say what you need and which tab to open (HLBP, Ora Clinical Intelligence, Site Scorecard, Ops Dashboard, or Studies).",
  "Do not invent Cosmos data that is not in the provided context.",
  "For portfolio / cross-study questions (all studies, averages across studies, clients like Alcon, totals, how many patients/studies last year, budget dollars, which study is largest), use context.portfolio — especially averages.enrolledSubjects, totals, byClient, highestBudgetStudies, matchedStudyCount. Prefer portfolio when context.answerFocus is \"portfolio\". NEVER answer an all-studies / average-across-studies question using only workingStudy or openStudyInUi.",
  "When context.answerFocus is \"single_study\" and cosmos/workingStudy is present, answer about that study. When answerFocus is \"portfolio\", ignore the open UI study except as optional footnote.",
  "When both cosmos and portfolio exist, use cosmos for study-specific detail and portfolio for rollups/averages.",
  "HLBP / High Level Ballpark: when the user says they need an HLBP / high-level ballpark form, create or continue an HLBP draft. End with CREATE_STUDY:{\"budgetType\":\"HLBP\",\"clientName\":\"...\",\"phase\":\"...\",\"indication\":\"...\",\"drivers\":{\"enrolledSubjects\":100,\"enrollmentMonths\":12,\"coreSites\":16},\"sites\":[{\"country\":\"United States\",\"coreSites\":12},{\"country\":\"United Kingdom\",\"coreSites\":4}],\"versionLabel\":\"HLBP draft\"} including only fields they gave, then NAVIGATE:hlbp. Guide missing required fields one batch at a time (client, indication, phase, enrolled, enrollment months, site country mix). When they answer, APPLY those fields (drivers.*, sites.N.country, sites.N.coreSites, clientName, etc.). Do not invent a full detailed Internal Budget.",
  "When the user wants a new study / draft bid (not HLBP) and provides details, briefly confirm, then end with exactly one line: CREATE_STUDY:{\"studyId\":\"O-12345 or omit\",\"clientName\":\"...\",\"title\":\"...\",\"protocol\":\"...\",\"phase\":\"...\",\"therapeuticArea\":\"...\",\"indication\":\"...\",\"drivers\":{\"enrolledSubjects\":120,\"screenedSubjects\":180,\"coreSites\":15,\"enrollmentMonths\":12},\"notes\":\"...\",\"versionLabel\":\"draft\"}. Only include fields the user gave. studyId optional — system will assign NEW-… if missing. Do not claim the study exists until the user clicks Create in the UI.",
  "When the user asks to open, go to, or show a tab/section (Hub, HLBP, Ops Dashboard, Studies, Versions, Ora Clinical Intelligence, Site Scorecard, Overview, Recruitment, ClinOps, Monitoring, SMO, Summary, Reviews, Formulas, Upload), put exactly one line at the end of your reply: NAVIGATE:<sectionId> using one of: hub, hlbp, ops, studies, versions, intelligence, scorecard, overview, recruitment, clinops, monitoring, smo, summary, reviews, formulas, upload.",
  "When the user asks you to set, fill, change, or update a field on the open study, briefly confirm what you will change, then put exactly one line at the end: APPLY:[{\"path\":\"assumptions.recruitment.notes\",\"value\":\"text\",\"label\":\"Notes (Recruitment)\"}].",
  "Section locks: context.sectionLocks lists tabs currently locked for editing (sectionId + holderName). You may READ and discuss locked tabs. Do NOT emit APPLY (or claim you changed values) for any path whose tab is in sectionLocks and held by someone else — instead say clearly e.g. 'Alex is editing Recruitment — ask them to Save and click Done before I can change that tab.' CREATE_STUDY for a new study is still allowed.",
  "APPLY paths must come from context.editableFields (path + label + tab). Prefer the activeTab when the user says a generic name like Notes. Examples: assumptions.recruitment.notes, drivers.enrolledSubjects, sites.0.country, sites.0.coreSites, clientName. Never invent paths. Do not claim the value is saved until the user clicks Apply in the UI.",
  "When context.user has a firstName (or displayName), greet them by first name when they say hi/hello or on the first reply of a chat — then skip greetings on follow-ups unless they greet you again."
].join(" ");

const PORTFOLIO_RULES =
  " DATA RULE: context.portfolio is queried from Cosmos DB across studies (databaseStudyCount / matchedStudyCount / averages / totals). " +
  "Questions about all studies, averages across studies, which study is largest, client rollups, or portfolio totals MUST use context.portfolio. " +
  "workingStudy and openStudyInUi are only the study open in the browser — never treat them as the full database. " +
  "For average enrollment use portfolio.averages.enrolledSubjects and cite matchedStudyCount / studiesWithEnrollmentCount.";

/**
 * Always appended — even when SWA overrides BUDDY_SYSTEM_PROMPT — so Buddy knows
 * Ora Clinical Intelligence / TrialHub / CT.gov and how to answer those asks.
 */
const INTELLIGENCE_RULES = [
  " INTELLIGENCE DATA CATALOG (Cosmos bd-budgets — reference tables, NOT budget line items):",
  "1) ora_fact_study (~249 Ora studies from Veeva CTM): study-level enrollment / PSM for Ora's own history. Key fields: study_number, sponsor, indication, phase, psm, study_rate_pt_mo, total_enrolled, n_contributing_sites, enroll_months, screen_fail_rate_recomputed, lifecycle_state, countries.",
  "2) ora_fact_site (~3613 site×study rows from Veeva): site performance. Key fields: study_name (joins to study_number), org_clean (canonical site), country, indication, site_psm, total_enrolled, site_enroll_months, fsi_trust (prefer \"high\"), screen_fail_rate.",
  "3) ora_trialhub_trials (~1682 industry trials): competitive landscape / industry PSM. Key fields: nct, title, sponsor, indication, phase, status, patients, planned_sites, actual_sites, psm_common, th_actual_psm, recruit_days, countries, in_ora_indication, lead_sponsor_type.",
  "4) ora_sponsor_crosswalk (~642): TrialHub/Veeva sponsor name → Salesforce. Key fields: trialhub_veeva_sponsor, sf_account_name, sf_account_id, sf_owner, tier, crosswalk_status (confirmed_new | previously_confirmed | no_sf_match | in_sf_inactive). no_sf_match = prospecting targets.",
  "5) ora_site_alias_table (~46): variant site names → canonical_name (already applied into org_clean where possible).",
  "6) ora_ctgov_trials (ClinicalTrials.gov ophthalmology feed, daily delta ~5AM Eastern): public registry landscape. Key fields: nct, title, status, phase, conditions, oraIndication, sponsor, sponsorClass, enrollment, countries, startDate, lastUpdatePostDate, hasResults. Use when context.intelligence.ctgov is present or user asks about CT.gov / registry / recruiting ophthalmology trials.",
  " USE CASES — match the ask to the right source:",
  "• Feasibility / \"how fast do we enroll\" / typical PSM for an indication → context.intelligence.indicationBenchmark (Ora median PSM + TrialHub median psm_common + site medians). Prefer medians; cite studiesWithPsm / trialsWithPsm counts.",
  "• Competing / recruiting industry trials → intelligence.indicationBenchmark.trialhub.recruitingSample / sampleTrials (NCT + sponsor + status).",
  "• Site selection / which sites perform → LIST real site names from context.intelligence.indicationBenchmark.sites.topSitesByPsm (org_clean + country + site_psm + fsi_trust). Also use countrySites.topSites when present. Optional: NAVIGATE:scorecard for the full scorecard UI — never as a substitute for naming sites.",
  "• Region / country feasibility (US, UK, Germany, Japan, …) → use countryFilter on sites + ctgov + TrialHub countries; cite geography explicitly.",
  "• Site Scorecard (Ora vs industry) → oraScore vs industryScore/Δ; Deeper dive = recommended site slate for enrollment goals. Prefer medians; null ≠ 0.",
  "• BD/sales pitch asks (\"why Ora\", \"what do I tell the sponsor\", RFI bullets) → lead with Ora median vs industry, geography, top sites, competitive recruiting; end with 3 short talking points.",
  "• Leadership asks (portfolio totals, averages, which client/study is largest, year rollups) → context.portfolio first; one headline + n, then brief implications.",
  "• Ops briefing (section status, fill requests, what to do next) → workingStudy.sectionStatus / requests / drivers; suggest NAVIGATE:ops or NAVIGATE:reviews.",
  "• Sponsor already in SF? BD owner / tier? → intelligence.sponsorCrosswalk.",
  "• NCT lookup → intelligence.nctLookup (TrialHub) and/or intelligence.ctgov.",
  "• Budget dollars / uploaded bid portfolio → context.portfolio (not intelligence).",
  "• HLBP form asks → CREATE_STUDY with budgetType HLBP + sites country mix, NAVIGATE:hlbp, then APPLY missing fields as the user answers. Past-bid dollar comps may use context.pricingScenarios when present — label them as comparable past service fees, not 'the HLBP form'.",
  "• CT.gov dollars → only when pricingScenarios.ctgovDollars.available or intelligence.ctgov.dollarMentions.available. Those are rare free-text mentions (not CRO bids). If unavailable, say CT.gov has no structured bid costs — do not invent.",
  "• RFP / pricing numbers from past bids → context.pricingScenarios when present (comparable service-fee ranges scaled to N). Cite comparableCount. Not a formal quote.",
  "• Open bid drivers / fields → workingStudy / cosmos study.",
  " QUALITY RULES: null PSM or enrollment means missing Veeva/registry data — NEVER treat null as zero. Prefer fsi_trust=high for site_psm. TrialHub/CT.gov PSM can have outliers — use median (and P25/P75 when present), not mean. Indication labels differ slightly across Ora Veeva vs TrialHub vs CT.gov; use aliasesUsed when explaining matches.",
  " SITE LISTING RULE (critical): If context.intelligence.indicationBenchmark.sites.topSitesByPsm OR countrySites.topSites OR legacyAnterior sites/leaderboard has rows, you MUST name at least 5–10 real sites (org_clean) with country and site_psm or enrolled in the reply. Do NOT say you need to open Clinical Intelligence instead of listing them. NAVIGATE:intelligence or NAVIGATE:scorecard may be added AFTER the list as optional follow-up — never as the only answer.",
  " If the user asks about sites/feasibility/PSM and those site arrays are empty/missing: (1) if indication is unknown, ask for indication (e.g. Dry Eye) in the reply; (2) only then suggest opening Intelligence/Scorecard. Do not NAVIGATE alone with no site names and no clarifying question.",
  " When answering intelligence or sales questions: short executive tone — one [[h]]Summary[[/h]], then 3–6 plain lines, highlight key medians/n with [[i]]…[[/i]]. For site asks add [[h]]Sites[[/h]] then a short list. For BD, add a final [[h]]Talking points[[/h]] with 3 bullets. No ###, no **, no long section lists."
].join(" ");

const LEGACY_ANTERIOR_RULES = [
  " LEGACY ANTERIOR-SEGMENT DATA (Cosmos bd-budgets — separate containers, NOT Ora Veeva and NOT budget studies):",
  "Containers: legacy_studies, legacy_sites, legacy_study_site_outcomes (by studyId), legacy_site_study_outcomes (by siteId). dataset=legacy_anterior_segment.",
  "When context.legacyAnterior is present:",
  "• You MAY use trust / relationship fields (relationshipPreference, advantages, disadvantages, relationshipNotes) without extra confirmation.",
  "• If legacyAnterior.indicationSites (or trust.indicationFilter) is set, prefer those sites for that indication (e.g. Dry Eye) — do not mix other indications into site suggestions.",
  "• Enrollment numbers (scheduled/screened/enrolled/attainmentPct/outcomes): ONLY if legacyAnterior.enrollmentIncluded is true. If enrollmentIncluded is false, ASK once: 'Want me to include legacy anterior-segment enrollment history (scheduled/screened/enrolled/%), or stick to Ora Veeva / Site Scorecard?' Do not invent or cite those enrollment metrics until they say yes.",
  "• After they confirm, the next turn will set enrollmentIncluded true — then use sites.metrics / siteOutcomes / studyOutcomes.",
  " Label this source as legacy anterior-segment overview (not Veeva PSM). Cite n. Null ≠ 0.",
  " If a named site/study has matched=0, say it was not found and ask for another spelling.",
  " Site Scorecard 'Include legacy recruitment data' is a separate UI toggle — when the user mentions they turned it on, treat enrollment as consented."
].join(" ");

const FORMAT_RULES =
  " OUTPUT FORMAT: Chat UI renders [[h]]…[[/h]] as blue headers and [[i]]…[[/i]] as red important text. " +
  "Never use markdown headings (#) or bold (** / ***). Prefer short paragraphs over outlines.";

/** Never leave the user with silence, "null", or "no answer". */
const ALWAYS_RESPOND_RULES =
  " ALWAYS RESPOND: Every user message MUST get a real reply in plain sentences. " +
  "Never answer with only null, (null), undefined, N/A, empty string, silence, or phrases like \"I have no answer\", \"no answer to that\", \"I cannot answer\", or \"nothing to say\". " +
  "If data is missing, incomplete, or the ask is unclear: say what you do know (even if thin), then ask 1–3 concrete clarifying questions, and name the tab to open (Intelligence, Site Scorecard, Ops Dashboard, Studies, Reviews). " +
  "If a field in context is null, say it is missing / not in the data — never print the word null or (null) to the user. " +
  "When unsure which study or indication they mean, ask — do not refuse.";

/** Prefer Foundry agent instructions pasted into SWA settings; else built-in default. */
function buddyInstructionsBase() {
  const custom =
    envSet("BUDDY_SYSTEM_PROMPT") ||
    envSet("FOUNDRY_AGENT_INSTRUCTIONS") ||
    envSet("AGENT_INSTRUCTIONS") ||
    envSet("SYSTEM_PROMPT");
  // Always append portfolio + intelligence + format + always-respond — SWA custom prompts often omit them
  return (
    (custom || SYSTEM_PROMPT_DEFAULT) +
    PORTFOLIO_RULES +
    INTELLIGENCE_RULES +
    LEGACY_ANTERIOR_RULES +
    FORMAT_RULES +
    ALWAYS_RESPOND_RULES
  );
}

function systemPromptFor(context) {
  const base = buddyInstructionsBase();
  const protocols =
    " Machine protocols: for tab navigation end with NAVIGATE:<sectionId> (hub,hlbp,ops,studies,versions,intelligence,scorecard,overview,recruitment,clinops,monitoring,smo,summary,reviews,formulas,upload)." +
    " For field fills end with APPLY:[{\"path\":\"drivers.enrolledSubjects\",\"value\":100,\"label\":\"Enrolled subjects\"}] using only context.editableFields paths; prefer activeTab for ambiguous names; the user must click Apply before values write." +
    " If context.sectionLocks shows another person on a tab, do not APPLY that tab — say who is editing it and that they must Save and Done first." +
    " To create a new study or HLBP from user-provided info end with CREATE_STUDY:{...json...} (set budgetType:\"HLBP\" and sites:[{country,coreSites}] for HLBP); user must click Create before it is saved." +
    " For cross-study / all-studies / average / client / year questions: set answer from context.portfolio (averages + totals + byClient); cite matchedStudyCount; do not use openStudyInUi or workingStudy for those answers." +
    " For feasibility / PSM / TrialHub / competing trials / site performance / NCT / ophthalmology landscape: use context.intelligence; if site lists are present, NAME the sites — do not only NAVIGATE:intelligence." +
    " For legacy anterior-segment site trust / preferred sites / historical scheduled-screened-enrolled: use context.legacyAnterior when present." +
    " For past-bid pricing comps: use context.pricingScenarios when present; include CT.gov $ only if ctgovDollars.available." +
    " FORMAT reminder: no markdown # or **; use [[h]] for blue section labels and [[i]] for red important facts only." +
    " Never reply with null/(null)/empty/no answer — ask a clarifying question instead.";
  const focus = context?.answerFocus;
  const focusNote =
    focus === "portfolio"
      ? " CRITICAL: answerFocus=portfolio — answer from context.portfolio (Cosmos DB) only; you may still use context.intelligence / context.legacyAnterior for feasibility if present."
      : " If the user asks about all studies or averages across studies, switch to context.portfolio even if a workingStudy is present.";
  const hasSiteList = Boolean(
    context?.intelligence?.indicationBenchmark?.sites?.topSitesByPsm?.length ||
      context?.intelligence?.countrySites?.topSites?.length ||
      context?.legacyAnterior?.indicationSites?.topByEnrolled?.length ||
      context?.legacyAnterior?.trust?.leaderboard?.length
  );
  const intelNote = context?.intelligence
    ? hasSiteList
      ? " context.intelligence IS attached WITH site rows — you MUST list org_clean names from topSitesByPsm or countrySites.topSites in this reply. NAVIGATE is optional after the list."
      : " context.intelligence IS attached but site lists are empty — give medians/NCT/crosswalk if present, then ask for indication/geography if needed. Do not pretend a tab open will magically list sites without data."
    : " context.intelligence may be absent on this turn; for site/feasibility asks, ask for indication if missing, or say data was not attached — do not only NAVIGATE:intelligence with no substance.";
  const legacyNote = context?.legacyAnterior
    ? context.legacyAnterior.enrollmentIncluded
      ? " context.legacyAnterior IS attached WITH enrollment — you may cite scheduled/screened/enrolled."
      : " context.legacyAnterior IS attached for trust notes only — ASK before citing legacy enrollment numbers (enrollmentIncluded=false)."
    : "";
  const dep = azureConfig().deployment;
  const modelNote = dep
    ? ` You are served via Azure deployment "${dep}". If asked which model you are, say that deployment name — do not claim GPT-4 or another model unless that is the deployment name.`
    : "";
  const user = context?.user;
  if (!user?.firstName && !user?.displayName && !user?.email) {
    return base + protocols + focusNote + intelNote + legacyNote + modelNote;
  }
  const label = user.firstName
    ? `${user.firstName}${user.email ? ` (${user.email})` : ""}`
    : user.displayName || user.email;
  return (
    base +
    protocols +
    focusNote +
    intelNote +
    legacyNote +
    modelNote +
    ` The signed-in user is ${label}. Prefer addressing them as ${user.firstName || "their first name"}.` +
    " Always prefer study data in the provided Context JSON over general knowledge."
  );
}

function envSet(name) {
  const v = (process.env[name] || "").trim();
  if (!v || v.includes("SET_IN")) return "";
  return v;
}

/** First non-empty env among aliases (for SWA naming mismatches). */
function envSetAny(names) {
  for (const name of names) {
    const v = envSet(name);
    if (v) return { value: v, from: name };
  }
  return { value: "", from: null };
}

const AZURE_KEY_ALIASES = [
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_KEY",
  "AZURE_AI_API_KEY",
  "AZURE_AI_KEY",
  "OPENAI_API_KEY",
  "FOUNDRY_API_KEY",
  "AI_API_KEY"
];

const AZURE_ENDPOINT_ALIASES = [
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_AI_ENDPOINT",
  "FOUNDRY_PROJECT_ENDPOINT",
  "AZURE_AI_PROJECT_ENDPOINT"
];

const AZURE_DEPLOYMENT_ALIASES = [
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_MODEL",
  "AZURE_AI_DEPLOYMENT",
  "FOUNDRY_DEPLOYMENT",
  "OPENAI_DEPLOYMENT"
];

function azureConfig() {
  const endpoint = envSetAny(AZURE_ENDPOINT_ALIASES);
  const apiKey = envSetAny(AZURE_KEY_ALIASES);
  const deployment = envSetAny(AZURE_DEPLOYMENT_ALIASES);
  return {
    endpoint: endpoint.value,
    apiKey: apiKey.value,
    deployment: deployment.value,
    sources: {
      endpoint: endpoint.from,
      apiKey: apiKey.from,
      deployment: deployment.from
    }
  };
}

function providerStatus() {
  const cfg = azureConfig();
  const azure = Boolean(cfg.endpoint) && Boolean(cfg.apiKey) && Boolean(cfg.deployment);
  const claude = Boolean(envSet("ANTHROPIC_API_KEY"));

  // Presence only — never return secret values
  const raw = (name) => {
    const v = process.env[name];
    if (v == null) return "missing";
    if (!String(v).trim()) return "empty";
    if (String(v).includes("SET_IN")) return "placeholder";
    return "set";
  };

  const aliasScan = {};
  for (const name of [...AZURE_KEY_ALIASES, ...AZURE_ENDPOINT_ALIASES, ...AZURE_DEPLOYMENT_ALIASES]) {
    const status = raw(name);
    if (status !== "missing") aliasScan[name] = status;
  }

  return {
    azureOpenAI: azure,
    claude,
    active: azure ? "azure_openai" : claude ? "claude" : null,
    // Deployment name only (not a secret) — so you can verify SWA matches Foundry
    deployment: cfg.deployment || null,
    effort: envSet("ANTHROPIC_EFFORT") || "low",
    buildId: "2026-07-26T26-hlbp-form",
    endpointKind: !cfg.endpoint
      ? null
      : isFoundryProjectEndpoint(cfg.endpoint)
        ? "foundry_project"
        : isOpenAiV1Endpoint(cfg.endpoint)
          ? "openai_v1"
          : "classic_azure_openai",
    envCheck: {
      AZURE_OPENAI_ENDPOINT: raw("AZURE_OPENAI_ENDPOINT"),
      AZURE_OPENAI_API_KEY: raw("AZURE_OPENAI_API_KEY"),
      AZURE_OPENAI_DEPLOYMENT: raw("AZURE_OPENAI_DEPLOYMENT"),
      BUDDY_SYSTEM_PROMPT: raw("BUDDY_SYSTEM_PROMPT"),
      FOUNDRY_AGENT_INSTRUCTIONS: raw("FOUNDRY_AGENT_INSTRUCTIONS"),
      COSMOS_ENDPOINT: raw("COSMOS_ENDPOINT"),
      COSMOS_KEY: raw("COSMOS_KEY")
    },
    resolvedFrom: cfg.sources,
    otherAiSettingsFound: aliasScan
  };
}

async function getStudyContext(studyId, { getDb }) {
  if (!studyId) return null;
  try {
    const database = getDb();
    const { resources: studies } = await database.container("studies").items
      .query({
        query: "SELECT * FROM c WHERE c.studyId = @id AND c.docType = @t",
        parameters: [
          { name: "@id", value: studyId },
          { name: "@t", value: "study" }
        ]
      })
      .fetchAll();
    const study = studies[0];
    if (!study) return { studyId, note: "No Cosmos study found for that id" };

    let version = null;
    if (study.currentVersionId) {
      try {
        const { resource } = await database
          .container("versions")
          .item(study.currentVersionId, studyId)
          .read();
        version = resource;
      } catch (_) {}
    }

    const { resources: lineSample } = await database.container("lineItems").items
      .query({
        query:
          "SELECT TOP 80 c.oraCode, c.department, c.service, c.units, c.totalHours, c.charge, c.directCost, c.phase FROM c WHERE c.studyId = @id",
        parameters: [{ name: "@id", value: studyId }]
      })
      .fetchAll();

    const byDept = {};
    for (const li of lineSample) {
      const d = li.department || "Other";
      byDept[d] = (byDept[d] || 0) + 1;
    }

    return {
      source: "cosmos",
      study: {
        studyId: study.studyId,
        clientName: study.clientName,
        title: study.title,
        protocol: study.protocol,
        phase: study.phase,
        therapeuticArea: study.therapeuticArea,
        indication: study.indication,
        status: study.status,
        drivers: study.drivers,
        sites: (study.sites || []).slice(0, 20)
      },
      version: version
        ? {
            id: version.id,
            label: version.label,
            lineItemCount: version.lineItemCount,
            totals: version.totals,
            sourceFileName: version.sourceFileName
          }
        : null,
      lineItemSample: lineSample,
      lineItemCountsByDepartment: byDept,
      sheetHarvestSummary: study.sheetHarvestSummary || version?.sheetHarvestSummary || null,
      sheetNames: (version?.sheetInventory || study.sheetHarvestSummary?.sheets || []).map((s) =>
        typeof s === "string" ? s : s.name
      )
    };
  } catch (err) {
    return {
      studyId,
      source: "cosmos_error",
      error: String(err.message || err)
    };
  }
}

function buildHistoryMessages(history) {
  const messages = [];
  if (!Array.isArray(history)) return messages;
  for (const turn of history.slice(-8)) {
    if (!turn || !turn.role || !turn.content) continue;
    if (turn.role !== "user" && turn.role !== "assistant") continue;
    messages.push({ role: turn.role, content: String(turn.content).slice(0, 8000) });
  }
  return messages;
}

function userBlock(question, context) {
  return [
    "Question:",
    question,
    "",
    "Context (JSON):",
    JSON.stringify(context || {}, null, 2).slice(0, 100000),
    "",
    "Reply format: plain text; optional [[h]]header[[/h]] (blue) and [[i]]important[[/i]] (red). No markdown # or **."
  ].join("\n");
}

function isFoundryProjectEndpoint(endpoint) {
  const e = String(endpoint || "").toLowerCase();
  return e.includes("services.ai.azure.com") || e.includes("/api/projects/");
}

function isOpenAiV1Endpoint(endpoint) {
  const e = String(endpoint || "").toLowerCase();
  return e.includes("/openai/v1");
}

function resourceNameFromEndpoint(endpoint) {
  const e = String(endpoint || "");
  let m = e.match(/^https:\/\/([^.]+)\.services\.ai\.azure\.com/i);
  if (m) return m[1];
  m = e.match(/^https:\/\/([^.]+)\.openai\.azure\.com/i);
  if (m) return m[1];
  m = e.match(/^https:\/\/([^.]+)\.cognitiveservices\.azure\.com/i);
  if (m) return m[1];
  return null;
}

/**
 * Build candidate chat-completion URLs. Foundry "project" URLs often 404 for
 * chat completions with api-key — prefer *.openai.azure.com/openai/v1.
 */
function buildAzureChatAttempts(endpoint, deployment, apiVersion) {
  const base = String(endpoint || "").replace(/\/$/, "");
  const resource = resourceNameFromEndpoint(base);
  const attempts = [];

  const pushV1 = (hostBase, label) => {
    const root = hostBase.replace(/\/$/, "").replace(/\/openai\/v1$/i, "");
    attempts.push({
      label,
      url: `${root}/openai/v1/chat/completions`,
      body: {
        model: deployment,
        messages: null, // filled later
        max_completion_tokens: 2048,
        // GPT-5 only allows default temperature=1; Foundry may inject 0.2 otherwise
        temperature: 1
      }
    });
  };

  const pushClassic = (hostBase, label) => {
    const root = hostBase.replace(/\/$/, "").replace(/\/openai\/v1$/i, "");
    attempts.push({
      label,
      url: `${root}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`,
      body: {
        messages: null,
        max_completion_tokens: 2048,
        temperature: 1
      }
    });
  };

  // 1) Preferred: OpenAI v1 on openai.azure.com (works with Foundry deployments + api-key)
  if (resource) {
    pushV1(`https://${resource}.openai.azure.com`, "openai_v1_host");
    pushClassic(`https://${resource}.openai.azure.com`, "classic_deployments_host");
    pushV1(`https://${resource}.cognitiveservices.azure.com`, "cognitive_v1_host");
    pushClassic(`https://${resource}.cognitiveservices.azure.com`, "cognitive_classic_host");
  }

  // 2) If user already pasted openai.azure.com (/openai/v1 or bare)
  if (/openai\.azure\.com/i.test(base)) {
    if (isOpenAiV1Endpoint(base) || /\/openai\/v1/i.test(base)) {
      pushV1(base, "user_openai_v1");
    } else {
      pushV1(base, "user_openai_as_v1");
      pushClassic(base, "user_classic");
    }
  }

  // 3) Project endpoint path (sometimes works; often 404 for plain chat)
  if (isFoundryProjectEndpoint(base)) {
    // Prefer resource-level Foundry OpenAI route (no /api/projects/...)
    if (resource) {
      pushV1(`https://${resource}.services.ai.azure.com`, "foundry_services_v1");
    }
    attempts.push({
      label: "foundry_project_openai_v1",
      url: `${base}/openai/v1/chat/completions`,
      body: {
        model: deployment,
        messages: null,
        max_completion_tokens: 2048,
        temperature: 1
      }
    });
  }

  // Dedupe by URL
  const seen = new Set();
  return attempts.filter((a) => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
}

/**
 * Supports Foundry project endpoints and classic Azure OpenAI.
 * Tries multiple URL shapes because Foundry project URLs often 404 for chat.
 */
async function askAzureOpenAI({ question, context, history }) {
  const cfg = azureConfig();
  const endpoint = cfg.endpoint.replace(/\/$/, "");
  const apiKey = cfg.apiKey;
  const deployment = cfg.deployment;
  const apiVersion = envSet("AZURE_OPENAI_API_VERSION") || "2024-08-01-preview";

  if (!endpoint || !apiKey || !deployment) {
    throw new Error(
      "Ask Buddy is not configured. Need endpoint + API key + deployment on SWA. " +
        `Key must be named AZURE_OPENAI_API_KEY (currently: endpoint=${cfg.sources.endpoint || "missing"}, key=${cfg.sources.apiKey || "missing"}, deployment=${cfg.sources.deployment || "missing"}).`
    );
  }

  const messages = [
    { role: "system", content: systemPromptFor(context) },
    ...buildHistoryMessages(history),
    { role: "user", content: userBlock(question, context) }
  ];

  const attempts = buildAzureChatAttempts(endpoint, deployment, apiVersion);
  if (!attempts.length) {
    throw new Error(`Could not build Azure chat URL from endpoint: ${endpoint}`);
  }

  const failures = [];
  for (const attempt of attempts) {
    const body = { ...attempt.body, messages };
    // classic body has no model field
    if (!("model" in attempt.body)) delete body.model;

    const res = await fetch(attempt.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "api-key": apiKey
      },
      body: JSON.stringify(body)
    });

    const respBody = await res.json().catch(() => ({}));
    if (res.ok) {
      const text = extractAzureMessageText(respBody);
      return {
        answer: ensureBuddyAnswer(text),
        model: respBody?.model || deployment,
        provider: "azure_openai",
        via: attempt.label,
        usage: respBody?.usage || null
      };
    }

    const msg =
      respBody?.error?.message ||
      respBody?.error?.code ||
      (Object.keys(respBody || {}).length ? JSON.stringify(respBody).slice(0, 200) : res.statusText);
    failures.push(`${attempt.label} → ${res.status} ${msg}`);

    // Retry other hosts only when the route itself is missing
    if (res.status !== 404) {
      break;
    }
  }

  throw new Error(
    `Azure AI chat failed for deployment "${deployment}". ` +
      `Check deployment name matches Foundry exactly. Tried: ${failures.join(" | ")}`
  );
}

async function askClaude({ question, context, history }) {
  const apiKey = envSet("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured in SWA Application settings");
  }
  const model = envSet("ANTHROPIC_MODEL") || "claude-sonnet-4-5";
  const effort = (envSet("ANTHROPIC_EFFORT") || "low").toLowerCase();

  const messages = [
    ...buildHistoryMessages(history),
    { role: "user", content: userBlock(question, context) }
  ];

  const payload = {
    model,
    max_tokens: 1024,
    system: systemPromptFor(context),
    messages
  };
  // Effort controls token spend / thoroughness (low = cheapest/fastest).
  if (["low", "medium", "high", "max"].includes(effort)) {
    payload.output_config = { effort };
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(payload)
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || JSON.stringify(body) || res.statusText;
    throw new Error(`Claude API ${res.status}: ${msg}`);
  }

  const text = (body.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return {
    answer: ensureBuddyAnswer(text),
    model: body.model || model,
    provider: "claude",
    effort,
    usage: body.usage || null
  };
}

/** True when the model effectively refused or returned garbage. */
function isEmptyOrRefusalAnswer(text) {
  const t = String(text || "")
    .replace(/\b(NAVIGATE|APPLY|CREATE_STUDY):[^\n]*/gi, "")
    .replace(/\[\[[hi]\]\]|\[\[\/[hi]\]\]/gi, "")
    .trim();
  if (!t) return true;
  const lower = t.toLowerCase().replace(/\s+/g, " ");
  if (/^(null|\(null\)|undefined|n\/a|none|nil|\.|\-+)$/i.test(lower)) return true;
  if (
    /^(i (have )?no answer( to that)?\.?|no answer( to that)?\.?|i cannot answer\.?|i don't have (an )?answer\.?|nothing to say\.?|i('m| am) unable to (help|answer)\.?)$/i.test(
      lower
    )
  ) {
    return true;
  }
  // Bare null dumps in otherwise tiny replies
  if (t.length < 40 && /\bnull\b/i.test(t) && !/\bmissing\b/i.test(t)) return true;
  return false;
}

const BUDDY_FALLBACK_ANSWER =
  "I need a bit more to help. [[h]]What I need[[/h]]\n" +
  "Tell me the indication (e.g. Dry Eye), geography if it matters (e.g. US), and whether you want a portfolio rollup, a pitch/feasibility read, or help on the open study.\n" +
  "You can also open Ora Clinical Intelligence, Site Scorecard, Ops Dashboard, or Studies and ask again from there.";

function ensureBuddyAnswer(text) {
  const raw = String(text == null ? "" : text).trim();
  if (isEmptyOrRefusalAnswer(raw)) return BUDDY_FALLBACK_ANSWER;
  // Never surface literal null tokens as the whole answer
  if (/^\(?null\)?$/i.test(raw)) return BUDDY_FALLBACK_ANSWER;
  return raw.replace(/(^|\s)\(?null\)?(?=\s|$)/gi, (m, lead) => `${lead}missing`);
}

/** Normalize Azure chat message content (string or multipart). */
function extractAzureMessageText(respBody) {
  const msg = respBody?.choices?.[0]?.message;
  if (!msg) return "";
  const raw = msg.content;
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && part.text) return part.text;
        return part?.text || "";
      })
      .join("\n")
      .trim();
  }
  return String(msg.refusal || "").trim();
}

/** Prefer Azure OpenAI (Ask Buddy); fall back to Claude only if Azure is unset. */
async function askAi(opts) {
  const status = providerStatus();
  let result;
  if (status.active === "azure_openai") result = await askAzureOpenAI(opts);
  else if (status.active === "claude") result = await askClaude(opts);
  else {
    throw new Error(
      "Ask Buddy is not configured. Set Azure OpenAI (AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT) in SWA Application settings."
    );
  }
  return { ...result, answer: ensureBuddyAnswer(result.answer) };
}

module.exports = {
  askAi,
  askClaude,
  askAzureOpenAI,
  getStudyContext,
  providerStatus,
  ensureBuddyAnswer
};
