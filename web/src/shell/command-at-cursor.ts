// command-at-cursor.ts — floating tool-picker triggered by typing on the viewport.
// When a printable key is pressed while no input has focus, an autocomplete overlay
// appears near the pointer. Arrow keys / Tab navigate items; Enter activates the tool.
// After a tool with required dimensions is picked, args mode collects values before executing.

import { dispatchSync } from "../commands/dispatch";
import { isToolMidExecution } from "../tools/index.js";
import { unprojectToXY } from "../viewer/projection";
import type { Viewer } from "../viewer/viewer";

let _overlay: HTMLElement | null = null;
let _pointerX = window.innerWidth / 2;
let _pointerY = window.innerHeight / 2;

// ── imperial parser ────────────────────────────────────────────────────────────

function parseImperial(s: string): number | null {
  const t = s.trim().replace(/\s+/g, "");
  const feetInch = /^(\d+(?:\.\d+)?)'(?:(\d+(?:\.\d+?)?)")?$/.exec(t);
  if (feetInch) return (parseFloat(feetInch[1]) + (feetInch[2] ? parseFloat(feetInch[2]) / 12 : 0)) * 0.3048;
  const inchOnly = /^(\d+(?:\.\d+?)?)"$/.exec(t);
  if (inchOnly) return parseFloat(inchOnly[1]) * 0.0254;
  const ftWord = /^(\d+(?:\.\d+?)?)(?:ft|feet|foot)$/i.exec(t);
  if (ftWord) return parseFloat(ftWord[1]) * 0.3048;
  const plain = /^(\d+(?:\.\d+?)?)$/.exec(t);
  if (plain) return parseFloat(plain[1]) * 0.3048;
  return null;
}

// ── tool args schema ───────────────────────────────────────────────────────────

type ArgDef = { name: string; label: string };
type ArgValues = Record<string, number>;

const TOOL_ARGS_SCHEMA: Partial<Record<string, ArgDef[]>> = {
  circle: [{ name: "radius", label: "Radius" }],
  rect:   [{ name: "width",  label: "Width"  }, { name: "length", label: "Length" }],
  wall:   [{ name: "length", label: "Length" }],
};

function executeToolWithArgs(toolId: string, vals: ArgValues): void {
  type EmitFn = (pt: { x: number; y: number; z: number }) => unknown;
  const emit = (window as unknown as { __emitClickWorld?: EmitFn }).__emitClickWorld;
  const viewer = (window as unknown as { __viewer?: Viewer }).__viewer;
  if (!emit) return;

  let cx = 0, cy = 0;
  if (viewer) {
    const wp = unprojectToXY(viewer, _pointerX, _pointerY);
    if (wp) { cx = wp.x; cy = wp.y; }
  }

  dispatchSync("setActiveTool", { toolId });

  if (toolId === "circle") {
    const r = vals.radius ?? 1;
    emit({ x: cx, y: cy, z: 0 });
    emit({ x: cx + r, y: cy, z: 0 });
  } else if (toolId === "rect") {
    const w = vals.width ?? 1;
    const l = vals.length ?? 1;
    emit({ x: cx, y: cy, z: 0 });
    emit({ x: cx + w, y: cy + l, z: 0 });
  } else if (toolId === "wall") {
    const wl = vals.length ?? 4;
    emit({ x: cx, y: cy, z: 0 });
    emit({ x: cx + wl, y: cy, z: 0 });
  }
}

// ── tool registry ──────────────────────────────────────────────────────────────

type ToolEntry = { id: string; label: string };

function collectTools(): ToolEntry[] {
  const seen = new Set<string>();
  const out: ToolEntry[] = [];
  // Primary palette buttons use data-tool + aria-label.
  for (const el of document.querySelectorAll<HTMLElement>("[data-tool]")) {
    const id = el.dataset.tool!;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = (el.getAttribute("aria-label") ?? id).trim();
    out.push({ id, label });
  }
  // Variant-mode rows use data-tool-id.
  for (const el of document.querySelectorAll<HTMLElement>("[data-tool-id]")) {
    const id = el.dataset.toolId!;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = (el.querySelector(".label")?.textContent ?? el.getAttribute("aria-label") ?? id).trim();
    out.push({ id, label });
  }
  return out;
}

// ── overlay lifecycle ──────────────────────────────────────────────────────────

function close() {
  _overlay?.remove();
  _overlay = null;
}

function commit(id: string) {
  const spec = TOOL_ARGS_SCHEMA[id];
  if (spec && spec.length > 0) {
    openArgsMode(id, spec);
  } else {
    dispatchSync("setActiveTool", { toolId: id });
    close();
  }
}

function openArgsMode(toolId: string, spec: ArgDef[]): void {
  if (!_overlay) return;

  const searchInput = _overlay.querySelector<HTMLInputElement>(".cmd-cursor-input");
  if (searchInput) { searchInput.readOnly = true; searchInput.style.opacity = "0.5"; }

  const list = _overlay.querySelector<HTMLElement>(".cmd-cursor-list");
  if (!list) return;

  const collected: ArgValues = {};
  let argIdx = 0;

  function showNextArg(): void {
    if (argIdx >= spec.length) {
      executeToolWithArgs(toolId, collected);
      close();
      return;
    }
    const { name, label } = spec[argIdx];
    list!.innerHTML = "";

    const labelEl = document.createElement("div");
    labelEl.className = "cmd-cursor-arg-label";
    labelEl.textContent = `${label}:`;
    list!.appendChild(labelEl);

    const argInput = document.createElement("input");
    argInput.type = "text";
    argInput.className = "cmd-cursor-input cmd-cursor-arg-input";
    argInput.placeholder = "5′, 16ft, 1.5m";
    argInput.setAttribute("autocomplete", "off");
    argInput.setAttribute("spellcheck", "false");
    list!.appendChild(argInput);

    const hintEl = document.createElement("div");
    hintEl.className = "cmd-cursor-arg-hint";
    hintEl.textContent = "feet (5′) · inches (36″) · meters (1.5)";
    list!.appendChild(hintEl);

    argInput.addEventListener("blur", () => setTimeout(close, 150));

    argInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        const val = parseImperial(argInput.value);
        if (val === null || val <= 0) {
          argInput.classList.add("cmd-cursor-arg-error");
          argInput.select();
          return;
        }
        collected[name] = val;
        argIdx++;
        showNextArg();
      }
    });

    argInput.focus();
  }

  showNextArg();
}

function open(initial: string) {
  close();
  const tools = collectTools();
  if (tools.length === 0) return;

  const wrap = document.createElement("div");
  wrap.className = "cmd-cursor-overlay";

  // Position near pointer, clamped so overlay stays on-screen.
  const OW = 220, OH = 280;
  const x = Math.min(_pointerX + 4, window.innerWidth  - OW - 8);
  const y = Math.min(_pointerY - 8, window.innerHeight - OH - 8);
  wrap.style.left = `${Math.max(8, x)}px`;
  wrap.style.top  = `${Math.max(8, y)}px`;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "cmd-cursor-input";
  input.value = initial;
  input.setAttribute("aria-label", "Tool search");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  wrap.appendChild(input);

  const list = document.createElement("div");
  list.className = "cmd-cursor-list";
  list.setAttribute("role", "listbox");
  wrap.appendChild(list);

  _overlay = wrap;
  document.body.appendChild(wrap);

  let activeIdx = -1;

  function items() {
    return list.querySelectorAll<HTMLElement>(".cmd-cursor-item");
  }

  function setActive(idx: number) {
    items().forEach((el, i) => el.classList.toggle("cmd-cursor-item--active", i === idx));
    activeIdx = idx;
    items()[idx]?.scrollIntoView({ block: "nearest" });
  }

  function render(query: string) {
    list.innerHTML = "";
    activeIdx = -1;
    const q = query.trim().toLowerCase();
    const matches = q
      ? tools.filter(t => t.label.toLowerCase().includes(q) || t.id.includes(q)).slice(0, 12)
      : tools.slice(0, 12);
    for (const t of matches) {
      const item = document.createElement("div");
      item.className = "cmd-cursor-item";
      item.setAttribute("role", "option");
      item.dataset.toolId = t.id;
      item.textContent = t.label;
      item.addEventListener("pointerdown", (e) => { e.preventDefault(); commit(t.id); });
      list.appendChild(item);
    }
    if (matches.length > 0) setActive(0);
  }

  input.addEventListener("input", () => render(input.value));

  input.addEventListener("keydown", (e) => {
    const els = items();
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const id = els[activeIdx]?.dataset.toolId;
      if (id) commit(id); else close();
      return;
    }
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      setActive(Math.min(activeIdx + 1, els.length - 1));
      return;
    }
    if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      setActive(Math.max(activeIdx - 1, 0));
      return;
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      // Stay open if focus moved inside the overlay (e.g. args-mode arg input).
      if (_overlay?.contains(document.activeElement)) return;
      close();
    }, 150);
  });

  render(initial);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// ── init ───────────────────────────────────────────────────────────────────────

export function initCommandAtCursor(): void {
  document.addEventListener("pointermove", (e) => {
    _pointerX = e.clientX;
    _pointerY = e.clientY;
  });

  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (_overlay) return;
    if (e.key.length !== 1) return;               // non-printable (Shift, Alt, etc.)
    if (e.key === " ") return;                    // Space — reserved for canvas pan / confirm
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.shiftKey) return;                       // Shift-modified printable (e.g. Shift+A)
    if (isToolMidExecution()) return;             // tool is capturing click sequence
    const t = document.activeElement as HTMLElement | null;
    if (!t) return;
    const tag = t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
    // Only trigger when viewport (canvas) or body/root is active — not over dock/menus.
    const overViewport = !!t.closest("#viewer-canvas, .vp-host, body");
    if (!overViewport) return;
    open(e.key);
  });
}
