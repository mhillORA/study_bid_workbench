/**
 * Artemis feasibility master in Cosmos (bd-budgets):
 *   feasibility_sites, feasibility_site_profiles,
 *   feasibility_survey_definitions, feasibility_survey_responses
 *
 * Buddy tools: search sites, search survey questions/answers, cluster duplicate sites.
 */

const SITES = "feasibility_sites";
const PROFILES = "feasibility_site_profiles";
const DEFS = "feasibility_survey_definitions";
const RESPONSES = "feasibility_survey_responses";
const DATASET = "artemis_feasibility_master";

async function queryAll(container, query, parameters = []) {
  const { resources } = await container.items
    .query({ query, parameters }, { enableCrossPartitionQuery: true })
    .fetchAll();
  return resources || [];
}

function normText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip PI-as-site naming noise so "David Brown Site" ≈ "David Brown (site)". */
function normalizeSiteName(name) {
  let s = normText(name);
  s = s
    .replace(/\b(md|phd|do|od|mba|facs|faao)\b/g, " ")
    .replace(/\b(site|llc|pc|pllc|inc|ltd|plc)\b/g, " ")
    .replace(/\b(dr|doctor)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Drop trailing city in parens already stripped by norm; remove lone city tags
  return s;
}

function normalizePi(pi) {
  return normalizeSiteName(pi);
}

function addressKey(row) {
  const a = normText([row.address1, row.city, row.state].filter(Boolean).join(" "));
  return a.length >= 10 ? a : "";
}

function isPiStyleName(name) {
  const n = String(name || "");
  return /\(\s*site\s*\)\s*$/i.test(n) || /\bsite\s*$/i.test(n.trim());
}

function isInstitutionStyleName(name) {
  const n = String(name || "");
  if (!n.trim()) return false;
  if (isPiStyleName(n)) return false;
  return /\b(eye|retina|ophthal|clinic|institute|research|associates|hospital|university|medical|vision|center|centre|partners)\b/i.test(
    n
  );
}

function siteRichness(row) {
  let score = 0;
  const m = row.metrics || {};
  if (isInstitutionStyleName(row.siteName)) score += 40;
  if (!isPiStyleName(row.siteName)) score += 10;
  if (row.linkedArtemisSiteId) score += 15;
  if (row.address1) score += 8;
  if (row.city && row.state) score += 5;
  score += Math.min(25, Number(row.feasibilitySurveyCount) || 0);
  score += Math.min(20, Math.round((Number(m.enrolled) || 0) / 50));
  score += Math.min(10, Number(m.nStudies) || 0);
  if (row.pi) score += 3;
  return score;
}

function summarizeSite(row, extra = {}) {
  const m = row.metrics || {};
  return {
    siteId: row.siteId || row.id,
    siteName: row.siteName || null,
    pi: row.pi || null,
    city: row.city || null,
    state: row.state || null,
    address1: row.address1 || null,
    indicationsCovered: row.indicationsCovered || row.therapeuticAreas || [],
    linkedArtemisSiteId: row.linkedArtemisSiteId || null,
    feasibilitySurveyCount: row.feasibilitySurveyCount ?? null,
    enrolled: m.enrolled ?? null,
    screened: m.screened ?? null,
    nStudies: m.nStudies ?? null,
    studyNames: Array.isArray(m.studyNames) ? m.studyNames.slice(0, 12) : null,
    richness: siteRichness(row),
    ...extra
  };
}

/**
 * Cluster duplicate / alias site rows (PI-as-name vs practice name, same address, etc.).
 */
function clusterSites(sites) {
  const rows = (sites || []).map((s) => ({ ...s, _sum: summarizeSite(s) }));
  const parent = new Map();
  const find = (id) => {
    if (!parent.has(id)) parent.set(id, id);
    const p = parent.get(id);
    if (p !== id) {
      const root = find(p);
      parent.set(id, root);
      return root;
    }
    return id;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const byName = new Map();
  const byPiCity = new Map();
  const byAddr = new Map();

  for (const r of rows) {
    const id = r.siteId || r.id;
    const nk = normalizeSiteName(r.siteName);
    if (nk.length >= 4) {
      if (!byName.has(nk)) byName.set(nk, []);
      byName.get(nk).push(id);
    }
    const pi = normalizePi(r.pi);
    const city = normText(r.city);
    if (pi.length >= 4) {
      const pk = city ? `${pi}|${city}` : pi;
      if (!byPiCity.has(pk)) byPiCity.set(pk, []);
      byPiCity.get(pk).push(id);
      // Also link PI-named sites to same PI without city when unique enough
      if (!byPiCity.has(pi)) byPiCity.set(pi, []);
      byPiCity.get(pi).push(id);
    }
    const ak = addressKey(r);
    if (ak) {
      if (!byAddr.has(ak)) byAddr.set(ak, []);
      byAddr.get(ak).push(id);
    }
  }

  const linkGroups = (map, minLen = 2) => {
    for (const ids of map.values()) {
      const uniq = [...new Set(ids)];
      if (uniq.length < minLen) continue;
      for (let i = 1; i < uniq.length; i += 1) union(uniq[0], uniq[i]);
    }
  };
  linkGroups(byName, 2);
  linkGroups(byAddr, 2);
  // PI+city: only when ≥2; bare PI only if exactly 2–3 (avoid mega-clusters)
  for (const [k, ids] of byPiCity.entries()) {
    const uniq = [...new Set(ids)];
    if (k.includes("|")) {
      if (uniq.length >= 2) for (let i = 1; i < uniq.length; i += 1) union(uniq[0], uniq[i]);
    } else if (uniq.length >= 2 && uniq.length <= 3) {
      for (let i = 1; i < uniq.length; i += 1) union(uniq[0], uniq[i]);
    }
  }

  // Soft: PI-style name matching institution that shares PI
  for (const r of rows) {
    if (!isPiStyleName(r.siteName)) continue;
    const pi = normalizePi(r.pi || r.siteName);
    if (pi.length < 5) continue;
    for (const other of rows) {
      if ((other.siteId || other.id) === (r.siteId || r.id)) continue;
      if (!isInstitutionStyleName(other.siteName)) continue;
      if (normalizePi(other.pi) === pi) union(r.siteId || r.id, other.siteId || other.id);
    }
  }

  const groups = new Map();
  for (const r of rows) {
    const id = r.siteId || r.id;
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  }

  const clusters = [];
  for (const members of groups.values()) {
    const sorted = [...members].sort((a, b) => siteRichness(b) - siteRichness(a));
    const canonical = sorted[0];
    const reasons = [];
    if (sorted.length > 1) {
      const names = new Set(sorted.map((m) => normalizeSiteName(m.siteName)));
      const addrs = new Set(sorted.map((m) => addressKey(m)).filter(Boolean));
      const pis = new Set(sorted.map((m) => normalizePi(m.pi)).filter(Boolean));
      if (names.size === 1) reasons.push("same_name");
      if (addrs.size === 1 && addrs.values().next().value) reasons.push("same_address");
      if (pis.size === 1 && pis.values().next().value) reasons.push("same_pi");
      if (sorted.some((m) => isPiStyleName(m.siteName)) && sorted.some((m) => isInstitutionStyleName(m.siteName))) {
        reasons.push("pi_vs_institution");
      }
    }
    clusters.push({
      canonicalSiteId: canonical.siteId || canonical.id,
      canonicalName: canonical.siteName,
      canonical: summarizeSite(canonical),
      memberCount: sorted.length,
      matchReasons: reasons.length ? reasons : ["singleton"],
      confidence: sorted.length === 1 ? "singleton" : reasons.includes("same_address") || reasons.includes("same_name") ? "high" : "medium",
      members: sorted.map((m) =>
        summarizeSite(m, {
          isCanonical: (m.siteId || m.id) === (canonical.siteId || canonical.id)
        })
      )
    });
  }

  clusters.sort((a, b) => b.memberCount - a.memberCount || (b.canonical.richness || 0) - (a.canonical.richness || 0));

  const dupClusters = clusters.filter((c) => c.memberCount > 1);
  return {
    siteCount: rows.length,
    clusterCount: clusters.length,
    duplicateClusterCount: dupClusters.length,
    duplicateMemberCount: dupClusters.reduce((n, c) => n + c.memberCount, 0),
    clusters,
    duplicateClusters: dupClusters
  };
}

function extractSiteHint(question) {
  const q = String(question || "");
  const quoted = q.match(/["']([^"']{3,80})["']/);
  if (quoted) return quoted[1].trim();
  const m =
    q.match(/\bsite\s+(?:named\s+|called\s+)?([A-Za-z0-9][\w .,&'\-/]{2,60})/i) ||
    q.match(/\b(?:for|at|about)\s+([A-Z][\w .,&'\-/]{2,50}?(?:Eye|Retina|Clinic|Institute|Associates|Research|Vision|Partners)[\w .,&'\-/]*)/);
  return m ? m[1].trim().replace(/[?.!,;]+$/, "") : null;
}

function extractQuestionHint(question) {
  const q = String(question || "");
  const quoted = [...q.matchAll(/["']([^"']{4,120})["']/g)].map((m) => m[1]);
  if (quoted.length) return quoted[quoted.length - 1];
  const m = q.match(/\bquestions?\s+(?:about|on|for|containing|with)\s+(.+)$/i);
  if (m) return m[1].trim().replace(/[?.!,;]+$/, "");
  return null;
}

function scoreSiteMatch(row, needle) {
  const n = normText(needle);
  if (!n) return 0;
  const name = normalizeSiteName(row.siteName);
  const pi = normalizePi(row.pi);
  const city = normText(row.city);
  const blob = `${name} ${pi} ${city} ${normText(row.address1)} ${(row.indicationsCovered || []).join(" ")}`;
  let score = 0;
  if (name === n) score += 100;
  else if (name.startsWith(n) || n.startsWith(name)) score += 70;
  else if (name.includes(n) || n.includes(name)) score += 50;
  if (pi && (pi.includes(n) || n.includes(pi))) score += 40;
  if (city && n.includes(city)) score += 10;
  for (const tok of n.split(" ").filter((t) => t.length > 2)) {
    if (blob.includes(tok)) score += 6;
  }
  score += Math.min(15, siteRichness(row) / 5);
  return score;
}

async function loadAllSites(database) {
  return queryAll(
    database.container(SITES),
    `SELECT c.id, c.siteId, c.siteName, c.siteCode, c.pi, c.city, c.state, c.zip, c.address1,
            c.indicationsCovered, c.therapeuticAreas, c.linkedArtemisSiteId, c.metrics,
            c.feasibilitySurveyCount, c.surveyIds, c.profileId, c.notes
     FROM c WHERE c.docType = @t OR NOT IS_DEFINED(c.docType)`,
    [{ name: "@t", value: "feasibilityLegacySite" }]
  );
}

async function loadAllDefs(database) {
  return queryAll(
    database.container(DEFS),
    `SELECT c.id, c.title, c.indication, c.therapeuticArea, c.questionCount, c.questions,
            c.responseCount, c.siteCount, c.platform, c.sourceTab
     FROM c`
  );
}

function searchSitesInMemory(sites, { needle, indication, limit = 15 } = {}) {
  let list = sites || [];
  if (indication) {
    const ind = normText(indication);
    list = list.filter((s) => {
      const covered = [...(s.indicationsCovered || []), ...(s.therapeuticAreas || [])]
        .map(normText)
        .join(" ");
      return !ind || covered.includes(ind) || covered.includes(ind.replace(/\s+/g, ""));
    });
  }
  if (needle) {
    const scored = list
      .map((s) => ({ s, score: scoreSiteMatch(s, needle) }))
      .filter((x) => x.score >= 20)
      .sort((a, b) => b.score - a.score || siteRichness(b.s) - siteRichness(a.s));
    return scored.slice(0, limit).map((x) => summarizeSite(x.s, { matchScore: x.score }));
  }
  return [...list]
    .sort((a, b) => siteRichness(b) - siteRichness(a))
    .slice(0, limit)
    .map((s) => summarizeSite(s));
}

function searchQuestionsInMemory(defs, { needle, indication, limit = 25 } = {}) {
  const n = normText(needle);
  const ind = normText(indication);
  const hits = [];
  for (const d of defs || []) {
    if (ind) {
      const dInd = normText(d.indication || d.therapeuticArea || "");
      if (dInd && !dInd.includes(ind) && !ind.includes(dInd)) {
        // still allow question-label matches across surveys
      }
    }
    for (const q of d.questions || []) {
      const label = String(q.label || "");
      const blob = normText(`${label} ${d.title} ${d.indication || ""}`);
      if (!n) continue;
      if (!blob.includes(n) && !n.split(" ").every((t) => t.length < 3 || blob.includes(t))) {
        const toks = n.split(" ").filter((t) => t.length > 2);
        if (!toks.some((t) => blob.includes(t))) continue;
      }
      let score = 0;
      if (blob.includes(n)) score += 40;
      for (const t of n.split(" ").filter((x) => x.length > 2)) {
        if (blob.includes(t)) score += 8;
      }
      if (ind && normText(d.indication || "").includes(ind)) score += 15;
      hits.push({
        surveyId: d.id,
        surveyTitle: d.title,
        indication: d.indication || null,
        therapeuticArea: d.therapeuticArea || null,
        questionId: q.id,
        label,
        type: q.type || null,
        required: Boolean(q.required),
        responseCount: d.responseCount ?? null,
        matchScore: score
      });
    }
  }
  hits.sort((a, b) => b.matchScore - a.matchScore);
  return hits.slice(0, limit);
}

async function loadAnswersForQuestions(database, questionHits, { siteIds = null, limit = 40 } = {}) {
  if (!questionHits?.length) return [];
  const bySurvey = new Map();
  for (const h of questionHits) {
    if (!bySurvey.has(h.surveyId)) bySurvey.set(h.surveyId, new Set());
    bySurvey.get(h.surveyId).add(h.questionId);
  }
  const out = [];
  for (const [surveyId, qids] of bySurvey.entries()) {
    let rows;
    try {
      rows = await queryAll(
        database.container(RESPONSES),
        `SELECT TOP 80 c.id, c.siteId, c.surveyId, c.displayName, c.indication, c.study,
                c.targetRole, c.answerCount, c.answers, c.submittedAt
         FROM c WHERE c.surveyId = @s`,
        [{ name: "@s", value: surveyId }]
      );
    } catch (_) {
      rows = [];
    }
    for (const row of rows) {
      if (siteIds && siteIds.length && !siteIds.includes(row.siteId)) continue;
      const answers = (row.answers || []).filter((a) => qids.has(a.questionId || a.id));
      if (!answers.length) continue;
      out.push({
        responseId: row.id,
        siteId: row.siteId,
        surveyId: row.surveyId,
        displayName: row.displayName || null,
        indication: row.indication || null,
        study: row.study || null,
        targetRole: row.targetRole || null,
        submittedAt: row.submittedAt || null,
        answers: answers.map((a) => ({
          questionId: a.questionId || a.id,
          label: a.label || null,
          value: a.value != null ? String(a.value).slice(0, 400) : null
        }))
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function isFeasibilityArtemisQuestion(question) {
  const q = String(question || "").toLowerCase();
  if (
    /\b(feasibility\s+(survey|site|master|question)|artemis\s+feasibility|survey\s+question|site\s+feasibility)\b/.test(
      q
    )
  ) {
    return true;
  }
  if (/\b(duplicate\s+sites?|dedupe\s+sites?|match\s+sites?|site\s+aliases?|same\s+site)\b/.test(q)) {
    return true;
  }
  if (/\b(feasibility|survey)\b/.test(q) && /\b(site|question|pi|investigator|answer|response)\b/.test(q)) {
    return true;
  }
  return false;
}

function wantsSiteMatchReport(question) {
  return /\b(duplicate|dedupe|deduplicate|match\s+sites?|aliases?|same\s+site|merge\s+sites?)\b/i.test(
    String(question || "")
  );
}

function wantsQuestionSearch(question) {
  return /\b(question|survey\s+question|what\s+did\s+.+answer|answers?\s+to)\b/i.test(
    String(question || "")
  );
}

/**
 * Buddy pack — search sites / questions and optional duplicate-site clusters.
 */
async function buildFeasibilityArtemisContext(getDb, opts = {}) {
  const question = String(opts.question || "");
  const siteHint = opts.siteName || extractSiteHint(question);
  const questionHint = opts.questionHint || extractQuestionHint(question);
  const indication = opts.indication ? String(opts.indication).trim() : null;
  const wantMatch = opts.includeMatch === true || wantsSiteMatchReport(question);
  const wantQuestions = opts.includeQuestions !== false && (wantsQuestionSearch(question) || Boolean(questionHint) || isFeasibilityArtemisQuestion(question));

  let database;
  try {
    database = getDb();
  } catch (err) {
    return { source: DATASET, error: String(err.message || err) };
  }

  const out = {
    source: DATASET,
    dataset: DATASET,
    note:
      "Artemis feasibility export in Cosmos (feasibility_*). Sites often appear twice (PI-named vs practice). Use matchClusters.canonical for BD; members are aliases.",
    query: {
      siteHint: siteHint || null,
      questionHint: questionHint || null,
      indication,
      wantMatch,
      wantQuestions
    },
    sites: null,
    questions: null,
    answers: null,
    match: null
  };

  try {
    const sites = await loadAllSites(database);
    out.inventory = {
      sites: sites.length,
      note: "Loaded from feasibility_sites"
    };

    if (wantMatch || !siteHint) {
      const clustered = clusterSites(sites);
      out.match = {
        siteCount: clustered.siteCount,
        clusterCount: clustered.clusterCount,
        duplicateClusterCount: clustered.duplicateClusterCount,
        duplicateMemberCount: clustered.duplicateMemberCount,
        topDuplicateClusters: clustered.duplicateClusters.slice(0, 25),
        // When searching a site, resolve aliases
        resolvedForHint: null
      };
      if (siteHint) {
        const hits = searchSitesInMemory(sites, { needle: siteHint, indication, limit: 12 });
        out.sites = hits;
        const strongIds = new Set(
          hits.filter((h) => (h.matchScore || 0) >= 50).map((h) => h.siteId)
        );
        const related = clustered.clusters.filter((c) =>
          c.members.some((m) => strongIds.has(m.siteId))
        );
        out.match.resolvedForHint = related.slice(0, 8);
      } else if (wantMatch) {
        out.sites = clustered.duplicateClusters.slice(0, 15).map((c) => c.canonical);
      } else {
        out.sites = searchSitesInMemory(sites, { indication, limit: 12 });
      }
    } else {
      out.sites = searchSitesInMemory(sites, { needle: siteHint, indication, limit: 15 });
      const clustered = clusterSites(sites);
      const strongIds = new Set(
        (out.sites || []).filter((h) => (h.matchScore || 0) >= 50).map((h) => h.siteId)
      );
      out.match = {
        resolvedForHint: clustered.clusters
          .filter((c) => c.members.some((m) => strongIds.has(m.siteId)))
          .slice(0, 8),
        note: "Alias clusters for matched sites only (full dedupe report: ask to match/dedupe sites)."
      };
    }

    if (wantQuestions) {
      const defs = await loadAllDefs(database);
      out.inventory.surveyDefinitions = defs.length;
      const needle = questionHint || (wantQuestions && siteHint ? null : null);
      const qNeedle =
        questionHint ||
        (/\b(enroll|capacity|patient|screen|recruit|coordinator|investigator|pi experience)\b/i.test(question)
          ? question.match(/\b(enroll\w*|capacity|patient\w*|screen\w*|recruit\w*|coordinator\w*|investigator\w*)\b/i)?.[1]
          : null) ||
        "enroll";
      // If user asked about a site only, still attach common capacity questions when indication known
      const searchNeedle = questionHint || (wantsQuestionSearch(question) ? qNeedle : null);
      if (searchNeedle) {
        out.questions = searchQuestionsInMemory(defs, {
          needle: searchNeedle,
          indication,
          limit: 20
        });
        const siteIds = [
          ...new Set([
            ...(out.sites || []).map((s) => s.siteId),
            ...((out.match && out.match.resolvedForHint) || []).flatMap((c) =>
              (c.members || []).map((m) => m.siteId)
            )
          ])
        ].filter(Boolean);
        out.answers = await loadAnswersForQuestions(database, out.questions.slice(0, 8), {
          siteIds: siteIds.length ? siteIds.slice(0, 30) : null,
          limit: 35
        });
        // Attach display names from site map
        const byId = new Map(sites.map((s) => [s.siteId || s.id, s.siteName]));
        for (const a of out.answers || []) {
          a.siteName = byId.get(a.siteId) || a.displayName || null;
        }
      } else {
        out.questions = defs
          .slice()
          .sort((a, b) => (b.responseCount || 0) - (a.responseCount || 0))
          .slice(0, 12)
          .map((d) => ({
            surveyId: d.id,
            surveyTitle: d.title,
            indication: d.indication,
            questionCount: d.questionCount,
            responseCount: d.responseCount,
            sampleQuestions: (d.questions || []).slice(0, 6).map((q) => ({
              questionId: q.id,
              label: q.label,
              type: q.type
            }))
          }));
      }
    }

    return out;
  } catch (err) {
    return { ...out, error: String(err.message || err) };
  }
}

module.exports = {
  DATASET,
  SITES,
  PROFILES,
  DEFS,
  RESPONSES,
  isFeasibilityArtemisQuestion,
  wantsSiteMatchReport,
  wantsQuestionSearch,
  clusterSites,
  searchSitesInMemory,
  searchQuestionsInMemory,
  buildFeasibilityArtemisContext,
  normalizeSiteName,
  normalizePi
};
