/**
 * Match Entra display name / email to NetSuite project_manager (and later PD) strings.
 * Handles "Alexander Butler", "Butler, Alexander", alexander.butler@….
 */

function normalizePersonName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[.,'’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameTokens(s) {
  return normalizePersonName(s)
    .split(" ")
    .filter((t) => t.length > 1 && !/^(mr|ms|mrs|dr|jr|sr|ii|iii)$/.test(t));
}

/** Tokens from Entra principal (display name + email local-part). */
function viewerNameTokens(principal) {
  if (!principal) return [];
  const fromName = nameTokens(principal.displayName || "");
  const email = String(principal.email || "").trim();
  const local = email.includes("@") ? email.split("@")[0] : email;
  const fromEmail = nameTokens(local.replace(/[._+\-]+/g, " "));
  const set = new Set([...fromName, ...fromEmail]);
  return [...set];
}

/**
 * True when Entra viewer looks like the same person as a study role name (PM/PD).
 */
function personNamesMatch(viewerPrincipalOrName, roleName) {
  const roleTok = nameTokens(roleName);
  if (!roleTok.length) return false;

  let viewerTok;
  if (viewerPrincipalOrName && typeof viewerPrincipalOrName === "object") {
    viewerTok = viewerNameTokens(viewerPrincipalOrName);
  } else {
    viewerTok = nameTokens(viewerPrincipalOrName);
  }
  if (viewerTok.length < 1) return false;

  const roleSet = new Set(roleTok);
  const viewSet = new Set(viewerTok);

  if (viewerTok.every((t) => roleSet.has(t))) return true;
  if (roleTok.every((t) => viewSet.has(t))) return true;

  if (viewerTok.length >= 2 && roleTok.length >= 2) {
    const vLast = viewerTok[viewerTok.length - 1];
    const rLast = roleTok[roleTok.length - 1];
    const vFirst = viewerTok[0];
    const rFirst = roleTok[0];
    const roleHasLast = roleSet.has(vLast);
    const roleHasFirst =
      roleSet.has(vFirst) || [...roleSet].some((t) => t.startsWith(vFirst.slice(0, 3)));
    const viewHasLast = viewSet.has(rLast);
    const viewHasFirst =
      viewSet.has(rFirst) || [...viewSet].some((t) => t.startsWith(rFirst.slice(0, 3)));
    if (roleHasLast && roleHasFirst) return true;
    if (viewHasLast && viewHasFirst) return true;
  }

  return false;
}

/**
 * Match against PM and optional PD / alt fields on a study row.
 * @returns {"PM"|"PD"|null}
 */
function matchStudyStaffRole(principal, row) {
  if (!principal || !row) return null;
  const pm = row.project_manager || row.projectManager || "";
  const pd = row.project_director || row.projectDirector || row.pd || "";
  const alt = row.project_manager_alt || "";
  if (personNamesMatch(principal, pm) || personNamesMatch(principal, alt)) return "PM";
  if (personNamesMatch(principal, pd)) return "PD";
  return null;
}

function sortMineFirst(rows, principal, pickRow = (r) => r) {
  if (!principal || !Array.isArray(rows) || !rows.length) return rows || [];
  return [...rows].sort((a, b) => {
    const ra = matchStudyStaffRole(principal, pickRow(a));
    const rb = matchStudyStaffRole(principal, pickRow(b));
    const sa = ra ? 0 : 1;
    const sb = rb ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return 0;
  });
}

module.exports = {
  normalizePersonName,
  nameTokens,
  viewerNameTokens,
  personNamesMatch,
  matchStudyStaffRole,
  sortMineFirst
};
