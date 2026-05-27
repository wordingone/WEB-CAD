// layout.ts — paper-space layout mode. LayoutController + public API.
// Types/utils: ./layout-types. SVG/PDF/DXF export: ./layout-export.

import { iconSVG } from "../ui/icons";
import type { Viewer } from "../viewer/viewer";
import { clippingPlaneStore } from "../geometry/clipping-planes";
import { levelStore } from "../geometry/levels";
import {
  sheetMm, sheetPx, MM_TO_PX, DEFAULT_CUSTOM, DEFAULT_PROVIDER, DEFAULT_TITLE,
  VIEWPORT_LABELS, activeScalePresets, DISPLAY_MODES, renderScaleBar,
  type SheetSizeId, type Orientation, type SheetDims, type ViewportId, type ScaleId,
  type DisplayMode, type SceneBoundsProvider,
  type PanelState, type PanelInit, type TitleBlock, type LayoutOptions,
} from "./layout-types";
import {
  layoutViewportToViewName,
  composeSvg, exportLayoutAsPdfImpl, exportLayoutAsAiImpl,
  exportLayoutAsDwgFallbackImpl, exportLayoutAsDxfImpl,
  applySheetCut, resetSheetCut,
  type SheetTemplate, type SheetLevelRef,
} from "./layout-export";

// Re-export public types so existing callers (modes.ts, dom-events.ts, etc.) are unaffected.
export type {
  SheetSizeId, Orientation, ViewportId, ScaleId, DisplayMode,
  SceneBounds, SceneBoundsProvider,
  PanelState, PanelInit, TitleBlock, LayoutOptions, DetailRef,
} from "./layout-types";
export { parseScale } from "./layout-types";
export type {
  SheetViewType, CardinalDir, SectionAxis, SheetTemplate, SheetLevelRef,
} from "./layout-export";
export { DEMO_SHEET_SET, applySheetCut, resetSheetCut, exportSheetSetAsPdf } from "./layout-export";

interface SheetData {
  id: string;
  name: string;
  size: SheetSizeId;
  orientation: Orientation;
  customMm: SheetDims;
  panels: PanelState[];
  template?: SheetTemplate;
}

let _sheetIdSeq = 0;
const newSheetId = (): string => `sheet-${++_sheetIdSeq}`;

let _panelIdSeq = 0;
const newPanelId = (): string => `panel-${++_panelIdSeq}`;

// Preset IDs available from the "+" sheet picker.
type SheetPresetId = "plan" | "rcp" | "elevation" | "section" | "blank";

// Static sheets always present: roof plan + 4 elevations + 2 sections.
// Ordered front-to-back so the tab strip reads logically left-to-right.
interface StaticSheetDef { name: string; viewport: ViewportId; scale: ScaleId; displayMode: DisplayMode; template?: SheetTemplate; }
const STATIC_SHEET_DEFS: StaticSheetDef[] = [
  { name: "Roof Plan",            viewport: "top",   scale: "1:100", displayMode: "technical" },
  { name: "South Elevation",      viewport: "front", scale: "1:100", displayMode: "technical", template: { id: "S3", viewType: "elevation", title: "South Elevation",      cardinalDir: "S", farClip: 40, camera: "front" } },
  { name: "East Elevation",       viewport: "right", scale: "1:100", displayMode: "technical", template: { id: "S2", viewType: "elevation", title: "East Elevation",       cardinalDir: "E", farClip: 40, camera: "right" } },
  { name: "North Elevation",      viewport: "back",  scale: "1:100", displayMode: "technical", template: { id: "S1", viewType: "elevation", title: "North Elevation",      cardinalDir: "N", farClip: 40, camera: "front" } },
  { name: "West Elevation",       viewport: "left",  scale: "1:100", displayMode: "technical", template: { id: "S4", viewType: "elevation", title: "West Elevation",       cardinalDir: "W", farClip: 40, camera: "right" } },
  { name: "Longitudinal Section", viewport: "front", scale: "1:100", displayMode: "technical", template: { id: "S5", viewType: "section",   title: "Longitudinal Section", sectionAxis: "NS-1",           camera: "front" } },
  { name: "Transverse Section",   viewport: "right", scale: "1:100", displayMode: "technical", template: { id: "S7", viewType: "section",   title: "Transverse Section",   sectionAxis: "EW-1",           camera: "right" } },
];

// Presets for user-added sheets via the "+" picker.
const ADD_SHEET_DEFS: Record<Exclude<SheetPresetId, "blank">, StaticSheetDef> = {
  plan:      { name: "Plan",         viewport: "top",   scale: "1:100", displayMode: "technical" },
  rcp:       { name: "Ceiling Plan", viewport: "top",   scale: "1:100", displayMode: "technical" },
  elevation: { name: "Elevation",    viewport: "front", scale: "1:100", displayMode: "technical" },
  section:   { name: "Section",      viewport: "front", scale: "1:100", displayMode: "technical" },
};

// Plan-view SVG blocks placed on the paper sheet when the user clicks in layout mode.
// Dimensions in CSS px at paper-space zoom. Blocks remain active for repeated placement.
function _stairSvg(dir: "UP" | "DN", w: number, h: number): string {
  const steps = 8;
  const rh = h / steps;
  let lines = "";
  for (let i = 1; i <= steps; i++) lines += `<line x1="0" y1="${Math.round(i * rh)}" x2="${w}" y2="${Math.round(i * rh)}"/>`;
  const mid = Math.round(w / 2);
  const ay = Math.round(h * 0.5);
  const al = Math.round(h * 0.15);
  const arrow = dir === "UP"
    ? `<path d="M${mid} ${ay + al} L${mid} ${ay - al} M${mid - 5} ${ay - al + 5} L${mid} ${ay - al} L${mid + 5} ${ay - al + 5}"/>`
    : `<path d="M${mid} ${ay - al} L${mid} ${ay + al} M${mid - 5} ${ay + al - 5} L${mid} ${ay + al} L${mid + 5} ${ay + al - 5}"/>`;
  return `<svg width="100%" height="100%" viewBox="0 0 ${w} ${h}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="0" y="0" width="${w}" height="${h}"/>${lines}${arrow}<text x="${mid + 8}" y="${ay + 5}" font-family="monospace" font-size="10" fill="currentColor" stroke="none">${dir}</text></svg>`;
}
const BLOCK_DEFS: Record<string, { w: number; h: number; svg: string }> = {
  "door-single":    { w: 64,  h: 64,  svg: `<svg width="100%" height="100%" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="0" y1="0" x2="64" y2="0"/><path d="M64 0 A64 64 0 0 0 0 64"/><line x1="0" y1="0" x2="0" y2="9"/><line x1="0" y1="64" x2="0" y2="55"/><line x1="64" y1="0" x2="64" y2="9"/></svg>` },
  "door-double":    { w: 128, h: 64,  svg: `<svg width="100%" height="100%" viewBox="0 0 128 64" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M0 0 L64 0"/><path d="M64 0 A64 64 0 0 0 0 64"/><path d="M128 0 L64 0"/><path d="M64 0 A64 64 0 0 1 128 64"/><line x1="0" y1="0" x2="0" y2="9"/><line x1="0" y1="64" x2="0" y2="55"/><line x1="128" y1="0" x2="128" y2="9"/><line x1="128" y1="64" x2="128" y2="55"/></svg>` },
  "door-sliding":   { w: 130, h: 28,  svg: `<svg width="100%" height="100%" viewBox="0 0 130 28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="0" y="4" width="76" height="16"/><rect x="54" y="8" width="76" height="16"/><line x1="0" y1="0" x2="0" y2="28"/><line x1="130" y1="0" x2="130" y2="28"/></svg>` },
  "window-single":  { w: 96,  h: 18,  svg: `<svg width="100%" height="100%" viewBox="0 0 96 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="0" y="0" width="96" height="18"/><line x1="0" y1="6" x2="96" y2="6"/><line x1="0" y1="12" x2="96" y2="12"/></svg>` },
  "window-casement":{ w: 96,  h: 18,  svg: `<svg width="100%" height="100%" viewBox="0 0 96 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="0" y="0" width="96" height="18"/><line x1="0" y1="6" x2="96" y2="6"/><line x1="0" y1="12" x2="96" y2="12"/><line x1="0" y1="12" x2="96" y2="0" stroke-dasharray="4 2"/></svg>` },
  "stair-up":       { w: 72,  h: 140, svg: _stairSvg("UP", 72, 140) },
  "stair-down":     { w: 72,  h: 140, svg: _stairSvg("DN", 72, 140) },
  "toilet":         { w: 36,  h: 60,  svg: `<svg width="100%" height="100%" viewBox="0 0 36 60" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="0" y="0" width="36" height="20" rx="2"/><ellipse cx="18" cy="44" rx="16" ry="15"/></svg>` },
  "sink":           { w: 52,  h: 44,  svg: `<svg width="100%" height="100%" viewBox="0 0 52 44" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="0" y="0" width="52" height="44" rx="2"/><ellipse cx="26" cy="22" rx="18" ry="14"/><circle cx="26" cy="22" r="3"/></svg>` },
  "bathtub":        { w: 56,  h: 120, svg: `<svg width="100%" height="100%" viewBox="0 0 56 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="0" y="0" width="56" height="120" rx="4"/><ellipse cx="28" cy="72" rx="20" ry="38"/><circle cx="28" cy="16" r="7"/></svg>` },
  "shower":         { w: 72,  h: 72,  svg: `<svg width="100%" height="100%" viewBox="0 0 72 72" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="0" y="0" width="72" height="72" rx="4"/><path d="M0 0 Q36 36 72 0" fill="none"/><circle cx="56" cy="56" r="5"/></svg>` },
  "desk":           { w: 100, h: 50,  svg: `<svg width="100%" height="100%" viewBox="0 0 100 50" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="0" y="0" width="100" height="50"/><path d="M0 40 Q50 50 100 40"/></svg>` },
  "chair":          { w: 40,  h: 40,  svg: `<svg width="100%" height="100%" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="4" y="14" width="32" height="26"/><path d="M4 14 A18 18 0 0 1 36 14"/></svg>` },
  "table-rnd":      { w: 60,  h: 60,  svg: `<svg width="100%" height="100%" viewBox="0 0 60 60" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="30" cy="30" r="28"/></svg>` },
  "sofa":           { w: 130, h: 55,  svg: `<svg width="100%" height="100%" viewBox="0 0 130 55" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="0" y="0" width="130" height="55" rx="4"/><rect x="4" y="4" width="16" height="47" rx="3"/><rect x="110" y="4" width="16" height="47" rx="3"/><line x1="20" y1="38" x2="110" y2="38"/><line x1="65" y1="38" x2="65" y2="51"/></svg>` },
  "bed-sgl":        { w: 80,  h: 120, svg: `<svg width="100%" height="100%" viewBox="0 0 80 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="0" y="0" width="80" height="120"/><rect x="0" y="0" width="80" height="28"/><ellipse cx="40" cy="55" rx="22" ry="16"/></svg>` },
  "bed-dbl":        { w: 120, h: 120, svg: `<svg width="100%" height="100%" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="0" y="0" width="120" height="120"/><rect x="0" y="0" width="120" height="28"/><ellipse cx="32" cy="55" rx="20" ry="16"/><ellipse cx="88" cy="55" rx="20" ry="16"/><line x1="60" y1="28" x2="60" y2="120" stroke-dasharray="4 2"/></svg>` },
  "tree":           { w: 72,  h: 72,  svg: `<svg width="100%" height="100%" viewBox="0 0 72 72" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="36" cy="36" r="34"/><circle cx="36" cy="36" r="22"/><circle cx="36" cy="36" r="10"/><circle cx="20" cy="20" r="9"/><circle cx="52" cy="20" r="9"/><circle cx="20" cy="52" r="9"/><circle cx="52" cy="52" r="9"/></svg>` },
  "car":            { w: 90,  h: 190, svg: `<svg width="100%" height="100%" viewBox="0 0 90 190" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="5" y="5" width="80" height="180" rx="12"/><path d="M5 30 Q5 8 22 8"/><path d="M85 30 Q85 8 68 8"/><path d="M5 160 Q5 182 22 182"/><path d="M85 160 Q85 182 68 182"/><rect x="10" y="15" width="70" height="30" rx="4" stroke-width="0.8"/></svg>` },
  "person":         { w: 28,  h: 48,  svg: `<svg width="100%" height="100%" viewBox="0 0 28 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="14" cy="8" r="7"/><path d="M4 48 L4 22 Q4 16 14 16 Q24 16 24 22 L24 48"/><line x1="4" y1="32" x2="24" y2="32"/></svg>` },
};

// LayoutController is the per-host instance state. Stored on the host element
// via a WeakMap so the module-level export functions (addPanel, exportLayout*)
// can resolve it without callers passing the instance back in.
export class LayoutController {
  host: HTMLElement;
  sheets: SheetData[];
  activeSheetIdx: number = 0;
  bounds: SceneBoundsProvider;
  title: TitleBlock;

  // Getters proxy to active sheet so callers (export, addPanel, etc.) are unchanged.
  get activeSheet(): SheetData { return this.sheets[this.activeSheetIdx]; }
  get panels(): PanelState[] { return this.activeSheet.panels; }
  get size(): SheetSizeId { return this.activeSheet.size; }
  set size(v: SheetSizeId) { this.activeSheet.size = v; }
  get orientation(): Orientation { return this.activeSheet.orientation; }
  set orientation(v: Orientation) { this.activeSheet.orientation = v; }
  get customMm(): SheetDims { return this.activeSheet.customMm; }

  // DOM refs.
  sheetEl!: HTMLElement;
  toolbarEl!: HTMLElement;
  tabsScrollEl!: HTMLElement;
  private sizeSelEl!: HTMLSelectElement;
  private oriSelEl!: HTMLSelectElement;
  titleblockEl!: HTMLElement;

  // Drag-to-create state.
  private dragging: { startX: number; startY: number; el?: HTMLElement } | null = null;
  // Detail region drag state.
  private _detailDrag: {
    mode: "panel" | "sheet";
    parentId: string | null;
    parentEl: HTMLElement | null;
    parent: PanelState | null;
    startX: number;
    startY: number;
    ghost: HTMLElement;
  } | null = null;
  // Active ribbon tool (e.g. "detail"). null = default pointer.
  private activeTool: string | null = null;
  // Pan-tool drag state: screen origin + stage scroll origin.
  private _panDrag: { sx: number; sy: number; scrollLeft: number; scrollTop: number } | null = null;
  // Counter for detail label letters (A, B, C…).
  private _detailLabelSeq = 0;
  // Selected panel (for toolbar interaction).
  private selectedPanelId: string | null = null;
  // Live thumbnail canvases for detail panels: panelId → {canvas, viewName, displayMode}.
  private _thumbCanvases = new Map<string, { canvas: HTMLCanvasElement; viewName: "top" | "persp" | "front" | "right"; anchorX: number; anchorY: number; snapW: number; snapH: number; displayMode: DisplayMode }>();
  private _thumbRAF = 0;
  // Set by onSheetMouseUp when a drag-to-create completes; suppresses the
  // subsequent click event so click-to-add doesn't fire a second addPanel.
  private _dragCompleted = false;
  // Unlink button — visible only when activeSheet is linked to a clip plane (#1849 §5.4).
  private _unlinkBtn: HTMLElement | null = null;
  // Subscription for levelStore changes — auto-syncs plan sheets (#1846).
  private _levelUnsub: (() => void) | null = null;
  // levelId → sheetId for auto-named plan sheets (#1846). Per-instance to avoid cross-test pollution.
  private _planSheetByLevelId = new Map<string, string>();
  // sheetIds where user manually renamed — opts out of auto-rename on level rename (#1846).
  private _planSheetUserRenamed = new Set<string>();
  // levelId → sheetId for auto-named RCP sheets (#1844).
  private _rcpSheetByLevelId = new Map<string, string>();
  // sheetIds where user manually renamed the RCP tab (#1844).
  private _rcpSheetUserRenamed = new Set<string>();
  // Fit-to-stage scale factor (zoom). All mouse coords divided by this.
  private zoomFactor = 1;
  // Previous sheet pixel dimensions — used in applySheetDims to rescale panels proportionally.
  private _prevSheetPxW = 0;
  private _prevSheetPxH = 0;
  // Whether to render the title block.
  private _showTitleBlock: boolean;
  // Watches stage size changes (including mode-switch from display:none → flex).
  private _ro: ResizeObserver | null = null;
  // Active model-space navigation state (dblclick to enter, click-outside to exit).
  private _navPanelId: string | null = null;
  private _navDispose: (() => void) | null = null;
  private _navDocListener: ((e: MouseEvent) => void) | null = null;
  // Skip default panel seeding during initial build when caller supplies initialPanels.
  private _suppressSeed = false;

  constructor(host: HTMLElement, opts: LayoutOptions) {
    this.host = host;
    const size = opts.size ?? "Tabloid";
    const orientation = opts.orientation ?? "landscape";
    const customMm = opts.customMm ?? { ...DEFAULT_CUSTOM };
    // Static sheets (roof plan + 4 elevations + 2 sections). Plan/RCP sheets prepended by syncPlanSheets/syncRcpSheets.
    this.sheets = STATIC_SHEET_DEFS.map((def) => ({
      id: newSheetId(),
      name: def.name,
      size,
      orientation,
      customMm: { ...customMm },
      panels: [],
      template: def.template,
    }));
    this.activeSheetIdx = 0;
    this.bounds = opts.bounds ?? DEFAULT_PROVIDER;
    this.title = { ...DEFAULT_TITLE, ...(opts.titleBlock ?? {}) };
    this._showTitleBlock = opts.showTitleBlock ?? false;
    this._suppressSeed = (opts.initialPanels?.length ?? 0) > 0;
    this.build();
    this._suppressSeed = false;
    // Seed a full-page viewport into each static sheet.
    if (opts.spawnDefault !== false) {
      const hasInitial = (opts.initialPanels?.length ?? 0) > 0;
      // Dynamic (plan+RCP) sheets occupy the front; static sheets follow.
      const dynamicOffset = this._planSheetByLevelId.size + this._rcpSheetByLevelId.size;
      STATIC_SHEET_DEFS.forEach((def, i) => {
        if (i === 0 && hasInitial) return; // caller-supplied initialPanels go to first sheet instead
        this.switchSheet(dynamicOffset + i);
        this._spawnPresetPanel(def.viewport, def.scale, def.displayMode);
      });
      this.switchSheet(0); // activate Plan: Level 1 (first sheet)
    }
    // initialPanels go to the active (first) sheet.
    for (const p of opts.initialPanels ?? []) this.addPanel(p);
    // Re-fit whenever the stage changes size (covers mode-switch from display:none → flex).
    const stage = this.sheetEl.parentElement;
    if (stage && typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => requestAnimationFrame(() => this.fitToStage()));
      this._ro.observe(stage);
    }
  }

  // --- Build DOM -----

  private build(): void {
    this.host.innerHTML = "";
    this.host.classList.add("paper-mode");

    const stage = document.createElement("div");
    stage.className = "paper-stage";
    this.host.appendChild(stage);

    this.toolbarEl = document.createElement("div");
    this.toolbarEl.className = "paper-toolbar";
    this.host.appendChild(this.toolbarEl);
    this.buildToolbar();

    this.sheetEl = document.createElement("div");
    this.sheetEl.className = "paper-sheet";
    this.sheetEl.dataset.size = this.size;
    this.sheetEl.dataset.orientation = this.orientation;
    stage.appendChild(this.sheetEl);

    this.applySheetDims();

    // Click-and-drag panel creation. Bound on sheet so panel children block by
    // checking event.target before opening a drag.
    this.sheetEl.addEventListener("mousedown", (e) => this.onSheetMouseDown(e));
    this.sheetEl.addEventListener("mousemove", (e) => this.onSheetMouseMove(e));
    this.sheetEl.addEventListener("mouseup",   ()  => this.onSheetMouseUp());
    this.sheetEl.addEventListener("mouseleave",()  => this.onSheetMouseUp());
    // Click-to-add: single click on empty sheet area creates a default-size panel.
    // Fires after mouseup; suppressed when a drag-to-create just completed.
    this.sheetEl.addEventListener("click", (e) => this.onSheetClick(e));

    // Ribbon tool activation.
    window.addEventListener("ribbon:tool-click", (e: Event) => {
      const ce = e as CustomEvent<{ tool: string | null }>;
      const tool = ce.detail.tool;
      // Always clean up active drag state on tool switch.
      this._detailDrag?.ghost.remove();
      this._detailDrag = null;
      this.dragging?.el?.remove();
      this.dragging = null;
      this._panDrag = null;
      if (!tool || tool === "select") {
        this.activeTool = null;
        this.sheetEl.style.cursor = "";
      } else if (tool === "pan") {
        this.activeTool = "pan";
        this.sheetEl.style.cursor = "grab";
      } else if (tool === "zoom") {
        this.activeTool = "zoom";
        this.sheetEl.style.cursor = "zoom-in";
      } else {
        // All other tools: crosshair cursor, activeTool set for future handlers.
        this.activeTool = tool;
        this.sheetEl.style.cursor = "crosshair";
      }
    });

    // Title block — only when explicitly requested.
    this.titleblockEl = document.createElement("div");
    this.titleblockEl.className = "paper-titleblock";
    if (this._showTitleBlock) {
      this.sheetEl.appendChild(this.titleblockEl);
      this.renderTitleBlock();
    }

    // Subscribe to levelStore so plan + RCP sheets track level changes (#1846/#1844).
    if (this._levelUnsub) this._levelUnsub();
    this._levelUnsub = levelStore.subscribe(() => {
      this.syncPlanSheets();
      this.syncRcpSheets();
    });
    this.syncPlanSheets();
    this.syncRcpSheets();
  }

  private buildToolbar(): void {
    const tb = this.toolbarEl;
    tb.innerHTML = "";

    // Left: sheet tab strip (nav arrows + scrollable tabs + add).
    const tabStrip = document.createElement("div");
    tabStrip.className = "sheet-tab-strip";

    // Scroll-left button.
    const navL = document.createElement("button");
    navL.type = "button";
    navL.className = "sheet-tab-nav";
    navL.innerHTML = "&#9664;";
    navL.title = "Scroll tabs left";
    navL.addEventListener("click", () => {
      this.tabsScrollEl.scrollBy({ left: -120, behavior: "smooth" });
    });
    tabStrip.appendChild(navL);

    // Scrollable tabs container.
    const tabsScroll = document.createElement("div");
    tabsScroll.className = "sheet-tabs";
    this.tabsScrollEl = tabsScroll;
    tabStrip.appendChild(tabsScroll);

    // Scroll-right button.
    const navR = document.createElement("button");
    navR.type = "button";
    navR.className = "sheet-tab-nav";
    navR.innerHTML = "&#9654;";
    navR.title = "Scroll tabs right";
    navR.addEventListener("click", () => {
      this.tabsScrollEl.scrollBy({ left: 120, behavior: "smooth" });
    });
    tabStrip.appendChild(navR);

    // Add-sheet button — shows preset picker.
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "sheet-tab-add";
    addBtn.title = "Add sheet";
    addBtn.textContent = "+";
    addBtn.addEventListener("click", () => this.addSheet());
    tabStrip.appendChild(addBtn);

    tb.appendChild(tabStrip);
    this.renderTabs();

    // Right: settings (size, orient, custom dims).
    const settings = document.createElement("div");
    settings.className = "paper-toolbar-settings";

    // Sheet-size dropdown.
    const sizeSel = document.createElement("select");
    sizeSel.className = "paper-tool";
    sizeSel.setAttribute("aria-label", "Sheet size");
    const sizes: SheetSizeId[] = ["Tabloid", "Letter", "Legal", "A0", "A1", "A2", "A3", "A4", "Custom"];
    for (const s of sizes) {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s === "Tabloid" ? "11×17" : s;
      if (s === this.size) opt.selected = true;
      sizeSel.appendChild(opt);
    }
    sizeSel.addEventListener("change", () => {
      this.size = sizeSel.value as SheetSizeId;
      customWrap.classList.toggle("visible", this.size === "Custom");
      this.applySheetDims();
    });
    this.sizeSelEl = sizeSel;
    settings.appendChild(this.labelled("Size", sizeSel));

    // Orientation toggle.
    const oriSel = document.createElement("select");
    oriSel.className = "paper-tool";
    oriSel.setAttribute("aria-label", "Orientation");
    for (const o of ["landscape", "portrait"] as Orientation[]) {
      const opt = document.createElement("option");
      opt.value = o; opt.textContent = o.charAt(0).toUpperCase() + o.slice(1);
      if (o === this.orientation) opt.selected = true;
      oriSel.appendChild(opt);
    }
    oriSel.addEventListener("change", () => {
      this.orientation = oriSel.value as Orientation;
      this.applySheetDims();
    });
    this.oriSelEl = oriSel;
    settings.appendChild(this.labelled("Orient", oriSel));

    // Custom dims (visible only when Custom selected).
    const wIn = document.createElement("input");
    wIn.type = "number"; wIn.value = String(this.customMm.w); wIn.min = "10"; wIn.step = "1";
    wIn.className = "paper-tool paper-tool-num";
    wIn.setAttribute("aria-label", "Custom width (mm)");
    wIn.addEventListener("change", () => {
      this.customMm.w = Math.max(10, Number(wIn.value) || DEFAULT_CUSTOM.w);
      if (this.size === "Custom") this.applySheetDims();
    });
    const hIn = document.createElement("input");
    hIn.type = "number"; hIn.value = String(this.customMm.h); hIn.min = "10"; hIn.step = "1";
    hIn.className = "paper-tool paper-tool-num";
    hIn.setAttribute("aria-label", "Custom height (mm)");
    hIn.addEventListener("change", () => {
      this.customMm.h = Math.max(10, Number(hIn.value) || DEFAULT_CUSTOM.h);
      if (this.size === "Custom") this.applySheetDims();
    });
    const customWrap = document.createElement("span");
    customWrap.className = "paper-tool-custom";
    customWrap.appendChild(this.labelled("W mm", wIn));
    customWrap.appendChild(this.labelled("H mm", hIn));
    settings.appendChild(customWrap);

    tb.appendChild(settings);

    // Unlink button — shown when the active sheet is linked to a clip-plane entity (#1849 §5.4).
    const unlinkBtn = document.createElement("button");
    unlinkBtn.type = "button";
    unlinkBtn.className = "paper-tool paper-tool-unlink";
    unlinkBtn.style.cssText = "display:none; margin-left:8px; background:none; border:1px solid var(--hairline); border-radius:2px; color:var(--sanguine,#c0392b); cursor:pointer; padding:0 8px; line-height:24px; font-size:10px; letter-spacing:0.05em;";
    unlinkBtn.textContent = "Unlink";
    unlinkBtn.title = "Detach sheet from linked clipping plane (freeze current bounds)";
    unlinkBtn.addEventListener("click", () => {
      const host = this.host;
      const sheetId = this.activeSheet.id;
      unlinkClipPlaneSheet(host, sheetId);
      unlinkBtn.style.display = "none";
    });
    this._unlinkBtn = unlinkBtn;
    tb.appendChild(unlinkBtn);
  }

  private renderTabs(): void {
    const c = this.tabsScrollEl;
    if (!c) return;
    c.innerHTML = "";
    this.sheets.forEach((sheet, i) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `sheet-tab${i === this.activeSheetIdx ? " active" : ""}`;
      tab.textContent = sheet.name;
      tab.title = sheet.name;
      tab.addEventListener("click", () => this.switchSheet(i));
      // Double-click to rename — inline input (no window.prompt).
      tab.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const input = document.createElement("input");
        input.type = "text";
        input.className = "sheet-tab-rename-input";
        input.value = sheet.name;
        tab.textContent = "";
        tab.appendChild(input);
        input.focus();
        input.select();
        const commit = () => {
          const v = input.value.trim();
          if (v) sheet.name = v;
          this.renderTabs();
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (ke) => {
          if (ke.key === "Enter") { ke.preventDefault(); commit(); }
          else if (ke.key === "Escape") { ke.stopPropagation(); this.renderTabs(); }
        });
        input.addEventListener("click", (ie) => ie.stopPropagation());
      });
      c.appendChild(tab);
    });
    // Scroll active tab into view.
    const activeTab = c.children[this.activeSheetIdx] as HTMLElement | undefined;
    activeTab?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }

  private switchSheet(idx: number): void {
    if (idx < 0 || idx >= this.sheets.length || idx === this.activeSheetIdx) return;
    this.activeSheetIdx = idx;
    this._prevSheetPxW = 0; this._prevSheetPxH = 0;
    // Clear panels from DOM (keep sheet element, titleblock).
    this.sheetEl.querySelectorAll(".paper-cell").forEach((el) => el.remove());
    // Apply new sheet size/orientation.
    this.applySheetDims();
    // Re-render this sheet's panels.
    for (const p of this.activeSheet.panels) this.renderPanel(p);
    // Sync settings dropdowns.
    if (this.sizeSelEl) this.sizeSelEl.value = this.size;
    if (this.oriSelEl) this.oriSelEl.value = this.orientation;
    // Update Unlink button visibility for the new active sheet (#1849 §5.4).
    if (this._unlinkBtn) {
      const isLinked = _sheetClipLinks.has(this.activeSheet.id);
      this._unlinkBtn.style.display = isLinked ? "inline-block" : "none";
    }
    // Apply or reset sheet cut (#187) — only when the layout panel is visible.
    // During LayoutController initialization the host has display:none, so this
    // guard prevents clip planes from leaking into the model viewport at startup.
    if (this.host.style.display !== "none") this.applyActiveCut();
    // Update tab highlight.
    this.renderTabs();
  }

  applyActiveCut(): void {
    const _viewer = (window as unknown as { __viewer?: Viewer }).__viewer;
    if (!_viewer) return;
    const { template } = this.activeSheet;
    if (template) {
      const levels: Record<string, SheetLevelRef> = {};
      for (const lvl of levelStore.all()) levels[lvl.id] = { elevation: lvl.elevation, height: lvl.height };
      applySheetCut(_viewer, template, levels);
    } else {
      resetSheetCut(_viewer);
    }
  }

  /**
   * Sync plan sheets with the levelStore (#1846).
   * Called once on init and on every levelStore change.
   * - Adds a plan sheet for any level with no linked sheet.
   * - Renames existing linked sheets when the level's name changes (unless user-renamed).
   * - Removes plan sheets for levels that have been deleted.
   */
  private syncPlanSheets(): void {
    const levels = levelStore.all();
    const currentLevelIds = new Set(levels.map(l => l.id));

    // Remove sheets for deleted levels.
    for (const [levelId, sheetId] of [...this._planSheetByLevelId.entries()]) {
      if (!currentLevelIds.has(levelId)) {
        const idx = this.sheets.findIndex(s => s.id === sheetId);
        if (idx !== -1) {
          if (this.activeSheetIdx > idx) this.activeSheetIdx--;
          else if (this.activeSheetIdx === idx) this.activeSheetIdx = Math.max(0, idx - 1);
          this.sheets.splice(idx, 1);
        }
        this._planSheetByLevelId.delete(levelId);
        this._planSheetUserRenamed.delete(sheetId);
      }
    }

    // Add or rename sheets for current levels.
    for (const level of levels) {
      const expectedName = `Plan: ${level.name}`;
      const existingSheetId = this._planSheetByLevelId.get(level.id);
      if (!existingSheetId) {
        // Insert new plan sheet after existing plan sheets (index = current plan count).
        // Plans occupy the front of the sheet list; presets follow (#1847).
        const insertIdx = this._planSheetByLevelId.size;
        const id = newSheetId();
        this._planSheetByLevelId.set(level.id, id);
        const refSheet = this.sheets[0];
        const newSheet: SheetData = {
          id,
          name: expectedName,
          size: refSheet?.size ?? "Tabloid",
          orientation: refSheet?.orientation ?? "landscape",
          customMm: refSheet ? { ...refSheet.customMm } : { ...DEFAULT_CUSTOM },
          panels: [],
          template: { id: `plan-${level.id}`, viewType: "plan", title: expectedName, levelId: level.id, cutOffset: 1.372, camera: "top" },
        };
        this.sheets.splice(insertIdx, 0, newSheet);
        if (this.activeSheetIdx >= insertIdx) this.activeSheetIdx++;
        // Seed with a full-page top-down viewport so the sheet isn't blank.
        // Suppressed during initial build when caller supplies initialPanels.
        if (!this._suppressSeed) {
          const mm = sheetMm(newSheet.size, newSheet.orientation, newSheet.customMm);
          const mr = 0.015;
          newSheet.panels.push({
            id: newPanelId(),
            x: Math.round(mm.w * MM_TO_PX * mr), y: Math.round(mm.h * MM_TO_PX * mr),
            w: Math.round(mm.w * MM_TO_PX * (1 - 2 * mr)), h: Math.round(mm.h * MM_TO_PX * (1 - 2 * mr)),
            viewport: "top", scale: "1:100", title: VIEWPORT_LABELS["top"],
            border: "thin", displayMode: "technical",
          });
        }
      } else if (!this._planSheetUserRenamed.has(existingSheetId)) {
        // Rename if level was renamed.
        const sheet = this.sheets.find(s => s.id === existingSheetId);
        if (sheet && sheet.name !== expectedName) sheet.name = expectedName;
      }
    }

    this.renderTabs();
  }

  /** Return the levelId linked to a plan sheet, or undefined if not a plan sheet (#1846). */
  getLinkedLevelId(sheetId: string): string | undefined {
    for (const [levelId, sid] of this._planSheetByLevelId) {
      if (sid === sheetId) return levelId;
    }
    return undefined;
  }

  /** Mark a plan sheet as user-renamed — opt out of auto-rename on level rename (#1846). */
  markUserRenamed(sheetId: string): void {
    this._planSheetUserRenamed.add(sheetId);
  }

  /** Sync RCP sheets with levelStore — mirrors syncPlanSheets() with "RCP:" prefix (#1844). */
  private syncRcpSheets(): void {
    const levels = levelStore.all();
    const currentLevelIds = new Set(levels.map(l => l.id));

    for (const [levelId, sheetId] of [...this._rcpSheetByLevelId.entries()]) {
      if (!currentLevelIds.has(levelId)) {
        const idx = this.sheets.findIndex(s => s.id === sheetId);
        if (idx !== -1) {
          if (this.activeSheetIdx > idx) this.activeSheetIdx--;
          else if (this.activeSheetIdx === idx) this.activeSheetIdx = Math.max(0, idx - 1);
          this.sheets.splice(idx, 1);
        }
        this._rcpSheetByLevelId.delete(levelId);
        this._rcpSheetUserRenamed.delete(sheetId);
      }
    }

    for (const level of levels) {
      const expectedName = `RCP: ${level.name}`;
      const existingSheetId = this._rcpSheetByLevelId.get(level.id);
      if (!existingSheetId) {
        // Insert after all plan sheets and existing RCP sheets.
        // Layout: [Plan(s)][RCP(s)][Static: Roof Plan, Elevations, Sections]
        const insertIdx = this._planSheetByLevelId.size + this._rcpSheetByLevelId.size;
        const id = newSheetId();
        this._rcpSheetByLevelId.set(level.id, id);
        const refSheet = this.sheets[0];
        const newSheet: SheetData = {
          id,
          name: expectedName,
          size: refSheet?.size ?? "Tabloid",
          orientation: refSheet?.orientation ?? "landscape",
          customMm: refSheet ? { ...refSheet.customMm } : { ...DEFAULT_CUSTOM },
          panels: [],
          template: { id: `rcp-${level.id}`, viewType: "rcp", title: expectedName, levelId: level.id, rcpCutOffset: 2.44, camera: "top" },
        };
        this.sheets.splice(insertIdx, 0, newSheet);
        if (this.activeSheetIdx >= insertIdx) this.activeSheetIdx++;
        // Seed with a full-page top-down viewport (reflected ceiling plan is a top view at ceiling height).
        // Suppressed during initial build when caller supplies initialPanels.
        if (!this._suppressSeed) {
          const mm = sheetMm(newSheet.size, newSheet.orientation, newSheet.customMm);
          const mr = 0.015;
          newSheet.panels.push({
            id: newPanelId(),
            x: Math.round(mm.w * MM_TO_PX * mr), y: Math.round(mm.h * MM_TO_PX * mr),
            w: Math.round(mm.w * MM_TO_PX * (1 - 2 * mr)), h: Math.round(mm.h * MM_TO_PX * (1 - 2 * mr)),
            viewport: "top", scale: "1:100", title: "CEILING PLAN",
            border: "thin", displayMode: "technical",
          });
        }
      } else if (!this._rcpSheetUserRenamed.has(existingSheetId)) {
        const sheet = this.sheets.find(s => s.id === existingSheetId);
        if (sheet && sheet.name !== expectedName) sheet.name = expectedName;
      }
    }

    this.renderTabs();
  }

  /** Return the levelId linked to an RCP sheet, or undefined if not an RCP sheet (#1844). */
  getRcpLinkedLevelId(sheetId: string): string | undefined {
    for (const [levelId, sid] of this._rcpSheetByLevelId) {
      if (sid === sheetId) return levelId;
    }
    return undefined;
  }

  /** Mark an RCP sheet as user-renamed — opt out of auto-rename on level rename (#1844). */
  markRcpUserRenamed(sheetId: string): void {
    this._rcpSheetUserRenamed.add(sheetId);
  }

  /** Auto-create a named sheet linked to a clipping-plane entity (#1849). Returns new sheet id. */
  addLinkedSheet(name: string, clipPlaneId?: string): string {
    const id = newSheetId();
    // Store the link BEFORE switchSheet so the Unlink button appears on first switch.
    if (clipPlaneId) _sheetClipLinks.set(id, clipPlaneId);
    this.sheets.push({
      id,
      name,
      size: this.size,
      orientation: this.orientation,
      customMm: { ...this.customMm },
      panels: [],
      template: clipPlaneId ? { id: `linked-${id}`, viewType: "section", title: name, clipPlaneId, camera: "front" } : undefined,
    });
    this.renderTabs();
    this.switchSheet(this.sheets.length - 1);
    return id;
  }

  /** Compute the insertion index for a user-added sheet of the given type.
   *  Layout groups: [Plan(s)][RCP(s)][Static: Roof Plan, Elevations, Sections]. */
  private _typeInsertIdx(presetId: SheetPresetId): number {
    let i = 0;
    // Skip level-linked plan sheets.
    while (i < this.sheets.length && this.sheets[i].name.startsWith("Plan:")) i++;
    if (presetId === "plan") return i;
    // Skip level-linked RCP sheets.
    while (i < this.sheets.length && this.sheets[i].name.startsWith("RCP:")) i++;
    if (presetId === "rcp") return i;
    // Elevation, section, blank → append after all dynamic sheets.
    return this.sheets.length;
  }

  private addSheet(presetId?: SheetPresetId): void {
    if (!presetId) { this._showPresetPicker(); return; }
    const def = presetId !== "blank" ? ADD_SHEET_DEFS[presetId] : null;
    const insertIdx = this._typeInsertIdx(presetId);
    const newSheet: SheetData = {
      id: newSheetId(),
      name: def ? def.name : `Sheet ${this.sheets.length + 1}`,
      size: this.size,
      orientation: this.orientation,
      customMm: { ...this.customMm },
      panels: [],
    };
    this.sheets.splice(insertIdx, 0, newSheet);
    this.switchSheet(insertIdx);
    if (def) this._spawnPresetPanel(def.viewport, def.scale, def.displayMode);
    else this._spawnDefaultPanel();
  }

  private _spawnPresetPanel(viewport: ViewportId, scale: ScaleId, displayMode: DisplayMode): void {
    const mm = sheetMm(this.size, this.orientation, this.customMm);
    const r = 0.015; // 1.5% margin → ~97% content area
    this.addPanel({
      x: Math.round(mm.w * MM_TO_PX * r),
      y: Math.round(mm.h * MM_TO_PX * r),
      w: Math.round(mm.w * MM_TO_PX * (1 - 2 * r)),
      h: Math.round(mm.h * MM_TO_PX * (1 - 2 * r)),
      viewport, scale, displayMode,
    });
  }

  private _spawnDefaultPanel(): void {
    this._spawnPresetPanel("perspective", "1:100", "shaded");
  }

  private _showPresetPicker(): void {
    const overlay = document.createElement("div");
    overlay.className = "sheet-preset-picker";
    const dismiss = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) dismiss(); });
    const presets: Array<{ id: SheetPresetId; label: string }> = [
      { id: "plan",      label: "Plan" },
      { id: "rcp",       label: "Ceiling Plan" },
      { id: "elevation", label: "Elevation" },
      { id: "section",   label: "Section" },
      { id: "blank",     label: "Blank" },
    ];
    const grid = document.createElement("div");
    grid.className = "sheet-preset-grid";
    for (const p of presets) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sheet-preset-btn";
      btn.dataset.preset = p.id;
      btn.textContent = p.label;
      btn.addEventListener("click", () => { dismiss(); this.addSheet(p.id); });
      grid.appendChild(btn);
    }
    overlay.appendChild(grid);
    this.host.appendChild(overlay);
  }

  private labelled(name: string, control: HTMLElement): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "paper-tool-label";
    const k = document.createElement("span");
    k.className = "paper-tool-k";
    k.textContent = name;
    wrap.appendChild(k);
    wrap.appendChild(control);
    return wrap;
  }

  private applySheetDims(): void {
    const mm = sheetMm(this.size, this.orientation, this.customMm);
    const px = sheetPx(mm);
    if (this._prevSheetPxW > 0 && this._prevSheetPxH > 0 && this.panels.length > 0) {
      const sx = px.w / this._prevSheetPxW;
      const sy = px.h / this._prevSheetPxH;
      for (const p of this.panels) {
        p.x = Math.round(p.x * sx); p.y = Math.round(p.y * sy);
        p.w = Math.round(p.w * sx); p.h = Math.round(p.h * sy);
      }
      for (const p of this.panels) this.renderPanel(p);
    }
    this._prevSheetPxW = px.w;
    this._prevSheetPxH = px.h;
    this.sheetEl.style.width = `${px.w}px`;
    this.sheetEl.style.height = `${px.h}px`;
    this.sheetEl.style.aspectRatio = `${mm.w} / ${mm.h}`;
    this.sheetEl.dataset.size = this.size;
    this.sheetEl.dataset.orientation = this.orientation;
    this.sheetEl.dataset.widthMm = String(mm.w);
    this.sheetEl.dataset.heightMm = String(mm.h);
    // Scale sheet to fit stage after layout stabilizes.
    requestAnimationFrame(() => this.fitToStage());
  }

  private fitToStage(): void {
    const stage = this.sheetEl.parentElement as HTMLElement | null;
    if (!stage) return;
    const PAD = 32;
    const sw = stage.clientWidth  - PAD * 2;
    const sh = stage.clientHeight - PAD * 2;
    if (sw <= 0 || sh <= 0) return;
    const pxW = parseFloat(this.sheetEl.style.width)  || 1;
    const pxH = parseFloat(this.sheetEl.style.height) || 1;
    this.zoomFactor = Math.min(1, sw / pxW, sh / pxH);
    this.sheetEl.style.zoom = String(this.zoomFactor);
    // Expose inverse zoom so CSS can scale header content back to screen size.
    this.sheetEl.style.setProperty("--iz", String(1 / this.zoomFactor));
  }

  // --- Drag-to-create ----

  private onSheetMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    if (this.activeTool === "pan") {
      const stage = this.sheetEl.parentElement as HTMLElement | null;
      if (stage) {
        this.sheetEl.style.cursor = "grabbing";
        this._panDrag = { sx: e.clientX, sy: e.clientY, scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop };
        e.preventDefault();
      }
      return;
    }
    if (this.activeTool === "detail") {
      this.startDetailDrag(e);
      return;
    }
    if (this.activeTool !== "viewport") return;
    // Ignore clicks that originate in panels / titleblock — those have their
    // own click handlers (selection / contenteditable).
    const tgt = e.target as HTMLElement | null;
    if (tgt && tgt.closest(".paper-cell, .paper-titleblock, .paper-toolbar")) return;
    const rect = this.sheetEl.getBoundingClientRect();
    const x = (e.clientX - rect.left) / this.zoomFactor;
    const y = (e.clientY - rect.top)  / this.zoomFactor;
    const ghost = document.createElement("div");
    ghost.className = "paper-cell-ghost";
    ghost.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0;border:1.5px dashed var(--ink,#1a1a22);pointer-events:none;z-index:100;`;
    this.sheetEl.appendChild(ghost);
    this.dragging = { startX: x, startY: y, el: ghost };
  }

  private startDetailDrag(e: MouseEvent): void {
    const tgt = e.target as HTMLElement | null;
    const panelEl = tgt?.closest<HTMLElement>(".paper-cell");
    const panelId = panelEl?.dataset.panelId ?? null;
    const parent = panelId ? (this.panels.find((p) => p.id === panelId) ?? null) : null;

    const rect = panelEl
      ? panelEl.getBoundingClientRect()
      : this.sheetEl.getBoundingClientRect();

    const x = (e.clientX - rect.left) / this.zoomFactor;
    const y = (e.clientY - rect.top)  / this.zoomFactor;

    const ghost = document.createElement("div");
    ghost.className = "paper-cell-ghost";
    ghost.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0;border:1.5px dashed var(--accent,#3d85c8);pointer-events:none;z-index:100;`;
    (panelEl ?? this.sheetEl).appendChild(ghost);

    this._detailDrag = {
      mode: panelId ? "panel" : "sheet",
      parentId: panelId,
      parentEl: panelEl ?? null,
      parent,
      startX: x,
      startY: y,
      ghost,
    };
  }

  private onSheetMouseMove(e: MouseEvent): void {
    if (this._panDrag) {
      const stage = this.sheetEl.parentElement as HTMLElement | null;
      if (stage) {
        stage.scrollLeft = this._panDrag.scrollLeft - (e.clientX - this._panDrag.sx);
        stage.scrollTop  = this._panDrag.scrollTop  - (e.clientY - this._panDrag.sy);
      }
      return;
    }
    if (this._detailDrag) {
      this.updateDetailDrag(e);
      return;
    }
    if (!this.dragging) return;
    const rect = this.sheetEl.getBoundingClientRect();
    const x = (e.clientX - rect.left) / this.zoomFactor;
    const y = (e.clientY - rect.top) / this.zoomFactor;
    const dx = x - this.dragging.startX;
    const dy = y - this.dragging.startY;
    const ghost = this.dragging.el!;
    const left = Math.min(this.dragging.startX, x);
    const top  = Math.min(this.dragging.startY, y);
    ghost.style.left = `${left}px`;
    ghost.style.top  = `${top}px`;
    ghost.style.width  = `${Math.abs(dx)}px`;
    ghost.style.height = `${Math.abs(dy)}px`;
  }

  private updateDetailDrag(e: MouseEvent): void {
    if (!this._detailDrag) return;
    const { mode, parentEl, parent, startX, startY, ghost } = this._detailDrag;

    if (mode === "panel") {
      const rect = parentEl!.getBoundingClientRect();
      const rawX = Math.max(0, Math.min((e.clientX - rect.left) / this.zoomFactor, parent!.w));
      const rawY = Math.max(0, Math.min((e.clientY - rect.top)  / this.zoomFactor, parent!.h));
      ghost.style.left   = `${Math.min(startX, rawX)}px`;
      ghost.style.top    = `${Math.min(startY, rawY)}px`;
      ghost.style.width  = `${Math.abs(rawX - startX)}px`;
      ghost.style.height = `${Math.abs(rawY - startY)}px`;
    } else {
      const rect = this.sheetEl.getBoundingClientRect();
      const x = (e.clientX - rect.left) / this.zoomFactor;
      const y = (e.clientY - rect.top)  / this.zoomFactor;
      ghost.style.left   = `${Math.min(startX, x)}px`;
      ghost.style.top    = `${Math.min(startY, y)}px`;
      ghost.style.width  = `${Math.abs(x - startX)}px`;
      ghost.style.height = `${Math.abs(y - startY)}px`;
    }
  }

  private onSheetMouseUp(): void {
    if (this._panDrag) {
      this._panDrag = null;
      this.sheetEl.style.cursor = "grab";
      return;
    }
    if (this._detailDrag) {
      this.finishDetailDrag();
      return;
    }
    if (!this.dragging) return;
    const ghost = this.dragging.el!;
    const w = parseFloat(ghost.style.width)  || 0;
    const h = parseFloat(ghost.style.height) || 0;
    const x = parseFloat(ghost.style.left)   || 0;
    const y = parseFloat(ghost.style.top)    || 0;
    ghost.remove();
    this.dragging = null;
    if (w < 30 || h < 30) return; // tiny drags — let click handler add default-size panel
    this._dragCompleted = true; // suppress click-to-add for this pointer sequence
    this.addPanel({ x, y, w, h, viewport: "top", scale: "1:100" });
    this.activeTool = null;
    this.sheetEl.style.cursor = "";
    window.dispatchEvent(new CustomEvent("layout:tool-deactivated", { detail: { tool: "viewport" } }));
  }

  private applyZoom(factor: number): void {
    this.zoomFactor = Math.max(0.05, Math.min(5, this.zoomFactor * factor));
    this.sheetEl.style.zoom = String(this.zoomFactor);
    this.sheetEl.style.setProperty("--iz", String(1 / this.zoomFactor));
  }

  private onSheetClick(e: MouseEvent): void {
    if (this._dragCompleted) { this._dragCompleted = false; return; }
    if (this.activeTool === "zoom") {
      this.applyZoom(e.shiftKey ? 1 / 1.3 : 1.3);
      this.sheetEl.style.cursor = e.shiftKey ? "zoom-out" : "zoom-in";
      return;
    }
    if (this.activeTool?.startsWith("block:")) {
      const tgt = e.target as HTMLElement | null;
      if (tgt && tgt.closest(".paper-cell, .paper-titleblock, .paper-toolbar")) return;
      const rect = this.sheetEl.getBoundingClientRect();
      const cx = (e.clientX - rect.left) / this.zoomFactor;
      const cy = (e.clientY - rect.top)  / this.zoomFactor;
      this.placeBlock(this.activeTool.slice("block:".length), cx, cy);
      return;
    }
    if (this.activeTool !== "viewport") return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && tgt.closest(".paper-cell, .paper-titleblock, .paper-toolbar")) return;
    const rect = this.sheetEl.getBoundingClientRect();
    const cx = (e.clientX - rect.left) / this.zoomFactor;
    const cy = (e.clientY - rect.top)  / this.zoomFactor;
    // Default size: 200mm × 150mm, centred on click, clamped to sheet.
    const w = Math.round(200 * MM_TO_PX);
    const h = Math.round(150 * MM_TO_PX);
    this.addPanel({ x: Math.max(0, cx - w / 2), y: Math.max(0, cy - h / 2), w, h, viewport: "top", scale: "1:100" });
    this.activeTool = null;
    this.sheetEl.style.cursor = "";
    window.dispatchEvent(new CustomEvent("layout:tool-deactivated", { detail: { tool: "viewport" } }));
  }

  private finishDetailDrag(): void {
    if (!this._detailDrag) return;
    const { mode, parentId, parent, ghost } = this._detailDrag;
    const rX = parseFloat(ghost.style.left)   || 0;
    const rY = parseFloat(ghost.style.top)    || 0;
    const rW = parseFloat(ghost.style.width)  || 0;
    const rH = parseFloat(ghost.style.height) || 0;
    ghost.remove();
    this._detailDrag = null;

    if (rW < 20 || rH < 20) { this.deactivateTool(); return; }

    const labelIdx = this._detailLabelSeq++;
    const label = String.fromCharCode(65 + (labelIdx % 26));

    if (mode === "panel") {
      // Region drawn inside a parent panel → place detail panel adjacent to parent.
      const detailW = Math.max(rW * 2, 150);
      const detailH = Math.max(rH * 2, 100);
      this.addPanel({
        x: parent!.x + parent!.w + 20,
        y: parent!.y,
        w: detailW,
        h: detailH,
        viewport: parent!.viewport,
        scale: parent!.scale,
        title: `DETAIL ${label}`,
        border: "thick",
        detailOf: { parentPanelId: parentId!, regionX: rX, regionY: rY, regionW: rW, regionH: rH, label },
      });
    } else {
      // Rect drawn on blank sheet → the rect IS the detail panel.
      // Auto-link to the first non-detail panel if one exists.
      const firstParent = this.panels.find((p) => !p.detailOf);
      if (firstParent) {
        this.addPanel({
          x: rX, y: rY, w: rW, h: rH,
          viewport: firstParent.viewport,
          scale: firstParent.scale,
          title: `DETAIL ${label}`,
          border: "thick",
          detailOf: {
            parentPanelId: firstParent.id,
            regionX: 0, regionY: 0,
            regionW: firstParent.w, regionH: firstParent.h,
            label,
          },
        });
      } else {
        this.addPanel({ x: rX, y: rY, w: rW, h: rH, viewport: "top", scale: "1:100", title: `DETAIL ${label}`, border: "thick" });
      }
    }
    this.deactivateTool();
  }

  private deactivateTool(): void {
    this.activeTool = null;
    this.sheetEl.style.cursor = "";
    window.dispatchEvent(new CustomEvent("layout:tool-deactivated", { detail: { tool: "detail" } }));
  }

  private _thumbLastRender = 0;
  private _startThumbLoop(): void {
    if (this._thumbRAF) return;
    const THUMB_INTERVAL_MS = 100; // ~10 fps — complex IFC scenes are expensive to double-render
    const tick = (now: DOMHighResTimeStamp) => {
      if (this._thumbCanvases.size === 0) { this._thumbRAF = 0; return; }
      this._thumbRAF = requestAnimationFrame(tick);
      if (now - this._thumbLastRender < THUMB_INTERVAL_MS) return;
      this._thumbLastRender = now;
      const viewer = (window as unknown as { __viewer?: Viewer }).__viewer;
      if (viewer) {
        for (const { canvas, viewName, anchorX, anchorY, snapW, snapH, displayMode } of this._thumbCanvases.values()) {
          viewer.renderThumbnailTo(viewName, canvas, anchorX, anchorY, snapW, snapH, displayMode);
        }
      }
    };
    this._thumbRAF = requestAnimationFrame(tick);
  }

  private placeBlock(blockId: string, cx: number, cy: number): void {
    const def = BLOCK_DEFS[blockId];
    if (!def) return;
    const el = document.createElement("div");
    el.className = "paper-block";
    el.dataset.blockId = blockId;
    el.style.cssText = `position:absolute;left:${Math.round(cx - def.w / 2)}px;top:${Math.round(cy - def.h / 2)}px;width:${def.w}px;height:${def.h}px;pointer-events:none;color:var(--fg,#111);`;
    el.innerHTML = def.svg;
    this.sheetEl.appendChild(el);
  }

  pauseThumbLoop(): void {
    if (this._thumbRAF) {
      cancelAnimationFrame(this._thumbRAF);
      this._thumbRAF = 0;
    }
  }

  resumeThumbLoop(): void {
    if (this._thumbCanvases.size > 0) this._startThumbLoop();
  }

  // --- Panel CRUD ----

  private _enterNavigate(p: PanelState, canvas: HTMLCanvasElement): void {
    this._exitNavigate();
    const viewer = (window as unknown as { __viewer?: Viewer }).__viewer;
    if (!viewer) return;
    const viewName = layoutViewportToViewName(p.viewport);
    const controls = viewer.createNavControls(viewName, canvas);
    this._navPanelId = p.id;
    this._navDispose = () => controls.dispose();
    // Mark panel visually.
    const el = this.sheetEl.querySelector<HTMLElement>(`[data-panel-id="${p.id}"]`);
    el?.classList.add("is-navigating");
    // Exit when the user clicks outside the canvas.
    const onDocClick = (e: MouseEvent) => {
      if (!canvas.contains(e.target as Node)) {
        this._exitNavigate();
      }
    };
    this._navDocListener = onDocClick;
    // Use capture so we see the click before other handlers consume it.
    document.addEventListener("mousedown", onDocClick, true);
  }

  private _exitNavigate(): void {
    if (this._navDispose) { this._navDispose(); this._navDispose = null; }
    if (this._navDocListener) {
      document.removeEventListener("mousedown", this._navDocListener, true);
      this._navDocListener = null;
    }
    if (this._navPanelId) {
      const el = this.sheetEl.querySelector<HTMLElement>(`[data-panel-id="${this._navPanelId}"]`);
      el?.classList.remove("is-navigating");
      this._navPanelId = null;
    }
  }

  addPanel(init: PanelInit): PanelState {
    const isDetail = !!init.detailOf;
    const p: PanelState = {
      id:          newPanelId(),
      x:           init.x,
      y:           init.y,
      w:           init.w,
      h:           init.h,
      viewport:    init.viewport,
      scale:       init.scale ?? "1:100",
      title:       init.title ?? (isDetail ? `DETAIL ${init.detailOf!.label}` : VIEWPORT_LABELS[init.viewport]),
      border:      init.border ?? (isDetail ? "thick" : "thin"),
      displayMode: init.displayMode ?? "technical",
      ...(isDetail ? { detailOf: init.detailOf } : {}),
    };
    this.panels.push(p);
    this.renderPanel(p);
    this.renderDetailOverlays();
    return p;
  }

  removePanel(id: string): void {
    const idx = this.panels.findIndex((p) => p.id === id);
    if (idx < 0) return;
    this.panels.splice(idx, 1);
    this._thumbCanvases.delete(id);
    const el = this.sheetEl.querySelector<HTMLElement>(`[data-panel-id="${id}"]`);
    if (el) el.remove();
    if (this.selectedPanelId === id) this.selectedPanelId = null;
    // Remove detail panels whose parent was just deleted.
    const deps = this.panels.filter((p) => p.detailOf?.parentPanelId === id).map((p) => p.id);
    for (const depId of deps) this.removePanel(depId);
    this.renderDetailOverlays();
  }

  private renderDetailOverlays(): void {
    this.sheetEl.querySelectorAll(".paper-cell-detail-region").forEach((el) => el.remove());
    for (const p of this.panels) {
      if (!p.detailOf) continue;
      const d = p.detailOf;
      const parentEl = this.sheetEl.querySelector<HTMLElement>(`[data-panel-id="${d.parentPanelId}"]`);
      if (!parentEl) continue;
      const overlay = document.createElement("div");
      overlay.className = "paper-cell-detail-region";
      overlay.style.left   = `${d.regionX}px`;
      overlay.style.top    = `${d.regionY}px`;
      overlay.style.width  = `${d.regionW}px`;
      overlay.style.height = `${d.regionH}px`;
      const bubble = document.createElement("span");
      bubble.className = "paper-cell-detail-label";
      bubble.textContent = d.label;
      overlay.appendChild(bubble);
      parentEl.appendChild(overlay);
    }
  }

  private renderPanel(p: PanelState): void {
    let el = this.sheetEl.querySelector<HTMLElement>(`[data-panel-id="${p.id}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "paper-cell";
      el.dataset.panelId = p.id;
      this.sheetEl.appendChild(el);
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectPanel(p.id);
      });
      let _hdrTimer: ReturnType<typeof setTimeout> | null = null;
      el.addEventListener("mouseenter", () => {
        if (_hdrTimer) { clearTimeout(_hdrTimer); _hdrTimer = null; }
        el!.querySelector<HTMLElement>(".paper-cell-header")?.classList.add("hdr-visible");
      });
      el.addEventListener("mouseleave", () => {
        if (_hdrTimer) clearTimeout(_hdrTimer);
        _hdrTimer = setTimeout(() => {
          el!.querySelector<HTMLElement>(".paper-cell-header")?.classList.remove("hdr-visible");
          _hdrTimer = null;
        }, 3500);
      });
    }
    if (p.detailOf) el.classList.add("detail-panel"); else el.classList.remove("detail-panel");
    el.style.position = "absolute";
    el.style.left = `${p.x}px`;
    el.style.top  = `${p.y}px`;
    el.style.width  = `${p.w}px`;
    el.style.height = `${p.h}px`;
    if (p.border === "none")  el.style.border = "none";
    if (p.border === "thick") el.style.borderWidth = "2px";

    el.innerHTML = "";

    // Header overlay — shows on hover, collapses on click away.
    const header = document.createElement("div");
    header.className = "paper-cell-header";
    header.addEventListener("mousedown", (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt.tagName === "SELECT" || tgt.tagName === "BUTTON") return;
      e.stopPropagation();
      e.preventDefault();
      this.selectPanel(p.id);
      const startMX = e.clientX, startMY = e.clientY;
      const startPX = p.x, startPY = p.y;
      document.body.style.cursor = "grabbing";
      const onMove = (ev: MouseEvent) => {
        p.x = startPX + (ev.clientX - startMX) / this.zoomFactor;
        p.y = startPY + (ev.clientY - startMY) / this.zoomFactor;
        el.style.left = `${p.x}px`;
        el.style.top  = `${p.y}px`;
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    const label = document.createElement("span");
    label.className = "paper-cell-label";
    label.textContent = p.title;
    header.appendChild(label);

    const vSel = document.createElement("select");
    vSel.className = "paper-cell-select";
    vSel.setAttribute("aria-label", "Viewport");
    for (const v of Object.keys(VIEWPORT_LABELS) as ViewportId[]) {
      const opt = document.createElement("option");
      opt.value = v; opt.textContent = VIEWPORT_LABELS[v];
      if (v === p.viewport) opt.selected = true;
      vSel.appendChild(opt);
    }
    vSel.addEventListener("change", () => {
      p.viewport = vSel.value as ViewportId;
      p.title = VIEWPORT_LABELS[p.viewport];
      this.renderPanel(p);
    });

    const sSel = document.createElement("select");
    sSel.className = "paper-cell-select";
    sSel.setAttribute("aria-label", "Scale");
    const presets = activeScalePresets();
    const isCustomScale = !presets.includes(p.scale);
    for (const s of presets) {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      if (s === p.scale || (s === "Custom" && isCustomScale)) opt.selected = true;
      sSel.appendChild(opt);
    }

    const sCustomInput = document.createElement("input");
    sCustomInput.type = "text";
    sCustomInput.className = "paper-cell-scale-input";
    sCustomInput.setAttribute("aria-label", "Custom scale");
    sCustomInput.placeholder = "1:150";
    sCustomInput.value = isCustomScale ? p.scale : "";
    sCustomInput.style.display = isCustomScale ? "" : "none";

    const applyCustomScale = () => {
      const raw = sCustomInput.value.trim();
      if (/^1:\d+(\.\d+)?$/.test(raw)) {
        p.scale = raw;
        this.renderPanel(p);
      } else {
        sCustomInput.value = p.scale;
      }
    };
    sCustomInput.addEventListener("blur", applyCustomScale);
    sCustomInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); applyCustomScale(); }
    });

    sSel.addEventListener("change", () => {
      if (sSel.value === "Custom") {
        sCustomInput.style.display = "";
        sCustomInput.focus();
        sCustomInput.select();
      } else {
        sCustomInput.style.display = "none";
        p.scale = sSel.value;
        this.renderPanel(p);
      }
    });

    const dmSel = document.createElement("select");
    dmSel.className = "paper-cell-select";
    dmSel.setAttribute("aria-label", "Display mode");
    for (const dm of DISPLAY_MODES) {
      const opt = document.createElement("option");
      opt.value = dm;
      opt.textContent = dm.charAt(0).toUpperCase() + dm.slice(1);
      if (dm === p.displayMode) opt.selected = true;
      dmSel.appendChild(opt);
    }
    dmSel.addEventListener("change", () => {
      p.displayMode = dmSel.value as DisplayMode;
      const entry = this._thumbCanvases.get(p.id);
      if (entry) entry.displayMode = p.displayMode;
    });

    header.appendChild(vSel);
    header.appendChild(sSel);
    header.appendChild(sCustomInput);
    header.appendChild(dmSel);
    el.appendChild(header);

    // Render the viewport content — live WebGL thumbnail for all panels.
    const renderWrap = document.createElement("div");
    renderWrap.className = "paper-cell-render";
    renderWrap.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      this._enterNavigate(p, thumbCanvas);
    });
    const viewName = layoutViewportToViewName(p.viewport);
    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = Math.max(1, Math.round(p.w));
    thumbCanvas.height = Math.max(1, Math.round(p.h));
    thumbCanvas.style.cssText = "width:100%;height:100%;display:block;";
    renderWrap.appendChild(thumbCanvas);
    this._thumbCanvases.set(p.id, { canvas: thumbCanvas, viewName, anchorX: 0, anchorY: 0, snapW: 0, snapH: 0, displayMode: p.displayMode });
    this._startThumbLoop();
    el.appendChild(renderWrap);

    // Scale bar overlay.
    const sb = document.createElement("div");
    sb.className = "paper-cell-scalebar";
    sb.innerHTML = renderScaleBar(p);
    el.appendChild(sb);

    // Close button.
    const close = document.createElement("button");
    close.type = "button";
    close.className = "paper-cell-close";
    close.innerHTML = iconSVG("x", 12);
    close.title = "Remove panel";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.removePanel(p.id);
    });
    el.appendChild(close);

    // Resize handles — 8 directions.
    for (const dir of ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const) {
      const handle = document.createElement("div");
      handle.className = "panel-resize-handle";
      handle.dataset.dir = dir;
      handle.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.selectPanel(p.id);
        const startMX = e.clientX, startMY = e.clientY;
        const ox = p.x, oy = p.y, ow = p.w, oh = p.h;
        // Snapshot the canvas dimensions at drag start — used by renderThumbnailTo
        // to compute the window crop during the drag.
        const entry0 = this._thumbCanvases.get(p.id);
        if (entry0) {
          entry0.snapW = entry0.canvas.width;
          entry0.snapH = entry0.canvas.height;
          entry0.anchorX = dir.includes("w") ? 1 : 0;
          entry0.anchorY = dir.includes("n") ? 1 : 0;
        }
        const onMove = (ev: MouseEvent) => {
          const dx = (ev.clientX - startMX) / this.zoomFactor;
          const dy = (ev.clientY - startMY) / this.zoomFactor;
          if (dir.includes("e")) p.w = Math.max(80, ow + dx);
          if (dir.includes("s")) p.h = Math.max(60, oh + dy);
          if (dir.includes("w")) { p.x = ox + dx; p.w = Math.max(80, ow - dx); }
          if (dir.includes("n")) { p.y = oy + dy; p.h = Math.max(60, oh - dy); }
          el.style.left   = `${p.x}px`;
          el.style.top    = `${p.y}px`;
          el.style.width  = `${p.w}px`;
          el.style.height = `${p.h}px`;
          // Keep canvas pixel dimensions in sync so the rAF loop renders at
          // the live size rather than CSS-stretching the old resolution.
          const entry = this._thumbCanvases.get(p.id);
          if (entry) {
            const nw = Math.max(1, Math.round(p.w));
            const nh = Math.max(1, Math.round(p.h));
            if (entry.canvas.width !== nw) entry.canvas.width = nw;
            if (entry.canvas.height !== nh) entry.canvas.height = nh;
          }
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          // Clear the drag snapshot — rendering reverts to plain aspect adaptation.
          const entry = this._thumbCanvases.get(p.id);
          if (entry) { entry.snapW = 0; entry.snapH = 0; }
          this.renderPanel(p);
          this.selectPanel(p.id);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
      el.appendChild(handle);
    }
  }

  private selectPanel(id: string): void {
    this.selectedPanelId = id;
    this.sheetEl.querySelectorAll<HTMLElement>(".paper-cell").forEach((c) => {
      c.classList.toggle("selected", c.dataset.panelId === id);
    });
  }

  // --- Title block ---

  private renderTitleBlock(): void {
    const t = this.titleblockEl;
    t.innerHTML = "";
    const cells: Array<[string, keyof TitleBlock, boolean]> = [
      ["PROJECT", "project", true],
      ["Sheet",   "sheet",   false],
      ["Scale",   "scale",   false],
      ["Drawn",   "drawnBy", false],
      ["Date",    "date",    false],
    ];
    for (const [label, key, brand] of cells) {
      const cell = document.createElement("div");
      cell.className = `tb-cell${brand ? " brand" : ""}`;
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = label;
      cell.appendChild(k);
      const v = document.createElement("span");
      v.className = "v";
      v.contentEditable = "true";
      v.spellcheck = false;
      v.textContent = this.title[key];
      v.dataset.titleKey = key;
      v.addEventListener("input", () => {
        this.title[key] = v.textContent ?? "";
      });
      cell.appendChild(v);
      t.appendChild(cell);
    }
  }
}

const _controllers = new WeakMap<HTMLElement, LayoutController>();

/** Maps sheetData.id → ClippingPlaneEntity.id for auto-linked sheets (#1849). */
const _sheetClipLinks = new Map<string, string>();


/** Return the clipping-plane entity ID linked to a sheet, if any. */
export function getClipPlaneIdForSheet(sheetId: string): string | undefined {
  return _sheetClipLinks.get(sheetId);
}

/**
 * Return the levelId linked to a plan sheet (#1846), or undefined if not a plan sheet.
 * @param host    The paper-mode host element.
 * @param sheetId The sheet's id.
 */
export function getLinkedLevelIdForSheet(host: HTMLElement, sheetId: string): string | undefined {
  return _controllers.get(host)?.getLinkedLevelId(sheetId);
}

/**
 * Mark a plan sheet as user-renamed — disables auto-rename on future level renames (#1846).
 * @param host    The paper-mode host element.
 * @param sheetId The sheet's id.
 */
export function markPlanSheetUserRenamed(host: HTMLElement, sheetId: string): void {
  _controllers.get(host)?.markUserRenamed(sheetId);
}

/**
 * Return the levelId linked to an RCP sheet (#1844), or undefined if not an RCP sheet.
 * @param host    The paper-mode host element.
 * @param sheetId The sheet's id.
 */
export function getRcpLinkedLevelIdForSheet(host: HTMLElement, sheetId: string): string | undefined {
  return _controllers.get(host)?.getRcpLinkedLevelId(sheetId);
}

/**
 * Mark an RCP sheet as user-renamed — disables auto-rename on future level renames (#1844).
 * @param host    The paper-mode host element.
 * @param sheetId The sheet's id.
 */
export function markRcpSheetUserRenamed(host: HTMLElement, sheetId: string): void {
  _controllers.get(host)?.markRcpUserRenamed(sheetId);
}

/**
 * Auto-create a linked section sheet in the Layout tab for a new clipping plane (#1849).
 * Called by the SdClippingPlane handler when autoSheet is true.
 * @param host      The paper-mode host element (from getLayoutHost()).
 * @param clipPlaneId  The ClippingPlaneEntity id from clippingPlaneStore.
 * @param name      Sheet tab label (e.g. "Section — Clip A").
 * @returns The new sheetData.id, or "" if no LayoutController is mounted.
 */
export function addLinkedClipPlaneSheet(host: HTMLElement, clipPlaneId: string, name: string): string {
  const c = _controllers.get(host);
  if (!c) return "";
  // Pass clipPlaneId so the link is stored BEFORE switchSheet fires (Unlink button visibility).
  return c.addLinkedSheet(name, clipPlaneId);
}

/**
 * Detach a linked sheet from its clipping-plane entity (#1849 §5.4).
 * Copies the entity's current bounds into static SheetTemplate fields and removes the link.
 * The ClippingPlaneEntity remains in the scene and store.
 * @returns The frozen config (origin/normal/farClip) or null if the sheet wasn't linked.
 */
export function unlinkClipPlaneSheet(
  host: HTMLElement,
  sheetId: string,
): { origin: [number, number, number]; normal: [number, number, number]; farClip: number } | null {
  const clipPlaneId = _sheetClipLinks.get(sheetId);
  if (!clipPlaneId) return null;
  const entity = clippingPlaneStore.get(clipPlaneId);
  _sheetClipLinks.delete(sheetId);
  if (!entity) return null;
  const frozen = { origin: entity.origin, normal: entity.normal, farClip: entity.bounds.farClip };
  // Update controller's unlink button if this is the active sheet.
  const c = _controllers.get(host);
  if (c && c.activeSheet.id === sheetId && c["_unlinkBtn"]) {
    (c["_unlinkBtn"] as HTMLElement).style.display = "none";
  }
  document.dispatchEvent(new CustomEvent("layout:sheet-unlinked", { detail: { sheetId, ...frozen } }));
  return frozen;
}

// --- Public exports ---

export function buildLayoutMode(host: HTMLElement, opts: LayoutOptions = {}): LayoutController {
  const c = new LayoutController(host, opts);
  _controllers.set(host, c);
  return c;
}

export function addPanel(host: HTMLElement, init: PanelInit): PanelState {
  const c = _controllers.get(host);
  if (!c) throw new Error("layout: host has no LayoutController; call buildLayoutMode first");
  return c.addPanel(init);
}

export function getPanels(host: HTMLElement): PanelState[] {
  const c = _controllers.get(host);
  return c ? c.panels.slice() : [];
}

export function getController(host: HTMLElement): LayoutController | undefined {
  return _controllers.get(host);
}

// --- Export wrappers (implementations live in layout-export.ts) ------------

export function exportLayoutAsSvg(host: HTMLElement): string {
  const c = _controllers.get(host);
  if (!c) throw new Error("layout: host has no LayoutController");
  return composeSvg(c);
}

export async function exportLayoutAsPdf(host: HTMLElement): Promise<ArrayBuffer> {
  const c = _controllers.get(host);
  if (!c) throw new Error("layout: host has no LayoutController");
  return exportLayoutAsPdfImpl(c);
}

export function exportLayoutAsAi(host: HTMLElement): string {
  const c = _controllers.get(host);
  if (!c) throw new Error("layout: host has no LayoutController");
  return exportLayoutAsAiImpl(c);
}

export function exportLayoutAsDwgFallback(host: HTMLElement): string {
  const c = _controllers.get(host);
  if (!c) throw new Error("layout: host has no LayoutController");
  return exportLayoutAsDwgFallbackImpl(c);
}

export function exportLayoutAsDxf(host: HTMLElement): string {
  const c = _controllers.get(host);
  if (!c) throw new Error("layout: host has no LayoutController");
  return exportLayoutAsDxfImpl(c);
}
