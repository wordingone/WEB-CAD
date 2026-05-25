// workbench-panels.ts — palette (3D mode + layout mode) + snap dock + all mode menus.
// Extracted from workbench.ts (lines 108–1081).

import { iconSVG } from "../ui/icons";
import { dispatchSync } from "../commands/dispatch";
import { OP_TOOL_IDS } from "../viewer/picker-hint";
import { getState } from "../app-state";
import { getSnap, setGridOn, setSnapOn, setOrthoOn, setPolarOn, setVertexSnapOn, setEdgeSnapOn, setMidpointSnapOn, setStep, setAngleStep } from "../viewer/snap-state";
import { setDoorVariant, setWindowVariant } from "../tools/openings";
import { subscribe } from "../viewer/selection-state";

function el(tag: string, cls?: string, attrs?: Record<string, string>): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

type PaletteSection = { tools: { id: string; icon: string; label: string }[] };

const PALETTE_SECTIONS: PaletteSection[] = [
  { tools: [
    { id: "select",  icon: "select",  label: "Select" },
    { id: "move",    icon: "move",    label: "Move" },
    { id: "rotate",  icon: "rotate",  label: "Rotate" },
    { id: "scale",   icon: "scale",   label: "Scale" },
    { id: "copy",    icon: "copy",    label: "Copy" },
    { id: "array",   icon: "array",   label: "Array" },
    { id: "align-left",    icon: "align-left",    label: "Align Left" },
    { id: "align-center-h",icon: "align-center-h",label: "Align Center H" },
    { id: "align-right",   icon: "align-right",   label: "Align Right" },
    { id: "align-top",     icon: "align-top",     label: "Align Top" },
    { id: "align-center-v",icon: "align-center-v",label: "Align Center V" },
    { id: "align-bottom",  icon: "align-bottom",  label: "Align Bottom" },
    { id: "dist-h",        icon: "dist-h",        label: "Distribute H" },
    { id: "dist-v",        icon: "dist-v",        label: "Distribute V" },
  ]},
  { tools: [
    { id: "line",    icon: "line",    label: "Line" },
    { id: "rect",    icon: "rect",    label: "Rectangle" },
    { id: "circle",  icon: "circle",  label: "Circle" },
    { id: "polygon", icon: "polygon", label: "Polygon" },
    { id: "arc",     icon: "arc",     label: "Arc" },
    { id: "polyline",icon: "polyline",label: "Polyline" },
    { id: "curve",   icon: "curve",   label: "Curve" },
    { id: "spline",  icon: "spline",  label: "Spline" },
    { id: "point",   icon: "point",   label: "Point" },
  ]},
  { tools: [
    { id: "extrude", icon: "extrude", label: "Extrude" },
    { id: "loft",    icon: "loft",    label: "Loft" },
    { id: "sweep",   icon: "sweep",   label: "Sweep" },
    { id: "revolve", icon: "revolve", label: "Revolve" },
    { id: "plane",   icon: "plane",   label: "Plane" },
    { id: "surface", icon: "surface", label: "Surface" },
    { id: "boolean",       icon: "boolean",       label: "Boolean" },
    { id: "bool-union",    icon: "bool-union",    label: "Union" },
    { id: "bool-diff",     icon: "bool-diff",     label: "Difference" },
    { id: "bool-intersect",icon: "bool-intersect",label: "Intersect" },
    { id: "fillet",        icon: "fillet",        label: "Fillet" },
  ]},
  { tools: [
    { id: "brep-explode", icon: "brep-explode", label: "Explode" },
    { id: "brep-join",    icon: "brep-join",    label: "Join" },
    { id: "brep-rebuild", icon: "brep-rebuild", label: "Rebuild" },
    { id: "brep-contour", icon: "brep-contour", label: "Contour" },
  ]},
  { tools: [
    { id: "wall",       icon: "wall",       label: "Wall" },
    { id: "slab",       icon: "slab",       label: "Slab" },
    { id: "column",     icon: "column",     label: "Column" },
    { id: "beam",       icon: "beam",       label: "Beam" },
    { id: "roof",       icon: "roof",       label: "Roof" },
    { id: "space",      icon: "space",      label: "Space" },
    { id: "foundation", icon: "foundation", label: "Foundation" },
    { id: "ceiling",    icon: "ceiling",    label: "Ceiling" },
    { id: "grid",       icon: "grid",       label: "Grid" },
    { id: "level",      icon: "level",      label: "Level" },
    { id: "datum",      icon: "datum",      label: "Reference Line" },
  ]},
  { tools: [
    { id: "stair",       icon: "stair",       label: "Stair" },
    { id: "door",        icon: "door",        label: "Door" },
    { id: "window",      icon: "window",      label: "Window" },
    { id: "ramp",        icon: "ramp",        label: "Ramp" },
    { id: "railing",     icon: "railing",     label: "Railing" },
    { id: "curtainwall", icon: "curtainwall", label: "Curtain Wall" },
    { id: "skylight",    icon: "skylight",    label: "Skylight" },
    { id: "opening",     icon: "opening",     label: "Opening" },
  ]},
  { tools: [
    { id: "section", icon: "section", label: "Section Box" },
    { id: "clip",    icon: "clip",    label: "Clip Plane" },
  ]},
  { tools: [
    { id: "aligned-dim",       icon: "aligned-dim",       label: "Aligned Dim" },
    { id: "angular-dim",       icon: "angular-dim",       label: "Angular Dim" },
    { id: "area-dim",          icon: "area-dim",          label: "Area" },
    { id: "volume-dim",        icon: "volume-dim",        label: "Volume" },
    { id: "label",             icon: "label",             label: "Label" },
    { id: "transient-measure", icon: "transient-measure", label: "Transient" },
  ]},
];

// Tools whose click handler dispatches a 2D draft-tool activation (not a 3D tool).
const LAYOUT_PALETTE_SECTIONS: PaletteSection[] = [
  // NAV — only confirmed-working tools in layout mode
  { tools: [
    { id: "select", icon: "select", label: "Select" },
    { id: "pan",    icon: "pan",    label: "Pan" },
    { id: "zoom",   icon: "zoom",   label: "Zoom" },
  ]},
];

// PALETTE_SECTIONS indices
const ARCH_SECTION_IDX = 4;
const COMP_SECTION_IDX = 5;

// Single shared tooltip element — created once, reused across all palette instances.
function getPaletteTip(): HTMLDivElement {
  let tip = document.getElementById("palette-tip") as HTMLDivElement | null;
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "palette-tip";
    tip.style.cssText = [
      "position:fixed",
      "pointer-events:none",
      "display:none",
      "background:#111",
      "color:#fff",
      "padding:3px 8px",
      "font-size:10px",
      "font-family:var(--mono,monospace)",
      "letter-spacing:.06em",
      "text-transform:uppercase",
      "border-radius:4px",
      "white-space:nowrap",
      "z-index:99999",
    ].join(";");
    document.body.appendChild(tip);
    document.addEventListener("mousemove", (e) => {
      if (tip!.style.display === "none") return;
      tip!.style.left = (e.clientX + 14) + "px";
      tip!.style.top  = (e.clientY - 10) + "px";
    });
  }
  return tip;
}

function showSelModeMenu(anchor: HTMLElement): void {
  document.querySelector(".sel-mode-menu")?.remove();

  const modes: Array<{ label: string; sub: string; toolId: string }> = [
    { label: "Standard",       sub: "Default click-to-select",            toolId: "select"       },
    { label: "Window Select",  sub: "Drag rectangle  [Crossing/Window]",  toolId: "sel-window"   },
    { label: "Lasso Select",   sub: "Freehand region  [Crossing/Window]", toolId: "sel-lasso"    },
    { label: "Boundary Select",sub: "Pick curve or draw polygon",         toolId: "sel-boundary" },
  ];

  const menu = el("div", "sel-mode-menu");
  menu.setAttribute("role", "menu");
  const rows: HTMLElement[] = [];
  for (const mode of modes) {
    const row = el("div", "sel-mode-row");
    row.setAttribute("role", "menuitem");
    row.setAttribute("tabindex", "0");
    row.dataset.toolId = mode.toolId;
    const labelEl = el("span", "sel-mode-label");
    labelEl.textContent = mode.label;
    const subEl = el("span", "sel-mode-sub");
    subEl.textContent = mode.sub;
    row.appendChild(labelEl);
    row.appendChild(subEl);
    row.addEventListener("click", () => {
      menu.remove();
      cleanup();
      dispatchSync("setActiveTool", { toolId: mode.toolId });
    });
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); row.click(); }
    });
    rows.push(row);
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  menu.style.left = rect.left + "px";
  menu.style.top  = (rect.bottom + 4) + "px";

  const onMove = (ev: PointerEvent) => {
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const hovered = under?.closest<HTMLElement>(".sel-mode-row") ?? null;
    for (const r of rows) r.classList.toggle("active", r === hovered);
  };

  const onUp = (ev: PointerEvent) => {
    cleanup();
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const row = under?.closest<HTMLElement>(".sel-mode-row");
    if (row?.dataset.toolId) {
      menu.remove();
      dispatchSync("setActiveTool", { toolId: row.dataset.toolId });
      return;
    }
    if (!menu.contains(under as Node)) {
      menu.remove();
      return;
    }
    setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
  };

  const onOutside = (ev: PointerEvent) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener("pointerdown", onOutside, true);
    }
  };

  const cleanup = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

function showScaleModeMenu(anchor: HTMLElement): void {
  document.querySelector(".sel-mode-menu")?.remove();

  const modes: Array<{ label: string; sub: string; toolId: string }> = [
    { label: "Scale 3D",  sub: "Uniform scale in all axes",              toolId: "scale"    },
    { label: "Scale 1D",  sub: "Stretch along one axis  [X / Y / Z]",   toolId: "scale-1d" },
    { label: "Scale 2D",  sub: "Uniform scale in XY plane  [Z intact]", toolId: "scale-2d" },
  ];

  const menu = el("div", "sel-mode-menu");
  menu.setAttribute("role", "menu");
  const rows: HTMLElement[] = [];
  for (const mode of modes) {
    const row = el("div", "sel-mode-row");
    row.setAttribute("role", "menuitem");
    row.setAttribute("tabindex", "0");
    row.dataset.toolId = mode.toolId;
    const labelEl = el("span", "sel-mode-label");
    labelEl.textContent = mode.label;
    const subEl = el("span", "sel-mode-sub");
    subEl.textContent = mode.sub;
    row.appendChild(labelEl);
    row.appendChild(subEl);
    row.addEventListener("click", () => {
      menu.remove();
      cleanup();
      dispatchSync("setActiveTool", { toolId: mode.toolId });
    });
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); row.click(); }
    });
    rows.push(row);
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  menu.style.left = rect.left + "px";
  menu.style.top  = (rect.bottom + 4) + "px";

  const onMove = (ev: PointerEvent) => {
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const hovered = under?.closest<HTMLElement>(".sel-mode-row") ?? null;
    for (const r of rows) r.classList.toggle("active", r === hovered);
  };

  const onUp = (ev: PointerEvent) => {
    cleanup();
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const row = under?.closest<HTMLElement>(".sel-mode-row");
    if (row?.dataset.toolId) {
      menu.remove();
      dispatchSync("setActiveTool", { toolId: row.dataset.toolId });
      return;
    }
    if (!menu.contains(under as Node)) {
      menu.remove();
      return;
    }
    setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
  };

  const onOutside = (ev: PointerEvent) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener("pointerdown", onOutside, true);
    }
  };

  const cleanup = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

function showWallModeMenu(anchor: HTMLElement): void {
  document.querySelector(".sel-mode-menu")?.remove();

  const modes: Array<{ label: string; sub: string; toolId: string }> = [
    { label: "Wall",              sub: "Click two endpoints",                      toolId: "wall"          },
    { label: "Polyline Walls",    sub: "Click chain of points — wall per segment", toolId: "wall-polyline" },
    { label: "Curve Walls",       sub: "Click control pts — spline-fit walls",     toolId: "wall-curve"    },
    { label: "Walls from Object", sub: "Pick existing polygon / curve / line",     toolId: "wall-pick"     },
  ];

  const menu = el("div", "sel-mode-menu");
  menu.setAttribute("role", "menu");
  const rows: HTMLElement[] = [];
  for (const mode of modes) {
    const row = el("div", "sel-mode-row");
    row.setAttribute("role", "menuitem");
    row.setAttribute("tabindex", "0");
    row.dataset.toolId = mode.toolId;
    const labelEl = el("span", "sel-mode-label");
    labelEl.textContent = mode.label;
    const subEl = el("span", "sel-mode-sub");
    subEl.textContent = mode.sub;
    row.appendChild(labelEl);
    row.appendChild(subEl);
    row.addEventListener("click", () => {
      menu.remove();
      cleanup();
      dispatchSync("setActiveTool", { toolId: mode.toolId });
    });
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); row.click(); }
    });
    rows.push(row);
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  menu.style.left = rect.left + "px";
  menu.style.top  = (rect.bottom + 4) + "px";

  const onMove = (ev: PointerEvent) => {
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const hovered = under?.closest<HTMLElement>(".sel-mode-row") ?? null;
    for (const r of rows) r.classList.toggle("active", r === hovered);
  };

  const onUp = (ev: PointerEvent) => {
    cleanup();
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const row = under?.closest<HTMLElement>(".sel-mode-row");
    if (row?.dataset.toolId) {
      menu.remove();
      dispatchSync("setActiveTool", { toolId: row.dataset.toolId });
      return;
    }
    if (!menu.contains(under as Node)) {
      menu.remove();
      return;
    }
    setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
  };

  const onOutside = (ev: PointerEvent) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener("pointerdown", onOutside, true);
    }
  };

  const cleanup = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

function showStairModeMenu(anchor: HTMLElement): void {
  document.querySelector(".sel-mode-menu")?.remove();

  const modes: Array<{ label: string; sub: string; toolId: string }> = [
    { label: "Stair (1-Line)",   sub: "Click start → end point",                  toolId: "stair"          },
    { label: "Polyline Stair",   sub: "Click chain of points — flight per segment", toolId: "stair-polyline" },
    { label: "Curve Stair",      sub: "Click control pts — spiral / curved",       toolId: "stair-curve"    },
  ];

  const menu = el("div", "sel-mode-menu");
  menu.setAttribute("role", "menu");
  const rows: HTMLElement[] = [];
  for (const mode of modes) {
    const row = el("div", "sel-mode-row");
    row.setAttribute("role", "menuitem");
    row.setAttribute("tabindex", "0");
    row.dataset.toolId = mode.toolId;
    const labelEl = el("span", "sel-mode-label");
    labelEl.textContent = mode.label;
    const subEl = el("span", "sel-mode-sub");
    subEl.textContent = mode.sub;
    row.appendChild(labelEl);
    row.appendChild(subEl);
    row.addEventListener("click", () => {
      menu.remove();
      cleanup();
      dispatchSync("setActiveTool", { toolId: mode.toolId });
    });
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); row.click(); }
    });
    rows.push(row);
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  menu.style.left = rect.left + "px";
  menu.style.top  = (rect.bottom + 4) + "px";

  const onMove = (ev: PointerEvent) => {
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const hovered = under?.closest<HTMLElement>(".sel-mode-row") ?? null;
    for (const r of rows) r.classList.toggle("active", r === hovered);
  };

  const onUp = (ev: PointerEvent) => {
    cleanup();
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const row = under?.closest<HTMLElement>(".sel-mode-row");
    if (row?.dataset.toolId) {
      menu.remove();
      dispatchSync("setActiveTool", { toolId: row.dataset.toolId });
    } else {
      menu.remove();
    }
  };

  const onOutside = (ev: PointerEvent) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener("pointerdown", onOutside, true);
    }
  };

  const cleanup = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

function showClipModeMenu(anchor: HTMLElement): void {
  document.querySelector(".sel-mode-menu")?.remove();

  const modes: Array<{ label: string; sub: string; toolId: string }> = [
    { label: "Horizontal Cut", sub: "1 click — horizontal plane at picked Z", toolId: "clip"         },
    { label: "Section Mode",   sub: "2 clicks — vertical plane along line",   toolId: "clip-section" },
  ];

  const menu = el("div", "sel-mode-menu");
  menu.setAttribute("role", "menu");
  const rows: HTMLElement[] = [];
  for (const mode of modes) {
    const row = el("div", "sel-mode-row");
    row.setAttribute("role", "menuitem");
    row.setAttribute("tabindex", "0");
    row.dataset.toolId = mode.toolId;
    const labelEl = el("span", "sel-mode-label");
    labelEl.textContent = mode.label;
    const subEl = el("span", "sel-mode-sub");
    subEl.textContent = mode.sub;
    row.appendChild(labelEl);
    row.appendChild(subEl);
    row.addEventListener("click", () => {
      menu.remove();
      cleanup();
      dispatchSync("setActiveTool", { toolId: mode.toolId });
    });
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); row.click(); }
    });
    rows.push(row);
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  menu.style.left = rect.left + "px";
  menu.style.top  = (rect.bottom + 4) + "px";

  const onMove = (ev: PointerEvent) => {
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const hovered = under?.closest<HTMLElement>(".sel-mode-row") ?? null;
    for (const r of rows) r.classList.toggle("active", r === hovered);
  };

  const onUp = (ev: PointerEvent) => {
    cleanup();
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const row = under?.closest<HTMLElement>(".sel-mode-row");
    if (row?.dataset.toolId) {
      menu.remove();
      dispatchSync("setActiveTool", { toolId: row.dataset.toolId });
    } else {
      menu.remove();
    }
  };

  const onOutside = (ev: PointerEvent) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener("pointerdown", onOutside, true);
    }
  };

  const cleanup = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

let _paletteHost: HTMLElement | null = null;

export function buildPalette(host: HTMLElement) {
  _paletteHost = host;
  host.innerHTML = "";

  const tip = getPaletteTip();

  host.addEventListener("mouseover", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".palette-btn");
    if (!btn) return;
    const label = btn.getAttribute("aria-label") ?? "";
    tip.textContent = label;
    tip.style.left = (e as MouseEvent).clientX + 14 + "px";
    tip.style.top  = (e as MouseEvent).clientY - 10 + "px";
    tip.style.display = "block";
  });
  host.addEventListener("mouseout", (e) => {
    const leaving = (e.target as HTMLElement).closest<HTMLElement>(".palette-btn");
    if (!leaving) return;
    const to = (e as MouseEvent).relatedTarget as HTMLElement | null;
    if (to && leaving.contains(to)) return;
    tip.style.display = "none";
  });

  const sectionEls: HTMLElement[] = [];

  for (let i = 0; i < PALETTE_SECTIONS.length; i++) {
    const section = PALETTE_SECTIONS[i];
    const sec = el("div", "palette-section");
    if (i === COMP_SECTION_IDX) sec.classList.add("palette-section--hidden");
    for (const tool of section.tools) {
      const btn = el("button", "palette-btn", { type: "button", "aria-label": tool.label, "data-tool": tool.id });
      const hasCorner = tool.id === "select" || tool.id === "scale" || tool.id === "wall" || tool.id === "stair" || tool.id === "clip";
      btn.innerHTML = iconSVG(tool.icon, 18) + (hasCorner ? `<span class="corner"></span>` : "");
      if (tool.id === "select" || tool.id === "scale" || tool.id === "wall" || tool.id === "stair" || tool.id === "clip") {
        const showMenu = tool.id === "select" ? showSelModeMenu
          : tool.id === "scale" ? showScaleModeMenu
          : tool.id === "stair" ? showStairModeMenu
          : tool.id === "clip" ? showClipModeMenu
          : showWallModeMenu;
        const defaultToolId = tool.id;
        let holdTimer: ReturnType<typeof setTimeout> | null = null;
        let menuOpened = false;
        btn.addEventListener("pointerdown", (ev) => {
          if (ev.button !== 0) return;
          try { btn.releasePointerCapture(ev.pointerId); } catch { /* ok */ }
          menuOpened = false;
          holdTimer = setTimeout(() => {
            menuOpened = true;
            showMenu(btn);
          }, 280);
        });
        btn.addEventListener("pointerup", () => {
          if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        });
        btn.addEventListener("click", () => {
          if (!menuOpened) dispatchSync("setActiveTool", { toolId: defaultToolId });
          menuOpened = false;
        });
      } else {
        btn.addEventListener("click", () => {
          if (getState("activeTool") === tool.id && OP_TOOL_IDS.has(tool.id)) {
            dispatchSync("setActiveTool", { toolId: "select" });
          } else {
            dispatchSync("setActiveTool", { toolId: tool.id });
          }
        });
      }
      sec.appendChild(btn);
    }
    host.appendChild(sec);
    sectionEls[i] = sec;
  }

  function showSectionTab(tab: "ARCH" | "CAD") {
    const showArch = tab === "ARCH";
    sectionEls[ARCH_SECTION_IDX]?.classList.toggle("palette-section--hidden", !showArch);
    sectionEls[COMP_SECTION_IDX]?.classList.toggle("palette-section--hidden", showArch);
  }

  window.addEventListener("ribbon:section-tab", (rawEv) => {
    const tab = (rawEv as CustomEvent<{ tab: string }>).detail?.tab;
    if (tab === "ARCH" || tab === "CAD") {
      showSectionTab(tab as "ARCH" | "CAD");
    }
  });

  // Variant picker — shown when door/window tool is active (#1127).
  const variantPicker = el("div", "palette-variant-picker");
  variantPicker.style.display = "none";
  variantPicker.innerHTML = `<div class="vp-title">Variant</div>`;

  const _vBtnSvgs = {
    door: [
      `<svg width="24" height="28" viewBox="0 0 24 28"><rect x="2" y="1" width="20" height="26" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="5" y="4" width="14" height="10" rx="0.5" fill="none" stroke="currentColor" stroke-width="0.8"/><rect x="5" y="16" width="14" height="9" rx="0.5" fill="none" stroke="currentColor" stroke-width="0.8"/><circle cx="18" cy="14.5" r="1" fill="currentColor"/></svg>`,
      `<svg width="24" height="28" viewBox="0 0 24 28"><rect x="1" y="1" width="10" height="26" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="13" y="1" width="10" height="26" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="4" width="6" height="10" rx="0.5" fill="none" stroke="currentColor" stroke-width="0.8"/><rect x="15" y="4" width="6" height="10" rx="0.5" fill="none" stroke="currentColor" stroke-width="0.8"/></svg>`,
    ],
    window: [
      `<svg width="28" height="22" viewBox="0 0 28 22"><rect x="1" y="1" width="26" height="20" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="14" y1="2" x2="14" y2="20" stroke="currentColor" stroke-width="0.8"/><rect x="3" y="3" width="9" height="16" rx="0.5" fill="rgba(100,160,210,0.25)" stroke="none"/><rect x="16" y="3" width="9" height="16" rx="0.5" fill="rgba(100,160,210,0.25)" stroke="none"/></svg>`,
      `<svg width="28" height="22" viewBox="0 0 28 22"><rect x="1" y="1" width="26" height="20" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="3" width="22" height="16" rx="0.5" fill="rgba(100,160,210,0.25)" stroke="currentColor" stroke-width="0.5"/></svg>`,
    ],
  };

  let _vpTool: "door" | "window" | null = null;
  let _vpSelected = 0;
  const _vpBtns: HTMLButtonElement[] = [];

  function _rebuildVariantBtns(toolId: "door" | "window"): void {
    _vpTool = toolId;
    variantPicker.querySelectorAll(".vp-btn").forEach(b => b.remove());
    _vpBtns.length = 0;
    const svgs = _vBtnSvgs[toolId];
    for (let i = 0; i < svgs.length; i++) {
      const btn = el("button", "palette-btn vp-btn", { type: "button", "aria-label": `Variant ${i + 1}`, "data-variant": String(i) }) as HTMLButtonElement;
      btn.innerHTML = svgs[i];
      if (i === _vpSelected) btn.classList.add("active");
      btn.addEventListener("click", () => {
        _vpSelected = i;
        _vpBtns.forEach((b, j) => b.classList.toggle("active", j === i));
        if (toolId === "door") setDoorVariant(i as 0 | 1);
        else setWindowVariant(i as 0 | 1);
      });
      variantPicker.appendChild(btn);
      _vpBtns.push(btn);
    }
  }

  subscribe(() => {
    const tool = getState("activeTool");
    if (tool === "door" || tool === "window") {
      if (tool !== _vpTool) { _vpSelected = 0; _rebuildVariantBtns(tool); }
      variantPicker.style.display = "";
    } else {
      variantPicker.style.display = "none";
    }
  });

  host.appendChild(variantPicker);
}

export function buildLayoutPalette(host: HTMLElement) {
  host.innerHTML = "";
  const tip = getPaletteTip();
  host.addEventListener("mouseover", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".palette-btn");
    if (!btn) return;
    tip.textContent = btn.getAttribute("aria-label") ?? "";
    tip.style.left = (e as MouseEvent).clientX + 14 + "px";
    tip.style.top  = (e as MouseEvent).clientY - 10 + "px";
    tip.style.display = "block";
  });
  host.addEventListener("mouseout", (e) => {
    const leaving = (e.target as HTMLElement).closest<HTMLElement>(".palette-btn");
    if (!leaving) return;
    const to = (e as MouseEvent).relatedTarget as HTMLElement | null;
    if (to && leaving.contains(to)) return;
    tip.style.display = "none";
  });
  for (const section of LAYOUT_PALETTE_SECTIONS) {
    const sec = el("div", "palette-section");
    for (const tool of section.tools) {
      const btn = el("button", "palette-btn", { type: "button", "aria-label": tool.label, "data-tool": tool.id });
      btn.innerHTML = iconSVG(tool.icon, 18);
      btn.addEventListener("click", () => {
        dispatchSync("setActiveTool", { toolId: tool.id });
      });
      sec.appendChild(btn);
    }
    host.appendChild(sec);
  }
}

export function rebuildPaletteForMode(mode: string) {
  if (!_paletteHost) return;
  if (mode === "layout") buildLayoutPalette(_paletteHost);
  else buildPalette(_paletteHost);
}

export function buildSnapDock(): HTMLElement {
  const root = el("div", "snap-dock");
  const snap = getSnap();
  const SNAP_KEYS: Array<{ key: keyof typeof snap; label: string }> = [
    { key: "snapOn",          label: "Snap" },
    { key: "orthoOn",         label: "Ortho" },
    { key: "gridOn",          label: "Grid" },
    { key: "polarOn",         label: "Polar" },
    { key: "vertexSnapOn",    label: "Vertex" },
    { key: "edgeSnapOn",      label: "Edge" },
    { key: "midpointSnapOn",  label: "Midpt" },
  ];
  const rows = SNAP_KEYS.map(({ key, label }) => {
    const checked = snap[key] ? "checked" : "";
    return `<label class="sf-row" style="display:flex; align-items:center; gap:6px; padding:2px 0; font-size:11px; cursor:pointer;">
      <input type="checkbox" data-snap="${key}" ${checked} style="margin:0;"/>
      <span style="color:var(--ink-soft);">${label}</span>
    </label>`;
  }).join("");
  root.innerHTML = `
    <div class="snap-dock-title">SNAP / CONSTRAIN</div>
    <div style="display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:0 12px; padding:2px 0 4px;">
      ${rows}
    </div>
    <div class="snap-row"><span class="k">step</span><input class="snap-input" id="snap-step-input" type="number" min="0.001" step="0.1" value="${getState("unitSystem") === "imperial" ? (snap.step * 3.28084).toFixed(2) : snap.step.toFixed(2)}"><span class="u">${getState("unitSystem") === "imperial" ? "ft" : "m"}</span></div>
    <div class="snap-row"><span class="k">angle</span><input class="snap-input" id="snap-angle-input" type="number" min="0.1" step="1" value="${snap.angleStep}"><span class="u">°</span></div>
    <div class="snap-row snap-row--cplane" title="Click to change construction plane" style="cursor:pointer"><span class="k">cplane</span><span class="v" id="snap-cplane-label">World XY</span></div>
  `;
  root.querySelectorAll<HTMLInputElement>("input[data-snap]").forEach((input) => {
    const key = input.dataset.snap;
    input.addEventListener("change", () => {
      const on = input.checked;
      switch (key) {
        case "snapOn":         setSnapOn(on); break;
        case "orthoOn":        setOrthoOn(on); break;
        case "gridOn":         setGridOn(on); break;
        case "polarOn":        setPolarOn(on); break;
        case "vertexSnapOn":   setVertexSnapOn(on); break;
        case "edgeSnapOn":     setEdgeSnapOn(on); break;
        case "midpointSnapOn": setMidpointSnapOn(on); break;
      }
    });
  });
  const stepInput = root.querySelector<HTMLInputElement>("#snap-step-input");
  if (stepInput) {
    stepInput.addEventListener("change", () => {
      const v = parseFloat(stepInput.value);
      const imperial = getState("unitSystem") === "imperial";
      const FT = 3.28084;
      if (Number.isFinite(v) && v > 0) {
        const stepM = imperial ? v / FT : v;
        setStep(stepM);
        stepInput.value = (imperial ? stepM * FT : stepM).toFixed(2);
      } else {
        const stepM = getSnap().step;
        stepInput.value = (imperial ? stepM * FT : stepM).toFixed(2);
      }
    });
  }
  const angleInput = root.querySelector<HTMLInputElement>("#snap-angle-input");
  if (angleInput) {
    angleInput.addEventListener("change", () => {
      const v = parseFloat(angleInput.value);
      if (Number.isFinite(v) && v > 0) {
        setAngleStep(v);
        angleInput.value = String(v);
      } else {
        angleInput.value = String(getSnap().angleStep);
      }
    });
  }

  const cplaneLabel = root.querySelector<HTMLElement>("#snap-cplane-label");
  if (cplaneLabel) {
    const cplaneRow = root.querySelector<HTMLElement>(".snap-row--cplane");
    const cplaneDisplayName = (mode: string, kind: string): string => {
      if (kind === "world") return "World XY";
      if (kind === "view-derived") return `${mode.charAt(0).toUpperCase()}${mode.slice(1)} (view)`;
      if (kind === "host-derived") return "Host surface";
      if (mode && mode !== "world") return `${mode.charAt(0).toUpperCase()}${mode.slice(1)}`;
      return "Custom";
    };

    window.addEventListener("viewer:cplane-changed", (e) => {
      const { cplane, mode } = (e as CustomEvent<{ cplane: { kind: string }; mode: string }>).detail;
      const label = cplaneDisplayName(mode ?? "", cplane?.kind ?? "world");
      cplaneLabel.textContent = label;
      cplaneLabel.style.color = cplane?.kind === "world" ? "" : "var(--sanguine)";
    });

    cplaneRow?.addEventListener("click", () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "k", code: "KeyK", ctrlKey: true, bubbles: true,
      }));
      setTimeout(() => {
        const cmdk = document.querySelector<HTMLInputElement>(".cmdk-input");
        if (cmdk) { cmdk.value = "SdSetCPlane "; cmdk.dispatchEvent(new Event("input", { bubbles: true })); }
      }, 80);
    });
  }

  return root;
}
