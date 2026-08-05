/**
 * Build downloadable Buddy artifacts (HTML / PDF / DOCX) from LLM HTML reports.
 */

const PDFDocument = require("pdfkit");

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
  const formats = new Set();
  if (/\bpdf\b/.test(q)) formats.add("pdf");
  if (/\b(docx|word|\.doc)\b/.test(q)) formats.add("docx");
  if (/\b(xlsx|excel|spreadsheet)\b/.test(q)) formats.add("xlsx");
  // Default deliverables when they ask to "create a doc" / branding pack
  if (!formats.size && wantsDocumentExport(q)) {
    formats.add("pdf");
    formats.add("docx");
    formats.add("html");
  } else {
    formats.add("html");
  }
  return [...formats];
}

function safeFilename(title, ext) {
  const base = String(title || "ora-document")
    .replace(/[^\w\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
    .toLowerCase() || "ora-document";
  const day = new Date().toISOString().slice(0, 10);
  return `${base}-${day}.${ext}`;
}

function stripHtmlToBlocks(html) {
  let s = String(html || "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<(h[1-6])[^>]*>/gi, (_, tag) => `\n##${tag.toUpperCase()}## `);
  s = s.replace(/<li[^>]*>/gi, "\n• ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s.slice(0, MAX_EXPORT_CHARS);
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

function htmlToPdfBuffer(html, title) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        margin: 54,
        size: "LETTER",
        info: { Title: title || "Ora document", Author: "Ora Ask Buddy" }
      });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.fillColor("#1B2A4A").fontSize(18).text(title || "Ora document", { align: "left" });
      doc.moveDown(0.4);
      doc
        .strokeColor("#1A7F8E")
        .lineWidth(2)
        .moveTo(54, doc.y)
        .lineTo(558, doc.y)
        .stroke();
      doc.moveDown(0.8);

      const body = stripHtmlToBlocks(html);
      const lines = body.split(/\n/);
      for (const line of lines) {
        const t = line.trim();
        if (!t) {
          doc.moveDown(0.35);
          continue;
        }
        if (/^##H1##\s*/i.test(t)) {
          doc.fillColor("#1B2A4A").fontSize(16).text(t.replace(/^##H1##\s*/i, ""), { paragraphGap: 6 });
        } else if (/^##H2##\s*/i.test(t)) {
          doc.fillColor("#1A7F8E").fontSize(13).text(t.replace(/^##H2##\s*/i, ""), { paragraphGap: 4 });
        } else if (/^##H[3-6]##\s*/i.test(t)) {
          doc.fillColor("#1B2A4A").fontSize(11).text(t.replace(/^##H[3-6]##\s*/i, ""), { paragraphGap: 3 });
        } else if (t.startsWith("• ")) {
          doc.fillColor("#1B2A4A").fontSize(10).text(t, { indent: 12, paragraphGap: 2 });
        } else {
          doc.fillColor("#1B2A4A").fontSize(10).text(t, { paragraphGap: 4, lineGap: 2 });
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function htmlToDocxBuffer(html, title) {
  let HTMLtoDOCX;
  try {
    HTMLtoDOCX = require("html-to-docx");
  } catch {
    throw new Error("html-to-docx not installed");
  }
  let source = String(html || "").trim();
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

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

  if (formats.includes("pdf")) {
    try {
      const pdf = await htmlToPdfBuffer(html, title);
      exports.push({
        format: "pdf",
        filename: safeFilename(title, "pdf"),
        mimeType: "application/pdf",
        contentBase64: pdf.toString("base64")
      });
    } catch (err) {
      exports.push({ format: "pdf", ok: false, error: String(err.message || err) });
    }
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
