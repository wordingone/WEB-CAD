// workbench-legacy-chat-input.ts — dock tab content: PROMPT + CONSOLE.
// Graph/history/params/initLiveTabSubscriptions extracted to workbench-skill-graph.ts.
// Extracted from workbench.ts (lines 276–285, 86–109, 2093–2803).

import { iconSVG } from "../ui/icons";
import { compileDsl } from "../commands/dsl-eval";
import { dispatchSync, type DispatchArgs } from "../commands/dispatch";
import { startCommandSession } from "../commands/command-session";
import { checkConsentAndLoad } from "../agent/model-consent";
import { isCadOnlyMode } from "../agent/boot-screen";
import { ChatPanel } from "../chat/chat-panel";
import {
  prefetchModel, MODEL_ID,
  suppressAgentSession, releaseAgentSession, isAgentSessionSuspended,
} from "../agent/agent-harness";
import {
  listSavedSkills,
  type SavedSkill, type SkillStep,
} from "../skills/skill-store";
import type { Skill } from "../agent/skills-loader";
import { setPickerHint } from "../viewer/picker-hint";
import {
  buildSkillsTabBody, buildHistoryTabBody,
  getCanvasInstance, getActivateNodesCanvas,
} from "./workbench-skill-graph";

function el(tag: string, cls?: string, attrs?: Record<string, string>): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

type DockTab = { id: string; icon: string; label: string };
export const DOCK_TABS: DockTab[] = [
  { id: "prompt",  icon: "sparkle", label: "CREATE" },
  { id: "skills",  icon: "graph",   label: "SKILLS" },
  { id: "history", icon: "history", label: "HISTORY" },
];

// Merged PROMPT/CONSOLE input: one tab, two modes. Shift+Tab toggles.
type ConsoleMode = "prompt" | "console";
const CONSOLE_MODE_LS_KEY = "web-cad:console-mode-v1";
function loadConsoleMode(): ConsoleMode {
  try {
    const v = localStorage.getItem(CONSOLE_MODE_LS_KEY);
    return v === "console" ? "console" : "prompt";
  } catch { return "prompt"; }
}
function saveConsoleMode(m: ConsoleMode): void {
  try { localStorage.setItem(CONSOLE_MODE_LS_KEY, m); } catch {}
}

// Exposed so cmdk can flip the mode without round-tripping through the DOM.
let _setConsoleModeFn: ((m: ConsoleMode) => void) | null = null;
export function setConsoleMode(m: ConsoleMode): void {
  _setConsoleModeFn?.(m);
}

// Module-level chat-panel ref so skillstore:saved can push saved skills into fastpath.
let _chatPanel: InstanceType<typeof ChatPanel> | null = null;

// Push a line into the in-page CONSOLE dock tab. Falls back to console.log when dock isn't mounted.
export function pushConsoleLine(kind: "cmd" | "ok" | "err" | "info", text: string): void {
  const history = document.getElementById("console-history");
  if (!history) {
    console.log(`[console:${kind}] ${text}`);
    return;
  }
  const d = new Date();
  const ts =
    String(d.getHours()).padStart(2, "0") + ":" +
    String(d.getMinutes()).padStart(2, "0") + ":" +
    String(d.getSeconds()).padStart(2, "0");
  const glyph = kind === "cmd" ? "›" : kind === "ok" ? "✓" : kind === "err" ? "✗" : "·";
  const line = document.createElement("div");
  line.className = `console-line ${kind}`;
  line.innerHTML = `<span class="ts"></span><span class="glyph"></span><span class="text"></span>`;
  line.querySelector(".ts")!.textContent = ts;
  line.querySelector(".glyph")!.textContent = glyph;
  line.querySelector(".text")!.textContent = text;
  history.appendChild(line);
  history.scrollTop = history.scrollHeight;
}

// ── Skill helpers (used by workbench.ts coordinator) ──────────────────────────

type _SkillJsonEntry = {
  name: string;
  keywords: string[];
  steps?: Array<{ verb: string; args: Record<string, unknown> }>;
};
const _SKILL_JSON_MODS = import.meta.glob(
  "../skills/*/skill.json",
  { eager: true },
) as Record<string, { default: _SkillJsonEntry } | _SkillJsonEntry>;

export function _buildTimeSkills(): Skill[] {
  const skills = Object.values(_SKILL_JSON_MODS).map((mod) => {
    const json = ("default" in mod ? mod.default : mod) as _SkillJsonEntry;
    return {
      name: json.name,
      version: "0",
      description: json.name.replace(/-/g, " "),
      keywords: json.keywords,
      examples: [],
      eval_id: "",
      body: "",
      steps: json.steps,
    };
  });
  return skills;
}

export function _savedSkillsAsSkills(saved: SavedSkill[]): Skill[] {
  return saved.map((s) => ({
    name: s.name,
    version: "0",
    description: s.description ?? s.name,
    keywords: [...new Set([
      s.name.toLowerCase(),
      ...s.name.toLowerCase().split(/[\s\-_]+/).filter((t) => t.length > 1),
    ])],
    examples: [],
    eval_id: "",
    body: "",
    steps: s.steps,
  }));
}

export async function _refreshChatSkills(): Promise<void> {
  if (!_chatPanel) return;
  const saved = await listSavedSkills().catch(() => [] as SavedSkill[]);
  _chatPanel.setSkills([..._buildTimeSkills(), ..._savedSkillsAsSkills(saved)]);
}

// ── Recent history ─────────────────────────────────────────────────────────────

const RECENT_LS_KEY = "web-cad:recent-v1";
type RecentEntry = { ts: string; label: string };

function loadRecentEntries(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_LS_KEY);
    return raw ? (JSON.parse(raw) as RecentEntry[]) : [];
  } catch { return []; }
}

export function saveRecentEntry(label: string): void {
  const d = new Date();
  const ts = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const entries = loadRecentEntries().filter(e => e.label !== label);
  entries.unshift({ ts, label });
  try { localStorage.setItem(RECENT_LS_KEY, JSON.stringify(entries.slice(0, 5))); } catch {}
  renderRecentList(document.getElementById("ai-recent-list"));
}

function renderRecentList(host: HTMLElement | null): void {
  if (!host) return;
  host.innerHTML = "";
  for (const r of loadRecentEntries()) {
    const line = el("div", "ai-recent");
    const span = document.createElement("span");
    span.className = "ts";
    span.textContent = r.ts;
    line.appendChild(span);
    line.appendChild(document.createTextNode(r.label));
    host.appendChild(line);
  }
}

// ── PROMPT tab body ────────────────────────────────────────────────────────────

export function buildPromptTabBody(promptPane: HTMLElement | null): HTMLElement {
  const wrap = el("div", "tab-body prompt-tab create-tab");

  // §#1637 Tier 4: cad-only mode — don't mount ChatPanel; show AI-disabled notice.
  if (isCadOnlyMode()) {
    wrap.innerHTML = `
      <div class="ai-disabled-notice">
        <p>AI features are disabled. Reload the page and choose a different option from the boot screen to enable them.</p>
        <button class="ai-disabled-reload-btn" type="button" onclick="window.location.reload()">Reload &amp; change settings</button>
      </div>`;
    return wrap;
  }

  let mode = loadConsoleMode();

  const header = el("div", "ai-header");
  function renderHeader(): void {
    const suspended = isAgentSessionSuspended();
    header.innerHTML = `
      <div class="ai-title">
        ${mode === "console" ? iconSVG("terminal", 13) : iconSVG("sparkle", 13)}
        ${mode === "console" ? "CONSOLE  ·  DSL COMMAND INPUT" : "CREATE  ·  CONVERSATION WITH GEMMA"}
      </div>
      <button class="mode-pill" title="Shift+Tab to toggle mode" data-mode="${mode}">
        ${mode === "console" ? "● CONSOLE" : "○ CREATE"}
      </button>
      <button class="vram-pill${suspended ? " vram-pill--suspended" : ""}" id="vram-toggle" type="button"
        title="${suspended ? "Resume agent (re-acquire VRAM)" : "Pause agent to free VRAM"}">
        ${suspended ? "▶ RESUME" : "⏸ SUSPEND"}
      </button>
      <span class="ai-badge" id="ai-model-badge">
        <span class="v">G</span>EMMA·4·E4B  ·  LIVE
      </span>
    `;
    header.querySelector(".mode-pill")?.addEventListener("click", () => {
      setConsoleMode(mode === "console" ? "prompt" : "console");
    });
    header.querySelector("#vram-toggle")?.addEventListener("click", () => {
      if (isAgentSessionSuspended()) releaseAgentSession();
      else suppressAgentSession();
    });
  }
  renderHeader();
  wrap.appendChild(header);

  // Keep vram-toggle label/state in sync whenever the harness suspends or resumes.
  window.addEventListener("agentmodel:session-suspended", (e) => {
    const suspended = (e as CustomEvent<{ suspended: boolean }>).detail.suspended;
    const btn = document.getElementById("vram-toggle") as HTMLButtonElement | null;
    if (!btn) return;
    btn.textContent = suspended ? "▶ RESUME" : "⏸ SUSPEND";
    btn.title = suspended ? "Resume agent (re-acquire VRAM)" : "Pause agent to free VRAM";
    btn.classList.toggle("vram-pill--suspended", suspended);
  });

  const chatRoot = el("div", "chat-panel-root");
  const chatPanel = new ChatPanel(chatRoot);
  _chatPanel = chatPanel;
  void _refreshChatSkills();

  const consolePane = buildConsoleInner();

  const innerHost = el("div", "create-tab-inner");
  innerHost.appendChild(mode === "console" ? consolePane : chatRoot);
  wrap.appendChild(innerHost);

  _setConsoleModeFn = (m: ConsoleMode) => {
    if (m === mode) return;
    mode = m;
    saveConsoleMode(m);
    renderHeader();
    innerHost.innerHTML = "";
    innerHost.appendChild(m === "console" ? consolePane : chatRoot);
  };

  const ac = new AbortController();
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.shiftKey && e.key === "Tab") {
      e.preventDefault();
      setConsoleMode(mode === "console" ? "prompt" : "console");
    }
  }, { signal: ac.signal });
  new MutationObserver(() => {
    if (!wrap.isConnected) ac.abort();
  }).observe(document.body, { childList: true, subtree: true });

  if (promptPane) {
    promptPane.classList.add("prompt-pane-embed");
  }

  const recentList = el("div", "ai-recent-list", { id: "ai-recent-list" });
  wrap.appendChild(recentList);
  renderRecentList(recentList);

  return wrap;
}

// ── CONSOLE inner pane ─────────────────────────────────────────────────────────

function buildConsoleInner(): HTMLElement {
  const wrap = el("div", "console-inner-pane");
  wrap.innerHTML = `
    <div class="console">
      <div class="console-history" id="console-history">
        <div class="console-line info"><span class="ts">00:00:01</span><span class="glyph">·</span><span class="text">OpenCascade WebAssembly initialized</span></div>
        <div class="console-line info"><span class="ts">00:00:01</span><span class="glyph">·</span><span class="text">web-ifc parser ready · IFC4 schema</span></div>
        <div class="console-line ok"><span class="ts">00:00:02</span><span class="glyph">✓</span><span class="text">Gemma 4 E4B-it ready</span></div>
        <div class="console-line info"><span class="ts">00:00:03</span><span class="glyph">·</span><span class="text">DSL ready · type wall|slab|column|box|cut, then ⏎</span></div>
      </div>
      <div class="console-prompt">
        <span class="caret">›</span>
        <input id="console-input" placeholder="DSL — wall (0 0) (5 0) height=3 thickness=0.2     |     column (0 0) height=3 profile=square(0.3)"/>
        <span style="font-family:var(--mono); font-size:9.5px; color:var(--ink-faint); letter-spacing:0.04em;">⏎ run</span>
      </div>
    </div>
  `;

  const input = wrap.querySelector<HTMLInputElement>("#console-input")!;
  const history = wrap.querySelector<HTMLDivElement>("#console-history")!;
  const buffer: string[] = [];
  let bufferIdx = 0;

  function ts(): string {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  }
  function pushLine(kind: "cmd" | "ok" | "err" | "info", text: string) {
    const line = document.createElement("div");
    line.className = `console-line ${kind}`;
    const glyph = kind === "cmd" ? "›" : kind === "ok" ? "✓" : kind === "err" ? "✗" : "·";
    line.innerHTML = `<span class="ts">${ts()}</span><span class="glyph">${glyph}</span><span class="text"></span>`;
    line.querySelector(".text")!.textContent = text;
    history.appendChild(line);
    history.scrollTop = history.scrollHeight;
  }

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.shiftKey && e.key === "Tab") return; // let global handler take it
    if (e.key === "Enter") {
      e.preventDefault();
      const src = input.value.trim();
      if (!src) return;
      buffer.push(src);
      bufferIdx = buffer.length;
      input.value = "";
      pushLine("cmd", src);

      void (async () => {
        const isDeclCmd = src.startsWith(":");
        const dslSrc = isDeclCmd ? src.slice(1).trim() : src;

        if (isDeclCmd) {
          const tokens = dslSrc.split(/\s+/);
          const verb = tokens[0];
          const dispArgs: DispatchArgs = {};
          for (const t of tokens.slice(1)) {
            const eq = t.indexOf("=");
            if (eq > 0) {
              const k = t.slice(0, eq);
              const v = t.slice(eq + 1);
              const n = Number(v);
              dispArgs[k] = Number.isFinite(n) ? n : v;
            }
          }
          const sr = await startCommandSession({ command: verb, parameters: dispArgs, metadata: { source: "console" } });
          if (sr.status === "needs_input") {
            setPickerHint(sr.summary ?? "Click in viewport to place");
            pushLine("info", `${verb} → ${sr.summary ?? "needs_input"}`);
          } else if (sr.status === "success") {
            setPickerHint(null);
            pushLine("ok", `dispatch ${verb} → ok`);
          } else {
            const dr = dispatchSync(verb, dispArgs);
            pushLine(
              dr.ok ? "ok" : (dr.error === "HandlerThrew" || dr.error === "NoHandler" ? "err" : "info"),
              `dispatch ${verb} → ${dr.ok ? dr.canonical! : `${dr.error}${dr.detail ? ": " + dr.detail : ""}`}`,
            );
          }
        }

        const c = compileDsl(dslSrc);
        if (!c.ok) {
          pushLine("err", `line ${c.line}: ${c.message}`);
          return;
        }
        if (c.dispatches && c.dispatches.length > 0) {
          for (const d of c.dispatches) {
            const sr = await startCommandSession({ command: d.verb, parameters: d.args, metadata: { source: "console" } });
            if (sr.status === "needs_input") {
              setPickerHint(sr.summary ?? "Click in viewport to place");
              pushLine("info", `${d.verb} → ${sr.summary ?? "needs_input"}`);
            } else if (sr.status === "success") {
              setPickerHint(null);
              pushLine("ok", `dispatch ${d.verb} → ok`);
            } else {
              const dr = dispatchSync(d.verb, d.args);
              pushLine(
                dr.ok ? "ok" : (dr.error === "HandlerThrew" || dr.error === "NoHandler" ? "err" : "info"),
                `dispatch ${d.verb} → ${dr.ok ? dr.canonical! : `${dr.error}${dr.detail ? ": " + dr.detail : ""}`}`,
              );
            }
          }
        }
        if (c.js) {
          const jsSrc = document.getElementById("js-source") as HTMLTextAreaElement | null;
          const runBtn = document.getElementById("run-btn") as HTMLButtonElement | null;
          if (jsSrc && runBtn) {
            jsSrc.value = c.js;
            jsSrc.dispatchEvent(new Event("input", { bubbles: true }));
            pushLine("info", `compiled · ${c.solids.length} solid${c.solids.length === 1 ? "" : "s"} → kernel`);
            runBtn.click();
          } else {
            pushLine("err", "kernel not ready (no #run-btn / #js-source)");
          }
        }
      })();
    } else if (e.key === "ArrowUp") {
      if (buffer.length === 0) return;
      e.preventDefault();
      bufferIdx = Math.max(0, bufferIdx - 1);
      input.value = buffer[bufferIdx] ?? "";
    } else if (e.key === "ArrowDown") {
      if (buffer.length === 0) return;
      e.preventDefault();
      bufferIdx = Math.min(buffer.length, bufferIdx + 1);
      input.value = buffer[bufferIdx] ?? "";
    }
  });

  return wrap;
}

// ── buildDock (orchestrates the 3 dock tabs) ──────────────────────────────────

export function buildDock(
  tabsHost: HTMLElement,
  bodyHost: HTMLElement,
  promptPane: HTMLElement | null,
  _paramPanel: HTMLElement | null,
  getCreateSequenceFn: () => string[],
  getCapabilityGatePromiseFn: () => Promise<string>,
): void {
  tabsHost.innerHTML = "";

  const panes: Record<string, HTMLElement> = {
    prompt:  buildPromptTabBody(promptPane),
    skills:  buildSkillsTabBody(),
    history: buildHistoryTabBody(),
  };

  const cadOnly = isCadOnlyMode();
  for (const t of DOCK_TABS) {
    const tab = el("div", "dock-tab", { "data-tab": t.id });
    tab.innerHTML = `${iconSVG(t.icon, 11)} ${t.label}`;
    if (t.id === "prompt" && cadOnly) {
      tab.classList.add("dock-tab--disabled");
      tab.setAttribute("aria-disabled", "true");
      tab.setAttribute("title", "AI features unavailable. Reload and choose another option to enable.");
      tab.style.pointerEvents = "none";
      tab.style.opacity = "0.35";
    } else {
      tab.addEventListener("click", () => activate(t.id));
    }
    tabsHost.appendChild(tab);
  }

  const spacer = el("div", "dock-spacer");
  tabsHost.appendChild(spacer);
  const actions = el("div", "dock-actions");
  actions.innerHTML = `
    <button class="vp-icon-btn" type="button" title="Pop out">${iconSVG("export", 11)}</button>
    <button class="vp-icon-btn" type="button" title="Clear">${iconSVG("trash", 11)}</button>
    <button class="vp-icon-btn" type="button" title="Settings">${iconSVG("settings", 11)}</button>
  `;
  tabsHost.appendChild(actions);

  function activate(id: string) {
    tabsHost.querySelectorAll(".dock-tab").forEach((t) => {
      const isActive = (t as HTMLElement).dataset.tab === id;
      t.classList.toggle("active", isActive);
    });
    bodyHost.innerHTML = "";
    if (panes[id]) bodyHost.appendChild(panes[id]);
    if (id === "prompt") {
      void getCapabilityGatePromiseFn().then((path) => {
        if (path === "cad-only" || path === "flags") return;
        const remoteUrl = (import.meta.env as Record<string, string>).VITE_GEMMA_AGENT_URL ?? "";
        if (remoteUrl) {
          prefetchModel();
        } else {
          checkConsentAndLoad(MODEL_ID, () => prefetchModel());
        }
      });
    }
  }
  activate("prompt");

  window.addEventListener("skill:animate", (e) => {
    const { steps } = (e as CustomEvent<{ steps: SkillStep[] }>).detail;
    activate("skills");
    getActivateNodesCanvas()?.();
    void getCanvasInstance()?.runWithAnimation(steps);
  });

  // suppress unused-param lint for getCreateSequenceFn (consumed by initLiveTabSubscriptions in coordinator)
  void (getCreateSequenceFn as unknown);
}
