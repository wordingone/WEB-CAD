// Shell chrome — design-handoff #171, T1 .zip parity restoration.
//
// Builds the menubar (9 menus) / modebar (4 modes) / ribbon (6 tabs + tools) /
// statusbar wiring on top of the existing prompt-pane + viewer-pane layout.
//
// Source-of-truth: B:/Downloads/gemma-architect-handoff/gemma-architect/project/app.jsx
// MENU_DATA action semantics + TOOL_GROUPS shape + BLUEPRINT pill location +
// modebar icons all match that bundle. Differences from app.jsx are inlined
// as TS port adaptations (no React state, app-state.ts pub/sub instead).
//
// DOM target classes match the bundle's project/styles.css:
// .app, .menubar, .modebar, .ribbon, .ribbon-tabs, .ribbon-tools, .statusbar,
// .menu-item / .menu-dropdown / .menu-row / .menu-row-kbd / .menu-sep, etc.

import { iconSVG } from "./icons";
import { openExportDrawer } from "./export-drawer";
import { openCmdK } from "./cmdk";
import { getCreateSequence } from "./create-mode";
import {
  getState,
  setState,
  subscribe,
  syncToolActiveClass,
  syncThemeAttribute,
  hydrateFromStorage,
  type LayoutMode,
} from "./app-state";

type MenuAction = () => void;
type MenuRow =
  | { label: string; kbd?: string; action?: MenuAction }
  | "---";
type MenuItem = {
  label: string;
  // dynamicLabel lets the View > theme entry render "Daylight · vellum" or
  // "Blueprint · night" depending on current state.
  dynamicLabel?: () => string;
  items: MenuRow[];
};

type Tool = { id: string; icon: string; label: string };
type ToolGroup = { label: string; tools: Tool[] };

// Shape mirrors app.jsx TOOL_GROUPS line 25–49 (id + icon per tool).
const TOOL_GROUPS: ToolGroup[] = [
  { label: "TRANSFORM", tools: [
    { id: "select", icon: "select", label: "Select" },
    { id: "move",   icon: "move",   label: "Move" },
    { id: "rotate", icon: "rotate", label: "Rotate" },
    { id: "scale",  icon: "scale",  label: "Scale" },
  ]},
  { label: "SKETCH 2D", tools: [
    { id: "line",     icon: "line",     label: "Line" },
    { id: "rect",     icon: "rect",     label: "Rectangle" },
    { id: "circle",   icon: "circle",   label: "Circle" },
    { id: "polygon",  icon: "polygon",  label: "Polygon" },
    { id: "polyline", icon: "polyline", label: "Polyline" },
    { id: "arc",      icon: "arc",      label: "Arc" },
    { id: "spline",   icon: "spline",   label: "Spline" },
  ]},
  { label: "SOLID", tools: [
    { id: "extrude", icon: "extrude", label: "Extrude" },
    { id: "revolve", icon: "revolve", label: "Revolve" },
    { id: "fillet",  icon: "fillet",  label: "Fillet" },
    { id: "chamfer", icon: "chamfer", label: "Chamfer" },
    { id: "boolean", icon: "boolean", label: "Boolean" },
  ]},
  { label: "ARCH", tools: [
    { id: "wall",   icon: "wall",   label: "Wall" },
    { id: "slab",   icon: "slab",   label: "Slab" },
    { id: "column", icon: "column", label: "Column" },
    { id: "stair",  icon: "stair",  label: "Stair" },
    { id: "door",   icon: "door",   label: "Door" },
    { id: "window", icon: "window", label: "Window" },
  ]},
  { label: "MEASURE", tools: [
    { id: "ruler",   icon: "ruler",   label: "Measure" },
    { id: "compass", icon: "compass", label: "Compass" },
  ]},
];

// Aggregate label table — lets the statusbar display the friendly name for
// the current activeTool. Keys must match TOOL_GROUPS[].tools[].id above and
// PALETTE_SECTIONS in workbench.ts.
const TOOL_LABEL: Record<string, string> = {
  select:"Select", move:"Move", rotate:"Rotate", scale:"Scale",
  line:"Line", rect:"Rectangle", circle:"Circle", polyline:"Polyline",
  polygon:"Polygon", arc:"Arc", spline:"Spline",
  extrude:"Extrude", revolve:"Revolve", boolean:"Boolean",
  fillet:"Fillet", chamfer:"Chamfer",
  wall:"Wall", slab:"Slab", column:"Column", stair:"Stair", door:"Door", window:"Window",
  ruler:"Measure", compass:"Compass",
};

type ModeDef = { key: "model" | "layout" | "research"; num: string; label: string; icon: string };

// Mirrors app.jsx modebar entries 380–392 (icon per mode).
const MODES: ModeDef[] = [
  { key: "model",    num: "01", label: "MODEL",    icon: "extrude" },
  { key: "layout",   num: "02", label: "LAYOUT",   icon: "rect" },
  { key: "research", num: "03", label: "RESEARCH", icon: "sparkle" },
];

const RIBBON_TABS = ["MODEL", "DRAFT", "ANALYZE", "RENDER", "ANNOTATE", "SUBMIT"] as const;
type RibbonTab = typeof RIBBON_TABS[number];

// Activate a dock tab from a menubar action. The tabs are built by
// workbench.ts and identified by data-tab=<id> on .dock-tab elements.
function activateDockTab(id: string): void {
  const tab = document.querySelector(`.dock-tab[data-tab="${id}"]`) as HTMLElement | null;
  tab?.click();
}

// Activate a top-level mode (model/layout/research). The modebar's per-tab
// click handler also drives this; this exists for menu-driven mode switches.
function activateMode(key: ModeDef["key"]): void {
  setState("viewMode", key);
  const tab = document.querySelector(`.mode-tab[data-mode="${key}"]`) as HTMLElement | null;
  tab?.click();
}

function setLayout(mode: LayoutMode): void {
  setState("layout", mode);
}

// Reset layout — bundle's Window > Reset layout: quad layout + dockH=340.
// Target dockH matches app.jsx line 295 (.zip uses 260 there but the rest of
// app.jsx initialises dockH=340 — the higher value matches the screenshot).
function resetLayout(): void {
  setLayout("quad");
  const app = document.querySelector(".app") as HTMLElement | null;
  app?.style.setProperty("--dock-h", "340px");
}

// Download the current construction sequence as a .gemma.json project file.
// This is the "Save" / "Save As…" fallback until T6 adds File System Access.
function saveProjectJson(): void {
  const seq = getCreateSequence();
  const payload = { version: 1, sequence: seq };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "project.gemma.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// MENU_DATA mirrors app.jsx 216–302. Every action callback is real, no
// console.debug stubs. Where an action depends on app-state (theme toggle,
// active tool, layout, dock tab), it goes through setState/getState/click
// so subscribers across the rest of the app see the change.
const MENU_DATA: MenuItem[] = [
  { label: "File", items: [
    { label: "New project",          kbd: "⌘N",   action: () => { location.reload(); } },
    { label: "Open…",                kbd: "⌘O",   action: () => {
      const btn = document.getElementById("file-pick-btn") as HTMLElement | null;
      btn?.click();
    } },
    { label: "Save",                 kbd: "⌘S",   action: () => saveProjectJson() },
    { label: "Save As…",             kbd: "⇧⌘S", action: () => saveProjectJson() },
    "---",
    { label: "Import IFC / STEP / OBJ…", action: () => {
      const btn = document.getElementById("file-pick-btn") as HTMLElement | null;
      btn?.click();
    } },
    { label: "Export…",              kbd: "⌘E",   action: () => openExportDrawer() },
    "---",
    { label: "Quit",                 kbd: "⌘Q" },
  ]},
  { label: "Edit", items: [
    { label: "Undo",                 kbd: "⌘Z" },
    { label: "Redo",                 kbd: "⇧⌘Z" },
    "---",
    { label: "Cut",                  kbd: "⌘X" },
    { label: "Copy",                 kbd: "⌘C" },
    { label: "Paste",                kbd: "⌘V" },
    { label: "Duplicate",            kbd: "⌘D" },
    "---",
    { label: "Select all",           kbd: "⌘A" },
    { label: "Deselect",             kbd: "esc",  action: () => setState("selectedId", null) },
  ]},
  { label: "View",
    items: [
      { label: "Single viewport",    kbd: "⍐1", action: () => setLayout("single") },
      { label: "Side by side",       kbd: "⍐2", action: () => setLayout("hsplit") },
      { label: "Stacked",            kbd: "⍐3", action: () => setLayout("vsplit") },
      { label: "Quad · T/F/R/P",     kbd: "⍐4", action: () => setLayout("quad") },
      "---",
      { label: "Mode · Model",       action: () => activateMode("model") },
      { label: "Mode · Layout",      action: () => activateMode("layout") },
      { label: "Mode · Research",    action: () => activateMode("research") },
      "---",
      // Theme entry uses dynamicLabel (handled in panel render).
      { label: "Toggle theme",       action: () => setState("night", !getState("night")) },
      { label: "Command palette…",   kbd: "⌘K",  action: () => openCmdK() },
    ],
  },
  { label: "Sketch", items: [
    { label: "Line",                 kbd: "L",   action: () => setState("activeTool", "line") },
    { label: "Rectangle",            kbd: "R",   action: () => setState("activeTool", "rect") },
    { label: "Circle",               kbd: "C",   action: () => setState("activeTool", "circle") },
    { label: "Polyline",                         action: () => setState("activeTool", "polyline") },
    { label: "Polygon",                          action: () => setState("activeTool", "polygon") },
    { label: "Arc",                              action: () => setState("activeTool", "arc") },
    { label: "Spline",                           action: () => setState("activeTool", "spline") },
  ]},
  { label: "Solid", items: [
    { label: "Extrude",              kbd: "E",   action: () => setState("activeTool", "extrude") },
    { label: "Revolve",                          action: () => setState("activeTool", "revolve") },
    "---",
    { label: "Boolean union",                    action: () => setState("activeTool", "boolean") },
    { label: "Boolean cut",                      action: () => setState("activeTool", "boolean") },
    "---",
    { label: "Fillet edges",                     action: () => setState("activeTool", "fillet") },
    { label: "Chamfer edges",                    action: () => setState("activeTool", "chamfer") },
  ]},
  { label: "Arch", items: [
    { label: "Wall",                 kbd: "W",   action: () => setState("activeTool", "wall") },
    { label: "Slab",                 kbd: "S",   action: () => setState("activeTool", "slab") },
    { label: "Column",                           action: () => setState("activeTool", "column") },
    { label: "Stair",                            action: () => setState("activeTool", "stair") },
    { label: "Door",                             action: () => setState("activeTool", "door") },
    { label: "Window",                           action: () => setState("activeTool", "window") },
  ]},
  { label: "Render", items: [
    { label: "Wireframe" },
    { label: "Hidden line" },
    { label: "Shaded" },
    { label: "Rendered" },
    "---",
    { label: "Render settings…" },
  ]},
  { label: "Window", items: [
    { label: "Prompt",               action: () => activateDockTab("prompt") },
    { label: "Console",              action: () => activateDockTab("console") },
    { label: "Node graph",           action: () => activateDockTab("nodes") },
    { label: "Parameters",           action: () => activateDockTab("parameters") },
    { label: "History",              action: () => activateDockTab("history") },
    "---",
    { label: "Reset layout",         action: () => resetLayout() },
  ]},
  { label: "Help", items: [
    { label: "Documentation" },
    { label: "Keyboard shortcuts" },
    { label: "About Gemma·Architect" },
  ]},
];

// Tag the View menu's "Toggle theme" row so its label re-renders when night
// state flips. Index 9 in the View > items list (0-based: Single, Side by,
// Stacked, Quad, "---", Model, Layout, Research, "---", theme).
(MENU_DATA[2].items[9] as { label: string }).label = getState("night")
  ? "Daylight · vellum"
  : "Blueprint · night";
subscribe("night", (n) => {
  (MENU_DATA[2].items[9] as { label: string }).label = n
    ? "Daylight · vellum"
    : "Blueprint · night";
});

function buildBrand(): HTMLElement {
  const brand = document.createElement("div");
  brand.className = "brand";

  const mark = document.createElement("span");
  mark.className = "brand-mark";
  mark.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.4"/>
    <path d="M12 3v18M3 12h18" stroke="currentColor" stroke-width="0.8" stroke-dasharray="2 2" opacity="0.5"/>
    <path d="M16 9.5a5 5 0 1 0 0 5h-3.5" stroke="oklch(0.55 0.15 28)" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  </svg>`;
  brand.appendChild(mark);

  const name = document.createElement("span");
  name.className = "brand-name";
  name.innerHTML = `GEMMA<span class="b-slash">/</span>ARCHITECT`;
  brand.appendChild(name);

  return brand;
}

function buildMenubar(host: HTMLElement) {
  host.innerHTML = "";
  host.appendChild(buildBrand());

  const items = document.createElement("div");
  items.className = "menubar-items";
  host.appendChild(items);

  let openItem: HTMLDivElement | null = null;
  let openDropdown: HTMLDivElement | null = null;

  function closeMenu() {
    if (openDropdown) { openDropdown.remove(); openDropdown = null; }
    if (openItem)     { openItem.classList.remove("open"); openItem = null; }
  }

  function openMenuFor(menu: MenuItem, anchor: HTMLDivElement) {
    closeMenu();
    const panel = document.createElement("div");
    panel.className = "menu-dropdown";
    panel.setAttribute("role", "menu");
    panel.dataset.for = menu.label.toLowerCase();
    panel.addEventListener("mousedown", (e) => e.stopPropagation());

    for (const entry of menu.items) {
      if (entry === "---") {
        const sep = document.createElement("div");
        sep.className = "menu-sep";
        sep.setAttribute("role", "separator");
        panel.appendChild(sep);
        continue;
      }
      const row = document.createElement("div");
      row.className = "menu-row";
      row.setAttribute("role", "menuitem");

      const label = document.createElement("span");
      label.className = "menu-row-label";
      label.textContent = entry.label;
      row.appendChild(label);

      if (entry.kbd) {
        const kbd = document.createElement("span");
        kbd.className = "menu-row-kbd";
        kbd.textContent = entry.kbd;
        row.appendChild(kbd);
      }

      const action = entry.action;
      if (action) {
        row.addEventListener("click", () => {
          action();
          closeMenu();
        });
      } else {
        row.classList.add("disabled");
        row.addEventListener("click", () => closeMenu());
      }
      panel.appendChild(row);
    }

    anchor.appendChild(panel);
    anchor.classList.add("open");
    openItem = anchor;
    openDropdown = panel;
  }

  for (const menu of MENU_DATA) {
    const item = document.createElement("div");
    item.className = "menu-item";
    item.dataset.menu = menu.label.toLowerCase();
    item.setAttribute("role", "menuitem");
    item.tabIndex = 0;
    item.textContent = menu.label;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      if (openItem === item) closeMenu();
      else openMenuFor(menu, item);
    });
    item.addEventListener("mouseenter", () => {
      if (openItem && openItem !== item) openMenuFor(menu, item);
    });
    items.appendChild(item);
  }

  // Spacer pushes right cluster to the far edge.
  const spacer = document.createElement("div");
  spacer.className = "menubar-spacer";
  host.appendChild(spacer);

  // Right cluster — file label + BLUEPRINT/VELLUM pill + session pill.
  // Pill location matches app.jsx:354–374 (was previously rendered into the
  // statusbar; that location got cropped at short viewport heights so we
  // moved it back to the menubar-right per .zip).
  const right = document.createElement("div");
  right.className = "menubar-right";
  right.innerHTML = `
    <span>Untitled.001 · IFC4</span>
    <button id="theme-toggle-pill" class="theme-toggle-pill" type="button"
      title="Toggle day/night (Ctrl+\\)">
      <span class="theme-toggle-pill-label">○ VELLUM</span>
    </button>
    <span class="session-pill"><span class="dot"></span>LOCAL · NO CLOUD</span>
  `;
  host.appendChild(right);

  const pillLabel = right.querySelector(".theme-toggle-pill-label") as HTMLElement;
  const pillBtn = right.querySelector("#theme-toggle-pill") as HTMLButtonElement;
  function paintPill(night: boolean) {
    pillLabel.textContent = night ? "◑ BLUEPRINT" : "○ VELLUM";
    pillBtn.classList.toggle("on", night);
  }
  paintPill(getState("night"));
  subscribe("night", (n) => paintPill(n));
  pillBtn.addEventListener("click", () => setState("night", !getState("night")));

  // Click-outside / Escape closes the dropdown.
  document.addEventListener("click", (e) => {
    if (!openDropdown) return;
    const tgt = e.target as Node | null;
    if (tgt && (openDropdown.contains(tgt) || openItem?.contains(tgt))) return;
    closeMenu();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openDropdown) closeMenu();
  });
}

function buildModebar(host: HTMLElement, onChange?: (k: string) => void): (k: string) => void {
  host.innerHTML = "";
  const tabs: HTMLDivElement[] = [];

  for (const mode of MODES) {
    const tab = document.createElement("div");
    tab.className = "mode-tab";
    tab.dataset.mode = mode.key;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", mode === MODES[0] ? "true" : "false");
    if (mode === MODES[0]) tab.classList.add("active");

    const num = document.createElement("span");
    num.className = "mode-num";
    num.textContent = mode.num;
    tab.appendChild(num);

    // Inject icon per .zip modebar (app.jsx:389: <Icon name={m.icon} size={13}/>)
    const iconWrap = document.createElement("span");
    iconWrap.className = "mode-icon";
    iconWrap.innerHTML = iconSVG(mode.icon, 13);
    iconWrap.setAttribute("aria-hidden", "true");
    tab.appendChild(iconWrap);

    const label = document.createTextNode(" " + mode.label);
    tab.appendChild(label);

    tab.addEventListener("click", () => activate(mode.key));
    tabs.push(tab);
    host.appendChild(tab);
  }

  // Spacer + meta cluster (right-aligned context label).
  const spacer = document.createElement("div");
  spacer.className = "modebar-spacer";
  host.appendChild(spacer);

  const meta = document.createElement("div");
  meta.className = "modebar-meta";
  host.appendChild(meta);

  function paintMeta(viewMode: ModeDef["key"]) {
    if (viewMode === "model") {
      meta.innerHTML = `<span class="k">CONTEXT</span><span class="v">3D · IFC4 · m</span>`;
    } else if (viewMode === "layout") {
      meta.innerHTML = `<span class="k">SHEET</span><span class="v">A1 · LANDSCAPE · 1:50</span>`;
    } else {
      meta.innerHTML = `<span class="k">CORPUS</span><span class="v">14 docs · LOCAL+WEB</span>`;
    }
  }
  paintMeta(getState("viewMode"));
  subscribe("viewMode", (v) => paintMeta(v));

  function activate(key: string) {
    for (const t of tabs) {
      const isActive = t.dataset.mode === key;
      t.classList.toggle("active", isActive);
      t.setAttribute("aria-selected", isActive ? "true" : "false");
    }
    setState("viewMode", key as ModeDef["key"]);
    const sbModeV = document.querySelector("#sb-mode .v") as HTMLElement | null;
    if (sbModeV) {
      const def = MODES.find((m) => m.key === key);
      sbModeV.textContent = (def?.label ?? key).toUpperCase();
    }
    if (onChange) onChange(key);
  }
  return activate;
}

function buildRibbon(ribbonHost: HTMLElement, onChange?: (t: RibbonTab) => void): (t: RibbonTab) => void {
  ribbonHost.innerHTML = "";

  // .ribbon-tabs — top strip with 6 tab labels.
  const tabsEl = document.createElement("div");
  tabsEl.className = "ribbon-tabs";
  tabsEl.setAttribute("role", "tablist");
  ribbonHost.appendChild(tabsEl);

  const tabs: HTMLDivElement[] = [];
  for (const t of RIBBON_TABS) {
    const tab = document.createElement("div");
    tab.className = "ribbon-tab";
    tab.dataset.tab = t;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", t === RIBBON_TABS[0] ? "true" : "false");
    if (t === RIBBON_TABS[0]) tab.classList.add("active");
    tab.textContent = t;
    tab.addEventListener("click", () => activate(t));
    tabs.push(tab);
    tabsEl.appendChild(tab);
  }

  // .ribbon-tools — middle area with toolgroups. Tools are icon-only buttons
  // per app.jsx:412–419 (was text labels — that was a port regression).
  const toolsEl = document.createElement("div");
  toolsEl.className = "ribbon-tools";
  ribbonHost.appendChild(toolsEl);

  for (const group of TOOL_GROUPS) {
    const groupEl = document.createElement("div");
    groupEl.className = "tool-group";

    for (const tool of group.tools) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tool-btn";
      btn.dataset.tool = tool.id;
      btn.title = tool.label;
      btn.innerHTML = iconSVG(tool.icon, 16);
      btn.addEventListener("click", () => setState("activeTool", tool.id));
      groupEl.appendChild(btn);
    }
    const groupLabel = document.createElement("span");
    groupLabel.className = "tool-group-label";
    groupLabel.textContent = group.label;
    groupEl.appendChild(groupLabel);

    toolsEl.appendChild(groupEl);
  }

  // .ribbon-right — quick actions (palette + export). Both wired now per
  // app.jsx:425–432 (export was previously dead).
  const rightEl = document.createElement("div");
  rightEl.className = "ribbon-right";
  rightEl.innerHTML = `
    <button class="btn btn-ghost" type="button" id="ribbon-palette-btn" title="Open command palette (Ctrl+K)">
      ${iconSVG("command", 11)} ⌘K
    </button>
    <button class="btn" type="button" id="ribbon-export-btn" title="Export (Ctrl+E)">
      ${iconSVG("export", 11)} EXPORT
    </button>
  `;
  ribbonHost.appendChild(rightEl);

  rightEl.querySelector("#ribbon-palette-btn")?.addEventListener("click", () => openCmdK());
  rightEl.querySelector("#ribbon-export-btn")?.addEventListener("click", () => openExportDrawer());

  function activate(t: RibbonTab) {
    for (const el of tabs) {
      const isActive = el.dataset.tab === t;
      el.classList.toggle("active", isActive);
      el.setAttribute("aria-selected", isActive ? "true" : "false");
    }
    if (onChange) onChange(t);
  }
  return activate;
}

function wireThemeToggleHotkey() {
  // Initial state (data-mode attribute) is set by syncThemeAttribute via the
  // app-state subscription. The pill button click handler in buildMenubar
  // drives setState("night", ...) which fires that subscription.
  // Ctrl+\ toggles theme too — preserved from the original shell.
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key !== "\\") return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
    e.preventDefault();
    setState("night", !getState("night"));
  });
}

function wireFpsCounter() {
  const cell = document.getElementById("sb-fps");
  const v = cell?.querySelector(".v") as HTMLElement | null;
  if (!v) return;
  let frames = 0;
  let last = performance.now();
  function tick(now: number) {
    frames++;
    if (now - last >= 1000) {
      const fps = Math.round((frames * 1000) / (now - last));
      v!.textContent = `${fps}`;
      frames = 0;
      last = now;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// Wire statusbar Tool / Sel cells to app-state. They're hardcoded "—" in
// index.html on first paint; this picks up subsequent state changes.
function wireStatusbarCells() {
  const toolV = document.querySelector("#sb-tool .v") as HTMLElement | null;
  const selV = document.querySelector("#sb-sel .v") as HTMLElement | null;
  if (toolV) {
    subscribe("activeTool", (id) => {
      toolV.textContent = TOOL_LABEL[id] ?? id;
    });
  }
  if (selV) {
    subscribe("selectedId", (id) => {
      selV.textContent = id ?? "—";
    });
  }
}

export function initShellChrome(opts?: { onModeChange?: (k: string) => void }) {
  // Hydrate state first so menubar renders with the correct theme label etc.
  hydrateFromStorage();
  // Side-effect subscriptions (theme attribute, tool active class).
  syncToolActiveClass();
  syncThemeAttribute();

  const menubar = document.querySelector(".menubar") as HTMLElement | null;
  const modebar = document.querySelector(".modebar") as HTMLElement | null;
  const ribbon  = document.querySelector(".ribbon")  as HTMLElement | null;
  if (menubar) buildMenubar(menubar);
  if (modebar) buildModebar(modebar, opts?.onModeChange);
  if (ribbon)  buildRibbon(ribbon);
  wireThemeToggleHotkey();
  wireFpsCounter();
  wireStatusbarCells();
}

export { TOOL_LABEL };
