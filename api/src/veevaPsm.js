/**
 * Shared Veeva PSM helpers — site_psm = enrolled / months(FSI→LSI), min 1 month.
 */

function picklistLabel(v) {
  if (v == null || v === "") return null;
  if (typeof v === "object") {
    return v.label || v.name || v.value || null;
  }
  const s = String(v).trim();
  if (!s) return null;
  // dry_eye__c → dry eye → title-ish handled by vaultIndicationLabel callers
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
 * Months of active enrollment FSI → LSI.
 * Same calendar month (or < 1 month) → 1 (never divide by zero).
 */
function siteEnrollMonthsFromFsiLsi(fsiIso, lsiIso) {
  if (!fsiIso || !lsiIso) return null;
  const a = Date.parse(fsiIso);
  const b = Date.parse(lsiIso);
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

/** site_psm = total_enrolled / site_enroll_months (Patients per Site per Month). */
function computeSitePsm(totalEnrolled, enrollMonths) {
  const n = Number(totalEnrolled);
  const m = Number(enrollMonths);
  if (!(n >= 0) || !(m > 0)) return null;
  if (n === 0) return 0;
  return Math.round((n / m) * 1000) / 1000;
}

function classifyEnrollmentMilestone(name, type) {
  const s = `${name || ""} ${type || ""}`.toLowerCase();
  // LSO is last subject OUT — not LSI / LPFV
  if (/\blso\b|last subject out|last patient out/.test(s)) return null;
  if (/\blsi\b|last subject in|last patient in|lpfv/.test(s)) return "lsi";
  if (/\bfsi\b|\bfpi\b|fpfv|first subject|first patient/.test(s)) return "fsi";
  return null;
}

module.exports = {
  picklistLabel,
  vaultIndicationLabel,
  siteEnrollMonthsFromFsiLsi,
  computeSitePsm,
  classifyEnrollmentMilestone
};
