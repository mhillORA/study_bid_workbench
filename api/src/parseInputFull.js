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
  sponsor: "clientName",
  "sponsor name": "clientName",
  client: "clientName",
  "study title/description": "title",
  "study title": "title",
  "study name": "title",
  "study description": "title",
  title: "title",
  "protocol number": "protocol",
  "protocol #": "protocol",
  protocol: "protocol",
  "parent opportunity id#": "opportunityId",
  "opportunity id": "opportunityId",
  "opportunity #": "opportunityId",
  "opp id": "opportunityId",
  phase: "phase",
  "study phase": "phase",
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

function parseInputFull(rows, options = {}) {
  const learnings = options.learnings || null;
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

  const siteParse = parseSites(rows, learnings);
  const sites = siteParse.sites;
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
    siteParseMeta: {
      headerRow: siteParse.headerRow,
      headerSignature: siteParse.headerSignature,
      columnMap: siteParse.columnMap,
      foundHeader: siteParse.headerRow >= 0,
      siteCount: sites.length
    },
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

/** Built-in + learned labels that can mark the country / geography column. */
const COUNTRY_HEADER_ALIASES = [
  "country",
  "countries",
  "country name",
  "site country",
  "country / region",
  "country/region",
  "geography",
  "geographies",
  "nation",
  "location",
  "locations",
  "site location",
  "site locations",
  "site name",
  "site names",
  "sites",
  "site",
  "region / country",
  "region/country"
];

const STOP_SITE_ROWS = new Set([
  "totals",
  "total",
  "pts check",
  "latinaba",
  "resources",
  "resource leads",
  "imv duration calculation",
  "masked and unmasked teams",
  "site & vendor payments",
  "site and vendor payments",
  "vendors",
  "monitoring"
]);

function normHeaderCell(v) {
  return normLabel(v).toLowerCase().replace(/[#:]+/g, "").replace(/\s+/g, " ").trim();
}

function isCountryHeaderLabel(label, learnings) {
  const n = normHeaderCell(label);
  if (!n) return false;
  if (COUNTRY_HEADER_ALIASES.includes(n)) return true;
  const learned = (learnings && learnings.siteHeaderAliases) || [];
  if (learned.map(normHeaderCell).includes(n)) return true;
  // Soft: starts with country/geography/nation/location
  if (/^(country|countries|geography|geographies|nation|location|locations|site name)/.test(n)) return true;
  return false;
}

function looksLikeSiteCountHeader(label) {
  const n = normHeaderCell(label);
  if (!n) return false;
  if (/(^|\b)(#\s*)?(core\s*)?sites?\b/.test(n)) return true;
  if (/(number|no\.?|#)\s+of\s+sites?/.test(n)) return true;
  if (/^sites?$/.test(n) || n === "site count" || n === "n sites") return true;
  return false;
}

function mapSiteColumns(headerRow, learnings) {
  const cells = (headerRow || []).map(normHeaderCell);
  const map = {
    country: 0,
    region: 1,
    coreSites: 2,
    backupSites: 3,
    startupMonths: 4,
    enrolledPts: 5,
    screenedPts: 6,
    completedPts: 7,
    enrollmentMonths: 8,
    enrollmentRate: 9,
    notes: 13
  };

  let foundCountry = false;
  cells.forEach((h, idx) => {
    if (!h) return;
    if (isCountryHeaderLabel(h, learnings) && !foundCountry) {
      map.country = idx;
      foundCountry = true;
      return;
    }
    if (/^region$|^geo(graphy)?$|^territory$/.test(h) || h.includes("region")) {
      if (h !== cells[map.country]) map.region = idx;
    }
    if (looksLikeSiteCountHeader(h) && !/backup|back-up|back up/.test(h)) map.coreSites = idx;
    if (/backup|back-up|back up/.test(h) && /site/.test(h)) map.backupSites = idx;
    if (/start.?up|startup|contract.?fpfv/.test(h) && /month/.test(h)) map.startupMonths = idx;
    if (/enrolled|enrollment pts|pts enrolled|# enrolled/.test(h) && !/rate|month/.test(h)) map.enrolledPts = idx;
    if (/screened|# screened/.test(h) && !/rate|fail/.test(h)) map.screenedPts = idx;
    if (/completed|# completed/.test(h)) map.completedPts = idx;
    if (/enrollment.*(month|mo)|enroll.*(month|mo)|fpfv.?lpfv/.test(h)) map.enrollmentMonths = idx;
    if (/enrollment rate|subjects.?site.?month|pts.?site.?mo/.test(h)) map.enrollmentRate = idx;
    if (/^notes?$|^comments?$|^assumptions?$/.test(h)) map.notes = idx;
  });

  return { map, foundCountry };
}

function findSiteHeaderRow(rows, learnings) {
  // 1) Classic: col0 country-like + a site-count column nearby
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const a0 = normHeaderCell(r[0]);
    if (isCountryHeaderLabel(a0, learnings)) {
      const hasSiteCol = r.some((c, idx) => idx > 0 && looksLikeSiteCountHeader(c));
      if (hasSiteCol || (r[2] && String(r[2]).toLowerCase().includes("site"))) {
        return i;
      }
      // Older sheets: "Country" then Region then blank until numbers — still accept
      if (a0 === "country" || a0 === "countries" || a0 === "geography") return i;
    }
  }

  // 2) "Site Mix" section marker — header is that row or the next non-empty row
  for (let i = 0; i < rows.length; i++) {
    const a0 = normHeaderCell(rows[i] && rows[i][0]);
    if (a0 === "site mix" || a0 === "sites mix" || a0 === "country mix" || a0 === "site distribution") {
      if (rows[i].some((c, idx) => idx > 0 && looksLikeSiteCountHeader(c))) return i;
      for (let j = i + 1; j < Math.min(i + 4, rows.length); j++) {
        const r = rows[j];
        if (!r) continue;
        if (isCountryHeaderLabel(r[0], learnings) || r.some((c) => looksLikeSiteCountHeader(c))) return j;
      }
    }
  }

  // 3) Any row where a cell is country-like AND another cell is site-count-like
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    let countryIdx = -1;
    let siteIdx = -1;
    r.forEach((c, idx) => {
      if (countryIdx < 0 && isCountryHeaderLabel(c, learnings)) countryIdx = idx;
      if (siteIdx < 0 && looksLikeSiteCountHeader(c)) siteIdx = idx;
    });
    if (countryIdx >= 0 && siteIdx >= 0 && countryIdx !== siteIdx) return i;
  }

  // 4) Learned header signatures (joined first cells)
  const sigs = (learnings && learnings.siteHeaderSignatures) || [];
  if (sigs.length) {
    for (let i = 0; i < rows.length; i++) {
      const sig = siteHeaderSignature(rows[i]);
      if (sig && sigs.includes(sig)) return i;
    }
  }

  return -1;
}

function siteHeaderSignature(headerRow) {
  if (!headerRow) return "";
  return headerRow
    .slice(0, 14)
    .map((c) => normHeaderCell(c))
    .filter(Boolean)
    .join("|");
}

function cellAt(r, idx) {
  if (idx == null || idx < 0) return null;
  return r[idx] ?? null;
}

function normalizeCountryName(raw, learnings) {
  const s = String(raw || "").trim();
  if (!s) return s;
  const key = s.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  const builtin = {
    us: "United States",
    usa: "United States",
    "u s": "United States",
    "u s a": "United States",
    "united states of america": "United States",
    "united states": "United States",
    uk: "United Kingdom",
    "u k": "United Kingdom",
    "great britain": "United Kingdom",
    britain: "United Kingdom",
    korea: "South Korea",
    "republic of korea": "South Korea",
    "south korea": "South Korea",
    "korea south": "South Korea",
    russia: "Russian Federation",
    czech: "Czech Republic",
    czechia: "Czech Republic",
    "czech republic": "Czech Republic",
    holland: "Netherlands",
    nederland: "Netherlands",
    "the netherlands": "Netherlands",
    uae: "United Arab Emirates",
    "u a e": "United Arab Emirates"
  };
  const learned = (learnings && learnings.countryAliases) || {};
  if (learned[key]) return learned[key];
  if (builtin[key]) return builtin[key];
  return s;
}

function parseSites(rows, learnings) {
  const siteHeader = findSiteHeaderRow(rows, learnings);
  const empty = {
    sites: [],
    headerRow: siteHeader,
    headerSignature: siteHeader >= 0 ? siteHeaderSignature(rows[siteHeader]) : "",
    columnMap: null
  };
  if (siteHeader < 0) return empty;

  const { map, foundCountry } = mapSiteColumns(rows[siteHeader], learnings);
  // If header detection found country elsewhere but map defaulted wrong, keep map.country from scan
  if (!foundCountry) {
    const cells = (rows[siteHeader] || []).map(normHeaderCell);
    const idx = cells.findIndex((h) => isCountryHeaderLabel(h, learnings));
    if (idx >= 0) map.country = idx;
  }

  const sites = [];
  for (let i = siteHeader + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const rawCountry = cellAt(r, map.country);
    if (rawCountry == null || String(rawCountry).trim() === "") continue;
    const countryRaw = String(rawCountry).trim();
    const countryLow = countryRaw.toLowerCase();
    if (STOP_SITE_ROWS.has(countryLow)) break;
    if (isCountryHeaderLabel(countryRaw, learnings) && looksLikeSiteCountHeader(cellAt(r, map.coreSites))) break;
    // Skip pure section markers / numeric-only first cells that aren't names
    if (/^(resources|monitoring|vendors|payments)/i.test(countryRaw)) break;

    const core = cellAt(r, map.coreSites);
    const enrolled = cellAt(r, map.enrolledPts);
    const notes = cellAt(r, map.notes);
    if ((core == null || core === "" || core === 0) && !notes && (enrolled == null || enrolled === "")) continue;

    sites.push({
      country: normalizeCountryName(countryRaw, learnings),
      countryRaw,
      region: cellAt(r, map.region),
      coreSites: core,
      backupSites: cellAt(r, map.backupSites),
      startupMonths: cellAt(r, map.startupMonths),
      enrolledPts: enrolled,
      screenedPts: cellAt(r, map.screenedPts),
      completedPts: cellAt(r, map.completedPts),
      enrollmentMonths: cellAt(r, map.enrollmentMonths),
      enrollmentRate: cellAt(r, map.enrollmentRate),
      notes
    });
  }

  return {
    sites,
    headerRow: siteHeader,
    headerSignature: siteHeaderSignature(rows[siteHeader]),
    columnMap: map
  };
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
