/**
 * On-demand HTTP page scrape for Monet asks.
 * Trigger: user pastes http(s) URL and/or says scrape/read/fetch the page.
 * Engine: plain fetch + HTML→text (no Firecrawl). SSRF-guarded.
 */
const dns = require("dns").promises;
const { URL } = require("url");

const MAX_URLS = 3;
const MAX_BYTES = 1.5 * 1024 * 1024;
const MAX_CHARS = 50000;
const FETCH_TIMEOUT_MS = 12000;

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;

function wantsPageScrape(question) {
  const q = String(question || "");
  if (!q.trim()) return false;
  const urls = extractUrls(q);
  if (urls.length) return true;
  const lower = q.toLowerCase();
  return (
    /\b(scrape|crawl)\b/.test(lower) ||
    /\b(read|fetch|open|pull|grab|get)\b.{0,40}\b(page|url|website|site|link|article)\b/.test(
      lower
    ) ||
    /\b(page|article|url|website)\b.{0,30}\b(content|text|html)\b/.test(lower)
  );
}

function extractUrls(question) {
  const raw = String(question || "");
  const found = [];
  const seen = new Set();
  let m;
  const re = new RegExp(URL_RE.source, "gi");
  while ((m = re.exec(raw)) && found.length < MAX_URLS) {
    let u = m[0].replace(/[.,;:!?]+$/, "");
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      const key = parsed.href;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(parsed.href);
    } catch (_) {
      /* skip */
    }
  }
  return found;
}

function isPrivateIp(ip) {
  const s = String(ip || "").toLowerCase();
  if (!s) return true;
  if (s === "127.0.0.1" || s === "::1" || s === "0.0.0.0") return true;
  if (s.startsWith("10.")) return true;
  if (s.startsWith("192.168.")) return true;
  if (s.startsWith("169.254.")) return true;
  if (s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80")) return true;
  const m = s.match(/^172\.(\d+)\./);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  return false;
}

async function assertPublicHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("blocked host");
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`DNS failed: ${err.message || err}`);
  }
  if (!records?.length) throw new Error("DNS returned no addresses");
  for (const r of records) {
    if (isPrivateIp(r.address)) throw new Error("private/link-local IP blocked");
  }
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return Number.isFinite(c) ? String.fromCharCode(c) : "";
    });
}

function htmlToText(html) {
  let s = String(html || "");
  const titleM = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? decodeEntities(titleM[1].replace(/\s+/g, " ").trim()) : "";
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article|header|footer)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "");
  s = decodeEntities(s);
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return { title, text: s };
}

async function fetchPageText(url, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || FETCH_TIMEOUT_MS;
  const maxBytes = Number(opts.maxBytes) || MAX_BYTES;
  const maxChars = Number(opts.maxChars) || MAX_CHARS;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return { url, ok: false, error: "invalid_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { url, ok: false, error: "unsupported_protocol" };
  }
  try {
    await assertPublicHost(parsed.hostname);
  } catch (err) {
    return { url, ok: false, error: String(err.message || err) };
  }

  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => {
    try {
      ac?.abort();
    } catch (_) {
      /* ignore */
    }
  }, timeoutMs);

  try {
    const res = await fetch(parsed.href, {
      method: "GET",
      redirect: "follow",
      signal: ac?.signal,
      headers: {
        "user-agent": "OraMonetBot/1.0 (+study-bid-workbench; public page fetch)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"
      }
    });
    if (!res.ok) {
      return { url: parsed.href, ok: false, error: `http_${res.status}` };
    }
    const ctype = String(res.headers.get("content-type") || "").toLowerCase();
    if (
      ctype &&
      !/text\/html|application\/xhtml|text\/plain|application\/xml|text\/xml/.test(ctype)
    ) {
      return {
        url: parsed.href,
        ok: false,
        error: `unsupported_content_type:${ctype.split(";")[0]}`
      };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      return { url: parsed.href, ok: false, error: "too_large" };
    }
    const raw = buf.toString("utf8");
    const { title, text } = htmlToText(raw);
    if (!text || text.length < 40) {
      return {
        url: parsed.href,
        ok: false,
        title: title || null,
        error: "empty_or_js_shell",
        charCount: text?.length || 0
      };
    }
    const clipped = text.slice(0, maxChars);
    return {
      url: parsed.href,
      ok: true,
      title: title || null,
      text: clipped,
      charCount: clipped.length,
      truncated: text.length > maxChars
    };
  } catch (err) {
    const msg = String(err?.name === "AbortError" ? "timeout" : err.message || err);
    return { url: parsed.href, ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<{ pages: Array, scrapedAt: string, requested: boolean, okCount?: number }>}
 */
async function scrapePagesForAsk(question, opts = {}) {
  const urls = extractUrls(question);
  if (!urls.length) {
    return {
      pages: [],
      scrapedAt: new Date().toISOString(),
      requested: wantsPageScrape(question)
    };
  }
  const pages = [];
  for (const u of urls.slice(0, MAX_URLS)) {
    // sequential — polite + simple SSRF/DNS checks
    // eslint-disable-next-line no-await-in-loop
    pages.push(await fetchPageText(u, opts));
  }
  return {
    pages,
    scrapedAt: new Date().toISOString(),
    requested: true,
    okCount: pages.filter((p) => p.ok).length
  };
}

module.exports = {
  wantsPageScrape,
  extractUrls,
  fetchPageText,
  scrapePagesForAsk,
  htmlToText,
  MAX_URLS,
  MAX_CHARS
};
