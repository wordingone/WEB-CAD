// Shell chrome — design-handoff #171.
//
// Builds the menubar (9 menus) / modebar (4 modes) / ribbon (6 tabs + body) /
// statusbar wiring on top of the existing prompt-pane + viewer-pane layout.
//
// Behavior in this slice is deliberately minimal:
//   - menubar buttons render the 9 dropdowns by name; click is a no-op log.
//     Menu DROPDOWN PANELS land in a follow-up sub-task (#179 owns Cmd-K +
//     palette + console parser; menus chain off the same dispatch).
//   - modebar tabs visually toggle (single active). Layout switching is #172.
//   - ribbon tabs visually toggle. Toolgroup population is #173+.
//   - statusbar shows current mode label + theme button. FPS counter is wired
//     against the requestAnimationFrame loop; viewer instrumentation is #173.
//   - theme toggle (Ctrl+\, click button) flips html[data-mode] + persists.

type MenuEntry = { label: string; shortcut?: string; separator?: false } | { separator: true };
type MenuItem = {
  label: string;
  /** Single-letter access key (Alt+key opens the menu in a real OS). Underlined in the label. */
  key: string;
  entries: MenuEntry[];
};

const MENUS: MenuItem[] = [
  { label: "File",   key: "F", entries: [
    { label: "New",        shortcut: "Ctrl+N" },
    { label: "Open…",      shortcut: "Ctrl+O" },
    { label: "Save",       shortcut: "Ctrl+S" },
    { label: "Save As…",   shortcut: "Ctrl+Shift+S" },
    { separator: true },
    { label: "Export…",    shortcut: "Ctrl+E" },
    { label: "Recent ▸" },
    { separator: true },
    { label: "Quit",       shortcut: "Ctrl+Q" },
  ]},
  { label: "Edit",   key: "E", entries: [
    { label: "Undo",         shortcut: "Ctrl+Z" },
    { label: "Redo",         shortcut: "Ctrl+Shift+Z" },
    { separator: true },
    { label: "Cut",          shortcut: "Ctrl+X" },
    { label: "Copy",         shortcut: "Ctrl+C" },
    { label: "Paste",        shortcut: "Ctrl+V" },
    { separator: true },
    { label: "Preferences…", shortcut: "Ctrl+," },
  ]},
  { label: "View",   key: "V", entries: [
    { label: "Top",          shortcut: "7" },
    { label: "Front",        shortcut: "1" },
    { label: "Right",        shortcut: "3" },
    { label: "Iso",          shortcut: "9" },
    { label: "Fit",          shortcut: "F" },
    { separator: true },
    { label: "Toggle Grid",  shortcut: "G" },
    { label: "Toggle Snap",  shortcut: "Shift+S" },
  ]},
  { label: "Sketch", key: "S", entries: [
    { label: "Line",       shortcut: "L" },
    { label: "Rectangle",  shortcut: "R" },
    { label: "Circle",     shortcut: "C" },
    { label: "Arc",        shortcut: "A" },
    { label: "Polygon" },
    { separator: true },
    { label: "Constrain ▸" },
  ]},
  { label: "Solid",  key: "O", entries: [
    { label: "Extrude",   shortcut: "E" },
    { label: "Revolve" },
    { label: "Sweep" },
    { label: "Loft" },
    { separator: true },
    { label: "Boolean ▸" },
    { label: "Fillet",    shortcut: "Shift+F" },
    { label: "Chamfer" },
  ]},
  { label: "Arch",   key: "A", entries: [
    { label: "Wall",   shortcut: "W" },
    { label: "Floor",  shortcut: "F" },
    { label: "Roof" },
    { separator: true },
    { label: "Door",   shortcut: "D" },
    { label: "Window" },
    { label: "Stair" },
    { label: "Column" },
  ]},
  { label: "Render", key: "R", entries: [
    { label: "Realtime",         shortcut: "Shift+R" },
    { label: "Daylight" },
    { separator: true },
    { label: "Material Library", shortcut: "M" },
    { label: "Render Region…" },
  ]},
  { label: "Window", key: "W", entries: [
    { label: "Single",            shortcut: "1" },
    { label: "Quad",              shortcut: "2" },
    { label: "Horizontal Split",  shortcut: "3" },
    { label: "Vertical Split",    shortcut: "4" },
    { separator: true },
    { label: "Reset Layout" },
  ]},
  { label: "Help",   key: "H", entries: [
    { label: "Keyboard Shortcuts", shortcut: "?" },
    { label: "Documentation" },
    { label: "Report Issue" },
    { separator: true },
    { label: "About" },
  ]},
];

type ToolGroup = { label: string; tools: string[] };
const TOOL_GROUPS: ToolGroup[] = [
  { label: "TRANSFORM", tools: ["Move", "Rotate", "Scale", "Mirror"] },
  { label: "SKETCH 2D", tools: ["Line", "Rect", "Circle", "Arc", "Poly"] },
  { label: "SOLID",     tools: ["Extrude", "Revolve", "Sweep", "Loft", "Boolean"] },
  { label: "ARCH",      tools: ["Wall", "Floor", "Roof", "Door", "Window", "Stair"] },
  { label: "MEASURE",   tools: ["Distance", "Angle", "Area"] },
];

const MODES = ["Modeling", "Drafting", "Layout", "Research"] as const;
type ModeName = typeof MODES[number];

const RIBBON_TABS = ["MODEL", "DRAFT", "ANALYZE", "RENDER", "ANNOTATE", "SUBMIT"] as const;
type RibbonTab = typeof RIBBON_TABS[number];

const THEME_KEY = "gemma-architect.theme";
type ThemeMode = "day" | "night";

function setTheme(mode: ThemeMode) {
  document.documentElement.setAttribute("data-mode", mode);
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* private mode etc. */ }
}

function loadTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "day" || v === "night") return v;
  } catch { /* ignore */ }
  return "night";
}

/** Render the menu label with the access-key letter underlined (the design has it underlined). */
function renderMenuLabel(label: string, key: string): string {
  const idx = label.toLowerCase().indexOf(key.toLowerCase());
  if (idx < 0) return label;
  return (
    label.slice(0, idx) +
    `<span class="menu-key">${label[idx]}</span>` +
    label.slice(idx + 1)
  );
}

function buildMenubar(host: HTMLElement) {
  host.innerHTML = "";
  let openMenu: HTMLDivElement | null = null;
  let openButton: HTMLButtonElement | null = null;

  function closeOpenMenu() {
    if (openMenu) {
      openMenu.remove();
      openMenu = null;
    }
    if (openButton) {
      openButton.setAttribute("aria-expanded", "false");
      openButton = null;
    }
  }

  function openDropdown(menu: MenuItem, anchor: HTMLButtonElement) {
    closeOpenMenu();
    const panel = document.createElement("div");
    panel.className = "menu-dropdown";
    panel.setAttribute("role", "menu");
    panel.dataset.for = menu.label.toLowerCase();
    for (const entry of menu.entries) {
      if ("separator" in entry && entry.separator) {
        const sep = document.createElement("div");
        sep.className = "menu-sep";
        sep.setAttribute("role", "separator");
        panel.appendChild(sep);
        continue;
      }
      const e = entry as { label: string; shortcut?: string };
      const row = document.createElement("button");
      row.type = "button";
      row.className = "menu-row";
      row.setAttribute("role", "menuitem");
      row.tabIndex = -1;
      const label = document.createElement("span");
      label.className = "menu-row-label";
      label.textContent = e.label;
      row.appendChild(label);
      if (e.shortcut) {
        const sc = document.createElement("span");
        sc.className = "menu-row-shortcut";
        sc.textContent = e.shortcut;
        row.appendChild(sc);
      }
      row.addEventListener("click", () => {
        // Per #171 task scope: actions wire to handlers in per-feature sub-tasks.
        console.debug(`[shell] ${menu.label} → ${e.label}${e.shortcut ? " (" + e.shortcut + ")" : ""}`);
        closeOpenMenu();
      });
      panel.appendChild(row);
    }
    // Position relative to the anchor button.
    const rect = anchor.getBoundingClientRect();
    panel.style.left = `${Math.round(rect.left)}px`;
    panel.style.top = `${Math.round(rect.bottom)}px`;
    document.body.appendChild(panel);
    anchor.setAttribute("aria-expanded", "true");
    openMenu = panel;
    openButton = anchor;
  }

  for (const menu of MENUS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-btn";
    btn.setAttribute("role", "menuitem");
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.dataset.menu = menu.label.toLowerCase();
    btn.innerHTML = renderMenuLabel(menu.label, menu.key);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (openButton === btn) {
        closeOpenMenu();
      } else {
        openDropdown(menu, btn);
      }
    });
    btn.addEventListener("mouseenter", () => {
      // Mouse-enter on adjacent menu while another is open swaps to it (per design spec).
      if (openButton && openButton !== btn) {
        openDropdown(menu, btn);
      }
    });
    host.appendChild(btn);
  }

  // Click-outside closes the dropdown.
  document.addEventListener("click", (e) => {
    if (!openMenu) return;
    const tgt = e.target as Node | null;
    if (tgt && (openMenu.contains(tgt) || openButton?.contains(tgt))) return;
    closeOpenMenu();
  });
  // Escape closes.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openMenu) {
      closeOpenMenu();
    }
  });
}

function buildRibbonBody(host: HTMLElement) {
  host.innerHTML = "";
  for (const group of TOOL_GROUPS) {
    const groupEl = document.createElement("div");
    groupEl.className = "tool-group";
    const groupLabel = document.createElement("div");
    groupLabel.className = "tool-group-label";
    groupLabel.textContent = group.label;
    groupEl.appendChild(groupLabel);
    const tools = document.createElement("div");
    tools.className = "tool-group-tools";
    for (const tool of group.tools) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tool-btn";
      btn.dataset.tool = tool.toLowerCase();
      btn.title = tool;
      btn.textContent = tool;
      tools.appendChild(btn);
    }
    groupEl.appendChild(tools);
    host.appendChild(groupEl);
  }
}

function buildRegistrationMarks() {
  // Ensure marks exist in document.body. Idempotent — skip if already present.
  if (document.getElementById("reg-mark-tl")) return;
  for (const corner of ["tl", "tr", "bl", "br"] as const) {
    const m = document.createElement("div");
    m.id = `reg-mark-${corner}`;
    m.className = `reg-mark reg-${corner}`;
    m.setAttribute("aria-hidden", "true");
    document.body.appendChild(m);
  }
}

function buildModebar(host: HTMLElement, onChange?: (m: ModeName) => void): (m: ModeName) => void {
  host.innerHTML = "";
  const buttons: HTMLButtonElement[] = [];
  for (const mode of MODES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mode-tab";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", mode === MODES[0] ? "true" : "false");
    btn.dataset.mode = mode;
    btn.textContent = mode;
    btn.addEventListener("click", () => activate(mode));
    buttons.push(btn);
    host.appendChild(btn);
  }

  function activate(mode: ModeName) {
    for (const btn of buttons) {
      btn.setAttribute("aria-selected", btn.dataset.mode === mode ? "true" : "false");
    }
    const sbMode = document.getElementById("sb-mode");
    if (sbMode) sbMode.textContent = mode.toUpperCase();
    if (onChange) onChange(mode);
  }
  return activate;
}

function buildRibbonTabs(host: HTMLElement, onChange?: (t: RibbonTab) => void): (t: RibbonTab) => void {
  host.innerHTML = "";
  const buttons: HTMLButtonElement[] = [];
  for (const tab of RIBBON_TABS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ribbon-tab";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", tab === RIBBON_TABS[0] ? "true" : "false");
    btn.dataset.tab = tab;
    btn.textContent = tab;
    btn.addEventListener("click", () => activate(tab));
    buttons.push(btn);
    host.appendChild(btn);
  }

  function activate(tab: RibbonTab) {
    for (const btn of buttons) {
      btn.setAttribute("aria-selected", btn.dataset.tab === tab ? "true" : "false");
    }
    if (onChange) onChange(tab);
  }
  return activate;
}

function wireThemeToggle() {
  setTheme(loadTheme());
  const btn = document.getElementById("theme-toggle");
  btn?.addEventListener("click", () => {
    const cur = (document.documentElement.getAttribute("data-mode") as ThemeMode) ?? "night";
    setTheme(cur === "day" ? "night" : "day");
  });
  window.addEventListener("keydown", (e) => {
    // Ctrl+\ — theme toggle. Skip when the user is editing text so we don't
    // steal a backslash they actually wanted.
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key !== "\\") return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
    e.preventDefault();
    const cur = (document.documentElement.getAttribute("data-mode") as ThemeMode) ?? "night";
    setTheme(cur === "day" ? "night" : "day");
  });
}

function wireFpsCounter() {
  const el = document.getElementById("sb-fps");
  if (!el) return;
  let frames = 0;
  let last = performance.now();
  function tick(now: number) {
    frames++;
    if (now - last >= 1000) {
      const fps = Math.round((frames * 1000) / (now - last));
      el!.textContent = `${fps} fps`;
      frames = 0;
      last = now;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

export function initShellChrome() {
  const menubar = document.getElementById("menubar");
  const modebar = document.getElementById("modebar");
  const ribbonTabs = document.getElementById("ribbon-tabs");
  const ribbonBody = document.getElementById("ribbon-body");
  if (menubar) buildMenubar(menubar);
  if (modebar) buildModebar(modebar);
  if (ribbonTabs) buildRibbonTabs(ribbonTabs);
  if (ribbonBody) buildRibbonBody(ribbonBody);
  buildRegistrationMarks();
  wireThemeToggle();
  wireFpsCounter();
}
