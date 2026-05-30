// workbench-skill-graph.ts — live construction graph, skill nodes, history, parameters.
// Extracted from workbench-legacy-chat-input.ts (lines 429-1117).

import { dispatchSync, registerPostDispatch, type DispatchArgs } from "../commands/dispatch";
import { dispatch } from "../commands/dispatch";
import { formatLength } from "../units";
import {
  listSavedSkills, deleteSkill, listClusters, saveCluster, deleteCluster, listCanvasClusters,
  type SavedSkill, type SkillStep, type SkillCluster,
} from "../skills/skill-store";
import { openSaveSkillModal } from "../skills/skill-modal";
import { SkillCanvas } from "../skills/skill-canvas";
import { setClusterCatalog, setCanvasSkillCatalog } from "../agent/agent-harness";
import * as THREE from "three";

// Suppress unused import lint for value imports.
void (saveCluster as unknown);
void (THREE as unknown);

// ── Live construction graph (SKILL NODES tab) ──────────────────────────────────

const _sessionSteps: SkillStep[] = [];

let _recording = false;
let _recordSteps: Array<{ verb: string; params: Record<string, unknown>; relativeTs: number }> = [];
let _recordStart = 0;
let _recordBtn: HTMLButtonElement | null = null;
let _recordStatus: HTMLSpanElement | null = null;

interface NodeRecord { label: string; verb?: string; args?: Record<string, unknown>; }
const _nodes: NodeRecord[] = [];
let _nodesLastSeqLen = 0;
let _selectedNodeIdx: number | null = null;
let _nodesWrap: HTMLElement | null = null;

const GEOMETRY_OP_RE = /^(Ifc|Sd|sd)/;

function chainToLabel(chain: string): string {
  const m = chain.match(/const (\w+)\s*=\s*([\w.]+)\(/);
  if (m) return `${m[1]} · ${m[2]}`;
  const first = chain.split("\n")[0].slice(0, 60);
  return first || chain.slice(0, 60);
}

function commandToLabel(id: string, args: Record<string, unknown>): string {
  const argStr = Object.entries(args)
    .filter(([k]) => !["canonical", "kernel"].includes(k))
    .map(([k, v]) => `${k}=${typeof v === "number" ? (v as number).toFixed(2) : v}`)
    .slice(0, 3)
    .join(" ");
  return argStr ? `${id} · ${argStr}` : id;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderNodes(): void {
  if (!_nodesWrap) return;
  let list = _nodesWrap.querySelector<HTMLElement>(".nodes-list");
  if (!list) {
    list = document.createElement("div");
    list.className = "nodes-list";
    list.style.cssText = "padding:8px 12px; font-family:var(--mono); font-size:11px; overflow-y:auto; height:100%;";
    _nodesWrap.appendChild(list);
  }
  if (_nodes.length === 0) {
    list.innerHTML = `<div class="empty-hint" style="padding:24px; color:var(--ink-faint);">Empty graph — load a demo or type a prompt.</div>`;
    return;
  }
  list.innerHTML = _nodes.map((n, i) => `
    ${i > 0 ? `<div style="text-align:center; color:var(--ink-faint); font-size:10px; line-height:1.4;">↓</div>` : ""}
    <div class="node-box" data-idx="${i}" style="
      border:1px solid var(--hairline); border-radius:4px; padding:6px 10px;
      margin:2px 0; background:var(--panel-bg); color:var(--ink);
      cursor:pointer; user-select:none;
    " title="${escHtml(n.label)}">${escHtml(n.label)}</div>
  `).join("");
}

let _skillsWrap: HTMLElement | null = null;

async function refreshClusterCatalog(): Promise<void> {
  const clusters = await listClusters().catch(() => [] as SkillCluster[]);
  setClusterCatalog(clusters.map(c => ({ name: c.name, steps: c.steps.length })));
}

async function refreshCanvasSkillCatalog(): Promise<void> {
  const canvasClusters = await listCanvasClusters().catch(() => []);
  const clusterSkills = canvasClusters.map(c => ({
    name: c.name,
    verb: "SdInvokeSkill",
    desc: c.description ?? `${c.nodeCount} node canvas cluster`,
  }));
  setCanvasSkillCatalog(clusterSkills);
}

async function renderSkillNodes(): Promise<void> {
  if (!_skillsWrap) return;
  const [saved, clusters] = await Promise.all([
    listSavedSkills().catch(() => [] as SavedSkill[]),
    listClusters().catch(() => [] as SkillCluster[]),
  ]);
  _skillsWrap.innerHTML = "";

  const sessionHeader = document.createElement("div");
  sessionHeader.className = "skill-nodes-session-header";
  const stepCount = _sessionSteps.filter(s => /^(Ifc|Sd)/.test(s.verb)).length;
  sessionHeader.innerHTML = `
    <span class="skill-nodes-session-label">Session · ${stepCount} step${stepCount === 1 ? "" : "s"}</span>
    <button class="btn btn-sm skill-nodes-save-btn" type="button" ${stepCount === 0 ? "disabled" : ""}>Save as skill</button>
  `;
  const saveBtn = sessionHeader.querySelector<HTMLButtonElement>(".skill-nodes-save-btn")!;
  saveBtn.addEventListener("click", () => {
    const steps = _sessionSteps.filter(s => /^(Ifc|Sd)/.test(s.verb));
    openSaveSkillModal(steps);
  });
  _skillsWrap.appendChild(sessionHeader);

  const liveSection = document.createElement("div");
  liveSection.className = "skill-nodes-live";
  if (_nodes.length === 0) {
    liveSection.innerHTML = `<div class="empty-hint">Empty — run a prompt to build a chain.</div>`;
  } else {
    liveSection.innerHTML = _nodes.map((n, i) => `
      ${i > 0 ? `<div class="skill-nodes-arrow">↓</div>` : ""}
      <div class="node-box${i === _selectedNodeIdx ? " selected" : ""}" data-idx="${i}" title="${escHtml(n.label)}">${escHtml(n.label)}</div>
    `).join("");
  }
  _skillsWrap.appendChild(liveSection);

  if (saved.length > 0) {
    const savedHeader = document.createElement("div");
    savedHeader.className = "skill-nodes-saved-header";
    savedHeader.textContent = `Saved skills (${saved.length})`;
    _skillsWrap.appendChild(savedHeader);

    for (const skill of saved) {
      const card = document.createElement("div");
      card.className = "skill-card";
      card.innerHTML = `
        <div class="skill-card-name">${escHtml(skill.name)}</div>
        ${skill.description ? `<div class="skill-card-desc">${escHtml(skill.description)}</div>` : ""}
        <div class="skill-card-meta">${skill.steps.length} step${skill.steps.length === 1 ? "" : "s"}</div>
        <div class="skill-card-actions">
          <button class="btn btn-sm skill-card-run" type="button">Run</button>
          <button class="btn btn-sm skill-card-delete" type="button">Delete</button>
        </div>
      `;
      card.querySelector<HTMLButtonElement>(".skill-card-run")!.addEventListener("click", async () => {
        for (const step of skill.steps) {
          dispatchSync(step.verb, step.args as DispatchArgs);
          await new Promise(r => setTimeout(r, 50));
        }
      });
      card.querySelector<HTMLButtonElement>(".skill-card-delete")!.addEventListener("click", async () => {
        await deleteSkill(skill.id);
        void renderSkillNodes();
      });
      _skillsWrap.appendChild(card);
    }
  }

  if (clusters.length > 0) {
    const clustersHeader = document.createElement("div");
    clustersHeader.className = "skill-nodes-saved-header";
    clustersHeader.textContent = `Clusters (${clusters.length})`;
    _skillsWrap.appendChild(clustersHeader);

    for (const cluster of clusters) {
      const card = document.createElement("div");
      card.className = "skill-card";
      card.innerHTML = `
        <div class="skill-card-name">${escHtml(cluster.name)}</div>
        <div class="skill-card-meta">${cluster.steps.length} step${cluster.steps.length === 1 ? "" : "s"} · cluster</div>
        <div class="skill-card-actions">
          <button class="btn btn-sm skill-card-run" type="button">Run</button>
          <button class="btn btn-sm skill-card-delete" type="button">Delete</button>
        </div>
      `;
      card.querySelector<HTMLButtonElement>(".skill-card-run")!.addEventListener("click", async () => {
        for (const step of cluster.steps) {
          await dispatch(step.verb, step.params as DispatchArgs);
          await new Promise(r => setTimeout(r, 50));
        }
      });
      card.querySelector<HTMLButtonElement>(".skill-card-delete")!.addEventListener("click", async () => {
        await deleteCluster(cluster.id);
        await refreshClusterCatalog();
        void refreshCanvasSkillCatalog();
        void renderSkillNodes();
      });
      _skillsWrap.appendChild(card);
    }
  }
}

let _canvasInstance: SkillCanvas | null = null;
let _activateNodesCanvas: (() => void) | null = null;

export function getCanvasInstance(): SkillCanvas | null { return _canvasInstance; }
export function getActivateNodesCanvas(): (() => void) | null { return _activateNodesCanvas; }

export function buildSkillsTabBody(): HTMLElement {
  const outer = document.createElement("div");
  outer.className = "tab-body skills-tab";
  outer.style.cssText = "display:flex; flex-direction:row; height:100%; overflow:hidden;";

  const nodesCol = document.createElement("div");
  nodesCol.className = "skills-nodes-col";
  nodesCol.style.cssText = "flex:1; min-width:0; display:flex; flex-direction:column; overflow:hidden;";

  const canvasPane = document.createElement("div");
  canvasPane.style.cssText = "flex:1; overflow:hidden;";
  _skillsWrap = null;
  _canvasInstance = new SkillCanvas(canvasPane);
  _activateNodesCanvas = null;

  _canvasInstance.setNodeSelectHandler((nodeId) => { _renderNodeInspector(nodeId); });

  nodesCol.appendChild(canvasPane);

  const paramsCol = document.createElement("div");
  paramsCol.className = "skills-params-col";
  paramsCol.style.cssText = "width:220px; flex-shrink:0; overflow-y:auto; padding:8px 10px; position:relative;";
  _paramsWrap = paramsCol;

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "sc-inspector-resize";
  resizeHandle.style.cssText = "position:absolute; left:0; top:0; width:5px; height:100%; cursor:col-resize; z-index:2;";
  let _rDragX = 0;
  let _rDragW = 0;
  resizeHandle.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    _rDragX = ev.clientX;
    _rDragW = paramsCol.offsetWidth;
    const onMove = (mv: MouseEvent): void => {
      paramsCol.style.width = `${Math.max(120, Math.min(400, _rDragW - (mv.clientX - _rDragX)))}px`;
    };
    const onUp = (): void => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  paramsCol.appendChild(resizeHandle);

  renderParameters(null);
  window.addEventListener("viewer:select", (rawEv) => {
    const uuid: string | null = (rawEv as CustomEvent<{ uuid: string | null }>).detail?.uuid ?? null;
    renderParameters(uuid);
  });

  outer.appendChild(nodesCol);
  outer.appendChild(paramsCol);
  return outer;
}

function _renderNodeInspector(nodeId: string | null): void {
  if (!_paramsWrap) return;
  if (!nodeId) { renderParameters(null); return; }
  const node = _canvasInstance?.getNode(nodeId);
  if (!node) { renderParameters(null); return; }

  _paramsWrap.innerHTML = "";

  const rh = document.createElement("div");
  rh.className = "sc-inspector-resize";
  rh.style.cssText = "position:absolute; left:0; top:0; width:5px; height:100%; cursor:col-resize; z-index:2;";
  _paramsWrap.appendChild(rh);

  const header = document.createElement("div");
  header.className = "params-header";
  header.textContent = node.skillName ?? node.verb ?? (node.kind === "script" ? "Script" : "Node");
  _paramsWrap.appendChild(header);

  if (node.kind === "script") {
    const ta = document.createElement("textarea");
    ta.style.cssText = "width:100%; min-height:120px; font-family:monospace; font-size:11px; resize:vertical; margin-top:6px; box-sizing:border-box;";
    ta.value = node.scriptSource ?? "";
    ta.spellcheck = false;
    ta.addEventListener("input", () => { _canvasInstance?.updateNodeScript(nodeId, ta.value); });
    _paramsWrap.appendChild(ta);
  } else {
    const steps = node.skillSteps ?? [];
    const countEl = document.createElement("div");
    countEl.style.cssText = "font-size:11px; color:var(--muted); margin:4px 0 8px;";
    countEl.textContent = `${steps.length} step${steps.length === 1 ? "" : "s"}`;
    _paramsWrap.appendChild(countEl);

    steps.slice(0, 12).forEach((step, stepIdx) => {
      const verbRow = document.createElement("div");
      verbRow.className = "params-row";
      verbRow.style.cssText = "font-size:11px; font-weight:600; margin-top:8px; padding-bottom:2px; border-bottom:1px solid var(--border,#333);";
      verbRow.textContent = step.verb;
      _paramsWrap!.appendChild(verbRow);

      const numericArgs = Object.entries(step.args ?? {}).filter(([, v]) => typeof v === "number");
      for (const [key, rawVal] of numericArgs) {
        const val = rawVal as number;
        const absVal = Math.abs(val);
        const rangeMax = absVal < 0.5 ? 10 : Math.max(absVal * 4, 10);
        const rangeMin = -rangeMax;
        const stepSize = rangeMax <= 1 ? 0.01 : rangeMax <= 10 ? 0.1 : 0.5;

        const argRow = document.createElement("div");
        argRow.className = "params-row";
        argRow.style.cssText = "display:grid; grid-template-columns:70px 1fr 50px; align-items:center; gap:4px; margin:3px 0;";

        const label = document.createElement("span");
        label.className = "params-label";
        label.style.cssText = "font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
        label.textContent = key;
        label.title = key;

        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = String(rangeMin);
        slider.max = String(rangeMax);
        slider.step = String(stepSize);
        slider.value = String(val);
        slider.style.cssText = "width:100%; cursor:pointer;";

        const numIn = document.createElement("input");
        numIn.type = "number";
        numIn.value = String(val);
        numIn.step = String(stepSize);
        numIn.style.cssText = "width:100%; font-size:10px; padding:1px 3px; box-sizing:border-box; background:var(--surface2,#1e1e1e); color:var(--fg,#ccc); border:1px solid var(--border,#444);";

        slider.addEventListener("input", () => {
          const v = parseFloat(slider.value);
          numIn.value = String(v);
          _canvasInstance?.updateNodeArg(nodeId, stepIdx, key, v);
        });
        numIn.addEventListener("change", () => {
          const v = parseFloat(numIn.value);
          if (isNaN(v)) return;
          slider.value = String(Math.min(rangeMax, Math.max(rangeMin, v)));
          _canvasInstance?.updateNodeArg(nodeId, stepIdx, key, v);
        });

        argRow.append(label, slider, numIn);
        _paramsWrap!.appendChild(argRow);
      }
      if (numericArgs.length === 0) {
        const noArgs = document.createElement("div");
        noArgs.style.cssText = "font-size:10px; color:var(--muted); margin:2px 0 2px 4px;";
        noArgs.textContent = "(no numeric params)";
        _paramsWrap!.appendChild(noArgs);
      }
    });

    if (steps.length > 12) {
      const more = document.createElement("div");
      more.style.cssText = "font-size:10px; color:var(--muted); margin-top:4px;";
      more.textContent = `…and ${steps.length - 12} more`;
      _paramsWrap.appendChild(more);
    }
  }
}

// ── Live event history (HISTORY tab) ──────────────────────────────────────────

interface HistRecord { ts: string; op: string; args: string; }
const _historyEvents: HistRecord[] = [];
const HISTORY_CAP = 500;
let _historyWrap: HTMLElement | null = null;
let _histSessionStart = 0;

function nowTs(): string {
  const ms = Date.now() - _histSessionStart;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((v) => String(v).padStart(2, "0")).join(":");
}

export function appendHistory(op: string, args: string): void {
  if (_histSessionStart === 0) _histSessionStart = Date.now();
  _historyEvents.push({ ts: nowTs(), op, args: args.slice(0, 80) });
  if (_historyEvents.length > HISTORY_CAP) _historyEvents.shift();
}

let _historyFilter = "";
let _historyListEl: HTMLElement | null = null;

export function renderHistory(): void {
  if (!_historyListEl) return;
  const q = _historyFilter.toLowerCase();
  const visible = _historyEvents.filter((h) =>
    !q || h.op.toLowerCase().includes(q) || h.args.toLowerCase().includes(q),
  );

  if (visible.length === 0) {
    _historyListEl.innerHTML = `<div class="empty-hint">No ops yet — load a demo or type a prompt.</div>`;
    return;
  }

  _historyListEl.innerHTML = "";
  for (const h of visible) {
    const row = document.createElement("div");
    row.className = "history-row";
    row.dataset.op = h.op;
    row.innerHTML = `
      <span class="history-ts">${escHtml(h.ts)}</span>
      <span class="history-op">${escHtml(h.op)}</span>
      <span class="history-args">${escHtml(h.args)}</span>
    `;
    row.addEventListener("click", () => {
      const viewer = (window as unknown as { __viewer?: { getScene(): import("three").Scene; selectObject(o: import("three").Object3D | null): void } }).__viewer;
      if (!viewer) return;
      viewer.getScene().traverse((obj) => {
        if ((obj.userData.dispatchVerb ?? obj.userData.creator) === h.op) {
          viewer.selectObject(obj);
        }
      });
    });
    _historyListEl.appendChild(row);
  }
  _historyListEl.scrollTop = _historyListEl.scrollHeight;
}

export function buildHistoryTabBody(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tab-body history-tab";
  wrap.style.cssText = "display:flex; flex-direction:column; height:100%; overflow:hidden;";
  _historyWrap = wrap;

  const filterBar = document.createElement("div");
  filterBar.className = "history-filter-bar";
  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.placeholder = "Filter ops…";
  filterInput.className = "history-filter-input";
  filterInput.addEventListener("input", () => {
    _historyFilter = filterInput.value;
    renderHistory();
  });
  filterBar.appendChild(filterInput);
  wrap.appendChild(filterBar);

  const list = document.createElement("div");
  list.className = "history-list";
  _historyListEl = list;
  wrap.appendChild(list);

  renderHistory();
  return wrap;
}

// ── Parameter rendering (shared by skills tab and params panel) ───────────────

// Numeric arg slider min/max/step heuristics by suffix.
export function sliderBounds(name: string): [number, number, number] {
  const n = name.toLowerCase();
  if (n.includes("angle") || n.includes("rotation")) return [0, 360, 1];
  if (n.includes("thickness") || n.includes("t")) return [0.01, 2, 0.01];
  if (n.includes("radius") || n.includes("r")) return [0.05, 20, 0.05];
  if (n.includes("height") || n.includes("h")) return [0.1, 20, 0.1];
  return [0.05, 30, 0.05];
}

export function isDimensionKey(name: string): boolean {
  const n = name.toLowerCase();
  return !n.includes("angle") && !n.includes("rotation");
}

export function fmtParam(key: string, v: number): string {
  return isDimensionKey(key) ? formatLength(v) : v.toFixed(2);
}

export function renderNodeParameters(verb: string, args: Record<string, unknown>): void {
  if (!_paramsWrap) return;
  _paramsWrap.innerHTML = "";

  const header = document.createElement("div");
  header.className = "params-header";
  header.textContent = verb;
  _paramsWrap.appendChild(header);

  for (const [key, val] of Object.entries(args)) {
    if (key.startsWith("_") || key === "uuid") continue;
    if (typeof val !== "number" && typeof val !== "string" && typeof val !== "boolean") continue;

    const row = document.createElement("div");
    row.className = "params-row";
    const label = document.createElement("label");
    label.className = "params-label";
    label.textContent = key;

    if (typeof val === "number") {
      const [min, max, step] = sliderBounds(key);
      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "params-slider";
      slider.min = String(min);
      slider.max = String(max);
      slider.step = String(step);
      slider.value = String(val);

      const valueSpan = document.createElement("span");
      valueSpan.className = "params-value";
      valueSpan.textContent = fmtParam(key, val as number);

      slider.addEventListener("input", () => {
        valueSpan.textContent = fmtParam(key, Number(slider.value));
      });

      slider.addEventListener("change", () => {
        const newVal = Number(slider.value);
        const newArgs = { ...args, [key]: newVal };
        if (_selectedNodeIdx !== null && _nodes[_selectedNodeIdx]?.verb === verb) {
          _nodes[_selectedNodeIdx].args = newArgs;
        }
        dispatchSync(verb, newArgs as DispatchArgs);
      });

      row.appendChild(label);
      row.appendChild(slider);
      row.appendChild(valueSpan);
    } else {
      const valEl = document.createElement("span");
      valEl.className = "params-value params-value-static";
      valEl.textContent = String(val);
      row.appendChild(label);
      row.appendChild(valEl);
    }

    _paramsWrap.appendChild(row);
  }
}

let _paramsWrap: HTMLElement | null = null;

export function renderParameters(uuid: string | null): void {
  if (!_paramsWrap) return;
  _paramsWrap.innerHTML = "";

  const viewer = (window as unknown as { __viewer?: { getScene(): THREE.Scene; removeObject(o: THREE.Object3D): boolean } }).__viewer;
  const obj = uuid && viewer ? viewer.getScene().getObjectByProperty("uuid", uuid) : null;
  const dispatchArgs = obj?.userData.dispatchArgs as Record<string, unknown> | undefined;
  const dispatchVerb = (obj?.userData.dispatchVerb ?? obj?.userData.creator) as string | undefined;

  if (!obj) {
    _paramsWrap.innerHTML = `<div class="empty-hint">Select an object to inspect its parameters.</div>`;
    return;
  }

  const header = document.createElement("div");
  header.className = "params-header";
  header.textContent = dispatchVerb ?? obj.name ?? obj.type ?? "Object";
  _paramsWrap.appendChild(header);

  if (!dispatchArgs || !dispatchVerb) {
    const geom = (obj as unknown as { geometry?: { type?: string; attributes?: { position?: { count?: number }; index?: { count?: number } } } }).geometry;
    const mat  = (obj as unknown as { material?: { type?: string; color?: { getHexString?(): string } } }).material;
    const pos  = obj.position;
    const bbox = new THREE.Box3().setFromObject(obj);
    const size = bbox.getSize(new THREE.Vector3());

    const addRow = (label: string, value: string): void => {
      const row = document.createElement("div");
      row.className = "params-row";
      row.innerHTML = `<span class="params-label">${escHtml(label)}</span><span class="params-value params-value-static">${escHtml(value)}</span>`;
      _paramsWrap!.appendChild(row);
    };

    addRow("type", geom?.type ?? obj.type ?? "—");
    if (geom?.attributes?.position?.count !== undefined) addRow("vertices", String(geom.attributes.position.count));
    if (geom?.attributes?.index?.count !== undefined) addRow("triangles", String(Math.floor(geom.attributes.index.count / 3)));
    addRow("bbox", `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`);
    addRow("position", `${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}`);
    if (mat?.type) addRow("material", mat.type);
    if (mat?.color?.getHexString) addRow("color", `#${mat.color.getHexString()}`);
    if (obj.userData.creator) addRow("creator", String(obj.userData.creator));
    return;
  }

  for (const [key, val] of Object.entries(dispatchArgs)) {
    if (key.startsWith("_") || key === "uuid") continue;
    if (typeof val !== "number" && typeof val !== "string" && typeof val !== "boolean") continue;

    const row = document.createElement("div");
    row.className = "params-row";

    const label = document.createElement("label");
    label.className = "params-label";
    label.textContent = key;

    if (typeof val === "number") {
      const [min, max, step] = sliderBounds(key);
      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "params-slider";
      slider.min = String(min);
      slider.max = String(max);
      slider.step = String(step);
      slider.value = String(val);

      const valueSpan = document.createElement("span");
      valueSpan.className = "params-value";
      valueSpan.textContent = fmtParam(key, val);

      slider.addEventListener("input", () => {
        valueSpan.textContent = fmtParam(key, Number(slider.value));
      });

      slider.addEventListener("change", () => {
        if (!viewer || !obj) return;
        const newVal = Number(slider.value);
        const newArgs = { ...(obj.userData.dispatchArgs as Record<string, unknown>), [key]: newVal };
        viewer.removeObject(obj);
        dispatchSync(dispatchVerb, newArgs as DispatchArgs);
      });

      row.appendChild(label);
      row.appendChild(slider);
      row.appendChild(valueSpan);
    } else {
      const valEl = document.createElement("span");
      valEl.className = "params-value params-value-static";
      valEl.textContent = String(val);
      row.appendChild(label);
      row.appendChild(valEl);
    }

    _paramsWrap.appendChild(row);
  }
}

// ── Live event subscription (called from workbench.ts coordinator) ─────────────

export function initLiveTabSubscriptions(
  getCreateSequence: () => string[],
  saveRecentEntryFn: (label: string) => void,
  refreshChatSkillsFn: () => Promise<void>,
): void {
  registerPostDispatch((canonical, args) => {
    if (_recording && /^(Ifc|Sd)/.test(canonical) && canonical !== "SdRunCluster" && canonical !== "SdListClusters") {
      _recordSteps.push({ verb: canonical, params: args as Record<string, unknown>, relativeTs: Date.now() - _recordStart });
    }
  });

  void refreshClusterCatalog();
  void refreshCanvasSkillCatalog();

  window.addEventListener("gemma:run-ok", (rawEv) => {
    const ev = rawEv as CustomEvent<{ js: string; label: string }>;
    const { js, label } = ev.detail;
    _nodes.length = 0;
    _sessionSteps.length = 0;
    _nodesLastSeqLen = 0;
    for (const lbl of jsToNodeLabels(js)) {
      _nodes.push({ label: lbl });
    }
    appendHistory("generate", label);
    saveRecentEntryFn(label);
    void renderSkillNodes();
    renderHistory();
  });

  window.addEventListener("gemma:command", (rawEv) => {
    const ev = rawEv as CustomEvent<{ id: string; args: Record<string, unknown> }>;
    const { id, args } = ev.detail;

    const seq = getCreateSequence();
    for (let i = _nodesLastSeqLen; i < seq.length; i++) {
      _nodes.push({ label: chainToLabel(seq[i]) });
    }
    _nodesLastSeqLen = seq.length;

    if (GEOMETRY_OP_RE.test(id)) {
      _nodes.push({ label: commandToLabel(id, args as Record<string, unknown>), verb: id, args: args as Record<string, unknown> });
      _sessionSteps.push({ verb: id, args: args as Record<string, unknown> });
    }

    const argStr = Object.entries(args as Record<string, unknown>)
      .filter(([k]) => !["canonical", "kernel"].includes(k))
      .map(([k, v]) => `${k}=${typeof v === "number" ? fmtParam(k, v as number) : String(v)}`)
      .slice(0, 4)
      .join(" ");
    appendHistory(id, argStr);

    void renderSkillNodes();
    renderHistory();
  });

  window.addEventListener("skillstore:saved", () => {
    void renderSkillNodes();
    void refreshChatSkillsFn();
  });

  window.addEventListener("skillstore:cluster-saved", () => {
    void refreshCanvasSkillCatalog();
  });

  window.addEventListener("viewer:select", (rawEv) => {
    const uuid: string | null = (rawEv as CustomEvent<{ uuid: string | null }>).detail?.uuid ?? null;
    if (uuid) {
      appendHistory("select", uuid.slice(0, 8) + "…");
      renderHistory();
    }
  });
}

function jsToNodeLabels(js: string): string[] {
  const labels: string[] = [];
  for (const m of js.matchAll(/const (\w+)\s*=\s*([\w.]+)\(/g)) {
    labels.push(`${m[1]} · ${m[2]}`);
  }
  return labels.length > 0 ? labels : js.trim() ? ["geometry · replicad"] : [];
}

// suppress unused-import-style references so TS doesn't complain
void (_recordBtn as unknown);
void (_recordStatus as unknown);
void (_nodesWrap as unknown);
void (_historyWrap as unknown);
void (renderNodes as unknown);
