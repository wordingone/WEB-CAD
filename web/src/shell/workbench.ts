// workbench.ts — thin coordinator.
// Builds the three-pane workbench (.workbench grid: palette / center-col / sidebar).
// Heavy panel content is in the four extracted modules; this file wires them together.
//
// Exports (public API, unchanged from pre-split):
//   setConsoleMode        — re-export from workbench-legacy-chat-input
//   saveRecentEntry       — re-export from workbench-legacy-chat-input
//   buildLayoutPalette    — re-export from workbench-panels
//   rebuildPaletteForMode — re-export from workbench-panels
//   buildWorkbench        — defined here

import { axesGizmoSVG } from "../ui/icons";
import { dispatchSync } from "../commands/dispatch";
import { subscribe as subscribeAppState, type ViewName } from "../app-state";
import { initBootScreen, getCapabilityGatePromise } from "../agent/boot-screen";
import { getCreateSequence } from "../tools/index";

import { buildPalette } from "./workbench-panels";
import { buildSidebar } from "./workbench-sidebar";
import { initRenderModePopover } from "./workbench-render-popover";
import {
  buildDock,
  saveRecentEntry,
  _refreshChatSkills,
} from "./workbench-legacy-chat-input";
import { initLiveTabSubscriptions } from "./workbench-skill-graph";

// ── Re-exports (public API surface preserved) ─────────────────────────────────
export { setConsoleMode, saveRecentEntry } from "./workbench-legacy-chat-input";
export { buildLayoutPalette, rebuildPaletteForMode } from "./workbench-panels";

// Suppress unused-import lint for identifiers used only in re-export or pass-through position.
void (saveRecentEntry as unknown);
void (_refreshChatSkills as unknown);

// ── View-switcher (W2.3) ──────────────────────────────────────────────────────

function el(tag: string, cls?: string, attrs?: Record<string, string>): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

type ViewOption = { view: ViewName; tag: string; label: string };
const VIEW_OPTIONS: ViewOption[] = [
  { view: "top",         tag: "top",   label: "TOP" },
  { view: "bottom",      tag: "bot",   label: "BOTTOM" },
  { view: "front",       tag: "front", label: "FRONT" },
  { view: "back",        tag: "back",  label: "BACK" },
  { view: "left",        tag: "left",  label: "LEFT" },
  { view: "right",       tag: "right", label: "RIGHT" },
  { view: "iso",         tag: "iso",   label: "ISO" },
  { view: "perspective", tag: "persp", label: "PERSPECTIVE" },
];

function applyViewToBtn(btn: HTMLElement, view: ViewName): void {
  const opt = VIEW_OPTIONS.find(o => o.view === view);
  if (!opt) return;
  const tagEl = btn.querySelector<HTMLElement>(".vp-tag");
  const nameEl = btn.querySelector<HTMLElement>(".vp-view-name");
  if (tagEl) { tagEl.className = `vp-tag ${opt.tag}`; }
  if (nameEl) { nameEl.textContent = opt.label; }
  btn.dataset.vpView = view;
}

function initViewSwitcher(): void {
  const backdrop = el("div", "vs-backdrop vs-backdrop--hidden");
  document.body.appendChild(backdrop);

  const popover = el("div", "vs-popover vs-popover--hidden");
  popover.setAttribute("tabindex", "-1");
  document.body.appendChild(popover);

  let activeBtn: HTMLElement | null = null;
  let focusedIdx = -1;

  function setFocusedIdx(idx: number): void {
    focusedIdx = idx;
    popover.querySelectorAll<HTMLElement>(".vs-item").forEach((item, i) => {
      item.classList.toggle("vs-item--focused", i === idx);
    });
  }

  function closePopover(): void {
    popover.classList.add("vs-popover--hidden");
    backdrop.classList.add("vs-backdrop--hidden");
    activeBtn = null;
    focusedIdx = -1;
    popover.querySelectorAll<HTMLElement>(".vs-item").forEach(item => {
      item.classList.remove("vs-item--focused");
    });
  }

  function syncActive(current: ViewName): void {
    popover.querySelectorAll<HTMLElement>(".vs-item").forEach(item => {
      item.classList.toggle("vs-item--active", item.dataset.view === current);
    });
  }

  for (const opt of VIEW_OPTIONS) {
    const item = el("div", "vs-item", { "data-view": opt.view });
    item.innerHTML = `<span class="vs-check">✓</span><span class="vp-tag ${opt.tag}"></span><span class="vs-label">${opt.label}</span>`;
    item.addEventListener("click", () => {
      if (opt.view === "perspective") {
        dispatchSync("SdSetViewPerspective", {});
      } else {
        dispatchSync("SdSetViewOrtho", { view: opt.view });
      }
      if (activeBtn) applyViewToBtn(activeBtn, opt.view);
      closePopover();
    });
    popover.appendChild(item);
  }

  popover.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closePopover(); e.preventDefault(); return; }
    const n = VIEW_OPTIONS.length;
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusedIdx((focusedIdx + 1) % n); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocusedIdx((focusedIdx - 1 + n) % n); }
    else if (e.key === "Enter" && focusedIdx >= 0) {
      e.preventDefault();
      const opt = VIEW_OPTIONS[focusedIdx];
      if (opt) {
        if (opt.view === "perspective") {
          dispatchSync("SdSetViewPerspective", {});
        } else {
          dispatchSync("SdSetViewOrtho", { view: opt.view });
        }
        if (activeBtn) applyViewToBtn(activeBtn, opt.view);
        closePopover();
      }
    }
  });

  backdrop.addEventListener("click", closePopover);

  document.querySelectorAll<HTMLElement>(".vp-view-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (activeBtn === btn && !popover.classList.contains("vs-popover--hidden")) {
        closePopover();
        return;
      }
      activeBtn = btn;
      const rect = btn.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      popover.classList.remove("vs-popover--hidden");
      backdrop.classList.remove("vs-backdrop--hidden");
      const pw = popover.offsetWidth;
      const ph = popover.offsetHeight;
      let left = rect.left;
      let top  = rect.bottom + 2;
      if (left + pw > vw - 10) left = Math.max(0, rect.right - pw);
      if (top  + ph > vh - 10) top  = rect.top - ph - 2;
      popover.style.left = `${left}px`;
      popover.style.top  = `${top}px`;
      const currentView = btn.dataset.vpView as ViewName ?? "perspective";
      syncActive(currentView);
      const activeIdx = VIEW_OPTIONS.findIndex(o => o.view === currentView);
      setFocusedIdx(activeIdx >= 0 ? activeIdx : 0);
      popover.focus();
    });
  });

  // Keep viewport-2's button in sync when view changes via cmdk/agent.
  subscribeAppState("currentView", (view) => {
    const vp2btn = document.querySelector<HTMLElement>("#viewport-2 .vp-view-btn");
    if (vp2btn) applyViewToBtn(vp2btn, view);
  });
}

// ── Dock resize ───────────────────────────────────────────────────────────────

function wireDockResize(): void {
  const divider = document.getElementById("dock-divider");
  const app = document.querySelector(".app") as HTMLElement | null;
  if (!divider || !app) return;
  let dragging = false;
  let startY = 0;
  let startH = 0;
  divider.addEventListener("mousedown", (e: MouseEvent) => {
    dragging = true;
    startY = e.clientY;
    const cur = getComputedStyle(app).getPropertyValue("--dock-h").trim();
    startH = parseInt(cur || "340", 10);
    document.body.style.userSelect = "none";
  });
  window.addEventListener("mousemove", (e: MouseEvent) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    const maxH = Math.min(560, window.innerHeight * 0.5);
    const newH = Math.max(80, Math.min(maxH, startH + dy));
    app.style.setProperty("--dock-h", newH + "px");
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    document.body.style.userSelect = "";
  });
}

// ── Panel collapse toggles (#488 / #517) ─────────────────────────────────────

function wirePanelToggles(): void {
  const workbench = document.querySelector<HTMLElement>(".workbench");
  if (!workbench) return;

  const backdrop = document.createElement("div");
  backdrop.className = "drawer-backdrop";
  document.body.appendChild(backdrop);

  const btnPalette = document.createElement("button");
  btnPalette.type = "button";
  btnPalette.className = "drawer-btn drawer-btn-palette";
  btnPalette.title = "Show palette";
  btnPalette.textContent = "≡";
  document.body.appendChild(btnPalette);

  const btnSidebar = document.createElement("button");
  btnSidebar.type = "button";
  btnSidebar.className = "drawer-btn drawer-btn-sidebar";
  btnSidebar.title = "Show sidebar";
  btnSidebar.textContent = "≡";
  document.body.appendChild(btnSidebar);

  function isDrawerMode(): boolean { return window.innerWidth <= 600; }

  function closeDrawers(): void {
    document.querySelector(".palette")?.classList.remove("drawer-open");
    document.querySelector(".sidebar")?.classList.remove("drawer-open");
    backdrop.classList.remove("active");
  }

  function toggleDrawer(panel: "palette" | "sidebar"): void {
    const panelEl = document.querySelector<HTMLElement>(`.${panel}`);
    if (!panelEl) return;
    const wasOpen = panelEl.classList.contains("drawer-open");
    closeDrawers();
    if (!wasOpen) {
      panelEl.classList.add("drawer-open");
      backdrop.classList.add("active");
    }
  }

  btnPalette.addEventListener("click", () => toggleDrawer("palette"));
  btnSidebar.addEventListener("click",  () => toggleDrawer("sidebar"));
  backdrop.addEventListener("click", closeDrawers);

  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.key === "[") {
      e.preventDefault();
      if (isDrawerMode()) toggleDrawer("palette");
      else workbench.classList.toggle("palette-collapsed");
    }
    if (e.altKey && e.key === "]") {
      e.preventDefault();
      if (isDrawerMode()) toggleDrawer("sidebar");
      else workbench.classList.toggle("sidebar-collapsed");
    }
  });
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function buildWorkbench(): void {
  initBootScreen();

  const paletteHost = document.getElementById("palette-host");
  const dockTabsHost = document.getElementById("dock-tabs-host");
  const dockBodyHost = document.getElementById("dock-body-host");
  const sidebarHost = document.getElementById("sidebar-host");
  const axesHost = document.getElementById("vp-axes-host");

  const promptPane = document.getElementById("prompt-pane");
  const scenePanel = document.getElementById("scene-panel");
  const paramPanel = document.getElementById("param-panel");

  if (paletteHost) buildPalette(paletteHost);
  if (sidebarHost) buildSidebar(sidebarHost, scenePanel);
  if (dockTabsHost && dockBodyHost) {
    buildDock(dockTabsHost, dockBodyHost, promptPane, paramPanel, getCreateSequence, getCapabilityGatePromise);
    initLiveTabSubscriptions(getCreateSequence, saveRecentEntry, _refreshChatSkills);
  }
  if (axesHost) axesHost.innerHTML = axesGizmoSVG();

  initRenderModePopover();
  initViewSwitcher();
  wireDockResize();
  wirePanelToggles();
}
