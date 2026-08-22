/**
 * Buddy feasibility from live Vault mirrors (ora_veeva_*), not ora_fact_*.
 * Site PSM = enrolled / months(FPFV → LPFV from milestone__v), min 1 month.
 */

const {
  vaultIndicationLabel,
  picklistLabel,
  siteEnrollMonthsFromFpfvLpfv,
  computeSitePsm,
  classifyPsmWindowMilestone
} = require("./veevaPsm");

async function queryAll(container, query, parameters = []) {
  const { resources } = await container.items
    .query({ query, parameters }, { enableCrossPartitionQuery: true })
    .fetchAll();
  return resources || [];
}

function round(n, d = 3) {
  if (n == null || Number.isNaN(Number(n))) return null;
  const f = 10 ** d;
  return Math.round(Number(n) * f) / f;
}

function median(nums) {
  const a = nums.filter((n) => typeof n === "number" && !Number.isNaN(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function isEnrolledSubjectStatus(statusRaw) {
  const status = String(statusRaw || "").toLowerCase();
  if (/\bscreen\s*fail|withdrawn|discontinued|not enrolled\b/.test(status)) return false;
  return true;
}

/** Vault country__v ids look like 00C000000000228 — not display names. */
function looksLikeVaultCountryId(raw) {
  return /^00C[0-9A-Z]{12,}$/i.test(String(raw || "").trim());
}

/** Normalize Vault country picklist / id residue → display name. */
function prettyCountryName(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s || looksLikeVaultCountryId(s)) return null;
  // Multi-country study lists are not a site country
  if (s.includes(";")) return null;
  // united_states__c / United_States__C → united states
  s = s
    .replace(/__/g, " ")
    .replace(/_/g, " ")
    .replace(/\s+c\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  const key = s.toLowerCase();
  const aliases = {
    "united states": "United States",
    us: "United States",
    usa: "United States",
    "u s": "United States",
    "u s a": "United States",
    "united kingdom": "United Kingdom",
    uk: "United Kingdom",
    "great britain": "United Kingdom",
    "czech republic": "Czech Republic",
    korea: "South Korea",
    "south korea": "South Korea",
    "hong kong": "Hong Kong"
  };
  if (aliases[key]) return aliases[key];
  // Title-case plain words
  if (/^[a-z ]+$/i.test(s) && s.length >= 3 && s.length <= 40) {
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return s;
}

/**
 * Resolve Vault country__v object ids → human country names.
 * Prefer ora_veeva_country (if synced); else majority-vote study.country__c via site.study__v;
 * else heuristic from study_country__v name__v (…USA… / United Kingdom…).
 */
async function loadCountryNameById(database) {
  const map = new Map();
  try {
    const rows = await queryAll(
      database.container("ora_veeva_country"),
      `SELECT c.id, c.name__v, c.abbreviation__v FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_veeva_country" }]
    );
    for (const r of rows) {
      const name = prettyCountryName(r.name__v) || String(r.name__v || "").trim();
      if (r.id && name && !looksLikeVaultCountryId(name)) map.set(r.id, name);
    }
  } catch (_) {
    /* optional until country__v ingest */
  }
  if (map.size > 0) return map;

  const votes = new Map(); // id → Map<label, n>
  const bump = (id, label) => {
    const pretty = prettyCountryName(label);
    if (!id || !pretty) return;
    if (!votes.has(id)) votes.set(id, new Map());
    const m = votes.get(id);
    m.set(pretty, (m.get(pretty) || 0) + 1);
  };

  try {
    const studies = await queryAll(
      database.container("ora_veeva_study"),
      `SELECT c.id, c.country__c FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_veeva_study" }]
    );
    const studyCountry = new Map();
    for (const s of studies) {
      const label = prettyCountryName(s.country__c);
      if (label) studyCountry.set(s.id, label);
    }
    const sites = await queryAll(
      database.container("ora_veeva_site"),
      `SELECT c.country__v, c.study__v FROM c WHERE c.docType = @t AND IS_DEFINED(c.country__v)`,
      [{ name: "@t", value: "ora_veeva_site" }]
    );
    for (const site of sites) {
      const label = studyCountry.get(site.study__v);
      if (label) bump(site.country__v, label);
    }
  } catch (_) {
    /* optional */
  }

  try {
    const sc = await queryAll(
      database.container("ora_veeva_study_country"),
      `SELECT c.country__v, c.name__v FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_veeva_study_country" }]
    );
    for (const row of sc) {
      const n = String(row.name__v || "");
      let guess = null;
      if (/\b(USA|U\.S\.A\.|United States)\b/i.test(n)) guess = "United States";
      else if (/\b(UK|U\.K\.|United Kingdom|Britain)\b/i.test(n)) guess = "United Kingdom";
      else if (/\bCanada\b/i.test(n)) guess = "Canada";
      else if (/\bGermany\b/i.test(n)) guess = "Germany";
      else if (/\bFrance\b/i.test(n)) guess = "France";
      else if (/\bJapan\b/i.test(n)) guess = "Japan";
      else if (/\bChina\b/i.test(n)) guess = "China";
      else if (/\bAustralia\b/i.test(n)) guess = "Australia";
      else if (/\bSpain\b/i.test(n)) guess = "Spain";
      else if (/\bItaly\b/i.test(n)) guess = "Italy";
      else if (/\bPoland\b/i.test(n)) guess = "Poland";
      else if (/\bIndia\b/i.test(n)) guess = "India";
      if (guess) bump(row.country__v, guess);
    }
  } catch (_) {
    /* optional */
  }

  for (const [id, labelCounts] of votes.entries()) {
    let best = null;
    let bestN = 0;
    for (const [label, n] of labelCounts.entries()) {
      if (n > bestN) {
        best = label;
        bestN = n;
      }
    }
    if (best) map.set(id, best);
  }
  return map;
}

function resolveCountryLabel(raw, countryNameById) {
  if (!raw) return "_unknown";
  const s = String(raw).trim();
  if (!s) return "_unknown";
  if (countryNameById && countryNameById.has(s)) {
    return prettyCountryName(countryNameById.get(s)) || countryNameById.get(s);
  }
  const direct = prettyCountryName(s);
  if (direct) return direct;
  if (looksLikeVaultCountryId(s)) return "Unknown country";
  return s;
}

function isTotalEnrolledMetricName(name) {
  return /total enrolled|subjects enrolled|patients enrolled|enrollment count/.test(
    String(name || "").toLowerCase()
  );
}

function isEnrollmentRateMetricName(name) {
  return /enrol(?:l)?ment rate|subjects per month|patients per month/.test(
    String(name || "").toLowerCase()
  );
}

/** Site-level Total Enrolled from ora_veeva_metric when subject rows lack site__v. */
async function loadEnrolledFromMetrics(database) {
  const bySite = new Map();
  const byStudy = new Map();
  try {
    const rows = await queryAll(
      database.container("ora_veeva_metric"),
      `SELECT c.site__v, c.study__v, c.name__v, c.actual__v, c.planned__v
       FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_veeva_metric" }]
    );
    for (const row of rows) {
      const actual = row.actual__v != null ? Number(row.actual__v) : null;
      const planned = row.planned__v != null ? Number(row.planned__v) : null;
      const val = Number.isFinite(actual) ? actual : Number.isFinite(planned) ? planned : null;
      if (val == null || val < 0) continue;
      const name = row.name__v;
      if (isTotalEnrolledMetricName(name)) {
        if (row.site__v) {
          bySite.set(row.site__v, { enrolled: val, source: "ora_veeva_metric.total_enrolled" });
        } else if (row.study__v) {
          byStudy.set(row.study__v, { enrolled: val, source: "ora_veeva_metric.study_total_enrolled" });
        }
      }
    }
  } catch (_) {
    /* optional */
  }
  return { bySite, byStudy };
}

/**
 * When site enrolled is missing but study.enrollment__vs exists, split across sites
 * on that study with FPFV+LPFV milestone window (approximate per-site enrolled).
 */
function allocateStudyEnrollmentToSites(sites, studyById) {
  const eligibleByStudy = new Map();
  for (const row of sites) {
    if (row.total_enrolled != null) continue;
    if (!(row.site_enroll_months > 0) || !row.veeva_study_id) continue;
    if (!eligibleByStudy.has(row.veeva_study_id)) eligibleByStudy.set(row.veeva_study_id, []);
    eligibleByStudy.get(row.veeva_study_id).push(row);
  }
  for (const [studyId, rows] of eligibleByStudy.entries()) {
    const study = studyById.get(studyId);
    const total = study?.total_enrolled;
    if (!(total > 0) || !rows.length) continue;
    const perSite = total / rows.length;
    for (const row of rows) {
      row.total_enrolled = round(perSite, 2);
      row.enrolled_source = "study.enrollment__vs/shared_fpfv_lpfv_sites";
      row.site_psm = computeSitePsm(row.total_enrolled, row.site_enroll_months);
      row.site_psm = row.site_psm != null ? round(row.site_psm) : null;
      row.psm_zero_enrolled = row.site_psm === 0;
    }
  }
}

/**
 * Load ora_veeva_* and compute site/study PSM from milestones.
 * Returns normalized rows shaped like the old fact pack (org_clean, site_psm, …).
 */
async function loadVeevaLiveFeasibility(database) {
  const studyRows = await queryAll(
    database.container("ora_veeva_study"),
    `SELECT c.id, c.name__v, c.alternate_study_number__vs, c.study_name__v, c.sponsor__c,
            c.sponsor_organization__v, c.indication__v, c.indication__c, c.study_phase__v,
            c.status__v, c.study_status__v, c.enrollment__vs, c.number_of_sites__c, c.country__c
     FROM c WHERE c.docType = @t`,
    [{ name: "@t", value: "ora_veeva_study" }]
  );

  const siteRows = await queryAll(
    database.container("ora_veeva_site"),
    `SELECT c.id, c.study__v, c.no_subjects_enrolled__v, c.name__v, c.site_name__v,
            c.organization__clin, c.country__v, c.study_name__v, c.study_number__v,
            c.indication__c, c.study_phase__c
     FROM c WHERE c.docType = @t`,
    [{ name: "@t", value: "ora_veeva_site" }]
  );

  const orgNameById = new Map();
  try {
    const orgs = await queryAll(
      database.container("ora_veeva_organization"),
      `SELECT c.id, c.name__v, c.full_name__v FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_veeva_organization" }]
    );
    for (const o of orgs) orgNameById.set(o.id, o.full_name__v || o.name__v || null);
  } catch (_) {
    /* optional */
  }

  const countryNameById = await loadCountryNameById(database);

  const sponsorNameById = new Map();
  try {
    const sponsors = await queryAll(
      database.container("ora_veeva_sponsor"),
      `SELECT c.id, c.name__v FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_veeva_sponsor" }]
    );
    for (const s of sponsors) sponsorNameById.set(s.id, s.name__v || null);
  } catch (_) {
    /* optional */
  }

  const enrolledBySite = new Map();
  try {
    const subjects = await queryAll(
      database.container("ora_veeva_subject"),
      `SELECT c.site__v, c.subject_status__v, c.status__v
       FROM c WHERE c.docType = @t AND IS_DEFINED(c.site__v) AND c.site__v != null`,
      [{ name: "@t", value: "ora_veeva_subject" }]
    );
    for (const sub of subjects) {
      if (!isEnrolledSubjectStatus(`${sub.subject_status__v || ""} ${sub.status__v || ""}`)) continue;
      enrolledBySite.set(sub.site__v, (enrolledBySite.get(sub.site__v) || 0) + 1);
    }
  } catch (_) {
    /* optional */
  }

  const metricEnrolled = await loadEnrolledFromMetrics(database);

  const datesBySite = new Map();
  try {
    const ms = await queryAll(
      database.container("ora_veeva_milestone"),
      `SELECT c.site__v, c.study__v, c.name__v, c.milestone_type__v,
              c.actual_finish_date__v, c.actual_start_date__v
       FROM c WHERE c.docType = @t AND IS_DEFINED(c.site__v) AND c.site__v != null`,
      [{ name: "@t", value: "ora_veeva_milestone" }]
    );
    for (const m of ms) {
      const kind = classifyPsmWindowMilestone(m.name__v, m.milestone_type__v);
      if (!kind) continue;
      const when = m.actual_finish_date__v || m.actual_start_date__v;
      if (!when) continue;
      if (!datesBySite.has(m.site__v)) datesBySite.set(m.site__v, {});
      const pack = datesBySite.get(m.site__v);
      if (kind === "fpfv") {
        if (!pack.fpfv || Date.parse(when) < Date.parse(pack.fpfv)) pack.fpfv = when;
      } else if (kind === "lpfv") {
        if (!pack.lpfv || Date.parse(when) > Date.parse(pack.lpfv)) pack.lpfv = when;
      }
    }
  } catch (_) {
    /* milestones required for PSM — empty → null PSM */
  }

  const studyById = new Map();
  for (const s of studyRows) {
    const indicationRaw = s.indication__v || s.indication__c || null;
    const indication = indicationRaw ? vaultIndicationLabel(indicationRaw) : "_unknown";
    const study_number = s.alternate_study_number__vs || s.name__v || s.id;
    studyById.set(s.id, {
      id: s.id,
      study_number,
      sponsor:
        (s.sponsor__c && sponsorNameById.get(s.sponsor__c)) || s.sponsor_organization__v || null,
      indication: indication || "_unknown",
      indication_picklist: indicationRaw ? String(indicationRaw) : null,
      phase: picklistLabel(s.study_phase__v) || null,
      lifecycle_state: picklistLabel(s.status__v || s.study_status__v) || null,
      total_enrolled: s.enrollment__vs != null ? Number(s.enrollment__vs) : null,
      n_contributing_sites: s.number_of_sites__c != null ? Number(s.number_of_sites__c) : null,
      countries: s.country__c || null,
      source: "ora_veeva_study",
      psm: null
    });
  }

  const sites = [];
  const sitePsmsByStudy = new Map();
  for (const site of siteRows) {
    const study = site.study__v ? studyById.get(site.study__v) : null;
    const fromSite = site.indication__c ? vaultIndicationLabel(site.indication__c) : null;
    const indication = fromSite || study?.indication || "_unknown";
    const org =
      (site.organization__clin && orgNameById.get(site.organization__clin)) ||
      site.site_name__v ||
      site.name__v ||
      null;
    if (!org) continue;

    const dates = datesBySite.get(site.id) || {};
    const months = siteEnrollMonthsFromFpfvLpfv(dates.fpfv, dates.lpfv);
    let enrolled =
      site.no_subjects_enrolled__v != null ? Number(site.no_subjects_enrolled__v) : null;
    let enrolledSource = enrolled != null ? "site.no_subjects_enrolled__v" : null;
    if (enrolled == null && enrolledBySite.has(site.id)) {
      enrolled = enrolledBySite.get(site.id);
      enrolledSource = "ora_veeva_subject_count";
    }
    if (enrolled == null && metricEnrolled.bySite.has(site.id)) {
      const pack = metricEnrolled.bySite.get(site.id);
      enrolled = pack.enrolled;
      enrolledSource = pack.source;
    }
    let site_psm = months != null && enrolled != null ? computeSitePsm(enrolled, months) : null;

    const row = {
      veeva_site_id: site.id,
      veeva_study_id: site.study__v || null,
      org_clean: org,
      organization: org,
      country: resolveCountryLabel(site.country__v, countryNameById),
      country_id: site.country__v || null,
      indication,
      phase: picklistLabel(site.study_phase__c) || study?.phase || null,
      lifecycle_state: study?.lifecycle_state || null,
      site_psm: site_psm != null ? round(site_psm) : null,
      psm_zero_enrolled: site_psm === 0,
      total_enrolled: enrolled,
      enrolled_source: enrolledSource,
      site_enroll_months: months,
      fpfv_date: dates.fpfv || null,
      lpfv_date: dates.lpfv || null,
      enroll_window_trust:
        dates.fpfv && dates.lpfv ? "high" : dates.fpfv || dates.lpfv ? "partial" : null,
      fsi_trust:
        dates.fpfv && dates.lpfv ? "high" : dates.fpfv || dates.lpfv ? "partial" : null,
      study_name: site.study_name__v || site.study_number__v || study?.study_number || null,
      source: "ora_veeva_site",
      psm_formula:
        "total_enrolled / months(FPFV→LPFV from ora_veeva_milestone; First/Last Subject First Visit only, min 1 month)"
    };
    sites.push(row);

    if (site.study__v && typeof site_psm === "number" && site_psm > 0) {
      if (!sitePsmsByStudy.has(site.study__v)) sitePsmsByStudy.set(site.study__v, []);
      sitePsmsByStudy.get(site.study__v).push(site_psm);
    }
  }

  allocateStudyEnrollmentToSites(sites, studyById);

  // Rebuild study PSM rollups after enrollment fallbacks
  sitePsmsByStudy.clear();
  for (const row of sites) {
    if (row.veeva_study_id && typeof row.site_psm === "number" && row.site_psm > 0) {
      if (!sitePsmsByStudy.has(row.veeva_study_id)) sitePsmsByStudy.set(row.veeva_study_id, []);
      sitePsmsByStudy.get(row.veeva_study_id).push(row.site_psm);
    }
  }

  const studies = [];
  for (const [id, st] of studyById.entries()) {
    const psms = sitePsmsByStudy.get(id) || [];
    const psm = psms.length ? round(median(psms)) : null;
    studies.push({
      ...st,
      psm,
      psm_source: psms.length ? "median_site_psm_fpfv_lpfv" : null,
      sites_with_psm: psms.length
    });
  }

  return {
    source: "ora_veeva",
    studyCount: studies.length,
    siteCount: sites.length,
    sitesWithPsm: sites.filter((s) => typeof s.site_psm === "number" && s.site_psm > 0).length,
    studiesWithPsm: studies.filter((s) => typeof s.psm === "number" && s.psm > 0).length,
    studies,
    sites,
      note:
      "Live Vault mirrors. Site PSM = enrolled / months(FPFV→LPFV visit milestones only — not FSI/LSI). When site enrolled is missing, falls back to study.enrollment__vs split across FPFV+LPFV sites. Cosmos currently has fsi__ctms/lsi__ctms (Subject In) — need First Subject First Visit milestones in Veeva for PSM."
  };
}

function classifyStartupMilestoneKey(name, type) {
  const s = `${name || ""} ${type || ""}`.toLowerCase();
  if (/\bsiv\b|site initiated|ir_site_initiated|first study site initiated/.test(s)) return "siv";
  if (/\bfsi\b|\bfpi\b|first subject|first patient|ready to enroll/.test(s)) return "fsi";
  if (/\birb\b|ethics|ec approval|irb submission|irb approv/.test(s)) return "irb";
  if (/cta signed|contract|site financial|financial docs/.test(s)) return "contract";
  if (/site selected|selected_site|site selection/.test(s)) return "selected";
  return null;
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.round((db - da) / 86400000);
}

/**
 * Startup gap rows from live ora_veeva_milestone (+ site/org names).
 * Same shape as wide ora_veeva_milestones docs — used by Buddy startupTimelines.
 */
async function loadVeevaStartupGapRows(database) {
  const siteRows = await queryAll(
    database.container("ora_veeva_site"),
    `SELECT c.id, c.name__v, c.site_name__v, c.study__v, c.study_name__v, c.organization__clin, c.country__v
     FROM c WHERE c.docType = @t`,
    [{ name: "@t", value: "ora_veeva_site" }]
  );
  const orgName = new Map();
  try {
    const orgRows = await queryAll(
      database.container("ora_veeva_organization"),
      `SELECT c.id, c.name__v, c.full_name__v FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_veeva_organization" }]
    );
    for (const o of orgRows) orgName.set(o.id, o.full_name__v || o.name__v);
  } catch (_) {
    /* optional */
  }
  const countryNameById = await loadCountryNameById(database);
  const siteById = new Map(siteRows.map((s) => [s.id, s]));

  const ms = await queryAll(
    database.container("ora_veeva_milestone"),
    `SELECT c.site__v, c.study__v, c.name__v, c.milestone_type__v,
            c.actual_finish_date__v, c.actual_start_date__v, c.planned_finish_date__v
     FROM c WHERE c.docType = @t AND IS_DEFINED(c.site__v) AND c.site__v != null`,
    [{ name: "@t", value: "ora_veeva_milestone" }]
  );

  const bySiteStudy = new Map();
  for (const m of ms) {
    const site = siteById.get(m.site__v);
    if (!site) continue;
    const key = `${m.site__v}|${m.study__v || site.study__v || ""}`;
    if (!bySiteStudy.has(key)) {
      const org =
        (site.organization__clin && orgName.get(site.organization__clin)) ||
        site.site_name__v ||
        site.name__v ||
        null;
      bySiteStudy.set(key, {
        organization: org,
        study_name: site.study_name__v || site.study__v || m.study__v,
        country: resolveCountryLabel(site.country__v, countryNameById),
        country_id: site.country__v || null,
        dates: {},
        source: "ora_veeva_milestone"
      });
    }
    const pack = bySiteStudy.get(key);
    const kind = classifyStartupMilestoneKey(m.name__v, m.milestone_type__v);
    const when = m.actual_finish_date__v || m.actual_start_date__v || m.planned_finish_date__v;
    if (kind && when && !pack.dates[kind]) pack.dates[kind] = when;
  }

  const rows = [];
  for (const pack of bySiteStudy.values()) {
    if (!pack.organization) continue;
    const d = pack.dates;
    const gaps_days = {
      selected_to_contract: daysBetween(d.selected, d.contract),
      contract_to_irb: daysBetween(d.contract, d.irb),
      irb_to_siv: daysBetween(d.irb, d.siv),
      siv_to_fsi: daysBetween(d.siv, d.fsi),
      contract_to_siv: daysBetween(d.contract, d.siv),
      contract_to_fsi: daysBetween(d.contract, d.fsi)
    };
    const hasGap = Object.values(gaps_days).some((n) => typeof n === "number");
    if (!hasGap && Object.keys(d).length < 2) continue;
    const year = Object.values(d)
      .map((x) => String(x || "").slice(0, 4))
      .find((y) => /^20\d{2}$/.test(y));
    rows.push({
      organization: pack.organization,
      study_name: pack.study_name,
      country: pack.country,
      dates: d,
      gaps_days,
      activity_2023_plus: !year || Number(year) >= 2023,
      outlier_gap_gt_730: Object.values(gaps_days).some((n) => typeof n === "number" && n > 730),
      source: "ora_veeva_milestone"
    });
  }
  return rows;
}

module.exports = {
  loadVeevaLiveFeasibility,
  loadVeevaStartupGapRows,
  loadCountryNameById,
  resolveCountryLabel,
  looksLikeVaultCountryId,
  round,
  median
};
