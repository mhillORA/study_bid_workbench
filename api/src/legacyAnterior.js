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
    /\b(site trust|trusted sites?|relationship preference|preferred sites?)\b/.test(q) ||
    /\b(advantages|disadvantages|relationship notes)\b/.test(q) ||
    /\b(which sites?).{0,40}\b(trust|prefer|perform|enroll|feasib)/.test(q) ||
    /\b(site|sites?).{0,30}\b(feasib|histor|legacy|anterior|scheduled|screened|enrolled)\b/.test(q) ||
    /\b(pi|principal investigator).{0,40}\b(site|study|enroll)/.test(q) ||
    /\b(target scheduled|lplv|visit ?1)\b/.test(q)
  );
}

/** Pull a quoted name or "site X" / "study X" phrase. */
function extractLegacyNameHints(question) {
  const q = String(question || "");
  const out = { siteName: null, studyName: null, siteId: null, studyId: null };
  const quoted = [...q.matchAll(/"([^"]{2,80})"|'([^']{2,80})'/g)].map((m) => m[1] || m[2]);
  const siteM = q.match(/\bsite\s+(?:named\s+|called\s+)?["']?([A-Za-z0-9][\w .,&'\-/]{2,60})["']?/i);
  const studyM = q.match(/\bstudy\s+(?:named\s+|called\s+)?["']?([A-Za-z0-9][\w .,&'\-/]{2,60})["']?/i);
  if (siteM) out.siteName = siteM[1].trim().replace(/[?.!,;:]+$/, "");
  if (studyM) out.studyName = studyM[1].trim().replace(/[?.!,;:]+$/, "");
  if (!out.siteName && quoted[0] && /\bsite\b/i.test(q)) out.siteName = quoted[0].trim();
  if (!out.studyName && quoted[0] && /\bstudy\b/i.test(q)) out.studyName = quoted[0].trim();
  if (!out.siteName && !out.studyName && quoted[0]) {
    // Ambiguous quote — try as site first (trust asks are usually site-centric)
    out.siteName = quoted[0].trim();
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
    const rows = await queryAll(
      container,
      `SELECT TOP @lim * FROM c WHERE c.docType = @t AND (
         CONTAINS(LOWER(c.siteName), LOWER(@n)) OR
         CONTAINS(LOWER(c.name), LOWER(@n)) OR
         CONTAINS(LOWER(c.siteCode), LOWER(@n))
       )`,
      [
        { name: "@t", value: DOC_SITE },
        { name: "@n", value: needle },
        { name: "@lim", value: limit }
      ]
    );
    return rows;
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
    return queryAll(
      container,
      `SELECT TOP @lim * FROM c WHERE c.docType = @t AND (
         CONTAINS(LOWER(c.studyName), LOWER(@n)) OR
         CONTAINS(LOWER(c.name), LOWER(@n)) OR
         CONTAINS(LOWER(c.title), LOWER(@n))
       )`,
      [
        { name: "@t", value: DOC_STUDY },
        { name: "@n", value: needle },
        { name: "@lim", value: limit }
      ]
    );
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
 * @param {{ question?: string, siteName?: string, studyName?: string, siteId?: string, studyId?: string, force?: boolean }} opts
 */
async function buildLegacyAnteriorContext(getDb, opts = {}) {
  const question = String(opts.question || "");
  const hints = extractLegacyNameHints(question);
  const siteName = opts.siteName || hints.siteName || null;
  const studyName = opts.studyName || hints.studyName || null;
  const siteId = opts.siteId || hints.siteId || null;
  const studyId = opts.studyId || hints.studyId || null;
  const intent = isLegacyAnteriorQuestion(question);
  const named = Boolean(siteName || studyName || siteId || studyId);

  if (!opts.force && !intent && !named) {
    return null;
  }

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
      "Legacy anterior-segment overview (Excel import). Separate from Ora Veeva / TrialHub / budget studies. Use for historical site trust and enrollment feasibility. Null metrics mean missing — never treat as zero.",
    query: { siteName, studyName, siteId, studyId, intent },
    sites: null,
    studies: null,
    siteOutcomes: null,
    studyOutcomes: null,
    trust: null
  };

  try {
    const siteRows = await findSites(database, {
      siteId,
      siteName,
      limit: named ? 10 : 20
    });
    out.sites = {
      matched: siteRows.length,
      items: siteRows.map(slimSite).slice(0, 15)
    };
    out.trust = trustRollup(siteRows);

    // Outcomes for best-matched site (PK /siteId)
    const primarySite = siteRows[0];
    if (primarySite && (named || intent)) {
      const sid = primarySite.siteId || primarySite.id;
      const oc = await outcomesForSite(database, sid, 50);
      out.siteOutcomes = {
        siteId: sid,
        siteName: primarySite.siteName || primarySite.name,
        ...summarizeOutcomes(oc)
      };
    }

    const studyRows = await findStudies(database, {
      studyId,
      studyName,
      limit: named ? 10 : 15
    });
    out.studies = {
      matched: studyRows.length,
      items: studyRows.map(slimStudy).slice(0, 12)
    };

    const primaryStudy = studyRows[0];
    if (primaryStudy && (studyName || studyId || (intent && named))) {
      const stid = primaryStudy.studyId || primaryStudy.id;
      const oc = await outcomesForStudy(database, stid, 50);
      out.studyOutcomes = {
        studyId: stid,
        studyName: primaryStudy.studyName || primaryStudy.name || primaryStudy.title,
        ...summarizeOutcomes(oc)
      };
    }

    // Counts for citation
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

module.exports = {
  DATASET,
  isLegacyAnteriorQuestion,
  extractLegacyNameHints,
  buildLegacyAnteriorContext
};
