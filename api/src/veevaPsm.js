/**
 * Shared Veeva PSM helpers — site_psm = enrolled / months(FPFV→LPFV), min 1 month.
 * PSM uses visit milestones only (First/Last Patient/Subject First Visit).
 * FSI / LSI / First Subject In / Last Subject In are NOT used for PSM (startup may still use FSI elsewhere).
 */

function picklistLabel(v) {
  if (v == null || v === "") return null;
  if (typeof v === "object") {
    return v.label || v.name || v.value || null;
  }
  const s = String(v).trim();
  if (!s) return null;
  return s;
}

/**
 * Vault Indication picklist → canonical Ora label (dry_eye__c → Dry Eye).
 * Lazy-require intelligence to avoid circular load with veevaLiveIntel.
 */
function vaultIndicationLabel(raw) {
  if (raw == null || raw === "") return "_unknown";
  try {
    const { canonicalIndicationFromVaultPicklist } = require("./intelligence");
    return canonicalIndicationFromVaultPicklist(raw);
  } catch (_) {
    let s = picklistLabel(raw) || String(raw);
    s = String(s).replace(/__c$/i, "").replace(/__v$/i, "").replace(/_/g, " ").trim();
    if (!s) return "_unknown";
    return s
      .split(/\s+/)
      .map((w) => (w.length ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
      .join(" ");
  }
}

/**
 * Months of active enrollment FPFV → LPFV.
 * Same calendar month (or < 1 month) → 1 (never divide by zero).
 */
function siteEnrollMonthsFromFpfvLpfv(fpfvIso, lpfvIso) {
  if (!fpfvIso || !lpfvIso) return null;
  const a = Date.parse(fpfvIso);
  const b = Date.parse(lpfvIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  const d0 = new Date(start);
  const d1 = new Date(end);
  let months =
    (d1.getUTCFullYear() - d0.getUTCFullYear()) * 12 + (d1.getUTCMonth() - d0.getUTCMonth());
  if (months < 1) return 1;
  return months;
}

/** @deprecated use siteEnrollMonthsFromFpfvLpfv — name kept for startup helpers */
const siteEnrollMonthsFromFsiLsi = siteEnrollMonthsFromFpfvLpfv;

/** site_psm = total_enrolled / site_enroll_months (Patients per Site per Month). */
function computeSitePsm(totalEnrolled, enrollMonths) {
  const n = Number(totalEnrolled);
  const m = Number(enrollMonths);
  if (!(n >= 0) || !(m > 0)) return null;
  if (n === 0) return 0;
  return Math.round((n / m) * 1000) / 1000;
}

/** Vault report labels — first/last *first visit* only (not Subject In). */
const PSM_WINDOW_START_LABELS = new Set([
  "first subject first visit in",
  "first patient first visit in"
]);

const PSM_WINDOW_END_LABELS = new Set([
  "last subject first visit in",
  "last patient first visit in"
]);

function milestoneBlob(name, type) {
  const typeLabel = (picklistLabel(type) || String(type || "")).toLowerCase();
  const nameLabel = String(name || "").toLowerCase();
  return `${nameLabel} ${typeLabel}`.replace(/[_\s]+/g, " ").trim();
}

function isPlainSubjectInMilestone(raw) {
  return (
    /(?:^|\s)fsi(?:__|\s|$)|(?:^|\s)lsi(?:__|\s|$)|fsi__ctms|lsi__ctms/.test(raw) ||
    (/first subject in|last subject in|first patient in|last patient in|study fsi|study lsi/.test(raw) &&
      !/first visit/.test(raw))
  );
}

/**
 * Map ora_veeva_milestone row → PSM enrollment window edge.
 * Returns "fpfv" | "lpfv" | null. Does NOT treat FSI/LSI as FPFV/LPFV.
 */
function classifyPsmWindowMilestone(name, type) {
  const raw = `${name || ""} ${type || ""}`.toLowerCase();
  const blob = milestoneBlob(name, type);
  const typeOnly = (picklistLabel(type) || String(type || "")).toLowerCase().replace(/[_\s]+/g, " ").trim();

  if (/lso__|lplv__|last subject out|last patient out|last patient last visit/.test(raw)) {
    return null;
  }

  if (isPlainSubjectInMilestone(raw)) {
    return null;
  }

  if (
    PSM_WINDOW_END_LABELS.has(blob) ||
    PSM_WINDOW_END_LABELS.has(typeOnly) ||
    /lpfv__|(?:^|[\s_])lpfv(?:__|\s|$)|last subject first visit|last patient first visit/.test(raw)
  ) {
    return "lpfv";
  }

  if (
    PSM_WINDOW_START_LABELS.has(blob) ||
    PSM_WINDOW_START_LABELS.has(typeOnly) ||
    /fpfv__|(?:^|[\s_])fpfv(?:__|\s|$)|first subject first visit|first patient first visit/.test(raw)
  ) {
    return "fpfv";
  }

  return null;
}

/** @deprecated alias — PSM path should call classifyPsmWindowMilestone */
const classifyEnrollmentMilestone = classifyPsmWindowMilestone;

module.exports = {
  picklistLabel,
  vaultIndicationLabel,
  siteEnrollMonthsFromFpfvLpfv,
  siteEnrollMonthsFromFsiLsi,
  computeSitePsm,
  classifyPsmWindowMilestone,
  classifyEnrollmentMilestone
};
