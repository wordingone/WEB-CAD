// workbench-render-popover.ts — render mode popover.
// Extracted from workbench.ts (lines 3300–3442).

import {
  setRenderMode, setLineType, setLineWeight,
  getRenderMode, getLineType, getLineWeight,
  type RenderMode, type LineType, type LineWeight,
} from "../viewer/render-modes";

function el(tag: string, cls?: string, attrs?: Record<string, string>): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export function initRenderModePopover(): void {
  const MODES: RenderMode[] = ["shaded", "wireframe", "ghosted", "realistic", "technical"];
  const LINE_TYPES: LineType[] = ["solid", "dashed", "hidden", "centerline", "gridline", "dotted"];
  const LINE_WEIGHTS: LineWeight[] = ["thin", "medium", "thick"];

  // Backdrop captures click-outside; sits below the popover in z-order.
  const backdrop = el("div", "rm-popover-backdrop rm-popover-backdrop--hidden");
  document.body.appendChild(backdrop);

  // Fixed-position popover appended to body — triggered by RENDER ribbon tab.
  const popover = el("div", "rm-popover rm-popover--hidden");
  popover.setAttribute("tabindex", "-1");
  document.body.appendChild(popover);

  // Mode list rows.
  const modeList = el("div", "rm-mode-list");
  for (const m of MODES) {
    const item = el("div", "rm-mode-item", { "data-mode": m });
    item.innerHTML = `<span class="rm-check">✓</span><span class="rm-label">${m.charAt(0).toUpperCase() + m.slice(1)}</span>`;
    item.addEventListener("click", () => { setRenderMode(m); closePopover(); });
    modeList.appendChild(item);
  }
  popover.appendChild(modeList);

  // Line type / weight sub-panel (shown only when TECHNICAL).
  const linePicker = el("div", "rm-line-picker rm-line-picker--hidden");
  const ltRow = el("div", "rm-lt-row");
  for (const lt of LINE_TYPES) {
    const b = el("button", "rm-lt-btn", { type: "button", "data-lt": lt, title: lt });
    b.textContent = lt.charAt(0).toUpperCase() + lt.slice(1);
    b.addEventListener("click", () => setLineType(lt));
    ltRow.appendChild(b);
  }
  linePicker.appendChild(ltRow);
  const lwRow = el("div", "rm-lw-row");
  for (const lw of LINE_WEIGHTS) {
    const b = el("button", "rm-lw-btn", { type: "button", "data-lw": lw, title: lw });
    b.textContent = lw.charAt(0).toUpperCase() + lw.slice(1);
    b.addEventListener("click", () => setLineWeight(lw));
    lwRow.appendChild(b);
  }
  linePicker.appendChild(lwRow);
  popover.appendChild(linePicker);

  let open = false;
  let focusedIdx = -1;

  function setFocusedIdx(idx: number): void {
    focusedIdx = idx;
    modeList.querySelectorAll<HTMLElement>(".rm-mode-item").forEach((item, i) => {
      item.classList.toggle("rm-mode-item--focused", i === idx);
    });
  }

  function closePopover() {
    open = false;
    focusedIdx = -1;
    popover.classList.add("rm-popover--hidden");
    backdrop.classList.add("rm-popover-backdrop--hidden");
    modeList.querySelectorAll<HTMLElement>(".rm-mode-item").forEach((item) => {
      item.classList.remove("rm-mode-item--focused");
    });
  }

  function syncState() {
    const mode = getRenderMode();
    const lt   = getLineType();
    const lw   = getLineWeight();
    modeList.querySelectorAll<HTMLElement>(".rm-mode-item").forEach((item) => {
      item.classList.toggle("rm-mode-item--active", item.dataset.mode === mode);
    });
    linePicker.classList.toggle("rm-line-picker--hidden", mode !== "technical");
    ltRow.querySelectorAll<HTMLElement>(".rm-lt-btn").forEach((b) => {
      b.classList.toggle("rm-lt-btn--active", b.dataset.lt === lt);
    });
    lwRow.querySelectorAll<HTMLElement>(".rm-lw-btn").forEach((b) => {
      b.classList.toggle("rm-lw-btn--active", b.dataset.lw === lw);
    });
  }

  // Keyboard: Escape closes; ArrowUp/Down cycles modes; Enter applies focused mode.
  popover.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closePopover(); e.preventDefault(); return; }
    const items = MODES;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIdx((focusedIdx + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIdx((focusedIdx - 1 + items.length) % items.length);
    } else if (e.key === "Enter" && focusedIdx >= 0) {
      e.preventDefault();
      const m = MODES[focusedIdx];
      if (m) { setRenderMode(m); closePopover(); }
    }
  });

  // Wire each per-viewport RENDER button to fire render-mode-toggle with its own rect.
  document.querySelectorAll<HTMLElement>('.vp-render-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('render-mode-toggle', { detail: { rect: btn.getBoundingClientRect() } }));
    });
  });

  // RENDER button in each vp-header fires this event; position popover below it.
  window.addEventListener("render-mode-toggle", (rawEv) => {
    const rect = (rawEv as CustomEvent<{ rect: DOMRect }>).detail?.rect;
    open = !open;
    if (open && rect) {
      popover.style.left = `${rect.left}px`;
      popover.style.top  = `${rect.bottom + 4}px`;
      popover.classList.remove("rm-popover--hidden");
      backdrop.classList.remove("rm-popover-backdrop--hidden");
      // Edge-collision clamp after layout
      const pw = popover.offsetWidth;
      const ph = popover.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = rect.left;
      let top  = rect.bottom + 4;
      if (left + pw > vw - 10) left = Math.max(0, rect.right - pw);
      if (top  + ph > vh - 10) top  = rect.top - ph - 4;
      popover.style.left = `${left}px`;
      popover.style.top  = `${top}px`;
      const activeIdx = MODES.indexOf(getRenderMode());
      setFocusedIdx(activeIdx >= 0 ? activeIdx : 0);
      syncState();
      popover.focus();
    } else {
      closePopover();
    }
  });
  backdrop.addEventListener("click", closePopover);
  document.addEventListener("click", (e) => {
    if (open && !popover.contains(e.target as Node) && e.target !== backdrop) closePopover();
  });
  window.addEventListener("render-mode-changed", () => syncState());

  syncState();
}
