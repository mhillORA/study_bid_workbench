const { app } = require("@azure/functions");
const AdmZip = require("adm-zip");
const { parseWorkbookBuffer } = require("./parseWorkbook");
const { upsertCanonical, createManualStudy, saveStudyVersion, saveSectionPatch, listStudies, getStudy, listVersions, getVersion, listLineItems, compareVersions, compareStudies, listQuarantine, getParseLearningsSummary, loadLearnings, getDb, buildPortfolioContext, listSectionLocks, claimSectionLock, heartbeatSectionLock, requestSectionTakeover, releaseSectionLock } = require("./cosmosLoad");
const {
  getOrBuildDashboardBrief,
  buildDashboardBrief,
  saveCachedBrief,
  loadCachedBrief
} = require("./dashboardBrief");
const { askAi, getStudyContext, providerStatus } = require("./askClaude");
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
  extractCountryFromQuestion,
  extractYearFromQuestion: extractIntelYearFromQuestion,
  extractTherapeuticFilterFromQuestion
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
const { runVeevaTablesSync, getVeevaSyncStatus } = require("./veevaSync");
const { ingestTrialHubUpload } = require("./trialhubIngest");
const {
  isPricingQuestion,
  extractRfpScenarioFromQuestion,
  buildRfpPricingPack
} = require("./rfpPricing");
const { normalizeBuddyAttachments } = require("./buddyAttachments");
const { buildBuddyDocExports, wantsDocumentExport } = require("./buddyDocExport");
const { routeBuddyAsk, isCompareTwoStudiesQuestion, isCrossStudyQuestion, isGeneralKnowledgeAsk } = require("./buddyRouter");
const { fetchBuddyIntelligence, fetchBuddyPortfolio } = require("./buddyCosmosFetch");
const { parseBuddyActions } = require("./buddyActions");
const { maybeHuntAndRetry, toolTraceFromPrefetch } = require("./buddyHunt");
const { storeAttachments, loadAttachments } = require("./buddyAttachmentVault");
const { storeAskPack, loadAskPack } = require("./buddyAskPack");
const {
  mintBuddySession,
  assertBuddySession,
  buddySessionRequired,
  sessionSecret,
  bearerFromRequest,
  verifyBuddySessionToken
} = require("./buddySession");
const {
  loadDeptContexts,
  saveDeptContexts,
  buildDeptContextForAsk,
  resolveBuddyDeptId,
  buddyContextSummary,
  DEFAULT_DEPARTMENTS
} = require("./deptContext");

function routerHasTool(route, name) {
  return Array.isArray(route?.tools) && route.tools.includes(name);
}

function nctFromQuestion(question) {
  const m = String(question || "").match(/\b(NCT\d{8})\b/i);
  return m ? m[1].toUpperCase() : null;
}

function attachmentTextForIntel(uploaded, maxChars = 15000) {
  return (uploaded.files || [])
    .filter((f) => f.ok && f.text)
    .map((f) => `${f.name || ""}\n${String(f.text || "")}`)
    .join("\n\n")
    .slice(0, maxChars);
}

function hasCopilotKey(request) {
  const expected = String(process.env.COPILOT_ASK_KEY || "").trim();
  const got = String(headerGet(request, "x-copilot-key") || "").trim();
  return Boolean(expected && !expected.includes("SET_IN") && got === expected);
}

/**
 * Scheduler uses Copilot key; SWA UI uses signed-in principal;
 * browser → Function App uses Buddy session JWT (VEEVA_* / SF_* live on ora-buddy-api).
 */
function authorizeCtgovSync(request) {
  if (hasCopilotKey(request)) return { ok: true, via: "copilot_key" };
  const user = signedInUserFromRequest(request, null);
  if (user && (user.email || user.userId)) return { ok: true, via: "swa_user", user };
  const token = bearerFromRequest(request, headerGet);
  if (token) {
    const verified = verifyBuddySessionToken(token);
    if (verified.ok) {
      return {
        ok: true,
        via: "buddy_session",
        user: {
          email: verified.payload?.email || null,
          userId: verified.payload?.sub || null,
          displayName: verified.payload?.name || null
        }
      };
    }
  }
  return { ok: false };
}

function corsHeaders(request = null) {
  const allowed = String(process.env.BUDDY_CORS_ORIGIN || "")
    .trim()
    .replace(/\/$/, "");
  const reqOrigin = request
    ? String(
        (typeof request.headers?.get === "function"
          ? request.headers.get("origin") || request.headers.get("Origin")
          : "") || ""
      )
        .trim()
        .replace(/\/$/, "")
    : "";
  // Prefer echoing the browser Origin when it matches allow-list (required for CORS).
  let origin = "*";
  if (allowed) {
    origin = reqOrigin && reqOrigin === allowed ? reqOrigin : allowed;
  } else if (reqOrigin) {
    origin = reqOrigin;
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "content-type, authorization, x-copilot-key, x-buddy-session",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
    // No Allow-Credentials — Buddy uses Bearer tokens, not cookies. ACAC on POST
    // while platform OPTIONS omits it confuses some browsers.
  };
}

function json(status, body, request = null) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request)
    },
    jsonBody: body
  };
}

function optionsOk(request) {
  return {
    status: 204,
    headers: corsHeaders(request)
  };
}

/** Soft Buddy reply when SWA would otherwise kill us with a gateway 500. */
function buddyDeadlineReply(reason) {
  return json(200, {
    ok: false,
    answer:
      "I ran out of time before the gateway cut me off. Ask again with a shorter question, or split visuals into a follow-up (“spin up a visual” after the chat answer).",
    error: String(reason || "ask_deadline").slice(0, 200),
    provider: "error",
    modelTier: "fast",
    answerFocus: "error",
    softDeadline: true
  });
}

function headerGet(request, name) {
  return (
    request.headers.get(name) ||
    request.headers.get(name.toLowerCase()) ||
    request.headers.get(name.toUpperCase()) ||
    ""
  );
}

function extractStudyIdsFromText(text) {
  const ids = [];
  const re = /\b(O-\d{3,}|FILE-[A-Za-z0-9._-]{4,}|HLBP-\d{8,}|NEW-\d{8,})\b/gi;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const id = String(m[1] || "").trim();
    if (id && !ids.some((x) => x.toUpperCase() === id.toUpperCase())) ids.push(id);
  }
  return ids;
}

function normalizeAskedStudyId(id) {
  const s = String(id || "").trim();
  if (!s) return null;
  if (/^\d{4,6}$/.test(s)) return `O-${s.padStart(5, "0")}`;
  if (/^O\d{4,6}$/i.test(s)) return `O-${s.slice(1).padStart(5, "0")}`;
  return s;
}

function resolveComparePair(question, body, portfolio) {
  const fromBody = (Array.isArray(body.compareStudyIds) ? body.compareStudyIds : [])
    .map(normalizeAskedStudyId)
    .filter(Boolean);
  const fromQ = extractStudyIdsFromText(question).map(normalizeAskedStudyId).filter(Boolean);
  const open = body.studyId ? normalizeAskedStudyId(body.studyId) : null;
  const same = (a, b) => String(a || "").toUpperCase() === String(b || "").toUpperCase();

  let left = null;
  let right = null;
  if (fromBody.length >= 2) {
    left = fromBody[0];
    right = fromBody[1];
  } else if (fromQ.length >= 2) {
    left = fromQ[0];
    right = fromQ[1];
  } else if (fromQ.length === 1 && open && !same(fromQ[0], open)) {
    left = open;
    right = fromQ[0];
  } else if (fromBody.length === 1 && open && !same(fromBody[0], open)) {
    left = open;
    right = fromBody[0];
  } else if (fromQ.length === 1 && fromBody.length === 1 && !same(fromQ[0], fromBody[0])) {
    left = fromBody[0];
    right = fromQ[0];
  } else {
    const client = String(body.clientName || "").trim();
    const studies = Array.isArray(portfolio?.studies) ? portfolio.studies : [];
    let hits = [];
    if (client) {
      const cl = client.toLowerCase();
      hits = studies.filter((s) => String(s.clientName || "").toLowerCase().includes(cl));
    }
    if (hits.length === 2) {
      left = hits[0].studyId;
      right = hits[1].studyId;
    } else if (hits.length > 2) {
      return {
        needIds: true,
        note: `Found ${hits.length} studies for ${client}. Name two O-ids (or check two on the Studies tab).`,
        candidates: hits.slice(0, 12).map((s) => ({
          studyId: s.studyId,
          clientName: s.clientName,
          title: s.title,
          indication: s.indication,
          phase: s.phase
        }))
      };
    }
  }

  if (!left || !right) {
    return {
      needIds: true,
      note: "Need two studies to compare. Name two O-ids (e.g. O-12345 and O-67890), check two on the Studies tab, or open one study and name the other."
    };
  }
  if (same(left, right)) {
    return { needIds: true, note: "Those are the same study id — pick two different studies." };
  }
  return { left, right };
}

function humanizeCompareKey(key) {
  const k = String(key || "");
  const raw = k.startsWith("driver.")
    ? k.slice(7)
    : k.startsWith("header.")
      ? k.slice(7)
      : k.startsWith("total.")
        ? k.slice(6)
        : k;
  const label = raw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_./]+/g, " ")
    .trim();
  if (k.startsWith("total.")) return `Fees / ${label}`;
  if (k.startsWith("driver.")) return label.replace(/^./, (c) => c.toUpperCase());
  return label.replace(/^./, (c) => c.toUpperCase()) || k;
}

function slimStudyComparison(diff) {
  const fieldChanges = (diff.fieldChanges || []).slice(0, 80).map((c) => ({
    field: humanizeCompareKey(c.key),
    key: c.key,
    left: c.previous ?? null,
    right: c.current ?? null
  }));
  const departmentDiffs = (diff.departmentDiffs || [])
    .filter((d) => d.changed)
    .slice(0, 20)
    .map((d) => ({
      department: d.department,
      left: {
        lines: d.previous?.count ?? 0,
        charge: d.previous?.charge ?? 0,
        hours: d.previous?.hours ?? 0
      },
      right: {
        lines: d.current?.count ?? 0,
        charge: d.current?.charge ?? 0,
        hours: d.current?.hours ?? 0
      }
    }));
  const topLineItemDiffs = (diff.lineItemDiffs || [])
    .map((li) => {
      const pc = Number(li.previous?.charge) || 0;
      const cc = Number(li.current?.charge) || 0;
      return { ...li, absDelta: Math.abs(cc - pc) };
    })
    .sort((a, b) => b.absDelta - a.absDelta)
    .slice(0, 25)
    .map((li) => {
      const row = li.current || li.previous || {};
      return {
        oraCode: li.oraCode,
        change: li.change,
        service: row.service || null,
        department: row.department || null,
        leftCharge: li.previous?.charge ?? null,
        rightCharge: li.current?.charge ?? null,
        leftHours: li.previous?.totalHours ?? null,
        rightHours: li.current?.totalHours ?? null
      };
    });
  return {
    left: {
      studyId: diff.leftStudyId,
      clientName: diff.older?.clientName || null,
      version: diff.older?.label || null,
      sourceFile: diff.older?.sourceFileName || null
    },
    right: {
      studyId: diff.rightStudyId,
      clientName: diff.newer?.clientName || null,
      version: diff.newer?.label || null,
      sourceFile: diff.newer?.sourceFileName || null
    },
    fieldChangeCount: (diff.fieldChanges || []).length,
    fieldUnchangedCount: diff.fieldUnchangedCount ?? null,
    fieldChanges,
    departmentDiffs,
    lineItemDiffCount: diff.lineItemDiffCount ?? (diff.lineItemDiffs || []).length,
    topLineItemDiffs,
    note: "left = first study, right = second. Summarize headline differences then notable department / line-item deltas. Cite both study ids. Do not use portfolio averages."
  };
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
  const compareTwo = isCompareTwoStudiesQuestion(q, body);
  const crossStudy =
    !compareTwo &&
    (isCrossStudyQuestion(q) || body.crossStudy === true || body.noStudy === true);
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

/** Known Entra emails whose local-part is a login id, not a given name. */
const PREFERRED_FIRST_NAME_BY_EMAIL = {
  "mhill@oraclinical.com": "Matthew"
};

function emailLocalPart(email) {
  if (!email || !String(email).includes("@")) return "";
  return String(email).split("@")[0].trim().toLowerCase();
}

/**
 * Real given name only — never email local-part / login id (e.g. mhill).
 * Prefer Entra given_name, then a human displayName, then a known email map.
 */
function firstNameFrom(displayName, email, givenName, userId) {
  const preferred = PREFERRED_FIRST_NAME_BY_EMAIL[String(email || "").trim().toLowerCase()];
  if (givenName && String(givenName).trim()) {
    const g = String(givenName).trim().split(/\s+/)[0];
    if (g && !looksLikeLoginId(g, email, userId)) return g;
  }
  if (displayName && String(displayName).trim()) {
    const d = String(displayName).trim();
    if (!d.includes("@")) {
      const first = d.split(/[\s,]+/)[0];
      if (first && !looksLikeLoginId(first, email, userId)) return first;
    }
  }
  if (preferred) return preferred;
  return null;
}

function looksLikeLoginId(token, email, userId) {
  const t = String(token || "").trim();
  if (!t) return true;
  const lower = t.toLowerCase();
  const local = emailLocalPart(email);
  if (local && lower === local) return true;
  if (local && lower === local.split(/[._-]/)[0]) return true;
  if (userId && lower === String(userId).trim().toLowerCase()) return true;
  // Single camel/lower token matching typical AD short names (no space, starts lower)
  if (/^[a-z][a-z0-9]{2,20}$/.test(t) && local && local.startsWith(lower)) return true;
  return false;
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
      const userId = raw.userId || headerGet(request, "x-ms-client-principal-id") || null;
      const firstName = firstNameFrom(displayName, email, givenName, userId);
      return {
        userId,
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
      firstName: firstNameFrom(headerName, headerName, null, null),
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
      firstName: bodyUser.firstName || firstNameFrom(displayName, email, null, bodyUser.userId || null),
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
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "health",
  handler: async (request) => {
    if (request.method === "OPTIONS") return optionsOk(request);
    const llm = providerStatus();
    return json(
      200,
      {
        ok: true,
        service: "study-bid-workbench-api",
        llm,
        externalApi: String(process.env.BUDDY_REQUIRE_SESSION || "")
          .trim()
          .toLowerCase() === "1"
      },
      request
    );
  }
});

/**
 * Mint a short-lived token for the external Buddy Function App.
 * Call from the SWA-hosted UI (Entra already gated /api/*).
 */
app.http("buddySession", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "buddy/session",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") return optionsOk(request);
    try {
      let body = {};
      try {
        body = await request.json();
      } catch (_) {
        body = {};
      }
      const user = signedInUserFromRequest(request, body.user || null);
      const minted = mintBuddySession({
        email: user?.email,
        name: user?.displayName || user?.firstName,
        userId: user?.userId || user?.email
      });
      if (!minted.ok) {
        return json(
          200,
          {
            ok: false,
            error: minted.error,
            apiBase: null,
            useLocalApi: true,
            note: "Session mint unavailable — Buddy will use same-origin /api (SWA 45s limit)."
          },
          request
        );
      }
      // Host-only env (no https://) becomes a relative URL in the browser → 405 on SWA.
      let apiBase = String(
        process.env.BUDDY_API_BASE ||
          "https://ora-buddy-api-hrdbgqh9cvaub5ft.eastus2-01.azurewebsites.net"
      )
        .trim()
        .replace(/\/$/, "")
        .replace(/^\/+/, "");
      if (apiBase && !/^https?:\/\//i.test(apiBase)) {
        apiBase = `https://${apiBase}`;
      }
      return json(
        200,
        {
          ok: true,
          token: minted.token,
          expiresAt: minted.expiresAt,
          expiresIn: minted.expiresIn,
          apiBase: apiBase || null,
          useLocalApi: !apiBase
        },
        request
      );
    } catch (err) {
      context.error?.(err);
      return json(200, { ok: false, error: String(err.message || err), useLocalApi: true }, request);
    }
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

/**
 * Commercial Dashboard weekly brief — cached after nightly sync so BD/leadership
 * open to chase/watch/concentration numbers instead of inventing Buddy questions.
 * GET: prefer cache (rebuild if older than ~20h). POST / ?refresh=true: force rebuild (auth).
 */
app.http("dashboardBrief", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "dashboard/brief",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "content-type, authorization, x-copilot-key, x-buddy-session"
        }
      };
    }
    try {
      const refreshQ = request.query.get("refresh") === "true";
      const forcePost = request.method === "POST";
      let body = {};
      if (forcePost) {
        try {
          body = (await request.json()) || {};
        } catch (_) {
          body = {};
        }
      }
      const refresh = forcePost || refreshQ || body.refresh === true;
      if (refresh) {
        const auth = authorizeCtgovSync(request);
        if (!auth.ok) {
          return json(
            401,
            {
              error:
                "Unauthorized — sign in, Buddy session, or x-copilot-key required to refresh the weekly brief"
            },
            request
          );
        }
        const triggeredBy =
          auth.via === "copilot_key"
            ? "scheduler_or_key"
            : `ui:${auth.user?.email || auth.user?.userId || "user"}`;
        const brief = await buildDashboardBrief(getDb, {
          buildPortfolioContext,
          triggeredBy
        });
        let saved;
        try {
          saved = await saveCachedBrief(getDb, brief);
        } catch (err) {
          saved = { ...brief, cached: false, cacheError: String(err.message || err) };
        }
        return json(200, saved, request);
      }

      const brief = await getOrBuildDashboardBrief(getDb, {
        buildPortfolioContext,
        triggeredBy: "get_or_build",
        refresh: false
      });
      return json(200, brief, request);
    } catch (err) {
      context.error?.(err);
      return json(500, { ok: false, error: String(err.message || err) }, request);
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

app.http("buddyDeptContexts", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "buddy/dept-contexts",
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
        const pack = await loadDeptContexts(getDb);
        return json(200, {
          ok: true,
          ...buddyContextSummary(pack),
          departments: pack.departments,
          updatedAt: pack.updatedAt,
          source: pack.source
        });
      }
      let body = {};
      try {
        body = (await request.json()) || {};
      } catch (_) {
        body = {};
      }
      const user = signedInUserFromRequest(request, body.user || null);
      const result = await saveDeptContexts(getDb, body, {
        requirePassword: false,
        updatedBy: user?.email || user?.displayName || "ui"
      });
      return json(result.ok ? 200 : result.status || 400, result);
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

app.http("veevaSync", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "veeva/sync",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return optionsOk(request);
    }
    try {
      if (request.method === "GET") {
        const status = await getVeevaSyncStatus(getDb);
        return json(200, status, request);
      }

      const auth = authorizeCtgovSync(request);
      if (!auth.ok) {
        return json(
          401,
          {
            error: "Unauthorized — sign in, or pass x-copilot-key (same as Copilot Ask key)"
          },
          request
        );
      }

      let body = {};
      try {
        body = (await request.json()) || {};
      } catch (_) {
        body = {};
      }
      const triggeredBy =
        auth.via === "copilot_key"
          ? "scheduler_or_key"
          : `ui:${auth.user?.email || auth.user?.userId || "user"}`;
      const onlyRaw = body.only || request.query.get("only");
      const only = Array.isArray(onlyRaw)
        ? onlyRaw
        : typeof onlyRaw === "string" && onlyRaw.trim()
          ? onlyRaw.split(/[,|;]+/).map((s) => s.trim()).filter(Boolean)
          : null;
      const full =
        body.full === true ||
        request.query.get("full") === "true" ||
        body.mode === "full";
      const prioritizeEmpty =
        body.prioritizeEmpty === true ||
        body.resume === true ||
        request.query.get("prioritizeEmpty") === "true" ||
        request.query.get("resume") === "true";
      const result = await runVeevaTablesSync(getDb, {
        full,
        delta: !full,
        only,
        prioritizeEmpty,
        triggeredBy
      });
      const errSummary = (result.results || [])
        .filter((r) => r.error)
        .map((r) => `${r.object}: ${r.error}`)
        .join(" · ");
      return json(
        200,
        {
          ...result,
          error: result.ok ? undefined : errSummary || result.error || "Veeva sync failed"
        },
        request
      );
    } catch (err) {
      context.error(err);
      return json(500, { ok: false, error: String(err.message || err) }, request);
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
          thenCrosswalk: body.thenCrosswalk !== false && request.query.get("thenCrosswalk") !== "false",
          triggeredBy
        });
        // Always 200 with structured results — UI shows per-object errors (avoid bare 500).
        const errSummary = (result.results || [])
          .filter((r) => r.error)
          .map((r) => `${r.object}: ${r.error}`)
          .join(" · ");
        return json(200, {
          ...result,
          error: result.ok ? undefined : errSummary || result.error || "SF tables sync failed"
        });
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

/**
 * Nested aliases — some clients/caches still POST /api/ask/visual|answer|prepare.
 * Flex/CORS stacks have returned 405 on these when missing; keep thin wrappers.
 */
app.http("askVisual", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "ask/visual",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") return optionsOk(request);
    const body = await request.json().catch(() => ({}));
    const fakeReq = {
      method: "POST",
      headers: request.headers,
      json: async () => ({ ...body, askPhase: "visual" })
    };
    return handleAskRequest(fakeReq, context, { requireCopilotKey: false });
  }
});

app.http("askAnswer", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "ask/answer",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") return optionsOk(request);
    const body = await request.json().catch(() => ({}));
    const fakeReq = {
      method: "POST",
      headers: request.headers,
      json: async () => ({ ...body, askPhase: "answer" })
    };
    return handleAskRequest(fakeReq, context, { requireCopilotKey: false });
  }
});

app.http("askPrepare", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "ask/prepare",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") return optionsOk(request);
    const body = await request.json().catch(() => ({}));
    const fakeReq = {
      method: "POST",
      headers: request.headers,
      json: async () => ({ ...body, askPhase: "prepare" })
    };
    return handleAskRequest(fakeReq, context, { requireCopilotKey: false });
  }
});

/**
 * Same-origin bridge (SWA → Function App). Browser never CORS-calls the FA for visuals.
 * On the Function App itself (BUDDY_REQUIRE_SESSION=1), this just runs ask locally.
 */
app.http("buddyAskBridge", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "buddy/ask",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") return optionsOk(request);

    // Already on the long-running Function App — handle in-process.
    if (buddySessionRequired()) {
      return handleAskRequest(request, context, { requireCopilotKey: false });
    }

    let faBase = String(
      process.env.BUDDY_API_BASE ||
        "https://ora-buddy-api-hrdbgqh9cvaub5ft.eastus2-01.azurewebsites.net"
    )
      .trim()
      .replace(/\/$/, "")
      .replace(/^\/+/, "");
    if (faBase && !/^https?:\/\//i.test(faBase)) {
      faBase = `https://${faBase}`;
    }

    // No FA configured — fall through to local SWA ask (45s).
    if (!faBase || !sessionSecret()) {
      return handleAskRequest(request, context, { requireCopilotKey: false });
    }

    let bodyText = "";
    try {
      bodyText = await request.text();
    } catch (_) {
      bodyText = "{}";
    }

    const user = signedInUserFromRequest(request, null);
    const minted = mintBuddySession({
      email: user?.email,
      name: user?.displayName || user?.firstName,
      userId: user?.userId || user?.email
    });
    if (!minted.ok) {
      return handleAskRequest(
        {
          method: "POST",
          headers: request.headers,
          json: async () => {
            try {
              return JSON.parse(bodyText || "{}");
            } catch {
              return {};
            }
          }
        },
        context,
        { requireCopilotKey: false }
      );
    }

    const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), 110000) : null;
    try {
      const upstream = await fetch(`${faBase}/api/ask`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${minted.token}`
        },
        body: bodyText || "{}",
        signal: ac ? ac.signal : undefined
      });
      const text = await upstream.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { ok: false, answer: text.slice(0, 500), error: "upstream_non_json" };
      }
      return json(upstream.status, parsed, request);
    } catch (err) {
      context.warn?.("buddyAskBridge upstream failed", err);
      return json(
        200,
        {
          ok: false,
          answer:
            "Leave-behind bridge could not reach the Function App in time. Try again, or ask without asking for a visual first.",
          error: String(err.message || err).slice(0, 200),
          provider: "error",
          modelTier: "fast",
          softDeadline: true
        },
        request
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
});

/** Copilot Studio entry — same Buddy context builder; requires x-copilot-key. */
app.http("copilotAsk", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "copilot/ask",
  handler: async (request, context) => handleAskRequest(request, context, { requireCopilotKey: true })
});

/**
 * Phase 2/3 of two-phase ask: load Cosmos pack and call Foundry once.
 */
async function handleAskFromPack({
  request,
  context,
  body,
  askPhase,
  askDeadlineAt,
  msLeft,
  requireCopilotKey
}) {
  const pack = await loadAskPack(getDb, body.contextId);
  if (!pack?.context) {
    return json(200, {
      ok: false,
      answer:
        "That Buddy prepare pack expired or was not found. Ask again — I’ll pull Ora data fresh.",
      error: "ask_pack_missing",
      provider: "error",
      modelTier: "fast",
      answerFocus: "error",
      phase: askPhase
    });
  }

  if (msLeft() < 4000) return buddyDeadlineReply("ask_deadline_before_foundry");

  const question = String(body.question || pack.question || "").trim();
  const history = Array.isArray(body.history)
    ? body.history
    : Array.isArray(pack.history)
      ? pack.history
      : [];
  const meta = pack.meta || {};
  const visualAsk = askPhase === "visual" || Boolean(meta.visualAsk);
  const docExportAsk = askPhase === "visual" || Boolean(meta.docExportAsk);

  let contextPayload = {
    ...pack.context,
    wantsHtmlVisual: askPhase === "visual" ? true : false,
    wantsDocumentExport: askPhase === "visual" ? Boolean(meta.docExportAsk) : false,
    askPhase,
    priorChatAnswer: body.priorAnswer ? String(body.priorAnswer).slice(0, 12000) : null
  };

  if (askPhase === "visual") {
    contextPayload = {
      ...contextPayload,
      wantsHtmlVisual: true,
      note:
        (contextPayload.note || "") +
        " VISUAL PHASE: Emit HTML_REPORT_START…END with a complete leave-behind after a 2–4 line chat summary. priorChatAnswer may already cover the narrative."
    };
  }

  const modelTier =
    askPhase === "visual" || visualAsk && askPhase !== "answer"
      ? "deep"
      : meta.modelTier === "deep"
        ? "deep"
        : "fast";
  // Chat answer hop stays Fast unless user explicitly asked deep and this isn't a deferred visual.
  const tier =
    askPhase === "visual"
      ? "deep"
      : meta.forceDeepChat || meta.modelTier === "deep"
        ? "deep"
        : "fast";

  const firstResult = await askAi({
    question,
    context: contextPayload,
    history,
    tier,
    body,
    deadlineAt: askDeadlineAt
  });

  let huntOut = await maybeHuntAndRetry({
    askAi,
    context: contextPayload,
    firstResult,
    question,
    history,
    tier,
    body,
    initialToolTrace: meta.initialToolTrace || [],
    toolDeps: {
      getDb,
      buildPortfolioContext,
      loadLiveContext,
      loadDeptContexts,
      buildDeptContextForAsk
    }
  });
  if (huntOut.evidence?.cleanAnswer) {
    huntOut = {
      ...huntOut,
      result: { ...huntOut.result, answer: huntOut.evidence.cleanAnswer }
    };
  }

  const result = huntOut.result;
  let answer = result.answer;
  let docExports = [];
  let reportTitle = null;
  const runExport =
    askPhase === "visual" ||
    (/HTML_REPORT_START/i.test(String(answer || "")) && askPhase === "answer");

  if (result.provider !== "error" && runExport) {
    try {
      const built = await buildBuddyDocExports(answer, question, {
        wantsHtmlVisual: askPhase === "visual" || Boolean(meta.visualAsk),
        wantsDocumentExport: Boolean(meta.docExportAsk),
        intelligence: contextPayload.intelligence,
        portfolio: contextPayload.portfolio,
        clientStudy: contextPayload.workingStudy || null
      });
      if (built.html) {
        answer = `${built.answer}\n\nHTML_REPORT_START\n${built.html}\nHTML_REPORT_END`;
        reportTitle = built.title;
        docExports = built.exports || [];
      }
    } catch (exportErr) {
      context.warn?.("buddy doc export failed", exportErr);
    }
  }

  const actionParse = parseBuddyActions(answer);
  const llm = providerStatus();
  const visualPending =
    askPhase === "answer" && Boolean(meta.visualAsk || meta.docExportAsk);

  return json(200, {
    ok: result.provider !== "error",
    phase: askPhase,
    contextId: pack.contextId || body.contextId,
    answer: actionParse.cleanAnswer || answer,
    rawAnswer: answer,
    actions: actionParse.actions,
    htmlReport: actionParse.htmlReport,
    evidence: huntOut.evidence,
    hunted: Boolean(huntOut.hunted),
    visualPending,
    visualAsk: Boolean(meta.visualAsk),
    suggestedPendingTask: meta.suggestedPendingTask || null,
    attachmentSessionId: meta.attachmentSessionId || null,
    attachmentIds: meta.attachmentIds || [],
    model: result.model,
    deployment: llm.deployment || result.model || null,
    displayName: llm.displayName || null,
    provider: result.provider,
    agentError: result.agentError || result.error || null,
    answerFocus: meta.answerFocus || contextPayload.answerFocus || null,
    workflow: meta.workflow || contextPayload.workflow || "auto",
    modelTier: result.modelTier || tier || modelTier,
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
    portfolioMatched: contextPayload.portfolio?.matchedStudyCount ?? null,
    databaseStudyCount: contextPayload.portfolio?.databaseStudyCount ?? null,
    intelligenceAttached: Boolean(
      contextPayload.intelligence &&
        contextPayload.intelligence.source === "ora_clinical_intelligence" &&
        !contextPayload.intelligence.error
    ),
    intelligenceQuery: contextPayload.intelligence?.query || null,
    buddyDebug: {
      phase: askPhase,
      routerIntent: meta.routerIntent || null,
      twoPhase: true,
      msLeft: msLeft()
    },
    greetedAs: contextPayload.user?.firstName || null
  });
}

async function handleAskRequest(request, context, { requireCopilotKey }) {
  if (request.method === "OPTIONS") {
    return optionsOk(request);
  }

  // External Function App: require short-lived session minted by SWA.
  const sessionGate = assertBuddySession(request, headerGet);
  if (!sessionGate.ok) {
    return json(
      sessionGate.status || 401,
      {
        ok: false,
        answer: "Buddy session expired or missing — refresh the page and try again.",
        error: sessionGate.error,
        provider: "error",
        modelTier: "fast",
        answerFocus: "error"
      },
      request
    );
  }

  // Longer budget when not behind SWA's 45s proxy (set on Function App).
  const askDeadlineAt =
    Date.now() +
    Math.max(
      15000,
      Number(process.env.BUDDY_ASK_DEADLINE_MS || (sessionGate.skipped ? 38000 : 120000)) ||
        38000
    );
  const msLeft = () => Math.max(0, askDeadlineAt - Date.now());

  try {
    if (requireCopilotKey) {
      const expected = String(process.env.COPILOT_ASK_KEY || "").trim();
      const got = String(headerGet(request, "x-copilot-key") || "").trim();
      if (!expected || expected.includes("SET_IN") || got !== expected) {
        return json(401, { error: "Invalid or missing x-copilot-key" });
      }
    }

    let body;
    try {
      body = await request.json();
    } catch (parseErr) {
      return json(200, {
        ok: false,
        answer:
          "I could not read that request body. Try sending again without a huge attachment, or refresh and sign in.",
        error: String(parseErr.message || parseErr).slice(0, 200),
        provider: "error",
        modelTier: "fast",
        answerFocus: "error"
      });
    }

    const askPhase = String(body?.askPhase || body?.phase || "auto").toLowerCase();

    // Two-phase: answer / visual reuse a prepare pack (each hop under SWA 45s).
    if (
      (askPhase === "answer" || askPhase === "visual") &&
      body?.contextId
    ) {
      return await handleAskFromPack({
        request,
        context,
        body,
        askPhase,
        askDeadlineAt,
        msLeft,
        requireCopilotKey
      });
    }

    // "hi" alone — tiny Foundry-free reply (still Buddy voice). Anything more
    // (weather, math, "hey what's…") goes through Foundry light lane below.
    {
      const q0 = String(body?.question || "")
        .toLowerCase()
        .replace(/[?.!]+$/g, "")
        .trim();
      const hasAtt =
        (Array.isArray(body?.attachments) && body.attachments.length > 0) ||
        (Array.isArray(body?.priorAttachments) && body.priorAttachments.length > 0) ||
        (Array.isArray(body?.attachmentIds) && body.attachmentIds.length > 0) ||
        Boolean(body?.attachmentSessionId);
      if (
        q0 &&
        !hasAtt &&
        !body?.pendingTask?.type &&
        /^(hi+|hello|hey+|yo|hiya|howdy|good\s+(morning|afternoon|evening)|thanks|thank\s+you|thx|ty|cheers|bye|goodbye|see\s+ya|ok|okay|cool|great|got\s+it)$/i.test(
          q0
        )
      ) {
        const user = signedInUserFromRequest(request, body.user || null);
        const name = user?.firstName || "";
        const hi = name ? `Hi ${name}` : "Hi";
        let answer = `${hi} — Buddy here. What do you need?`;
        if (/^(thanks|thank\s+you|thx|ty|cheers)$/i.test(q0)) answer = "Anytime — what else do you need?";
        else if (/^(bye|goodbye|see\s+ya)$/i.test(q0)) answer = "Later — I’m here when you need me.";
        else if (/^(ok|okay|cool|great|got\s+it)$/i.test(q0)) answer = "Got it. What’s next?";
        return json(200, {
          ok: true,
          answer,
          provider: "instant",
          modelTier: "fast",
          agent: "Buddy",
          answerFocus: "chat",
          greetedAs: name || null
        });
      }
    }

    let uploaded = { files: [], errors: [] };
    try {
      uploaded = await normalizeBuddyAttachments(body.attachments);
    } catch (attErr) {
      context.warn?.("normalizeBuddyAttachments failed", attErr);
      uploaded = {
        files: [],
        errors: [String(attErr.message || attErr).slice(0, 200)]
      };
    }
    let hasOkUpload = (uploaded.files || []).some((f) => f.ok && f.text);
    const history = body.history || [];
    let attachmentSessionId = body.attachmentSessionId || null;
    let vaultFileMeta = [];

    // Vault replay: attachmentIds / sessionId (preferred over base64 priorAttachments)
    if (
      !hasOkUpload &&
      (Array.isArray(body.attachmentIds) && body.attachmentIds.length || body.attachmentSessionId)
    ) {
      try {
        const vaulted = await loadAttachments(getDb, {
          attachmentIds: body.attachmentIds || [],
          sessionId: body.attachmentSessionId || null
        });
        if ((vaulted.files || []).some((f) => f.ok && f.text)) {
          uploaded = vaulted;
          hasOkUpload = true;
          attachmentSessionId = vaulted.sessionId || body.attachmentSessionId || null;
        }
      } catch (_) {
        /* fall through to priorAttachments */
      }
    }

    // Reconcile follow-up: client replays the last attachment from the prior turn.
    if (!hasOkUpload && Array.isArray(body.priorAttachments) && body.priorAttachments.length) {
      const prior = await normalizeBuddyAttachments(body.priorAttachments);
      if ((prior.files || []).some((f) => f.ok && f.text)) {
        uploaded = prior;
        hasOkUpload = true;
      }
    }

    // Persist new uploads into vault for multi-turn reconcile
    if (hasOkUpload && (uploaded.files || []).some((f) => f.ok && f.text && !f.fromVault)) {
      try {
        const stored = await storeAttachments(getDb, uploaded, {
          sessionId: attachmentSessionId || undefined,
          userId: body.user?.email || body.user?.userId || null
        });
        if (stored.stored) {
          attachmentSessionId = stored.sessionId;
          vaultFileMeta = stored.files || [];
        }
      } catch (_) {
        /* vault optional — base64 replay still works */
      }
    }
    let question = String(body.question || "").trim();
    if (!question && hasOkUpload) {
      question =
        "Please review the attached file(s). Extract key specs, summarize what you found, list gaps, and answer based on the file content.";
    }
    if (!question) return json(400, { error: "question is required (or attach a file)" });

    // Everyday AI (weather, math, news, chitchat+) — Foundry Fast, zero Cosmos
    if (!hasOkUpload && isGeneralKnowledgeAsk(question, { hasOkUpload: false, body })) {
      const user = signedInUserFromRequest(request, body.user || null);
      const historyLite = Array.isArray(history) ? history.slice(-6) : [];
      if (msLeft() < 4000) return buddyDeadlineReply("ask_deadline_light");
      const lightResult = await askAi({
        question,
        history: historyLite,
        tier: "fast",
        body,
        deadlineAt: askDeadlineAt,
        context: {
          user,
          answerFocus: "general_chat",
          generalKnowledge: true,
          workflow: "auto",
          buddyMode: "chat",
          askedAt: new Date().toISOString(),
          note: "Everyday AI ask — answer as Buddy; use web search if needed; no Cosmos packs."
        }
      });
      return json(200, {
        ok: lightResult.provider !== "error",
        answer: lightResult.answer,
        provider: lightResult.provider,
        agent: lightResult.agent || null,
        model: lightResult.model,
        modelTier: "fast",
        answerFocus: "general_chat",
        workflow: "auto",
        phase: "light",
        buddyDebug: {
          routerIntent: "general_chat",
          routerTools: ["web_search"],
          generalKnowledge: true,
          cosmosSkipped: true
        },
        greetedAs: user?.firstName || null
      });
    }

    // Route with hints (may refine after client directory from portfolio).
    let hints = inferAskHints(question, body, []);
    let route = routeBuddyAsk({ question, body, history, hasOkUpload, hints });

    // Ora-earned fee rankings are always portfolio-scope (even with a study open)
    if (route.moneyIntent === "ora_earned") {
      hints.crossStudy = true;
      hints.studyId = hints.studyId && /\b(O-\d{3,})\b/i.test(question) ? hints.studyId : null;
    }

    let portfolioFetch = await fetchBuddyPortfolio(buildPortfolioContext, {
      routerTools: route.tools,
      hints
    });
    let portfolioFull = portfolioFetch.portfolioFull || portfolioFetch.portfolio;
    let portfolio = portfolioFetch.portfolio;
    let clientDirectory = portfolioFetch.clientDirectory || [];

    if (clientDirectory.length) {
      hints = inferAskHints(question, body, clientDirectory);
      if (route.moneyIntent === "ora_earned") {
        hints.crossStudy = true;
        hints.studyId = hints.studyId && /\b(O-\d{3,})\b/i.test(question) ? hints.studyId : null;
      }
      if (
        hints.clientName &&
        String(hints.clientName).trim().length <= 3 &&
        !body.clientName &&
        !hasExplicitClientCue(question)
      ) {
        hints.clientName = null;
      }
      if (route.externalFeedAsk && hints.year) {
        hints.portfolioYear = hints.year;
        hints.year = null;
      }
      const route2 = routeBuddyAsk({ question, body, history, hasOkUpload, hints });
      if (routerHasTool(route2, "portfolio") && !routerHasTool(route, "portfolio")) {
        portfolioFetch = await fetchBuddyPortfolio(buildPortfolioContext, {
          routerTools: route2.tools,
          hints
        });
        portfolioFull = portfolioFetch.portfolioFull || portfolioFetch.portfolio;
        portfolio = portfolioFetch.portfolio;
        clientDirectory = portfolioFetch.clientDirectory || clientDirectory;
      }
      route = route2;
    }

    const {
      intent: routerIntent,
      tools: routerTools,
      depth: routerDepth,
      workflow: buddyWorkflow,
      moneyIntent,
      buddyMode,
      answerFocus,
      studyId,
      forcePortfolio,
      crossStudy,
      compareAsk,
      cosmosReconciliation: attachmentCosmosCompareAsk,
      attachmentAnalyzeVerb,
      attachmentDriven,
      fillFollowUp,
      needsFullIntel,
      visualAsk,
      docExportAsk,
      suggestedPendingTask
    } = route;

    const user = signedInUserFromRequest(request, body.user || null);
    const activeTab = body.activeTab ? String(body.activeTab) : null;
    const activeTabLabel = body.activeTabLabel ? String(body.activeTabLabel) : null;
    const editableFields = Array.isArray(body.editableFields) ? body.editableFields : null;
    const fieldsByTab = body.fieldsByTab && typeof body.fieldsByTab === "object" ? body.fieldsByTab : null;

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

    // Re-filter portfolio if client/year emerged after client directory scan
    if (
      portfolio &&
      portfolio.source === "cosmos_portfolio" &&
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
            ...portfolio,
            filters: {
              ...(portfolio.filters || {}),
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
        portfolioFull = portfolio;
      } catch (err) {
        portfolio = { ...portfolio, filterError: String(err.message || err) };
      }
    }

    let studyComparison = null;
    if (compareAsk && routerHasTool(route, "study_compare")) {
      const pair = resolveComparePair(question, body, portfolioFull || portfolio);
      if (pair.needIds) {
        studyComparison = pair;
      } else {
        try {
          const rawDiff = await compareStudies(pair.left, pair.right);
          studyComparison = slimStudyComparison(rawDiff);
        } catch (err) {
          studyComparison = {
            error: String(err.message || err),
            leftStudyId: pair.left,
            rightStudyId: pair.right,
            note: "Could not load a Cosmos diff for those two studies."
          };
        }
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
      // EVERY Buddy ask queries live Cosmos — no skip/upload-only paths.
      const attachmentBlobForIntel = hasOkUpload ? attachmentTextForIntel(uploaded, 15000) : "";
      const intelQuestion = attachmentBlobForIntel
        ? `${question}\n\n--- ATTACHED DOCUMENT TEXT (for extracting filters) ---\n${attachmentBlobForIntel}`
        : question;

      const rfpHint = extractRfpScenarioFromQuestion(question, body);
      let indFromFiles = null;
      if (hasOkUpload && !sourceOverviewAsk) {
        indFromFiles = extractIndicationFromQuestion(attachmentBlobForIntel || intelQuestion);
      }

      const resolvedIndication =
        qIndication ||
        (sourceOverviewAsk ? null : hintIndication || snapIndication) ||
        indFromFiles ||
        rfpHint.indication ||
        null;
      const resolvedCountry =
        qCountry || (sourceOverviewAsk && !qCountry ? null : hintCountry) || null;

      const intelBase = {
        question: intelQuestion,
        indication: resolvedIndication,
        country: resolvedCountry,
        attachmentText: attachmentBlobForIntel || "",
        clientName: sourceOverviewAsk ? null : hints.clientName || snapClient || null,
        sponsor: sourceOverviewAsk ? null : hints.clientName || snapClient || null
      };

      intelligence = await fetchBuddyIntelligence(getDb, {
        intelBase,
        routerTools,
        routerDepth,
        question,
        cosmosReconciliation: attachmentCosmosCompareAsk
      });
    } catch (err) {
      intelligence = { source: "ora_clinical_intelligence_error", error: String(err.message || err) };
    }

    // Legacy anterior-segment site/study trust & feasibility (separate containers — read only)
    let legacyAnterior = null;
    try {
      if (routerHasTool(route, "legacy_anterior")) {
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
        !compareAsk &&
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
      }
    } catch (err) {
      legacyAnterior = { source: "legacy_anterior_segment_error", error: String(err.message || err) };
    }

    // Past-bid RFP pricing tiers (High Level Ballpark / Moderate / Goal Bid)
    let pricingScenarios = null;
    try {
      if (routerHasTool(route, "pricing_scenarios")) {
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
      }
    } catch (err) {
      pricingScenarios = { source: "past_bid_pricing_error", error: String(err.message || err) };
    }

    // Live Buddy context (Cosmos) — SME additions without redeploy
    let buddyLiveContext = null;
    try {
      if (routerHasTool(route, "live_context")) {
      buddyLiveContext = await loadLiveContext(getDb);
      if (buddyLiveContext && !buddyLiveContext.text) buddyLiveContext = { ...buddyLiveContext, empty: true };
      }
    } catch (err) {
      buddyLiveContext = { source: "error", error: String(err.message || err) };
    }

    // Dept lens UI paused — always attach all department playbooks.
    const buddyDeptLens = "auto";
    let buddyDeptContexts = null;
    try {
      if (routerHasTool(route, "dept_context")) {
        const deptPack = await loadDeptContexts(getDb);
        buddyDeptContexts = buildDeptContextForAsk(deptPack, buddyDeptLens);
      }
    } catch (err) {
      buddyDeptContexts = { source: "buddy_dept_contexts_error", error: String(err.message || err) };
    }

    const openStudyId = body.studyId ? String(body.studyId).trim() : null;
    // Chat hop stays Fast; Deep is reserved for /ask/visual (or explicit deep cue without visual deferral).
    const forceDeepChat =
      !visualAsk &&
      !docExportAsk &&
      (routerDepth === "deep" ||
        /\b(go deeper|think harder|deep dive|terra)\b/i.test(question));
    const modelTier = forceDeepChat ? "deep" : "fast";
    const contextPayload = {
      askedAt: new Date().toISOString(),
      source: requireCopilotKey ? "copilot_studio" : "workbench",
      modelTier,
      buddyMode,
      pendingTask: body.pendingTask && body.pendingTask.type ? body.pendingTask : null,
      router: {
        intent: routerIntent,
        tools: routerTools,
        depth: routerDepth,
        confidence: route.confidence,
        reasons: route.reasons
      },
      workflow: attachmentCosmosCompareAsk ? "feasibility" : buddyWorkflow,
      cosmosLiveQuery: true,
      cosmosReconciliation: attachmentCosmosCompareAsk,
      workflowNote: attachmentCosmosCompareAsk
        ? "COSMOS RECONCILIATION: user attached a document (this turn or a prior turn) and asked to verify/compare claims against live Ora Cosmos data. Read ATTACHED DOCUMENTS / uploadedDocuments, then compare each factual claim to ORA COSMOS FACTS / context.intelligence. Flag matches, mismatches, and missing data. Do NOT require an open study in the UI. Do NOT say Cosmos was not queried when intelligenceAttached=true."
        : buddyWorkflow === "budget"
          ? "BUDGET workflow: use portfolio / workingStudy / pricing / APPLY / CREATE_STUDY / HLBP. Do NOT answer with TrialHub/PSM/site feasibility unless the user explicitly asks."
          : buddyWorkflow === "feasibility"
            ? "FEASIBILITY workflow: use context.intelligence / legacyAnterior / scorecard-style site & enrollment facts. Do NOT invent bid dollars or open an HLBP unless the user explicitly asks for budget/pricing."
            : buddyWorkflow === "hybrid"
              ? "HYBRID workflow: user wants BOTH feasibility (PSM/sites/TrialHub/intelligence) AND budget/pricing. Answer in two clearly labeled parts. Use context.intelligence for performance/site facts; use context.portfolio/pricingScenarios/workingStudy for Ora fees. Do not answer with only one domain."
              : buddyWorkflow === "teach"
                ? "TEACH workflow: capture durable SME notes. End with LEARN_CONTEXT:{...}. Do not run a budget or feasibility analysis unless asked."
                : "AUTO workflow: pick budget vs feasibility from the question; use hybrid-style two-part answers when both domains are clearly asked.",
      buddyModeNote:
        buddyMode === "chat"
          ? "CHAT mode: analyze, answer, reconcile, and propose — do NOT emit APPLY or CREATE_STUDY unless the user explicitly says fill/apply/set/create study/update field. NAVIGATE and LEARN_CONTEXT are still allowed."
          : "DO mode: user wants actions — APPLY, CREATE_STUDY, HLBP fills, and NAVIGATE are allowed when appropriate.",
      answerFocus,
      moneyIntent,
      wantsHtmlVisual: visualAsk,
      wantsDocumentExport: docExportAsk,
      fillFollowUp,
      dataSources: {
        cosmosPortfolioQueried: Boolean(!compareAsk && portfolio && portfolio.source === "cosmos_portfolio"),
        studyComparisonAttached: Boolean(studyComparison && !studyComparison.needIds && !studyComparison.error),
        databaseStudyCount: portfolio?.databaseStudyCount ?? null,
        matchedStudyCount: portfolio?.matchedStudyCount ?? null,
        intelligenceAttached: Boolean(
          intelligence && intelligence.source === "ora_clinical_intelligence" && !intelligence.error
        ),
        legacyAnteriorAttached: Boolean(legacyAnterior && legacyAnterior.source === "legacy_anterior_segment"),
        pricingScenariosAttached: Boolean(pricingScenarios && pricingScenarios.tiers),
        buddyLiveContextAttached: Boolean(buddyLiveContext && buddyLiveContext.text),
        buddyDeptContextsAttached: Boolean(buddyDeptContexts && !buddyDeptContexts.error),
        note: "studyComparison = two-study bid diff. portfolio = budget studies. pricingScenarios = past-bid RFP tiers. intelligence = Ora Veeva + TrialHub + CT.gov. legacyAnterior = anterior-segment overview. buddyLiveContext = SME append notes. buddyDeptContexts = department playbook lens (Ops/BD/Recruitment…)."
      },
      buddyDept: buddyDeptLens,
      buddyDeptContexts,
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
        compare: Boolean(studyComparison),
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
      studyComparison,
      portfolio: compareAsk ? undefined : portfolio,
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

    const initialToolTrace = toolTraceFromPrefetch({
      portfolio,
      intelligence,
      legacyAnterior,
      pricingScenarios,
      buddyLiveContext,
      buddyDeptContexts,
      routerTools
    });

    const toolDeps = {
      getDb,
      buildPortfolioContext,
      loadLiveContext,
      loadDeptContexts,
      buildDeptContextForAsk
    };

    // Phase 1 (prepare): persist pack and return — Foundry runs on /ask/answer.
    if (askPhase === "prepare") {
      const stored = await storeAskPack(getDb, {
        question,
        history: Array.isArray(history) ? history.slice(-8) : [],
        context: contextPayload,
        meta: {
          visualAsk: Boolean(visualAsk),
          docExportAsk: Boolean(docExportAsk),
          modelTier,
          forceDeepChat: Boolean(forceDeepChat),
          answerFocus,
          workflow: buddyWorkflow,
          routerIntent,
          routerTools,
          suggestedPendingTask: suggestedPendingTask || null,
          attachmentSessionId: attachmentSessionId || null,
          attachmentIds: (vaultFileMeta.filter((f) => f.id) || []).map((f) => f.id),
          initialToolTrace,
          portfolioMatched: portfolio?.matchedStudyCount ?? null,
          databaseStudyCount: portfolio?.databaseStudyCount ?? null
        }
      });
      if (!stored.stored) {
        return json(200, {
          ok: false,
          phase: "prepare",
          answer:
            "I pulled the ask together but could not stash the prepare pack. Try again in a moment.",
          error: stored.error || "ask_pack_store_failed",
          provider: "error",
          modelTier: "fast"
        });
      }
      return json(200, {
        ok: true,
        phase: "prepare",
        contextId: stored.contextId,
        visualAsk: Boolean(visualAsk),
        docExportAsk: Boolean(docExportAsk),
        modelTier,
        answerFocus,
        workflow: buddyWorkflow,
        attachmentSessionId: attachmentSessionId || null,
        attachmentIds: (vaultFileMeta.filter((f) => f.id) || []).map((f) => f.id),
        portfolioMatched: portfolio?.matchedStudyCount ?? null,
        databaseStudyCount: portfolio?.databaseStudyCount ?? null,
        intelligenceAttached: Boolean(
          intelligence && intelligence.source === "ora_clinical_intelligence" && !intelligence.error
        ),
        buddyDebug: {
          routerIntent,
          routerTools,
          phase: "prepare",
          msLeft: msLeft()
        },
        statusHint: visualAsk
          ? "Ora data ready — answering, then building your visual…"
          : "Ora data ready — asking Buddy…"
      });
    }

    if (msLeft() < 5000) return buddyDeadlineReply("ask_deadline_after_prepare");

    // Legacy one-shot: one Foundry call; defer HTML visuals to a follow-up hop.
    const deferVisual = Boolean(visualAsk || docExportAsk);
    const chatContext = deferVisual
      ? { ...contextPayload, wantsHtmlVisual: false, wantsDocumentExport: false }
      : contextPayload;

    // Stack: Node hunts Cosmos / TrialHub / CT.gov → Foundry Fast or Terra answers.
    // Soft-fail: never throws for model/provider errors.
    const firstResult = await askAi({
      question,
      context: chatContext,
      history,
      tier: modelTier,
      body,
      deadlineAt: askDeadlineAt
    });

    // If Foundry answer is weak/ungrounded, gap-fill Cosmos packs and ask Foundry once more.
    let huntOut = await maybeHuntAndRetry({
      askAi,
      context: chatContext,
      firstResult,
      question,
      history,
      tier: modelTier,
      body,
      initialToolTrace,
      toolDeps
    });
    if (huntOut.evidence?.cleanAnswer) {
      huntOut = {
        ...huntOut,
        result: {
          ...huntOut.result,
          answer: huntOut.evidence.cleanAnswer
        }
      };
    }

    const result = huntOut.result;
    const evidence = huntOut.evidence;
    if (huntOut.context?.intelligence) intelligence = huntOut.context.intelligence;
    if (huntOut.context?.portfolio) portfolio = huntOut.context.portfolio;

    let answer = result.answer;
    let docExports = [];
    let reportTitle = null;
    let contextIdForVisual = null;
    try {
      if (
        !deferVisual &&
        result.provider !== "error" &&
        (visualAsk || docExportAsk || /HTML_REPORT_START/i.test(String(answer || "")))
      ) {
        const built = await buildBuddyDocExports(answer, question, {
          wantsHtmlVisual: visualAsk,
          wantsDocumentExport: docExportAsk,
          intelligence,
          portfolio,
          clientStudy: contextPayload.clientStudy || contextPayload.workingStudy || null
        });
        if (built.html) {
          answer = built.answer;
          answer = `${built.answer}\n\nHTML_REPORT_START\n${built.html}\nHTML_REPORT_END`;
          reportTitle = built.title;
          docExports = built.exports || [];
        }
      } else if (deferVisual && result.provider !== "error") {
        const stored = await storeAskPack(getDb, {
          question,
          history: Array.isArray(history) ? history.slice(-8) : [],
          context: contextPayload,
          meta: {
            visualAsk: true,
            docExportAsk: Boolean(docExportAsk),
            modelTier: "deep",
            answerFocus,
            workflow: buddyWorkflow,
            routerIntent,
            suggestedPendingTask: suggestedPendingTask || null,
            attachmentSessionId: attachmentSessionId || null,
            attachmentIds: (vaultFileMeta.filter((f) => f.id) || []).map((f) => f.id)
          }
        });
        if (stored.stored) contextIdForVisual = stored.contextId;
      }
    } catch (exportErr) {
      context.warn?.("buddy doc export failed", exportErr);
    }
    const actionParse = parseBuddyActions(answer);
    const llm = providerStatus();
    return json(200, {
      answer: actionParse.cleanAnswer || answer,
      rawAnswer: answer,
      actions: actionParse.actions,
      htmlReport: actionParse.htmlReport,
      evidence,
      hunted: Boolean(huntOut.hunted),
      huntReason: huntOut.huntReason || null,
      attachmentSessionId: attachmentSessionId || null,
      attachmentIds: (vaultFileMeta.filter((f) => f.id) || []).map((f) => f.id),
      suggestedPendingTask: suggestedPendingTask || null,
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
      visualPending: Boolean(deferVisual && contextIdForVisual),
      visualAsk: Boolean(visualAsk),
      contextId: contextIdForVisual,
      phase: deferVisual ? "answer_deferred_visual" : "auto",
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
      intelligenceAttached: Boolean(
        intelligence && intelligence.source === "ora_clinical_intelligence" && !intelligence.error
      ),
      intelligenceQuery: intelligence?.query || {
        indication: null,
        country: null
      },
      buddyDebug: {
        routerIntent,
        routerTools,
        routerConfidence: route.confidence,
        routerReasons: route.reasons,
        routerRerouted: Boolean(clientDirectory.length),
        fetchPlan: intelligence?.fetchPlan || null,
        contextFetchPlan: {
          portfolio: routerHasTool(route, "portfolio"),
          intelligence: intelligence?.fetchPlan || null,
          legacy: routerHasTool(route, "legacy_anterior"),
          pricing: routerHasTool(route, "pricing_scenarios"),
          compare: routerHasTool(route, "study_compare"),
          liveContext: routerHasTool(route, "live_context"),
          deptContext: routerHasTool(route, "dept_context")
        },
        buddyDeptLens,
        portfolioSkipped: Boolean(portfolio?.skipped),
        actionCount: actionParse.actions.length,
        hunted: Boolean(huntOut.hunted),
        huntReason: huntOut.huntReason || null,
        huntRetry: Boolean(huntOut.huntRetry),
        evidenceGrounded: evidence?.grounded !== false,
        evidenceSourceCount: evidence?.sources?.filter((s) => s.ok)?.length ?? 0,
        evidenceGapCount: evidence?.gaps?.length ?? 0,
        attachmentCosmosCompareAsk,
        hasOkUpload,
        reconcileFollowUp: Boolean(body.reconcileFollowUp || route.reconcileFollowUp),
        buddyMode,
        pendingTaskType: body.pendingTask?.type || null,
        priorAttachmentsReplayed: Boolean(
          !body.attachments?.length && Array.isArray(body.priorAttachments) && body.priorAttachments.length
        ),
        intelSource: intelligence?.source || null,
        intelError: intelligence?.error || null,
        intelIndication:
          intelligence?.query?.indication ||
          intelligence?.indicationBenchmark?.indicationRequested ||
          null,
        reconciliationPack: intelligence?.attachedFrom === "cosmos_reconciliation",
        phase: deferVisual ? "auto_defer_visual" : "auto",
        msLeft: msLeft()
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
      modelTier: "fast",
      escalated: false,
      answerFocus: "error"
    });
  }
}
