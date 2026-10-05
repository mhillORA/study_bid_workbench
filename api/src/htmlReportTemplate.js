/**
 * HTML report / BD prep-sheet templates.
 * Mike uploads Sunhawk/Cloudbreak-style HTML once → Monet clones CSS + sections
 * for new sponsors in the same chat.
 */

function extOf(name) {
  const m = String(name || "")
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

function isHtmlFile(file) {
  if (!file || !file.ok) return false;
  const ext = extOf(file.name);
  const mime = String(file.mimeType || "").toLowerCase();
  const text = String(file.text || "").slice(0, 2000);
  if (ext === "html" || ext === "htm") return true;
  if (mime.includes("text/html")) return true;
  return /<!DOCTYPE\s+html|<html[\s>]/i.test(text);
}

function wantsTemplateClone(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  return (
    /\b(like\s+this|same\s+(format|layout|style|template|structure)|just\s+like|mirror|clone|copy\s+(the\s+)?(format|layout|style|template)|follow\s+(this|the)\s+(format|template|html|prep)|using\s+(this|the)\s+(template|format|prep\s*sheet)|in\s+this\s+format|make\s+(me\s+)?(one|another|a\s+report)\s+like)\b/.test(
      q
    ) ||
    /\b(prep\s*sheet|call\s+prep|meeting\s+prep|bd\s+prep|leave[- ]behind)\b/.test(q) ||
    /\b(build|create|produce|generate|draft|make)\b.{0,60}\b(prep|report|leave[- ]behind)\b/.test(q)
  );
}

function extractStyleBlock(html) {
  const m = String(html || "").match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  return m ? m[1].trim() : "";
}

function extractSectionHeaders(html) {
  const headers = [];
  const re = /class=["'][^"']*card-hdr[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = re.exec(String(html || ""))) && headers.length < 20) {
    const t = String(m[1] || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (t) headers.push(t);
  }
  if (!headers.length) {
    const h2 = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi;
    while ((m = h2.exec(String(html || ""))) && headers.length < 12) {
      const t = String(m[1] || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (t) headers.push(t);
    }
  }
  return headers;
}

function extractTitle(html, fallbackName) {
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) {
    return String(m[1] || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
  }
  return String(fallbackName || "prep sheet").replace(/\.[^.]+$/, "");
}

/**
 * Pick the best HTML file to use as the sticky report template.
 */
function pickHtmlTemplate(files, question) {
  const list = Array.isArray(files) ? files.filter(isHtmlFile) : [];
  if (!list.length) return null;

  const q = String(question || "").toLowerCase();
  const scored = list.map((f) => {
    const name = String(f.name || "").toLowerCase();
    const text = String(f.text || "");
    let score = 1;
    if (/prep|meeting|call|sunhawk|cloudbreak|leave/.test(name)) score += 3;
    if (/card-hdr|kpi-row|\.header|\.wrap/.test(text)) score += 2;
    if (wantsTemplateClone(q)) score += 2;
    if (/<!DOCTYPE\s+html/i.test(text)) score += 1;
    return { f, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].f;
  const html = String(best.text || "").trim();
  if (!html || html.length < 200) return null;

  const style = extractStyleBlock(html);
  const sections = extractSectionHeaders(html);
  return {
    name: best.name || "template.html",
    title: extractTitle(html, best.name),
    html: html.slice(0, 100000),
    style: style.slice(0, 40000),
    sections,
    charCount: html.length,
    sticky: true,
    role: "html_report_template"
  };
}

function formatHtmlTemplateBlock(template) {
  if (!template?.html) return "";
  const parts = [
    "HTML REPORT TEMPLATE (sticky for this chat unless the user attaches a different HTML).",
    "Clone this document's CSS, class names, section order, and card layout for the NEW sponsor/meeting.",
    "Replace company-specific content with facts from Context / Cosmos / CT.gov / web. Never invent Ora numbers.",
    "Keep the same visual language (navy/teal header, .card / .card-hdr, alerts, KPI strip, tables, footer) even when content changes.",
    "Emit a COMPLETE HTML_REPORT_START…END for the new ask — do not return the template unchanged.",
    `Template file: ${template.name || "template.html"}`,
    template.sections?.length
      ? `Section headers to preserve (adapt titles for the new sponsor): ${template.sections.join(" · ")}`
      : "",
    "",
    "TEMPLATE_HTML_START",
    template.html,
    "TEMPLATE_HTML_END"
  ].filter(Boolean);
  return parts.join("\n");
}

module.exports = {
  isHtmlFile,
  wantsTemplateClone,
  pickHtmlTemplate,
  formatHtmlTemplateBlock,
  extractSectionHeaders,
  extractStyleBlock
};
