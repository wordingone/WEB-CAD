// Paper Mode (#02 LAYOUT) + Research Mode (#03 RESEARCH).
//
// Both modes render full-area replacements inside .workbench. The workbench
// children (palette / center-col / sidebar) are hidden via [data-mode] on
// .workbench when mode != "model", and the matching .paper-mode / .research-mode
// container shows.
//
// PaperMode (T15) uses the layout.ts controller — sheet sizes, click-drag
// panel creation, viewport pickers, scale bars, editable title block, and
// PDF/SVG/AI/DWG export. Existing viewports (top/front/right/perspective)
// ARE the cameras; panels just choose which one to render at a given scale.

import { iconSVG } from "./icons";
import { buildLayoutMode, addPanel } from "./layout";

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
  // Build the layout controller into the host. It will inject .paper-toolbar,
  // .paper-stage > .paper-sheet, and the editable title block. Seed with
  // four panels so the first paint mirrors the original 4-cell mockup.
  buildLayoutMode(el, {
    size: "A1",
    orientation: "landscape",
    initialPanels: [
      { x: 60,  y: 60,  w: 380, h: 240, viewport: "top",         scale: "1:100", title: "A · PLAN" },
      { x: 470, y: 60,  w: 380, h: 240, viewport: "front",       scale: "1:100", title: "B · ELEVATION" },
      { x: 60,  y: 320, w: 380, h: 240, viewport: "right",       scale: "1:100", title: "C · SECTION" },
      { x: 470, y: 320, w: 380, h: 240, viewport: "axonometric", scale: "NTS",   title: "D · AXONOMETRIC" },
    ],
  });
  // Suppress the "unused" warning on addPanel without removing it from the
  // public surface — modes.ts re-exports it for any consumer that wants it.
  void addPanel;
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
