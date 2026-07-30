/**
 * TrialHub Excel upload → Cosmos ora_trialhub_trials.
 * Full-file ingest each upload; dedupe by NCT (no duplicate trials).
 *
 * Expects TrialHub "Trials Search Data" export (.xlsx) with sheet
 * "Trials (Detailed)" (falls back to "Trials").
 */

const ExcelJS = require("exceljs");
const { INDICATION_GROUPS } = require("./intelligence");

const CONTAINER = "ora_trialhub_trials";
const DOC_TYPE = "ora_trialhub_trials";
const DATASET = "ora_clinical_intelligence";
const SCHEMA_VERSION = 2;
const PK_SENTINEL = "_unknown";
const WORKERS = 8;

const COL = {
  nct: "Trial Id (link)",
  officialTitle: "Official Title",
  title: "Title",
  phase: "Phase",
  patients: "Patients",
  status: "Status",
  sponsor: "Sponsor",
  leadSponsorType: "Lead Sponsor Type",
  indications: "Indications",
  countries: "Countries",
  countriesAll: "Countries (All)",
  countriesCount: "Countries Count",
  studyType: "Study Type",
  primaryPurpose: "Primary Purpose",
  plannedSites: "Planned Number Of Sites",
  actualSites: "Actual Number Of Sites",
  plannedPsm: "Planned P/S/M",
  actualPsm: "Actual P/S/M",
  plannedRecruitDays: "Planned Recruitment (days)",
  actualRecruitDays: "Actual Recruitment (days)",
  treatmentMonths: "Treatment Duration (months)",
  dropRate: "Drop Rate",
  actualStart: "Actual Start Date",
  actualLpi: "Actual Last Patient In Estimation",
  plannedPrimaryCompletion: "Planned Primary Completion",
  actualPrimaryCompletion: "Actual Primary Completion",
  plannedStudyCompletion: "Planned Study Completion",
  actualStudyCompletion: "Actual Study Completion"
};

function blankToNull(v) {
  const unwrapped = unwrapCell(v);
  if (unwrapped == null) return null;
  if (typeof unwrapped === "number" && Number.isFinite(unwrapped)) return unwrapped;
  const s = String(unwrapped).trim();
  if (!s || s === "-" || s === "—" || /^n\/?a$/i.test(s)) return null;
  return s;
}

function unwrapCell(v) {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    // exceljs hyperlink: { text, hyperlink }
    if (v.text != null) return unwrapCell(v.text);
    if (v.hyperlink != null && typeof v.hyperlink === "string") {
      const m = v.hyperlink.match(/\b(NCT\d{8})\b/i);
      if (m) return m[1].toUpperCase();
      return v.hyperlink;
    }
    // rich text
    if (Array.isArray(v.richText)) {
      return v.richText.map((p) => p.text || "").join("");
    }
    if (v.result != null) return unwrapCell(v.result); // formula
    if (v.sharedString != null) return unwrapCell(v.sharedString);
  }
  return v;
}

function toNumber(v) {
  const unwrapped = unwrapCell(v);
  if (unwrapped == null || unwrapped === "") return null;
  if (typeof unwrapped === "number" && Number.isFinite(unwrapped)) return unwrapped;
  const s = String(unwrapped).trim().replace(/,/g, "");
  if (!s || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeNct(raw) {
  const s = String(unwrapCell(raw) || "")
    .trim()
    .toUpperCase();
  const m = s.match(/\b(NCT\d{8})\b/);
  return m ? m[1] : null;
}

function sheetHeaderMap(rowValues) {
  const map = {};
  (rowValues || []).forEach((v, i) => {
    const key = String(unwrapCell(v) || "").trim();
    if (key && map[key] == null) map[key] = i;
  });
  return map;
}

function cell(rowValues, headerMap, colName) {
  const idx = headerMap[colName];
  if (idx == null) return null;
  return rowValues[idx];
}

function primaryIndication(raw) {
  const s = blankToNull(raw);
  if (!s) return PK_SENTINEL;
  const parts = s
    .split(/[;|]/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts[0] || PK_SENTINEL;
}

function inOraIndication(indicationsText) {
  const hay = String(indicationsText || "").toLowerCase();
  if (!hay) return false;
  for (const group of INDICATION_GROUPS || []) {
    for (const label of group) {
      const needle = String(label || "")
        .toLowerCase()
        .trim();
      if (needle.length >= 3 && hay.includes(needle)) return true;
    }
  }
  return false;
}

function rowToDoc(rowValues, headerMap, meta) {
  const nct = normalizeNct(cell(rowValues, headerMap, COL.nct));
  if (!nct) return null;

  const indicationsRaw = blankToNull(cell(rowValues, headerMap, COL.indications));
  const title =
    blankToNull(cell(rowValues, headerMap, COL.title)) ||
    blankToNull(cell(rowValues, headerMap, COL.officialTitle));
  const thActual = toNumber(cell(rowValues, headerMap, COL.actualPsm));
  const thPlanned = toNumber(cell(rowValues, headerMap, COL.plannedPsm));
  const patients = toNumber(cell(rowValues, headerMap, COL.patients));
  const plannedSites = toNumber(cell(rowValues, headerMap, COL.plannedSites));
  const actualSites = toNumber(cell(rowValues, headerMap, COL.actualSites));
  const recruitDays =
    toNumber(cell(rowValues, headerMap, COL.actualRecruitDays)) ??
    toNumber(cell(rowValues, headerMap, COL.plannedRecruitDays));
  const countries =
    blankToNull(cell(rowValues, headerMap, COL.countries)) ||
    blankToNull(cell(rowValues, headerMap, COL.countriesAll));
  const nCountries =
    toNumber(cell(rowValues, headerMap, COL.countriesCount)) ??
    (countries
      ? countries
          .split(/[,;]/)
          .map((x) => x.trim())
          .filter(Boolean).length
      : null);

  const indicationPk = primaryIndication(indicationsRaw);

  return {
    id: nct,
    nct,
    title,
    phase: blankToNull(cell(rowValues, headerMap, COL.phase)),
    status: blankToNull(cell(rowValues, headerMap, COL.status)),
    sponsor: blankToNull(cell(rowValues, headerMap, COL.sponsor)),
    lead_sponsor_type: blankToNull(cell(rowValues, headerMap, COL.leadSponsorType)),
    primary_raw: indicationsRaw,
    indication: indicationPk,
    indications: indicationsRaw,
    in_ora_indication: inOraIndication(indicationsRaw),
    study_type: blankToNull(cell(rowValues, headerMap, COL.studyType)),
    primary_purpose: blankToNull(cell(rowValues, headerMap, COL.primaryPurpose)),
    patients,
    planned_sites: plannedSites,
    actual_sites: actualSites,
    recruit_days: recruitDays,
    psm_common: thActual != null ? thActual : thPlanned,
    th_actual_psm: thActual,
    th_planned_psm: thPlanned,
    drop_rate: toNumber(cell(rowValues, headerMap, COL.dropRate)),
    n_countries: nCountries,
    countries,
    actual_start: blankToNull(cell(rowValues, headerMap, COL.actualStart)),
    actual_lpi: blankToNull(cell(rowValues, headerMap, COL.actualLpi)),
    planned_primary_completion: blankToNull(cell(rowValues, headerMap, COL.plannedPrimaryCompletion)),
    actual_primary_completion: blankToNull(cell(rowValues, headerMap, COL.actualPrimaryCompletion)),
    planned_study_completion: blankToNull(cell(rowValues, headerMap, COL.plannedStudyCompletion)),
    actual_study_completion: blankToNull(cell(rowValues, headerMap, COL.actualStudyCompletion)),
    treatment_duration_months: blankToNull(cell(rowValues, headerMap, COL.treatmentMonths)),
    docType: DOC_TYPE,
    dataset: DATASET,
    schemaVersion: SCHEMA_VERSION,
    source: "trialhub_xlsx",
    sourceFile: meta.sourceFile || null,
    importedAt: meta.importedAt,
    uploadedBy: meta.uploadedBy || null
  };
}

async function parseTrialHubBuffer(buffer, fileName = "trialhub.xlsx") {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const preferred = ["Trials (Detailed)", "Trials"];
  let sheet = null;
  for (const name of preferred) {
    sheet = wb.getWorksheet(name);
    if (sheet) break;
  }
  if (!sheet) {
    sheet = wb.worksheets.find((ws) => {
      const row1 = ws.getRow(1).values || [];
      const joined = row1.map((v) => String(v || "")).join("|");
      return /Trial Id/i.test(joined);
    });
  }
  if (!sheet) {
    throw new Error(
      `No Trials sheet found. Expected "Trials (Detailed)" or "Trials". Sheets: ${wb.worksheets
        .map((w) => w.name)
        .join(", ")}`
    );
  }

  let headerMap = null;
  const byNct = new Map();
  let rawRows = 0;
  let skipped = 0;

  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values || [];
    // exceljs row.values is 1-indexed (index 0 unused)
    const cells = values.slice(1);
    if (!headerMap) {
      const map = sheetHeaderMap(cells);
      if (map[COL.nct] != null || Object.keys(map).some((k) => /trial id/i.test(k))) {
        headerMap = map;
        if (headerMap[COL.nct] == null) {
          const alt = Object.keys(map).find((k) => /trial id/i.test(k));
          if (alt) headerMap[COL.nct] = map[alt];
        }
      }
      return;
    }
    // Skip repeated header rows in TrialHub exports
    const first = unwrapCell(cells[headerMap[COL.nct]]);
    if (first && /trial id/i.test(String(first))) return;

    rawRows += 1;
    const nct = normalizeNct(cell(cells, headerMap, COL.nct));
    if (!nct) {
      skipped += 1;
      return;
    }
    const doc = rowToDoc(cells, headerMap, {
      sourceFile: fileName,
      importedAt: new Date().toISOString()
    });
    if (!doc) {
      skipped += 1;
      return;
    }
    // Last row wins within file (no dupes)
    byNct.set(nct, doc);
  });

  if (!headerMap) {
    throw new Error(`Could not find header row with "${COL.nct}" on sheet "${sheet.name}"`);
  }

  return {
    sheet: sheet.name,
    rawRows,
    skipped,
    uniqueTrials: byNct.size,
    docs: [...byNct.values()]
  };
}

async function findExistingByNct(container, nct) {
  const { resources } = await container.items
    .query(
      {
        query: "SELECT c.id, c.indication FROM c WHERE c.nct = @nct OR c.id = @nct",
        parameters: [{ name: "@nct", value: nct }]
      },
      { enableCrossPartitionQuery: true }
    )
    .fetchAll();
  return resources || [];
}

async function deleteExistingForNct(container, nct) {
  const existing = await findExistingByNct(container, nct);
  let deleted = 0;
  for (const row of existing) {
    if (!row?.id) continue;
    const pk = row.indication != null && String(row.indication).trim() !== "" ? row.indication : PK_SENTINEL;
    try {
      await container.item(row.id, pk).delete();
      deleted += 1;
    } catch (err) {
      // Retry with sentinel if PK mismatch from older docs
      if (pk !== PK_SENTINEL) {
        try {
          await container.item(row.id, PK_SENTINEL).delete();
          deleted += 1;
        } catch (_) {
          /* ignore */
        }
      } else {
        throw err;
      }
    }
  }
  return deleted;
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/**
 * Ingest a TrialHub export buffer into Cosmos.
 * Dedupes by NCT within the file and against existing Cosmos docs.
 */
async function ingestTrialHubUpload(getDb, buffer, opts = {}) {
  const fileName = opts.fileName || "trialhub.xlsx";
  const uploadedBy = opts.uploadedBy || null;
  const dryRun = opts.dryRun === true;
  const importedAt = new Date().toISOString();

  const parsed = await parseTrialHubBuffer(buffer, fileName);
  const docs = parsed.docs.map((d) => ({
    ...d,
    importedAt,
    sourceFile: fileName,
    uploadedBy
  }));

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      fileName,
      sheet: parsed.sheet,
      rawRows: parsed.rawRows,
      skipped: parsed.skipped,
      uniqueTrials: parsed.uniqueTrials,
      sample: docs.slice(0, 3).map((d) => ({
        nct: d.nct,
        indication: d.indication,
        status: d.status,
        sponsor: d.sponsor,
        th_actual_psm: d.th_actual_psm
      }))
    };
  }

  const database = getDb();
  try {
    await database.containers.createIfNotExists({
      id: CONTAINER,
      partitionKey: { paths: ["/indication"] }
    });
  } catch (_) {
    /* container may already exist */
  }
  const container = database.container(CONTAINER);

  let upserted = 0;
  let replaced = 0;
  let failed = 0;
  const errors = [];

  const outcomes = await mapPool(docs, WORKERS, async (doc) => {
    try {
      const deleted = await deleteExistingForNct(container, doc.nct);
      await container.items.upsert(doc);
      return { ok: true, deleted };
    } catch (err) {
      return { ok: false, nct: doc.nct, error: String(err.message || err).slice(0, 240) };
    }
  });

  for (const o of outcomes) {
    if (o && o.ok) {
      upserted += 1;
      replaced += o.deleted || 0;
    } else {
      failed += 1;
      if (o && errors.length < 12) {
        errors.push({ nct: o.nct, error: o.error });
      }
    }
  }

  let containerCount = null;
  try {
    const { resources } = await container.items
      .query({ query: "SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t", parameters: [{ name: "@t", value: DOC_TYPE }] })
      .fetchAll();
    containerCount = resources?.[0] ?? null;
  } catch (_) {
    containerCount = null;
  }

  return {
    ok: failed === 0,
    fileName,
    sheet: parsed.sheet,
    rawRows: parsed.rawRows,
    skipped: parsed.skipped,
    uniqueTrials: parsed.uniqueTrials,
    upserted,
    priorDocsRemoved: replaced,
    failed,
    errors: errors.length ? errors : undefined,
    containerCount,
    note:
      "Upserted by NCT (no duplicates). Re-upload updates matching NCTs; other TrialHub rows already in Cosmos are kept (so 3k export chunks can accumulate)."
  };
}

module.exports = {
  parseTrialHubBuffer,
  ingestTrialHubUpload,
  CONTAINER,
  DOC_TYPE
};
