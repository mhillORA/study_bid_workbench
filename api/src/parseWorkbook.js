const ExcelJS = require("exceljs");
const crypto = require("crypto");
const { parseInputFull, parseKeyRates } = require("./parseInputFull");

const SHEET_ALIASES = {
  "Input Tab": ["Input Tab", "Main Specifications Required", "Study Specs"],
  "Internal Budget": [
    "Internal Budget",
    "Ora Model Budget",
    "Study Budget",
    "RFP_Budget",
    "Budget",
    "Detailed Breakdown",
    "Cost Breakdown"
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
  let m = String(name).match(/O-(\d{4,5})/i);
  if (m) return `O-${m[1].padStart(5, "0")}`;
  m = String(name).match(/(?<![A-Za-z])0-(\d{4,5})/);
  if (m) return `O-${m[1].padStart(5, "0")}`;
  return null;
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
  const { header, drivers, sites, fields, resourceLeads, monitoring, vendors, payments, matchedKnown, fieldCount } =
    input;
  const lineItems = parseInternalBudget(budgetRows);
  const execSum = parseExecSum(execRows);
  const rates = parseKeyRates(keyRows);

  const sheetInventory = sheetNames.map((name) => {
    const ws = wb.getWorksheet(name);
    let rows = 0;
    try {
      rows = ws && ws.rowCount ? ws.rowCount : 0;
    } catch (_) {}
    return { name, rowCount: rows, captured: Boolean(Object.values(resolved).includes(name)) };
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
  warnings.push(`Captured ${fieldCount} Input Tab fields, ${sites.length} sites, ${rates.length} key rates`);

  const fileOpp = opportunityFromFilename(fileName);
  let opportunityId = "UNKNOWN";
  if (header.opportunityId && String(header.opportunityId).trim()) {
    opportunityId = String(header.opportunityId).trim();
  } else if (fileOpp) {
    opportunityId = fileOpp;
    header.opportunityId = fileOpp;
    header.opportunityIdSource = "filename";
    warnings.push(`Filled opportunityId from filename: ${fileOpp}`);
    conf = Math.min(1, conf + 0.15);
  }

  const enoughLines = lineItems.length >= 20;
  const hasId = opportunityId !== "UNKNOWN";
  let quarantine = !hasId || (conf < 0.45 && !enoughLines) || (!fp.matched && lineItems.length < 10);

  if (hasId && lineItems.length >= 20) {
    warnings.push("POC auto-load: opportunity id + line items");
    conf = Math.max(conf, 0.7);
    quarantine = false;
  } else if (hasId && resolved["Internal Budget"] && lineItems.length >= 10) {
    warnings.push("POC auto-load: aliased Internal Budget sheet");
    conf = Math.max(conf, 0.65);
    quarantine = false;
  } else if (enoughLines && hasId && !fp.matched) {
    warnings.push("Loaded with sheet aliases / partial fingerprint");
    conf = Math.max(conf, 0.75);
    quarantine = false;
  }

  const coreSites = sites.reduce((sum, s) => sum + (typeof s.coreSites === "number" ? s.coreSites : 0), 0);
  drivers.coreSites = coreSites || drivers.coreSites;

  // Defaults used by UI formula demo if missing
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
      fieldCount
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
      createdAt: importedAt
    },
    lineItems,
    matchedInputLabels: matched
  };
}

module.exports = {
  parseWorkbookBuffer,
  opportunityFromFilename
};
