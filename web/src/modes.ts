// Paper Mode (#02 LAYOUT) + Research Mode (#03 RESEARCH) — bundle ports.
//
// Both modes render full-area replacements inside .workbench. The workbench
// children (palette / center-col / sidebar) are hidden via [data-mode] on
// .workbench when mode != "model", and the matching .paper-mode / .research-mode
// container shows.

import { iconSVG } from "./icons";

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

type ResearchDoc = { name: string; source: string; meta: string; tags: string[] };
const RESEARCH_DOCS: ResearchDoc[] = [
  { name: "ASHRAE 90.1-2022 §5.5",       source: "WEB · ashrae.org",          meta: "PDF · 412pp · cached", tags: ["envelope", "climate-4A"] },
  { name: "Local Code · Boston Z-Art.32", source: "LOCAL · /codes/boston/",   meta: "PDF · 88pp",            tags: ["zoning", "setback"] },
  { name: "Site Survey · Beacon St 142", source: "LOCAL · uploads/",          meta: "DWG · 1.2MB",           tags: ["survey"] },
  { name: "Passive House Std. 9.1",      source: "WEB · phius.org",           meta: "PDF · 64pp",            tags: ["envelope", "airtight"] },
  { name: "IFC4 Schema · Walls",         source: "WEB · buildingsmart.org",   meta: "HTML",                  tags: ["schema", "IFC4"] },
  { name: "Precedent · Bohlin Cabin",    source: "WEB · archdaily",           meta: "Article · 18 imgs",     tags: ["precedent", "timber"] },
];

const RESEARCH_DOC_BODY = `
  <div class="rdv-page">
    <h4>5.5  Building Envelope Requirements</h4>
    <p>For climate zone 4A, <span class="rdv-highlight">opaque assemblies shall meet the U-factor and continuous insulation criteria of Table 5.5-4</span><span class="citation-anchor">1</span>. Above-grade walls of mass type shall not exceed U-0.090, with continuous insulation of R-7.5 c.i. minimum.</p>
    <p>Vertical fenestration U-factor shall not exceed 0.36 for fixed glazing and 0.43 for operable. <span class="rdv-highlight">SHGC shall not exceed 0.36 for north-facing fenestration with PF &lt; 0.5</span><span class="citation-anchor">2</span>.</p>
    <p>Roof assemblies above conditioned space shall meet R-30 c.i. for insulation entirely above deck. Skylights shall not exceed 3% of gross roof area unless additional energy modeling demonstrates compliance with §11.</p>
    <p>Air leakage through the building envelope, when measured per ASTM E779 at 75 Pa, shall not exceed 0.40 cfm/ft² of envelope area for the whole building.</p>
    <span class="rdv-page-num">p. 142 / 412</span>
  </div>
  <div class="rdv-page">
    <h4>5.5.4  Mass Walls</h4>
    <p>Mass walls of CMU or concrete shall comply with Table 5.5-4. <span class="rdv-highlight">Where exterior insulation is used, joints in the insulation shall be staggered and offset minimum 6 inches</span><span class="citation-anchor">3</span> from joints in the substrate.</p>
    <p>Thermal bridging at slab edges, parapets, and balcony attachments shall be detailed to limit linear transmittance ψ ≤ 0.30 W/m·K per ISO 14683.</p>
    <span class="rdv-page-num">p. 143 / 412</span>
  </div>
`;

const FINDINGS_HTML = `
  <div class="finding">
    <div class="f-q">Q · envelope U-factor for climate 4A?</div>
    <div class="f-a">Mass walls: U ≤ 0.090, with R-7.5 continuous insulation minimum<span class="f-cite">1</span>.</div>
    <div class="f-meta">ASHRAE 90.1-2022 · p.142 · 0.4s</div>
  </div>
  <div class="finding">
    <div class="f-q">Q · north-facing SHGC limit?</div>
    <div class="f-a">SHGC ≤ 0.36 for fixed glazing on north walls when PF &lt; 0.5<span class="f-cite">2</span>.</div>
    <div class="f-meta">ASHRAE 90.1-2022 · p.142</div>
  </div>
  <div class="finding">
    <div class="f-q">Q · setback for Boston Art-32 R-1?</div>
    <div class="f-a">Front 20 ft min · Side 10 ft each · Rear 25 ft when abutting residential. 35 ft height cap unless variance.</div>
    <div class="f-meta">Boston Z-Art.32 · §32-23 · p.41</div>
  </div>
  <div class="finding">
    <div class="f-q">Q · joint stagger for ext. insulation?</div>
    <div class="f-a">Stagger insulation joints ≥ 6 in. offset from substrate joints<span class="f-cite">3</span>.</div>
    <div class="f-meta">ASHRAE 90.1-2022 · §5.5.4</div>
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

function buildResearchMode(): HTMLElement {
  const el = document.createElement("div");
  el.className = "research-mode mode-pane";
  el.dataset.modePane = "research";
  el.style.display = "none";

  const corpusItems = RESEARCH_DOCS.map((d, i) => `
    <div class="doc-card${i === 0 ? " active" : ""}" data-doc="${i}">
      <div class="dc-name">${d.name}</div>
      <div class="dc-source">${d.source}</div>
      <div class="dc-meta">${d.meta}</div>
      <div class="dc-tags">${d.tags.map((t) => `<span class="dc-tag">${t}</span>`).join("")}</div>
    </div>
  `).join("");

  el.innerHTML = `
    <div class="research-col">
      <div class="research-header">${iconSVG("import", 13)} CORPUS <span class="pill">${RESEARCH_DOCS.length} docs</span></div>
      <div class="research-body" id="research-corpus">${corpusItems}</div>
    </div>
    <div class="research-doc-viewer">
      <div class="rdv-toolbar">
        <span style="font-weight:700; color:var(--ink);" id="rdv-active-name">${RESEARCH_DOCS[0].name}</span>
        <span style="flex:1;"></span>
        <span>find:</span>
        <input value="setback"/>
        <span>· 12 hits</span>
      </div>
      <div class="rdv-pages">${RESEARCH_DOC_BODY}</div>
    </div>
    <div class="research-col">
      <div class="research-header">${iconSVG("sparkle", 13)} FINDINGS <span class="pill">3 cited</span></div>
      <div class="research-body findings-list">${FINDINGS_HTML}</div>
      <div class="research-prompt">
        <textarea placeholder="ask the corpus  ·  e.g. what is the max FAR for this lot?"></textarea>
        <div class="rp-actions">
          <div class="rp-toggles">
            <span class="rp-toggle active">LOCAL</span>
            <span class="rp-toggle active">WEB</span>
            <span class="rp-toggle">CITE</span>
          </div>
          <span>GEMMA·3 · 2.6B · ⏎</span>
        </div>
      </div>
    </div>
  `;

  // Doc-card click → swap active.
  const corpus = el.querySelector("#research-corpus") as HTMLElement;
  const activeName = el.querySelector("#rdv-active-name") as HTMLElement;
  corpus.addEventListener("click", (e) => {
    const card = (e.target as HTMLElement).closest(".doc-card") as HTMLElement | null;
    if (!card) return;
    const i = Number(card.dataset.doc || "0");
    corpus.querySelectorAll(".doc-card.active").forEach((c) => c.classList.remove("active"));
    card.classList.add("active");
    activeName.textContent = RESEARCH_DOCS[i].name;
  });

  // Toggle pills.
  el.querySelectorAll(".rp-toggle").forEach((t) => {
    t.addEventListener("click", () => t.classList.toggle("active"));
  });

  return el;
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
