// command-at-cursor.ts — floating tool-picker triggered by typing on the viewport.
// When a printable key is pressed while no input has focus, an autocomplete overlay
// appears near the pointer. Arrow keys / Tab navigate items; Enter activates the tool.

import { dispatchSync } from "../commands/dispatch";
import { isToolMidExecution } from "../tools/index.js";

let _overlay: HTMLElement | null = null;
let _pointerX = window.innerWidth / 2;
let _pointerY = window.innerHeight / 2;

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
  dispatchSync("setActiveTool", { toolId: id });
  close();
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

  input.addEventListener("blur", () => setTimeout(close, 150));

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
