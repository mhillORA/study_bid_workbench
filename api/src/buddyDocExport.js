/**
 * Build downloadable Buddy artifacts (HTML / DOCX) from LLM HTML reports.
 * PDF is offered in the UI via browser Print → Save as PDF (keeps API package under SWA limits).
 */

const MAX_EXPORT_CHARS = 200000;

function extractHtmlReport(text) {
  const src = String(text || "");
  const re = /HTML_REPORT_START\s*([\s\S]*?)\s*HTML_REPORT_END/i;
  const m = src.match(re);
  if (!m) return { answer: src.trim(), html: null };
  const html = String(m[1] || "").trim();
  const answer = src.replace(re, "\n").trim();
  return { answer, html: html || null };
}

function wantsDocumentExport(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  return (
    /\b(pdf|docx|word|powerpoint|pptx|xlsx|excel|spreadsheet)\b/.test(q) ||
    /\b(document|doc|memo|one[- ]pager|onepager|proposal|bid\s*pack|leave[- ]behind|handout|feasibility(\s+report)?|win\s+themes?|call\s+prep|meeting\s+prep)\b/.test(
      q
    ) ||
    /\b(make|produce|build|create|generate|write|draft|export|download|develop|help\s+me)\b.{0,80}\b(doc|document|pdf|word|docx|report|proposal|memo|deck|slide|form|feasibility|win\s+themes?|template)\b/.test(
      q
    ) ||
    /\b(follow|using|from|match|based on|in\s+my|standard)\b.{0,40}\b(brand|branding|template|style|styling|guidelines?|form|format)\b/.test(
      q
    ) ||
    /\b(brand|branding|template|style guide|guidelines?)\b/.test(q)
  );
}

function requestedFormats(question) {
  const q = String(question || "").toLowerCase();
  const formats = new Set(["html"]);
  if (/\b(docx|word|\.doc)\b/.test(q) || wantsDocumentExport(q)) formats.add("docx");
  return [...formats];
}

function safeFilename(title, ext) {
  const base =
    String(title || "ora-document")
      .replace(/[^\w\-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60)
      .toLowerCase() || "ora-document";
  const day = new Date().toISOString().slice(0, 10);
  return `${base}-${day}.${ext}`;
}

function extractTitle(html, question) {
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m && m[1].trim()) return m[1].replace(/<[^>]+>/g, "").trim().slice(0, 120);
  const h = String(html || "").match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h && h[1].trim()) return h[1].replace(/<[^>]+>/g, "").trim().slice(0, 120);
  const q = String(question || "").trim();
  if (q) return q.slice(0, 80);
  return "Ora document";
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function htmlToDocxBuffer(html, title) {
  let HTMLtoDOCX;
  try {
    HTMLtoDOCX = require("html-to-docx");
  } catch {
    throw new Error("html-to-docx not installed");
  }
  let source = String(html || "").trim().slice(0, MAX_EXPORT_CHARS);
  if (!/^<!DOCTYPE|^<html/i.test(source)) {
    source = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeXml(
      title || "Ora document"
    )}</title></head><body>${source}</body></html>`;
  }
  const out = await HTMLtoDOCX(source, null, {
    title: title || "Ora document",
    margins: { top: 720, right: 720, bottom: 720, left: 720 }
  });
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

/**
 * @returns {Promise<{answer:string, html:string|null, title:string, exports:Array}>}
 */
async function buildBuddyDocExports(answerText, question) {
  const { answer, html } = extractHtmlReport(answerText);
  if (!html) {
    return { answer: answerText, html: null, title: null, exports: [] };
  }

  const title = extractTitle(html, question);
  const formats = requestedFormats(question);
  const exports = [];

  if (formats.includes("html")) {
    exports.push({
      format: "html",
      filename: safeFilename(title, "html"),
      mimeType: "text/html;charset=utf-8",
      contentBase64: Buffer.from(html, "utf8").toString("base64")
    });
  }

  if (formats.includes("docx")) {
    try {
      const docx = await htmlToDocxBuffer(html, title);
      exports.push({
        format: "docx",
        filename: safeFilename(title, "docx"),
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        contentBase64: docx.toString("base64")
      });
    } catch (err) {
      exports.push({ format: "docx", ok: false, error: String(err.message || err) });
    }
  }

  return { answer, html, title, exports: exports.filter((e) => e.contentBase64 || e.error) };
}

module.exports = {
  extractHtmlReport,
  wantsDocumentExport,
  requestedFormats,
  buildBuddyDocExports
};
