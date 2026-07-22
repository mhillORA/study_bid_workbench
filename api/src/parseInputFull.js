/**
 * Full Input Tab extraction — every labeled enterable/value cell we can see,
 * plus typed drivers, sites, resource leads, monitoring, vendors.
 */

function normLabel(v) {
  if (v == null) return "";
  return String(v).replace(/\s+/g, " ").trim().replace(/\?+$/, "");
}

function isBlank(v) {
  return v == null || (typeof v === "string" && v.trim() === "");
}

const HEADER_MAP = {
  "client name": "clientName",
  "study title/description": "title",
  "protocol number": "protocol",
  "parent opportunity id#": "opportunityId",
  phase: "phase",
  "bd director": "bdDirector",
  "bdo lead": "bdoLead",
  "therapeutic area": "therapeuticArea",
  "therapeutic area head": "therapeuticAreaHead",
  indication: "indication",
  "is indication a rare disease": "rareDisease",
  "is ip gene therapy": "geneTherapy",
  "what is the patient population": "patientPopulation",
  "client soe or ora soe assumptions": "soeSource",
  "budget version": "budgetVersion",
  "date budget due": "budgetDueDate",
  "enrollment type": "enrollmentType",
  "budget type": "budgetType",
  "level of reviews needed": "reviewLevel",
  "deliverable type": "deliverableType",
  "standalone or program": "standaloneOrProgram",
  "bid to spec / ora assumptions": "bidToSpec",
  "all ora systems? if not, what external systems": "allOraSystems"
};

const DRIVER_LABELS = {
  "# screened subjects": "screenedSubjects",
  "# enrolled subjects": "enrolledSubjects",
  "# completed subjects": "completedSubjects",
  "overall enrollment rate (subjects/site/month)": "enrollmentRate",
  "start-up (contract-fpfv) in months": "startupMonths",
  "enrollment (fpfv-lpfv) in months": "enrollmentMonths",
  "treatment incl. screening (lpfv-lplv) in months": "treatmentMonths",
  "long term follow-up (ltfu) in months": "ltfuMonths",
  "database lock (lp out-db lock) in months": "dblMonths",
  "closeout (db lock-delivery of tmf) in months": "closeoutMonths",
  "total duration": "totalDuration",
  "screen failure %": "screenFailRate",
  "drop-out rate": "dropOutRate"
};

function parseInputFull(rows) {
  const fields = []; // every A/B (and note) we find in core + later sections
  const header = {};
  const drivers = {};
  const driverMeta = {};
  let matchedKnown = 0;
  let section = "Core Inputs";

  const SECTION_MARKERS = new Set([
    "core inputs",
    "site mix",
    "resource leads",
    "imv duration calculation",
    "site & vendor payments",
    "vendors",
    "sponsor drivers",
    "patients",
    "timeline"
  ]);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const a = r[0];
    if (a == null || String(a).trim() === "") {
      // still harvest patient/timeline labels in cols D/F
      harvestDriversFromRow(r, drivers, driverMeta, fields, section);
      continue;
    }
    const label = normLabel(a);
    const low = label.toLowerCase();

    if (SECTION_MARKERS.has(low) || low === "country") {
      if (low !== "country") section = label;
      if (low === "site mix" || low === "country") {
        // sites parsed separately
      }
      fields.push({
        key: `section:${low}`,
        label,
        value: null,
        kind: "section",
        section,
        row: i + 1,
        editable: false
      });
      continue;
    }

    const value = r[1] != null && r[1] !== "" ? r[1] : null;
    const note = r[2] != null && String(r[2]).trim() !== "" ? r[2] : r[8] != null ? r[8] : null;

    // Map known header fields
    const canon = HEADER_MAP[low.replace(/\?+$/, "").trim()];
    if (canon && value != null) {
      header[canon] = value;
      matchedKnown += 1;
    }

    fields.push({
      key: canon || `input:${low}`,
      label,
      value,
      note: note != null && note !== value ? String(note) : null,
      kind: "input",
      section,
      row: i + 1,
      editable: true,
      sourceCols: "A/B"
    });

    harvestDriversFromRow(r, drivers, driverMeta, fields, section);
  }

  const sites = parseSites(rows);
  const resourceLeads = parseResourceLeads(rows);
  const monitoring = parseMonitoringBlock(rows);
  const vendors = parseVendors(rows);
  const payments = parsePayments(rows);

  // Derived helpers used by UI formulas
  if (drivers.coreSites == null && sites.length) {
    drivers.coreSites = sites.reduce((s, x) => s + (Number(x.coreSites) || 0), 0);
  }
  if (drivers.screenFailRate == null && driverMeta.screenFailRate != null) {
    drivers.screenFailRate = driverMeta.screenFailRate;
  }

  return {
    header,
    drivers,
    driverMeta,
    fields,
    sites,
    resourceLeads,
    monitoring,
    vendors,
    payments,
    matchedKnown,
    fieldCount: fields.filter((f) => f.kind === "input").length
  };
}

function harvestDriversFromRow(r, drivers, driverMeta, fields, section) {
  if (!r) return;
  // Col D label / F value (patients & timeline)
  if (r[3] != null && String(r[3]).trim() !== "") {
    const label = normLabel(r[3]);
    const low = label.toLowerCase();
    const key = DRIVER_LABELS[low];
    const value = r[5] != null ? r[5] : null;
    if (key && value != null && value !== "") {
      drivers[key] = value;
    }
    // G/H secondary (screen fail %, dates, etc.)
    if (r[6] != null && String(r[6]).trim() !== "") {
      const sideLabel = normLabel(r[6]);
      const sideLow = sideLabel.toLowerCase();
      const sideVal = r[7] != null ? r[7] : null;
      if (sideLow.includes("screen failure") && sideVal != null) {
        drivers.screenFailRate = sideVal;
        driverMeta.screenFailRate = sideVal;
      }
      if (sideLow.includes("drop-out") && sideVal != null) {
        drivers.dropOutRate = sideVal;
      }
      fields.push({
        key: `side:${sideLow}`,
        label: sideLabel,
        value: sideVal,
        kind: "driver_side",
        section: section || "Patients/Timeline",
        editable: true,
        sourceCols: "G/H"
      });
    }
    fields.push({
      key: key || `driver:${low}`,
      label,
      value,
      kind: "driver",
      section: section || "Patients/Timeline",
      editable: true,
      sourceCols: "D/F"
    });
  }
}

function parseSites(rows) {
  let siteHeader = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r && normLabel(r[0]).toLowerCase() === "country" && r[2] && String(r[2]).toLowerCase().includes("site")) {
      siteHeader = i;
      break;
    }
  }
  const sites = [];
  if (siteHeader < 0) return sites;
  for (let i = siteHeader + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r[0] == null) continue;
    const country = String(r[0]).trim();
    if (country.toLowerCase() === "totals") break;
    if (["pts check", "latinaba"].includes(country.toLowerCase())) break;
    const core = r[2];
    if ((core == null || core === "" || core === 0) && !r[13] && !r[5]) continue;
    sites.push({
      country,
      region: r[1] ?? null,
      coreSites: r[2] ?? null,
      backupSites: r[3] ?? null,
      startupMonths: r[4] ?? null,
      enrolledPts: r[5] ?? null,
      screenedPts: r[6] ?? null,
      completedPts: r[7] ?? null,
      enrollmentMonths: r[8] ?? null,
      enrollmentRate: r[9] ?? null,
      notes: r[13] ?? null
    });
  }
  return sites;
}

function parseResourceLeads(rows) {
  let start = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && normLabel(rows[i][0]).toLowerCase() === "resources") {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  const headers = (rows[start] || []).slice(1, 9).map((h, idx) => normLabel(h) || `col${idx}`);
  const out = [];
  for (let i = start + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r[0] == null) break;
    const role = normLabel(r[0]);
    if (["imv duration calculation", "masked and unmasked teams"].includes(role.toLowerCase())) break;
    if (role.toLowerCase() === "resource leads") continue;
    const regions = {};
    headers.forEach((h, idx) => {
      regions[h || `c${idx}`] = r[idx + 1] ?? null;
    });
    out.push({ role, regions, notes: r[13] ?? null });
  }
  return out;
}

function parseMonitoringBlock(rows) {
  const keys = [
    "Masked and unmasked teams?",
    "Overall Monitoring Strategy:",
    "Frequency of RBQM Data Review Meetings?",
    "SDV (in %)",
    "# of Sites",
    "Enrolled Patients / Site",
    "Total Duration for IMVs (Conduct + LTFU + DBL - 0.5 months)",
    "Total # of Procedures per Completed Patient",
    "# of Procedures per Screen Fail Patient",
    "Duration per Procedure (Minutes)",
    "Total Hours Required to SDV all Patients",
    "Days on Site per Visit",
    "Minimum Total # of Visits Between FPFV and DBL",
    "Total # of Visits Per Site Between FPFV and DBL",
    "Customized Reports: Add'l Time Needed (Hours)",
    "% of Half-day IMVs needing Add'l time",
    "Frequency of Masked Visits (weeks)",
    "Frequency of UnMasked Visits (weeks)"
  ];
  const out = {};
  for (const label of keys) {
    const target = normLabel(label).toLowerCase();
    for (const r of rows) {
      if (!r || r[0] == null) continue;
      if (normLabel(r[0]).toLowerCase() === target || normLabel(r[0]).toLowerCase().startsWith(target.replace(/\?$/, ""))) {
        out[label] = r[1] ?? null;
        break;
      }
    }
  }
  return out;
}

function parsePayments(rows) {
  const out = {};
  for (const r of rows) {
    if (!r || r[0] == null) continue;
    const low = normLabel(r[0]).toLowerCase();
    if (low.includes("vendor payment frequency")) {
      out.vendorPaymentFrequency = r[1] ?? null;
      out.vendorPaymentsCount = r[2] ?? null;
    }
    if (low.includes("site payment frequency")) {
      out.sitePaymentFrequency = r[1] ?? null;
      out.sitePaymentsCount = r[2] ?? null;
    }
  }
  return out;
}

function parseVendors(rows) {
  let start = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && normLabel(rows[i][0]).toLowerCase() === "vendor type") {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < Math.min(rows.length, start + 40); i++) {
    const r = rows[i];
    if (!r || r[0] == null) continue;
    const t = normLabel(r[0]);
    if (!t || t.toLowerCase() === "vendors") continue;
    // stop if we hit a totally different section heading pattern
    if (t.length > 60) break;
    out.push({
      vendorType: t,
      vendorName: r[1] ?? null,
      oraResponsibility: r[2] ?? null,
      dateRequested: r[3] ?? null,
      dateExpected: r[4] ?? null,
      dateReceived: r[5] ?? null,
      freqTransfers: r[6] ?? null
    });
  }
  return out;
}

function parseKeyRates(rows) {
  const rates = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const code = r[5];
    if (!code) continue;
    rates.push({
      region: r[4] ?? null,
      resourceCode: String(code).trim(),
      resourceName: r[6] ?? null,
      costRate: r[8] ?? null,
      baseRate: r[9] ?? null,
      baseRateAdjusted: r[10] ?? null
    });
  }
  return rates;
}

module.exports = {
  parseInputFull,
  parseKeyRates,
  normLabel
};
