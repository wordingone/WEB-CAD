import type { Viewer } from "./viewer/viewer";
import type { ScenePanel, SceneSummary } from "./scene/scene-panel";
import { openExportDrawer } from "./io/export-drawer";
import { formatLength, unitLabel } from "./units";
import { getOpPhase, getLastOpFinishMs } from "./viewer/op-tool";
import { ptIsCoordInputActive } from "./viewer/transforms";
import { applyDrafting, removeDrafting, isDrafting } from "./geometry/drafting";
import { DEMOS, applyParams, type DemoPrompt, type Param } from "./agent/demo-prompts";
import { levelStore, loadLevelLocks } from "./geometry/levels";
import { SAMPLES } from "./io/sample-files";
import type { WorkerOut } from "./worker";
import { getState } from "./app-state";
import { getLayoutHost, activateMode } from "./shell/modes";
import { exportLayoutAsSvg, exportLayoutAsPdf, exportLayoutAsDwgFallback, exportLayoutAsDxf, addPanel, getPanels } from "./shell/layout";
import { buildIfc, buildIfcScene, ifcRoundTrip, type IfcSceneElement, type IfcLevel } from "./ifc/ifc";
import { canonicalGeometryToIfcNurbsSurfaces, surfaceToIfcNurbs } from "./ifc/canonical-ifc";
import type { Surface } from "./nurbs/nurbs-surfaces";
import { detectFormat, loadMainThreadFormat, buildIfcMesh, buildStepMesh, WORKER_FORMATS, MAIN_THREAD_FORMATS, isSupported, type LoadedScene } from "./io/loader";
import { exportObj, exportGltfJson, exportGlb, exportUsdz, exportStl, export3dm, exportSvg, exportDxf, exportPdf } from "./io/exporters";
import { undo, redo, clearHistory } from "./history";
import { dispatchSync, registerHandler, registerPostDispatch } from "./commands/dispatch";
import {
  createSceneAutosavePayload,
  readSceneAutosavePayload,
  sceneStoreSave,
  sceneStoreLoad,
  sceneStoreClear,
} from "./io/scene-store";
import type { RoofParams } from "./tools/structural";
import { DEFAULT_WALL_HEIGHT, rebuildWallParams, rebuildGroupWallHeight } from "./tools/structural";
import { DEFAULT_DOOR_W, DEFAULT_DOOR_H } from "./tools/dimensions";
import * as THREE from "three";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

export function initDomEvents(viewer: Viewer, scenePanel: ScenePanel): { dispose: () => void } {
  // ── DOM element refs ──────────────────────────────────────────────────────
  const modePromptBtn = $<HTMLButtonElement>("mode-prompt-btn");
  const modeFileBtn = $<HTMLButtonElement>("mode-file-btn");
  const promptPanel = $<HTMLDivElement>("prompt-mode-panel");
  const filePanel = $<HTMLDivElement>("file-mode-panel");
  const promptSelect = $<HTMLSelectElement>("prompt-select");
  const promptText = $<HTMLTextAreaElement>("prompt-text");
  const jsSource = $<HTMLTextAreaElement>("js-source");
  const runBtn = $<HTMLButtonElement>("run-btn");
  const sampleSelect = $<HTMLSelectElement>("sample-select");
  const filePickBtn = $<HTMLButtonElement>("file-pick-btn");
  const fileInput = $<HTMLInputElement>("file-input");
  const fileNameLabel = $<HTMLSpanElement>("file-name");
  const status = $<HTMLDivElement>("status");
  const paramPanel = $<HTMLDivElement>("param-panel");
  const paramSliders = $<HTMLDivElement>("param-sliders");
  const paramCollapseBtn = $<HTMLButtonElement>("param-collapse-btn");
  const dropOverlay = $<HTMLDivElement>("drop-overlay");
  const exportButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".exp-btn"));
  const workbenchEl = document.querySelector(".workbench") as HTMLElement | null;

  function setStatus(msg: string, kind: "ok" | "err" | "info" | "warn" | "" = "") {
    status.textContent = msg;
    status.className = `status${kind ? " " + kind : ""}`;
  }

  // ── paramCollapseBtn ──────────────────────────────────────────────────────
  paramCollapseBtn.addEventListener("click", () => {
    paramPanel.classList.toggle("collapsed");
    const collapsed = paramPanel.classList.contains("collapsed");
    paramCollapseBtn.setAttribute("aria-label", collapsed ? "Expand parameters panel" : "Collapse parameters panel");
  });

  // ── Worker ────────────────────────────────────────────────────────────────
  type Source =
    | { kind: "none" }
    | { kind: "prompt"; demoId: string }
    | { kind: "file"; format: string; filename: string };

  let worker: Worker;
  let nextId = 1;
  let pendingStl: ArrayBuffer | null = null;
  let pendingStep: ArrayBuffer | null = null;
  let currentSource: Source = { kind: "none" };
  type WorkerCallback = (msg: WorkerOut) => void;
  const workerCallbacks = new Map<number, WorkerCallback>();
  let workerReady = false;
  const pendingRuns: Array<() => void> = [];

  (window as any).__worker_recycle_count = 0;

  function spawnWorker(): void {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
      const msg = ev.data;
      if (msg.type === "ready") {
        workerReady = true;
        runBtn.disabled = false;
        setStatus("OpenCascade ready.", "info");
        pendingRuns.forEach((fn) => fn());
        pendingRuns.length = 0;
        initSceneRestore();
        loadLevelLocks();
        return;
      }
      if ("id" in msg) {
        const cb = workerCallbacks.get((msg as any).id);
        if (cb) { workerCallbacks.delete((msg as any).id); cb(msg); return; }
      }
      if (msg.type === "run-error") {
        setStatus(`Error: ${msg.error}`, "err");
        runBtn.disabled = false;
        refreshExportButtons();
        return;
      }
      if (msg.type === "run-ok") {
        viewer.setMesh(msg.mesh, msg.bounds);
        clearHistory();
        pendingStl = msg.stl.byteLength > 0 ? msg.stl : null;
        pendingStep = msg.step?.byteLength > 0 ? msg.step : null;
        currentSource = { kind: "prompt", demoId: currentDemo.id };
        setStatus(`${shortLabel(currentDemo.label)} \xb7 ${formatBounds(msg.bounds)} \xb7 ready to export`, "ok");
        const promptTris = msg.mesh.indices?.length
          ? msg.mesh.indices.length / 3
          : (msg.mesh.vertices?.length ?? 0) / 9;
        scenePanel.update({ format: "replicad", triangles: Math.round(promptTris), filename: shortLabel(currentDemo.label) });
        runBtn.disabled = false;
        refreshExportButtons();
        window.dispatchEvent(new CustomEvent("gemma:run-ok", { detail: { js: jsSource.value, label: shortLabel(currentDemo.label) } }));
      }
    };
  }

  function terminateAndRecycle(): void {
    worker.terminate();
    workerReady = false;
    workerCallbacks.clear();
    (window as any).__worker_recycle_count++;
    spawnWorker();
  }

  spawnWorker();

  // ── Helpers ───────────────────────────────────────────────────────────────
  function formatBounds(b: { min: [number, number, number]; max: [number, number, number] }): string {
    const dx = b.max[0] - b.min[0], dy = b.max[1] - b.min[1], dz = b.max[2] - b.min[2];
    return `${formatLength(dx)} \xd7 ${formatLength(dy)} \xd7 ${formatLength(dz)}`;
  }

  function shortLabel(label: string): string {
    const stripped = label.replace(/^\d+\.\s*/, "").replace(/\s*\(.*\)\s*$/, "").trim();
    return stripped || label;
  }

  // ── Prompt mode ───────────────────────────────────────────────────────────
  DEMOS.forEach((d, i) => {
    const opt = document.createElement("option");
    opt.value = String(i); opt.textContent = d.label;
    promptSelect.appendChild(opt);
  });

  SAMPLES.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.id; opt.textContent = s.label;
    if (s.note) opt.title = s.note;
    sampleSelect.appendChild(opt);
  });

  let currentDemo: DemoPrompt = DEMOS[0];
  let currentParams: Record<string, number> = {};

  function loadDemo(idx: number) {
    currentDemo = DEMOS[idx];
    promptText.value = currentDemo.prompt;
    buildSliders(currentDemo);
    jsSource.value = applyParams(currentDemo.js, currentParams);
  }

  function formatParam(v: number, p: Param): string {
    if (p.step >= 1) return v.toFixed(0);
    if (p.step >= 0.1) return v.toFixed(1);
    return v.toFixed(2);
  }

  function buildSliders(demo: DemoPrompt) {
    paramSliders.innerHTML = "";
    currentParams = {};
    if (!demo.params || demo.params.length === 0) { paramPanel.classList.add("hidden"); return; }
    paramPanel.classList.remove("hidden");
    for (const p of demo.params) {
      currentParams[p.name] = p.default;
      const row = document.createElement("div"); row.className = "slider-row";
      const label = document.createElement("label"); label.textContent = p.label; label.htmlFor = `slider-${p.name}`;
      const valueSpan = document.createElement("span"); valueSpan.className = "value"; valueSpan.textContent = p.default.toString();
      const input = document.createElement("input");
      input.id = `slider-${p.name}`; input.type = "range";
      input.min = String(p.min); input.max = String(p.max); input.step = String(p.step); input.value = String(p.default);
      let timer: number | undefined;
      input.addEventListener("input", () => {
        const v = parseFloat(input.value);
        currentParams[p.name] = v;
        valueSpan.textContent = formatParam(v, p);
        jsSource.value = applyParams(currentDemo.js, currentParams);
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => runJs(jsSource.value), 90);
      });
      row.appendChild(label); row.appendChild(valueSpan); row.appendChild(input);
      paramSliders.appendChild(row);
    }
  }

  function runJs(js: string) {
    const send = () => {
      runBtn.disabled = true;
      refreshExportButtons(true);
      setStatus("Running...", "info");
      worker.postMessage({ type: "run", id: nextId++, js });
    };
    if (workerReady) send();
    else pendingRuns.push(send);
  }

  promptSelect.addEventListener("change", () => { loadDemo(Number(promptSelect.value)); });
  runBtn.addEventListener("click", () => { runJs(jsSource.value); });

  // ── Source mode toggle ────────────────────────────────────────────────────
  function setMode(mode: "prompt" | "file") {
    if (mode === "prompt") {
      modePromptBtn.classList.add("active"); modePromptBtn.setAttribute("aria-selected", "true");
      modeFileBtn.classList.remove("active"); modeFileBtn.setAttribute("aria-selected", "false");
      promptPanel.classList.remove("hidden"); filePanel.classList.add("hidden");
      runBtn.disabled = !workerReady;
    } else {
      modeFileBtn.classList.add("active"); modeFileBtn.setAttribute("aria-selected", "true");
      modePromptBtn.classList.remove("active"); modePromptBtn.setAttribute("aria-selected", "false");
      promptPanel.classList.add("hidden"); filePanel.classList.remove("hidden");
      runBtn.disabled = true; paramPanel.classList.add("hidden");
    }
  }

  modePromptBtn.addEventListener("click", () => setMode("prompt"));
  modeFileBtn.addEventListener("click", () => setMode("file"));

  // ── File-load flow ────────────────────────────────────────────────────────
  async function handleFile(file: File): Promise<void> {
    const fmt = detectFormat(file.name);
    fileNameLabel.textContent = file.name;
    fileNameLabel.classList.remove("muted");
    if (!isSupported(fmt)) {
      setStatus(`Unsupported format: .${fmt} — try .ifc / .glb / .gltf / .obj / .stl / .step`, "err");
      return;
    }
    setStatus(`Reading ${file.name} (${fmt.toUpperCase()})...`, "info");
    const buffer = await file.arrayBuffer();
    if (MAIN_THREAD_FORMATS.has(fmt)) {
      try {
        const scene = await loadMainThreadFormat(buffer, fmt);
        finalizeFileLoad(scene, file.name);
      } catch (e) {
        setStatus(`Failed to parse ${file.name}: ${(e as Error).message}`, "err");
      }
      return;
    }
    if (WORKER_FORMATS.has(fmt)) {
      if (!workerReady) {
        setStatus("Waiting for OpenCascade WASM to finish loading...", "info");
        pendingRuns.push(() => handleFile(file));
        return;
      }
      if (fmt === "ifc") {
        setStatus(`Parsing ${file.name} via web-ifc... (may take a few seconds)`, "info");
        const id = nextId++;
        workerCallbacks.set(id, (msg) => {
          if (msg.type === "load-ifc-ok") {
            buildIfcMesh(msg, file.name).then((scene) => {
              finalizeFileLoad(scene, file.name);
              window.dispatchEvent(new CustomEvent("viewer:ifc-loaded", { detail: { filename: file.name } }));
              dispatchSync("SdZoomExtents", {});
              terminateAndRecycle();
            });
          } else if (msg.type === "load-ifc-error") {
            setStatus(`IFC parse failed: ${msg.error}`, "err");
            terminateAndRecycle();
          }
        });
        worker.postMessage({ type: "load-ifc", id, bytes: buffer }, [buffer]);
      } else if (fmt === "step" || fmt === "stp" || fmt === "iges" || fmt === "igs" || fmt === "brep") {
        setStatus(`Parsing ${file.name} via OpenCascade... (may take a few seconds)`, "info");
        const id = nextId++;
        workerCallbacks.set(id, (msg) => {
          if (msg.type === "load-step-ok") {
            buildStepMesh(msg, file.name, fmt).then((scene) => finalizeFileLoad(scene, file.name));
          } else if (msg.type === "load-step-error") {
            setStatus(`${fmt.toUpperCase()} parse failed: ${msg.error}`, "err");
          }
        });
        worker.postMessage({ type: "load-step", id, bytes: buffer, format: fmt as any }, [buffer]);
      }
    }
  }

  function finalizeFileLoad(scene: LoadedScene, filename: string) {
    viewer.setObject(scene.object, scene.bounds);
    clearHistory();
    pendingStl = null; pendingStep = null;
    currentSource = { kind: "file", format: scene.format, filename };
    setStatus(scene.summary, "ok");
    const summary: SceneSummary = { format: scene.format, triangles: scene.triangles, filename, hierarchy: scene.hierarchy };
    const m = scene.summary.match(/(\d[\d,]*)\s+entit/i);
    if (m) summary.entityCount = parseInt(m[1].replace(/,/g, ""), 10);
    const sm = scene.summary.match(/IFC[24X]+/i);
    if (sm) summary.schema = sm[0].toUpperCase();
    scenePanel.update(summary);
    refreshExportButtons();
  }

  filePickBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { const f = fileInput.files?.[0]; if (f) handleFile(f); });

  window.addEventListener("file:open-ifc", () => {
    let ifcPicker = document.getElementById("ifc-file-picker") as HTMLInputElement | null;
    if (!ifcPicker) {
      ifcPicker = document.createElement("input");
      ifcPicker.type = "file"; ifcPicker.id = "ifc-file-picker"; ifcPicker.accept = ".ifc";
      ifcPicker.style.display = "none"; document.body.appendChild(ifcPicker);
      ifcPicker.addEventListener("change", () => {
        const f = ifcPicker!.files?.[0]; if (f) handleFile(f); ifcPicker!.value = "";
      });
    }
    ifcPicker.click();
  });

  (window as Window & { __importIfcFromUrl?: (url: string) => Promise<void> }).__importIfcFromUrl = async (url: string) => {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url}: HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    await handleFile(new File([buf], url.split("/").pop() ?? "import.ifc"));
  };

  sampleSelect.addEventListener("change", async () => {
    const id = sampleSelect.value; if (!id) return;
    const sample = SAMPLES.find((s) => s.id === id); if (!sample) return;
    setStatus(`Fetching ${sample.label}...`, "info");
    try {
      const resp = await fetch(`./${sample.path}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buffer = await resp.arrayBuffer();
      await handleFile(new File([buffer], sample.path.split("/").pop() ?? "sample", { type: "application/octet-stream" }));
    } catch (e) { setStatus(`Failed to fetch sample: ${(e as Error).message}`, "err"); }
  });

  // ── Drag-drop ─────────────────────────────────────────────────────────────
  let dragDepth = 0;
  function hasFiles(e: DragEvent): boolean { return Array.from(e.dataTransfer?.types ?? []).includes("Files"); }
  window.addEventListener("dragenter", (e) => { e.preventDefault(); if (!hasFiles(e)) return; dragDepth++; dropOverlay.classList.remove("hidden"); });
  window.addEventListener("dragleave", (e) => { e.preventDefault(); if (!hasFiles(e)) return; dragDepth--; if (dragDepth <= 0) { dragDepth = 0; dropOverlay.classList.add("hidden"); } });
  window.addEventListener("dragover", (e) => { e.preventDefault(); });
  window.addEventListener("drop", (e) => {
    e.preventDefault(); dragDepth = 0; dropOverlay.classList.add("hidden");
    const dt = e.dataTransfer; if (!dt || !dt.files || dt.files.length === 0) return;
    const file = dt.files[0];
    if (filePanel.classList.contains("hidden")) setMode("file");
    handleFile(file);
  });

  // ── Export pipeline ───────────────────────────────────────────────────────
  function refreshExportButtons(disabledOverride: boolean = false): void {
    const has = currentSource.kind !== "none";
    for (const btn of exportButtons) {
      const fmt = btn.dataset.fmt; if (!fmt) continue;
      if (disabledOverride || !has) { btn.disabled = true; continue; }
      if (fmt === "step") { btn.disabled = !pendingStep; continue; }
      btn.disabled = false;
    }
  }

  async function handleExport(fmt: string): Promise<void> {
    const is2D = fmt === "svg" || fmt === "pdf" || fmt === "dwg" || fmt === "dxf";
    if (is2D) {
      if (workbenchEl?.dataset.mode !== "layout") activateMode("layout", workbenchEl);
      const host = getLayoutHost();
      if (!host) { setStatus("Layout not initialized.", "warn"); return; }
      if (getPanels(host).length === 0) {
        const S = 480, pad = 20;
        addPanel(host, { x: pad,       y: pad,       w: S, h: S, viewport: "top",         scale: "1:100", title: "PLAN — TOP" });
        addPanel(host, { x: pad+S+pad, y: pad,       w: S, h: S, viewport: "front",       scale: "1:100", title: "ELEVATION — FRONT" });
        addPanel(host, { x: pad,       y: pad+S+pad, w: S, h: S, viewport: "right",       scale: "1:100", title: "ELEVATION — RIGHT" });
        addPanel(host, { x: pad+S+pad, y: pad+S+pad, w: S, h: S, viewport: "perspective", scale: "1:100", title: "3D VIEW" });
      }
      const stem = "sheet";
      try {
        if (fmt === "svg") {
          const text = exportLayoutAsSvg(host);
          (window as unknown as Record<string, unknown>).__lastLayoutSvg = text;
          downloadBlob(new Blob([text], { type: "image/svg+xml" }), `${stem}.svg`);
          setStatus(`Layout SVG \xb7 ${(text.length / 1024).toFixed(1)} KB`, "ok");
        } else if (fmt === "pdf") {
          const buf = await exportLayoutAsPdf(host);
          downloadBlob(new Blob([buf], { type: "application/pdf" }), `${stem}.pdf`);
          setStatus(`Layout PDF \xb7 ${(buf.byteLength / 1024).toFixed(1)} KB`, "ok");
        } else if (fmt === "dxf") {
          const text = exportLayoutAsDxf(host);
          downloadBlob(new Blob([text], { type: "image/vnd.dxf" }), `${stem}.dxf`);
          setStatus(`DXF vector \xb7 ${(text.length / 1024).toFixed(1)} KB`, "ok");
        } else if (fmt === "dwg") {
          const text = exportLayoutAsDwgFallback(host);
          downloadBlob(new Blob([text], { type: "image/vnd.dxf" }), `${stem}.dxf`);
          setStatus(`DXF (LibreDWG-WASM unavailable — SVG sidecar) \xb7 ${(text.length / 1024).toFixed(1)} KB`, "ok");
        }
      } catch (e) {
        console.error("[SdExport] 2D export failed:", e);
        setStatus(`Layout export ${fmt.toUpperCase()} failed: ${(e as Error).message}`, "err");
      }
      return;
    }
    const stem = currentSource.kind === "prompt" ? currentDemo.id
      : currentSource.kind === "file" ? sanitizeStem(currentSource.filename) : "export";
    try {
      if (fmt === "ifc" || fmt === "ifc4") { await exportIfc(stem); return; }
      if (fmt === "stl") {
        if (pendingStl) {
          downloadBlob(new Blob([pendingStl], { type: "model/stl" }), `${stem}.stl`);
          setStatus(`STL \xb7 ${(pendingStl.byteLength / 1024).toFixed(1)} KB`, "ok");
        } else {
          const stlSrc = viewer.getActiveObject() ?? (() => {
            const scene = viewer.getScene();
            const tagged = scene.children.filter(c => c.userData.creator);
            const nodes = tagged.length ? tagged : scene.children.filter(c => c instanceof THREE.Mesh || c instanceof THREE.Group);
            if (!nodes.length) return null;
            if (nodes.length === 1) return nodes[0];
            const g = new THREE.Group(); for (const c of nodes) g.add(c.clone()); return g;
          })();
          if (!stlSrc) { setStatus("No geometry loaded.", "warn"); return; }
          const buf = exportStl(stlSrc, {
            getCanonicalGeometryForObject: (target) => viewer.getCanonicalGeometryForObject(target),
          });
          downloadBlob(new Blob([buf], { type: "model/stl" }), `${stem}.stl`);
          setStatus(`STL \xb7 ${(buf.byteLength / 1024).toFixed(1)} KB`, "ok");
        }
        return;
      }
      let obj: THREE.Object3D | null = viewer.getActiveObject();
      if (!obj) {
        const sceneRoot = viewer.getScene();
        const tagged = sceneRoot.children.filter(c => c.userData.creator);
        const geomNodes = tagged.length ? tagged : sceneRoot.children.filter(c => c instanceof THREE.Mesh || c instanceof THREE.Group);
        if (!geomNodes.length) { setStatus("No geometry loaded.", "warn"); return; }
        if (geomNodes.length === 1) { obj = geomNodes[0]; }
        else { const g = new THREE.Group(); for (const c of geomNodes) g.add(c.clone()); obj = g; }
      }
      setStatus(`Exporting ${fmt.toUpperCase()}...`, "info");
      if (fmt === "obj") {
        const text = exportObj(obj, {
          getCanonicalGeometryForObject: (target) => viewer.getCanonicalGeometryForObject(target),
        }); downloadBlob(new Blob([text], { type: "model/obj" }), `${stem}.obj`);
        setStatus(`OBJ \xb7 ${(text.length / 1024).toFixed(1)} KB`, "ok");
      } else if (fmt === "3dm") {
        setStatus("Exporting 3DM (loading Rhino runtime)…", "info");
        const buf = await export3dm(obj, {
          getCanonicalGeometryForObject: (target) => viewer.getCanonicalGeometryForObject(target),
        });
        downloadBlob(new Blob([buf.buffer as ArrayBuffer], { type: "application/octet-stream" }), `${stem}.3dm`);
        setStatus(`3DM \xb7 ${(buf.byteLength / 1024).toFixed(1)} KB`, "ok");
      } else if (fmt === "dwg") {
        const text = exportDxf(obj, {
          getCanonicalGeometryForObject: (target) => viewer.getCanonicalGeometryForObject(target),
        });
        downloadBlob(new Blob([text], { type: "image/vnd.dxf" }), `${stem}.dxf`);
        setStatus(`DXF (AutoCAD-compatible; true DWG binary not available in browser) \xb7 ${(text.length / 1024).toFixed(1)} KB`, "ok");
      } else if (fmt === "glb") {
        const buf = await exportGlb(obj); downloadBlob(new Blob([buf], { type: "model/gltf-binary" }), `${stem}.glb`);
        setStatus(`GLB \xb7 ${(buf.byteLength / 1024).toFixed(1)} KB`, "ok");
      } else if (fmt === "gltf") {
        const json = await exportGltfJson(obj); downloadBlob(new Blob([json], { type: "model/gltf+json" }), `${stem}.gltf`);
        setStatus(`glTF \xb7 ${(json.length / 1024).toFixed(1)} KB`, "ok");
      } else if (fmt === "usdz") {
        const buf = await exportUsdz(obj);
        downloadBlob(new Blob([buf.buffer as ArrayBuffer], { type: "model/vnd.usdz+zip" }), `${stem}.usdz`);
        setStatus(`USDZ \xb7 ${(buf.byteLength / 1024).toFixed(1)} KB`, "ok");
      } else if (fmt === "svg") {
        const text = exportSvg(obj, {
          getCanonicalGeometryForObject: (target) => viewer.getCanonicalGeometryForObject(target),
        });
        downloadBlob(new Blob([text], { type: "image/svg+xml" }), `${stem}.svg`);
        setStatus(`SVG \xb7 ${(text.length / 1024).toFixed(1)} KB`, "ok");
      } else if (fmt === "dxf") {
        const text = exportDxf(obj, {
          getCanonicalGeometryForObject: (target) => viewer.getCanonicalGeometryForObject(target),
        });
        downloadBlob(new Blob([text], { type: "image/vnd.dxf" }), `${stem}.dxf`);
        setStatus(`DXF \xb7 ${(text.length / 1024).toFixed(1)} KB`, "ok");
      } else if (fmt === "pdf") {
        const buf = exportPdf(obj, {
          getCanonicalGeometryForObject: (target) => viewer.getCanonicalGeometryForObject(target),
        });
        downloadBlob(new Blob([buf.buffer as ArrayBuffer], { type: "application/pdf" }), `${stem}.pdf`);
        setStatus(`PDF \xb7 ${(buf.byteLength / 1024).toFixed(1)} KB`, "ok");
      } else if (fmt === "step") {
        if (pendingStep) {
          downloadBlob(new Blob([pendingStep], { type: "application/step" }), `${stem}.step`);
          setStatus(`STEP \xb7 ${(pendingStep.byteLength / 1024).toFixed(1)} KB`, "ok");
        } else { setStatus("STEP only available for replicad-generated geometry.", "warn"); }
      } else { setStatus(`Unknown export format: ${fmt}`, "err"); }
    } catch (e) {
      console.error("[SdExport] 3D export failed:", e);
      setStatus(`Export ${fmt.toUpperCase()} failed: ${(e as Error).message}`, "err");
    }
  }

  function sanitizeStem(filename: string): string {
    return filename.replace(/\.[a-z0-9]+$/i, "").replace(/[^A-Za-z0-9_\-]+/g, "_") || "export";
  }

  const IFC_SKIP_CREATORS = new Set(["SdRefGrid", "IfcGridLine", "SdLevel", "SdDatum", "SdReferenceLine"]);

  function sceneElementsForExport(): IfcSceneElement[] {
    const elements: IfcSceneElement[] = [];
    const scene = viewer.getScene();
    const tmp = new THREE.Vector3();
    scene.traverse((obj) => {
      const creator = obj.userData.creator as string | undefined;
      if (!creator || IFC_SKIP_CREATORS.has(creator)) return;
      if (obj.parent && obj.parent.userData.creator) return;
      const verts: number[] = [], idx: number[] = [];
      obj.updateMatrixWorld(true);
      obj.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const g = mesh.geometry as THREE.BufferGeometry;
        const pos = g.attributes.position?.array as Float32Array | undefined;
        if (!pos) return;
        const baseIndex = verts.length / 3;
        for (let i = 0; i < pos.length; i += 3) {
          tmp.set(pos[i], pos[i + 1], pos[i + 2]); tmp.applyMatrix4(mesh.matrixWorld);
          verts.push(tmp.x, tmp.y, tmp.z);
        }
        const indexAttr = g.index;
        if (indexAttr) { for (let j = 0; j < indexAttr.array.length; j++) idx.push(indexAttr.array[j] + baseIndex); }
        else { for (let j = 0; j < Math.floor(pos.length / 3); j++) idx.push(baseIndex + j); }
      });
      const sidecarSurface = obj.userData.nurbsSurface as Surface | undefined;
      const canonicalSurfaces = canonicalGeometryToIfcNurbsSurfaces(viewer.getCanonicalGeometryForObject(obj), obj.matrixWorld);
      const sidecarIfcSurface = sidecarSurface ? surfaceToIfcNurbs(sidecarSurface, obj.matrixWorld) : null;
      const nurbsSurfaces = canonicalSurfaces.length > 0
        ? canonicalSurfaces
        : sidecarIfcSurface ? [sidecarIfcSurface] : undefined;
      if (verts.length > 0) elements.push({
        mesh: { vertices: new Float32Array(verts), indices: new Uint32Array(idx) },
        nurbsSurfaces,
        creator, label: creator,
        levelId: obj.userData.levelId as string | undefined,
        dispatchArgs: obj.userData.dispatchArgs as Record<string, unknown> | undefined,
      });
    });
    return elements;
  }

  async function exportIfc(stem: string): Promise<void> {
    setStatus("Building IFC + verifying round-trip via web-ifc...", "info");
    try {
      let bytes: Uint8Array;
      const sceneElements = sceneElementsForExport();
      const exportLevels: IfcLevel[] = levelStore.all().map((l) => ({ levelId: l.id, name: l.name, elevation: l.elevation }));
      const ifcImperial = getState("unitSystem") === "imperial";
      if (sceneElements.length > 0) {
        bytes = buildIfcScene(sceneElements, exportLevels, { imperial: ifcImperial });
      } else {
        const data = viewer.getActiveMeshData();
        if (!data) { setStatus("No geometry to export as IFC.", "warn"); return; }
        const label = currentSource.kind === "prompt" ? currentDemo.label
          : currentSource.kind === "file" ? `Imported ${currentSource.filename}` : "GemmaCad Element";
        bytes = buildIfc({ vertices: data.vertices, indices: data.indices }, label, { imperial: ifcImperial });
      }
      const result = await ifcRoundTrip(bytes);
      if (result.ok) {
        const { wall, slab, column, beam, proxy, total } = result.counts;
        const detail = [wall && `${wall}w`, slab && `${slab}s`, column && `${column}c`, beam && `${beam}b`, proxy && `${proxy}x`].filter(Boolean).join(" ") || "0 elements";
        setStatus(`IFC4 ${(result.byteSize / 1024).toFixed(1)} KB \xb7 ${total} elements (${detail}) \xb7 ${result.schema} OK`, "ok");
      } else {
        setStatus(`IFC built (${(bytes.byteLength / 1024).toFixed(1)} KB) — round-trip skipped: ${result.error}`, "warn");
      }
      downloadBlob(new Blob([new Uint8Array(bytes)], { type: "application/x-step" }), `${stem}.ifc`);
    } catch (e) { setStatus(`IFC build failed: ${(e as Error).message}`, "err"); }
  }

  for (const btn of exportButtons) {
    btn.addEventListener("click", () => { const fmt = btn.dataset.fmt; if (fmt) handleExport(fmt); });
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── SdExport handler (needs handleExport + setStatus from this scope) ─────
  registerHandler("SdExport", (args) => {
    const fmt = args.format as string | undefined;
    if (!fmt) return { error: "format required (ifc|ifc4|glb|gltf|obj|stl|3dm|dwg|step|svg|dxf|pdf|usdz)" };
    if ((window as unknown as { __testMode?: boolean }).__testMode) return { ok: true, format: fmt, testMode: true };
    handleExport(fmt).catch((e) => { console.warn("[SdExport]", e); setStatus(`Export failed: ${String((e as Error)?.message ?? e)}`, "warn"); });
    return { ok: true, format: fmt };
  });

  // ── Inspectors ────────────────────────────────────────────────────────────
  const _roofInspectorEl = ((): HTMLElement => {
    let el = document.getElementById("element-inspector");
    if (!el) {
      el = document.createElement("div"); el.id = "element-inspector";
      el.style.cssText = "display:none;position:fixed;bottom:1rem;right:1rem;background:rgba(20,20,20,0.93);border:1px solid #444;border-radius:6px;padding:10px 14px;min-width:210px;z-index:200;font:13px/1.5 sans-serif;color:#ddd;";
      document.body.appendChild(el);
    }
    return el;
  })();

  let _roofInspectorMeshUuid: string | null = null;
  let _stairInspectorGroupUuid: string | null = null;
  let _doorInspectorMeshUuid: string | null = null;
  let _wallInspectorMeshUuid: string | null = null;

  function _mkInspectorSlider(
    label: string, minM: number, maxM: number, stepM: number, curM: number, unit: string,
    onChange: (metersVal: number) => void,
  ): HTMLElement {
    const isLength = unit === "m";
    const isImperial = isLength && unitLabel() === "ft";
    const FT = 3.28084;
    const toDisp = (m: number) => isImperial ? Math.round(m * FT * 100) / 100 : m;
    const toMeters = (d: number) => isImperial ? d / FT : d;
    const dispUnit = isLength ? unitLabel() : unit;
    const min = toDisp(minM), max = toDisp(maxM), step = Math.round(toDisp(stepM) * 1000) / 1000;
    const cur = toDisp(curM);
    const row = document.createElement("div"); row.style.cssText = "display:flex;align-items:center;gap:6px;margin:4px 0;";
    const lbl = document.createElement("span"); lbl.style.cssText = "min-width:70px;font-size:11px;color:#aaa;"; lbl.textContent = label;
    const val = document.createElement("span"); val.style.cssText = "min-width:36px;text-align:right;font-size:11px;"; val.textContent = `${cur}${dispUnit}`;
    const inp = document.createElement("input");
    inp.type = "range"; inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(cur); inp.style.cssText = "flex:1;";
    inp.addEventListener("input", () => { val.textContent = `${parseFloat(inp.value)}${dispUnit}`; });
    inp.addEventListener("change", () => { onChange(isLength ? toMeters(parseFloat(inp.value)) : parseFloat(inp.value)); });
    row.appendChild(lbl); row.appendChild(val); row.appendChild(inp);
    return row;
  }

  function _inspectorTitle(text: string): HTMLElement {
    const el = document.createElement("div");
    el.style.cssText = "font-size:12px;font-weight:600;margin-bottom:6px;color:#fff;";
    el.textContent = text; return el;
  }

  function _showRoofInspector(mesh: THREE.Mesh): void {
    const p: RoofParams = (mesh.userData.roofParams as RoofParams) ?? { type: "pitched", pitchDeg: 30, overhang: 0.5, thickness: 0.15 };
    _roofInspectorMeshUuid = mesh.uuid;
    const mkSlider = (label: string, key: keyof RoofParams, minM: number, maxM: number, stepM: number, unit: string) => {
      const isLength = unit === "m", isImperial = isLength && unitLabel() === "ft", FT = 3.28084;
      const toDisp = (m: number) => isImperial ? Math.round(m * FT * 100) / 100 : m;
      const toMeters = (d: number) => isImperial ? d / FT : d;
      const dispUnit = isLength ? unitLabel() : unit;
      const min = toDisp(minM), max = toDisp(maxM), step = Math.round(toDisp(stepM) * 1000) / 1000;
      const row = document.createElement("div"); row.style.cssText = "display:flex;align-items:center;gap:6px;margin:4px 0;";
      const lbl = document.createElement("span"); lbl.style.cssText = "min-width:70px;font-size:11px;color:#aaa;"; lbl.textContent = label;
      const val = document.createElement("span"); val.style.cssText = "min-width:32px;text-align:right;font-size:11px;";
      const curM = (p[key] as number) ?? (key === "pitchDeg" ? 30 : key === "overhang" ? 0.5 : 0.15);
      const cur = toDisp(curM); val.textContent = `${cur}${dispUnit}`;
      const inp = document.createElement("input");
      inp.type = "range"; inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(cur); inp.style.cssText = "flex:1;";
      inp.addEventListener("input", () => { val.textContent = `${parseFloat(inp.value)}${dispUnit}`; });
      inp.addEventListener("change", () => {
        const dispVal = parseFloat(inp.value), metersVal = isLength ? toMeters(dispVal) : dispVal;
        const updated: Record<string, unknown> = { ...p, [key]: metersVal };
        const existing = viewer.getScene().getObjectByProperty("uuid", _roofInspectorMeshUuid ?? "");
        if (!existing) return;
        const dispArgs = (existing.userData.dispatchArgs as Record<string, unknown>) ?? {};
        dispatchSync("SdRoof", { ...dispArgs, roofType: updated.type as string, pitchDeg: updated.pitchDeg as number, overhang: updated.overhang as number, thickness: updated.thickness as number });
        const stillOld = viewer.getScene().getObjectByProperty("uuid", _roofInspectorMeshUuid ?? "");
        if (stillOld) viewer.removeObject(stillOld);
      });
      row.appendChild(lbl); row.appendChild(val); row.appendChild(inp); return row;
    };
    const typeMap: Array<[RoofParams["type"], string]> = [["pitched", "Gable"], ["hip", "Hip"], ["shed", "Shed"], ["flat", "Flat"]];
    const typeRow = document.createElement("div"); typeRow.style.cssText = "margin:2px 0 6px;";
    const typeLbl = document.createElement("span"); typeLbl.style.cssText = "font-size:11px;color:#aaa;margin-right:6px;"; typeLbl.textContent = "Type";
    const typeSel = document.createElement("select"); typeSel.style.cssText = "background:#333;color:#ddd;border:1px solid #555;border-radius:3px;padding:1px 4px;font-size:12px;";
    for (const [val, lbl] of typeMap) {
      const opt = document.createElement("option"); opt.value = val ?? ""; opt.textContent = lbl;
      if (val === p.type) opt.selected = true; typeSel.appendChild(opt);
    }
    typeSel.addEventListener("change", () => { (p as Record<string, unknown>).type = typeSel.value; });
    typeRow.appendChild(typeLbl); typeRow.appendChild(typeSel);
    _roofInspectorEl.innerHTML = "";
    const title = document.createElement("div"); title.style.cssText = "font-size:12px;font-weight:600;margin-bottom:6px;color:#fff;"; title.textContent = "Roof";
    _roofInspectorEl.appendChild(title); _roofInspectorEl.appendChild(typeRow);
    _roofInspectorEl.appendChild(mkSlider("Pitch", "pitchDeg", 5, 70, 5, "\xb0"));
    _roofInspectorEl.appendChild(mkSlider("Overhang", "overhang", 0, 2, 0.1, "m"));
    _roofInspectorEl.appendChild(mkSlider("Thickness", "thickness", 0.05, 0.5, 0.05, "m"));
    _roofInspectorEl.style.display = "";
  }

  function _showStairInspector(group: THREE.Object3D): void {
    const sp = group.userData.stairParams as { actualRiser: number; actualTread: number; nRisers: number; totalRise: number } | undefined;
    _stairInspectorGroupUuid = group.uuid; _roofInspectorMeshUuid = null;
    _roofInspectorEl.innerHTML = ""; _roofInspectorEl.appendChild(_inspectorTitle("Stair"));
    if (sp) {
      const info = document.createElement("div"); info.style.cssText = "padding:2px 8px 4px; font-size:10px; color:var(--ink-dim);";
      info.textContent = `${sp.nRisers} steps \xb7 rise ${(sp.totalRise * 1000 | 0) / 1000}m`;
      _roofInspectorEl.appendChild(info);
    }
    _roofInspectorEl.appendChild(_mkInspectorSlider("Riser", 0.10, 0.20, 0.005, sp?.actualRiser ?? 0.1778, "m", (v) => {
      const cur = viewer.getScene().getObjectByProperty("uuid", _stairInspectorGroupUuid ?? ""); if (!cur) return;
      const da = (cur.userData.dispatchArgs as Record<string, unknown>) ?? {};
      const params = cur.userData.stairParams as { actualRiser: number; actualTread: number } | undefined;
      dispatchSync("SdStair", { ...da, riser: v, tread: params?.actualTread ?? 0.2794 }); viewer.removeObject(cur);
    }));
    _roofInspectorEl.appendChild(_mkInspectorSlider("Tread", 0.254, 0.356, 0.005, sp?.actualTread ?? 0.2794, "m", (v) => {
      const cur = viewer.getScene().getObjectByProperty("uuid", _stairInspectorGroupUuid ?? ""); if (!cur) return;
      const da = (cur.userData.dispatchArgs as Record<string, unknown>) ?? {};
      const params = cur.userData.stairParams as { actualRiser: number; actualTread: number } | undefined;
      dispatchSync("SdStair", { ...da, riser: params?.actualRiser ?? 0.1778, tread: v }); viewer.removeObject(cur);
    }));
    _roofInspectorEl.style.display = "";
  }

  function _showDoorInspector(mesh: THREE.Mesh): void {
    _doorInspectorMeshUuid = mesh.uuid; _roofInspectorMeshUuid = null; _stairInspectorGroupUuid = null;
    const curW = (mesh.userData.voidW as number | undefined) ?? DEFAULT_DOOR_W;
    const curH = (mesh.userData.voidH as number | undefined) ?? DEFAULT_DOOR_H;
    _roofInspectorEl.innerHTML = ""; _roofInspectorEl.appendChild(_inspectorTitle("Door"));
    const redispatch = (w: number, h: number) => {
      const cur = viewer.getScene().getObjectByProperty("uuid", _doorInspectorMeshUuid ?? ""); if (!cur) return;
      const da = (cur.userData.dispatchArgs as Record<string, unknown>) ?? {};
      dispatchSync("SdDoor", { ...da, width: w, height: h }); viewer.removeObject(cur);
    };
    let liveW = curW, liveH = curH;
    _roofInspectorEl.appendChild(_mkInspectorSlider("Width",  0.61, 1.22, 0.025, curW, "m", (v) => { liveW = v; redispatch(liveW, liveH); }));
    _roofInspectorEl.appendChild(_mkInspectorSlider("Height", 0.61, 2.44, 0.025, curH, "m", (v) => { liveH = v; redispatch(liveW, liveH); }));
    _roofInspectorEl.style.display = "";
  }

  function _showWallInspector(mesh: THREE.Object3D): void {
    _wallInspectorMeshUuid = mesh.uuid; _roofInspectorMeshUuid = null; _stairInspectorGroupUuid = null; _doorInspectorMeshUuid = null;
    const curH = (mesh.userData.wallHeight as number | undefined) ?? DEFAULT_WALL_HEIGHT;
    _roofInspectorEl.innerHTML = ""; _roofInspectorEl.appendChild(_inspectorTitle("Wall"));
    _roofInspectorEl.appendChild(_mkInspectorSlider("Height", 2.13, 4.27, 0.05, curH, "m", (v) => {
      const cur = viewer.getScene().getObjectByProperty("uuid", _wallInspectorMeshUuid ?? "");
      if (cur instanceof THREE.Group) rebuildGroupWallHeight(cur, v);
      else if (cur instanceof THREE.Mesh) rebuildWallParams(cur, { height: v });
    }));
    _roofInspectorEl.style.display = "";
  }

  function _hideInspector(): void {
    _roofInspectorEl.style.display = "none";
    _roofInspectorMeshUuid = null; _stairInspectorGroupUuid = null; _doorInspectorMeshUuid = null; _wallInspectorMeshUuid = null;
  }

  // ── Window event listeners ────────────────────────────────────────────────
  window.addEventListener("viewer:select", (e) => {
    const uuid = (e as CustomEvent<{ uuid: string | null }>).detail?.uuid;
    if (!uuid) { _hideInspector(); return; }
    const obj = viewer.getScene().getObjectByProperty("uuid", uuid);
    const creator = obj?.userData?.creator as string | undefined;
    if (creator === "roof" && obj instanceof THREE.Mesh) {
      _stairInspectorGroupUuid = null; _doorInspectorMeshUuid = null; _wallInspectorMeshUuid = null;
      _showRoofInspector(obj);
    } else if (creator === "stair") {
      let stairGroup: THREE.Object3D | null = null, cur: THREE.Object3D | null = obj ?? null;
      while (cur) { if (cur.userData?.stairParams) { stairGroup = cur; break; } cur = cur.parent; }
      if (stairGroup) _showStairInspector(stairGroup); else _hideInspector();
    } else if ((creator === "door" || creator === "SdDoor") && obj instanceof THREE.Mesh) {
      _showDoorInspector(obj);
    } else if (creator === "wall" && (obj instanceof THREE.Mesh || obj instanceof THREE.Group)) {
      _showWallInspector(obj);
    } else { _hideInspector(); }
  });

  window.addEventListener("agent:turn-complete", (e) => {
    const verbs = (e as CustomEvent<{ verbs: string[] }>).detail?.verbs;
    if (verbs && verbs.length > 0 && currentSource.kind === "none") {
      currentSource = { kind: "prompt", demoId: currentDemo.id };
      refreshExportButtons();
    }
  });

  document.addEventListener("viewer:isolate-changed", (e) => {
    const cell = document.getElementById("sb-isolate"); if (!cell) return;
    const uuid = (e as CustomEvent<{ uuid: string | null }>).detail?.uuid;
    cell.style.display = uuid ? "" : "none";
  });

  window.addEventListener("sd:status", (e) => {
    const { msg, kind } = (e as CustomEvent<{ msg: string; kind: "ok" | "err" | "info" | "warn" | "" }>).detail;
    setStatus(msg, kind);
  });

  window.addEventListener("keydown", (e) => {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (getOpPhase()) return;
    if (ptIsCoordInputActive()) return;
    if (Date.now() - getLastOpFinishMs() < 300) return;
    switch (e.key) {
      case "1": case "Numpad1": viewer.setView("front"); break;
      case "3": case "Numpad3": viewer.setView("right"); break;
      case "7": case "Numpad7": viewer.setView("top"); break;
      case "9": case "Numpad9": viewer.setView("iso"); break;
      case "5": case "Numpad5": viewer.setView("extents"); break;
      case "f": case "F":       viewer.setView("extents"); break;
      case "d": case "D":       toggleDraftingStyle(); break;
      default: return;
    }
    e.preventDefault();
  });

  window.addEventListener("keydown", (e) => {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
    const mod = e.ctrlKey || e.metaKey; if (!mod) return;
    if (e.key === "z" || e.key === "Z") {
      if (e.shiftKey) { if (redo(viewer)) e.preventDefault(); }
      else { if (undo(viewer)) e.preventDefault(); }
    } else if (e.key === "y" || e.key === "Y") {
      if (redo(viewer)) e.preventDefault();
    } else if (e.shiftKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault(); dispatchSync("selectAll", {});
    }
  });

  function toggleDraftingStyle(): void {
    const root = viewer.getActiveObject(); if (!root) return;
    if (isDrafting(root)) removeDrafting(root); else applyDrafting(root);
  }
  (window as unknown as { __toggleDrafting?: () => void }).__toggleDrafting = toggleDraftingStyle;

  // ── IDB auto-save + restore ───────────────────────────────────────────────
  function _hasUserContent(): boolean {
    return viewer.getScene().children.some((c) => (c as any).userData?.creator && (c as any).userData.creator !== "IfcLevel");
  }

  let _autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let _idbDirty = false;
  const _idbDiag: { dirty: boolean; lastSaveOk: boolean; lastErr: string | null; saveCount: number; failCount: number } =
    { dirty: false, lastSaveOk: false, lastErr: null, saveCount: 0, failCount: 0 };
  (window as unknown as Record<string, unknown>).__idbDiag = _idbDiag;

  function _setDirty(v: boolean, reason: string): void {
    _idbDirty = v; _idbDiag.dirty = v;
    console.debug(`[idb] dirty=${v} (${reason})`);
  }

  function _triggerAutoSave(): void {
    _setDirty(true, "post-dispatch");
    if (_autoSaveTimer !== null) return;
    _autoSaveTimer = setTimeout(async () => {
      _autoSaveTimer = null;
      try {
        const objects = viewer.exportScene();
        if (objects.length > 0) {
          await sceneStoreSave(createSceneAutosavePayload(objects, viewer.exportCanonicalGeometry()));
        } else {
          await sceneStoreClear();
        }
        _idbDiag.saveCount++; _idbDiag.lastSaveOk = true; _idbDiag.lastErr = null;
        _setDirty(false, "autosave-ok");
      } catch (err) {
        _idbDiag.failCount++; _idbDiag.lastSaveOk = false; _idbDiag.lastErr = String(err);
        console.warn("[idb] autosave failed — _idbDirty stays true:", err);
      }
    }, 2000);
  }

  const _NON_MUTATING_VERBS = new Set([
    "setActiveTool", "setActiveLevel", "toggleLayerVisibility", "toggleObjectVisibility",
    "selectObject", "deselectAll", "create_goal", "update_goal", "get_goal", "setCamera", "resetCamera",
  ]);
  registerPostDispatch((canonical) => { if (!_NON_MUTATING_VERBS.has(canonical)) _triggerAutoSave(); });

  setInterval(async () => {
    if (_hasUserContent()) {
      try {
        await sceneStoreSave(createSceneAutosavePayload(viewer.exportScene(), viewer.exportCanonicalGeometry()));
        _idbDiag.saveCount++; _idbDiag.lastSaveOk = true; _idbDiag.lastErr = null;
        _setDirty(false, "heartbeat-ok");
      } catch (err) { _idbDiag.failCount++; _idbDiag.lastErr = String(err); console.warn("[idb] heartbeat save failed:", err); }
    }
  }, 60_000);

  async function initSceneRestore(): Promise<void> {
    try {
      const saved = await sceneStoreLoad();
      const payload = readSceneAutosavePayload(saved);
      if (!payload || payload.objects.length === 0) return;
      if (_hasUserContent()) return;
      const prompt = document.getElementById("restore-prompt") as HTMLElement | null; if (!prompt) return;
      prompt.hidden = false;
      document.getElementById("restore-btn")?.addEventListener("click", async () => {
        prompt.hidden = true;
        try {
          viewer.importCanonicalGeometry(payload.canonicalGeometry);
          viewer.importScene(payload.objects as Parameters<typeof viewer.importScene>[0]);
          await sceneStoreClear();
          setStatus("Session restored.", "ok");
        }
        catch { setStatus("Restore failed.", "err"); }
      }, { once: true });
      document.getElementById("restore-discard-btn")?.addEventListener("click", async () => {
        prompt.hidden = true; await sceneStoreClear().catch(() => {});
      }, { once: true });
    } catch { /* IDB unavailable */ }
  }

  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "e" || e.key === "E")) {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
      e.preventDefault();
      openExportDrawer();
    }
  });

  (window as unknown as Record<string, unknown>).__sceneBeforeunloadHooked = true;
  window.addEventListener("beforeunload", (e: BeforeUnloadEvent) => {
    if (navigator.webdriver === true) return;
    const hasContent = _hasUserContent();
    console.debug(`[beforeunload] dirty=${_idbDirty} hasContent=${hasContent} diag=`, JSON.stringify(_idbDiag));
    if (_idbDirty && hasContent) { e.preventDefault(); e.returnValue = ""; }
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  setStatus("Loading OpenCascade WebAssembly...", "info");
  runBtn.disabled = true;
  refreshExportButtons(true);

  return {
    dispose() { worker.terminate(); },
  };
}

export type DomEventsHandle = ReturnType<typeof initDomEvents>;
