/**
 * Legacy anterior-segment overview data in Cosmos (read-only).
 * Containers (do not write / do not alter other containers):
 *   legacy_studies, legacy_sites,
 *   legacy_study_site_outcomes, legacy_site_study_outcomes
 *
 * Used by Buddy for site trust + feasibility questions.
 */

const DATASET = "legacy_anterior_segment";
const DOC_STUDY = "legacyStudy";
const DOC_SITE = "legacySite";
const DOC_BY_STUDY = "legacyStudySiteOutcome";
const DOC_BY_SITE = "legacySiteStudyOutcome";

async function queryAll(container, query, parameters = []) {
  const { resources } = await container.items
    .query({ query, parameters }, { enableCrossPartitionQuery: true })
    .fetchAll();
  return resources || [];
}

function num(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function attainment(enrolled, target) {
  const e = num(enrolled);
  const t = num(target);
  if (e == null || t == null || t <= 0) return null;
  return Math.round((e / t) * 1000) / 10;
}

function median(nums) {
  const a = (nums || []).filter((n) => n != null && Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function isLegacyAnteriorQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  return (
    /\b(legacy|anterior[\s-]?segment|as overview|anterior overview)\b/.test(q) ||
    /\blegacy\b.{0,40}\b(table|board|list|recruit|enroll|visual|html|report|data|dashboard|overview)\b/.test(
      q
    ) ||
    /\b(table|board|list|visual|html|report|dashboard|overview)\b.{0,40}\blegacy\b/.test(q) ||
    /\b(site trust|trusted sites?|relationship preference|preferred sites?)\b/.test(q) ||
    /\b(advantages|disadvantages|relationship notes)\b/.test(q) ||
    /\b(which sites?).{0,40}\b(trust|prefer|perform|enroll|feasib)/.test(q) ||
    /\b(site|sites?).{0,30}\b(feasib|histor|legacy|anterior|scheduled|screened|enrolled)\b/.test(q) ||
    /\b(pi|principal investigator).{0,40}\b(site|study|enroll)/.test(q) ||
    /\b(target scheduled|lplv|visit ?1)\b/.test(q)
  );
}

/** Feed-wide legacy board/dashboard — do not hijack with open-study indication. */
function isLegacyOverviewQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  if (!/\b(legacy|anterior[\s-]?segment)\b/.test(q)) return false;
  // Named indication in the question → not a feed-wide overview
  try {
    const { extractIndicationFromQuestion } = require("./intelligence");
    if (extractIndicationFromQuestion(question)) return false;
  } catch (_) {
    /* ignore */
  }
  return (
    /\b(dashboard|overview|board|leaderboard|table|recruit(?:ment)?\s+data|all\s+sites|full\s+(?:board|table))\b/.test(
      q
    ) ||
    /\blegacy\b.{0,30}\b(data|feed|cosmos)\b/.test(q) ||
    /\b(what(?:'s| is)|show|give|list)\b.{0,40}\blegacy\b/.test(q)
  );
}

/** User wants a visual/document artifact — Buddy must emit HTML_REPORT. */
function wantsHtmlVisual(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  return (
    /\b(visual|html(\s+report)?|chart|graph|graphic|dashboard|slide|deck|print(?:able)?|pdf|docx|word|heatmap|matrix|one[- ]pager|onepager|document|proposal|memo|leave[- ]behind|feasibility(\s+report)?|win\s+themes?|call\s+prep|meeting\s+prep)\b/.test(
      q
    ) ||
    /\b(make|produce|build|create|generate|render|show|give|draw|draft|export|write|develop|help\s+me)\b.{0,80}\b(visual|html|chart|graph|table|report|deck|slide|doc|document|pdf|word|docx|proposal|memo|form|feasibility|win\s+themes?|template)\b/.test(
      q
    ) ||
    /\b(table|board)\b.{0,30}\b(html|visual|report|printable)\b/.test(q) ||
    /\b(follow|using|from|match|based on|in\s+my|standard)\b.{0,40}\b(brand|branding|template|style|styling|guidelines?|form|format)\b/.test(
      q
    ) ||
    /\b(brand|branding|style guide|template)\b.{0,40}\b(create|make|produce|build|generate|doc|document|pdf|proposal|report|feasibility)\b/.test(
      q
    )
  );
}

/** Asking for the legacy recruitment/site table itself implies enrollment consent. */
function isLegacyTableAsk(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  return (
    /\blegacy\b.{0,50}\b(table|board|leaderboard|recruit|enroll|matrix|spreadsheet|dashboard|overview)\b/.test(
      q
    ) ||
    /\b(table|board|leaderboard|recruit|enroll|dashboard|overview)\b.{0,50}\blegacy\b/.test(q) ||
    isLegacyOverviewQuestion(question) ||
    (wantsHtmlVisual(q) && /\blegacy\b/.test(q))
  );
}

const HINT_STOP =
  /^(trust|notes?|for|with|that|which|the|a|an|our|preferred|prefer|best|top|legacy|anterior|enrollment|recruitment|history|historical|data|overview)\b/i;

function cleanHintName(raw) {
  let s = String(raw || "")
    .trim()
    .replace(/[?.!,;:]+$/, "")
    .replace(/\s+(and|or|vs|versus|in|for|with|from)\s+.*$/i, "")
    .trim();
  if (!s || s.length < 3 || HINT_STOP.test(s)) return null;
  return s;
}

/** Pull a quoted name or "site named X" / "study called X" phrase. */
function extractLegacyNameHints(question) {
  const q = String(question || "");
  const out = { siteName: null, studyName: null, siteId: null, studyId: null };
  const quoted = [...q.matchAll(/"([^"]{2,80})"|'([^']{2,80})'/g)].map((m) => m[1] || m[2]);
  // Prefer explicit named/called — bare "site trust notes…" must not become a siteName
  const siteM = q.match(
    /\bsites?\s+(?:named|called)\s+["']?([A-Za-z0-9][\w .,&'\-/]{2,60})["']?/i
  );
  const studyM = q.match(
    /\bstud(?:y|ies)\s+(?:named|called)\s+["']?([A-Za-z0-9][\w .,&'\-/]{2,60})["']?/i
  );
  if (siteM) out.siteName = cleanHintName(siteM[1]);
  if (studyM) out.studyName = cleanHintName(studyM[1]);
  if (!out.siteName && quoted[0] && /\bsite\b/i.test(q)) out.siteName = cleanHintName(quoted[0]);
  if (!out.studyName && quoted[0] && /\bstudy\b/i.test(q)) out.studyName = cleanHintName(quoted[0]);
  if (!out.siteName && !out.studyName && quoted[0]) {
    out.siteName = cleanHintName(quoted[0]);
  }
  const idSite = q.match(/\bsiteId\s*[:=]\s*([A-Za-z0-9_\-]+)/i);
  const idStudy = q.match(/\bstudyId\s*[:=]\s*([A-Za-z0-9_\-]+)/i);
  if (idSite) out.siteId = idSite[1];
  if (idStudy) out.studyId = idStudy[1];
  return out;
}

function slimSite(doc) {
  if (!doc) return null;
  const m = doc.metrics || {};
  return {
    siteId: doc.siteId || doc.id,
    siteName: doc.siteName || doc.name || null,
    status: doc.status || null,
    relationshipPreference: doc.relationshipPreference || null,
    advantages: doc.advantages || null,
    disadvantages: doc.disadvantages || null,
    relationshipNotes: doc.relationshipNotes || null,
    metrics: {
      targetScheduled: num(m.targetScheduled),
      scheduled: num(m.scheduled),
      screened: num(m.screened),
      enrolled: num(m.enrolled),
      nStudies: num(m.nStudies),
      nPis: num(m.nPis),
      attainmentPct: attainment(m.enrolled, m.targetScheduled),
      studyNames: Array.isArray(m.studyNames) ? m.studyNames.slice(0, 12) : null
    }
  };
}

function slimStudy(doc) {
  if (!doc) return null;
  const m = doc.metrics || {};
  return {
    studyId: doc.studyId || doc.id,
    studyName: doc.studyName || doc.name || doc.title || null,
    therapeuticArea: doc.therapeuticArea || null,
    indication: doc.indication || null,
    sponsor: doc.sponsor || null,
    phase: doc.phase || null,
    status: doc.status || null,
    notes: doc.notes || null,
    metrics: {
      targetScheduled: num(m.targetScheduled),
      scheduled: num(m.scheduled),
      screened: num(m.screened),
      enrolled: num(m.enrolled),
      nSites: num(m.nSites),
      nPis: num(m.nPis),
      attainmentPct: attainment(m.enrolled, m.targetScheduled)
    }
  };
}

function slimOutcome(doc) {
  if (!doc) return null;
  return {
    studyId: doc.studyId || null,
    siteId: doc.siteId || null,
    studyName: doc.studyName || null,
    siteName: doc.siteName || null,
    pi: doc.pi || null,
    group: doc.group || null,
    visit1Start: doc.visit1Start || null,
    lplv: doc.lplv || null,
    targetScheduled: num(doc.targetScheduled),
    scheduled: num(doc.scheduled),
    screened: num(doc.screened),
    enrolled: num(doc.enrolled),
    attainmentPct: attainment(doc.enrolled, doc.targetScheduled)
  };
}

async function findSites(database, { siteId, siteName, limit = 15 } = {}) {
  const container = database.container("legacy_sites");
  if (siteId) {
    try {
      const { resource } = await container.item(String(siteId), String(siteId)).read();
      return resource ? [resource] : [];
    } catch (_) {
      /* fall through to name search */
    }
  }
  if (siteName) {
    const needle = String(siteName).trim();
    if (needle.length < 3) return [];
    const rows = await queryAll(
      container,
      `SELECT TOP @lim * FROM c WHERE c.docType = @t AND (
         (IS_DEFINED(c.siteName) AND CONTAINS(LOWER(c.siteName), LOWER(@n))) OR
         (IS_DEFINED(c.name) AND CONTAINS(LOWER(c.name), LOWER(@n))) OR
         (IS_DEFINED(c.siteCode) AND CONTAINS(LOWER(c.siteCode), LOWER(@n)))
       )`,
      [
        { name: "@t", value: DOC_SITE },
        { name: "@n", value: needle },
        { name: "@lim", value: Math.max(limit * 4, 40) }
      ]
    );
    const key = normSiteName(needle);
    return rankNameMatches(rows, key, (r) => [r.siteName, r.name, r.siteCode]).slice(0, limit);
  }
  // Top sites by enrolled for portfolio-style trust asks
  const rows = await queryAll(
    container,
    `SELECT TOP @lim * FROM c WHERE c.docType = @t`,
    [
      { name: "@t", value: DOC_SITE },
      { name: "@lim", value: Math.max(limit * 3, 40) }
    ]
  );
  return rows
    .sort((a, b) => (num(b?.metrics?.enrolled) || 0) - (num(a?.metrics?.enrolled) || 0))
    .slice(0, limit);
}

async function findStudies(database, { studyId, studyName, limit = 15 } = {}) {
  const container = database.container("legacy_studies");
  if (studyId) {
    try {
      const { resource } = await container.item(String(studyId), String(studyId)).read();
      return resource ? [resource] : [];
    } catch (_) {}
  }
  if (studyName) {
    const needle = String(studyName).trim();
    if (needle.length < 3) return [];
    const rows = await queryAll(
      container,
      `SELECT TOP @lim * FROM c WHERE c.docType = @t AND (
         (IS_DEFINED(c.studyName) AND CONTAINS(LOWER(c.studyName), LOWER(@n))) OR
         (IS_DEFINED(c.name) AND CONTAINS(LOWER(c.name), LOWER(@n))) OR
         (IS_DEFINED(c.title) AND CONTAINS(LOWER(c.title), LOWER(@n)))
       )`,
      [
        { name: "@t", value: DOC_STUDY },
        { name: "@n", value: needle },
        { name: "@lim", value: Math.max(limit * 4, 40) }
      ]
    );
    const key = normSiteName(needle);
    return rankNameMatches(rows, key, (r) => [r.studyName, r.name, r.title]).slice(0, limit);
  }
  const rows = await queryAll(
    container,
    `SELECT TOP @lim * FROM c WHERE c.docType = @t`,
    [
      { name: "@t", value: DOC_STUDY },
      { name: "@lim", value: Math.max(limit * 3, 40) }
    ]
  );
  return rows
    .sort((a, b) => (num(b?.metrics?.enrolled) || 0) - (num(a?.metrics?.enrolled) || 0))
    .slice(0, limit);
}

async function outcomesForSite(database, siteId, limit = 40) {
  if (!siteId) return [];
  return queryAll(
    database.container("legacy_site_study_outcomes"),
    `SELECT TOP @lim * FROM c WHERE c.docType = @t AND c.siteId = @id`,
    [
      { name: "@t", value: DOC_BY_SITE },
      { name: "@id", value: String(siteId) },
      { name: "@lim", value: limit }
    ]
  );
}

async function outcomesForStudy(database, studyId, limit = 40) {
  if (!studyId) return [];
  return queryAll(
    database.container("legacy_study_site_outcomes"),
    `SELECT TOP @lim * FROM c WHERE c.docType = @t AND c.studyId = @id`,
    [
      { name: "@t", value: DOC_BY_STUDY },
      { name: "@id", value: String(studyId) },
      { name: "@lim", value: limit }
    ]
  );
}

function summarizeOutcomes(rows) {
  const slim = (rows || []).map(slimOutcome).filter(Boolean);
  const enrolled = slim.map((r) => r.enrolled).filter((n) => n != null);
  const attainmentPcts = slim.map((r) => r.attainmentPct).filter((n) => n != null);
  const byEnrolled = [...slim]
    .filter((r) => r.enrolled != null)
    .sort((a, b) => (b.enrolled || 0) - (a.enrolled || 0))
    .slice(0, 12);
  const preferred = slim.filter(
    (r) => r.siteName && /prefer|strategic|tier\s*1|high/i.test(String(r.group || ""))
  );
  return {
    n: slim.length,
    medianEnrolled: median(enrolled),
    medianAttainmentPct: median(attainmentPcts),
    topByEnrolled: byEnrolled,
    sample: slim.slice(0, 15)
  };
}

function trustRollup(sites) {
  const slim = (sites || []).map(slimSite).filter(Boolean);
  const withPref = slim.filter((s) => s.relationshipPreference);
  const preferred = slim
    .filter((s) => /prefer|strategic|tier\s*1|key|high|good/i.test(String(s.relationshipPreference || "")))
    .slice(0, 15);
  const withNotes = slim
    .filter((s) => s.advantages || s.disadvantages || s.relationshipNotes)
    .slice(0, 12);
  const byEnrolled = [...slim]
    .filter((s) => s.metrics && s.metrics.enrolled != null)
    .sort((a, b) => (b.metrics.enrolled || 0) - (a.metrics.enrolled || 0))
    .slice(0, 12);
  return {
    sitesSampled: slim.length,
    withRelationshipPreference: withPref.length,
    preferredSites: preferred,
    sitesWithTrustNotes: withNotes,
    topSitesByEnrolled: byEnrolled
  };
}

/**
 * Build a bounded Buddy pack from legacy anterior-segment containers.
 * @param {Function} getDb
 * @param {{ question?: string, siteName?: string, studyName?: string, siteId?: string, studyId?: string, indication?: string, force?: boolean, includeEnrollment?: boolean }} opts
 */
async function buildLegacyAnteriorContext(getDb, opts = {}) {
  const question = String(opts.question || "");
  const hints = extractLegacyNameHints(question);
  const siteName = opts.siteName || hints.siteName || null;
  const studyName = opts.studyName || hints.studyName || null;
  const siteId = opts.siteId || hints.siteId || null;
  const studyId = opts.studyId || hints.studyId || null;
  const indication = String(opts.indication || "").trim() || null;
  const intent = isLegacyAnteriorQuestion(question);
  const named = Boolean(siteName || studyName || siteId || studyId);

  const includeEnrollment = opts.includeEnrollment !== false && Boolean(opts.includeEnrollment);

  if (!opts.force && !intent && !named && !indication) {
    return null;
  }

  let database;
  try {
    database = getDb();
  } catch (err) {
    return { source: DATASET, error: String(err.message || err) };
  }

  let aliases = indication ? [indication] : [];
  if (indication) {
    try {
      const { indicationAliases } = require("./intelligence");
      aliases = indicationAliases(indication);
    } catch (_) {
      /* keep [indication] */
    }
  }

  const out = {
    source: DATASET,
    dataset: DATASET,
    note:
      "Legacy anterior-segment overview (Excel import). Separate from Ora Veeva / TrialHub / budget studies. Use for historical site trust and enrollment feasibility. Null metrics mean missing — never treat as zero." +
      (indication
        ? ` Filtered to indication "${indication}" (budget-tool vocabulary via study indication).`
        : ""),
    query: { siteName, studyName, siteId, studyId, indication, intent, includeEnrollment },
    enrollmentIncluded: includeEnrollment,
    enrollmentAvailable: true,
    sites: null,
    studies: null,
    siteOutcomes: null,
    studyOutcomes: null,
    trust: null,
    indicationSites: null
  };

  try {
    // Always attach a leaderboard for legacy asks (table/visual/trust) — Cosmos is the source
    if (indication || includeEnrollment || intent || opts.force) {
      try {
        const enriched = await enrichSitesWithLegacy(database, [], {
          indication,
          indicationAliases: aliases
        });
        out.indicationSites = {
          indication: enriched.meta?.indicationFilter || indication,
          matchingStudyCount: enriched.meta?.matchingStudyCount,
          topByEnrolled: (enriched.meta?.leaderboard || []).slice(0, 40),
          note: enriched.meta?.note
        };
        if (includeEnrollment) {
          out.htmlTable = {
            title: indication
              ? `Legacy anterior-segment sites — ${indication}`
              : "Legacy anterior-segment recruitment leaderboard",
            columns: [
              "siteName",
              "relationshipPreference",
              "enrolled",
              "scheduled",
              "screened",
              "targetScheduled",
              "attainmentPct",
              "nStudies",
              "indication"
            ],
            rows: (enriched.meta?.leaderboard || []).slice(0, 40).map((s) => ({
              siteName: s.siteName,
              relationshipPreference: s.relationshipPreference || null,
              enrolled: s.metrics?.enrolled ?? null,
              scheduled: s.metrics?.scheduled ?? null,
              screened: s.metrics?.screened ?? null,
              targetScheduled: s.metrics?.targetScheduled ?? null,
              attainmentPct: s.metrics?.attainmentPct ?? null,
              nStudies: s.metrics?.nStudies ?? null,
              indication: s.indication || s.metrics?.indication || indication || null
            })),
            note: "Queried live from Cosmos legacy_sites / legacy outcomes. Never ask the user to paste this table."
          };
        }
        if (!named && enriched.meta?.leaderboard?.length) {
          out.trust = {
            sitesSampled: enriched.meta.leaderboard.length,
            withRelationshipPreference: 0,
            preferredSites: [],
            sitesWithTrustNotes: [],
            topSitesByEnrolled: enriched.meta.leaderboard.slice(0, 25),
            indicationFilter: enriched.meta.indicationFilter
          };
        }
      } catch (err) {
        out.indicationSites = { error: String(err.message || err) };
      }
    }

    const siteRows = await findSites(database, {
      siteId,
      siteName,
      limit: named ? 10 : 20
    });
    out.sites = {
      matched: siteRows.length,
      items: siteRows.map(slimSite).slice(0, 15)
    };
    if (!out.trust) out.trust = trustRollup(siteRows);

    const primarySite = siteRows[0];
    if (includeEnrollment && primarySite && (named || intent)) {
      const sid = primarySite.siteId || primarySite.id;
      const oc = await outcomesForSite(database, sid, 50);
      out.siteOutcomes = {
        siteId: sid,
        siteName: primarySite.siteName || primarySite.name,
        ...summarizeOutcomes(oc)
      };
    }

    let studyRows = await findStudies(database, {
      studyId,
      studyName,
      limit: named ? 10 : 40
    });
    if (indication && aliases.length) {
      studyRows = studyRows.filter((s) =>
        indicationMatches(s.oraIndication || s.indication, aliases)
      );
    }
    out.studies = {
      matched: studyRows.length,
      items: studyRows.map(slimStudy).slice(0, 12)
    };

    const primaryStudy = studyRows[0];
    if (includeEnrollment && primaryStudy && (studyName || studyId || (intent && named))) {
      const stid = primaryStudy.studyId || primaryStudy.id;
      const oc = await outcomesForStudy(database, stid, 50);
      out.studyOutcomes = {
        studyId: stid,
        studyName: primaryStudy.studyName || primaryStudy.name || primaryStudy.title,
        ...summarizeOutcomes(oc)
      };
    }

    if (!includeEnrollment) {
      if (out.sites?.items) {
        out.sites.items = out.sites.items.map((s) => ({
          ...s,
          metrics: s.metrics
            ? {
                nStudies: s.metrics.nStudies,
                nPis: s.metrics.nPis,
                studyNames: s.metrics.studyNames,
                enrollmentHidden: true
              }
            : null
        }));
      }
      if (out.studies?.items) {
        out.studies.items = out.studies.items.map((s) => ({
          ...s,
          metrics: s.metrics
            ? { nSites: s.metrics.nSites, nPis: s.metrics.nPis, enrollmentHidden: true }
            : null
        }));
      }
      if (out.trust) out.trust.topSitesByEnrolled = [];
      if (out.htmlTable) out.htmlTable = null;
      if (out.indicationSites?.topByEnrolled) {
        out.indicationSites.topByEnrolled = out.indicationSites.topByEnrolled.map((s) => ({
          siteId: s.siteId,
          siteName: s.siteName,
          relationshipPreference: s.relationshipPreference,
          indication: s.indication,
          metrics: s.metrics
            ? { nStudies: s.metrics.nStudies, studyNames: s.metrics.studyNames }
            : null
        }));
      }
    }

    try {
      const [sc, tc, oc] = await Promise.all([
        queryAll(database.container("legacy_sites"), "SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t", [
          { name: "@t", value: DOC_SITE }
        ]),
        queryAll(database.container("legacy_studies"), "SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t", [
          { name: "@t", value: DOC_STUDY }
        ]),
        queryAll(
          database.container("legacy_site_study_outcomes"),
          "SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t",
          [{ name: "@t", value: DOC_BY_SITE }]
        )
      ]);
      out.counts = {
        sites: sc[0] || 0,
        studies: tc[0] || 0,
        outcomes: oc[0] || 0
      };
    } catch (_) {
      out.counts = null;
    }
  } catch (err) {
    out.error = String(err.message || err);
  }

  return out;
}

function normSiteName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Score how well a needle matches any of a row's name fields (higher = better). */
function nameMatchScore(needleNorm, candidateNorm) {
  if (!needleNorm || !candidateNorm) return 0;
  if (needleNorm === candidateNorm) return 1000 + candidateNorm.length;
  const tokens = (s) => s.split(/\s+/).filter((t) => t.length >= 3);
  const nt = tokens(needleNorm);
  const ct = tokens(candidateNorm);
  if (nt.length && ct.length) {
    const cset = new Set(ct);
    const overlap = nt.filter((t) => cset.has(t)).length;
    if (overlap) {
      const ratio = overlap / Math.max(nt.length, ct.length);
      if (ratio >= 0.6 || overlap >= 2) return 400 + Math.round(ratio * 100) + overlap * 10;
    }
  }
  // Substring only when the shorter side is long enough to avoid "core"/"eye" false hits
  const shorter = needleNorm.length <= candidateNorm.length ? needleNorm : candidateNorm;
  const longer = needleNorm.length <= candidateNorm.length ? candidateNorm : needleNorm;
  if (shorter.length >= 8 && longer.includes(shorter)) return 200 + shorter.length;
  if (shorter.length >= 5 && longer.startsWith(shorter)) return 150 + shorter.length;
  return 0;
}

function rankNameMatches(rows, needleNorm, namesOf) {
  return (rows || [])
    .map((row) => {
      let best = 0;
      for (const n of namesOf(row) || []) {
        best = Math.max(best, nameMatchScore(needleNorm, normSiteName(n)));
      }
      return { row, score: best };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (num(b.row?.metrics?.enrolled) || 0) - (num(a.row?.metrics?.enrolled) || 0))
    .map((x) => x.row);
}

function legacyMetricsPayload(hit, overrideMetrics = null) {
  const m = overrideMetrics || hit.metrics || {};
  const enrolled = num(m.enrolled);
  const screened = num(m.screened);
  const scheduled = num(m.scheduled);
  const target = num(m.targetScheduled);
  const screenPct = screened != null && scheduled > 0 ? roundPct(screened / scheduled) : null;
  const enrollOfScreen = enrolled != null && screened > 0 ? roundPct(enrolled / screened) : null;
  return {
    siteId: hit.siteId || hit.id,
    siteName: hit.siteName || hit.name,
    relationshipPreference: hit.relationshipPreference || null,
    advantages: hit.advantages || null,
    disadvantages: hit.disadvantages || null,
    indication: m.indication || hit.indication || null,
    indications: Array.isArray(m.indications) ? m.indications : null,
    targetScheduled: target,
    scheduled,
    screened,
    enrolled,
    nStudies: num(m.nStudies),
    attainmentPct: attainment(enrolled, target),
    screenedOfScheduledPct: screenPct,
    enrolledOfScreenedPct: enrollOfScreen
  };
}

function normIndication(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function indicationMatches(value, aliases = []) {
  const v = normIndication(value);
  if (!v || !aliases.length) return false;
  const isDryEye = (s) =>
    /\bdry eye\b/.test(s) || /\bkeratoconjunctivitis\b/.test(s) || /\bmeibomian\b/.test(s) || s === "ded";
  const isDryAmd = (s) =>
    /\bdry amd\b/.test(s) || /\bgeographic atrophy\b/.test(s) || s === "ga";
  for (const a of aliases) {
    const na = normIndication(a);
    if (!na) continue;
    // Dry Eye ≠ Dry AMD even though both contain "dry"
    if ((isDryEye(v) && isDryAmd(na)) || (isDryAmd(v) && isDryEye(na))) continue;
    if (v === na) return true;
    // Token-bounded phrase only — "dry" must not match either family
    if (na.length < 5) continue;
    const hv = ` ${v} `;
    const hn = ` ${na} `;
    if (hv.includes(hn) || hn.includes(hv)) return true;
  }
  return false;
}

/**
 * Match Ora scorecard sites (org_clean) to legacy_sites and attach recruitment metrics.
 * When indicationAliases are provided, metrics are rolled up from site×study outcomes
 * for studies whose indication matches (same vocabulary as the budget tool).
 */
async function enrichSitesWithLegacy(database, sites = [], opts = {}) {
  const aliases = Array.isArray(opts.indicationAliases)
    ? opts.indicationAliases.filter(Boolean)
    : opts.indication
      ? [opts.indication]
      : [];
  const filterIndication = Boolean(aliases.length);

  const [legacyRows, studyRows, outcomeRows] = await Promise.all([
    queryAll(database.container("legacy_sites"), `SELECT * FROM c WHERE c.docType = @t`, [
      { name: "@t", value: DOC_SITE }
    ]),
    queryAll(database.container("legacy_studies"), `SELECT * FROM c WHERE c.docType = @t`, [
      { name: "@t", value: DOC_STUDY }
    ]),
    queryAll(
      database.container("legacy_site_study_outcomes"),
      `SELECT * FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: DOC_BY_SITE }]
    )
  ]);

  const studyIndById = new Map();
  const matchingStudyIds = new Set();
  for (const st of studyRows) {
    const ind = st.oraIndication || st.indication || null;
    const id = String(st.studyId || st.id);
    studyIndById.set(id, ind);
    if (!filterIndication || indicationMatches(ind, aliases)) matchingStudyIds.add(id);
  }

  // Per-site rollup — either all outcomes, or only studies matching indication
  const metricsBySiteId = new Map();
  for (const o of outcomeRows) {
    const studyId = String(o.studyId || "");
    if (filterIndication && !matchingStudyIds.has(studyId)) continue;
    const siteId = String(o.siteId || "");
    if (!siteId) continue;
    let g = metricsBySiteId.get(siteId);
    if (!g) {
      g = {
        targetScheduled: 0,
        scheduled: 0,
        screened: 0,
        enrolled: 0,
        nStudies: new Set(),
        indications: new Set(),
        studyNames: []
      };
      metricsBySiteId.set(siteId, g);
    }
    g.targetScheduled += num(o.targetScheduled) || 0;
    g.scheduled += num(o.scheduled) || 0;
    g.screened += num(o.screened) || 0;
    g.enrolled += num(o.enrolled) || 0;
    if (studyId) g.nStudies.add(studyId);
    const ind = studyIndById.get(studyId);
    if (ind) g.indications.add(ind);
    if (o.studyName && g.studyNames.length < 12) g.studyNames.push(o.studyName);
  }

  function metricsForSite(row) {
    const siteId = String(row.siteId || row.id);
    const g = metricsBySiteId.get(siteId);
    if (!g) {
      if (filterIndication) return null; // no outcomes for this indication
      return null;
    }
    if (filterIndication && g.nStudies.size === 0) return null;
    return {
      targetScheduled: g.targetScheduled || null,
      scheduled: g.scheduled || null,
      screened: g.screened || null,
      enrolled: g.enrolled || null,
      nStudies: g.nStudies.size,
      indication: filterIndication ? aliases[0] : [...g.indications][0] || null,
      indications: [...g.indications],
      studyNames: g.studyNames
    };
  }

  const entries = [];
  const siteById = new Map();
  for (const row of legacyRows) {
    siteById.set(String(row.siteId || row.id), row);
    const names = [row.siteName, row.name, row.siteCode].filter(Boolean);
    for (const n of names) {
      const key = normSiteName(n);
      if (key) entries.push({ key, row });
    }
  }

  function findMatch(org) {
    const key = normSiteName(org);
    if (!key) return null;
    let best = null;
    let bestScore = 0;
    for (const { key: k, row } of entries) {
      const score = nameMatchScore(key, k);
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }
    return bestScore >= 150 ? best : null;
  }

  let matched = 0;
  const usedLegacyIds = new Set();
  const outSites = (sites || []).map((s) => {
    const hit = findMatch(s.org_clean);
    if (!hit) return { ...s, legacy: null, legacyMatched: false };
    const m = metricsForSite(hit);
    if (filterIndication && !m) return { ...s, legacy: null, legacyMatched: false };
    matched += 1;
    usedLegacyIds.add(String(hit.siteId || hit.id));
    return {
      ...s,
      legacyMatched: true,
      legacyMatchQuality: "name",
      legacy: legacyMetricsPayload(hit, m || hit.metrics)
    };
  });

  // Leaderboard: sites with indication-filtered metrics, else site-level rollup
  const leaderboard = [];
  for (const row of legacyRows) {
    const m = metricsForSite(row);
    if (filterIndication && !m) continue;
    const metrics = m || row.metrics || {};
    const slim = slimSite({ ...row, metrics: { ...(row.metrics || {}), ...metrics } });
    if (!slim) continue;
    if (slim.metrics) {
      slim.metrics.indication = metrics.indication || null;
      slim.metrics.indications = metrics.indications || null;
    }
    slim.indication = metrics.indication || null;
    leaderboard.push({
      ...slim,
      matchedToOra: usedLegacyIds.has(String(slim.siteId))
    });
  }
  leaderboard.sort((a, b) => (b.metrics?.enrolled || 0) - (a.metrics?.enrolled || 0));

  const matchedStudyCount = matchingStudyIds.size;
  return {
    sites: outSites,
    meta: {
      source: DATASET,
      legacySiteCount: legacyRows.length,
      matched,
      unmatched: outSites.length - matched,
      indicationFilter: filterIndication ? aliases[0] : null,
      indicationAliases: filterIndication ? aliases : null,
      matchingStudyCount: filterIndication ? matchedStudyCount : studyRows.length,
      leaderboard: leaderboard.slice(0, 60),
      note: filterIndication
        ? `Legacy sites filtered to indication "${aliases[0]}" via study outcomes (${matchedStudyCount} studies). Ranked by enrolled for that indication.`
        : "Legacy recruitment lists sites ranked by enrolled across all anterior-segment studies. Pass an indication to filter."
    }
  };
}

function roundPct(x) {
  if (x == null || !Number.isFinite(x)) return null;
  return Math.round(x * 1000) / 10;
}

function userConsentedLegacyEnrollment(question, history = []) {
  const q = String(question || "").toLowerCase();
  // Asking for the legacy table / visual is consent to use enrollment columns
  if (isLegacyTableAsk(question)) return true;
  if (wantsHtmlVisual(question) && /\blegacy\b/.test(q)) return true;
  // Explicit opt-in on this turn
  if (
    /\b(yes|yeah|yep|sure|ok|okay|please|include|use|pull|show|produce|build|make|generate)\b/.test(q) &&
    /\b(legacy|anterior|enrollment|recruitment|historical|table|board)\b/.test(q)
  ) {
    return true;
  }
  if (/\b(include|use|with|show|pull)\b.{0,40}\blegacy\b/i.test(q)) return true;
  if (/\blegacy\b.{0,30}\b(enroll|recruit|table|board|data|visual|html)\b/i.test(q)) return true;
  // Recent assistant asked + user said yes
  const turns = history || [];
  for (let i = turns.length - 1; i >= 0 && i >= turns.length - 4; i--) {
    const t = turns[i];
    if (t.role === "user" && /\b(yes|yeah|yep|sure|ok|okay|please|include it|use it|go ahead)\b/i.test(t.content || "")) {
      for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
        if (
          turns[j].role === "assistant" &&
          /\blegacy\b/i.test(turns[j].content || "") &&
          /\b(enroll|recruit|table)\b/i.test(turns[j].content || "")
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

module.exports = {
  DATASET,
  isLegacyAnteriorQuestion,
  isLegacyOverviewQuestion,
  isLegacyTableAsk,
  wantsHtmlVisual,
  extractLegacyNameHints,
  buildLegacyAnteriorContext,
  enrichSitesWithLegacy,
  userConsentedLegacyEnrollment
};
