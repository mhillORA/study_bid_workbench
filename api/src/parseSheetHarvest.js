/**
 * Harvest every worksheet into a bounded, queryable dump so uncaptured
 * Ora sheets (SoE, Cash Flow, Client Budget, QC, …) still land in Cosmos.
 */

function cellValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object" && v.text != null) return v.text;
  if (typeof v === "object" && v.result != null) return v.result;
  if (typeof v === "object" && v.richText) {
    return v.richText.map((t) => t.text).join("");
  }
  if (typeof v === "string" && v.startsWith("=")) return null;
  if (typeof v === "object") {
    try {
      return JSON.parse(JSON.stringify(v));
    } catch (_) {
      return String(v);
    }
  }
  return v;
}

const MAX_ROWS = 300;
const MAX_COLS = 30;
const MAX_CELLS_UNSTRUCTURED = 800;
const MAX_SHEETS = 40;

/**
 * @param {import('exceljs').Workbook} wb
 * @param {Record<string,string>} resolvedCanonicalToActual - e.g. { "Input Tab": "Input Tab" }
 */
function harvestAllSheets(wb, resolvedCanonicalToActual = {}) {
  const capturedNames = new Set(Object.values(resolvedCanonicalToActual).filter(Boolean));
  const sheets = [];
  let sheetCount = 0;

  for (const ws of wb.worksheets) {
    if (sheetCount >= MAX_SHEETS) break;
    sheetCount += 1;
    const name = ws.name;
    const role = Object.keys(resolvedCanonicalToActual).find((k) => resolvedCanonicalToActual[k] === name) || null;
    const structured = capturedNames.has(name);

    let maxRow = 0;
    let maxCol = 0;
    const cells = [];
    const labelValuePairs = [];
    const cellBudget = structured ? 0 : MAX_CELLS_UNSTRUCTURED;

    try {
      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber > MAX_ROWS) return;
        if (maxRow < rowNumber) maxRow = rowNumber;
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          if (colNumber > MAX_COLS) return;
          if (maxCol < colNumber) maxCol = colNumber;
          const v = cellValue(cell.value);
          if (v == null || v === "") return;

          if (colNumber === 1 && typeof v === "string" && v.trim()) {
            const next = row.getCell(2);
            const nv = cellValue(next && next.value);
            if (nv != null && nv !== "" && labelValuePairs.length < 300) {
              labelValuePairs.push({
                label: String(v).replace(/\s+/g, " ").trim(),
                value: nv,
                row: rowNumber
              });
            }
          }

          if (cellBudget > 0 && cells.length < cellBudget) {
            cells.push({
              a: cell.address || `R${rowNumber}C${colNumber}`,
              r: rowNumber,
              c: colNumber,
              v: typeof v === "string" ? v.slice(0, 500) : v
            });
          }
        });
      });
    } catch (_) {}

    sheets.push({
      name,
      role,
      structured,
      rowCount: maxRow || (ws.rowCount || 0),
      colCount: maxCol,
      cellCount: cells.length,
      cells: structured ? [] : cells,
      labelValues: labelValuePairs
    });
  }

  return {
    harvestedAt: new Date().toISOString(),
    sheetCount: sheets.length,
    structuredCount: sheets.filter((s) => s.structured).length,
    unstructuredCount: sheets.filter((s) => !s.structured).length,
    sheets
  };
}

module.exports = {
  harvestAllSheets,
  cellValue
};
