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

type MenuItem = {
  label: string;
  /** Single-letter access key (Alt+key opens the menu in a real OS). Underlined in the label. */
  key: string;
  items: string[];
};

const MENUS: MenuItem[] = [
  { label: "File",   key: "F", items: ["New", "Open...", "Save", "Save As...", "Export...", "Recent ▸", "Quit"] },
  { label: "Edit",   key: "E", items: ["Undo", "Redo", "Cut", "Copy", "Paste", "Preferences..."] },
  { label: "View",   key: "V", items: ["Top", "Front", "Right", "Iso", "Fit", "Toggle Grid", "Toggle Snap"] },
  { label: "Sketch", key: "S", items: ["Line", "Rectangle", "Circle", "Arc", "Polygon", "Constrain ▸"] },
  { label: "Solid",  key: "O", items: ["Extrude", "Revolve", "Sweep", "Loft", "Boolean ▸", "Fillet", "Chamfer"] },
  { label: "Arch",   key: "A", items: ["Wall", "Floor", "Roof", "Door", "Window", "Stair", "Column"] },
  { label: "Render", key: "R", items: ["Realtime", "Daylight", "Material Library", "Render Region..."] },
  { label: "Window", key: "W", items: ["Single", "Quad", "Horizontal Split", "Vertical Split", "Reset Layout"] },
  { label: "Help",   key: "H", items: ["Keyboard Shortcuts", "Documentation", "Report Issue", "About"] },
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
  for (const menu of MENUS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-btn";
    btn.setAttribute("role", "menuitem");
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.dataset.menu = menu.label.toLowerCase();
    btn.innerHTML = renderMenuLabel(menu.label, menu.key);
    btn.addEventListener("click", () => {
      // Dropdown panels land in the follow-up palette/menu sub-task. For #171
      // we just record that the menu was activated so the structure works
      // end-to-end before the panel implementation lands.
      console.debug(`[shell] menu "${menu.label}" — items: ${menu.items.join(" / ")}`);
    });
    host.appendChild(btn);
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
  if (menubar) buildMenubar(menubar);
  if (modebar) buildModebar(modebar);
  if (ribbonTabs) buildRibbonTabs(ribbonTabs);
  wireThemeToggle();
  wireFpsCounter();
}
