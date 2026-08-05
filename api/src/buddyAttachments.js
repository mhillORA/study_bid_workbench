/**
 * Buddy chat attachments — extract text for LLM context.
 * Supports: txt/md/csv/json/html, xlsx/xls/csv via ExcelJS, pdf, docx.
 */

const ExcelJS = require("exceljs");

const MAX_FILES = 4;
const MAX_BYTES_EACH = 4 * 1024 * 1024;
const MAX_TEXT_CHARS = 80000;
const MAX_TOTAL_CHARS = 120000;

function extOf(name) {
  const m = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

function decodeAttachment(att) {
  const name = String(att?.name || "upload").slice(0, 200);
  const mimeType = String(att?.mimeType || "").slice(0, 120);
  const encoding = String(att?.encoding || "utf8").toLowerCase();
  const raw = att?.content;
  if (raw == null || raw === "") {
    return { name, mimeType, error: "empty content" };
  }
  let buffer;
  if (encoding === "base64") {
    try {
      buffer = Buffer.from(String(raw), "base64");
    } catch {
      return { name, mimeType, error: "invalid base64" };
    }
  } else {
    buffer = Buffer.from(String(raw), "utf8");
  }
  if (buffer.length > MAX_BYTES_EACH) {
    return { name, mimeType, error: `file too large (max ${MAX_BYTES_EACH / (1024 * 1024)} MB)` };
  }
  return { name, mimeType, buffer };
}

async function extractFromXlsx(buffer, name) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const parts = [];
  let rows = 0;
  for (const ws of wb.worksheets) {
    if (!ws || rows >= 800) break;
    parts.push(`--- Sheet: ${ws.name} ---`);
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rows >= 800) return;
      const vals = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        if (colNumber > 40) return;
        let v = cell.value;
        if (v && typeof v === "object") {
          if (v.text != null) v = v.text;
          else if (v.result != null) v = v.result;
          else if (v.richText) v = v.richText.map((t) => t.text).join("");
          else v = JSON.stringify(v);
        }
        if (v == null || v === "") return;
        vals.push(String(v));
      });
      if (vals.length) {
        parts.push(vals.join("\t"));
        rows += 1;
      }
      if (rowNumber > 500) return false;
    });
  }
  return parts.join("\n").slice(0, MAX_TEXT_CHARS);
}

async function extractFromPdf(buffer) {
  let PDFParse;
  try {
    ({ PDFParse } = require("pdf-parse"));
  } catch {
    throw new Error("PDF support not installed on API (pdf-parse)");
  }
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return String(result?.text || "").slice(0, MAX_TEXT_CHARS);
  } finally {
    try {
      await parser.destroy();
    } catch (_) {}
  }
}

async function extractFromDocx(buffer) {
  let mammoth;
  try {
    mammoth = require("mammoth");
  } catch {
    throw new Error("DOCX support not installed on API (mammoth)");
  }
  const result = await mammoth.extractRawText({ buffer });
  return String(result?.value || "").slice(0, MAX_TEXT_CHARS);
}

async function extractText(name, mimeType, buffer) {
  const ext = extOf(name);
  const mime = String(mimeType || "").toLowerCase();

  if (
    ext === "txt" ||
    ext === "md" ||
    ext === "markdown" ||
    ext === "csv" ||
    ext === "json" ||
    ext === "html" ||
    ext === "htm" ||
    ext === "log" ||
    mime.startsWith("text/") ||
    mime === "application/json"
  ) {
    return buffer.toString("utf8").slice(0, MAX_TEXT_CHARS);
  }

  if (ext === "xlsx" || ext === "xlsm" || mime.includes("spreadsheetml")) {
    return extractFromXlsx(buffer, name);
  }

  if (ext === "pdf" || mime === "application/pdf") {
    return extractFromPdf(buffer);
  }

  if (ext === "docx" || mime.includes("wordprocessingml")) {
    return extractFromDocx(buffer);
  }

  if (ext === "doc") {
    throw new Error("Legacy .doc not supported — save as .docx or PDF");
  }

  // Last resort: try utf8 (works for some emails / mislabeled text)
  const asText = buffer.toString("utf8");
  if (/[\x00-\x08\x0e-\x1f]/.test(asText.slice(0, 2000))) {
    throw new Error(`Unsupported file type .${ext || "unknown"} — use PDF, DOCX, XLSX, TXT, CSV, or MD`);
  }
  return asText.slice(0, MAX_TEXT_CHARS);
}

/**
 * @param {Array<{name?:string,mimeType?:string,encoding?:string,content?:string}>} attachments
 * @returns {Promise<{files: Array<object>, totalChars: number}>}
 */
async function normalizeBuddyAttachments(attachments) {
  const list = Array.isArray(attachments) ? attachments.slice(0, MAX_FILES) : [];
  const files = [];
  let totalChars = 0;

  for (const att of list) {
    const decoded = decodeAttachment(att);
    if (decoded.error) {
      files.push({
        name: decoded.name,
        mimeType: decoded.mimeType,
        ok: false,
        error: decoded.error
      });
      continue;
    }
    try {
      let text = await extractText(decoded.name, decoded.mimeType, decoded.buffer);
      text = String(text || "").replace(/\u0000/g, "").trim();
      if (!text) {
        files.push({
          name: decoded.name,
          mimeType: decoded.mimeType,
          ok: false,
          error: "no extractable text"
        });
        continue;
      }
      const room = Math.max(0, MAX_TOTAL_CHARS - totalChars);
      if (room <= 0) {
        files.push({
          name: decoded.name,
          mimeType: decoded.mimeType,
          ok: false,
          error: "skipped — attachment text budget full"
        });
        continue;
      }
      if (text.length > room) text = text.slice(0, room);
      totalChars += text.length;
      files.push({
        name: decoded.name,
        mimeType: decoded.mimeType,
        ok: true,
        charCount: text.length,
        byteLength: decoded.buffer.length,
        text
      });
    } catch (err) {
      files.push({
        name: decoded.name,
        mimeType: decoded.mimeType,
        ok: false,
        error: String(err.message || err)
      });
    }
  }

  return { files, totalChars, maxFiles: MAX_FILES, maxBytesEach: MAX_BYTES_EACH };
}

module.exports = {
  normalizeBuddyAttachments,
  MAX_FILES,
  MAX_BYTES_EACH,
  MAX_TEXT_CHARS,
  MAX_TOTAL_CHARS
};
