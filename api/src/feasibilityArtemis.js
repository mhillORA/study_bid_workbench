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

const STOP_KEYWORDS = new Set(
  `a an the of to for and or in on at by with from is are was were be been being this that these those it its your our their how many what which who when where why do does did can could would should will have has had not no yes if then than as per each all any more most other such only own same so too very just also about into over after before between under again further once here there please provide following below listed select check specify apply apply. information details need able`.split(
    " "
  )
);

/** High-signal clinical / ops themes for Buddy keyword search. */
const QUESTION_THEMES = [
  {
    id: "enrollment",
    label: "Enrollment / capacity",
    match: /\b(enroll|enrollment|capacity|recruit|patients?\s+per|subjects?\s+per|block\s+enroll)/i
  },
  {
    id: "screening",
    label: "Screening / screen fail",
    match: /\b(screen|screening|screen\s*fail|eligibility|inclusion|exclusion)/i
  },
  {
    id: "investigator",
    label: "Investigator / PI",
    match: /\b(investigator|principal\s+investigator|\bpi\b|credentials|sub[- ]?i)/i
  },
  {
    id: "coordinator",
    label: "Coordinator / staffing",
    match: /\b(coordinator|crc|staff|fte|dedicated|research\s+nurse)/i
  },
  {
    id: "equipment",
    label: "Equipment / imaging",
    match: /\b(equipment|oct|bcva|fundus|imaging|device|slit\s*lamp|camera|certif)/i
  },
  {
    id: "pharmacy",
    label: "Pharmacy / IP storage",
    match: /\b(pharmacy|investigational\s+product|\bip\b|freezer|refrigerat|temperature|storage)/i
  },
  {
    id: "regulatory",
    label: "Regulatory / IRB",
    match: /\b(irb|ec\b|regulatory|ethics|icf|informed\s+consent)/i
  },
  {
    id: "competing",
    label: "Competing studies",
    match: /\b(compet|ongoing\s+stud|other\s+stud|currently\s+participat)/i
  },
  {
    id: "interest",
    label: "Interest / participation",
    match: /\b(interest|participat|willing|able\s+to\s+conduct|capacity\s+to)/i
  },
  {
    id: "budget",
    label: "Budget / contract",
    match: /\b(budget|contract|startup\s+fee|payment)/i
  },
  {
    id: "site_profile",
    label: "Site profile / practice",
    match: /\b(practice\s+setting|address|phone|email|contact|institution|satellite)/i
  }
];

/**
 * Catalog Buddy can browse: survey names, indications, question keywords & themes.
 */
function buildFeasibilityCatalog(defs, sites) {
  const surveys = (defs || [])
    .filter((d) => d && d.id && d.id !== "feasibility_pack_meta" && d.title)
    .map((d) => {
      const labels = (d.questions || []).map((q) => String(q.label || "").trim()).filter(Boolean);
      const keywords = new Map();
      for (const label of labels) {
        for (const tok of normText(label).split(" ")) {
          if (tok.length < 4 || STOP_KEYWORDS.has(tok)) continue;
          keywords.set(tok, (keywords.get(tok) || 0) + 1);
        }
      }
      const topKeywords = [...keywords.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 18)
        .map(([k]) => k);
      const themeHits = QUESTION_THEMES.map((t) => {
        const samples = labels.filter((l) => t.match.test(l)).slice(0, 4);
        return samples.length
          ? { theme: t.id, label: t.label, questionCount: labels.filter((l) => t.match.test(l)).length, samples }
          : null;
      }).filter(Boolean);
      return {
        surveyId: d.id,
        title: d.title,
        indication: d.indication || null,
        therapeuticArea: d.therapeuticArea || null,
        platform: d.platform || null,
        questionCount: d.questionCount ?? labels.length,
        responseCount: d.responseCount ?? null,
        siteCount: d.siteCount ?? null,
        topKeywords,
        themes: themeHits,
        sampleQuestions: labels.slice(0, 8)
      };
    })
    .sort((a, b) => (b.responseCount || 0) - (a.responseCount || 0));

  const indicationCounts = new Map();
  for (const s of surveys) {
    const ind = String(s.indication || "").trim();
    if (!ind) continue;
    if (!indicationCounts.has(ind)) {
      indicationCounts.set(ind, { indication: ind, surveys: 0, responses: 0, surveyTitles: [] });
    }
    const row = indicationCounts.get(ind);
    row.surveys += 1;
    row.responses += Number(s.responseCount) || 0;
    row.surveyTitles.push(s.title);
  }

  const siteIndicationCounts = new Map();
  for (const s of sites || []) {
    for (const x of [...(s.indicationsCovered || []), ...(s.therapeuticAreas || [])]) {
      const k = String(x || "").trim();
      if (!k) continue;
      siteIndicationCounts.set(k, (siteIndicationCounts.get(k) || 0) + 1);
    }
  }

  const globalKw = new Map();
  for (const s of surveys) {
    for (const k of s.topKeywords || []) {
      globalKw.set(k, (globalKw.get(k) || 0) + 1);
    }
  }

  const themesRollup = QUESTION_THEMES.map((t) => {
    const across = [];
    for (const s of surveys) {
      const hit = (s.themes || []).find((x) => x.theme === t.id);
      if (hit) {
        across.push({
          survey: s.title,
          indication: s.indication,
          questionCount: hit.questionCount,
          samples: hit.samples
        });
      }
    }
    return {
      theme: t.id,
      label: t.label,
      surveyCount: across.length,
      keywords: t.match.source.replace(/\\b/g, "").replace(/[|()]/g, " ").split(/\s+/).filter(Boolean).slice(0, 12),
      surveys: across.slice(0, 10)
    };
  }).filter((t) => t.surveyCount > 0);

  return {
    note:
      "Use surveyTitles / indications / questionKeywords to find Artemis feasibility data. Search questions with those keywords; match sites via siteName/PI then use match.canonical for duplicates.",
    howToAskExamples: [
      "Feasibility questions about enrollment for Dry Eye",
      "What did Total Eye Care answer on Aerie COMET?",
      "Sites with GA / geographic atrophy feasibility surveys",
      "Duplicate feasibility sites — match PI vs practice names",
      "Survey questions about OCT / BCVA equipment"
    ],
    surveyCount: surveys.length,
    surveys: surveys.map((s) => ({
      surveyId: s.surveyId,
      title: s.title,
      indication: s.indication,
      therapeuticArea: s.therapeuticArea,
      questionCount: s.questionCount,
      responseCount: s.responseCount,
      siteCount: s.siteCount,
      topKeywords: s.topKeywords,
      sampleQuestions: s.sampleQuestions,
      themes: (s.themes || []).map((t) => t.label)
    })),
    indicationsFromSurveys: [...indicationCounts.values()].sort((a, b) => b.responses - a.responses),
    indicationsFromSites: [...siteIndicationCounts.entries()]
      .map(([indication, siteCount]) => ({ indication, siteCount }))
      .sort((a, b) => b.siteCount - a.siteCount)
      .slice(0, 40),
    questionKeywords: [...globalKw.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([keyword, surveyHits]) => ({ keyword, surveyHits })),
    questionThemes: themesRollup,
    searchTips: {
      containers: ["feasibility_sites", "feasibility_site_profiles", "feasibility_survey_definitions", "feasibility_survey_responses"],
      joinKeys: ["siteId", "surveyId", "questionId"],
      duplicateNote: "Prefer catalog + match.canonicalName; PI-named rows are often aliases of practice names."
    }
  };
}

/** Static triggers so router fires even before catalog loads. */
const FEASIBILITY_TRIGGER_TERMS =
  /\b(artemis|feasibility|surveymonkey|general\s+site\s+feasibility|aerie\s+comet|dew261|4dmt|prism|cog2201|henlius|nacuity|usher|stargardt|eluminex|lotus|lentechs|viatris|neurotrophic|naion|nidek|boehringer|survey\s+question|feasibility\s+survey|feasibility\s+site)\b/i;

function isFeasibilityArtemisQuestion(question) {
  const q = String(question || "");
  if (FEASIBILITY_TRIGGER_TERMS.test(q)) return true;
  if (
    /\b(feasibility\s+(survey|site|master|question)|artemis\s+feasibility|survey\s+question|site\s+feasibility)\b/i.test(
      q
    )
  ) {
    return true;
  }
  if (/\b(duplicate\s+sites?|dedupe\s+sites?|match\s+sites?|site\s+aliases?|same\s+site)\b/i.test(q)) {
    return true;
  }
  if (/\b(feasibility|survey)\b/i.test(q) && /\b(site|question|pi|investigator|answer|response|enroll|oct|bcva|equipment)\b/i.test(q)) {
    return true;
  }
  // Indication + survey/feasibility cue
  if (
    /\b(dry\s*eye|dme|wet\s*amd|geographic\s+atrophy|\bga\b|presbyopia|prk|stargardt|usher|glaucoma|naion)\b/i.test(q) &&
    /\b(survey|feasibility|question|site\s+answer|enroll(?:ment)?\s+capacity)\b/i.test(q)
  ) {
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
      "Artemis feasibility export in Cosmos (feasibility_*). Always read context.feasibilityArtemis.catalog first (survey titles, indications, question keywords/themes). Sites often appear twice (PI-named vs practice) — use match.canonical. Search questions with catalog.questionKeywords / questionThemes.",
    query: {
      siteHint: siteHint || null,
      questionHint: questionHint || null,
      indication,
      wantMatch,
      wantQuestions
    },
    catalog: null,
    sites: null,
    questions: null,
    answers: null,
    match: null
  };

  try {
    const sites = await loadAllSites(database);
    const defs = await loadAllDefs(database);
    out.catalog = buildFeasibilityCatalog(defs, sites);
    out.inventory = {
      sites: sites.length,
      surveyDefinitions: defs.length,
      note: "Loaded from feasibility_sites + feasibility_survey_definitions"
    };
    // Keep Data Lens Cosmos snapshot warm whenever Buddy builds the pack
    try {
      await persistFeasibilityCatalog(() => database, out.catalog);
      out.catalogPersistedAt = new Date().toISOString();
    } catch (_) {
      /* non-fatal */
    }

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
      out.inventory.surveyDefinitions = defs.length;
      const qNeedle =
        questionHint ||
        (/\b(enroll|capacity|patient|screen|recruit|coordinator|investigator|pi experience|oct|bcva|equipment|freezer|irb|pharmacy)\b/i.test(
          question
        )
          ? question.match(
              /\b(enroll\w*|capacity|patient\w*|screen\w*|recruit\w*|coordinator\w*|investigator\w*|oct|bcva|equipment|freezer|irb|pharmacy)\b/i
            )?.[1]
          : null);
      // Prefer explicit question hint; else theme keyword; else don't force "enroll"
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
        const byId = new Map(sites.map((s) => [s.siteId || s.id, s.siteName]));
        for (const a of out.answers || []) {
          a.siteName = byId.get(a.siteId) || a.displayName || null;
        }
      } else {
        // Point Buddy at catalog instead of dumping raw defs again
        out.questions = (out.catalog?.surveys || []).slice(0, 12).map((d) => ({
          surveyId: d.surveyId,
          surveyTitle: d.title,
          indication: d.indication,
          questionCount: d.questionCount,
          responseCount: d.responseCount,
          topKeywords: d.topKeywords,
          sampleQuestions: (d.sampleQuestions || []).slice(0, 6).map((label) => ({ label }))
        }));
      }
    }

    return out;
  } catch (err) {
    return { ...out, error: String(err.message || err) };
  }
}

/**
 * Persist catalog snapshot for Data Lens / SQL readers (same facts Buddy uses).
 * Container: feasibility_survey_definitions, id feasibility_pack_meta (partition /id).
 */
async function persistFeasibilityCatalog(getDb, catalog) {
  const database = getDb();
  const now = new Date().toISOString();
  const doc = {
    id: "feasibility_pack_meta",
    docType: "feasibilityCatalogSnapshot",
    dataset: DATASET,
    schemaVersion: 2,
    source: "ora-buddy-api",
    audience: ["buddy", "data_lens"],
    updatedAt: now,
    catalog
  };
  await database.container(DEFS).items.upsert(doc);
  try {
    await database.containers.createIfNotExists({
      id: "syncState",
      partitionKey: { paths: ["/id"] }
    });
    await database.container("syncState").items.upsert({
      id: "feasibility_catalog",
      docType: "sync_state",
      lastSuccessfulSync: now,
      lastRunAt: now,
      surveyCount: catalog?.surveyCount ?? null,
      note: "Artemis feasibility catalog snapshot for Buddy + Data Lens"
    });
  } catch (_) {
    /* optional */
  }
  return doc;
}

async function loadPersistedFeasibilityCatalog(getDb) {
  try {
    const database = getDb();
    const { resource } = await database
      .container(DEFS)
      .item("feasibility_pack_meta", "feasibility_pack_meta")
      .read();
    if (resource?.catalog) return resource;
  } catch (_) {
    /* miss */
  }
  return null;
}

/**
 * Full pack for Data Lens / HTTP: catalog (+ optional search). Always refreshes catalog snapshot.
 */
async function buildFeasibilityLensPack(getDb, opts = {}) {
  const pack = await buildFeasibilityArtemisContext(getDb, {
    question: opts.question || "feasibility catalog for Data Lens",
    siteName: opts.siteName || null,
    questionHint: opts.questionHint || null,
    indication: opts.indication || null,
    includeMatch: opts.includeMatch !== false,
    includeQuestions: true
  });
  if (pack?.catalog && !pack.error) {
    try {
      await persistFeasibilityCatalog(getDb, pack.catalog);
      pack.catalogPersistedAt = new Date().toISOString();
    } catch (err) {
      pack.catalogPersistError = String(err.message || err).slice(0, 200);
    }
  }
  return {
    ...pack,
    audience: "data_lens",
    note:
      (pack.note || "") +
      " Data Lens: prefer catalog (survey titles, indications, questionKeywords, questionThemes). Same Cosmos as Buddy; do not call /api/ask."
  };
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
  buildFeasibilityCatalog,
  buildFeasibilityArtemisContext,
  buildFeasibilityLensPack,
  persistFeasibilityCatalog,
  loadPersistedFeasibilityCatalog,
  normalizeSiteName,
  normalizePi
};
