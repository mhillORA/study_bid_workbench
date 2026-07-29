const ExcelJS = require("exceljs");
const crypto = require("crypto");
const { parseInputFull, parseKeyRates } = require("./parseInputFull");
const { enrichInputFields, applyCanonicalToBags } = require("./fieldRegistry");
const { harvestAllSheets } = require("./parseSheetHarvest");
const {
  mergeSheetAliasOptions,
  resolveCanonicalWithLearnings,
  guessSheetCanonical,
  buildLearnHints
} = require("./parseLearning");

const SHEET_ALIASES = {
  "Input Tab": ["Input Tab", "Main Specifications Required", "Study Specs"],
  "Internal Budget": [
    "Internal Budget",
    "Ora Model Budget",
    "Study Budget",
    "RFP_Budget",
    "Budget",
    "Detailed Breakdown",
    "Cost Breakdown",
    "CNGB-001 Cost Breakdown"
  ],
  "Exec Sum": ["Exec Sum", "Study Economics", "Study Economics (2)", "Executive Summary"],
  Key: ["Key"]
};

const DEPT_BY_PREFIX = {
  AA: "Recruitment",
  AB: "ClinOps",
  AC: "ClinOps",
  AD: "ClinOps",
  AE: "ClinOps",
  AF: "ClinOps",
  AG: "ClinOps",
  AH: "ClinOps",
  AI: "ClinOps",
  AJ: "ClinOps",
  AK: "ClinOps",
  AL: "ClinOps",
  AM: "ClinOps",
  AN: "Monitoring",
  AO: "Monitoring",
  AP: "ClinOps",
  AQ: "ClinOps",
  AR: "ClinOps",
  AS: "Medical",
  AT: "Medical",
  AX: "SMO",
  BR: "DataManagement",
  BS: "Biostatistics",
  BT: "IRT",
  BW: "IP",
  BX: "PassThrough"
};

function normLabel(v) {
  if (v == null) return "";
  return String(v).replace(/\s+/g, " ").trim().replace(/\?+$/, "");
}

function cellValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object" && v.text != null) return v.text;
  if (typeof v === "object" && v.result != null) return v.result;
  if (typeof v === "object" && v.richText) {
    return v.richText.map((t) => t.text).join("");
  }
  if (typeof v === "string" && v.startsWith("=")) return null;
  return v;
}

/** Coerce Excel currency / percent / string cells to a finite number. */
function toMoneyNumber(v) {
  const raw = cellValue(v);
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const s = String(raw).trim().replace(/[$,%\s]/g, "").replace(/\((.*)\)/, "-$1");
  if (!s || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function opportunityFromFilename(name) {
  const s = String(name || "");
  // Prefer explicit Ora opportunity tokens: O-12345 / O12345
  let m = s.match(/(?:^|[^A-Za-z0-9])O-(\d{4,5})(?!\d)/i);
  if (m) return `O-${m[1].padStart(5, "0")}`;
  m = s.match(/(?:^|[^A-Za-z0-9])O(\d{4,5})(?!\d)/i);
  if (m) return `O-${m[1].padStart(5, "0")}`;
  // Typo form INTERNAL_0-12345_… — do NOT match inside protocol ids like VSJ-110-2201
  m = s.match(/(?:^|INTERNAL_|NO_CO_|BUDGET_|_)0-(\d{4,5})(?!\d)/i);
  if (m) return `O-${m[1].padStart(5, "0")}`;
  return null;
}

/** Ora project number often embedded as YY-NNN-NNNN (e.g. 24-150-0003). */
function projectNumberFromFilename(name) {
  const m = String(name || "").match(/(?:^|[^0-9])(\d{2}-\d{3}-\d{4})(?:[^0-9]|$)/);
  return m ? m[1] : null;
}

function isJunkIdentityValue(v) {
  const s = String(v || "").trim();
  if (!s) return true;
  if (s.length > 120) return true;
  const low = s.toLowerCase();
  if (
    /^(client name|sponsor|sponsor name|study title|study description|title|n\/?a|tbd|yes|no|none|null|unknown)$/i.test(
      s
    )
  ) {
    return true;
  }
  // Instructional / geography placeholders wrongly pulled from Input Tab
  if (/^for us only\b/i.test(s)) return true;
  if (/^north america$/i.test(s) || /^europe$/i.test(s) || /^global$/i.test(s)) return true;
  if (/submissions to fda/i.test(s)) return true;
  if (/requires separate regulatory/i.test(s)) return true;
  if (low === "study description") return true;
  return false;
}

function cleanTitleFromFilenameBits(raw) {
  let t = String(raw || "")
    .replace(/\.xlsx$/i, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Drop trailing version / CO / date noise
  t = t
    .replace(
      /\s+(?:Ph(?:ase)?\s*\d[a-z]?|P\d[a-z]?|CO\s*#?\s*\d+|SOW\s*\d*|Scenario\s*\d+|v\d+(?:\.\d+)?|reduced)\b.*$/i,
      ""
    )
    .replace(/\s+\d{1,2}[A-Za-z]{3}\d{2,4}\s*$/g, "")
    .replace(/\s*[\(\[\{].*$/, "")
    .replace(/\s+-\s*$/, "")
    .trim();
  return t || null;
}

/**
 * Pull sponsor / study title / protocol from common Ora SharePoint / INTERNAL names
 * when Input Tab headers are missing or junk.
 *
 * Examples:
 *  - 1. Active Projects_04. Posterior_Roche - BP45328SNOWBALL - 24-150-0003_OOS Log….xlsx
 *  - INTERNAL_Alcon_DEF512-E002_P3b_DED_v5_CO1_25Mar2025.xlsx
 *  - Internal_Budget_Beacon_AGTC-CNGA3-002_CO3_(17Sep2025).xlsx
 */
function metaFromFilename(name) {
  const original = String(name || "");
  let base = original.replace(/\.xlsx$/i, "").trim();
  base = base.replace(/^(?:Copy of\s+)+/i, "").trim();

  const out = {
    clientName: null,
    title: null,
    protocol: null,
    therapeuticArea: null,
    projectNumber: null,
    kind: null,
    source: null
  };

  if (/oos\s*log/i.test(original)) out.kind = "oos_log";
  else if (/active projects/i.test(original)) out.kind = "active_projects";
  else if (/^INTERNAL|^BUDGET|^Internal/i.test(base)) out.kind = "internal_budget";

  // Active Projects_NN. <Area>_<Sponsor> - <Study> - <YY-NNN-NNNN>_…
  let m = base.match(
    /Active Projects[_\s]*\d+\.\s*([^_\/]+?)_([^-\/]+?)\s*-\s*(.+?)\s*-\s*(\d{2}-\d{3}-\d{4})/i
  );
  if (m) {
    out.therapeuticArea = m[1].trim();
    out.clientName = m[2].trim();
    out.title = cleanTitleFromFilenameBits(m[3]);
    out.projectNumber = m[4];
    out.protocol = m[4];
    out.source = "active_projects_filename";
    out.kind = out.kind || "active_projects";
    return out;
  }

  // Looser: Sponsor - Study - YY-NNN-NNNN anywhere (folder crumbs ok)
  m = base.match(
    /(?:^|[_\s])([A-Za-z][A-Za-z0-9&.]*(?:\s+[A-Za-z][A-Za-z0-9&.]*){0,2})\s*-\s*([^-]+?)\s*-\s*(\d{2}-\d{3}-\d{4})/
  );
  if (m && /active projects/i.test(base)) {
    out.clientName = m[1].trim();
    out.title = cleanTitleFromFilenameBits(m[2]);
    out.projectNumber = m[3];
    out.protocol = m[3];
    out.source = "active_projects_loose";
    return out;
  }

  const proj = projectNumberFromFilename(base);
  if (proj) {
    out.projectNumber = proj;
    out.protocol = out.protocol || proj;
  }

  // Internal_Budget_<Sponsor>_<rest>
  m = base.match(/^Internal[_\s-]*Budget[_\s-]+([^_\/]+)[_\s-]+(.+)$/i);
  if (m) {
    out.clientName = m[1].trim();
    out.title = cleanTitleFromFilenameBits(m[2]);
    out.source = "internal_budget_filename";
    out.kind = "internal_budget";
    return out;
  }

  // INTERNAL_<Sponsor>_<rest>  /  BUDGET_<…>
  m = base.match(/^(?:INTERNAL|BUDGET)_(.+)$/i);
  if (m) {
    let rest = m[1];
    const opp = opportunityFromFilename(original);
    const cut = rest.search(
      /_(?:Ph(?:ase)?\d[a-z]?|P\d[a-b]?|CO(?:#?\d+)?|SOW\d*|Scenario\d*|v\d+)/i
    );
    const head = cut > 0 ? rest.slice(0, cut) : rest;
    const parts = head.split("_").filter(Boolean);
    if (parts.length) {
      // First underscore-token is sponsor; trailing Inc/LLC/MA continue the sponsor.
      // Exception: BUDGET_<vendor>_<sponsor>_O-##### → prefer sponsor after known vendor/CRO.
      let i = 1;
      const sponsorParts = [parts[0]];
      while (i < parts.length && /^(?:MA|Inc|INC|LLC|Ltd|Corp|Bio|Therapeutics|Pharma|Medical|Vision)$/i.test(parts[i])) {
        sponsorParts.push(parts[i]);
        i += 1;
      }
      if (
        /^(?:medtrials|vendor|cro)$/i.test(String(sponsorParts[0]).replace(/\s+/g, "")) ||
        /^medtrials\b/i.test(sponsorParts.join(" "))
      ) {
        if (parts[i]) {
          const sponsorFromSecond = [parts[i]];
          i += 1;
          while (
            i < parts.length &&
            /^(?:MA|Inc|INC|LLC|Ltd|Corp|Bio|Therapeutics|Pharma|Medical|Vision)$/i.test(parts[i])
          ) {
            sponsorFromSecond.push(parts[i]);
            i += 1;
          }
          out.clientName = sponsorFromSecond.join(" ").trim();
        } else {
          out.clientName = sponsorParts.join(" ").trim();
        }
      } else {
        out.clientName = sponsorParts.join(" ").trim() || null;
      }
      const titleBits = parts.slice(i).join("_");
      out.title =
        cleanTitleFromFilenameBits(titleBits) ||
        (opp ? opp : null) ||
        cleanTitleFromFilenameBits(parts.slice(1).join("_"));
      if (opp) {
        out.protocol = opp;
        if (!out.title || out.title === out.clientName) out.title = opp;
      }
      out.source = "internal_filename";
      out.kind = out.kind || "internal_budget";
      return out;
    }
  }

  // 2CTech_Phase2RP_Budget_… style
  m = base.match(/^([A-Za-z0-9][A-Za-z0-9&.]*)[_\s-]+(.+)$/i);
  if (m && /budget/i.test(base) && !out.clientName) {
    out.clientName = m[1];
    out.title = cleanTitleFromFilenameBits(m[2]);
    out.source = "generic_budget_filename";
    out.kind = "internal_budget";
    return out;
  }

  return out.clientName || out.title || out.projectNumber ? out : out;
}

function applyFilenameMetaToHeader(header, fileName, warnings) {
  const meta = metaFromFilename(fileName);
  const h = header && typeof header === "object" ? header : {};
  const notes = [];

  if (isJunkIdentityValue(h.clientName)) {
    if (h.clientName) notes.push(`Cleared junk clientName "${String(h.clientName).slice(0, 40)}"`);
    h.clientName = null;
  }
  if (isJunkIdentityValue(h.title)) {
    if (h.title) notes.push(`Cleared junk title "${String(h.title).slice(0, 40)}"`);
    h.title = null;
  }

  if (!h.clientName && meta.clientName) {
    h.clientName = meta.clientName;
    h.clientNameSource = meta.source;
    notes.push(`Filled clientName from filename: ${meta.clientName}`);
  }
  if (!h.title && meta.title) {
    h.title = meta.title;
    h.titleSource = meta.source;
    notes.push(`Filled title from filename: ${meta.title}`);
  }
  if ((!h.protocol || isJunkIdentityValue(h.protocol)) && (meta.protocol || meta.projectNumber)) {
    h.protocol = meta.protocol || meta.projectNumber;
    notes.push(`Filled protocol from filename: ${h.protocol}`);
  }
  if (!h.therapeuticArea && meta.therapeuticArea) {
    h.therapeuticArea = meta.therapeuticArea;
    notes.push(`Filled therapeuticArea from filename: ${meta.therapeuticArea}`);
  }
  if (meta.kind === "oos_log") {
    h.budgetType = h.budgetType || "oos_log";
    notes.push("Filename looks like an OOS log (not an Ora budget workbook)");
  }

  if (warnings && notes.length) for (const n of notes) warnings.push(n);
  return { header: h, meta, notes };
}

function studyIdFromFilename(name) {
  const opp = opportunityFromFilename(name);
  if (opp) return opp;
  const meta = metaFromFilename(name);
  // Prefer compact project-number ids over FILE-1._Active_Projects_…
  if (meta.projectNumber) {
    const sponsor = meta.clientName
      ? String(meta.clientName)
          .replace(/[^\w]+/g, "")
          .slice(0, 16)
      : "";
    return sponsor ? `PN-${meta.projectNumber}_${sponsor}` : `PN-${meta.projectNumber}`;
  }
  const stem = String(name || "workbook")
    .replace(/\.xlsx$/i, "")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 72);
  return stem ? `FILE-${stem}` : `FILE-UNKNOWN`;
}

function resolveSheets(names, learnings) {
  const has = new Set(names);
  const aliases = mergeSheetAliasOptions(SHEET_ALIASES, learnings);
  const resolved = {};
  const used = new Set();

  for (const [canon, options] of Object.entries(aliases)) {
    for (const opt of options) {
      if (has.has(opt) && !used.has(opt)) {
        resolved[canon] = opt;
        used.add(opt);
        break;
      }
    }
    if (!resolved[canon]) {
      for (const s of names) {
        if (used.has(s)) continue;
        const low = s.toLowerCase();
        if (canon === "Internal Budget" && (low.includes("cost breakdown") || low.includes("internal budget") || low.includes("ora model"))) {
          resolved[canon] = s;
          used.add(s);
          break;
        }
        if (canon === "Exec Sum" && (low.includes("econom") || low.includes("exec sum") || low.includes("executive"))) {
          resolved[canon] = s;
          used.add(s);
          break;
        }
        if (canon === "Input Tab" && (low.includes("input") || low.includes("spec") || low.includes("assumption"))) {
          if (/budget|cost|exec|key|rate/.test(low)) continue;
          resolved[canon] = s;
          used.add(s);
          break;
        }
        if (canon === "Key" && (low === "key" || low.includes("rate card") || low.includes("rates"))) {
          resolved[canon] = s;
          used.add(s);
          break;
        }
      }
    }
    // Learned fuzzy: any unused sheet whose name maps to this canonical role
    if (!resolved[canon]) {
      for (const s of names) {
        if (used.has(s)) continue;
        if (guessSheetCanonical(s) === canon) {
          resolved[canon] = s;
          used.add(s);
          break;
        }
      }
    }
  }
  return resolved;
}

function sheetMatrix(worksheet) {
  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const vals = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      vals[col - 1] = cellValue(cell.value);
    });
    rows.push(vals);
  });
  return rows;
}

function oraPrefix(code) {
  const m = String(code).trim().match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : "";
}

function parseInternalBudget(rows) {
  const items = [];
  let section = null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const ora = r[0];
    const service = r[2];
    if (ora == null && service && typeof service === "string") {
      const s = service.trim();
      if (s && s.toUpperCase() !== "LABOR" && s.toLowerCase() !== "subtotal") section = s;
      continue;
    }
    if (!ora || typeof ora !== "string") continue;
    const code = ora.trim();
    if (!code) continue;
    const svc = service != null ? String(service).trim() : "";
    if (svc.toLowerCase() === "subtotal") continue;
    const prefix = oraPrefix(code);
    items.push({
      oraCode: code,
      oraPrefix: prefix,
      department: DEPT_BY_PREFIX[prefix] || "Other",
      section,
      clientMapping: r[1] ?? null,
      service: svc,
      netSuiteTask: r[3] ?? null,
      unitDescription: r[4] ?? null,
      oraTask: r[5] ?? null,
      units: r[6] ?? null,
      hoursPerUnit: r[7] ?? null,
      totalHours: r[8] ?? null,
      resourceCode: r[9] ?? null,
      hourlyRate: r[10] ?? null,
      charge: r[11] ?? null,
      hourlyCost: r[12] ?? null,
      directCost: r[13] ?? null,
      phase: r[14] ?? null
    });
  }
  return items;
}

function parseExecSum(rows) {
  const totals = {};
  const serviceAreas = [];
  for (const r of rows) {
    if (!r) continue;
    const area = r[2];
    const fees = toMoneyNumber(r[4]);
    if (area && typeof area === "string" && area.trim() && fees != null) {
      const label = area.trim();
      const low = label.toLowerCase();
      if (
        [
          "subtotal service fees",
          "contingency budget",
          "inflation",
          "discount",
          "total service fees"
        ].includes(low)
      ) {
        totals[label] = fees;
      } else if (!["service areas", "cost per patient"].includes(low)) {
        serviceAreas.push({ name: label, serviceFees: fees });
      }
    }
    const ptLabel = r[10];
    const ptVal = toMoneyNumber(r[12]);
    if (ptLabel && typeof ptLabel === "string" && ptLabel.trim() && ptVal != null) {
      const ptLow = ptLabel.trim().toLowerCase();
      if (ptLow === "total" || (ptLow.includes("pass") && ptLow.includes("through"))) {
        totals.passThroughTotal = ptVal;
      }
    }
  }
  return { totals, serviceAreas };
}

async function parseWorkbookBuffer(buffer, fileName, options = {}) {
  const learnings = options.learnings || null;
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const sheetNames = wb.worksheets.map((w) => w.name);
  const resolved = resolveSheets(sheetNames, learnings);
  const required = ["Input Tab", "Internal Budget", "Exec Sum"];
  const missing = required.filter((r) => !resolved[r]);
  const fp = {
    matched: missing.length === 0,
    missingSheets: missing,
    resolvedSheets: resolved,
    sheetCount: sheetNames.length,
    score: missing.length === 0 ? 1 : Math.max(0, 1 - missing.length / required.length)
  };

  const inputRows = resolved["Input Tab"] ? sheetMatrix(wb.getWorksheet(resolved["Input Tab"])) : [];
  const budgetRows = resolved["Internal Budget"]
    ? sheetMatrix(wb.getWorksheet(resolved["Internal Budget"]))
    : [];
  const execRows = resolved["Exec Sum"] ? sheetMatrix(wb.getWorksheet(resolved["Exec Sum"])) : [];
  const keyRows = resolved.Key ? sheetMatrix(wb.getWorksheet(resolved.Key)) : [];

  const input = parseInputFull(inputRows, { learnings });
  let {
    header,
    drivers,
    sites,
    fields,
    resourceLeads,
    monitoring,
    vendors,
    payments,
    matchedKnown,
    fieldCount,
    siteParseMeta
  } = input;
  const extraResolve = learnings
    ? (label) => resolveCanonicalWithLearnings(label, learnings)
    : null;
  fields = enrichInputFields(fields, extraResolve);
  const bags = applyCanonicalToBags(header, drivers, fields);
  header = bags.header;
  drivers = bags.drivers;
  const normalizedCount = fields.filter((f) => f.normalized).length;

  const warnings = [];
  // Fill / repair sponsor + study name from SharePoint / INTERNAL filenames when Input Tab is empty or junk
  const fileMetaApply = applyFilenameMetaToHeader(header, fileName, warnings);
  header = fileMetaApply.header;
  const fileMeta = fileMetaApply.meta;

  const lineItems = parseInternalBudget(budgetRows);
  const execSum = parseExecSum(execRows);
  const rates = parseKeyRates(keyRows);

  const sheetHarvest = harvestAllSheets(wb, resolved);
  const sheetInventory = sheetNames.map((name) => {
    const ws = wb.getWorksheet(name);
    let rows = 0;
    try {
      rows = ws && ws.rowCount ? ws.rowCount : 0;
    } catch (_) {}
    const harvested = (sheetHarvest.sheets || []).find((s) => s.name === name);
    return {
      name,
      rowCount: rows,
      captured: Boolean(Object.values(resolved).includes(name)),
      labelValueCount: harvested ? (harvested.labelValues || []).length : 0,
      cellDumpCount: harvested ? (harvested.cells || []).length : 0
    };
  });

  const harvestLabelTotal = sheetInventory.reduce((n, s) => n + (s.labelValueCount || 0), 0);

  let conf = fp.score;
  const matched = matchedKnown;
  if (matched < 8) {
    conf *= 0.6;
    warnings.push(`Only matched ${matched} known header labels (${fieldCount} total input fields captured)`);
  } else conf = Math.min(1, conf + 0.1);
  if (lineItems.length < 50) {
    conf *= 0.5;
    warnings.push(`Only ${lineItems.length} line items`);
  }
  if (!fp.matched) warnings.push(`Missing sheets: ${missing.join(", ")}`);
  warnings.push(
    `Captured ${fieldCount} Input Tab fields (${normalizedCount} canonical), ${sites.length} sites, ${rates.length} key rates`
  );
  if (!sites.length) {
    conf *= 0.85;
    warnings.push(
      siteParseMeta?.foundHeader
        ? "Site Mix header found but no country rows captured — check older column layout"
        : "No Site Mix / Country table detected — older site headers will be proposed for learning"
    );
  } else if (siteParseMeta?.headerSignature) {
    warnings.push(`Site table header: ${siteParseMeta.headerSignature.slice(0, 120)}`);
  }
  warnings.push(
    `Sheet harvest: ${sheetHarvest.sheetCount} sheets (${sheetHarvest.unstructuredCount} unstructured dumps)`
  );
  if (learnings) {
    const sheetLearned = Object.values(learnings.sheetAliases || {}).reduce((n, a) => n + (a?.length || 0), 0);
    const fieldLearned = Object.values(learnings.fieldAliases || {}).reduce((n, a) => n + (a?.length || 0), 0);
    if (sheetLearned || fieldLearned) {
      warnings.push(`Applied learned aliases: ${sheetLearned} sheet, ${fieldLearned} field`);
    }
  }

  const fileOpp = opportunityFromFilename(fileName);
  const fileStudyId = studyIdFromFilename(fileName);
  const headerOpp = header.opportunityId && String(header.opportunityId).trim()
    ? String(header.opportunityId).trim()
    : null;

  // Filename O-xxxxx wins over header (avoids wrong opp when workbook reused/copied).
  let opportunityId = fileOpp || headerOpp || fileStudyId || "UNKNOWN";
  if (fileOpp) {
    header.opportunityId = fileOpp;
    header.opportunityIdSource = "filename_opp";
    if (headerOpp && headerOpp !== fileOpp) {
      warnings.push(`Header opportunityId ${headerOpp} overridden by filename ${fileOpp}`);
    } else {
      warnings.push(`Filled studyId from filename: ${fileOpp}`);
    }
    conf = Math.min(1, conf + 0.15);
  } else if (!headerOpp && fileStudyId) {
    header.opportunityId = fileStudyId;
    header.opportunityIdSource = "filename_stem";
    warnings.push(`No O-##### in name — using studyId ${fileStudyId}`);
    conf = Math.min(1, conf + 0.1);
  }

  const enoughLines = lineItems.length >= 20;
  const hasId = opportunityId !== "UNKNOWN";
  // "Similar enough": any recognizable budget content → Cosmos; empty shells → quarantine
  const hasContent =
    lineItems.length >= 1 ||
    fieldCount >= 5 ||
    harvestLabelTotal >= 8 ||
    Boolean(resolved["Input Tab"]) ||
    Boolean(resolved["Internal Budget"]) ||
    Boolean(resolved["Exec Sum"]);

  let quarantineReasons = [];
  if (!hasId) quarantineReasons.push("no_study_id");
  if (lineItems.length === 0) quarantineReasons.push("no_line_items");
  if (fieldCount === 0) quarantineReasons.push("no_input_fields");
  if (!fp.matched) quarantineReasons.push(`missing_sheets:${missing.join("|") || "none"}`);
  if (conf < 0.45) quarantineReasons.push("low_confidence");
  if (!hasContent) quarantineReasons.push("no_recognizable_content");
  if (fileMeta?.kind === "oos_log" || /oos\s*log/i.test(String(fileName || ""))) {
    quarantineReasons.push("not_a_budget_workbook:oos_log");
  }

  // Similar → Cosmos. Unsure / empty → quarantine (still mined for learnings).
  let quarantine = !(hasId && hasContent);
  // OOS logs / non-budget Active Projects crumbs should never auto-load as studies
  if (fileMeta?.kind === "oos_log" || quarantineReasons.some((r) => String(r).startsWith("not_a_budget"))) {
    quarantine = true;
  }

  if (hasId && hasContent) {
    warnings.push(
      lineItems.length >= 20
        ? "Auto-load: study id + line items (similar format)"
        : "Auto-load: study id + similar content (inputs/harvest/sheets); re-upload after learnings promote aliases"
    );
    conf = Math.max(conf, lineItems.length >= 20 ? 0.7 : 0.55);
    quarantine = false;
  } else if (enoughLines && hasId && !fp.matched) {
    warnings.push("Loaded with sheet aliases / partial fingerprint");
    conf = Math.max(conf, 0.75);
    quarantine = false;
  }

  if (quarantine) {
    warnings.push(`Quarantine reasons: ${quarantineReasons.join(", ") || "unusable parse"}`);
  }

  const coreSites = sites.reduce((sum, s) => sum + (typeof s.coreSites === "number" ? s.coreSites : 0), 0);
  drivers.coreSites = coreSites || drivers.coreSites;

  // Defaults used by UI formulas if missing
  if (drivers.contingency == null) drivers.contingency = 0;
  if (drivers.inflationRate == null) drivers.inflationRate = 0;
  if (drivers.discount == null) drivers.discount = 0;

  const importedAt = new Date().toISOString();
  const studyId = opportunityId;

  const partial = {
    fingerprint: fp,
    sheetInventory,
    study: { inputFields: fields, sites },
    source: { fileName },
    siteParseMeta,
    inputPreviewRows: inputRows.slice(0, 80).map((r) => (r || []).slice(0, 14))
  };
  const learnHints = buildLearnHints(partial);
  const siteHintN = (learnHints.proposedSiteHeaders || []).length;
  if (learnHints.proposedSheets.length || learnHints.proposedFields.length || siteHintN) {
    warnings.push(
      `Learn hints: ${learnHints.proposedSheets.length} sheet, ${learnHints.proposedFields.length} field, ${siteHintN} site-header proposal(s)`
    );
  }

  return {
    schemaVersion: 2,
    profileId: "ora-budget-internal-v3",
    confidence: Math.round(conf * 1000) / 1000,
    warnings,
    quarantine,
    quarantineReasons,
    learnHints,
    siteParseMeta: siteParseMeta || null,
    source: {
      fileName,
      sha256,
      byteSize: buffer.length,
      storedIn: "not-persisted-bytes"
    },
    fingerprint: fp,
    sheetInventory,
    rates,
    study: {
      id: `study-${studyId}`,
      studyId,
      opportunityId,
      clientName: header.clientName || null,
      title: header.title || null,
      protocol: header.protocol || null,
      phase: header.phase || null,
      therapeuticArea: header.therapeuticArea || null,
      indication: header.indication || null,
      enrollmentType: header.enrollmentType || null,
      budgetType: header.budgetType || null,
      status: "imported",
      importedAt,
      header,
      drivers,
      sites,
      inputFields: fields,
      resourceLeads,
      monitoring,
      vendors,
      payments,
      fieldCount,
      normalizedFieldCount: normalizedCount,
      sheetHarvestSummary: {
        sheetCount: sheetHarvest.sheetCount,
        structuredCount: sheetHarvest.structuredCount,
        unstructuredCount: sheetHarvest.unstructuredCount,
        sheets: (sheetHarvest.sheets || []).map((s) => ({
          name: s.name,
          role: s.role,
          structured: s.structured,
          rowCount: s.rowCount,
          labelValueCount: (s.labelValues || []).length,
          cellCount: (s.cells || []).length
        }))
      }
    },
    version: {
      id: `ver-${studyId}-${sha256.slice(0, 10)}`,
      studyId,
      label: String(header.budgetVersion || "imported"),
      sourceSha256: sha256,
      sourceFileName: fileName,
      totals: execSum.totals || {},
      execSum,
      lineItemCount: lineItems.length,
      rateCount: rates.length,
      sheetInventory,
      sheetHarvest,
      createdAt: importedAt
    },
    lineItems,
    matchedInputLabels: matched
  };
}

module.exports = {
  parseWorkbookBuffer,
  opportunityFromFilename,
  studyIdFromFilename,
  metaFromFilename,
  applyFilenameMetaToHeader,
  isJunkIdentityValue,
  projectNumberFromFilename
};
