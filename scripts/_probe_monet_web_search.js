/**
 * Smoke-test: Monet Foundry agent can use web search for a live public fact.
 * Usage: node scripts/_probe_monet_web_search.js
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
    } catch (_) {
      /* ignore */
    }
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
loadEnvFile(path.join(__dirname, "..", "api", "local.settings.json"));

const { askAi, providerStatus, foundryAgentConfig } = require("../api/src/askClaude");

(async () => {
  const st = providerStatus();
  const ag = foundryAgentConfig("deep");
  let urlHost = null;
  try {
    urlHost = ag.url ? new URL(ag.url).host : null;
  } catch (_) {
    urlHost = "bad-url";
  }
  console.log(
    "CONFIG",
    JSON.stringify({
      displayName: st.displayName || null,
      enabled: ag.enabled,
      reason: ag.reason || null,
      urlHost,
      agentFrom: ag.from || null
    })
  );
  if (!ag.enabled) {
    console.error("FAIL: Foundry agent not configured");
    process.exit(2);
  }

  // Obscure enough that a good answer almost certainly needs live web search
  const today = new Date().toISOString().slice(0, 10);
  const question =
    `Search the live web right now (do not use memory). ` +
    `What is the current UTC date according to time.is or worldtimeapi, and what is one headline from Reuters or AP News published today (${today})? ` +
    `Reply with [[h]]Web check[[/h]] then two short lines. Say explicitly that you used web search.`;

  const started = Date.now();
  const result = await askAi({
    question,
    context: {
      generalKnowledgeAsk: true,
      moneyIntent: "public_company",
      router: { tools: ["web_search"], intent: "general_knowledge" },
      note: "WEB SEARCH PROBE — use your Foundry web search tool. No Cosmos packs."
    },
    history: [],
    tier: "deep"
  });
  const ms = Date.now() - started;
  const answer = String(result.answer || "");
  const lower = answer.toLowerCase();
  const mentionsSearch =
    /\b(web search|searched|from the web|live web|reuters|ap news|time\.is|worldtimeapi)\b/i.test(
      answer
    );
  const hasDateLike = /\b20\d{2}-\d{2}-\d{2}\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
    answer
  );
  const ok =
    result.provider !== "error" &&
    answer.length > 40 &&
    (mentionsSearch || hasDateLike);

  console.log(
    "RESULT",
    JSON.stringify({
      ok,
      provider: result.provider,
      model: result.model || null,
      ms,
      answerChars: answer.length,
      mentionsSearch,
      hasDateLike,
      agentError: result.agentError || result.error || null
    })
  );
  console.log("---ANSWER---");
  console.log(answer.slice(0, 2500));
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error("FATAL", err && err.message ? err.message : err);
  process.exit(1);
});
