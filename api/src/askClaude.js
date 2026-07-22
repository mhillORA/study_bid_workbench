/**
 * Study context + LLM ask (Azure OpenAI / Copilot-style first, Claude optional).
 */

const SYSTEM_PROMPT = [
  "You are the Study Bid Workbench assistant for Ora Clinical BD / operations.",
  "Answer questions about clinical study budgets, drivers, departments, line items, and formulas.",
  "Be concise and practical. Prefer numbers and Ora codes when present in context.",
  "If context is missing or incomplete, say what you need.",
  "Do not invent Cosmos data that is not in the provided context.",
  "This is a proof-of-concept — keep answers short unless asked for detail."
].join(" ");

function envSet(name) {
  const v = (process.env[name] || "").trim();
  if (!v || v.includes("SET_IN")) return "";
  return v;
}

function providerStatus() {
  const azure =
    Boolean(envSet("AZURE_OPENAI_ENDPOINT")) &&
    Boolean(envSet("AZURE_OPENAI_API_KEY")) &&
    Boolean(envSet("AZURE_OPENAI_DEPLOYMENT"));
  const claude = Boolean(envSet("ANTHROPIC_API_KEY"));
  return {
    azureOpenAI: azure,
    claude,
    active: azure ? "azure_openai" : claude ? "claude" : null
  };
}

async function getStudyContext(studyId, { getDb }) {
  if (!studyId) return null;
  try {
    const database = getDb();
    const { resources: studies } = await database.container("studies").items
      .query({
        query: "SELECT * FROM c WHERE c.studyId = @id AND c.docType = @t",
        parameters: [
          { name: "@id", value: studyId },
          { name: "@t", value: "study" }
        ]
      })
      .fetchAll();
    const study = studies[0];
    if (!study) return { studyId, note: "No Cosmos study found for that id" };

    let version = null;
    if (study.currentVersionId) {
      try {
        const { resource } = await database
          .container("versions")
          .item(study.currentVersionId, studyId)
          .read();
        version = resource;
      } catch (_) {}
    }

    const { resources: lineSample } = await database.container("lineItems").items
      .query({
        query:
          "SELECT TOP 80 c.oraCode, c.department, c.service, c.units, c.totalHours, c.charge, c.directCost, c.phase FROM c WHERE c.studyId = @id",
        parameters: [{ name: "@id", value: studyId }]
      })
      .fetchAll();

    const byDept = {};
    for (const li of lineSample) {
      const d = li.department || "Other";
      byDept[d] = (byDept[d] || 0) + 1;
    }

    return {
      source: "cosmos",
      study: {
        studyId: study.studyId,
        clientName: study.clientName,
        title: study.title,
        protocol: study.protocol,
        phase: study.phase,
        therapeuticArea: study.therapeuticArea,
        indication: study.indication,
        status: study.status,
        drivers: study.drivers,
        sites: (study.sites || []).slice(0, 20)
      },
      version: version
        ? {
            id: version.id,
            label: version.label,
            lineItemCount: version.lineItemCount,
            totals: version.totals,
            sourceFileName: version.sourceFileName
          }
        : null,
      lineItemSample: lineSample,
      lineItemCountsByDepartment: byDept
    };
  } catch (err) {
    return {
      studyId,
      source: "cosmos_error",
      error: String(err.message || err)
    };
  }
}

function buildHistoryMessages(history) {
  const messages = [];
  if (!Array.isArray(history)) return messages;
  for (const turn of history.slice(-8)) {
    if (!turn || !turn.role || !turn.content) continue;
    if (turn.role !== "user" && turn.role !== "assistant") continue;
    messages.push({ role: turn.role, content: String(turn.content).slice(0, 8000) });
  }
  return messages;
}

function userBlock(question, context) {
  return [
    "### Question",
    question,
    "",
    "### Context (JSON)",
    JSON.stringify(context || {}, null, 2).slice(0, 100000)
  ].join("\n");
}

async function askAzureOpenAI({ question, context, history }) {
  const endpoint = envSet("AZURE_OPENAI_ENDPOINT").replace(/\/$/, "");
  const apiKey = envSet("AZURE_OPENAI_API_KEY");
  const deployment = envSet("AZURE_OPENAI_DEPLOYMENT");
  const apiVersion = envSet("AZURE_OPENAI_API_VERSION") || "2024-08-01-preview";

  if (!endpoint || !apiKey || !deployment) {
    throw new Error(
      "Azure OpenAI not configured. Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT in SWA Application settings."
    );
  }

  const url = `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...buildHistoryMessages(history),
    { role: "user", content: userBlock(question, context) }
  ];

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": apiKey
    },
    body: JSON.stringify({
      messages,
      max_tokens: 2048,
      temperature: 0.2
    })
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || JSON.stringify(body) || res.statusText;
    throw new Error(`Azure OpenAI ${res.status}: ${msg}`);
  }

  const text = body?.choices?.[0]?.message?.content?.trim() || "";
  return {
    answer: text || "(empty response)",
    model: body?.model || deployment,
    provider: "azure_openai",
    usage: body?.usage || null
  };
}

async function askClaude({ question, context, history }) {
  const apiKey = envSet("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured in SWA Application settings");
  }
  const model = envSet("ANTHROPIC_MODEL") || "claude-sonnet-4-5";

  const messages = [
    ...buildHistoryMessages(history),
    { role: "user", content: userBlock(question, context) }
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages
    })
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || JSON.stringify(body) || res.statusText;
    throw new Error(`Claude API ${res.status}: ${msg}`);
  }

  const text = (body.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return {
    answer: text || "(empty response)",
    model: body.model || model,
    provider: "claude",
    usage: body.usage || null
  };
}

/** Prefer Azure OpenAI (Copilot-style); fall back to Claude if only that is set. */
async function askAi(opts) {
  const status = providerStatus();
  if (status.active === "azure_openai") return askAzureOpenAI(opts);
  if (status.active === "claude") return askClaude(opts);
  throw new Error(
    "No LLM configured. Set Azure OpenAI (AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT) or ANTHROPIC_API_KEY in SWA Application settings."
  );
}

module.exports = {
  askAi,
  askClaude,
  askAzureOpenAI,
  getStudyContext,
  providerStatus
};
