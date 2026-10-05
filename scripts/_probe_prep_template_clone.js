/**
 * Pressure-test: clone Sunhawk prep-sheet format for Cloudbreak via Monet Foundry.
 * Writes HTML to scripts/_out_cloudbreak_sunhawk_format.html
 * Usage: node scripts/_probe_prep_template_clone.js
 */
const fs = require("fs");
const path = require("path");

function loadEnvFile(fp) {
  if (!fs.existsSync(fp)) return;
  if (fp.endsWith(".json")) {
    try {
      const j = JSON.parse(fs.readFileSync(fp, "utf8"));
      const v = j.Values || j;
      for (const [k, val] of Object.entries(v)) {
        if (!process.env[k] && val != null) process.env[k] = String(val);
      }
    } catch (_) {}
    return;
  }
  for (const line of fs.readFileSync(fp, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!process.env[m[1].trim()]) process.env[m[1].trim()] = v;
  }
}

loadEnvFile(path.join(__dirname, "..", ".env"));
loadEnvFile(path.join(__dirname, "..", "api", ".env"));

const {
  pickHtmlTemplate,
  wantsTemplateClone,
  extractSectionHeaders
} = require("../api/src/htmlReportTemplate");
const { askAi, foundryAgentConfig } = require("../api/src/askClaude");

(async () => {
  // Prefer FA settings when local env missing
  if (!process.env.BUDDY_FOUNDRY_API_KEY) {
    try {
      const { execSync } = require("child_process");
      const raw = execSync(
        'az functionapp config appsettings list -g RG_Workloads -n ora-buddy-api -o json',
        { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
      );
      const settings = JSON.parse(raw);
      for (const s of settings) {
        if (/^(BUDDY_FOUNDRY|FOUNDRY_AGENT|BUDDY_DISPLAY)/.test(s.name) && s.value) {
          process.env[s.name] = s.value;
        }
      }
    } catch (err) {
      console.error("Could not load FA settings:", err.message || err);
    }
  }

  const sunhawkPath = String.raw`c:\Users\shue1\Downloads\Sunhawk_DryEye_PrepSheet.html`;
  const cloudPath = String.raw`c:\Users\shue1\Downloads\AAO 2026  Cloudbreak Meeting Prep.html`;
  const sunhawk = fs.readFileSync(sunhawkPath, "utf8");
  const cloud = fs.readFileSync(cloudPath, "utf8");

  const q =
    "Build me a BD call / meeting prep sheet for Cloudbreak Therapeutics just like this SunHawk template. Same CSS, cards, KPI strip, alerts, tables, questions, and talking points structure — fill with Cloudbreak / CBT-001 / pterygium / AAO 2026 context. Emit HTML_REPORT.";

  const tpl = pickHtmlTemplate(
    [{ name: "Sunhawk_DryEye_PrepSheet.html", ok: true, text: sunhawk, mimeType: "text/html" }],
    q
  );
  console.log("TEMPLATE", {
    picked: Boolean(tpl),
    name: tpl?.name,
    sections: tpl?.sections,
    clone: wantsTemplateClone(q),
    cloudSections: extractSectionHeaders(cloud)
  });

  const ag = foundryAgentConfig("deep");
  console.log("AGENT", { enabled: ag.enabled, reason: ag.reason || null });
  if (!ag.enabled) {
    process.exit(2);
  }

  const started = Date.now();
  const result = await askAi({
    question: q,
    history: [],
    tier: "deep",
    context: {
      wantsHtmlVisual: true,
      wantsDocumentExport: true,
      answerFocus: "feasibility",
      workflow: "feasibility",
      htmlTemplate: {
        name: tpl.name,
        title: tpl.title,
        sections: tpl.sections,
        charCount: tpl.charCount,
        sticky: true,
        cloneRequested: true,
        html: tpl.html
      },
      note: "PREP TEMPLATE CLONE PRESSURE TEST — clone SunHawk format for Cloudbreak."
    }
  });

  const answer = String(result.answer || "");
  const m = answer.match(/HTML_REPORT_START\s*([\s\S]*?)\s*HTML_REPORT_END/i);
  const html = m ? m[1].trim() : null;
  const outPath = path.join(__dirname, "_out_cloudbreak_sunhawk_format.html");
  if (html) fs.writeFileSync(outPath, html, "utf8");

  const checks = {
    hasHtml: Boolean(html),
    hasStyle: html ? /<style/i.test(html) : false,
    hasHeader: html ? /class=["']header["']|\.header/i.test(html) : false,
    hasCard: html ? /class=["']card["']/i.test(html) : false,
    mentionsCloudbreak: html ? /cloudbreak/i.test(html) : false,
    notSunhawkTitle: html ? !/SunHawk Vision Biotech — BD Call Prep/i.test(html) : false,
    hasKpiOrAlert: html ? /kpi|alert/i.test(html) : false,
    ms: Date.now() - started,
    provider: result.provider,
    outPath: html ? outPath : null,
    answerChars: answer.length,
    htmlChars: html ? html.length : 0
  };
  console.log("RESULT", JSON.stringify(checks, null, 2));
  if (!html) {
    console.log("---ANSWER HEAD---");
    console.log(answer.slice(0, 1500));
  }
  const ok =
    checks.hasHtml &&
    checks.hasStyle &&
    checks.hasCard &&
    checks.mentionsCloudbreak &&
    checks.notSunhawkTitle;
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error("FATAL", err && err.stack ? err.stack : err);
  process.exit(1);
});
