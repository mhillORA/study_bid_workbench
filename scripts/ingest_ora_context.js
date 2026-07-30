const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const src = path.join(
  "C:/Users/shue1/Downloads/Ora_Intelligence_Context_Document_v2_1.html"
);
const docsHtml = path.join(root, "docs", "ora-intelligence-context-v2.html");
const txtOut = path.join(root, "api", "src", "oraIntelligenceContext.txt");
const publicHtml = path.join(root, "ora-intelligence-context-v2.html");

fs.mkdirSync(path.dirname(docsHtml), { recursive: true });
fs.copyFileSync(src, docsHtml);
fs.copyFileSync(src, publicHtml);

const html = fs.readFileSync(docsHtml, "utf8");
let text = html
  .replace(/<style[\s\S]*?<\/style>/gi, "\n")
  .replace(/<script[\s\S]*?<\/script>/gi, "\n");
text = text
  .replace(/<\/(p|div|h[1-6]|li|tr|table|br|pre)>/gi, "\n")
  .replace(/<li[^>]*>/gi, "- ")
  .replace(/<[^>]+>/g, " ");
text = text
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/[ \t]+\n/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .replace(/[ \t]{2,}/g, " ")
  .trim();

fs.mkdirSync(path.dirname(txtOut), { recursive: true });
fs.writeFileSync(txtOut, text, "utf8");
console.log({
  htmlBytes: html.length,
  textChars: text.length,
  approxTokens: Math.round(text.length / 4),
  docsHtml,
  publicHtml,
  txtOut
});
