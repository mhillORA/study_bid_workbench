/**
 * Build a compact context blob for Claude from Cosmos (when configured)
 * and/or a client-provided study snapshot (POC localStorage).
 */

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

    // Sample of line items by department (not full 2k+ rows)
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

async function askClaude({ question, context, history }) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey || apiKey.includes("SET_IN")) {
    throw new Error("ANTHROPIC_API_KEY not configured in SWA Application settings");
  }
  const model = (process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5").trim();

  const system = [
    "You are the Study Bid Workbench assistant for Ora Clinical BD / operations.",
    "Answer questions about clinical study budgets, drivers, departments, line items, and formulas.",
    "Be concise and practical. Prefer numbers and Ora codes when present in context.",
    "If context is missing or incomplete, say what you need.",
    "Do not invent Cosmos data that is not in the provided context.",
    "This is a proof-of-concept — keep answers short unless asked for detail."
  ].join(" ");

  const messages = [];
  if (Array.isArray(history)) {
    for (const turn of history.slice(-8)) {
      if (!turn || !turn.role || !turn.content) continue;
      if (turn.role !== "user" && turn.role !== "assistant") continue;
      messages.push({ role: turn.role, content: String(turn.content).slice(0, 8000) });
    }
  }

  const userBlock = [
    "### Question",
    question,
    "",
    "### Context (JSON)",
    JSON.stringify(context || {}, null, 2).slice(0, 100000)
  ].join("\n");

  messages.push({ role: "user", content: userBlock });

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
      system,
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
    usage: body.usage || null
  };
}

module.exports = { askClaude, getStudyContext };
