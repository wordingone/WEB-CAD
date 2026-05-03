// Paper Mode (#02 LAYOUT) + Research Mode (#03 RESEARCH).
//
// Paper Mode is the bundle's static SVG mockup; functional research mode
// is wired below.
//
// RESEARCH MODE — three columns:
//   - left  : corpus listing + search input. Filter pills (LOCAL / WEB /
//             CITE) restrict the corpus before the query scores.
//   - middle: rendered markdown of the active doc with `<mark>`-tag
//             highlighting on query terms.
//   - right : findings (top-N ranked snippets with citation buttons) +
//             session citation log + JSON download.
//
// All scoring is in `research-index.ts` (TF-IDF + cosine, hand-rolled).
// The default corpus is loaded from `research-corpus-loader.ts` which
// pulls *.md files via Vite's `?raw` import.

import { iconSVG } from "./icons";
import {
  buildResearchIndex,
  queryResearch,
  createCitationTracker,
  type ResearchIndex,
  type QueryResult,
  type DocKind,
  type CitationTracker,
} from "./research-index";
import { defaultCorpus } from "./research-corpus-loader";
import { renderMarkdown } from "./research-md";

// ---------------- Paper mode (unchanged static mockup) ----------------

const PAPER_MODE_HTML = `
<div class="paper-sheet">
  <div class="paper-cell">
    <span class="paper-cell-label">A · PLAN · LEVEL 00</span>
    <span class="paper-cell-scale">1:50</span>
    <svg viewBox="0 0 220 140" preserveAspectRatio="xMidYMid meet">
      <g fill="none" stroke="oklch(0.18 0.018 250)">
        <path d="M 30 30 L 130 30 L 130 70 L 190 70 L 190 110 L 30 110 Z" stroke-width="1.6"/>
        <path d="M 34 34 L 126 34 L 126 74 L 186 74 L 186 106 L 34 106 Z" stroke-width="0.6"/>
        <path d="M 70 30 L 70 36 M 80 30 L 80 36 M 70 36 A 10 10 0 0 1 80 30" stroke-width="0.5"/>
        <g stroke="oklch(0.55 0.02 250)" stroke-width="0.35">
          <line x1="30" y1="22" x2="130" y2="22"/>
          <line x1="30" y1="20" x2="30" y2="24"/>
          <line x1="130" y1="20" x2="130" y2="24"/>
        </g>
        <text x="80" y="19" font-size="5" fill="oklch(0.40 0.015 250)" text-anchor="middle" font-family="monospace">8000</text>
      </g>
    </svg>
  </div>
  <div class="paper-cell">
    <span class="paper-cell-label">B · ELEVATION · NORTH</span>
    <span class="paper-cell-scale">1:50</span>
    <svg viewBox="0 0 220 140">
      <g fill="none" stroke="oklch(0.18 0.018 250)">
        <path d="M 30 100 L 30 50 L 110 50 L 110 75 L 190 75 L 190 100 Z" stroke-width="1.6"/>
        <line x1="20" y1="100" x2="200" y2="100" stroke-width="0.6"/>
        <g stroke-width="0.3">
          ${Array.from({ length: 18 }).map((_, i) => `<line x1="${20 + i * 10}" y1="100" x2="${28 + i * 10}" y2="108"/>`).join("")}
        </g>
        <rect x="42" y="62" width="14" height="20" stroke-width="0.5"/>
        <rect x="62" y="62" width="14" height="20" stroke-width="0.5"/>
        <rect x="82" y="62" width="14" height="20" stroke-width="0.5"/>
      </g>
    </svg>
  </div>
  <div class="paper-cell">
    <span class="paper-cell-label">C · SECTION · A-A</span>
    <span class="paper-cell-scale">1:50</span>
    <svg viewBox="0 0 220 140">
      <g stroke="oklch(0.18 0.018 250)" fill="none">
        <path d="M 30 100 L 30 50 L 190 50 L 190 100 Z" stroke-width="1.6"/>
        <path d="M 30 100 L 190 100" stroke-width="2.2"/>
        <line x1="30" y1="74" x2="190" y2="74" stroke-width="0.5" stroke-dasharray="2 1.5"/>
        <text x="36" y="71" font-size="4.5" fill="oklch(0.4 0.015 250)" font-family="monospace">+1.40 SLAB</text>
      </g>
    </svg>
  </div>
  <div class="paper-cell">
    <span class="paper-cell-label">D · AXONOMETRIC</span>
    <span class="paper-cell-scale">NTS</span>
    <svg viewBox="0 0 220 140">
      <g stroke="oklch(0.18 0.018 250)" fill="none">
        <path d="M 60 100 L 130 70 L 170 90 L 170 50 L 130 30 L 60 60 Z" stroke-width="1.6"/>
        <path d="M 60 60 L 60 100 M 130 30 L 130 70 M 170 50 L 170 90" stroke-width="0.8"/>
        <path d="M 60 100 L 130 70 L 170 90" stroke-width="2.2"/>
        <path d="M 130 70 L 60 60 M 130 70 L 170 50" stroke-width="0.5" stroke-dasharray="2 1.5"/>
      </g>
    </svg>
  </div>
  <div class="paper-titleblock">
    <div class="tb-cell brand"><span class="k">PROJECT</span><span class="v">UNTITLED · 001</span></div>
    <div class="tb-cell"><span class="k">Sheet</span><span class="v">A-101</span></div>
    <div class="tb-cell"><span class="k">Scale</span><span class="v">1:50 / NTS</span></div>
    <div class="tb-cell"><span class="k">Drawn</span><span class="v">GEMMA·AI</span></div>
    <div class="tb-cell"><span class="k">Date</span><span class="v">2026·05·02</span></div>
  </div>
</div>
`;

function buildPaperMode(): HTMLElement {
  const el = document.createElement("div");
  el.className = "paper-mode mode-pane";
  el.dataset.modePane = "layout";
  el.style.display = "none";
  el.innerHTML = PAPER_MODE_HTML;
  return el;
}

// ---------------- Research mode (functional) ----------------

interface ResearchState {
  index: ResearchIndex | null;
  tracker: CitationTracker;
  activeDoc: string | null;       // doc name currently shown in the viewer
  query: string;                  // latest search query
  results: QueryResult[];         // ranked results for the query
  filterLocal: boolean;
  filterWeb: boolean;
  filterCite: boolean;
}

function buildResearchMode(): HTMLElement {
  const el = document.createElement("div");
  el.className = "research-mode mode-pane";
  el.dataset.modePane = "research";
  el.style.display = "none";

  const state: ResearchState = {
    index: null,
    tracker: createCitationTracker(),
    activeDoc: null,
    query: "",
    results: [],
    filterLocal: true,
    filterWeb: true,
    filterCite: false,
  };

  // Expose state for in-page debugging + headless tests poking from
  // playwright. Read-only handle.
  (window as unknown as { __research?: ResearchState }).__research = state;

  el.innerHTML = `
    <div class="research-col">
      <div class="research-header">${iconSVG("import", 13)} CORPUS <span class="pill" id="r-corpus-pill">— docs</span></div>
      <div class="research-search">
        <input type="search" id="r-query" placeholder="search the corpus  ·  e.g. wall thickness conventions"/>
      </div>
      <div class="research-body" id="r-corpus-list"></div>
    </div>
    <div class="research-doc-viewer">
      <div class="rdv-toolbar">
        <span style="font-weight:700; color:var(--ink);" id="r-active-name">— select a doc —</span>
        <span style="flex:1;"></span>
        <span id="r-hit-count">0 hits</span>
      </div>
      <div class="rdv-pages" id="r-doc-body">
        <div class="rdv-page"><p style="color: var(--ink-faint);">Indexing corpus…</p></div>
      </div>
    </div>
    <div class="research-col">
      <div class="research-header">${iconSVG("sparkle", 13)} FINDINGS <span class="pill" id="r-cite-pill">0 cited</span></div>
      <div class="research-body findings-list" id="r-findings"></div>
      <div class="research-prompt">
        <div class="rp-actions">
          <div class="rp-toggles">
            <span class="rp-toggle active" data-filter="local">LOCAL</span>
            <span class="rp-toggle active" data-filter="web">WEB</span>
            <span class="rp-toggle" data-filter="cite">CITE</span>
          </div>
          <span class="rp-export" id="r-export" title="Download citations.json">${iconSVG("export", 11)} export</span>
        </div>
      </div>
    </div>
  `;

  // ---- DOM handles ----
  const queryInput = el.querySelector<HTMLInputElement>("#r-query")!;
  const corpusList = el.querySelector<HTMLElement>("#r-corpus-list")!;
  const corpusPill = el.querySelector<HTMLElement>("#r-corpus-pill")!;
  const activeName = el.querySelector<HTMLElement>("#r-active-name")!;
  const docBody = el.querySelector<HTMLElement>("#r-doc-body")!;
  const hitCount = el.querySelector<HTMLElement>("#r-hit-count")!;
  const findings = el.querySelector<HTMLElement>("#r-findings")!;
  const citePill = el.querySelector<HTMLElement>("#r-cite-pill")!;
  const exportBtn = el.querySelector<HTMLElement>("#r-export")!;

  // ---- Build the index asynchronously ----
  buildResearchIndex(defaultCorpus())
    .then((idx) => {
      state.index = idx;
      // Default active doc = first local doc.
      const first = idx.docs.find((d) => d.kind === "local") ?? idx.docs[0];
      if (first) state.activeDoc = first.name;
      renderAll();
    })
    .catch((e) => {
      docBody.innerHTML = `<div class="rdv-page"><p style="color: var(--err);">Failed to build research index: ${(e as Error).message}</p></div>`;
    });

  // ---- Re-render the entire research mode ----
  function renderAll() {
    if (!state.index) return;
    renderCorpusList();
    renderActiveDoc();
    renderFindings();
    renderCitePill();
  }

  function activeFilter(): DocKind | "all" {
    if (state.filterLocal && !state.filterWeb) return "local";
    if (state.filterWeb && !state.filterLocal) return "web";
    return "all";
  }

  function restrictSet(): Set<string> | undefined {
    if (!state.filterCite) return undefined;
    return state.tracker.citedSources();
  }

  function visibleDocs() {
    if (!state.index) return [];
    const filter = activeFilter();
    const restrict = restrictSet();
    return state.index.docs.filter((d) => {
      if (filter !== "all" && d.kind !== filter) return false;
      if (restrict && !restrict.has(d.name)) return false;
      return true;
    });
  }

  function renderCorpusList() {
    if (!state.index) return;
    const docs = visibleDocs();
    corpusPill.textContent = `${docs.length} docs`;

    // If a query is set, sort by score; otherwise alphabetical.
    let cards: { name: string; title: string; source: string; score?: number }[];
    if (state.query.trim()) {
      cards = state.results.map((r) => ({
        name: r.name,
        title: r.title,
        source: r.source,
        score: r.score,
      }));
      // Append filtered docs that didn't score (so the user can still
      // pick them).
      const seen = new Set(cards.map((c) => c.name));
      for (const d of docs) {
        if (!seen.has(d.name)) cards.push({ name: d.name, title: d.title, source: d.source });
      }
    } else {
      cards = docs.map((d) => ({ name: d.name, title: d.title, source: d.source }));
    }

    corpusList.innerHTML = cards
      .map((c) => {
        const active = state.activeDoc === c.name ? " active" : "";
        const scoreLine = c.score !== undefined
          ? `<div class="dc-meta">score: ${c.score.toFixed(3)}</div>`
          : "";
        const cited = state.tracker.citedSources().has(c.name)
          ? `<span class="dc-tag">cited</span>`
          : "";
        return `
          <div class="doc-card${active}" data-doc="${escAttr(c.name)}">
            <div class="dc-name">${escText(c.title)}</div>
            <div class="dc-source">${escText(c.source)}</div>
            ${scoreLine}
            <div class="dc-tags">${cited}</div>
          </div>
        `;
      })
      .join("");
  }

  function renderActiveDoc() {
    if (!state.index) return;
    const doc = state.index.docs.find((d) => d.name === state.activeDoc);
    if (!doc) {
      activeName.textContent = "— select a doc —";
      docBody.innerHTML = "";
      hitCount.textContent = "0 hits";
      return;
    }
    activeName.textContent = doc.title;

    // Compute highlight terms from current query (or matched terms of the
    // top hit for this doc, whichever is more specific).
    let highlightTerms: string[] = [];
    const topHit = state.results.find((r) => r.name === doc.name);
    if (topHit) highlightTerms = topHit.matchedTerms;
    else if (state.query.trim()) {
      // Fallback — surface all query tokens.
      highlightTerms = state.query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 1);
    }

    // Hit count = number of <mark>'d spans we're about to render.
    const html = renderMarkdown(doc.body, { highlightTerms });
    const hits = (html.match(/<mark>/g) || []).length;
    hitCount.textContent = `${hits} hit${hits === 1 ? "" : "s"}`;
    docBody.innerHTML = `<div class="rdv-page rdv-md">${html}<span class="rdv-page-num">${escText(doc.source)}</span></div>`;
  }

  function renderFindings() {
    if (!state.index) return;
    if (state.results.length === 0 && state.tracker.list().length === 0) {
      findings.innerHTML = `
        <div class="finding finding-empty">
          <div class="f-q">No query yet.</div>
          <div class="f-a">Type a query above to surface ranked snippets, then "Cite" to capture findings.</div>
        </div>`;
      return;
    }

    const resultBlocks = state.results.slice(0, 6).map((r, idx) => {
      const matchedTags = r.matchedTerms
        .slice(0, 6)
        .map((t) => `<span class="dc-tag">${escText(t)}</span>`)
        .join("");
      return `
        <div class="finding" data-result-idx="${idx}">
          <div class="f-q">${escText(r.title)}  <span class="f-meta">· ${r.score.toFixed(3)}</span></div>
          <div class="f-a">${escText(r.snippet)}</div>
          <div class="f-meta">${escText(r.source)} · line ${r.line} ${matchedTags}</div>
          <div class="f-actions">
            <button class="f-cite-btn" data-result-idx="${idx}" type="button">Cite</button>
            <button class="f-open-btn" data-doc="${escAttr(r.name)}" type="button">Open</button>
          </div>
        </div>
      `;
    }).join("");

    const citeList = state.tracker.list();
    const citeBlocks = citeList.length > 0
      ? `<div class="cite-divider">CITED THIS SESSION (${citeList.length})</div>` +
        citeList.map((c, i) => `
          <div class="finding finding-cited">
            <div class="f-q">${escText(c.source)} · line ${c.line}</div>
            <div class="f-a">${escText(c.claim)}</div>
            <div class="f-actions">
              <button class="f-uncite-btn" data-cite-idx="${i}" type="button">Remove</button>
            </div>
          </div>
        `).join("")
      : "";

    findings.innerHTML = resultBlocks + citeBlocks;
  }

  function renderCitePill() {
    citePill.textContent = `${state.tracker.list().length} cited`;
  }

  // ---- Query handler ----
  function runQuery() {
    if (!state.index) return;
    const q = queryInput.value;
    state.query = q;
    if (!q.trim()) {
      state.results = [];
    } else {
      state.results = queryResearch(state.index, q, {
        source: activeFilter(),
        restrictTo: restrictSet(),
        limit: 10,
      });
      // Auto-jump active doc to top result.
      if (state.results.length > 0) state.activeDoc = state.results[0].name;
    }
    renderAll();
  }

  let queryTimer: number | undefined;
  queryInput.addEventListener("input", () => {
    if (queryTimer) window.clearTimeout(queryTimer);
    queryTimer = window.setTimeout(runQuery, 120) as unknown as number;
  });

  // ---- Corpus card click ----
  corpusList.addEventListener("click", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".doc-card");
    if (!card) return;
    const name = card.dataset.doc;
    if (!name) return;
    state.activeDoc = name;
    renderAll();
  });

  // ---- Filter pill toggle ----
  el.querySelectorAll<HTMLElement>(".rp-toggle").forEach((t) => {
    t.addEventListener("click", () => {
      const which = t.dataset.filter;
      if (which === "local") state.filterLocal = !state.filterLocal;
      else if (which === "web") state.filterWeb = !state.filterWeb;
      else if (which === "cite") state.filterCite = !state.filterCite;
      t.classList.toggle("active");
      runQuery();
    });
  });

  // ---- Findings buttons (Cite / Open / Remove) ----
  findings.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    const citeBtn = target.closest<HTMLElement>(".f-cite-btn");
    if (citeBtn) {
      const idx = Number(citeBtn.dataset.resultIdx);
      const r = state.results[idx];
      if (r) {
        state.tracker.cite({ source: r.name, line: r.line, claim: r.snippet });
        renderAll();
      }
      return;
    }

    const openBtn = target.closest<HTMLElement>(".f-open-btn");
    if (openBtn) {
      const name = openBtn.dataset.doc;
      if (name) {
        state.activeDoc = name;
        renderAll();
      }
      return;
    }

    const uncite = target.closest<HTMLElement>(".f-uncite-btn");
    if (uncite) {
      const idx = Number(uncite.dataset.citeIdx);
      state.tracker.remove(idx);
      renderAll();
      return;
    }
  });

  // ---- Export citations as JSON ----
  exportBtn.addEventListener("click", () => {
    const blob = new Blob([state.tracker.exportJSON()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "citations.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  return el;
}

// Tiny escape helpers — used in templated innerHTML construction. Keep
// untrusted text out of attribute values + element text.
function escText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return escText(s).replace(/"/g, "&quot;");
}

let paperEl: HTMLElement | null = null;
let researchEl: HTMLElement | null = null;

export function buildModes(workbench: HTMLElement) {
  paperEl = buildPaperMode();
  researchEl = buildResearchMode();
  workbench.appendChild(paperEl);
  workbench.appendChild(researchEl);
}

export function activateMode(key: string, workbench: HTMLElement | null) {
  if (!workbench) return;
  workbench.dataset.mode = key;
  const showPaper = key === "layout";
  const showResearch = key === "research";
  if (paperEl)    paperEl.style.display    = showPaper    ? "" : "none";
  if (researchEl) researchEl.style.display = showResearch ? "" : "none";
}
