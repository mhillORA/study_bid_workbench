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

/** First non-empty env among aliases (for SWA naming mismatches). */
function envSetAny(names) {
  for (const name of names) {
    const v = envSet(name);
    if (v) return { value: v, from: name };
  }
  return { value: "", from: null };
}

const AZURE_KEY_ALIASES = [
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_KEY",
  "AZURE_AI_API_KEY",
  "AZURE_AI_KEY",
  "OPENAI_API_KEY",
  "FOUNDRY_API_KEY",
  "AI_API_KEY"
];

const AZURE_ENDPOINT_ALIASES = [
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_AI_ENDPOINT",
  "FOUNDRY_PROJECT_ENDPOINT",
  "AZURE_AI_PROJECT_ENDPOINT"
];

const AZURE_DEPLOYMENT_ALIASES = [
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_MODEL",
  "AZURE_AI_DEPLOYMENT",
  "FOUNDRY_DEPLOYMENT",
  "OPENAI_DEPLOYMENT"
];

function azureConfig() {
  const endpoint = envSetAny(AZURE_ENDPOINT_ALIASES);
  const apiKey = envSetAny(AZURE_KEY_ALIASES);
  const deployment = envSetAny(AZURE_DEPLOYMENT_ALIASES);
  return {
    endpoint: endpoint.value,
    apiKey: apiKey.value,
    deployment: deployment.value,
    sources: {
      endpoint: endpoint.from,
      apiKey: apiKey.from,
      deployment: deployment.from
    }
  };
}

function providerStatus() {
  const cfg = azureConfig();
  const azure = Boolean(cfg.endpoint) && Boolean(cfg.apiKey) && Boolean(cfg.deployment);
  const claude = Boolean(envSet("ANTHROPIC_API_KEY"));

  // Presence only — never return secret values
  const raw = (name) => {
    const v = process.env[name];
    if (v == null) return "missing";
    if (!String(v).trim()) return "empty";
    if (String(v).includes("SET_IN")) return "placeholder";
    return "set";
  };

  const aliasScan = {};
  for (const name of [...AZURE_KEY_ALIASES, ...AZURE_ENDPOINT_ALIASES, ...AZURE_DEPLOYMENT_ALIASES]) {
    const status = raw(name);
    if (status !== "missing") aliasScan[name] = status;
  }

  return {
    azureOpenAI: azure,
    claude,
    active: azure ? "azure_openai" : claude ? "claude" : null,
    effort: envSet("ANTHROPIC_EFFORT") || "low",
    buildId: "2026-07-22T16:58-temp1",
    endpointKind: !cfg.endpoint
      ? null
      : isFoundryProjectEndpoint(cfg.endpoint)
        ? "foundry_project"
        : isOpenAiV1Endpoint(cfg.endpoint)
          ? "openai_v1"
          : "classic_azure_openai",
    envCheck: {
      AZURE_OPENAI_ENDPOINT: raw("AZURE_OPENAI_ENDPOINT"),
      AZURE_OPENAI_API_KEY: raw("AZURE_OPENAI_API_KEY"),
      AZURE_OPENAI_DEPLOYMENT: raw("AZURE_OPENAI_DEPLOYMENT"),
      COSMOS_ENDPOINT: raw("COSMOS_ENDPOINT"),
      COSMOS_KEY: raw("COSMOS_KEY")
    },
    resolvedFrom: cfg.sources,
    otherAiSettingsFound: aliasScan
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

function resourceNameFromEndpoint(endpoint) {
  const e = String(endpoint || "");
  let m = e.match(/^https:\/\/([^.]+)\.services\.ai\.azure\.com/i);
  if (m) return m[1];
  m = e.match(/^https:\/\/([^.]+)\.openai\.azure\.com/i);
  if (m) return m[1];
  m = e.match(/^https:\/\/([^.]+)\.cognitiveservices\.azure\.com/i);
  if (m) return m[1];
  return null;
}

/**
 * Build candidate chat-completion URLs. Foundry "project" URLs often 404 for
 * chat completions with api-key — prefer *.openai.azure.com/openai/v1.
 */
function buildAzureChatAttempts(endpoint, deployment, apiVersion) {
  const base = String(endpoint || "").replace(/\/$/, "");
  const resource = resourceNameFromEndpoint(base);
  const attempts = [];

  const pushV1 = (hostBase, label) => {
    const root = hostBase.replace(/\/$/, "").replace(/\/openai\/v1$/i, "");
    attempts.push({
      label,
      url: `${root}/openai/v1/chat/completions`,
      body: {
        model: deployment,
        messages: null, // filled later
        max_completion_tokens: 2048,
        // GPT-5 only allows default temperature=1; Foundry may inject 0.2 otherwise
        temperature: 1
      }
    });
  };

  const pushClassic = (hostBase, label) => {
    const root = hostBase.replace(/\/$/, "").replace(/\/openai\/v1$/i, "");
    attempts.push({
      label,
      url: `${root}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`,
      body: {
        messages: null,
        max_completion_tokens: 2048,
        temperature: 1
      }
    });
  };

  // 1) Preferred: OpenAI v1 on openai.azure.com (works with Foundry deployments + api-key)
  if (resource) {
    pushV1(`https://${resource}.openai.azure.com`, "openai_v1_host");
    pushClassic(`https://${resource}.openai.azure.com`, "classic_deployments_host");
    pushV1(`https://${resource}.cognitiveservices.azure.com`, "cognitive_v1_host");
    pushClassic(`https://${resource}.cognitiveservices.azure.com`, "cognitive_classic_host");
  }

  // 2) If user already pasted openai.azure.com (/openai/v1 or bare)
  if (/openai\.azure\.com/i.test(base)) {
    if (isOpenAiV1Endpoint(base) || /\/openai\/v1/i.test(base)) {
      pushV1(base, "user_openai_v1");
    } else {
      pushV1(base, "user_openai_as_v1");
      pushClassic(base, "user_classic");
    }
  }

  // 3) Project endpoint path (sometimes works; often 404 for plain chat)
  if (isFoundryProjectEndpoint(base)) {
    // Prefer resource-level Foundry OpenAI route (no /api/projects/...)
    if (resource) {
      pushV1(`https://${resource}.services.ai.azure.com`, "foundry_services_v1");
    }
    attempts.push({
      label: "foundry_project_openai_v1",
      url: `${base}/openai/v1/chat/completions`,
      body: {
        model: deployment,
        messages: null,
        max_completion_tokens: 2048,
        temperature: 1
      }
    });
  }

  // Dedupe by URL
  const seen = new Set();
  return attempts.filter((a) => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
}

/**
 * Supports Foundry project endpoints and classic Azure OpenAI.
 * Tries multiple URL shapes because Foundry project URLs often 404 for chat.
 */
async function askAzureOpenAI({ question, context, history }) {
  const cfg = azureConfig();
  const endpoint = cfg.endpoint.replace(/\/$/, "");
  const apiKey = cfg.apiKey;
  const deployment = cfg.deployment;
  const apiVersion = envSet("AZURE_OPENAI_API_VERSION") || "2024-08-01-preview";

  if (!endpoint || !apiKey || !deployment) {
    throw new Error(
      "Ask Buddy is not configured. Need endpoint + API key + deployment on SWA. " +
        `Key must be named AZURE_OPENAI_API_KEY (currently: endpoint=${cfg.sources.endpoint || "missing"}, key=${cfg.sources.apiKey || "missing"}, deployment=${cfg.sources.deployment || "missing"}).`
    );
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...buildHistoryMessages(history),
    { role: "user", content: userBlock(question, context) }
  ];

  const attempts = buildAzureChatAttempts(endpoint, deployment, apiVersion);
  if (!attempts.length) {
    throw new Error(`Could not build Azure chat URL from endpoint: ${endpoint}`);
  }

  const failures = [];
  for (const attempt of attempts) {
    const body = { ...attempt.body, messages };
    // classic body has no model field
    if (!("model" in attempt.body)) delete body.model;

    const res = await fetch(attempt.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "api-key": apiKey
      },
      body: JSON.stringify(body)
    });

    const respBody = await res.json().catch(() => ({}));
    if (res.ok) {
      const text = respBody?.choices?.[0]?.message?.content?.trim() || "";
      return {
        answer: text || "(empty response)",
        model: respBody?.model || deployment,
        provider: "azure_openai",
        via: attempt.label,
        usage: respBody?.usage || null
      };
    }

    const msg =
      respBody?.error?.message ||
      respBody?.error?.code ||
      (Object.keys(respBody || {}).length ? JSON.stringify(respBody).slice(0, 200) : res.statusText);
    failures.push(`${attempt.label} → ${res.status} ${msg}`);

    // Retry other hosts only when the route itself is missing
    if (res.status !== 404) {
      break;
    }
  }

  throw new Error(
    `Azure AI chat failed for deployment "${deployment}". ` +
      `Check deployment name matches Foundry exactly. Tried: ${failures.join(" | ")}`
  );
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
