/**
 * Parse Buddy machine protocols from model answers into structured actions.
 * Client may consume actions[] directly instead of re-parsing free text.
 */

function extractBalancedJsonArray(src, marker) {
  const upper = String(src || "").toUpperCase();
  const needle = String(marker || "").toUpperCase();
  const idx = upper.indexOf(needle);
  if (idx < 0) return null;
  const brack = src.indexOf("[", idx);
  if (brack < 0) return null;
  let depth = 0;
  for (let i = brack; i < src.length; i++) {
    if (src[i] === "[") depth += 1;
    else if (src[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          return { value: JSON.parse(src.slice(brack, i + 1)), start: idx, end: i + 1 };
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

function extractBalancedJsonObject(src, marker) {
  const upper = String(src || "").toUpperCase();
  const needle = String(marker || "").toUpperCase();
  const idx = upper.indexOf(needle);
  if (idx < 0) return null;
  const brace = src.indexOf("{", idx);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return { value: JSON.parse(src.slice(brace, i + 1)), start: idx, end: i + 1 };
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

function extractApplyPatches(text) {
  let src = String(text || "");
  src = src.replace(/```(?:json)?\s*(APPLY:[\s\S]*?)```/gi, "$1");
  const re = /\bAPPLY:\s*(\[[\s\S]*?\])/gi;
  let match;
  let cleaned = src;
  const patches = [];
  while ((match = re.exec(src)) !== null) {
    try {
      patches.push(...JSON.parse(match[1]));
    } catch (_) {}
    cleaned = cleaned.replace(match[0], "\n");
  }
  if (!patches.length) {
    const bal = extractBalancedJsonArray(src, "APPLY:");
    if (bal && Array.isArray(bal.value)) {
      patches.push(...bal.value);
      cleaned = (src.slice(0, bal.start) + "\n" + src.slice(bal.end)).trim();
    }
  }
  if (!patches.length) {
    const obj = extractBalancedJsonObject(src, "APPLY:");
    if (obj && obj.value && typeof obj.value === "object") {
      const list = Array.isArray(obj.value) ? obj.value : [obj.value];
      patches.push(...list);
      cleaned = (src.slice(0, obj.start) + "\n" + src.slice(obj.end)).trim();
    }
  }
  return { text: cleaned.trim(), patches };
}

function extractCreateStudy(text) {
  const src = String(text || "");
  const re = /\bCREATE_STUDY:\s*(\{[\s\S]*?\})\s*(?=\n(?:NAVIGATE:|APPLY:|LEARN_CONTEXT:)|$)/i;
  const m = src.match(re) || src.match(/\bCREATE_STUDY:\s*(\{[\s\S]*\})\s*$/i);
  let create = null;
  let cleaned = src;
  if (m) {
    try {
      create = JSON.parse(m[1]);
    } catch (_) {}
  }
  if (!create) {
    const bal = extractBalancedJsonObject(src, "CREATE_STUDY:");
    if (bal) create = bal.value;
  }
  cleaned = src.replace(/\bCREATE_STUDY:\s*\{[\s\S]*\}\s*/i, "\n").trim();
  return { text: cleaned, create };
}

function extractLearnContext(text) {
  const src = String(text || "");
  const re = /\bLEARN_CONTEXT:\s*(\{[\s\S]*?\})\s*(?=\n(?:NAVIGATE:|APPLY:|CREATE_STUDY:)|$)/i;
  const m = src.match(re) || src.match(/\bLEARN_CONTEXT:\s*(\{[\s\S]*\})\s*$/i);
  let learn = null;
  let cleaned = src;
  if (m) {
    try {
      learn = JSON.parse(m[1]);
    } catch (_) {}
  }
  if (!learn) {
    const bal = extractBalancedJsonObject(src, "LEARN_CONTEXT:");
    if (bal) learn = bal.value;
  }
  cleaned = src.replace(/\bLEARN_CONTEXT:\s*\{[\s\S]*\}\s*/i, "\n").trim();
  return { text: cleaned, learn };
}

function extractHtmlReport(text) {
  const src = String(text || "");
  const start = src.match(/HTML_REPORT_START/i);
  const end = src.match(/HTML_REPORT_END/i);
  if (!start || !end) return { text: src, html: null };
  const sIdx = src.search(/HTML_REPORT_START/i);
  const eIdx = src.search(/HTML_REPORT_END/i);
  if (sIdx < 0 || eIdx < 0 || eIdx <= sIdx) return { text: src, html: null };
  const html = src
    .slice(sIdx + "HTML_REPORT_START".length, eIdx)
    .replace(/^[\s:]+/, "")
    .trim();
  const textOut = (src.slice(0, sIdx) + src.slice(eIdx + "HTML_REPORT_END".length)).trim();
  return { text: textOut, html: html || null };
}

function extractNavigate(text) {
  const src = String(text || "");
  const m = src.match(/\bNAVIGATE:([a-z0-9_-]+)\b/i);
  if (!m) return { text: src, sectionId: null };
  return {
    text: src.replace(/\s*NAVIGATE:[a-z0-9_-]+\s*/gi, "\n").trim(),
    sectionId: m[1].toLowerCase()
  };
}

/**
 * Parse model answer into user-visible text + structured actions.
 * @returns {{ cleanAnswer: string, actions: Array<{type:string,...}>, htmlReport: string|null }}
 */
function parseBuddyActions(rawAnswer) {
  let text = String(rawAnswer || "").trim();
  const actions = [];

  const nav = extractNavigate(text);
  text = nav.text;
  if (nav.sectionId) {
    actions.push({ type: "navigate", sectionId: nav.sectionId });
  }

  const report = extractHtmlReport(text);
  text = report.text;

  const created = extractCreateStudy(text);
  text = created.text;
  if (created.create) {
    actions.push({ type: "create_study", payload: created.create });
  }

  const learned = extractLearnContext(text);
  text = learned.text;
  if (learned.learn) {
    actions.push({ type: "learn_context", payload: learned.learn });
  }

  const extracted = extractApplyPatches(text);
  text = extracted.text;
  if (extracted.patches.length) {
    actions.push({ type: "apply_patches", patches: extracted.patches });
  }

  text = text.replace(/(^|\s)\(?null\)?(?=\s|$)/gi, (m, lead) => `${lead}missing`);
  const bare = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (
    !bare ||
    /^(null|\(null\)|undefined|n\/a|none)$/i.test(bare) ||
    /^(i (have )?no answer( to that)?\.?|no answer( to that)?\.?)$/i.test(bare)
  ) {
    if (!report.html && !actions.length) {
      text =
        "I need a bit more to help. Tell me the indication (e.g. Dry Eye), geography if it matters, and whether you want a portfolio rollup, a pitch/feasibility read, or help on the open study.";
    } else {
      text = "";
    }
  }

  return {
    cleanAnswer: text.trim(),
    actions,
    htmlReport: report.html || null
  };
}

module.exports = {
  parseBuddyActions,
  extractApplyPatches,
  extractCreateStudy,
  extractLearnContext,
  extractNavigate
};
