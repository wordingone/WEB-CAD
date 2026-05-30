// workbench-legacy-chat-input.ts — dock tab content: PROMPT + CONSOLE.
// Graph/history/params/initLiveTabSubscriptions extracted to workbench-skill-graph.ts.
// Extracted from workbench.ts (lines 276–285, 86–109, 2093–2803).

import { iconSVG } from "../ui/icons";
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

// setConsoleMode kept as no-op — console tab removed in #213; callers in cmdk / workbench.ts re-export.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function setConsoleMode(_m: string): void { /* no-op — console tab removed */ }

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

  const header = el("div", "ai-header");
  function renderHeader(): void {
    const suspended = isAgentSessionSuspended();
    header.innerHTML = `
      <div class="ai-title">
        ${iconSVG("sparkle", 13)}
        CREATE  ·  CONVERSATION WITH GEMMA
      </div>
      <button class="vram-pill${suspended ? " vram-pill--suspended" : ""}" id="vram-toggle" type="button"
        title="${suspended ? "Resume agent (re-acquire VRAM)" : "Pause agent to free VRAM"}">
        ${suspended ? "▶ RESUME" : "⏸ SUSPEND"}
      </button>
      <span class="ai-badge" id="ai-model-badge">
        <span class="v">G</span>EMMA·4·E4B  ·  LIVE
      </span>
    `;
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

  const innerHost = el("div", "create-tab-inner");
  innerHost.appendChild(chatRoot);
  wrap.appendChild(innerHost);

  if (promptPane) {
    promptPane.classList.add("prompt-pane-embed");
  }

  const recentList = el("div", "ai-recent-list", { id: "ai-recent-list" });
  wrap.appendChild(recentList);
  renderRecentList(recentList);

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

  // One-shot flag: model loading should start exactly once per page load, not on every
  // tab switch back to "prompt". Without this guard, every re-activation calls
  // checkConsentAndLoad again, which can re-show the consent dialog even after the
  // model is already running (e.g. warm OPFS boot completes before the async cache check).
  let _modelLoadStarted = false;
  function activate(id: string) {
    tabsHost.querySelectorAll(".dock-tab").forEach((t) => {
      const isActive = (t as HTMLElement).dataset.tab === id;
      t.classList.toggle("active", isActive);
    });
    bodyHost.innerHTML = "";
    if (panes[id]) bodyHost.appendChild(panes[id]);
    if (id === "prompt" && !_modelLoadStarted) {
      _modelLoadStarted = true;
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
