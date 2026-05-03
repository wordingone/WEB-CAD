// Cmd-K command palette — design-handoff #179.
//
// Scope: the palette overlay only. Console parser + history/undo are separate
// slices of #179 that land alongside the dock surface (#175) and are deferred
// to a follow-up. This commit ships the contained overlay so Ctrl+K is live
// before the dock surface lands.
//
// Behavior:
//   - Ctrl+K (or Cmd+K on macOS) opens a centered overlay.
//   - Search input filters a command list assembled from menubar entries +
//     a few palette-only extras (Toggle theme, Reload, About).
//   - Arrow Up/Down navigates; Home/End jumps; Enter executes; Escape closes.
//   - Click on a row executes; click on backdrop closes.
//   - Per #179 task scope, command actions are no-op stubs that log to console
//     (full handler wiring lives with the per-feature sub-tasks that own each
//     domain — file ops in #178, view nav in #173, etc.).

type Command = {
  id: string;
  label: string;
  group?: string;
  shortcut?: string;
  /** Synonyms / search aliases. "theme" finds Toggle Day/Night even though the label says neither word. */
  keywords?: string[];
  /** Lowercased haystack pre-built once per command for filter speed. */
  haystack?: string;
};

const COMMANDS: Command[] = [
  // File
  { id: "file.new",          group: "File",   label: "New",                 shortcut: "Ctrl+N" },
  { id: "file.open",          group: "File",   label: "Open…",               shortcut: "Ctrl+O" },
  { id: "file.save",          group: "File",   label: "Save",                shortcut: "Ctrl+S" },
  { id: "file.saveas",        group: "File",   label: "Save As…",            shortcut: "Ctrl+Shift+S" },
  { id: "file.export",        group: "File",   label: "Export…",             shortcut: "Ctrl+E" },
  { id: "file.quit",          group: "File",   label: "Quit",                shortcut: "Ctrl+Q" },
  // Edit
  { id: "edit.undo",          group: "Edit",   label: "Undo",                shortcut: "Ctrl+Z" },
  { id: "edit.redo",          group: "Edit",   label: "Redo",                shortcut: "Ctrl+Shift+Z" },
  { id: "edit.cut",           group: "Edit",   label: "Cut",                 shortcut: "Ctrl+X" },
  { id: "edit.copy",          group: "Edit",   label: "Copy",                shortcut: "Ctrl+C" },
  { id: "edit.paste",         group: "Edit",   label: "Paste",               shortcut: "Ctrl+V" },
  { id: "edit.preferences",   group: "Edit",   label: "Preferences…",        shortcut: "Ctrl+," },
  // View
  { id: "view.top",           group: "View",   label: "Top",                 shortcut: "7" },
  { id: "view.front",         group: "View",   label: "Front",               shortcut: "1" },
  { id: "view.right",         group: "View",   label: "Right",               shortcut: "3" },
  { id: "view.iso",           group: "View",   label: "Iso",                 shortcut: "9" },
  { id: "view.fit",           group: "View",   label: "Fit",                 shortcut: "F" },
  { id: "view.toggleGrid",    group: "View",   label: "Toggle Grid",         shortcut: "G" },
  { id: "view.toggleSnap",    group: "View",   label: "Toggle Snap",         shortcut: "Shift+S" },
  // Sketch
  { id: "sketch.line",        group: "Sketch", label: "Line",                shortcut: "L" },
  { id: "sketch.rectangle",   group: "Sketch", label: "Rectangle",           shortcut: "R" },
  { id: "sketch.circle",      group: "Sketch", label: "Circle",              shortcut: "C" },
  { id: "sketch.arc",         group: "Sketch", label: "Arc",                 shortcut: "A" },
  { id: "sketch.polygon",     group: "Sketch", label: "Polygon" },
  // Solid
  { id: "solid.extrude",      group: "Solid",  label: "Extrude",             shortcut: "E" },
  { id: "solid.revolve",      group: "Solid",  label: "Revolve" },
  { id: "solid.sweep",        group: "Solid",  label: "Sweep" },
  { id: "solid.loft",         group: "Solid",  label: "Loft" },
  { id: "solid.fillet",       group: "Solid",  label: "Fillet",              shortcut: "Shift+F" },
  { id: "solid.chamfer",      group: "Solid",  label: "Chamfer" },
  // Arch
  { id: "arch.wall",          group: "Arch",   label: "Wall",                shortcut: "W" },
  { id: "arch.floor",         group: "Arch",   label: "Floor",               shortcut: "F" },
  { id: "arch.roof",          group: "Arch",   label: "Roof" },
  { id: "arch.door",          group: "Arch",   label: "Door",                shortcut: "D" },
  { id: "arch.window",        group: "Arch",   label: "Window" },
  { id: "arch.stair",         group: "Arch",   label: "Stair" },
  { id: "arch.column",        group: "Arch",   label: "Column" },
  // Render
  { id: "render.realtime",    group: "Render", label: "Realtime",            shortcut: "Shift+R" },
  { id: "render.daylight",    group: "Render", label: "Daylight" },
  { id: "render.materials",   group: "Render", label: "Material Library",    shortcut: "M" },
  { id: "render.region",      group: "Render", label: "Render Region…" },
  // Window (layout)
  { id: "window.single",      group: "Window", label: "Single",              shortcut: "1" },
  { id: "window.quad",        group: "Window", label: "Quad",                shortcut: "2" },
  { id: "window.hsplit",      group: "Window", label: "Horizontal Split",    shortcut: "3" },
  { id: "window.vsplit",      group: "Window", label: "Vertical Split",      shortcut: "4" },
  { id: "window.reset",       group: "Window", label: "Reset Layout" },
  // App
  { id: "app.toggleTheme",    group: "App",    label: "Toggle Day/Night",    shortcut: "Ctrl+\\",
    keywords: ["theme", "dark", "light", "vellum", "blueprint"] },
  { id: "app.reload",         group: "App",    label: "Reload",              keywords: ["refresh"] },
  { id: "app.shortcuts",      group: "App",    label: "Keyboard Shortcuts",  shortcut: "?",
    keywords: ["help", "hotkeys", "bindings"] },
  { id: "app.about",          group: "App",    label: "About",               keywords: ["version"] },
];

// Pre-build haystack strings for fast filtering. Includes id so domain searches
// like "arch" or "view.iso" resolve too, plus keywords for synonyms.
for (const c of COMMANDS) {
  const parts = [c.id, c.group ?? "", c.label];
  if (c.keywords) parts.push(c.keywords.join(" "));
  c.haystack = parts.join(" ").toLowerCase();
}

type PaletteState = {
  overlay: HTMLDivElement;
  input: HTMLInputElement;
  list: HTMLDivElement;
  filtered: Command[];
  highlighted: number;
};

let state: PaletteState | null = null;

function executeCommand(cmd: Command) {
  // Per-feature handlers will hook on these IDs in their own sub-tasks. For
  // #179 we just dispatch a CustomEvent so other modules can listen without
  // tight coupling, plus a console.debug for visibility while the rest is
  // being built out.
  console.debug(`[palette] execute: ${cmd.id} (${cmd.group} → ${cmd.label})`);
  window.dispatchEvent(new CustomEvent("gemma:command", { detail: cmd }));

  // A tiny built-in: theme toggle, since the shell already owns it via #171.
  // Vellum (day) is the canonical default — blueprint (night) is the toggle.
  // Fall back to "day" when data-mode isn't set so the first toggle goes to
  // blueprint, not back to itself.
  if (cmd.id === "app.toggleTheme") {
    const cur = (document.documentElement.getAttribute("data-mode") as "day" | "night" | null) ?? "day";
    const next = cur === "day" ? "night" : "day";
    document.documentElement.setAttribute("data-mode", next);
    try { localStorage.setItem("gemma-architect.theme", next); } catch { /* ignore */ }
  }
  if (cmd.id === "app.reload") {
    window.location.reload();
  }
}

function filterCommands(query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return COMMANDS;
  // Substring match across `<group> <label>`. Cheap, predictable, no fuzzy
  // surprises for a CAD audience that knows what they're looking for.
  return COMMANDS.filter((c) => c.haystack!.includes(q));
}

function renderList(s: PaletteState) {
  s.list.innerHTML = "";
  if (s.filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pl-empty";
    empty.textContent = "No matches";
    s.list.appendChild(empty);
    return;
  }
  let lastGroup: string | undefined;
  s.filtered.forEach((cmd, idx) => {
    if (cmd.group && cmd.group !== lastGroup) {
      const groupEl = document.createElement("div");
      groupEl.className = "pl-group";
      groupEl.textContent = cmd.group;
      s.list.appendChild(groupEl);
      lastGroup = cmd.group;
    }
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pl-row";
    row.dataset.idx = String(idx);
    if (idx === s.highlighted) row.setAttribute("aria-selected", "true");
    const label = document.createElement("span");
    label.className = "pl-row-label";
    label.textContent = cmd.label;
    row.appendChild(label);
    if (cmd.shortcut) {
      const sc = document.createElement("span");
      sc.className = "pl-row-shortcut";
      sc.textContent = cmd.shortcut;
      row.appendChild(sc);
    }
    row.addEventListener("click", () => {
      executeCommand(cmd);
      close();
    });
    row.addEventListener("mousemove", () => {
      if (s.highlighted !== idx) {
        s.highlighted = idx;
        updateHighlight(s);
      }
    });
    s.list.appendChild(row);
  });
}

function updateHighlight(s: PaletteState) {
  const rows = s.list.querySelectorAll<HTMLElement>(".pl-row");
  rows.forEach((row) => {
    const idx = Number(row.dataset.idx);
    row.setAttribute("aria-selected", idx === s.highlighted ? "true" : "false");
    if (idx === s.highlighted) {
      row.scrollIntoView({ block: "nearest" });
    }
  });
}

function open() {
  if (state) return; // idempotent
  const overlay = document.createElement("div");
  overlay.id = "palette-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Command palette");
  overlay.setAttribute("aria-modal", "true");

  const panel = document.createElement("div");
  panel.className = "pl-panel";

  const input = document.createElement("input");
  input.className = "pl-input";
  input.type = "text";
  input.placeholder = "Type a command…";
  input.spellcheck = false;
  input.autocapitalize = "off";
  input.autocomplete = "off";
  panel.appendChild(input);

  const list = document.createElement("div");
  list.className = "pl-list";
  list.setAttribute("role", "listbox");
  panel.appendChild(list);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  state = { overlay, input, list, filtered: COMMANDS.slice(), highlighted: 0 };
  renderList(state);
  // Focus the input on next frame so the focus-ring transition feels smooth.
  requestAnimationFrame(() => input.focus());

  input.addEventListener("input", () => {
    if (!state) return;
    state.filtered = filterCommands(input.value);
    state.highlighted = 0;
    renderList(state);
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
}

function close() {
  if (!state) return;
  state.overlay.remove();
  state = null;
}

function isInputTarget(t: EventTarget | null): boolean {
  if (!t) return false;
  const el = t as HTMLElement;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.isContentEditable === true
  );
}

export function initPalette() {
  // Global keydown router: open on Ctrl+K (or Cmd+K), navigate while open.
  window.addEventListener("keydown", (e) => {
    // Open
    if (!state && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      // Only swallow if not in an editable target — inputs may have their own
      // Ctrl+K (e.g. browser url bar) but our window-level listener still wins.
      // The editable-target gate intentionally matches the menubar pattern.
      if (isInputTarget(e.target)) return;
      e.preventDefault();
      open();
      return;
    }
    if (!state) return;
    // While open: arrow-key nav, Enter to execute, Escape to close.
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (state.filtered.length === 0) return;
      state.highlighted = (state.highlighted + 1) % state.filtered.length;
      updateHighlight(state);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (state.filtered.length === 0) return;
      state.highlighted = (state.highlighted - 1 + state.filtered.length) % state.filtered.length;
      updateHighlight(state);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      state.highlighted = 0;
      updateHighlight(state);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      state.highlighted = Math.max(0, state.filtered.length - 1);
      updateHighlight(state);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = state.filtered[state.highlighted];
      if (cmd) {
        executeCommand(cmd);
        close();
      }
      return;
    }
  });
}
