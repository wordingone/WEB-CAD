// workbench-sidebar.ts — all sidebar tab content + sidebar frame.

import { layerStore, DEFAULT_LAYER_ID } from "../geometry/layers";
import { drawingLayerStore, type DrawingLayer } from "../geometry/drawing-layers";
import { pushCustomAction } from "../history";
import { getState, subscribe as subscribeAppState } from "../app-state";
import { formatLength, formatLengthNum, parseLength, unitLabel } from "../units";
import { levelStore, type Level } from "../geometry/levels";
import * as THREE from "three";
import { subscribe, getSelected, subscribeMulti, getMultiSelected, type Selection } from "../viewer/selection-state";
import { buildSelectionFiltersPanel } from "../scene/scene-panel";
import { buildSnapDock } from "./workbench-panels";
import { rebuildWallParams, rebuildGroupWallHeight } from "../tools/structural";
import { attemptWallCornerJoins } from "../tools/wall-corners";
import { showWallHeightHandle, hideWallHeightHandle } from "../viewer/wall-height-handle";
import { Viewer } from "../viewer/viewer";
import { getNurbsForm, type NurbsSurface as NsNurbsSurface } from "../nurbs/nurbs-surfaces";
import { insertKnotU, insertKnotV, midParamU, midParamV } from "../nurbs/nurbs-surface-algorithms";
import { objectFromCanonicalGeometry } from "../geometry/canonical-display";
import type { CanonicalBrepGeometry } from "../geometry/canonical-geometry";
import type { Brep } from "../nurbs/nurbs-brep";

function el(tag: string, cls?: string, attrs?: Record<string, string>): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

type SidebarTab = { id: string; label: string };
const SIDEBAR_TABS: SidebarTab[] = [
  { id: "scene",   label: "SCENE" },
  { id: "inspect", label: "INSPECT" },
];

function buildSceneTab(scenePanel: HTMLElement | null): HTMLElement {
  const wrap = el("div", "tab-body hier-tab");

  if (!scenePanel) {
    const hint = el("div");
    hint.style.cssText = "padding:8px 10px; font-size:11px; color:var(--ink-faint);";
    hint.textContent = "No scene — drop IFC/GLB or pick a sample.";
    wrap.appendChild(hint);
  }

  function addSubsection(title: string, body: HTMLElement): void {
    const hdr = el("div");
    hdr.style.cssText =
      "display:flex; align-items:center; gap:5px; padding:5px 10px 4px;" +
      " border-top:1px solid var(--hairline-soft); cursor:pointer; user-select:none;";
    const arrow = el("span");
    arrow.textContent = "▾";
    arrow.style.cssText = "font-size:9px; color:var(--ink-faint);";
    const label = el("span");
    label.textContent = title;
    label.style.cssText =
      "font-family:var(--mono); font-size:9px; letter-spacing:0.12em;" +
      " text-transform:uppercase; color:var(--ink-dim); font-weight:600;";
    hdr.appendChild(arrow);
    hdr.appendChild(label);
    let open = true;
    hdr.addEventListener("click", () => {
      open = !open;
      body.style.display = open ? "" : "none";
      arrow.textContent = open ? "▾" : "▸";
    });
    wrap.appendChild(hdr);
    wrap.appendChild(body);
  }

  addSubsection("BUILDING LAYERS", buildLayersTab());
  const refBody = el("div");
  refBody.appendChild(buildLevelsTab());
  refBody.appendChild(build2DLayersTab());
  addSubsection("REFERENCE GEOMETRY", refBody);
  return wrap;
}

function buildInspectTab(): HTMLElement {
  const wrap = el("div", "tab-body props");
  wrap.innerHTML = `
    <div class="props-header">
      <div>
        <div class="props-title">—</div>
        <div class="props-subtitle">no selection</div>
      </div>
    </div>
    <div class="prop-section">
      <div class="prop-section-title">IDENTITY</div>
      <div class="prop-row"><span class="k">Name</span><span class="v" data-field="name">—</span></div>
      <div class="prop-row"><span class="k">Type</span><span class="v" data-field="type">—</span></div>
      <div class="prop-row"><span class="k">Exact</span><span class="v" data-field="exact">—</span></div>
      <div class="prop-row"><span class="k">GUID</span><span class="v" data-field="guid">—</span></div>
      <div class="prop-row"><span class="k">Storey</span><span class="v" data-field="storey">—</span></div>
      <div class="prop-row"><span class="k">Layer</span><span class="v" data-field="layer">—</span></div>
    </div>
    <div class="prop-section" id="transform-section">
      <div class="prop-section-title">TRANSFORM</div>
      <div class="prop-vec3">
        <span class="k">Position</span>
        <span class="axis" data-axis="X">—</span>
        <span class="axis" data-axis="Y">—</span>
        <span class="axis" data-axis="Z">—</span>
      </div>
      <div class="prop-vec3">
        <span class="k">Rotation</span>
        <span class="axis" data-axis="Rx">—</span>
        <span class="axis" data-axis="Ry">—</span>
        <span class="axis" data-axis="Rz">—</span>
      </div>
    </div>
    <div class="prop-section" id="bounds-section">
      <div class="prop-section-title">BOUNDS</div>
      <div class="prop-vec3">
        <span class="k">Size</span>
        <span class="axis" data-axis="dX">—</span>
        <span class="axis" data-axis="dY">—</span>
        <span class="axis" data-axis="dZ">—</span>
      </div>
    </div>
    <div class="prop-section" id="nurbs-surface-section" style="display:none">
      <div class="prop-section-title">NURBS SURFACE</div>
      <div class="prop-row">
        <span class="k">Kind</span><span class="v" id="nurbs-kind">—</span>
      </div>
      <div class="prop-row">
        <span class="k">DegU</span><span class="v" id="nurbs-deg-u" style="width:20px;text-align:right">—</span>
        <span class="k" style="margin-left:10px">DegV</span><span class="v" id="nurbs-deg-v" style="width:20px;text-align:right">—</span>
      </div>
      <div class="prop-row">
        <span class="k">CntU</span>
        <span class="v" style="display:flex;align-items:center;gap:3px">
          <span id="nurbs-cnt-u" style="width:24px;text-align:right">—</span>
          <button id="nurbs-add-u" style="padding:0 5px;font-size:11px;background:var(--paper-2);border:1px solid var(--hairline);border-radius:var(--r-sm);cursor:pointer;color:var(--ink)">+</button>
        </span>
        <span class="k" style="margin-left:10px">CntV</span>
        <span class="v" style="display:flex;align-items:center;gap:3px">
          <span id="nurbs-cnt-v" style="width:24px;text-align:right">—</span>
          <button id="nurbs-add-v" style="padding:0 5px;font-size:11px;background:var(--paper-2);border:1px solid var(--hairline);border-radius:var(--r-sm);cursor:pointer;color:var(--ink)">+</button>
        </span>
      </div>
    </div>
    <div class="prop-section" id="wall-params-section" style="display:none">
      <div class="prop-section-title">WALL PARAMETERS</div>
      <div class="prop-row">
        <span class="k">Thickness</span>
        <span class="v">
          <input type="text" data-wall-field="thickness" style="width:54px"/>
          <span class="unit" data-wall-unit>m</span>
          <input type="range" data-wall-slider="thickness" min="0.05" max="1.0" step="0.01" style="width:60px;accent-color:var(--sanguine)"/>
        </span>
      </div>
      <div class="prop-row">
        <span class="k">Bottom elev.</span>
        <span class="v">
          <input type="text" data-wall-field="bottom" style="width:54px"/>
          <span class="unit" data-wall-unit>m</span>
          <select data-wall-level-select="bottom" style="font-size:9.5px;background:var(--paper-2);border:1px solid var(--hairline);color:var(--ink);border-radius:var(--r-sm);padding:1px 2px"></select>
        </span>
      </div>
      <div class="prop-row">
        <span class="k">Height</span>
        <span class="v">
          <input type="text" data-wall-field="height" style="width:54px"/>
          <span class="unit" data-wall-unit>m</span>
          <input type="range" data-wall-slider="height" min="0.1" max="30" step="0.05" style="width:60px;accent-color:var(--sanguine)"/>
        </span>
      </div>
    </div>
  `;

  function updateInspect(sel: Selection | null): void {
    const title = wrap.querySelector<HTMLElement>(".props-title");
    const subtitle = wrap.querySelector<HTMLElement>(".props-subtitle");
    const runtimeViewer = (window as unknown as { __viewer?: Viewer }).__viewer;
    const canonicalFor = (selection: Selection) => {
      const owner = selection.parent ?? selection.transformTarget ?? selection.object;
      return runtimeViewer?.getCanonicalGeometryForObject(owner)
        ?? runtimeViewer?.getCanonicalGeometryForObject(selection.object);
    };
    const canonicalLabelFor = (selection: Selection): string | null => {
      const record = canonicalFor(selection);
      if (!record) return null;
      if (record.kind === "brep") {
        const shellCount = record.brep.shells.length;
        const faceCount = record.brep.shells.reduce((n, shell) => n + shell.faces.length, 0);
        const edgeCount = record.brep.shells.reduce((n, shell) => n + shell.edges.length, 0);
        const closed = record.brep.shells.length > 0 && record.brep.shells.every((shell) => shell.isClosed);
        return `${closed ? "Closed " : ""}BRep/NURBS polysurface · ${shellCount} shell${shellCount === 1 ? "" : "s"} · ${faceCount} face${faceCount === 1 ? "" : "s"} · ${edgeCount} edge${edgeCount === 1 ? "" : "s"}`;
      }
      if (record.kind === "surface") return `NURBS/analytic surface · ${record.surface.kind}`;
      if (record.kind === "curve") return `NURBS/analytic curve · ${record.curve.kind}`;
      return "Exact point";
    };
    const canonicalIdFor = (selection: Selection): string | null => canonicalFor(selection)?.id ?? null;

    const multi = getMultiSelected();
    if (multi.length > 1) {
      if (title) title.textContent = `${multi.length} components selected`;
      const types = [...new Set(
        multi.map((s) => canonicalLabelFor(s) || (s.object.userData?.ifcClass as string | undefined) || s.topology)
      )].sort().join(", ");
      if (subtitle) subtitle.textContent = types;
      wrap.querySelectorAll<HTMLElement>("[data-field]").forEach((v) => (v.textContent = "—"));
      wrap.querySelectorAll<HTMLElement>(".axis").forEach((a) => (a.textContent = "—"));
      const unionBox = new THREE.Box3();
      for (const s of multi) unionBox.expandByObject(s.object);
      const sizeAxes = wrap.querySelectorAll<HTMLElement>('.prop-vec3:nth-of-type(3) .axis');
      if (isFinite(unionBox.min.x)) {
        const sz = new THREE.Vector3();
        unionBox.getSize(sz);
        if (sizeAxes[0]) sizeAxes[0].textContent = sz.x.toFixed(3);
        if (sizeAxes[1]) sizeAxes[1].textContent = sz.y.toFixed(3);
        if (sizeAxes[2]) sizeAxes[2].textContent = sz.z.toFixed(3);
      }
      const wallMeshes = multi
        .map((s) => s.object as THREE.Object3D)
        .filter((o) => o.userData?.creator === "wall");
      updateWallSection(wallMeshes);
      updateNurbsSection(null);
      if (wallMeshes.length === 1) showWallHeightHandle(wallMeshes[0] as THREE.Mesh | THREE.Group);
      else hideWallHeightHandle();
      return;
    }

    if (!sel) {
      if (title) title.textContent = "—";
      if (subtitle) subtitle.textContent = "no selection";
      wrap.querySelectorAll<HTMLElement>("[data-field]").forEach((v) => (v.textContent = "—"));
      wrap.querySelectorAll<HTMLElement>(".axis").forEach((a) => (a.textContent = "—"));
      updateWallSection([]);
      updateNurbsSection(null);
      hideWallHeightHandle();
      return;
    }
    const obj = sel.object as THREE.Object3D;
    const isBrepSubObject = sel.parent && (sel.topology === "face" || sel.topology === "edge" || sel.topology === "vertex");
    const subObjectLabel = isBrepSubObject
      ? `BRep ${sel.topology}${sel.faceIndex !== undefined ? ` #${sel.faceIndex}` : sel.edgeIndex !== undefined ? ` #${sel.edgeIndex}` : sel.vertexIndex !== undefined ? ` #${sel.vertexIndex}` : ""}`
      : null;
    const ud = (obj.userData ?? {}) as {
      ifcClass?: string;
      guid?: string;
      storeyName?: string;
      layer?: string;
    };
    if (title) title.textContent = subObjectLabel ?? obj.name ?? sel.uuid.slice(0, 8);
    const canonicalLabel = canonicalLabelFor(sel);
    const canonicalId = canonicalIdFor(sel);
    const typeLabel = subObjectLabel ?? canonicalLabel ?? ud.ifcClass ?? sel.topology;
    if (subtitle) subtitle.textContent = subObjectLabel && canonicalLabel ? `${subObjectLabel} · ${canonicalLabel}` : typeLabel;
    const nameEl = wrap.querySelector<HTMLElement>('[data-field="name"]');
    if (nameEl) nameEl.textContent = obj.name || "—";
    const typeEl = wrap.querySelector<HTMLElement>('[data-field="type"]');
    if (typeEl) typeEl.textContent = typeLabel;
    const exactEl = wrap.querySelector<HTMLElement>('[data-field="exact"]');
    if (exactEl) exactEl.textContent = canonicalId ? `${canonicalId} · ${canonicalLabel}` : "—";
    const guidEl = wrap.querySelector<HTMLElement>('[data-field="guid"]');
    if (guidEl) guidEl.textContent = ud.guid || (sel.uuid.slice(0, 16) + "…");
    const storeyEl = wrap.querySelector<HTMLElement>('[data-field="storey"]');
    if (storeyEl) storeyEl.textContent = ud.storeyName || "—";
    const layerEl = wrap.querySelector<HTMLElement>('[data-field="layer"]');
    if (layerEl) layerEl.textContent = ud.layer || ud.ifcClass || "default";
    const box = new THREE.Box3().setFromObject(obj);
    const posAxes = wrap.querySelectorAll<HTMLElement>('.prop-vec3:nth-of-type(1) .axis');
    if (isFinite(box.min.x)) {
      const center = new THREE.Vector3();
      box.getCenter(center);
      if (posAxes[0]) posAxes[0].textContent = formatLength(center.x);
      if (posAxes[1]) posAxes[1].textContent = formatLength(center.y);
      if (posAxes[2]) posAxes[2].textContent = formatLength(center.z);
    } else {
      const pos = new THREE.Vector3();
      obj.getWorldPosition(pos);
      if (posAxes[0]) posAxes[0].textContent = formatLength(pos.x);
      if (posAxes[1]) posAxes[1].textContent = formatLength(pos.y);
      if (posAxes[2]) posAxes[2].textContent = formatLength(pos.z);
    }
    const rotAxes = wrap.querySelectorAll<HTMLElement>('.prop-vec3:nth-of-type(2) .axis');
    {
      const refObj = sel.parent ?? obj;
      const r = refObj.rotation;
      const toDeg = (rad: number) => (rad * 180 / Math.PI).toFixed(1) + "°";
      if (rotAxes[0]) rotAxes[0].textContent = toDeg(r.x);
      if (rotAxes[1]) rotAxes[1].textContent = toDeg(r.y);
      if (rotAxes[2]) rotAxes[2].textContent = toDeg(r.z);
    }
    const sizeAxes = wrap.querySelectorAll<HTMLElement>('.prop-vec3:nth-of-type(3) .axis');
    if (isFinite(box.min.x)) {
      const sz = new THREE.Vector3();
      box.getSize(sz);
      if (sizeAxes[0]) sizeAxes[0].textContent = formatLength(sz.x);
      if (sizeAxes[1]) sizeAxes[1].textContent = formatLength(sz.y);
      if (sizeAxes[2]) sizeAxes[2].textContent = formatLength(sz.z);
    } else {
      sizeAxes.forEach((a) => (a.textContent = "—"));
    }

    if (obj.userData?.creator === "wall") {
      updateWallSection([obj]);
      showWallHeightHandle(obj as THREE.Mesh | THREE.Group);
    } else {
      updateWallSection([]);
      hideWallHeightHandle();
    }
    updateNurbsSection(sel);
  }

  // ── Wall parameters section ────────────────────────────────────────────────
  let _activeWalls: THREE.Object3D[] = [];

  function updateWallSection(walls: THREE.Object3D[]): void {
    const sec = wrap.querySelector<HTMLElement>("#wall-params-section");
    if (!sec) return;
    _activeWalls = walls;
    if (walls.length === 0) {
      sec.style.display = "none";
      return;
    }
    sec.style.display = "";

    const thicknessInput = sec.querySelector<HTMLInputElement>('[data-wall-field="thickness"]');
    const thicknessSlider = sec.querySelector<HTMLInputElement>('[data-wall-slider="thickness"]');
    const heightInput = sec.querySelector<HTMLInputElement>('[data-wall-field="height"]');
    const heightSlider = sec.querySelector<HTMLInputElement>('[data-wall-slider="height"]');
    const bottomInput = sec.querySelector<HTMLInputElement>('[data-wall-field="bottom"]');
    const levelSelect = sec.querySelector<HTMLSelectElement>('[data-wall-level-select="bottom"]');

    const allT = walls.map((m) => (m.userData.wallThickness as number | undefined) ?? 0.2);
    const allH = walls.map((m) => (m.userData.wallHeight as number | undefined) ?? 3);
    const allZ = walls.map((m) => m.position.z);

    const sameT = allT.every((v) => v === allT[0]);
    const sameH = allH.every((v) => v === allH[0]);
    const sameZ = allZ.every((v) => v === allZ[0]);

    const tVal = sameT ? formatLengthNum(allT[0]) : "";
    const hVal = sameH ? formatLengthNum(allH[0]) : "";
    const zVal = sameZ ? formatLengthNum(allZ[0]) : "";
    const uLbl = unitLabel();

    if (thicknessInput) thicknessInput.value = tVal;
    if (thicknessSlider) thicknessSlider.value = sameT ? String(allT[0]) : "";
    if (heightInput) heightInput.value = hVal;
    if (heightSlider) heightSlider.value = sameH ? String(allH[0]) : "";
    if (bottomInput) bottomInput.value = zVal;
    sec.querySelectorAll<HTMLElement>("[data-wall-unit]").forEach((s) => (s.textContent = uLbl));

    if (levelSelect) {
      const levels = levelStore.all();
      levelSelect.innerHTML = '<option value="">manual</option>' +
        levels.map((lv) => `<option value="${lv.elevation}">${lv.name} (${formatLength(lv.elevation)})</option>`).join("");
      levelSelect.value = sameZ ? String(allZ[0]) : "";
    }
  }

  function applyWallParam(field: "thickness" | "height" | "bottom", rawVal: string, alreadyMeters = false): void {
    let val: number | null;
    if (field === "bottom") {
      const bare = parseFloat(rawVal);
      if (!isFinite(bare)) return;
      val = (!alreadyMeters && getState("unitSystem") === "imperial") ? bare * 0.3048 : bare;
    } else {
      val = alreadyMeters ? parseFloat(rawVal) : parseLength(rawVal);
    }
    if (val === null || _activeWalls.length === 0) return;
    for (const m of _activeWalls) {
      if (m instanceof THREE.Group) {
        if (field === "height") rebuildGroupWallHeight(m, Math.max(0.01, val));
        else if (field === "bottom") { m.position.z = val; m.updateMatrixWorld(true); }
      } else if (m instanceof THREE.Mesh) {
        if (field === "thickness") rebuildWallParams(m, { thickness: Math.max(0.01, val) });
        else if (field === "height") rebuildWallParams(m, { height: Math.max(0.01, val) });
        else if (field === "bottom") rebuildWallParams(m, { bottomElevation: val });
      }
    }
    const scene = (window as unknown as { __viewer?: { getScene(): THREE.Scene } }).__viewer?.getScene();
    if (scene) {
      for (const m of _activeWalls) {
        if (m instanceof THREE.Mesh) attemptWallCornerJoins(m, scene);
      }
    }
    updateWallSection(_activeWalls);
  }

  // ── NURBS surface section ──────────────────────────────────────────────────

  // Global face index → {shell, face} lookup (mirrors deformCanonicalBrep convention).
  function _getBrepFace(brep: Brep, globalIdx: number) {
    let count = 0;
    for (let si = 0; si < brep.shells.length; si++) {
      const shell = brep.shells[si];
      for (let fi = 0; fi < shell.faces.length; fi++) {
        if (count === globalIdx) return { face: shell.faces[fi], shellIdx: si, faceIdx: fi };
        count++;
      }
    }
    return null;
  }

  // Current selection state used by + buttons.
  let _nurbsSel: { sel: Selection; record: CanonicalBrepGeometry } | null = null;

  function updateNurbsSection(sel: Selection | null): void {
    const sec = wrap.querySelector<HTMLElement>("#nurbs-surface-section");
    const transformSec = wrap.querySelector<HTMLElement>("#transform-section");
    const boundsSec = wrap.querySelector<HTMLElement>("#bounds-section");
    if (!sec) return;

    const isFaceSub = sel?.topology === "face" && typeof sel.faceIndex === "number" && !!sel.parent;
    if (!isFaceSub || !sel) {
      sec.style.display = "none";
      _nurbsSel = null;
      if (transformSec) transformSec.style.display = "";
      if (boundsSec) boundsSec.style.display = "";
      return;
    }

    const runtimeViewer = (window as unknown as { __viewer?: Viewer }).__viewer;
    const parentObj = sel.parent!;
    const record = runtimeViewer?.getCanonicalGeometryForObject(parentObj);
    if (record?.kind !== "brep") {
      sec.style.display = "none";
      _nurbsSel = null;
      return;
    }

    const hit = _getBrepFace(record.brep, sel.faceIndex!);
    if (!hit) { sec.style.display = "none"; _nurbsSel = null; return; }

    const { form, surface: ns } = getNurbsForm(hit.face.surface);
    _nurbsSel = { sel, record: record as CanonicalBrepGeometry };

    const kindEl = wrap.querySelector<HTMLElement>("#nurbs-kind");
    const degUEl = wrap.querySelector<HTMLElement>("#nurbs-deg-u");
    const degVEl = wrap.querySelector<HTMLElement>("#nurbs-deg-v");
    const cntUEl = wrap.querySelector<HTMLElement>("#nurbs-cnt-u");
    const cntVEl = wrap.querySelector<HTMLElement>("#nurbs-cnt-v");
    const addU = wrap.querySelector<HTMLButtonElement>("#nurbs-add-u");
    const addV = wrap.querySelector<HTMLButtonElement>("#nurbs-add-v");

    if (kindEl) kindEl.textContent = `${hit.face.surface.kind}${form === 2 ? " (approx)" : ""}`;
    if (degUEl) degUEl.textContent = String(ns.order[0] - 1);
    if (degVEl) degVEl.textContent = String(ns.order[1] - 1);
    if (cntUEl) cntUEl.textContent = String(ns.cvCount[0]);
    if (cntVEl) cntVEl.textContent = String(ns.cvCount[1]);
    if (addU) addU.disabled = false;
    if (addV) addV.disabled = false;

    sec.style.display = "";
    // Hide Transform + Bounds sections for face sub-object — they show bbox of the tiny overlay.
    if (transformSec) transformSec.style.display = "none";
    if (boundsSec) boundsSec.style.display = "none";
  }

  function _applyNurbsKnotInsert(dir: "u" | "v"): void {
    if (!_nurbsSel) return;
    const { sel, record } = _nurbsSel;
    const runtimeViewer = (window as unknown as { __viewer?: Viewer }).__viewer;
    if (!runtimeViewer) return;

    const hit = _getBrepFace(record.brep, sel.faceIndex!);
    if (!hit) return;

    let surface = getNurbsForm(hit.face.surface).surface;
    const newSurface: NsNurbsSurface = dir === "u"
      ? insertKnotU(surface, midParamU(surface))
      : insertKnotV(surface, midParamV(surface));

    // Rebuild the BRep with the updated face surface.
    let globalCount = 0;
    const newBrep: Brep = {
      shells: record.brep.shells.map((shell, si) => {
        const localIdx = sel.faceIndex! - globalCount;
        globalCount += shell.faces.length;
        if (si !== hit.shellIdx) return shell;
        return {
          ...shell,
          faces: shell.faces.map((f, fi) =>
            fi === hit.faceIdx ? { ...f, surface: newSurface } : f
          ),
        };
      }),
    };

    const newRecord: CanonicalBrepGeometry = { ...record, brep: newBrep, source: "edit" };
    const store = runtimeViewer.getCanonicalGeometryStore();
    store.upsert(newRecord);
    _nurbsSel = { sel, record: newRecord };

    // Re-tessellate and swap geometry on the parent mesh.
    const parentMesh = sel.parent as THREE.Mesh | undefined;
    if (parentMesh) {
      const newObj = objectFromCanonicalGeometry(newRecord);
      if (newObj instanceof THREE.Mesh) {
        parentMesh.geometry.dispose();
        parentMesh.geometry = newObj.geometry;
        (newObj as THREE.Mesh).geometry = new THREE.BufferGeometry();
      }
    }

    // Refresh the display.
    updateNurbsSection(sel);
  }

  const nurbsSec = wrap.querySelector<HTMLElement>("#nurbs-surface-section");
  nurbsSec?.querySelector<HTMLButtonElement>("#nurbs-add-u")
    ?.addEventListener("click", () => _applyNurbsKnotInsert("u"));
  nurbsSec?.querySelector<HTMLButtonElement>("#nurbs-add-v")
    ?.addEventListener("click", () => _applyNurbsKnotInsert("v"));

  const wallSec = wrap.querySelector<HTMLElement>("#wall-params-section");
  if (wallSec) {
    for (const field of ["thickness", "height"] as const) {
      const inp = wallSec.querySelector<HTMLInputElement>(`[data-wall-field="${field}"]`);
      const sld = wallSec.querySelector<HTMLInputElement>(`[data-wall-slider="${field}"]`);
      inp?.addEventListener("change", (e) => {
        const raw = (e.target as HTMLInputElement).value;
        const meters = parseLength(raw);
        if (meters !== null && sld) sld.value = String(meters);
        applyWallParam(field, raw);
      });
      sld?.addEventListener("input", (e) => {
        const meters = parseFloat((e.target as HTMLInputElement).value);
        if (inp && isFinite(meters)) inp.value = formatLengthNum(meters);
        applyWallParam(field, String(meters), true);
      });
    }
    subscribeAppState("unitSystem", () => updateWallSection(_activeWalls));
    const bottomInp = wallSec.querySelector<HTMLInputElement>('[data-wall-field="bottom"]');
    bottomInp?.addEventListener("change", (e) => applyWallParam("bottom", (e.target as HTMLInputElement).value));
    const levelSel = wallSec.querySelector<HTMLSelectElement>('[data-wall-level-select="bottom"]');
    levelSel?.addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      if (!v) return;
      if (bottomInp) bottomInp.value = v;
      applyWallParam("bottom", v);
    });
  }

  window.addEventListener("wall:params-changed", () => updateWallSection(_activeWalls));

  subscribe(updateInspect);
  subscribeMulti(() => updateInspect(getSelected()));
  updateInspect(getSelected());
  return wrap;
}

function buildLevelsTab(): HTMLElement {
  const wrap = el("div", "tab-body levels-tab");

  function renderRow(lvl: Level, list: HTMLElement) {
    const row = el("div", "level-row");
    row.style.cssText = `display:flex; align-items:center; gap:6px; padding:4px 6px; border-radius:4px; cursor:pointer; background:${lvl.active ? "var(--accent-subtle, rgba(80,140,255,0.12))" : "transparent"};`;

    const eye = el("button", "level-eye");
    eye.innerHTML = lvl.visible
      ? `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 6s2-3.5 5-3.5S11 6 11 6s-2 3.5-5 3.5S1 6 1 6z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="6" cy="6" r="1.5" fill="currentColor"/></svg>`
      : `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 6s2-3.5 5-3.5S11 6 11 6s-2 3.5-5 3.5S1 6 1 6z" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.35"/><line x1="2" y1="10" x2="10" y2="2" stroke="currentColor" stroke-width="1.2"/></svg>`;
    eye.style.cssText = "border:none; background:transparent; cursor:pointer; padding:0; color:var(--ink-body); flex-shrink:0;";
    eye.title = lvl.visible ? "Hide level" : "Show level";
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      (window as unknown as { __dispatch?: (cmd: string, args: unknown) => unknown }).__dispatch?.("setLevelVisible", { id: lvl.id, visible: !lvl.visible });
    });

    const nameEl = el("div");
    nameEl.textContent = lvl.name;
    nameEl.style.cssText = "flex:1; font-size:11px; color:var(--ink-body);";

    const elevEl = el("div");
    elevEl.textContent = formatLength(Math.abs(lvl.elevation)).replace(/^/, lvl.elevation >= 0 ? "+" : "−");
    elevEl.style.cssText = "font-size:9px; color:var(--ink-dim); white-space:nowrap;";

    const heightEl = el("div", "level-height-display");
    heightEl.textContent = `h: ${formatLength(lvl.height)}`;
    heightEl.title = "Floor-to-floor height — click to edit";
    heightEl.style.cssText = "font-size:9px; color:var(--ink-faint); white-space:nowrap; cursor:pointer; padding:0 2px;";
    heightEl.addEventListener("click", (e) => {
      e.stopPropagation();
      const imperial = getState("unitSystem") === "imperial";
      const FT = 3.28084;
      const inp = document.createElement("input");
      inp.type = "number";
      inp.min = "0.01";
      inp.step = "0.5";
      inp.value = imperial ? (lvl.height * FT).toFixed(2) : lvl.height.toFixed(2);
      inp.title = imperial ? "Floor-to-floor height (ft)" : "Floor-to-floor height (m)";
      inp.style.cssText = "width:46px; font-size:9px; padding:1px 3px; background:var(--chrome,#1a1a1a); border:1px solid var(--accent,#5080ff); color:var(--ink-body,#ddd); border-radius:2px;";
      const unitLabelEl = document.createElement("span");
      unitLabelEl.textContent = imperial ? "ft" : "m";
      unitLabelEl.style.cssText = "font-size:9px; color:var(--ink-faint); margin-left:2px; flex-shrink:0;";
      const inpWrap = el("div", "level-height-input-wrap");
      inpWrap.style.cssText = "display:flex; align-items:center;";
      inpWrap.appendChild(inp);
      inpWrap.appendChild(unitLabelEl);
      heightEl.replaceWith(inpWrap);
      inp.focus(); inp.select();
      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        const raw = parseFloat(inp.value);
        if (!isNaN(raw) && raw > 0) {
          const hM = imperial ? raw / FT : raw;
          levelStore.update(lvl.id, { height: hM });
        } else if (inpWrap.parentNode) {
          inpWrap.replaceWith(heightEl);
        }
      };
      inp.addEventListener("blur", commit);
      inp.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); inp.blur(); }
        if (ev.key === "Escape") { committed = true; if (inpWrap.parentNode) inpWrap.replaceWith(heightEl); ev.stopPropagation(); }
      });
    });

    const chip = el("div", "level-active-chip");
    chip.textContent = "ACTIVE";
    chip.style.cssText = `font-size:8px; padding:1px 4px; border-radius:2px; background:var(--accent,#5080ff); color:#fff; display:${lvl.active ? "block" : "none"};`;

    row.appendChild(eye);
    row.appendChild(nameEl);
    row.appendChild(elevEl);
    row.appendChild(heightEl);
    row.appendChild(chip);

    if (lvl.id !== "level/0") {
      const delBtn = el("button", "level-del-btn");
      delBtn.textContent = "−";
      delBtn.title = "Delete level";
      delBtn.style.cssText = "border:none; background:transparent; cursor:pointer; padding:0 2px; color:var(--ink-faint); font-size:14px; line-height:1; flex-shrink:0;";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        (window as unknown as { __dispatch?: (cmd: string, args: unknown) => unknown }).__dispatch?.("removeLevel", { id: lvl.id });
      });
      row.appendChild(delBtn);
    }

    const lockBtn = el("button", "level-lock-btn");
    lockBtn.style.cssText = "background:none; border:none; cursor:pointer; color:var(--ink); opacity:" + (lvl.locked ? "1" : "0.35") + "; padding:0 2px; flex-shrink:0;";
    lockBtn.title = lvl.locked ? "Unlock level" : "Lock level";
    lockBtn.innerHTML = lvl.locked
      ? `<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><rect x="1" y="5" width="8" height="7" rx="1" stroke="currentColor"/><path d="M3 5V3.5a2 2 0 014 0V5" stroke="currentColor"/></svg>`
      : `<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><rect x="1" y="5" width="8" height="7" rx="1" stroke="currentColor" stroke-dasharray="2 1"/><path d="M3 5V3.5a2 2 0 014 0V5" stroke="currentColor"/></svg>`;
    lockBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      levelStore.setLocked(lvl.id, !lvl.locked);
    });
    row.appendChild(lockBtn);

    row.addEventListener("click", () => {
      if (lvl.locked) return;
      (window as unknown as { __dispatch?: (cmd: string, args: unknown) => unknown }).__dispatch?.("setActiveLevel", { id: lvl.id });
    });

    list.appendChild(row);
  }

  function render() {
    wrap.innerHTML = "";

    const header = el("div", "levels-header");
    header.style.cssText = "display:flex; align-items:center; justify-content:space-between; padding:4px 2px 6px;";
    const title = el("div");
    title.style.cssText = "font-size:9.5px; letter-spacing:0.14em; text-transform:uppercase; color:var(--ink-dim); font-weight:600;";
    title.textContent = "BUILDING LEVELS";
    const addBtn = el("button", "levels-add-btn");
    addBtn.textContent = "+";
    addBtn.style.cssText = "font-size:12px; padding:0 6px; cursor:pointer; background:var(--chrome-secondary); border:none; color:var(--ink-body); border-radius:3px;";
    header.appendChild(title);
    header.appendChild(addBtn);
    wrap.appendChild(header);

    const list = el("div", "levels-list");
    list.style.cssText = "display:flex; flex-direction:column; gap:2px;";
    for (const lvl of levelStore.all()) renderRow(lvl, list);
    wrap.appendChild(list);

    addBtn.addEventListener("click", () => {
      const existing = wrap.querySelector(".level-form");
      if (existing) { existing.remove(); return; }
      const form = el("div", "level-form");
      form.style.cssText = "display:flex; flex-direction:column; gap:4px; padding:6px; background:var(--chrome-secondary); border-radius:4px; margin-top:6px;";
      const imperial = getState("unitSystem") === "imperial";
      const FT = 3.28084;
      const maxElevM = Math.max(...levelStore.all().map(l => l.elevation));
      const defaultDisplayVal = imperial ? ((maxElevM + 3) * FT).toFixed(1) : (maxElevM + 3).toFixed(1);
      const unit = imperial ? "ft" : "m";
      form.innerHTML = `
        <input class="level-elev-input" placeholder="Elevation (${unit})" type="number" step="${imperial ? "0.5" : "0.1"}" value="${defaultDisplayVal}" style="font-size:11px; padding:3px 5px; background:var(--input-bg,var(--chrome)); border:1px solid var(--hairline); color:var(--ink-body); border-radius:3px;"/>
        <div style="display:flex; gap:4px;">
          <button class="level-create-btn" style="flex:1; font-size:10px; padding:3px; background:var(--accent,#5080ff); color:#fff; border:none; border-radius:3px; cursor:pointer;">Add Level</button>
          <button class="level-cancel-btn" style="font-size:10px; padding:3px 8px; background:none; border:1px solid var(--hairline); color:var(--ink-body); border-radius:3px; cursor:pointer;">Cancel</button>
        </div>
      `;
      wrap.appendChild(form);
      form.querySelector<HTMLButtonElement>(".level-cancel-btn")!.addEventListener("click", () => form.remove());
      form.querySelector<HTMLButtonElement>(".level-create-btn")!.addEventListener("click", () => {
        const elevDisplay = parseFloat((form.querySelector<HTMLInputElement>(".level-elev-input")!).value);
        if (isNaN(elevDisplay)) return;
        const elevM = imperial ? elevDisplay / FT : elevDisplay;
        const all = levelStore.all();
        const name = elevM >= 0
          ? `Level ${all.filter(l => l.elevation >= 0).length + 1}`
          : `Level B${all.filter(l => l.elevation < 0).length + 1}`;
        (window as unknown as { __dispatch?: (cmd: string, args: unknown) => unknown }).__dispatch?.("IfcLevel", { name, elevation: elevM });
        form.remove();
      });
    });
  }

  render();
  levelStore.subscribe(render);
  return wrap;
}

function buildLayersTab(): HTMLElement {
  const wrap = el("div", "tab-body layers-tab");

  const header = el("div", "layers-header");
  header.style.cssText = "display:flex; align-items:center; justify-content:space-between; padding:4px 2px 6px;";
  const title = el("div");
  title.style.cssText = "font-size:9.5px; letter-spacing:0.14em; text-transform:uppercase; color:var(--ink-dim); font-weight:600;";
  title.textContent = "BUILDING LAYERS";
  const addBtn = el("button");
  addBtn.style.cssText = "font-size:11px; background:none; border:1px solid var(--hairline); border-radius:3px; color:var(--ink); cursor:pointer; padding:1px 6px; line-height:16px;";
  addBtn.textContent = "+";
  addBtn.title = "New layer";
  header.appendChild(title);
  header.appendChild(addBtn);
  wrap.appendChild(header);

  const list = el("div", "layer-list");
  wrap.appendChild(list);

  function getViewer(): Viewer | undefined {
    return (window as unknown as { __viewer?: Viewer }).__viewer;
  }

  function applyVisibility(layerId: string, visible: boolean): void {
    const v = getViewer();
    if (!v) return;
    v.getScene().traverse((obj) => {
      if ((obj as THREE.Object3D & { userData: Record<string, unknown> }).userData?.layerId === layerId) {
        obj.visible = visible;
      }
    });
  }

  function applyColor(layerId: string, hex: string): void {
    const v = getViewer();
    if (!v) return;
    const color = new THREE.Color(hex);
    v.getScene().traverse((obj) => {
      if ((obj as THREE.Object3D & { userData: Record<string, unknown> }).userData?.layerId === layerId) {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh && mesh.material) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
              (m as THREE.MeshStandardMaterial).color.set(color);
              (m as THREE.MeshStandardMaterial).needsUpdate = true;
            }
          }
        }
      }
    });
  }

  const expandedLayers = new Set<string>();

  function getLayerObjects(layerId: string): THREE.Object3D[] {
    const v = getViewer();
    if (!v) return [];
    const hits: THREE.Object3D[] = [];
    v.getScene().traverse((obj) => {
      const ud = (obj as THREE.Object3D & { userData: Record<string, unknown> }).userData;
      if (ud?.layerId === layerId && ud?.kind) hits.push(obj);
    });
    return hits;
  }

  function buildChildRows(layerId: string): HTMLElement {
    const childWrap = el("div");
    childWrap.style.cssText = "background:var(--surface-2,rgba(0,0,0,0.12));";
    const objs = getLayerObjects(layerId);
    if (objs.length === 0) {
      const empty = el("div");
      empty.style.cssText = "padding:4px 10px 4px 28px; font-size:10px; color:var(--ink-faint); font-style:italic;";
      empty.textContent = "No objects";
      childWrap.appendChild(empty);
    } else {
      for (const obj of objs) {
        const childRow = el("div");
        childRow.style.cssText = "display:flex; align-items:center; gap:6px; padding:3px 4px 3px 28px; border-bottom:1px solid var(--hairline); cursor:pointer; min-height:22px;";
        childRow.title = "Select object";
        const nameSpan = el("span");
        nameSpan.style.cssText = "flex:1; font-size:10px; color:var(--ink-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
        const ud = (obj as THREE.Object3D & { userData: Record<string, unknown> }).userData;
        nameSpan.textContent = obj.name || String(ud.kind || obj.uuid.slice(0, 8));
        childRow.appendChild(nameSpan);
        childRow.addEventListener("click", () => {
          window.dispatchEvent(new CustomEvent("viewer:select-uuid", { detail: { uuid: obj.uuid } }));
        });
        childRow.addEventListener("mouseenter", () => { childRow.style.background = "var(--surface-hover,rgba(255,255,255,0.06))"; });
        childRow.addEventListener("mouseleave", () => { childRow.style.background = ""; });
        childWrap.appendChild(childRow);
      }
    }
    return childWrap;
  }

  function renderList(): void {
    list.innerHTML = "";
    for (const layer of layerStore.all()) {
      const isExpanded = expandedLayers.has(layer.id);

      const row = el("div", "layer-row", { "data-layer-id": layer.id });
      row.style.cssText = "display:flex; align-items:center; gap:4px; padding:3px 2px; border-bottom:1px solid var(--hairline); min-height:26px;";

      const arrowBtn = el("button");
      arrowBtn.style.cssText = "background:none; border:none; cursor:pointer; color:var(--ink-faint); padding:0 2px; flex-shrink:0; font-size:9px; width:14px; text-align:center;";
      arrowBtn.textContent = isExpanded ? "▾" : "▸";
      arrowBtn.title = isExpanded ? "Collapse" : "Expand";
      arrowBtn.addEventListener("click", () => {
        if (expandedLayers.has(layer.id)) expandedLayers.delete(layer.id);
        else expandedLayers.add(layer.id);
        renderList();
      });

      const eyeBtn = el("button");
      eyeBtn.style.cssText = "background:none; border:none; cursor:pointer; color:var(--ink); opacity:" + (layer.visible ? "1" : "0.35") + "; padding:0 2px; flex-shrink:0;";
      eyeBtn.title = layer.visible ? "Hide layer" : "Show layer";
      eyeBtn.innerHTML = layer.visible
        ? `<svg width="13" height="9" viewBox="0 0 13 9" fill="none"><ellipse cx="6.5" cy="4.5" rx="5.5" ry="3.5" stroke="currentColor"/><circle cx="6.5" cy="4.5" r="1.5" fill="currentColor"/></svg>`
        : `<svg width="13" height="9" viewBox="0 0 13 9" fill="none"><ellipse cx="6.5" cy="4.5" rx="5.5" ry="3.5" stroke="currentColor" stroke-dasharray="2 1"/></svg>`;
      eyeBtn.addEventListener("click", () => {
        const oldVisible = layer.visible;
        const newVisible = !layer.visible;
        pushCustomAction(
          () => { layerStore.setVisible(layer.id, oldVisible); applyVisibility(layer.id, oldVisible); renderList(); },
          () => { layerStore.setVisible(layer.id, newVisible); applyVisibility(layer.id, newVisible); renderList(); },
        );
        layerStore.setVisible(layer.id, newVisible);
        applyVisibility(layer.id, newVisible);
      });

      const lockBtn = el("button");
      lockBtn.style.cssText = "background:none; border:none; cursor:pointer; color:var(--ink); opacity:" + (layer.locked ? "1" : "0.35") + "; padding:0 2px; flex-shrink:0;";
      lockBtn.title = layer.locked ? "Unlock layer" : "Lock layer";
      lockBtn.innerHTML = layer.locked
        ? `<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><rect x="1" y="5" width="8" height="7" rx="1" stroke="currentColor"/><path d="M3 5V3.5a2 2 0 014 0V5" stroke="currentColor"/></svg>`
        : `<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><rect x="1" y="5" width="8" height="7" rx="1" stroke="currentColor" stroke-dasharray="2 1"/><path d="M3 5V3.5a2 2 0 014 0V5" stroke="currentColor"/></svg>`;
      lockBtn.addEventListener("click", () => {
        const oldLocked = layer.locked;
        const newLocked = !layer.locked;
        pushCustomAction(
          () => { layerStore.setLocked(layer.id, oldLocked); renderList(); },
          () => { layerStore.setLocked(layer.id, newLocked); renderList(); },
        );
        layerStore.setLocked(layer.id, newLocked);
      });

      const colorInput = document.createElement("input");
      colorInput.type = "color";
      colorInput.value = layer.color;
      colorInput.style.cssText = "width:14px; height:14px; border:none; padding:0; cursor:pointer; flex-shrink:0; border-radius:2px;";
      colorInput.title = "Layer color";
      colorInput.addEventListener("change", () => {
        const oldColor = layer.color;
        const newColor = colorInput.value;
        pushCustomAction(
          () => { layerStore.setColor(layer.id, oldColor); applyColor(layer.id, oldColor); renderList(); },
          () => { layerStore.setColor(layer.id, newColor); applyColor(layer.id, newColor); renderList(); },
        );
        layerStore.setColor(layer.id, newColor);
        applyColor(layer.id, newColor);
      });

      const nameEl = el("span");
      nameEl.style.cssText = "flex:1; font-size:11px; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer;";
      nameEl.textContent = layer.name;
      nameEl.addEventListener("click", () => {
        if (expandedLayers.has(layer.id)) expandedLayers.delete(layer.id);
        else expandedLayers.add(layer.id);
        renderList();
      });

      const delBtn = el("button") as HTMLButtonElement;
      delBtn.style.cssText = "background:none; border:none; cursor:" + (layer.id === DEFAULT_LAYER_ID ? "default" : "pointer") + "; color:var(--ink-dim); opacity:" + (layer.id === DEFAULT_LAYER_ID ? "0.2" : "0.6") + "; padding:0 2px; flex-shrink:0; font-size:13px;";
      delBtn.textContent = "×";
      delBtn.title = layer.id === DEFAULT_LAYER_ID ? "Default layer cannot be deleted" : "Delete layer";
      delBtn.disabled = layer.id === DEFAULT_LAYER_ID;
      delBtn.addEventListener("click", () => {
        if (layer.id === DEFAULT_LAYER_ID) return;
        layerStore.remove(layer.id);
      });

      row.appendChild(arrowBtn);
      row.appendChild(eyeBtn);
      row.appendChild(lockBtn);
      row.appendChild(colorInput);
      row.appendChild(nameEl);
      row.appendChild(delBtn);
      list.appendChild(row);

      if (isExpanded) {
        list.appendChild(buildChildRows(layer.id));
      }
    }
  }

  addBtn.addEventListener("click", () => {
    const name = prompt("Layer name:");
    if (!name?.trim()) return;
    layerStore.add({ name: name.trim(), visible: true, locked: false, color: "#" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0") });
  });

  layerStore.subscribe(renderList);
  renderList();
  return wrap;
}

function build2DLayersTab(): HTMLElement {
  const wrap = el("div", "tab-body drawing-layers-tab");
  wrap.style.cssText = "padding:0 2px 4px;";

  const header = el("div", "layers-header");
  header.style.cssText = "display:flex; align-items:center; justify-content:space-between; padding:4px 2px 6px;";
  const title = el("div");
  title.style.cssText = "font-size:9.5px; letter-spacing:0.14em; text-transform:uppercase; color:var(--ink-dim); font-weight:600;";
  title.textContent = "2D LAYERS";
  const addBtn = el("button") as HTMLButtonElement;
  addBtn.style.cssText = "font-size:11px; background:none; border:1px solid var(--hairline); border-radius:3px; color:var(--ink); cursor:pointer; padding:1px 6px; line-height:16px;";
  addBtn.textContent = "+";
  addBtn.title = "New 2D layer";
  addBtn.addEventListener("click", () => {
    drawingLayerStore.add(`Layer ${drawingLayerStore.all().length + 1}`);
  });
  header.appendChild(title);
  header.appendChild(addBtn);
  wrap.appendChild(header);

  const list = el("div", "drawing-layer-list");
  wrap.appendChild(list);

  function syncSceneVisibility(layer: DrawingLayer): void {
    const viewer = (window as unknown as { __viewer?: { forEachSceneChild: (fn: (o: { userData: Record<string, unknown>; visible: boolean }) => void) => void } }).__viewer;
    if (!viewer) return;
    viewer.forEachSceneChild((obj) => {
      if (obj.userData.drawingLayerId === layer.id) obj.visible = layer.visible;
    });
  }

  function countLayerObjects(layerId: string): number {
    const viewer = (window as unknown as { __viewer?: { forEachSceneChild: (fn: (o: { userData: Record<string, unknown> }) => void) => void } }).__viewer;
    if (!viewer) return 0;
    let n = 0;
    viewer.forEachSceneChild((obj) => { if (obj.userData.drawingLayerId === layerId) n++; });
    return n;
  }

  function renderList(): void {
    list.innerHTML = "";
    const activeId = drawingLayerStore.getActiveId();
    for (const layer of drawingLayerStore.all()) {
      const objCount = countLayerObjects(layer.id);
      const row = el("div", "layer-row", { "data-layer-id": layer.id });
      row.style.cssText =
        "display:flex; align-items:center; gap:4px; padding:3px 2px; border-bottom:1px solid var(--hairline); min-height:26px;" +
        (layer.id === activeId ? " background:var(--bg-hover);" : "");

      const eyeBtn = el("button") as HTMLButtonElement;
      eyeBtn.style.cssText = "background:none; border:none; cursor:pointer; color:var(--ink); opacity:" + (layer.visible ? "1" : "0.35") + "; padding:0 2px; flex-shrink:0;";
      eyeBtn.title = objCount === 0
        ? "No objects on this layer yet — toggle takes effect when objects are assigned"
        : (layer.visible ? "Hide layer" : "Show layer");
      eyeBtn.innerHTML = layer.visible
        ? `<svg width="13" height="9" viewBox="0 0 13 9" fill="none"><ellipse cx="6.5" cy="4.5" rx="5.5" ry="3.5" stroke="currentColor"/><circle cx="6.5" cy="4.5" r="1.5" fill="currentColor"/></svg>`
        : `<svg width="13" height="9" viewBox="0 0 13 9" fill="none"><ellipse cx="6.5" cy="4.5" rx="5.5" ry="3.5" stroke="currentColor" stroke-dasharray="2 1"/></svg>`;
      eyeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        drawingLayerStore.setVisible(layer.id, !layer.visible);
        syncSceneVisibility(drawingLayerStore.get(layer.id)!);
      });

      const lockBtn = el("button") as HTMLButtonElement;
      lockBtn.style.cssText = "background:none; border:none; cursor:pointer; color:var(--ink); opacity:" + (layer.locked ? "1" : "0.35") + "; padding:0 2px; flex-shrink:0;";
      lockBtn.title = layer.locked ? "Unlock layer" : "Lock layer";
      lockBtn.innerHTML = layer.locked
        ? `<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><rect x="1" y="5" width="8" height="7" rx="1" stroke="currentColor"/><path d="M3 5V3.5a2 2 0 014 0V5" stroke="currentColor"/></svg>`
        : `<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><rect x="1" y="5" width="8" height="7" rx="1" stroke="currentColor" stroke-dasharray="2 1"/><path d="M3 5V3.5a2 2 0 014 0V5" stroke="currentColor"/></svg>`;
      lockBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        drawingLayerStore.setLocked(layer.id, !layer.locked);
      });

      const colorInput = document.createElement("input");
      colorInput.type = "color";
      colorInput.value = layer.color;
      colorInput.style.cssText = "width:14px; height:14px; border:none; padding:0; cursor:pointer; flex-shrink:0; border-radius:2px;";
      colorInput.title = "Layer color";
      colorInput.addEventListener("change", (e) => {
        e.stopPropagation();
        const newColor = (e.target as HTMLInputElement).value;
        drawingLayerStore.setColor(layer.id, newColor);
        const viewer = (window as unknown as { __viewer?: { forEachSceneChild: (fn: (o: { userData: Record<string, unknown>; material?: { color?: { set: (c: string) => void }; needsUpdate: boolean } }) => void) => void } }).__viewer;
        if (viewer) {
          viewer.forEachSceneChild((obj) => {
            if (obj.userData.drawingLayerId === layer.id && obj.material?.color) {
              obj.material.color.set(newColor);
              obj.material.needsUpdate = true;
            }
          });
        }
      });

      const nameEl = el("span");
      nameEl.style.cssText = "flex:1; font-size:11px; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer;";
      nameEl.textContent = layer.name;
      nameEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const input = el("input") as HTMLInputElement;
        input.value = layer.name;
        input.style.cssText = "flex:1; font-size:11px; border:1px solid var(--sanguine); border-radius:2px; padding:0 2px; width:100%;";
        nameEl.replaceWith(input);
        input.focus();
        input.select();
        const commit = (): void => { drawingLayerStore.rename(layer.id, input.value); };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (ke) => {
          if (ke.key === "Enter") { commit(); input.blur(); }
          if (ke.key === "Escape") input.blur();
        });
      });

      const countBadge = el("span");
      countBadge.style.cssText = "font-size:9px; color:var(--ink-faint); flex-shrink:0; padding:0 1px;";
      countBadge.textContent = objCount === 0 ? "empty" : String(objCount);
      countBadge.title = objCount === 0 ? "No objects on this layer" : `${objCount} object${objCount === 1 ? "" : "s"}`;

      const isDefault = layer.id === "default";
      const delBtn = el("button") as HTMLButtonElement;
      delBtn.style.cssText = "background:none; border:none; cursor:" + (isDefault ? "default" : "pointer") + "; color:var(--ink-dim); opacity:" + (isDefault ? "0.2" : "0.6") + "; padding:0 2px; flex-shrink:0; font-size:13px;";
      delBtn.textContent = "×";
      delBtn.title = isDefault ? "Default layer cannot be deleted" : "Delete layer";
      delBtn.disabled = isDefault;
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!isDefault) drawingLayerStore.remove(layer.id);
      });

      row.appendChild(eyeBtn);
      row.appendChild(lockBtn);
      row.appendChild(colorInput);
      row.appendChild(nameEl);
      row.appendChild(countBadge);
      row.appendChild(delBtn);
      row.addEventListener("click", () => { drawingLayerStore.setActive(layer.id); });
      list.appendChild(row);
    }
  }

  drawingLayerStore.subscribe(renderList);
  renderList();
  return wrap;
}

export function buildSidebar(host: HTMLElement, scenePanel: HTMLElement | null) {
  host.innerHTML = "";

  const tabs = el("div", "sb-tabs");
  const body = el("div", "sb-body");
  body.style.cssText = "flex:1; min-height:0; overflow-y:auto; overflow-x:hidden;";
  const snap = buildSnapDock();

  const panes: Record<string, HTMLElement> = {
    scene:   buildSceneTab(scenePanel),
    inspect: buildInspectTab(),
  };

  for (const t of SIDEBAR_TABS) {
    const tab = el("div", "sb-tab", { "data-tab": t.id });
    tab.textContent = t.label;
    tab.addEventListener("click", () => activate(t.id));
    tabs.appendChild(tab);
  }

  const filterPanel = buildSelectionFiltersPanel();

  function activate(id: string) {
    tabs.querySelectorAll(".sb-tab").forEach((t) => {
      const isActive = (t as HTMLElement).dataset.tab === id;
      t.classList.toggle("active", isActive);
    });
    body.innerHTML = "";
    if (panes[id]) body.appendChild(panes[id]);
    body.appendChild(filterPanel);
    body.appendChild(snap);
  }

  // SIDEBAR_W_KEY — corrected from stale "gemma-sidebar-w" branding to "web-cad-sidebar-w"
  const SIDEBAR_W_KEY = "web-cad-sidebar-w";
  const SIDEBAR_W_MIN = 240;
  const SIDEBAR_W_MAX = 480;

  const resizeHandle = el("div", "sidebar-resize-handle");
  let resizing = false;
  let resizeStartX = 0;
  let resizeStartW = 0;

  resizeHandle.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    resizing = true;
    resizeHandle.classList.add("dragging");
    resizeHandle.setPointerCapture(e.pointerId);
    resizeStartX = e.clientX;
    const wb = host.closest<HTMLElement>(".workbench");
    resizeStartW = wb ? parseInt(getComputedStyle(wb).getPropertyValue("--sidebar-w").trim() || "320", 10) : 320;
  });

  resizeHandle.addEventListener("pointermove", (e: PointerEvent) => {
    if (!resizing) return;
    const dx = resizeStartX - e.clientX;
    const newW = Math.min(SIDEBAR_W_MAX, Math.max(SIDEBAR_W_MIN, resizeStartW + dx));
    const wb = host.closest<HTMLElement>(".workbench");
    if (wb) wb.style.setProperty("--sidebar-w", `${newW}px`);
  });

  resizeHandle.addEventListener("pointerup", (e: PointerEvent) => {
    if (!resizing) return;
    resizing = false;
    resizeHandle.classList.remove("dragging");
    resizeHandle.releasePointerCapture(e.pointerId);
    const wb = host.closest<HTMLElement>(".workbench");
    if (wb) {
      const current = wb.style.getPropertyValue("--sidebar-w");
      if (current) try { localStorage.setItem(SIDEBAR_W_KEY, current); } catch {}
    }
  });

  // Restore persisted width.
  const savedW = localStorage.getItem(SIDEBAR_W_KEY) ?? localStorage.getItem("gemma-sidebar-w");
  if (savedW) {
    const wb = host.closest<HTMLElement>(".workbench") ?? document.querySelector<HTMLElement>(".workbench");
    if (wb) wb.style.setProperty("--sidebar-w", savedW);
  }

  function isWall(obj: THREE.Object3D) { return obj.userData?.creator === "wall"; }
  subscribe((sel) => {
    if (sel && isWall(sel.object)) activate("inspect");
    else if (!sel) activate("scene");
  });
  subscribeMulti(() => {
    const multi = getMultiSelected();
    if (multi.length > 1) {
      if (multi.some((s) => isWall(s.object))) activate("inspect");
      else activate("scene");
    }
  });

  host.appendChild(tabs);
  host.appendChild(body);
  host.appendChild(resizeHandle);
  activate("scene");
}
