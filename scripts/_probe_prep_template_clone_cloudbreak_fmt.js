/**
 * Clone Cloudbreak AAO prep format for SunHawk — second format pressure test.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function loadEnvFile(fp) {
  if (!fs.existsSync(fp)) return;
  for (const line of fs.readFileSync(fp, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1].trim()]) process.env[m[1].trim()] = v;
  }
}
loadEnvFile(path.join(__dirname, "..", ".env"));
loadEnvFile(path.join(__dirname, "..", "api", ".env"));
if (!process.env.BUDDY_FOUNDRY_API_KEY) {
  const raw = execSync('az functionapp config appsettings list -g RG_Workloads -n ora-buddy-api -o json', {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  for (const s of JSON.parse(raw)) {
    if (/^(BUDDY_FOUNDRY|FOUNDRY_AGENT|BUDDY_DISPLAY)/.test(s.name) && s.value) process.env[s.name] = s.value;
  }
}

const { pickHtmlTemplate, wantsTemplateClone } = require("../api/src/htmlReportTemplate");
const { askAi, foundryAgentConfig } = require("../api/src/askClaude");

(async () => {
  const cloudPath = String.raw`c:\Users\shue1\Downloads\AAO 2026  Cloudbreak Meeting Prep.html`;
  const cloud = fs.readFileSync(cloudPath, "utf8");
  const q =
    "Build a meeting prep leave-behind for SunHawk Vision Biotech in the EXACT same format as this Cloudbreak AAO prep HTML — same simple card sections (news, company snapshot, pipeline, Ora relevance, competitive landscape, key questions, talking points). Emit HTML_REPORT.";
  const tpl = pickHtmlTemplate(
    [{ name: "AAO_Cloudbreak_Meeting_Prep.html", ok: true, text: cloud, mimeType: "text/html" }],
    q
  );
  console.log("TEMPLATE", { name: tpl?.name, sections: tpl?.sections, clone: wantsTemplateClone(q) });
  if (!foundryAgentConfig("deep").enabled) process.exit(2);

  const result = await askAi({
    question: q,
    history: [],
    tier: "deep",
    context: {
      wantsHtmlVisual: true,
      htmlTemplate: {
        name: tpl.name,
        title: tpl.title,
        sections: tpl.sections,
        charCount: tpl.charCount,
        sticky: true,
        cloneRequested: true,
        html: tpl.html
      }
    }
  });
  const answer = String(result.answer || "");
  const m = answer.match(/HTML_REPORT_START\s*([\s\S]*?)\s*HTML_REPORT_END/i);
  const html = m ? m[1].trim() : null;
  const out = path.join(__dirname, "_out_sunhawk_cloudbreak_format.html");
  const dl = String.raw`c:\Users\shue1\Downloads\Monet_Sunhawk_Prep_CloudbreakFormat.html`;
  if (html) {
    fs.writeFileSync(out, html, "utf8");
    fs.writeFileSync(dl, html, "utf8");
  }
  const ok = Boolean(html) && /sunhawk/i.test(html) && /card-hdr/i.test(html) && !/Cloudbreak — AAO/i.test(html);
  console.log(JSON.stringify({ ok, provider: result.provider, htmlChars: html?.length || 0, dl }, null, 2));
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
