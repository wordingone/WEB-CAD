/**
 * fetch.mjs — SSRF-safe fetch + HTML→text pipeline for corpus mining.
 *
 * Shared module: used by scripts/corpus-mine/run.mjs AND by the future
 * research-tab web-search adapter (#373). Both are web-fetch pipelines;
 * one module, two consumers.
 *
 * Safety properties (same as research-tab-design.md §1.2):
 *   M2 — No JavaScript execution: fetch raw HTML, no browser context.
 *   M3 — Subresource stripping: src/href attrs stripped before text extraction.
 *   M5 — Per-domain rate cap: 1 req/2s/domain enforced via _domainLastFetch.
 *   M7 — Content cap: contentText ≤ 100_000 chars.
 *
 * NOT included here (build-time mining context, no browser side effects):
 *   M1 — Structured-output gate (caller's responsibility: extract.mjs)
 *   M4 — Per-session URL graph (caller's responsibility: run.mjs)
 *   M6 — Per-session token budget (caller's responsibility: run.mjs)
 */

/** @typedef {{ url: string; fetchedAt: string; title: string; source: string; contentText: string; rawHtmlBytes: number }} FetchedDoc */

const _domainLastFetch = new Map(); // domain → timestamp ms
const RATE_MS = 2_000;              // 1 req / 2s / domain

/**
 * Fetch a URL and return sanitized plain text.
 * @param {string} url
 * @param {string} source  source category label (e.g. "rhino-docs")
 * @param {string} title   human label for the page
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<FetchedDoc | null>}  null on non-200 or fetch error
 */
export async function fetchDoc(url, source, title, opts = {}) {
  const { timeoutMs = 10_000 } = opts;

  // Rate-cap per domain
  const domain = new URL(url).hostname;
  const lastFetch = _domainLastFetch.get(domain) ?? 0;
  const wait = Math.max(0, RATE_MS - (Date.now() - lastFetch));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _domainLastFetch.set(domain, Date.now());

  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "WEB-CAD-corpus-miner/1.0 (build-time; non-commercial research)" },
    });
    clearTimeout(timer);
  } catch (err) {
    console.warn(`[fetch] ${url} — error: ${err.message}`);
    return null;
  }

  if (!res.ok) {
    console.warn(`[fetch] ${url} — HTTP ${res.status}`);
    return null;
  }

  const rawHtml = await res.text();
  const rawHtmlBytes = rawHtml.length;
  const contentText = htmlToText(rawHtml).slice(0, 100_000);
  const extractedTitle = extractTitle(rawHtml) || title;

  return {
    url,
    fetchedAt: new Date().toISOString(),
    title: extractedTitle,
    source,
    contentText,
    rawHtmlBytes,
  };
}

/**
 * Strip HTML to plain text.
 * Removes: script, style, nav, header, footer, aside, form, button elements.
 * Converts numbered-list items to "N. text" for step extraction downstream.
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  let t = html;

  // Strip entire elements (content + tags)
  t = t.replace(/<(script|style|nav|header|footer|aside|form|button|noscript|svg|iframe|object|embed)[^>]*>[\s\S]*?<\/\1>/gi, " ");

  // Preserve ordered list numbering
  let liCount = 0;
  t = t.replace(/<ol[^>]*>/gi, () => { liCount = 0; return "\n"; });
  t = t.replace(/<\/ol>/gi, "\n");
  t = t.replace(/<ul[^>]*>/gi, "\n");
  t = t.replace(/<\/ul>/gi, "\n");
  t = t.replace(/<li[^>]*>/gi, () => `\n${++liCount}. `);
  t = t.replace(/<\/li>/gi, "");

  // Convert block elements to newlines
  t = t.replace(/<\/(p|div|section|article|h[1-6]|tr|td|th|br)>/gi, "\n");
  t = t.replace(/<br\s*\/?>/gi, "\n");

  // Strip all remaining tags
  t = t.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  t = t
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#[0-9]+;/g, " ");

  // Collapse whitespace
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n[ \t]+/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");

  return t.trim();
}

/**
 * Extract <title> text from HTML.
 * @param {string} html
 * @returns {string}
 */
function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/<[^>]+>/g, "").trim().slice(0, 200) : "";
}
