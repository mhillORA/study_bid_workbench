const { app } = require("@azure/functions");
const AdmZip = require("adm-zip");
const { parseWorkbookBuffer } = require("./parseWorkbook");
const { upsertCanonical, createManualStudy, saveStudyVersion, saveSectionPatch, listStudies, getStudy, listVersions, getVersion, listLineItems, compareVersions, compareStudies, listQuarantine, getParseLearningsSummary, loadLearnings, getDb, buildPortfolioContext, listSectionLocks, claimSectionLock, heartbeatSectionLock, requestSectionTakeover, releaseSectionLock } = require("./cosmosLoad");
const { askAi, getStudyContext, providerStatus, inferModelTier } = require("./askClaude");
const {
  buildIntelligenceContext,
  buildSiteScorecard,
  buildLegacyRecruitmentBoard,
  getIntelligenceHealth,
  isIntelligenceQuestion,
  isSourceOverviewQuestion,
  isTrialhubQuestion,
  isCtgovQuestion,
  isVeevaQuestion,
  isSalesforceDataQuestion,
  extractIndicationFromQuestion,
  extractCountryFromQuestion
} = require("./intelligence");
const {
  isLegacyAnteriorQuestion,
  isLegacyOverviewQuestion,
  buildLegacyAnteriorContext,
  userConsentedLegacyEnrollment,
  wantsHtmlVisual,
  isLegacyTableAsk
} = require("./legacyAnterior");
const { loadLiveContext, saveLiveContext } = require("./buddyLiveContext");
const { runCtgovSync, getCtgovSyncStatus, remapCtgovIndications } = require("./ctgovSync");
const { runSalesforceCrosswalkSync, getSalesforceSyncStatus } = require("./salesforceSync");
const { runSalesforceTablesSync, getSalesforceTablesStatus } = require("./salesforceTables");
const { ingestTrialHubUpload } = require("./trialhubIngest");
const {
  isPricingQuestion,
  extractRfpScenarioFromQuestion,
  buildRfpPricingPack
} = require("./rfpPricing");
const { normalizeBuddyAttachments } = require("./buddyAttachments");
const { buildBuddyDocExports, wantsDocumentExport } = require("./buddyDocExport");

function nctFromQuestion(question) {
  const m = String(question || "").match(/\b(NCT\d{8})\b/i);
  return m ? m[1].toUpperCase() : null;
}

function hasCopilotKey(request) {
  const expected = String(process.env.COPILOT_ASK_KEY || "").trim();
  const got = String(headerGet(request, "x-copilot-key") || "").trim();
  return Boolean(expected && !expected.includes("SET_IN") && got === expected);
}

/** Scheduler uses Copilot key; manual UI uses signed-in SWA principal. */
function authorizeCtgovSync(request) {
  if (hasCopilotKey(request)) return { ok: true, via: "copilot_key" };
  const user = signedInUserFromRequest(request, null);
  if (user && (user.email || user.userId)) return { ok: true, via: "swa_user", user };
  return { ok: false };
}

function json(status, body) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    jsonBody: body
  };
}

function headerGet(request, name) {
  return (
    request.headers.get(name) ||
    request.headers.get(name.toLowerCase()) ||
    request.headers.get(name.toUpperCase()) ||
    ""
  );
}

/** Infer studyId / client / year from the question + known client list. */
function isCrossStudyQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  // Explicit multi-study / portfolio intent
  // NOTE: RFP/ballpark/pricing alone is NOT cross-study — keep the open study for "this protocol" asks.
  if (
    /\b(all studies|across (all )?studies|every study|entire portfolio|whole portfolio|portfolio)\b/.test(q) ||
    /\b(across|among|between)\b.{0,40}\bstudies\b/.test(q) ||
    /\b(how many studies|which study|which studies|largest study|biggest study|most expensive|highest budget)\b/.test(q) ||
    /\b(largest|biggest|highest|top)\b.{0,40}\b(budget|fee|enrollment|study|studies|client|sponsor)\b/.test(q) ||
    /\b(average|avg|mean|median|total|sum|rollup)\b.{0,60}\b(across|all|every|portfolio|studies)\b/.test(q) ||
    /\b(enroll|patient|subject|budget|fee).{0,40}\b(across|all studies|every study)\b/.test(q) ||
    /\bstudies\b.{0,40}\b(last year|this year|in 20\d{2}|overall|combined)\b/.test(q) ||
    /\bcompare\b.{0,40}\bstud(y|ies)\b/.test(q) ||
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

/** True when the user clearly asked about a named client/sponsor (not a soft substring hit). */
function hasExplicitClientCue(question) {
  const q = String(question || "");
  return (
    /\b(?:with|for|from|client|sponsor|customer|account)\s+[A-Za-z0-9]/i.test(q) ||
    /\bstudies?\s+(?:for|with|from)\s+[A-Za-z0-9]/i.test(q) ||
    /\b[A-Za-z][A-Za-z0-9 .&'+-]{1,40}\s+studies\b/i.test(q)
  );
}

/**
 * Match a Cosmos client name in the question with word boundaries.
 * Short names (≤3 chars, e.g. "BL") must be whole words — never substrings of
 * "reliably", "table", "problem", etc.
 */
function clientNameMentionedInQuestion(question, clientName) {
  const name = String(clientName || "").trim();
  if (!name || name.length < 2) return false;
  const q = String(question || "");
  const escaped = name
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+")
    .replace(/\+/g, "\\+");
  // Whole-phrase / whole-word match (handles "Bausch + Lomb", "Alcon", "BL")
  if (new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?=[^A-Za-z0-9]|$)`, "i").test(q)) {
    return true;
  }
  // Longer unique names may appear without clean boundaries (possessives, punctuation)
  if (name.length >= 5 && q.toLowerCase().includes(name.toLowerCase())) {
    return true;
  }
  return false;
}

function extractYearFromQuestion(question) {
  const q = String(question || "");
  if (/\blast\s+year\b/i.test(q)) return new Date().getFullYear() - 1;
  if (/\bthis\s+year\b/i.test(q)) return new Date().getFullYear();
  // Require a year cue — bare "2024" in industry text must NOT filter the portfolio
  const ym = q.match(
    /\b(?:in|for|during|year|fy|calendar\s+year|cy)\s*(20\d{2})\b|\b(20\d{2})\s+(?:studies|bids?|budgets?|portfolio|ingest|uploads?)\b|\byear\s*[=:]\s*(20\d{2})\b/i
  );
  if (ym) return Number(ym[1] || ym[2] || ym[3]);
  return null;
}

function inferAskHints(question, body, clientNames) {
  const q = String(question || "");
  // body.portfolio=true means "include portfolio rollup" (frontend always sends it).
  // It must NOT force cross-study focus — that drops the open study for ops/BD asks.
  const crossStudy =
    isCrossStudyQuestion(q) || body.crossStudy === true || body.noStudy === true;
  // Explicit O-##### in the question wins; otherwise open-study id from the UI
  // must NOT bind cross-study / "all studies" questions to one workbook.
  const explicitStudy =
    (q.match(/\b(O-\d{3,})\b/i) || q.match(/\b(FILE-[A-Za-z0-9._-]{4,})\b/))?.[1] || null;

  let studyId = explicitStudy;
  if (!studyId && !crossStudy && body.studyId) {
    studyId = String(body.studyId).trim();
  }

  let clientName = body.clientName ? String(body.clientName).trim() : null;
  let year = body.year != null && body.year !== "" ? Number(body.year) : null;
  if (!year || Number.isNaN(year)) year = extractYearFromQuestion(q);

  // Soft directory scan only with an explicit client cue (or body.clientName).
  // Open-study mode must not substring-match client names out of English prose.
  const allowSoftClient = hasExplicitClientCue(q) || Boolean(body.clientName);

  if (!clientName && allowSoftClient && Array.isArray(clientNames) && clientNames.length) {
    const sorted = [...clientNames].sort((a, b) => String(b).length - String(a).length);
    for (const name of sorted) {
      if (clientNameMentionedInQuestion(q, name)) {
        clientName = name;
        break;
      }
    }
  }

  if (!clientName && hasExplicitClientCue(q)) {
    const m = q.match(
      /\b(?:with|for|from|client|sponsor|customer|account)\s+([A-Za-z][A-Za-z0-9 .&'+-]{1,40?}?)(?:\s+last|\s+in\s+20|\s+studies|\s+patients|\s+enrollment|\?|$)/i
    );
    if (m) clientName = m[1].trim();
  }

  return { studyId, clientName, year, crossStudy };
}

/** Ora earned fees (portfolio) vs sponsor corporate revenue (web). */
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

/**
 * Two primary Buddy workflows (+ teach for live context).
 * body.buddyWorkflow wins when set (budget | feasibility | teach | auto).
 */
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
    if (/\b(feasib|psm|site slate|competing|trialhub|scorecard|win themes?)\b/i.test(q)) {
      return "feasibility";
    }
    if (/\b(budget|hlbp|ballpark|pricing|rfp|quote|service fees?|internal budget)\b/i.test(q)) {
      return "budget";
    }
  }
  return "auto";
}

function claimMap(claims) {
  const map = {};
  if (!Array.isArray(claims)) return map;
  for (const c of claims) {
    if (!c || c.typ == null) continue;
    map[String(c.typ)] = c.val;
    const short = String(c.typ).split("/").pop();
    if (short && map[short] == null) map[short] = c.val;
  }
  return map;
}

function firstNameFrom(displayName, email, givenName) {
  if (givenName && String(givenName).trim()) {
    return String(givenName).trim().split(/\s+/)[0];
  }
  if (displayName && String(displayName).trim()) {
    const d = String(displayName).trim();
    if (!d.includes("@")) return d.split(/[\s,]+/)[0];
  }
  if (email && String(email).includes("@")) {
    const local = String(email).split("@")[0];
    const token = local.split(/[._-]/)[0];
    if (token) return token.charAt(0).toUpperCase() + token.slice(1);
  }
  return null;
}

/** Prefer SWA Easy Auth headers; never trust client-supplied identity alone. */
function signedInUserFromRequest(request, bodyUser) {
  const encoded = headerGet(request, "x-ms-client-principal");
  if (encoded) {
    try {
      const raw = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      const claims = claimMap(raw.claims);
      const email =
        raw.userDetails ||
        claims.preferred_username ||
        claims.email ||
        claims.emails ||
        headerGet(request, "x-ms-client-principal-name") ||
        null;
      const displayName =
        claims.name ||
        claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"] ||
        null;
      const givenName =
        claims.given_name ||
        claims.givenname ||
        claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname"] ||
        null;
      const firstName = firstNameFrom(displayName, email, givenName);
      return {
        userId: raw.userId || headerGet(request, "x-ms-client-principal-id") || null,
        identityProvider: raw.identityProvider || headerGet(request, "x-ms-client-principal-idp") || "aad",
        email: email || null,
        displayName: displayName || email || null,
        firstName,
        source: "swa_principal"
      };
    } catch (_) {
      /* fall through */
    }
  }

  const headerName = headerGet(request, "x-ms-client-principal-name");
  if (headerName) {
    return {
      userId: headerGet(request, "x-ms-client-principal-id") || null,
      identityProvider: headerGet(request, "x-ms-client-principal-idp") || "aad",
      email: headerName.includes("@") ? headerName : null,
      displayName: headerName,
      firstName: firstNameFrom(headerName, headerName, null),
      source: "swa_headers"
    };
  }

  // Local / pre-auth preview only — optional hint from browser /.auth/me
  if (bodyUser && (bodyUser.email || bodyUser.displayName || bodyUser.firstName)) {
    const email = bodyUser.email || null;
    const displayName = bodyUser.displayName || email;
    return {
      userId: bodyUser.userId || null,
      identityProvider: bodyUser.identityProvider || "client",
      email,
      displayName,
      firstName: bodyUser.firstName || firstNameFrom(displayName, email, null),
      source: "client_hint"
    };
  }

  return null;
}

async function collectXlsxFromRequest(request) {
  const files = [];
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    for (const [key, value] of form.entries()) {
      if (key === "mode" || key === "requestedBy") continue;
      if (value && typeof value.arrayBuffer === "function") {
        const name = value.name || key;
        const buf = Buffer.from(await value.arrayBuffer());
        files.push({ name, buffer: buf });
      }
    }
    return {
      files,
      mode: String(form.get("mode") || "load"),
      requestedBy: String(form.get("requestedBy") || "anonymous")
    };
  }

  // Raw single file body with filename header
  const buf = Buffer.from(await request.arrayBuffer());
  const name = request.headers.get("x-file-name") || "upload.xlsx";
  files.push({ name, buffer: buf });
  return { files, mode: "load", requestedBy: "anonymous" };
}

function zipBaseName(entryName) {
  const parts = String(entryName || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function isParseableExcel(name) {
  const low = String(name || "").toLowerCase();
  return low.endsWith(".xlsx") || low.endsWith(".xlsm");
}

function expandArchives(files, depth = 0) {
  const out = [];
  for (const f of files) {
    const lower = String(f.name || "").toLowerCase();
    if (lower.endsWith(".zip")) {
      if (depth > 3) continue;
      const zip = new AdmZip(f.buffer);
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const full = String(entry.entryName || "").replace(/\\/g, "/");
        if (full.includes("__MACOSX/") || full.endsWith(".DS_Store")) continue;
        const en = zipBaseName(full);
        if (!en || en.startsWith("~$")) continue;
        const enLow = en.toLowerCase();
        if (enLow.endsWith(".zip")) {
          out.push(
            ...expandArchives([{ name: en, buffer: entry.getData() }], depth + 1)
          );
          continue;
        }
        if (!isParseableExcel(en)) continue;
        // Preserve folder uniqueness in the study/file name
        const folderPrefix = full
          .slice(0, Math.max(0, full.length - en.length))
          .replace(/\/+$/, "")
          .replace(/[\\/]+/g, "_");
        const name = folderPrefix ? `${folderPrefix}_${en}` : en;
        out.push({ name, buffer: entry.getData() });
      }
    } else if (isParseableExcel(f.name)) {
      out.push(f);
    }
  }
  return out;
}

app.http("import", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "import",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "content-type"
        }
      };
    }

    const jobId = `job-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    const report = {
      jobId,
      loaded: [],
      quarantined: [],
      failed: []
    };

    try {
      const { files, mode } = await collectXlsxFromRequest(request);
      const workbooks = expandArchives(files);
      if (!workbooks.length) {
        return json(400, { error: "No .xlsx/.xlsm workbooks found in upload (nested zip folders are scanned)" });
      }

      const dryRun = mode === "dry";
      let learnings = null;
      try {
        learnings = await loadLearnings(getDb);
      } catch (_) {
        learnings = null;
      }

      for (const wb of workbooks) {
        try {
          const canonical = await parseWorkbookBuffer(wb.buffer, wb.name, { learnings });
          const entry = {
            file: wb.name,
            studyId: canonical.study.studyId,
            confidence: canonical.confidence,
            lineItems: canonical.version.lineItemCount,
            warnings: canonical.warnings,
            quarantineReasons: canonical.quarantineReasons || [],
            missingSheets: canonical.fingerprint?.missingSheets || [],
            learnHints: canonical.learnHints || null
          };
          if (dryRun) {
            entry.cosmosStatus = canonical.quarantine ? "quarantined" : "dry_run_ok";
            (canonical.quarantine ? report.quarantined : report.loaded).push(entry);
          } else {
            const summary = await upsertCanonical(canonical, jobId);
            entry.cosmosStatus = summary.status;
            entry.versionId = summary.versionId;
            entry.learningPromoted = summary.learningPromoted || 0;
            // Refresh learnings so later files in the same batch benefit
            try {
              learnings = await loadLearnings(getDb);
            } catch (_) {}
            (summary.status === "quarantined" ? report.quarantined : report.loaded).push(entry);
          }
          context.log(`OK ${wb.name} -> ${entry.studyId} (${entry.cosmosStatus})`);
        } catch (err) {
          context.error(`FAIL ${wb.name}`, err);
          let msg = String(err.message || err);
          if (/firewall|blocked by your Cosmos|through public internet/i.test(msg)) {
            msg = "COSMOS_FIREWALL: Azure blocked the API IP. Cosmos → Networking → allow Azure datacenters (or All networks).";
          }
          if (/Entity with the specified id already exists|Request size is too large|Timeout|timed out/i.test(msg)) {
            msg = `COSMOS_WRITE: ${msg.slice(0, 300)}`;
          }
          report.failed.push({
            file: wb.name,
            error: msg,
            errorName: err.name || null,
            stack: String(err.stack || "").split("\n").slice(0, 4)
          });
        }
      }

      report.counts = {
        loaded: report.loaded.length,
        quarantined: report.quarantined.length,
        failed: report.failed.length,
        files: workbooks.length
      };
      report.mode = dryRun ? "dry" : "load";
      return json(200, report);
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err), jobId });
    }
  }
});

app.http("studies", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "studies",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "content-type"
        }
      };
    }
    try {
      if (request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const result = await createManualStudy(body || {});
        return json(200, result);
      }
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get("limit") || 500);
      const budgetType = String(url.searchParams.get("budgetType") || url.searchParams.get("category") || "")
        .trim()
        .toLowerCase();
      let studies = await listStudies(limit);
      if (budgetType && budgetType !== "all") {
        studies = studies.filter((s) => {
          const bt = String(s.budgetType || s.category || "").toLowerCase();
          if (budgetType === "hlbp") return bt === "hlbp" || bt.includes("ballpark");
          if (budgetType === "uploaded") return bt && bt !== "hlbp" && bt !== "draft" && !bt.includes("ballpark");
          return bt === budgetType || bt.includes(budgetType);
        });
      }
      return json(200, { studies, filter: { budgetType: budgetType || "all" } });
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("studyById", {
  methods: ["GET", "PUT", "OPTIONS"],
  authLevel: "anonymous",
  route: "studies/{studyId}",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
          "Access-Control-Allow-Headers": "content-type"
        }
      };
    }
    try {
      const studyId = request.params.studyId;
      if (request.method === "PUT") {
        const body = await request.json().catch(() => ({}));
        const result = await saveStudyVersion(studyId, { ...(body || {}), mode: body?.mode || "update" });
        return json(200, result);
      }
      const study = await getStudy(studyId);
      if (!study) return json(404, { error: `Study ${studyId} not found` });
      const versions = await listVersions(studyId);
      let version = null;
      let lineItems = [];
      const versionId = study.currentVersionId || (versions[0] && versions[0].id);
      if (versionId) {
        version = await getVersion(studyId, versionId);
        lineItems = await listLineItems(studyId, versionId, { limit: 400 });
      }
      return json(200, { study, versions, version, lineItems });
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("studyVersions", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "studies/{studyId}/versions",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "content-type"
        }
      };
    }
    try {
      const studyId = request.params.studyId;
      if (request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const result = await saveStudyVersion(studyId, { ...(body || {}), mode: "new" });
        return json(200, result);
      }
      const versions = await listVersions(studyId);
      return json(200, { studyId, versions });
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("studyVersionById", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "studies/{studyId}/versions/{versionId}",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS"
        }
      };
    }
    try {
      const { studyId, versionId } = request.params;
      const version = await getVersion(studyId, versionId);
      if (!version) return json(404, { error: "Version not found" });
      const lineItems = await listLineItems(studyId, versionId, { limit: 400 });
      return json(200, { version, lineItems });
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("studyLocks", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "studies/{studyId}/locks",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "content-type"
        }
      };
    }
    try {
      const locks = await listSectionLocks(request.params.studyId);
      return json(200, { locks });
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("studyLockBySection", {
  methods: ["PUT", "DELETE", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "studies/{studyId}/locks/{sectionId}",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "PUT, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "content-type"
        }
      };
    }
    try {
      const { studyId, sectionId } = request.params;
      const body = await request.json().catch(() => ({}));
      const user = signedInUserFromRequest(request, body.user || null) || body.user || {};
      const holder = {
        userId: user.userId || user.email || body.userId || null,
        email: user.email || body.email || null,
        displayName: user.displayName || user.firstName || body.displayName || null,
        firstName: user.firstName || null
      };

      if (request.method === "PUT") {
        const action = String(body.action || "claim").toLowerCase();
        if (action === "heartbeat") {
          const result = await heartbeatSectionLock(studyId, sectionId, holder, body.draft || null);
          return json(200, result);
        }
        if (action === "request_takeover") {
          const result = await requestSectionTakeover(studyId, sectionId, holder);
          return json(200, result);
        }
        if (action === "takeover" || action === "force") {
          const result = await claimSectionLock(studyId, sectionId, holder, {
            takeover: true,
            force: action === "force" || Boolean(body.force)
          });
          return json(200, result);
        }
        try {
          const result = await claimSectionLock(studyId, sectionId, holder, {});
          return json(200, result);
        } catch (err) {
          if (err.status === 409) {
            return json(409, { error: String(err.message || err), lock: err.lock || null });
          }
          throw err;
        }
      }

      if (request.method === "POST") {
        // Section save while holding lock
        const locks = await listSectionLocks(studyId);
        const lock = locks.find((l) => l.sectionId === sectionId);
        const holderId = holder.userId || holder.email;
        const holds =
          lock &&
          (lock.holderUserId === holderId ||
            (holder.email && lock.holderEmail === holder.email));
        if (!holds) {
          return json(403, {
            error: lock
              ? `${lock.holderName || "Someone"} is editing this tab — Save is blocked until they Done or release.`
              : "You must click Edit on this tab before saving.",
            lock: lock || null
          });
        }
        const result = await saveSectionPatch(studyId, sectionId, {
          ...(body.payload || body),
          mode: body.mode || "update",
          source: "section_lock_save"
        });
        // refresh heartbeat draft clear optional
        await heartbeatSectionLock(studyId, sectionId, holder, body.payload || body || null).catch(
          () => null
        );
        return json(200, result);
      }

      // DELETE — release
      const result = await releaseSectionLock(studyId, sectionId, holder, {
        force: Boolean(body.force)
      });
      return json(200, result);
    } catch (err) {
      context.error(err);
      const status = err.status || 500;
      return json(status, { error: String(err.message || err), lock: err.lock || null });
    }
  }
});

app.http("studyCompare", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "studies/{studyId}/compare",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS"
        }
      };
    }
    try {
      const studyId = request.params.studyId;
      const url = new URL(request.url);
      const older = url.searchParams.get("older");
      const newer = url.searchParams.get("newer");
      if (!older || !newer) {
        return json(400, { error: "Query params older & newer (version ids) are required" });
      }
      const diff = await compareVersions(studyId, older, newer);
      return json(200, diff);
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("budgetsCompare", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "compare",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS"
        }
      };
    }
    try {
      const url = new URL(request.url);
      const left = url.searchParams.get("left");
      const right = url.searchParams.get("right");
      const leftVersion = url.searchParams.get("leftVersion");
      const rightVersion = url.searchParams.get("rightVersion");
      if (!left || !right) {
        return json(400, { error: "Query params left & right (study ids) are required" });
      }
      const diff = await compareStudies(left, right, leftVersion, rightVersion);
      return json(200, diff);
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("GetRoles", {
  methods: ["POST", "GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "GetRoles",
  handler: async (request) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "content-type"
        }
      };
    }
    // SWA calls this after Entra login to assign custom roles.
    // Returning "reader" for any successful auth; Entra group assignment still gates who can sign in.
    try {
      if (request.method === "POST") {
        await request.json().catch(() => ({}));
      }
    } catch (_) {
      /* ignore body parse errors */
    }
    return json(200, { roles: ["reader"] });
  }
});

app.http("health", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: async () => {
    const llm = providerStatus();
    return json(200, {
      ok: true,
      service: "study-bid-workbench-api",
      llm
    });
  }
});

app.http("intelligenceHealth", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "intelligence",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "content-type"
        }
      };
    }
    try {
      const health = await getIntelligenceHealth(getDb);
      return json(200, health);
    } catch (err) {
      context.error(err);
      return json(500, { ok: false, error: String(err.message || err) });
    }
  }
});

app.http("intelligenceIndication", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "intelligence/indication",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "content-type"
        }
      };
    }
    try {
      const q = request.query.get("q") || request.query.get("indication") || "";
      const countryRaw =
        request.query.get("countries") ||
        request.query.get("country") ||
        request.query.get("region") ||
        "";
      const global =
        request.query.get("global") === "true" ||
        String(countryRaw).toLowerCase() === "global";
      if (!String(q).trim() && !String(countryRaw).trim() && !global) {
        return json(400, { error: "query param q (indication) and/or country is required" });
      }
      const pack = await buildIntelligenceContext(getDb, {
        question: `benchmark ${q} ${countryRaw}`.trim(),
        indication: String(q).trim() || null,
        countries: global ? null : countryRaw,
        global,
        force: true
      });
      return json(200, pack);
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("intelligenceSiteScorecard", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "intelligence/sitescorecard",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "content-type"
        }
      };
    }
    try {
      const q = request.query.get("q") || request.query.get("indication") || "";
      const countryRaw =
        request.query.get("countries") ||
        request.query.get("country") ||
        request.query.get("region") ||
        "";
      const global =
        request.query.get("global") === "true" ||
        String(countryRaw).toLowerCase() === "global";
      const source = request.query.get("source") || "ora";
      const includeLegacy =
        request.query.get("includeLegacy") === "true" ||
        request.query.get("legacy") === "true";
      const legacyOnly =
        request.query.get("legacyOnly") === "true" ||
        request.query.get("legacyBoard") === "true";
      if (legacyOnly || (includeLegacy && !String(q).trim() && !String(countryRaw).trim() && !global)) {
        const board = await buildLegacyRecruitmentBoard(getDb, {
          indication: String(q).trim() || null
        });
        return json(board.legacy?.error ? 500 : 200, board);
      }
      if (!String(q).trim() && !String(countryRaw).trim() && !global) {
        return json(400, { error: "q (indication) and/or country is required" });
      }
      const card = await buildSiteScorecard(getDb, {
        indication: String(q).trim() || null,
        countries: global ? null : countryRaw,
        global,
        source,
        includeLegacy
      });
      return json(card.error ? 400 : 200, card);
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("buddyContext", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "buddy/context",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "content-type"
        }
      };
    }
    try {
      if (request.method === "GET") {
        const pack = await loadLiveContext(getDb);
        return json(200, pack);
      }
      let body = {};
      try {
        body = (await request.json()) || {};
      } catch (_) {
        body = {};
      }
      const user = signedInUserFromRequest(request, null);
      // Append-only — no password; full replace (body.text without append) is rejected in saveLiveContext
      const result = await saveLiveContext(getDb, {
        text: body.text != null ? body.text : undefined,
        append: body.append || body.addition || null,
        dept: body.dept || body.department || null,
        category: body.category || null,
        title: body.title,
        user
      });
      return json(result.ok ? 200 : 400, result);
    } catch (err) {
      context.error(err);
      return json(500, { ok: false, error: String(err.message || err) });
    }
  }
});

app.http("trialhubUpload", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "trialhub/upload",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "content-type, x-file-name, x-copilot-key"
        }
      };
    }
    try {
      const auth = authorizeCtgovSync(request);
      if (!auth.ok) {
        return json(401, {
          error: "Unauthorized — sign in, or pass x-copilot-key (same as Copilot Ask key)"
        });
      }

      const dryRun =
        String(request.query.get("dry") || "").toLowerCase() === "true" ||
        String(request.query.get("dryRun") || "").toLowerCase() === "true";

      const { files } = await collectXlsxFromRequest(request);
      const xlsx = (files || []).find((f) => isParseableExcel(f.name));
      if (!xlsx) {
        return json(400, {
          error: "Upload a TrialHub .xlsx export (Trials Search Data)."
        });
      }

      const uploadedBy =
        (auth.user && (auth.user.email || auth.user.displayName)) ||
        auth.via ||
        null;

      context.log(
        `TrialHub upload ${xlsx.name} (${xlsx.buffer.length} bytes) dryRun=${dryRun} via=${auth.via}`
      );
      const result = await ingestTrialHubUpload(getDb, xlsx.buffer, {
        fileName: xlsx.name,
        uploadedBy,
        dryRun
      });
      return json(result.ok || dryRun ? 200 : 500, result);
    } catch (err) {
      context.error(err);
      let msg = String(err.message || err);
      if (/firewall|blocked by your Cosmos|through public internet/i.test(msg)) {
        msg =
          "COSMOS_FIREWALL: Azure blocked the API IP. Cosmos → Networking → allow Azure datacenters (or All networks).";
      }
      return json(500, { ok: false, error: msg });
    }
  }
});

app.http("ctgovSync", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "ctgov/sync",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "content-type, x-copilot-key"
        }
      };
    }
    try {
      if (request.method === "GET") {
        const status = await getCtgovSyncStatus(getDb);
        return json(200, status);
      }

      const auth = authorizeCtgovSync(request);
      if (!auth.ok) {
        return json(401, {
          error: "Unauthorized — sign in, or pass x-copilot-key (same as Copilot Ask key)"
        });
      }

      let body = {};
      try {
        body = (await request.json()) || {};
      } catch (_) {
        body = {};
      }
      const full = body.full === true || request.query.get("full") === "true";
      const remapOnly =
        body.remap === true ||
        body.remapIndications === true ||
        request.query.get("remap") === "true";
      if (remapOnly && !full) {
        const remap = await remapCtgovIndications(getDb, { max: Number(body.max) || 5000 });
        return json(remap.ok ? 200 : 500, { ok: remap.ok, mode: "remap_indications", ...remap });
      }
      const result = await runCtgovSync(getDb, {
        full,
        triggeredBy: auth.via === "copilot_key" ? "scheduler_or_key" : `ui:${auth.user?.email || auth.user?.userId || "user"}`
      });
      return json(result.ok || result.skipped ? 200 : 500, result);
    } catch (err) {
      context.error(err);
      return json(500, { ok: false, error: String(err.message || err) });
    }
  }
});

app.http("salesforceSync", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "salesforce/sync",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "content-type, x-copilot-key"
        }
      };
    }
    try {
      if (request.method === "GET") {
        const status = await getSalesforceSyncStatus(getDb);
        let tables = null;
        try {
          tables = await getSalesforceTablesStatus(getDb);
        } catch (_) {
          tables = null;
        }
        return json(200, { ...status, tables });
      }

      const auth = authorizeCtgovSync(request);
      if (!auth.ok) {
        return json(401, {
          error: "Unauthorized — sign in, or pass x-copilot-key (same as Copilot Ask key)"
        });
      }

      let body = {};
      try {
        body = (await request.json()) || {};
      } catch (_) {
        body = {};
      }
      const dryRun = body.dryRun === true || request.query.get("dryRun") === "true";
      const tables =
        body.tables === true ||
        body.mode === "tables" ||
        request.query.get("tables") === "true" ||
        request.query.get("mode") === "tables";
      const triggeredBy =
        auth.via === "copilot_key"
          ? "scheduler_or_key"
          : `ui:${auth.user?.email || auth.user?.userId || "user"}`;

      if (tables) {
        const onlyRaw = body.only || request.query.get("only");
        const only = Array.isArray(onlyRaw)
          ? onlyRaw
          : typeof onlyRaw === "string" && onlyRaw.trim()
            ? onlyRaw.split(/[,|;]+/).map((s) => s.trim()).filter(Boolean)
            : null;
        const result = await runSalesforceTablesSync(getDb, {
          dryRun: false,
          only,
          triggeredBy
        });
        return json(result.ok || result.skipped ? 200 : 500, result);
      }

      const result = await runSalesforceCrosswalkSync(getDb, {
        dryRun,
        triggeredBy
      });
      return json(result.ok || result.skipped ? 200 : 500, result);
    } catch (err) {
      context.error(err);
      return json(500, { ok: false, error: String(err.message || err) });
    }
  }
});

app.http("quarantine", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "quarantine",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "content-type"
        }
      };
    }
    try {
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get("limit") || 200);
      const items = await listQuarantine(limit);
      const reasonBuckets = {};
      for (const q of items) {
        const reasons = Array.isArray(q.reason) ? q.reason : [String(q.reason || "unknown")];
        for (const r of reasons) {
          const key = String(r).slice(0, 120);
          reasonBuckets[key] = (reasonBuckets[key] || 0) + 1;
        }
      }
      let learnings = null;
      try {
        learnings = await getParseLearningsSummary();
      } catch (err) {
        learnings = { error: String(err.message || err) };
      }
      return json(200, { count: items.length, reasonBuckets, learnings, items });
    } catch (err) {
      context.error(err);
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("ask", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "ask",
  handler: async (request, context) => handleAskRequest(request, context, { requireCopilotKey: false })
});

/** Copilot Studio entry — same Buddy context builder; requires x-copilot-key. */
app.http("copilotAsk", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "copilot/ask",
  handler: async (request, context) => handleAskRequest(request, context, { requireCopilotKey: true })
});

async function handleAskRequest(request, context, { requireCopilotKey }) {
  if (request.method === "OPTIONS") {
    return {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, x-copilot-key"
      }
    };
  }

  try {
    if (requireCopilotKey) {
      const expected = String(process.env.COPILOT_ASK_KEY || "").trim();
      const got = String(headerGet(request, "x-copilot-key") || "").trim();
      if (!expected || expected.includes("SET_IN") || got !== expected) {
        return json(401, { error: "Invalid or missing x-copilot-key" });
      }
    }

    const body = await request.json();
    const uploaded = await normalizeBuddyAttachments(body.attachments);
    const hasOkUpload = (uploaded.files || []).some((f) => f.ok && f.text);
    let question = String(body.question || "").trim();
    if (!question && hasOkUpload) {
      question =
        "Please review the attached file(s). Extract key specs, summarize what you found, list gaps, and answer based on the file content.";
    }
    if (!question) return json(400, { error: "question is required (or attach a file)" });

    const externalFeedAsk =
      isSourceOverviewQuestion(question) ||
      isTrialhubQuestion(question) ||
      isCtgovQuestion(question) ||
      isVeevaQuestion(question);
    const catalogAskEarly =
      /\b(what(?:'s| is) in (?:the )?(?:db|database|cosmos)|data\s+catalog|container\s+counts?|ingest(?:ion)?\s+freshness|how many (?:trials|studies|sites) (?:in|does) (?:cosmos|the db|the database))\b/i.test(
        question
      );
    const buddyWorkflowEarly = inferBuddyWorkflow(question, body);
    const moneyIntentEarly = inferMoneyIntent(question);
    const skipHeavyPortfolio =
      buddyWorkflowEarly === "teach" ||
      ((externalFeedAsk || catalogAskEarly) &&
        buddyWorkflowEarly !== "budget" &&
        !isPricingQuestion(question) &&
        moneyIntentEarly !== "ora_earned" &&
        !/\b(portfolio|budget|fee|revenue|hlbp|ballpark|bid|pricing)\b/i.test(question));

    // ALWAYS query Cosmos for the full portfolio — unless feed/catalog/teach (avoids SWA ~45s timeout).
    let portfolioFull = null;
    let clientDirectory = [];
    if (skipHeavyPortfolio) {
      portfolioFull = {
        source: "cosmos_portfolio_skipped",
        skipped: true,
        note:
          "Portfolio rollup skipped — this ask targets TrialHub / CT.gov / Veeva / catalog data. Use context.intelligence (not portfolio.matchedStudyCount) for feed counts."
      };
    } else {
      try {
        portfolioFull = await buildPortfolioContext({ limit: 500 });
        clientDirectory = portfolioFull.clientNamesInDatabase || [];
      } catch (err) {
        portfolioFull = { source: "cosmos_portfolio_error", error: String(err.message || err) };
        clientDirectory = [];
      }
    }

    const hints = inferAskHints(question, body, clientDirectory);
    // Year in a TrialHub/CT.gov/Veeva ask filters feed stats — not budget portfolio rows.
    if (externalFeedAsk && hints.year) {
      hints.portfolioYear = hints.year;
      hints.year = null;
    }
    // Belt-and-suspenders: never keep a 1–3 char client filter without an explicit cue
    if (
      hints.clientName &&
      String(hints.clientName).trim().length <= 3 &&
      !body.clientName &&
      !hasExplicitClientCue(question)
    ) {
      hints.clientName = null;
    }
    const moneyIntent = inferMoneyIntent(question);
    const buddyWorkflow = inferBuddyWorkflow(question, body);
    // Ora-earned fee rankings are always portfolio-scope (even with a study open)
    if (moneyIntent === "ora_earned") {
      hints.crossStudy = true;
      hints.studyId = hints.studyId && /\b(O-\d{3,})\b/i.test(question) ? hints.studyId : null;
    }
    // noStudy / empty selection = portfolio only — EXCEPT when the user attached docs
    // (otherwise Buddy ignores the file and dumps a portfolio overview).
    // body.portfolio=true only means "attach portfolio data" — not force focus.
    const attachmentDriven = hasOkUpload;
    const forcePortfolio =
      buddyWorkflow !== "teach" &&
      buddyWorkflow !== "feasibility" &&
      !attachmentDriven &&
      (body.noStudy === true ||
        Boolean(hints.crossStudy) ||
        moneyIntent === "ora_earned" ||
        (!body.studyId && !body.studySnapshot));
    const studyId = forcePortfolio
      ? (String(question).match(/\b(O-\d{3,})\b/i) || [])[1] || null
      : hints.studyId;
    const crossStudy = !attachmentDriven && (Boolean(hints.crossStudy) || forcePortfolio);
    const history = body.history || [];
    const user = signedInUserFromRequest(request, body.user || null);
    const activeTab = body.activeTab ? String(body.activeTab) : null;
    const activeTabLabel = body.activeTabLabel ? String(body.activeTabLabel) : null;
    const editableFields = Array.isArray(body.editableFields) ? body.editableFields : null;
    const fieldsByTab = body.fieldsByTab && typeof body.fieldsByTab === "object" ? body.fieldsByTab : null;

    const answerFocus =
      buddyWorkflow === "teach"
        ? "teach"
        : buddyWorkflow === "feasibility"
          ? "feasibility"
          : attachmentDriven
            ? studyId || body.studySnapshot
              ? "single_study"
              : "attachments"
            : forcePortfolio || crossStudy
              ? "portfolio"
              : studyId || body.studySnapshot
                ? "single_study"
                : "portfolio";

    // Browser working copy only for single-study questions
    const clientStudy = answerFocus === "portfolio" ? null : body.studySnapshot || null;

    let cosmosContext = null;
    let sectionLocks = [];
    if (studyId && answerFocus === "single_study") {
      cosmosContext = await getStudyContext(studyId, { getDb });
      try {
        sectionLocks = await listSectionLocks(studyId);
      } catch (_) {
        sectionLocks = Array.isArray(body.sectionLocks) ? body.sectionLocks : [];
      }
    } else if (Array.isArray(body.sectionLocks)) {
      sectionLocks = body.sectionLocks;
    }

    // Prefer filtered portfolio when the question names a client/year; else full DB rollup
    let portfolio = portfolioFull;
    if (
      portfolioFull &&
      portfolioFull.source === "cosmos_portfolio" &&
      (hints.clientName || hints.year)
    ) {
      try {
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
            note: `No studies matched client filter "${hints.clientName}". Showing full database portfolio.`
          };
        } else {
          portfolio = filtered;
        }
      } catch (err) {
        portfolio = { ...portfolioFull, filterError: String(err.message || err) };
      }
    }

    // Ora Clinical Intelligence (Veeva + TrialHub) — same filters as Intelligence tab when provided
    let intelligence = null;
    try {
      const hint =
        body.intelligenceHint && typeof body.intelligenceHint === "object"
          ? body.intelligenceHint
          : {};
      const hintIndication = String(hint.indication || body.indication || "").trim() || null;
      const hintCountry = String(hint.country || body.country || body.region || "").trim() || null;

      const snap = body.studySnapshot || clientStudy || null;
      const snapIndication =
        (snap && snap.indication) ||
        (cosmosContext && cosmosContext.study && cosmosContext.study.indication) ||
        null;
      const snapClient =
        (snap && snap.clientName) ||
        (cosmosContext && cosmosContext.study && cosmosContext.study.clientName) ||
        null;
      const qIndication = extractIndicationFromQuestion(question);
      const qCountry = extractCountryFromQuestion(question);
      const sourceOverviewAsk = isSourceOverviewQuestion(question);
      const salesforceAsk = isSalesforceDataQuestion(question);
      const catalogAsk =
        /\b(what(?:'s| is) in (?:the )?(?:db|database|cosmos)|data\s+catalog|container\s+counts?|ingest(?:ion)?\s+freshness|how many (?:trials|studies|sites) (?:in|does) (?:cosmos|the db|the database))\b/i.test(
          question
        );
      // Cosmos-first: question text wins over whatever tab/hint is open in the browser.
      // Source dashboards (CT.gov / TrialHub / Veeva / crosswalk): ignore open-study indication
      // so Dry Eye (etc.) does not hijack a feed-wide overview ask.
      // Only use open-study / tab hint filters when the ask itself is intel-shaped.
      // Never force a full intel Cosmos pull just because Dry Eye (etc.) is open in the UI —
      // that was timing out Buddy asks (500s) on remember/ops/field-fill questions.
      const forceIntel =
        buddyWorkflow === "feasibility" ||
        (buddyWorkflow !== "budget" &&
          buddyWorkflow !== "teach" &&
          (isIntelligenceQuestion(question) ||
            sourceOverviewAsk ||
            salesforceAsk ||
            catalogAsk ||
            wantsDocumentExport(question) ||
            wantsHtmlVisual(question) ||
            hasOkUpload ||
            isPricingQuestion(question) ||
            Boolean(nctFromQuestion(question)) ||
            Boolean(qIndication) ||
            Boolean(qCountry)));

      const indication = forceIntel
        ? qIndication || (sourceOverviewAsk ? null : hintIndication || snapIndication) || null
        : qIndication || null;
      const country = forceIntel
        ? qCountry || (sourceOverviewAsk && !qCountry ? null : hintCountry) || null
        : qCountry || null;

      if (forceIntel) {
        const rfpHint = extractRfpScenarioFromQuestion(question, body);
        let indFromFiles = null;
        if (!indication && !rfpHint.indication && hasOkUpload && !sourceOverviewAsk) {
          const blob = (uploaded.files || [])
            .map((f) => `${f.name || ""}\n${String(f.text || "").slice(0, 4000)}`)
            .join("\n");
          indFromFiles = extractIndicationFromQuestion(blob);
        }
        const intelTimeoutMs = Number(process.env.BUDDY_INTEL_TIMEOUT_MS || 18000);
        const intelPromise = buildIntelligenceContext(getDb, {
          question,
          indication: rfpHint.indication || indication || indFromFiles,
          country,
          clientName: sourceOverviewAsk ? null : hints.clientName || snapClient || null,
          sponsor: sourceOverviewAsk ? null : hints.clientName || snapClient || null,
          force: true
        });
        intelligence = await Promise.race([
          intelPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`intelligence pack timed out after ${intelTimeoutMs}ms`)), intelTimeoutMs)
          )
        ]).catch((err) => ({
          source: "ora_clinical_intelligence_error",
          error: String(err.message || err),
          note: "Skipped heavy intel pack so Buddy can still answer."
        }));
        if (intelligence && !intelligence.error) {
          intelligence.attachedFrom = "cosmos_query";
          intelligence.note =
            "Queried live from Cosmos (ora_fact_* / TrialHub / CT.gov). Not dependent on which Workbench tab is open. Prefer these numbers over invented benchmarks.";
        }
      }
    } catch (err) {
      intelligence = { source: "ora_clinical_intelligence_error", error: String(err.message || err) };
    }

    // Legacy anterior-segment site/study trust & feasibility (separate containers — read only)
    let legacyAnterior = null;
    try {
      const legacyHint =
        body.legacyHint && typeof body.legacyHint === "object" ? body.legacyHint : {};
      const legacyOverviewAsk = isLegacyOverviewQuestion(question);
      const enrollmentConsent =
        body.includeLegacyEnrollment === true ||
        body.useLegacyEnrollment === true ||
        userConsentedLegacyEnrollment(question, history) ||
        isLegacyTableAsk(question) ||
        legacyOverviewAsk ||
        (wantsHtmlVisual(question) && isLegacyAnteriorQuestion(question));
      const forceLegacy =
        buddyWorkflow !== "budget" &&
        buddyWorkflow !== "teach" &&
        (isLegacyAnteriorQuestion(question) ||
          isLegacyTableAsk(question) ||
          legacyOverviewAsk ||
          Boolean(
            legacyHint.siteName ||
              legacyHint.studyName ||
              legacyHint.siteId ||
              legacyHint.studyId
          ) ||
          Boolean(body.legacyPack && body.legacyPack.source === "legacy_anterior_segment") ||
          enrollmentConsent);
      // Do NOT force legacy just because the open study/tab has an indication —
      // that overloaded every Buddy ask and caused timeouts/500s.
      if (body.legacyPack && body.legacyPack.source === "legacy_anterior_segment" && !body.legacyPack.error) {
        legacyAnterior = {
          ...body.legacyPack,
          attachedFrom: "ui_legacy_pack",
          enrollmentIncluded: Boolean(body.legacyPack.enrollmentIncluded || enrollmentConsent),
          note: "Legacy anterior-segment pack from client (not re-queried)."
        };
      } else if (forceLegacy || isLegacyAnteriorQuestion(question) || isLegacyTableAsk(question)) {
        const snap = body.studySnapshot || clientStudy || null;
        const qLegacyInd = extractIndicationFromQuestion(question);
        // Overview/dashboard asks: ignore open-study / tab indication (same class as CT.gov)
        const legacyIndication = legacyOverviewAsk
          ? qLegacyInd
          : qLegacyInd ||
            legacyHint.indication ||
            (body.intelligenceHint && body.intelligenceHint.indication) ||
            body.indication ||
            (snap && snap.indication) ||
            (cosmosContext && cosmosContext.study && cosmosContext.study.indication) ||
            null;
        legacyAnterior = await buildLegacyAnteriorContext(getDb, {
          question,
          siteName: legacyHint.siteName || null,
          studyName: legacyHint.studyName || null,
          siteId: legacyHint.siteId || null,
          studyId: legacyHint.studyId || null,
          indication: legacyIndication ? String(legacyIndication).trim() : null,
          force: forceLegacy || Boolean(legacyIndication),
          includeEnrollment: enrollmentConsent
        });
        if (legacyAnterior && !legacyAnterior.error) {
          legacyAnterior.enrollmentIncluded = enrollmentConsent;
          legacyAnterior.enrollmentAvailable = true;
          if (!enrollmentConsent) {
            legacyAnterior.prompt =
              "Ask the user once: include legacy anterior-segment enrollment (scheduled/screened/enrolled/%), or stick to Ora Veeva / Scorecard only? Do not cite legacy enrollment numbers until they say yes.";
          }
        }
      }
    } catch (err) {
      legacyAnterior = { source: "legacy_anterior_segment_error", error: String(err.message || err) };
    }

    // Past-bid RFP pricing tiers (High Level Ballpark / Moderate / Goal Bid)
    let pricingScenarios = null;
    try {
      const rfp = extractRfpScenarioFromQuestion(question, body);
      if (
        buddyWorkflow !== "feasibility" &&
        buddyWorkflow !== "teach" &&
        (isPricingQuestion(question) || (rfp.wantsTiers && (rfp.enrolledSubjects || rfp.indication)))
      ) {
        const studies =
          (portfolio && portfolio.source === "cosmos_portfolio" && portfolio.studies) ||
          (portfolioFull && portfolioFull.studies) ||
          [];
        pricingScenarios = buildRfpPricingPack(studies, {
          indication:
            rfp.indication ||
            intelligence?.query?.indication ||
            extractIndicationFromQuestion(question) ||
            null,
          enrolledSubjects: rfp.enrolledSubjects,
          coreSites: rfp.coreSites
        });
        if (intelligence && intelligence.ctgov && intelligence.ctgov.dollarMentions) {
          pricingScenarios.ctgovDollars = intelligence.ctgov.dollarMentions;
        } else {
          pricingScenarios.ctgovDollars = {
            available: false,
            note: "CT.gov has no structured CRO bid dollars. Mention free-text $ only when intelligence.ctgov.dollarMentions.available is true."
          };
        }
      }
    } catch (err) {
      pricingScenarios = { source: "past_bid_pricing_error", error: String(err.message || err) };
    }

    // Live Buddy context (Cosmos) — SME additions without redeploy
    let buddyLiveContext = null;
    try {
      buddyLiveContext = await loadLiveContext(getDb);
      if (buddyLiveContext && !buddyLiveContext.text) buddyLiveContext = { ...buddyLiveContext, empty: true };
    } catch (err) {
      buddyLiveContext = { source: "error", error: String(err.message || err) };
    }

    const visualAsk =
      wantsHtmlVisual(question) ||
      wantsDocumentExport(question) ||
      (hasOkUpload &&
        /\b(create|make|produce|build|generate|draft|export|write)\b/i.test(question));
    const docExportAsk = wantsDocumentExport(question) || Boolean(visualAsk && hasOkUpload);
    const openStudyId = body.studyId ? String(body.studyId).trim() : null;
    const modelTier = inferModelTier(question, body, buddyWorkflow);
    const contextPayload = {
      askedAt: new Date().toISOString(),
      source: requireCopilotKey ? "copilot_studio" : "workbench",
      modelTier,
      workflow: buddyWorkflow,
      workflowNote:
        buddyWorkflow === "budget"
          ? "BUDGET workflow: use portfolio / workingStudy / pricing / APPLY / CREATE_STUDY / HLBP. Do NOT answer with TrialHub/PSM/site feasibility unless the user explicitly asks."
          : buddyWorkflow === "feasibility"
            ? "FEASIBILITY workflow: use context.intelligence / legacyAnterior / scorecard-style site & enrollment facts. Do NOT invent bid dollars or open an HLBP unless the user explicitly asks for budget/pricing."
            : buddyWorkflow === "teach"
              ? "TEACH workflow: capture durable SME notes. End with LEARN_CONTEXT:{...}. Do not run a budget or feasibility analysis unless asked."
              : "AUTO workflow: pick budget vs feasibility from the question; keep those domains separate.",
      answerFocus,
      moneyIntent,
      wantsHtmlVisual: visualAsk,
      wantsDocumentExport: docExportAsk,
      dataSources: {
        cosmosPortfolioQueried: Boolean(portfolio && portfolio.source === "cosmos_portfolio"),
        databaseStudyCount: portfolio?.databaseStudyCount ?? null,
        matchedStudyCount: portfolio?.matchedStudyCount ?? null,
        intelligenceAttached: Boolean(intelligence && intelligence.source === "ora_clinical_intelligence"),
        legacyAnteriorAttached: Boolean(legacyAnterior && legacyAnterior.source === "legacy_anterior_segment"),
        pricingScenariosAttached: Boolean(pricingScenarios && pricingScenarios.tiers),
        buddyLiveContextAttached: Boolean(buddyLiveContext && buddyLiveContext.text),
        note: "portfolio = budget studies. pricingScenarios = past-bid RFP tiers. intelligence = Ora Veeva + TrialHub + CT.gov. legacyAnterior = anterior-segment overview. buddyLiveContext = SME text from Buddy Context tab."
      },
      user,
      activeTab,
      activeTabLabel,
      sectionLocks: (sectionLocks || []).map((l) => ({
        sectionId: l.sectionId,
        holderName: l.holderName || l.holderEmail || l.holderUserId,
        holderEmail: l.holderEmail || null,
        lockedAt: l.lockedAt || null
      })),
      queryHints: {
        studyId: studyId || null,
        clientName: hints.clientName || null,
        year: hints.year || null,
        feedYear: hints.portfolioYear || null,
        crossStudy,
        intelligence: Boolean(intelligence && !intelligence.error),
        legacyAnterior: Boolean(legacyAnterior && !legacyAnterior.error),
        wantsHtmlVisual: visualAsk
      },
      openStudyInUi: openStudyId
        ? {
            studyId: openStudyId,
            note:
              answerFocus === "portfolio"
                ? "Open in UI only — IGNORE. Answer from context.portfolio (Cosmos)."
                : "Study currently open in the workbench UI."
          }
        : null,
      cosmos: cosmosContext,
      portfolio,
      pricingScenarios,
      intelligence,
      legacyAnterior,
      buddyLiveContext:
        buddyLiveContext && buddyLiveContext.text
          ? {
              source: buddyLiveContext.source,
              updatedAt: buddyLiveContext.updatedAt,
              updatedBy: buddyLiveContext.updatedBy,
              appendOnly: true,
              entryCount: buddyLiveContext.entryCount || null,
              charCount: buddyLiveContext.charCount || null,
              organized: buddyLiveContext.organized || null,
              text: String(buddyLiveContext.text).slice(0, 60000),
              note:
                "Append-only SME live context from Buddy Context tab, grouped by department then category. When asked what is in current/live context, summarize organized by dept/category from this object — do not invent entries."
            }
          : buddyLiveContext
            ? {
                source: buddyLiveContext.source,
                empty: true,
                appendOnly: true,
                organized: { byDepartment: [], entryCount: 0, charCount: 0 },
                note: "No live additions yet — use Buddy Context tab to append by department + category."
              }
            : null,
      workingStudy:
        answerFocus === "portfolio" || !clientStudy
          ? null
          : {
              source: "browser_working_copy",
              studyId: clientStudy.studyId,
              clientName: clientStudy.clientName,
              title: clientStudy.title,
              protocol: clientStudy.protocol,
              phase: clientStudy.phase,
              indication: clientStudy.indication,
              versionLabel: clientStudy.versionLabel,
              drivers: clientStudy.drivers,
              sites: clientStudy.sites,
              budgetType: clientStudy.budgetType,
              sectionStatus: clientStudy.sectionStatus,
              assumptions: clientStudy.assumptions
            },
      editableFields:
        answerFocus === "portfolio"
          ? []
          : (editableFields || []).slice(0, 200).map((f) => ({
              path: f.path,
              label: f.label,
              tab: f.tab,
              tabLabel: f.tabLabel,
              group: f.group,
              value: f.value
            })),
      fieldsByTab: answerFocus === "portfolio" ? null : fieldsByTab,
      uploadedDocuments: {
        count: (uploaded.files || []).length,
        okCount: (uploaded.files || []).filter((f) => f.ok).length,
        totalChars: uploaded.totalChars || 0,
        files: (uploaded.files || []).map((f) =>
          f.ok
            ? {
                name: f.name,
                mimeType: f.mimeType,
                charCount: f.charCount,
                text: f.text
              }
            : {
                name: f.name,
                mimeType: f.mimeType,
                ok: false,
                error: f.error
              }
        ),
        note:
          "User-attached files for this ask. Prefer these over guessing. Extract specs from them; do not ask for facts already present. If a file failed, say so briefly."
      }
    };

    // askAi is soft-fail: never throws for model/provider errors
    const result = await askAi({
      question,
      context: contextPayload,
      history,
      tier: modelTier,
      body
    });
    let answer = result.answer;
    let docExports = [];
    let reportTitle = null;
    try {
      if (
        result.provider !== "error" &&
        (visualAsk || docExportAsk || /HTML_REPORT_START/i.test(String(answer || "")))
      ) {
        const built = await buildBuddyDocExports(answer, question);
        if (built.html) {
          answer = built.answer;
          // Re-attach markers so the client can still open HTML; also send binary exports
          answer = `${built.answer}\n\nHTML_REPORT_START\n${built.html}\nHTML_REPORT_END`;
          reportTitle = built.title;
          docExports = built.exports || [];
        }
      }
    } catch (exportErr) {
      context.warn?.("buddy doc export failed", exportErr);
    }
    const llm = providerStatus();
    return json(200, {
      answer,
      ok: result.provider !== "error",
      model: result.model,
      deployment: llm.deployment || result.model || null,
      displayName: llm.displayName || null,
      provider: result.provider,
      agentError: result.agentError || result.error || null,
      usage: result.usage,
      studyId: answerFocus === "portfolio" ? null : studyId || clientStudy?.studyId || null,
      clientName: hints.clientName || null,
      year: hints.year || null,
      answerFocus,
      workflow: buddyWorkflow,
      modelTier: result.modelTier || modelTier,
      escalated: Boolean(result.escalated),
      agent: result.agent || null,
      documentTitle: reportTitle,
      exports: docExports.map((e) =>
        e.contentBase64
          ? {
              format: e.format,
              filename: e.filename,
              mimeType: e.mimeType,
              contentBase64: e.contentBase64
            }
          : { format: e.format, ok: false, error: e.error }
      ),
      attachments: (uploaded.files || []).map((f) => ({
        name: f.name,
        ok: Boolean(f.ok),
        charCount: f.charCount || 0,
        error: f.error || null
      })),
      portfolioMatched: portfolio?.matchedStudyCount ?? null,
      databaseStudyCount: portfolio?.databaseStudyCount ?? null,
      intelligenceAttached: Boolean(intelligence && intelligence.source === "ora_clinical_intelligence"),
      intelligenceQuery: intelligence?.query || {
        indication: null,
        country: null
      },
      greetedAs: user?.firstName || user?.displayName || null
    });
  } catch (err) {
    // Buddy chat must never 500 — always return a speakable answer for the panel.
    context.error(err);
    const msg = String(err.message || err).slice(0, 400);
    const llm = (() => {
      try {
        return providerStatus();
      } catch (_) {
        return {};
      }
    })();
    return json(200, {
      ok: false,
      answer:
        `I hit an internal error building that reply (${msg}). ` +
        `Try again with a shorter question, or without an open study if this was a simple remember/ops ask.`,
      error: msg,
      provider: "error",
      deployment: llm.deployment || null,
      displayName: llm.displayName || "Buddy",
      answerFocus: "error"
    });
  }
}
