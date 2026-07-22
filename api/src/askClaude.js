/**
 * Ask Buddy — study context + LLM (Azure OpenAI preferred; Claude optional fallback).
 */

const SYSTEM_PROMPT = [
  "You are Ask Buddy, the Study Bid Workbench assistant for Ora Clinical BD / operations.",
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
  const endpoint = envSet("AZURE_OPENAI_ENDPOINT");
  const azure =
    Boolean(endpoint) &&
    Boolean(envSet("AZURE_OPENAI_API_KEY")) &&
    Boolean(envSet("AZURE_OPENAI_DEPLOYMENT"));
  const claude = Boolean(envSet("ANTHROPIC_API_KEY"));
  return {
    azureOpenAI: azure,
    claude,
    active: azure ? "azure_openai" : claude ? "claude" : null,
    effort: envSet("ANTHROPIC_EFFORT") || "low",
    endpointKind: !endpoint
      ? null
      : isFoundryProjectEndpoint(endpoint)
        ? "foundry_project"
        : isOpenAiV1Endpoint(endpoint)
          ? "openai_v1"
          : "classic_azure_openai"
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

function isFoundryProjectEndpoint(endpoint) {
  const e = String(endpoint || "").toLowerCase();
  return e.includes("services.ai.azure.com") || e.includes("/api/projects/");
}

function isOpenAiV1Endpoint(endpoint) {
  const e = String(endpoint || "").toLowerCase();
  return e.includes("/openai/v1");
}

/**
 * Supports:
 * - Classic Azure OpenAI: https://NAME.openai.azure.com
 * - Foundry OpenAI v1:    https://NAME.openai.azure.com/openai/v1
 * - Foundry project:      https://NAME.services.ai.azure.com/api/projects/PROJECT
 */
async function askAzureOpenAI({ question, context, history }) {
  let endpoint = envSet("AZURE_OPENAI_ENDPOINT").replace(/\/$/, "");
  const apiKey = envSet("AZURE_OPENAI_API_KEY");
  const deployment = envSet("AZURE_OPENAI_DEPLOYMENT");
  const apiVersion = envSet("AZURE_OPENAI_API_VERSION") || "2024-08-01-preview";

  if (!endpoint || !apiKey || !deployment) {
    throw new Error(
      "Ask Buddy is not configured. Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT in SWA Application settings (Foundry project endpoint is OK)."
    );
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...buildHistoryMessages(history),
    { role: "user", content: userBlock(question, context) }
  ];

  let url;
  let body;
  const foundry = isFoundryProjectEndpoint(endpoint) || isOpenAiV1Endpoint(endpoint);

  if (foundry) {
    // Foundry / OpenAI-compatible: model name goes in the JSON body
    if (isFoundryProjectEndpoint(endpoint) && !endpoint.toLowerCase().includes("/openai/v1")) {
      url = `${endpoint}/openai/v1/chat/completions`;
    } else if (isOpenAiV1Endpoint(endpoint)) {
      url = endpoint.endsWith("/chat/completions")
        ? endpoint
        : `${endpoint.replace(/\/$/, "")}/chat/completions`;
    } else {
      url = `${endpoint}/openai/v1/chat/completions`;
    }
    body = {
      model: deployment,
      messages,
      max_tokens: 2048,
      temperature: 0.2
    };
  } else {
    // Classic Azure OpenAI resource endpoint
    // Strip accidental /openai/v1 if someone pasted a hybrid URL incompletely
    endpoint = endpoint.replace(/\/openai\/v1$/i, "");
    url = `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
    body = {
      messages,
      max_tokens: 2048,
      temperature: 0.2
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": apiKey
    },
    body: JSON.stringify(body)
  });

  const respBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = respBody?.error?.message || JSON.stringify(respBody) || res.statusText;
    throw new Error(`Azure AI ${res.status}: ${msg}`);
  }

  const text = respBody?.choices?.[0]?.message?.content?.trim() || "";
  return {
    answer: text || "(empty response)",
    model: respBody?.model || deployment,
    provider: foundry ? "azure_foundry" : "azure_openai",
    usage: respBody?.usage || null
  };
}

async function askClaude({ question, context, history }) {
  const apiKey = envSet("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured in SWA Application settings");
  }
  const model = envSet("ANTHROPIC_MODEL") || "claude-sonnet-4-5";
  const effort = (envSet("ANTHROPIC_EFFORT") || "low").toLowerCase();

  const messages = [
    ...buildHistoryMessages(history),
    { role: "user", content: userBlock(question, context) }
  ];

  const payload = {
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages
  };
  // Effort controls token spend / thoroughness (low = cheapest/fastest).
  if (["low", "medium", "high", "max"].includes(effort)) {
    payload.output_config = { effort };
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(payload)
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
    effort,
    usage: body.usage || null
  };
}

/** Prefer Azure OpenAI (Ask Buddy); fall back to Claude only if Azure is unset. */
async function askAi(opts) {
  const status = providerStatus();
  if (status.active === "azure_openai") return askAzureOpenAI(opts);
  if (status.active === "claude") return askClaude(opts);
  throw new Error(
    "Ask Buddy is not configured. Set Azure OpenAI (AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT) in SWA Application settings."
  );
}

module.exports = {
  askAi,
  askClaude,
  askAzureOpenAI,
  getStudyContext,
  providerStatus
};
