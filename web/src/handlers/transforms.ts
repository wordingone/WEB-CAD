import { registerHandler } from "../commands/dispatch";
import { Viewer } from "../viewer/viewer";
import * as THREE from "three";
import { getSelected, setSelected, clearMultiSelected, addToMultiSelected, topologyAllowed, getFilters } from "../viewer/selection-state";
import { captureTransform, pushTransformAction, pushReplaceAction, pushBatchAction } from "../history";
import { replayCloneSideEffects } from "../viewer/copy-array";
import { execAlignTool } from "../tools/index";
import { csgUnion, csgDifference, csgIntersection, filletMesh, chamferEdge, getUniqueEdges } from "../viewer/csg";
import { runPolySel, runRectSel } from "../viewer/selection-ops";
import { NurbsBooleanBackend } from "../nurbs/brep-boolean";
import { transformBrep } from "../nurbs/nurbs-brep";
import type { Xform } from "../nurbs/nurbs-primitives";
import { linkPlanarizedMeshEditBrep } from "./mesh-planar-brep";
import { objectFromCanonicalGeometry } from "../geometry/canonical-display";

type BooleanOp = "union" | "difference" | "intersection";

function threeMatrixToXform(matrix: THREE.Matrix4): Xform {
  const e = matrix.elements;
  return {
    m: [
      e[0], e[4], e[8], e[12],
      e[1], e[5], e[9], e[13],
      e[2], e[6], e[10], e[14],
      e[3], e[7], e[11], e[15],
    ],
  };
}

function linkCanonicalBooleanResult(
  viewer: Viewer,
  objA: THREE.Object3D,
  objB: THREE.Object3D,
  result: THREE.Object3D,
  op: BooleanOp,
  createdBy: string,
): void {
  objA.updateMatrixWorld(true);
  objB.updateMatrixWorld(true);
  const store = viewer.getCanonicalGeometryStore();
  const canonicalA = store.resolveObjectOrAncestor(objA);
  const canonicalB = store.resolveObjectOrAncestor(objB);
  if (canonicalA?.kind !== "brep" || canonicalB?.kind !== "brep") return;
  const brepA = transformBrep(canonicalA.brep, threeMatrixToXform(objA.matrixWorld));
  const brepB = transformBrep(canonicalB.brep, threeMatrixToXform(objB.matrixWorld));

  const backend = new NurbsBooleanBackend();
  const canonicalResult =
    op === "difference" ? backend.difference(brepA, brepB)
      : op === "intersection" ? backend.intersection(brepA, brepB)
        : backend.union(brepA, brepB);
  if (!canonicalResult.ok) return;

  const record = store.create({
    kind: "brep",
    brep: canonicalResult.brep,
    source: "edit",
    createdBy,
    metadata: {
      operation: `boolean-${op}`,
      operands: [canonicalA.id, canonicalB.id],
    },
  });
  store.linkObject(result, record.id);
}

function canonicalBooleanDisplayResult(
  viewer: Viewer,
  objA: THREE.Object3D,
  objB: THREE.Object3D,
  op: BooleanOp,
  createdBy: string,
  args: Record<string, unknown>,
): THREE.Mesh | null {
  objA.updateMatrixWorld(true);
  objB.updateMatrixWorld(true);
  const store = viewer.getCanonicalGeometryStore();
  const canonicalA = store.resolveObjectOrAncestor(objA);
  const canonicalB = store.resolveObjectOrAncestor(objB);
  if (canonicalA?.kind !== "brep" || canonicalB?.kind !== "brep") return null;
  const brepA = transformBrep(canonicalA.brep, threeMatrixToXform(objA.matrixWorld));
  const brepB = transformBrep(canonicalB.brep, threeMatrixToXform(objB.matrixWorld));
  const backend = new NurbsBooleanBackend();
  const canonicalResult =
    op === "difference" ? backend.difference(brepA, brepB)
      : op === "intersection" ? backend.intersection(brepA, brepB)
        : backend.union(brepA, brepB);
  if (!canonicalResult.ok) return null;
  const record = store.create({
    kind: "brep",
    brep: canonicalResult.brep,
    source: "edit",
    createdBy,
    metadata: {
      operation: `boolean-${op}`,
      operands: [canonicalA.id, canonicalB.id],
      displaySource: "canonical-brep",
    },
  });
  const display = objectFromCanonicalGeometry(record);
  if (!(display instanceof THREE.Mesh)) {
    store.delete(record.id);
    return null;
  }
  const pos = display.geometry.getAttribute("position");
  record.displayMesh = {
    revision: 1,
    generatedAt: Date.now(),
    vertexCount: pos?.count,
    triangleCount: display.geometry.index ? Math.floor(display.geometry.index.count / 3) : (pos ? Math.floor(pos.count / 3) : undefined),
    derivation: "tessellated-brep",
  };
  display.userData.kind = "brep";
  display.userData.creator = createdBy;
  display.userData.dispatchArgs = args;
  display.userData.booleanDisplaySource = "canonical-brep";
  store.linkObject(display, record.id);
  return display;
}

function buildPointMaterial(sizePx = 14): THREE.PointsMaterial {
  const canvas = document.createElement("canvas");
  canvas.width = 32; canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  ctx.beginPath();
  ctx.arc(16, 16, 12, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 3;
  ctx.stroke();
  return new THREE.PointsMaterial({
    size: sizePx, sizeAttenuation: false,
    map: new THREE.CanvasTexture(canvas),
    transparent: true, alphaTest: 0.1, depthTest: false,
  });
}

function resolveTransformTarget(viewer: Viewer, args: Record<string, unknown>): THREE.Object3D | null {
  const byTarget = (args.target as string | undefined)
    ? (viewer.getScene().getObjectByProperty("uuid", args.target as string) ?? null)
    : null;
  return byTarget ?? getSelected()?.transformTarget ?? viewer.getActiveObject();
}

function vectorArg(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (!Array.isArray(value)) return new THREE.Vector3(...fallback);
  return new THREE.Vector3(
    typeof value[0] === "number" ? value[0] : fallback[0],
    typeof value[1] === "number" ? value[1] : fallback[1],
    typeof value[2] === "number" ? value[2] : fallback[2],
  );
}

function dominantAxis(axis: THREE.Vector3): "x" | "y" | "z" {
  const ax = Math.abs(axis.x);
  const ay = Math.abs(axis.y);
  const az = Math.abs(axis.z);
  return ax >= ay && ax >= az ? "x" : ay >= az ? "y" : "z";
}

function axisStringVector(axis: string | null): THREE.Vector3 {
  if (axis?.includes("y")) return new THREE.Vector3(0, 1, 0);
  if (axis?.includes("z")) return new THREE.Vector3(0, 0, 1);
  return new THREE.Vector3(1, 0, 0);
}

function vectorListArg(value: unknown): THREE.Vector3[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((point): point is number[] => Array.isArray(point) && point.length >= 2)
    .map((point) => new THREE.Vector3(point[0] ?? 0, point[1] ?? 0, point[2] ?? 0));
}

function selectionModeArg(value: unknown): "crossing" | "window" {
  return value === "window" ? "window" : "crossing";
}

function rectArg(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const nums = value.slice(0, 4).map((n) => Number(n));
  return nums.every(Number.isFinite) ? nums as [number, number, number, number] : null;
}

function screenPolygonArg(value: unknown): Array<{ x: number; y: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((point) => {
    if (Array.isArray(point) && point.length >= 2) {
      const x = Number(point[0]);
      const y = Number(point[1]);
      return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : [];
    }
    if (point && typeof point === "object") {
      const p = point as { x?: unknown; y?: unknown };
      const x = Number(p.x);
      const y = Number(p.y);
      return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : [];
    }
    return [];
  });
}

function curveLength(points: THREE.Vector3[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += points[i].distanceTo(points[i - 1]);
  return length;
}

function sampleAlongCurve(points: THREE.Vector3[], count: number): THREE.Vector3[] {
  const distances: number[] = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + points[i].distanceTo(points[i - 1]));
  const total = distances[distances.length - 1] ?? 0;
  const samples: THREE.Vector3[] = [];
  const n = Math.max(2, count);
  for (let i = 0; i < n; i++) {
    const t = total === 0 ? 0 : (i / (n - 1)) * total;
    let segment = 0;
    while (segment < distances.length - 2 && distances[segment + 1] < t) segment++;
    const span = distances[segment + 1] - distances[segment];
    const alpha = span > 0 ? (t - distances[segment]) / span : 0;
    samples.push(points[segment].clone().lerp(points[Math.min(segment + 1, points.length - 1)], Math.min(1, alpha)));
  }
  return samples;
}

export function registerTransformHandlers(viewer: Viewer): void {
  registerHandler("SdMove", (args) => {
    const sel = resolveTransformTarget(viewer, args);
    if (!sel) return { moved: false, reason: "no selection" };
    const before = captureTransform(sel);
    const x = (args.x as number | undefined)
      ?? (Array.isArray(args.delta) ? (args.delta as number[])[0] : undefined)
      ?? (Array.isArray(args.vector) ? (args.vector as number[])[0] : undefined)
      ?? 0;
    const y = (args.y as number | undefined)
      ?? (Array.isArray(args.delta) ? (args.delta as number[])[1] : undefined)
      ?? (Array.isArray(args.vector) ? (args.vector as number[])[1] : undefined)
      ?? 0;
    const z = (args.z as number | undefined)
      ?? (Array.isArray(args.delta) ? (args.delta as number[])[2] : undefined)
      ?? (Array.isArray(args.vector) ? (args.vector as number[])[2] : undefined)
      ?? 0;
    sel.position.x += x;
    sel.position.y += y;
    sel.position.z += z;
    sel.updateMatrix();
    sel.updateMatrixWorld(true);
    pushTransformAction(sel, before);
    return { moved: true, delta: [x, y, z] };
  });

  registerHandler("SdScale", (args) => {
    const sel = resolveTransformTarget(viewer, args);
    if (!sel) return { scaled: false, reason: "no selection" };
    const before = captureTransform(sel);
    const f = (args.factor as number | undefined) ?? 1;
    if (!Number.isFinite(f) || f <= 0) return { scaled: false, reason: "factor must be positive" };
    const baseArg = Array.isArray(args.base) ? args.base : args.pivot;
    const base = vectorArg(baseArg, [0, 0, 0]);
    const hasBase = Array.isArray(baseArg);
    const mode = (args.mode as string | undefined) ?? null;
    const axisRaw = args.axis;
    const axis = typeof axisRaw === "string" ? axisRaw.toLowerCase() : null;

    if (hasBase) {
      const offset = sel.position.clone().sub(base);
      if (mode === "1d") {
        const axisVec = Array.isArray(axisRaw)
          ? vectorArg(axisRaw, [1, 0, 0])
          : axisStringVector(axis);
        const key = dominantAxis(axisVec);
        offset[key] *= f;
        sel.position.copy(base).add(offset);
        sel.scale[key] *= f;
      } else if (mode === "2d" || axis === "xy") {
        offset.x *= f;
        offset.y *= f;
        sel.position.copy(base).add(offset);
        sel.scale.x *= f;
        sel.scale.y *= f;
      } else {
        offset.multiplyScalar(f);
        sel.position.copy(base).add(offset);
        sel.scale.multiplyScalar(f);
      }
    } else if (!axis) {
      sel.scale.multiplyScalar(f);
    } else {
      if (axis.includes("x")) sel.scale.x *= f;
      if (axis.includes("y")) sel.scale.y *= f;
      if (axis.includes("z")) sel.scale.z *= f;
    }
    sel.updateMatrix();
    sel.updateMatrixWorld(true);
    pushTransformAction(sel, before);
    return { scaled: true, factor: f, axis: axis ?? "uniform", mode: mode ?? "uniform", base: hasBase ? base.toArray() : undefined };
  });

  registerHandler("SdRotate", (args) => {
    const sel = resolveTransformTarget(viewer, args);
    if (!sel) return { rotated: false, reason: "no selection" };
    const before = captureTransform(sel);
    const deg = (args.angle as number | undefined) ?? 0;
    const axis = (args.axis as number[] | undefined) ?? [0, 0, 1];
    const axisVec = new THREE.Vector3(axis[0] ?? 0, axis[1] ?? 0, axis[2] ?? 1).normalize();
    const rad = (deg * Math.PI) / 180;
    const baseArg = Array.isArray(args.base) ? args.base : args.pivot;
    const base = vectorArg(baseArg, [0, 0, 0]);
    if (Array.isArray(baseArg)) {
      sel.position.sub(base);
      sel.position.applyAxisAngle(axisVec, rad);
      sel.position.add(base);
    }
    const q = new THREE.Quaternion().setFromAxisAngle(axisVec, rad);
    sel.quaternion.premultiply(q);
    sel.updateMatrix();
    sel.updateMatrixWorld(true);
    pushTransformAction(sel, before);
    return { rotated: true, angle: deg, axis, pivot: Array.isArray(baseArg) ? base.toArray() : undefined };
  });

  registerHandler("SdCopy", (args) => {
    const byTarget = (args.target as string | undefined)
      ? (viewer.getScene().getObjectByProperty("uuid", args.target as string) ?? null)
      : null;
    const sel = byTarget ?? getSelected()?.transformTarget ?? viewer.getActiveObject();
    if (!sel) return { copied: false, reason: "no selection" };
    const x = (args.x as number | undefined)
      ?? (Array.isArray(args.vector) ? (args.vector as number[])[0] : undefined) ?? 0;
    const y = (args.y as number | undefined)
      ?? (Array.isArray(args.vector) ? (args.vector as number[])[1] : undefined) ?? 0;
    const z = (args.z as number | undefined)
      ?? (Array.isArray(args.vector) ? (args.vector as number[])[2] : undefined) ?? 0;
    const clone = sel.clone();
    clone.position.x += x; clone.position.y += y; clone.position.z += z;
    clone.userData = { ...sel.userData };
    viewer.addMesh(clone as THREE.Mesh, "brep");
    replayCloneSideEffects(clone, viewer.getScene());
    return { created: clone.uuid, delta: [x, y, z] };
  });

  registerHandler("SdArrayLinear", (args) => {
    const byTarget = (args.target as string | undefined)
      ? (viewer.getScene().getObjectByProperty("uuid", args.target as string) ?? null)
      : null;
    const sel = byTarget ?? getSelected()?.transformTarget ?? viewer.getActiveObject();
    if (!sel) return { created: false, reason: "no selection" };
    const count = Math.max(1, Math.round((args.count as number | undefined) ?? 3));
    const dx = (args.dx as number | undefined) ?? 1;
    const dy = (args.dy as number | undefined) ?? 0;
    const dz = (args.dz as number | undefined) ?? 0;
    const ids: string[] = [];
    for (let i = 1; i < count; i++) {
      const clone = sel.clone();
      clone.position.x += dx * i; clone.position.y += dy * i; clone.position.z += dz * i;
      clone.userData = { ...sel.userData };
      viewer.addMesh(clone as THREE.Mesh, "brep");
      replayCloneSideEffects(clone, viewer.getScene());
      ids.push(clone.uuid);
    }
    return { created: ids.length, ids };
  });

  registerHandler("SdArrayGrid", (args) => {
    const byTarget = (args.target as string | undefined)
      ? (viewer.getScene().getObjectByProperty("uuid", args.target as string) ?? null)
      : null;
    const sel = byTarget ?? getSelected()?.transformTarget ?? viewer.getActiveObject();
    if (!sel) return { created: false, reason: "no selection" };
    const rows = Math.max(1, Math.round((args.rows as number | undefined) ?? 3));
    const cols = Math.max(1, Math.round((args.cols as number | undefined) ?? 3));
    const dx = (args.dx as number | undefined) ?? 1;
    const dy = (args.dy as number | undefined) ?? 1;
    const ids: string[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r === 0 && c === 0) continue;
        const clone = sel.clone();
        clone.position.x += dx * c; clone.position.y += dy * r;
        clone.userData = { ...sel.userData };
        viewer.addMesh(clone as THREE.Mesh, "brep");
        replayCloneSideEffects(clone, viewer.getScene());
        ids.push(clone.uuid);
      }
    }
    return { created: ids.length, rows, cols };
  });

  registerHandler("SdArrayPolar", (args) => {
    const byTarget = (args.target as string | undefined)
      ? (viewer.getScene().getObjectByProperty("uuid", args.target as string) ?? null)
      : null;
    const sel = byTarget ?? getSelected()?.transformTarget ?? viewer.getActiveObject();
    if (!sel) return { created: false, reason: "no selection" };
    const count = Math.max(2, Math.round((args.count as number | undefined) ?? 6));
    const cx = (args.cx as number | undefined) ?? 0;
    const cy = (args.cy as number | undefined) ?? 0;
    const totalAngle = ((args.angle as number | undefined) ?? 360) * Math.PI / 180;
    const ox = sel.position.x - cx;
    const oy = sel.position.y - cy;
    const ids: string[] = [];
    for (let i = 1; i < count; i++) {
      const a = (totalAngle / count) * i;
      const clone = sel.clone();
      clone.position.x = cx + ox * Math.cos(a) - oy * Math.sin(a);
      clone.position.y = cy + ox * Math.sin(a) + oy * Math.cos(a);
      clone.userData = { ...sel.userData };
      viewer.addMesh(clone as THREE.Mesh, "brep");
      replayCloneSideEffects(clone, viewer.getScene());
      ids.push(clone.uuid);
    }
    return { created: ids.length, count };
  });

  registerHandler("SdArrayAlongCurve", (args) => {
    const sel = resolveTransformTarget(viewer, args);
    if (!sel) return { created: false, reason: "no selection" };
    const path = vectorListArg(args.path ?? args.curve ?? args.points);
    if (path.length < 2) return { created: false, reason: "path requires at least two points" };
    if (curveLength(path) <= 1e-9) return { created: false, reason: "path length must be positive" };
    const count = Math.max(2, Math.round((args.count as number | undefined) ?? 3));
    const sourceCenter = new THREE.Vector3();
    new THREE.Box3().setFromObject(sel).getCenter(sourceCenter);
    const samples = sampleAlongCurve(path, count);
    const batchObjs: THREE.Object3D[] = [];
    for (const sample of samples) {
      const clone = sel.clone(true);
      clone.position.x += sample.x - sourceCenter.x;
      clone.position.y += sample.y - sourceCenter.y;
      clone.position.z += sample.z - sourceCenter.z;
      clone.userData = { ...sel.userData, creator: "array-along-curve" };
      viewer.addMesh(clone, (clone.userData.kind as string | undefined) ?? "mesh", { noHistory: true });
      replayCloneSideEffects(clone, viewer.getScene());
      batchObjs.push(clone);
    }
    pushBatchAction(batchObjs, "SdArrayAlongCurve");
    return { created: batchObjs.length, count, pathLength: curveLength(path) };
  });

  registerHandler("SdAlignObjects", (args) => {
    const mode = (args.mode as string | undefined) ?? "left";
    execAlignTool(mode);
    return { ok: true, mode };
  });

  registerHandler("SdSelectAll", () => {
    clearMultiSelected();
    const filters = getFilters();
    const selectable: THREE.Object3D[] = [];
    viewer.getScene().traverse((obj) => {
      const kind = obj.userData.kind as string | undefined;
      if (!kind) return;
      const topo = (kind === "brep" || kind === "compound") ? kind as "brep" | "compound"
                 : (kind === "mesh") ? "mesh" as const
                 : null;
      if (!topo || !topologyAllowed(topo, filters)) return;
      selectable.push(obj);
    });
    if (selectable.length === 0) return;
    const centroid = new THREE.Vector3();
    selectable.forEach((o) => centroid.add(o.getWorldPosition(new THREE.Vector3())));
    centroid.divideScalar(selectable.length);
    selectable.forEach((o) => {
      addToMultiSelected({
        topology: (o.userData.kind as "mesh" | "brep" | "compound") ?? "mesh",
        uuid: o.uuid,
        object: o,
        transformTarget: o,
      });
    });
    const proxy = new THREE.Object3D();
    proxy.position.copy(centroid);
    proxy.userData.kind = "_selectAll_proxy";
    viewer.getScene().add(proxy); // audit-undo-ok — transient gumball anchor, not user content
    viewer.selectObject(proxy);
    window.dispatchEvent(new CustomEvent("viewer:selectAll", { detail: { count: selectable.length } }));
  });

  registerHandler("SdSelectWindow", (args) => {
    const rect = rectArg(args.rect);
    if (!rect) return { error: "SdSelectWindow requires rect=[x1,y1,x2,y2]" };
    const selected = runRectSel(viewer, rect[0], rect[1], rect[2], rect[3], selectionModeArg(args.mode));
    return { selected, count: selected.length, mode: selectionModeArg(args.mode) };
  });

  registerHandler("SdSelectLasso", (args) => {
    const polygon = screenPolygonArg(args.polygon);
    if (polygon.length < 3) return { error: "SdSelectLasso requires polygon with at least three screen points" };
    const selected = runPolySel(viewer, polygon, selectionModeArg(args.mode));
    return { selected, count: selected.length, mode: selectionModeArg(args.mode) };
  });

  registerHandler("SdSelectBoundary", (args) => {
    const polygon = screenPolygonArg(args.polygon);
    if (polygon.length < 3) return { error: "SdSelectBoundary requires polygon with at least three screen points" };
    const selected = runPolySel(viewer, polygon, selectionModeArg(args.mode));
    return { selected, count: selected.length, mode: selectionModeArg(args.mode) };
  });

  registerHandler("SdBoolean", (args) => {
    const opArg = (args.op as string | undefined) ?? "union";
    const aId = args.a as string | undefined;
    const bId = args.b as string | undefined;
    if (!aId || !bId) return { error: "SdBoolean requires a and b object_ids" };
    const scene = viewer.getScene();
    const objA = scene.getObjectByProperty("uuid", aId);
    const objB = scene.getObjectByProperty("uuid", bId);
    if (!objA || !objB) return { error: `SdBoolean — object not found: ${!objA ? aId : bId}` };
    if (!(objA instanceof THREE.Mesh) || !(objB instanceof THREE.Mesh))
      return { error: "SdBoolean — both targets must be solid meshes" };
    const creator = opArg === "difference" ? "boolean-difference" : opArg === "intersection" ? "boolean-intersection" : "boolean-union";
    const canonicalResult = canonicalBooleanDisplayResult(
      viewer,
      objA,
      objB,
      opArg === "difference" || opArg === "intersection" ? opArg : "union",
      creator,
      args,
    );
    if (canonicalResult) {
      scene.remove(objA); // audit-undo-ok - paired with pushReplaceAction below
      scene.remove(objB); // audit-undo-ok - paired with pushReplaceAction below
      viewer.addMesh(canonicalResult, "brep", { noHistory: true });
      pushReplaceAction(canonicalResult, [objA, objB], creator);
      return { created: canonicalResult.uuid, op: opArg, displaySource: "canonical-brep" };
    }
    const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
    let result: THREE.Mesh;
    try {
      if (opArg === "difference") result = csgDifference(objA, objB, mat);
      else if (opArg === "intersection") result = csgIntersection(objA, objB, mat);
      else result = csgUnion(objA, objB, mat);
    } catch {
      return { error: "SdBoolean — CSG failed (geometry may be non-manifold)" };
    }
    if (!result.geometry.getAttribute("position") || result.geometry.getAttribute("position").count === 0)
      return { error: "SdBoolean — result is empty (objects may not overlap)" };
    result.userData.kind = "brep";
    result.userData.creator = creator;
    result.userData.dispatchArgs = args;
    linkCanonicalBooleanResult(viewer, objA, objB, result, opArg === "difference" || opArg === "intersection" ? opArg : "union", creator);
    scene.remove(objA); // audit-undo-ok — paired with pushReplaceAction below
    scene.remove(objB); // audit-undo-ok — paired with pushReplaceAction below
    viewer.addMesh(result, "brep", { noHistory: true });
    pushReplaceAction(result, [objA, objB], creator);
    return { created: result.uuid, op: opArg };
  });

  // §WEB-CAD#30 G8: SdBooleanUnion / SdBooleanDifference / SdBooleanIntersection handlers.
  // These are the verb-specific forms of SdBoolean — no `op` arg, arg names differ for Difference.
  function _doBoolOp(
    aId: string | undefined,
    bId: string | undefined,
    op: "union" | "difference" | "intersection",
  ): Record<string, unknown> {
    if (!aId || !bId) return { error: `Sd${op.charAt(0).toUpperCase() + op.slice(1)} requires two object ids` };
    const scene = viewer.getScene();
    const objA = scene.getObjectByProperty("uuid", aId);
    const objB = scene.getObjectByProperty("uuid", bId);
    if (!objA || !objB) return { error: `boolean ${op} — object not found: ${!objA ? aId : bId}` };
    if (!(objA instanceof THREE.Mesh) || !(objB instanceof THREE.Mesh))
      return { error: `boolean ${op} — both targets must be solid meshes` };
    const creator = op === "difference" ? "boolean-difference" : op === "intersection" ? "boolean-intersection" : "boolean-union";
    const canonicalResult = canonicalBooleanDisplayResult(viewer, objA, objB, op, creator, { a: aId, b: bId });
    if (canonicalResult) {
      scene.remove(objA); // audit-undo-ok
      scene.remove(objB); // audit-undo-ok
      viewer.addMesh(canonicalResult, "brep", { noHistory: true });
      pushReplaceAction(canonicalResult, [objA, objB], creator);
      return { created: canonicalResult.uuid, op, displaySource: "canonical-brep" };
    }
    const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
    let result: THREE.Mesh;
    try {
      if (op === "difference") result = csgDifference(objA, objB, mat);
      else if (op === "intersection") result = csgIntersection(objA, objB, mat);
      else result = csgUnion(objA, objB, mat);
    } catch {
      return { error: `boolean ${op} — CSG failed (geometry may be non-manifold)` };
    }
    if (!result.geometry.getAttribute("position") || result.geometry.getAttribute("position").count === 0)
      return { error: `boolean ${op} — result is empty (objects may not overlap)` };
    result.userData.kind = "brep";
    result.userData.creator = creator;
    linkCanonicalBooleanResult(viewer, objA, objB, result, op, creator);
    scene.remove(objA); // audit-undo-ok
    scene.remove(objB); // audit-undo-ok
    viewer.addMesh(result, "brep", { noHistory: true });
    pushReplaceAction(result, [objA, objB], creator);
    return { created: result.uuid, op };
  }

  registerHandler("SdBooleanUnion", (args) =>
    _doBoolOp(args.a as string | undefined, args.b as string | undefined, "union")
  );

  registerHandler("SdBooleanDifference", (args) =>
    _doBoolOp(args.outer as string | undefined, args.inner as string | undefined, "difference")
  );

  registerHandler("SdBooleanIntersection", (args) =>
    _doBoolOp(args.a as string | undefined, args.b as string | undefined, "intersection")
  );

  registerHandler("SdFillet", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdFillet — target is required" };
    const radius = args.radius as number | undefined;
    if (radius === undefined || radius === null) return { error: "SdFillet — radius is required" };
    if (!Number.isFinite(radius) || radius <= 0) return { error: `SdFillet — radius must be a positive number, got: ${radius}` };
    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdFillet — target not found: ${targetId}` };
    if (!(obj instanceof THREE.Mesh)) return { error: `SdFillet — target is not a Mesh` };
    const edgeId = args.edgeId as number | undefined;
    const edgeFrom = args.edgeFrom as number[] | undefined;
    const edgeTo = args.edgeTo as number[] | undefined;
    let filleted: THREE.Mesh;
    if (edgeId !== undefined && edgeId !== null) {
      const edges = getUniqueEdges(obj);
      if (edgeId < 0 || edgeId >= edges.length) {
        return { error: `SdFillet — edgeId ${edgeId} out of range [0, ${edges.length - 1}]` };
      }
      const [localA, localB] = edges[edgeId];
      const worldA = localA.clone().applyMatrix4(obj.matrixWorld);
      const worldB = localB.clone().applyMatrix4(obj.matrixWorld);
      filleted = chamferEdge(obj, worldA, worldB, radius);
      if (filleted.userData._chamferError) {
        return { error: `SdFillet — ${filleted.userData._chamferError as string}` };
      }
      linkPlanarizedMeshEditBrep(viewer, obj, filleted, "SdFillet", {
        operation: "edge-chamfer",
        edgeId,
        radius,
      });
    } else if (edgeFrom && edgeTo) {
      const worldA = new THREE.Vector3(edgeFrom[0] ?? 0, edgeFrom[1] ?? 0, edgeFrom[2] ?? 0);
      const worldB = new THREE.Vector3(edgeTo[0] ?? 0, edgeTo[1] ?? 0, edgeTo[2] ?? 0);
      filleted = chamferEdge(obj, worldA, worldB, radius);
      if (filleted.userData._chamferError) {
        return { error: `SdFillet — ${filleted.userData._chamferError as string}` };
      }
      linkPlanarizedMeshEditBrep(viewer, obj, filleted, "SdFillet", {
        operation: "edge-chamfer",
        edgeFrom,
        edgeTo,
        radius,
      });
    } else {
      filleted = filletMesh(obj, radius);
      if (filleted.userData._chamferError) {
        return { error: `SdFillet — ${filleted.userData._chamferError as string}` };
      }
      linkPlanarizedMeshEditBrep(viewer, obj, filleted, "SdFillet", {
        operation: "all-edge-fillet",
        radius,
      });
    }
    viewer.getScene().remove(obj); // audit-undo-ok: tracked by pushReplaceAction below
    viewer.addMesh(filleted, "brep", { noHistory: true });
    pushReplaceAction(filleted, [obj], "fillet");
    return { modified: filleted.uuid, edgeCount: edgeId !== undefined ? 1 : "all" };
  });

  registerHandler("SdSelect", (args) => {
    const id = args.id as string | undefined;
    if (!id) return { error: "SdSelect requires id" };
    const obj = viewer.getScene().getObjectByProperty("uuid", id);
    if (!obj) return { error: `SdSelect — object not found: ${id}` };
    clearMultiSelected();
    viewer.selectObject(obj);
    const topo = (obj.userData.kind as "mesh" | "brep" | "compound") ?? "mesh";
    setSelected({ topology: topo, uuid: obj.uuid, object: obj, transformTarget: obj });
    window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: obj.uuid } }));
    return { selected: obj.uuid };
  });

  registerHandler("SdSelectByQuery", (args) => {
    const creatorQ = args.creator as string | undefined;
    const layerQ = args.layerId as string | undefined;
    const levelQ = args.levelId as string | undefined;
    const matches: THREE.Object3D[] = [];
    viewer.getScene().traverse((obj) => {
      if (!obj.userData.kind) return;
      if (creatorQ && obj.userData.creator !== creatorQ) return;
      if (layerQ && obj.userData.layerId !== layerQ) return;
      if (levelQ && obj.userData.levelId !== levelQ) return;
      matches.push(obj);
    });
    if (matches.length === 0) return { selected: [], count: 0 };
    clearMultiSelected();
    const centroid = new THREE.Vector3();
    matches.forEach((o) => centroid.add(o.getWorldPosition(new THREE.Vector3())));
    centroid.divideScalar(matches.length);
    matches.forEach((o) => addToMultiSelected({
      topology: (o.userData.kind as "mesh" | "brep" | "compound") ?? "mesh",
      uuid: o.uuid, object: o, transformTarget: o,
    }));
    const proxy = new THREE.Object3D();
    proxy.position.copy(centroid);
    proxy.userData.kind = "_selectQuery_proxy";
    viewer.getScene().add(proxy); // audit-undo-ok — transient gumball anchor, not user content
    viewer.selectObject(proxy);
    window.dispatchEvent(new CustomEvent("viewer:selectAll", { detail: { count: matches.length } }));
    return { selected: matches.map((o) => o.uuid), count: matches.length };
  });

  registerHandler("SdArray", (args) => {
    const count = Math.max(1, Math.trunc((args.count as number | undefined) ?? 1));
    const spacing = (args.spacing as number[] | undefined) ?? [1, 0, 0];
    const sx = spacing[0] ?? 1;
    const sy = spacing[1] ?? 0;
    const sz = spacing[2] ?? 0;

    const cols = Math.max(1, Math.trunc((args.cols as number | undefined) ?? (args.countX as number | undefined) ?? count));
    const rows = Math.max(1, Math.trunc((args.rows as number | undefined) ?? (args.countY as number | undefined) ?? 1));
    const spacingY = (args.spacingY as number[] | undefined) ?? [0, 1, 0];
    const syx = spacingY[0] ?? 0;
    const syy = spacingY[1] ?? 1;
    const syz = spacingY[2] ?? 0;

    const target = args.target;
    const selected = getSelected()?.transformTarget ?? null;
    const active = viewer.getActiveObject();
    const baseObj = selected ?? active ?? null;

    function makePoint(position: [number, number, number]): THREE.Points {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
      const obj = new THREE.Points(geom, buildPointMaterial());
      obj.userData.kind = "point";
      obj.userData.creator = "array";
      return obj;
    }

    const isPointTarget =
      target === "point" ||
      target === "SdPoint" ||
      (Array.isArray(target) && target.length >= 2) ||
      (target && typeof target === "object" && (target as Record<string, unknown>).kind === "point");

    const basePointRaw =
      Array.isArray(target)
        ? target
        : (target && typeof target === "object" && Array.isArray((target as Record<string, unknown>).position))
          ? ((target as Record<string, unknown>).position as number[])
          : ([0, 0, 0] as number[]);
    const basePoint: [number, number, number] = [
      basePointRaw[0] ?? 0,
      basePointRaw[1] ?? 0,
      basePointRaw[2] ?? 0,
    ];

    let created = 0;
    const batchObjs: THREE.Object3D[] = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const dx = i * sx + j * syx;
        const dy = i * sy + j * syy;
        const dz = i * sz + j * syz;
        if (isPointTarget || !baseObj) {
          const p = makePoint([basePoint[0] + dx, basePoint[1] + dy, basePoint[2] + dz]);
          viewer.addMesh(p, "mesh", { noHistory: true });
          batchObjs.push(p);
        } else {
          const clone = baseObj.clone(true);
          clone.position.set(
            baseObj.position.x + dx,
            baseObj.position.y + dy,
            baseObj.position.z + dz,
          );
          clone.userData = { ...baseObj.userData, creator: "array" };
          viewer.addMesh(clone, (clone.userData.kind as string | undefined) ?? "mesh", { noHistory: true });
          batchObjs.push(clone);
        }
        created++;
      }
    }
    pushBatchAction(batchObjs, "SdArray");

    return {
      created: isPointTarget || !baseObj ? "point-array" : "array",
      count: created,
      rows,
      cols,
      spacing: [sx, sy, sz],
    };
  });
}
