const ExcelJS = require("exceljs");
const crypto = require("crypto");
const { parseInputFull, parseKeyRates } = require("./parseInputFull");
const { enrichInputFields, applyCanonicalToBags } = require("./fieldRegistry");
const { harvestAllSheets } = require("./parseSheetHarvest");

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

function studyIdFromFilename(name) {
  const opp = opportunityFromFilename(name);
  if (opp) return opp;
  const stem = String(name || "workbook")
    .replace(/\.xlsx$/i, "")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 72);
  return stem ? `FILE-${stem}` : `FILE-UNKNOWN`;
}

function resolveSheets(names) {
  const has = new Set(names);
  const resolved = {};
  for (const [canon, options] of Object.entries(SHEET_ALIASES)) {
    for (const opt of options) {
      if (has.has(opt)) {
        resolved[canon] = opt;
        break;
      }
    }
    if (!resolved[canon]) {
      for (const s of names) {
        const low = s.toLowerCase();
        if (canon === "Internal Budget" && (low.includes("cost breakdown") || low.includes("internal budget"))) {
          resolved[canon] = s;
          break;
        }
        if (canon === "Exec Sum" && low.includes("econom")) {
          resolved[canon] = s;
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
    const fees = r[4];
    if (area && typeof area === "string" && area.trim() && fees != null) {
      const label = area.trim();
      const low = label.toLowerCase();
      if (["subtotal service fees", "contingency budget", "inflation", "discount", "total service fees"].includes(low)) {
        totals[label] = fees;
      } else if (!["service areas", "cost per patient"].includes(low)) {
        serviceAreas.push({ name: label, serviceFees: fees });
      }
    }
    const ptLabel = r[10];
    const ptVal = r[12];
    if (ptLabel && typeof ptLabel === "string" && ptLabel.trim() && ptVal != null) {
      if (ptLabel.trim().toLowerCase() === "total") totals.passThroughTotal = ptVal;
    }
  }
  return { totals, serviceAreas };
}

async function parseWorkbookBuffer(buffer, fileName) {
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const sheetNames = wb.worksheets.map((w) => w.name);
  const resolved = resolveSheets(sheetNames);
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

  const input = parseInputFull(inputRows);
  let { header, drivers, sites, fields, resourceLeads, monitoring, vendors, payments, matchedKnown, fieldCount } =
    input;
  fields = enrichInputFields(fields);
  const bags = applyCanonicalToBags(header, drivers, fields);
  header = bags.header;
  drivers = bags.drivers;
  const normalizedCount = fields.filter((f) => f.normalized).length;

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

  const warnings = [];
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
  warnings.push(
    `Sheet harvest: ${sheetHarvest.sheetCount} sheets (${sheetHarvest.unstructuredCount} unstructured dumps)`
  );

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
  const hasContent =
    lineItems.length >= 1 ||
    fieldCount >= 5 ||
    Boolean(resolved["Input Tab"]) ||
    Boolean(resolved["Internal Budget"]);

  let quarantineReasons = [];
  if (!hasId) quarantineReasons.push("no_study_id");
  if (lineItems.length === 0) quarantineReasons.push("no_line_items");
  if (fieldCount === 0) quarantineReasons.push("no_input_fields");
  if (!fp.matched) quarantineReasons.push(`missing_sheets:${missing.join("|") || "none"}`);
  if (conf < 0.45) quarantineReasons.push("low_confidence");

  // POC: load anything with an id + any captured content. Quarantine only empty shells.
  let quarantine = !(hasId && hasContent);

  if (hasId && hasContent) {
    warnings.push(
      lineItems.length >= 20
        ? "POC auto-load: study id + line items"
        : "POC auto-load: study id + captured inputs (filename stem OK if no O-#####)"
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

  return {
    schemaVersion: 2,
    profileId: "ora-budget-internal-v3",
    confidence: Math.round(conf * 1000) / 1000,
    warnings,
    quarantine,
    quarantineReasons,
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
  studyIdFromFilename
};
