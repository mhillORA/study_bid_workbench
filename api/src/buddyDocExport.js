/**
 * Build downloadable Buddy artifacts (HTML / DOCX) from LLM HTML reports.
 * PDF is offered in the UI via browser Print → Save as PDF (keeps API package under SWA limits).
 */

const MAX_EXPORT_CHARS = 200000;

/** Chat [[h]]/[[i]] must become real HTML in reports (navy headers, red emphasis). */
function normalizeBuddyMarkup(raw) {
  let s = String(raw || "");
  s = s.replace(/\[{1,3}\s*\/\s*([hi])\s*\]{1,3}/gi, (_, t) => `[[/${t.toLowerCase()}]]`);
  s = s.replace(/\[{1,3}\s*([hi])\s*\]{1,3}/gi, (_, t) => `[[${t.toLowerCase()}]]`);
  return s;
}

function convertBuddyMarkupInHtml(html) {
  let s = normalizeBuddyMarkup(html);
  if (!/\[\[\/?[hi]\]\]/i.test(s)) return s;
  s = s.replace(
    /\[\[h\]\]([\s\S]*?)\[\[\/h\]\]/gi,
    (_, inner) =>
      `<div style="color:#1B2A4A;font-weight:700;font-size:1.08rem;margin:0.9rem 0 0.4rem;">${inner}</div>`
  );
  s = s.replace(
    /\[\[i\]\]([\s\S]*?)\[\[\/i\]\]/gi,
    (_, inner) => `<span style="color:#C0392B;font-weight:700;">${inner}</span>`
  );
  // Leftover unpaired tokens
  s = s.replace(/\[\[\/?[hi]\]\]/gi, "");
  return s;
}

function extractHtmlReport(text) {
  const src = String(text || "");
  const startM = src.match(/HTML_REPORT_START/i);
  if (!startM) return { answer: src.trim(), html: null };
  const sIdx = startM.index;
  const afterStart = sIdx + startM[0].length;
  const endM = src.slice(afterStart).match(/HTML_REPORT_END/i);
  let htmlRaw;
  let answer;
  if (endM) {
    const eIdx = afterStart + endM.index;
    htmlRaw = src.slice(afterStart, eIdx).trim();
    answer = (src.slice(0, sIdx) + src.slice(eIdx + endM[0].length)).trim();
  } else {
    // Truncated model output — still salvage the HTML so Buddy can show a visual
    htmlRaw = src.slice(afterStart).trim();
    answer = src.slice(0, sIdx).trim() || "Document ready — open beside chat.";
  }
  const html = convertBuddyMarkupInHtml(htmlRaw);
  return { answer, html: html || null };
}

/** When the model fails to emit HTML_REPORT, still ship a usable Ora-styled visual. */
function synthesizeFallbackHtmlReport(question, context = {}) {
  const ind =
    context.intelligence?.query?.indication ||
    context.intelligence?.indicationBenchmark?.indicationRequested ||
    context.clientStudy?.indication ||
    "";
  const country = context.intelligence?.query?.country || "";
  const ora = context.intelligence?.indicationBenchmark?.ora || null;
  const th = context.intelligence?.indicationBenchmark?.trialhub || null;
  const port = context.portfolio || null;
  const q = String(question || "").slice(0, 200);
  const rows = [];
  if (ora) {
    rows.push(
      `<tr><td>Ora studies (indication)</td><td>${escapeHtmlSynth(String(ora.studyCount ?? "—"))}</td></tr>`,
      `<tr><td>Ora median PSM</td><td>${escapeHtmlSynth(ora.medianPsm != null ? String(ora.medianPsm) : "missing")}</td></tr>`,
      `<tr><td>Ora sites (n)</td><td>${escapeHtmlSynth(String(ora.siteCount ?? ora.nSites ?? "—"))}</td></tr>`
    );
  }
  if (th) {
    rows.push(
      `<tr><td>TrialHub trials</td><td>${escapeHtmlSynth(String(th.trialCount ?? th.n ?? "—"))}</td></tr>`,
      `<tr><td>TrialHub median PSM</td><td>${escapeHtmlSynth(th.medianPsm != null ? String(th.medianPsm) : "missing")}</td></tr>`
    );
  }
  if (port && !port.skipped) {
    rows.push(
      `<tr><td>Portfolio studies matched</td><td>${escapeHtmlSynth(String(port.matchedStudyCount ?? "—"))} / ${escapeHtmlSynth(String(port.databaseStudyCount ?? "—"))}</td></tr>`
    );
  }
  if (!rows.length) {
    rows.push(
      `<tr><td colspan="2">Live packs were thin for this ask — open Ora Clinical Intelligence with an indication, or re-ask with geography.</td></tr>`
    );
  }
  const title = ind
    ? `Ora feasibility snapshot — ${ind}${country ? ` · ${country}` : ""}`
    : "Ora feasibility snapshot";
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtmlSynth(title)}</title>
<style>
body{font-family:Segoe UI,Arial,sans-serif;background:#F0F4F8;color:#1B2A4A;margin:0;padding:24px;line-height:1.5}
.header{background:linear-gradient(135deg,#1B2A4A,#1A7F8E);color:#fff;padding:20px 24px;border-radius:10px;margin-bottom:16px}
.card{background:#fff;border-radius:10px;padding:16px 20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
table{width:100%;border-collapse:collapse;margin-top:8px}
td,th{border-bottom:1px solid #E2E8F0;padding:8px 6px;text-align:left;font-size:14px}
.muted{color:#64748B;font-size:13px}
</style></head><body>
<div class="header"><h1 style="margin:0;font-size:1.35rem">${escapeHtmlSynth(title)}</h1>
<p style="margin:8px 0 0;opacity:.9;font-size:14px">Ask: ${escapeHtmlSynth(q || "—")}</p></div>
<div class="card"><p class="muted">Buddy built this shell because the model reply had no HTML_REPORT block. Numbers below are from attached Cosmos packs only — say if something looks off.</p>
<table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
</body></html>`;
  return html;
}

function escapeHtmlSynth(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
async function buildBuddyDocExports(answerText, question, context = null) {
  let { answer, html } = extractHtmlReport(answerText);
  if (!html && context && (context.wantsHtmlVisual || context.wantsDocumentExport)) {
    html = synthesizeFallbackHtmlReport(question, context);
    answer =
      String(answer || answerText || "").trim() ||
      "Built a feasibility snapshot from Cosmos packs — open beside chat. Ask me to refine layout or add sections.";
  }
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
  convertBuddyMarkupInHtml,
  wantsDocumentExport,
  requestedFormats,
  buildBuddyDocExports,
  synthesizeFallbackHtmlReport
};
