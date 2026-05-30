import { registerHandler } from "../commands/dispatch";
import { Viewer } from "../viewer/viewer";
import * as THREE from "three";
import { getSelected, setSelected, clearSelected, clearMultiSelected, addToMultiSelected, topologyAllowed, getFilters } from "../viewer/selection-state";
import { captureTransform, pushTransformAction, pushReplaceAction, pushBatchAction } from "../history";
import { replayCloneSideEffects } from "../viewer/copy-array";
import { execAlignTool } from "../tools/index";
import { csgUnion, csgDifference, csgIntersection, getUniqueEdges } from "../viewer/csg";
import { runPolySel, runRectSel } from "../viewer/selection-ops";
import { NurbsBooleanBackend } from "../nurbs/brep-boolean";
import { BREP_DEFAULT_TOLERANCE, transformBrep, brepConcat, type Brep, type BrepFace } from "../nurbs/nurbs-brep";
import { Plane, type Point3, type Xform } from "../nurbs/nurbs-primitives";
import type { NurbsSurface } from "../nurbs/nurbs-surfaces";
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
): THREE.Mesh | { error: string } | null {
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
  if (!canonicalResult.ok) {
    return {
      error: `boolean ${op} canonical BRep failed: ${canonicalResult.error.code} (${canonicalResult.error.message})`,
    };
  }
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
    return { error: `boolean ${op} canonical BRep display generation failed` };
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

function linkedCanonicalCarrier(obj: THREE.Object3D): THREE.Object3D {
  let current: THREE.Object3D | null = obj;
  while (current) {
    if (typeof current.userData.canonicalGeometryId === "string") return current;
    current = current.parent;
  }
  return obj;
}

function pointFromVector(v: THREE.Vector3): Point3 {
  return { x: v.x, y: v.y, z: v.z };
}

function linearNurbsSurface(
  p00: Point3,
  p01: Point3,
  p10: Point3,
  p11: Point3,
  uDomain: [number, number] = [0, 1],
  vDomain: [number, number] = [0, 1],
): NurbsSurface {
  return {
    kind: "nurbs",
    dim: 3,
    isRational: false,
    order: [2, 2],
    cvCount: [2, 2],
    knots: [uDomain, vDomain],
    cvs: [
      p00.x, p00.y, p00.z,
      p01.x, p01.y, p01.z,
      p10.x, p10.y, p10.z,
      p11.x, p11.y, p11.z,
    ],
    cvStride: [6, 3],
  };
}

function trimmedNurbsFace(points: THREE.Vector3[]): BrepFace | null {
  if (points.length < 3) return null;
  const origin = points[0];
  let normal = new THREE.Vector3();
  for (let i = 1; i + 1 < points.length; i++) {
    normal = new THREE.Vector3()
      .subVectors(points[i], origin)
      .cross(new THREE.Vector3().subVectors(points[i + 1], origin));
    if (normal.lengthSq() > 1e-12) break;
  }
  if (normal.lengthSq() <= 1e-12) return null;
  normal.normalize();
  const xAxis = new THREE.Vector3().subVectors(points[1], origin).normalize();
  const yAxis = new THREE.Vector3().crossVectors(normal, xAxis).normalize();
  const uv = points.map((p) => {
    const d = new THREE.Vector3().subVectors(p, origin);
    return { x: d.dot(xAxis), y: d.dot(yAxis), z: 0 };
  });
  const uMin = Math.min(...uv.map((p) => p.x));
  const uMax = Math.max(...uv.map((p) => p.x));
  const vMin = Math.min(...uv.map((p) => p.y));
  const vMax = Math.max(...uv.map((p) => p.y));
  const plane = Plane.create(pointFromVector(origin), pointFromVector(xAxis), pointFromVector(yAxis));
  const surface = linearNurbsSurface(
    Plane.pointAt(plane, uMin, vMin),
    Plane.pointAt(plane, uMin, vMax),
    Plane.pointAt(plane, uMax, vMin),
    Plane.pointAt(plane, uMax, vMax),
    [uMin, uMax],
    [vMin, vMax],
  );
  const closed = [...uv, uv[0]];
  return {
    surface,
    outerLoop: {
      curves: [{
        kind: "polyline",
        points: closed,
        parameters: closed.map((_, i) => i),
      }],
      orientation: true,
    },
    innerLoops: [],
    orientation: true,
    tolerance: BREP_DEFAULT_TOLERANCE,
  };
}

function uniqueBrepPoints(brep: Brep): THREE.Vector3[] {
  const byKey = new Map<string, THREE.Vector3>();
  const add = (p: Point3): void => {
    const key = `${p.x.toFixed(9)},${p.y.toFixed(9)},${p.z.toFixed(9)}`;
    if (!byKey.has(key)) byKey.set(key, new THREE.Vector3(p.x, p.y, p.z));
  };
  for (const shell of brep.shells) {
    for (const vertex of shell.vertices) add(vertex.point);
    for (const edge of shell.edges) {
      if (edge.curve.kind === "line") {
        add(edge.curve.from);
        add(edge.curve.to);
      } else if (edge.curve.kind === "polyline") {
        for (const point of edge.curve.points) add(point);
      }
    }
    for (const face of shell.faces) {
      if (face.surface.kind === "nurbs") {
        for (let i = 0; i < face.surface.cvs.length; i += face.surface.cvStride[1]) {
          add({ x: face.surface.cvs[i] ?? 0, y: face.surface.cvs[i + 1] ?? 0, z: face.surface.cvs[i + 2] ?? 0 });
        }
      } else if (face.surface.kind === "plane") {
        add(face.surface.plane.origin);
      }
    }
  }
  return [...byKey.values()];
}

function axisBoxBoundsFromBrep(brep: Brep): { min: THREE.Vector3; max: THREE.Vector3 } | null {
  const points = uniqueBrepPoints(brep);
  if (points.length < 8) return null;
  const box = new THREE.Box3().setFromPoints(points);
  if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return null;
  if (box.max.x - box.min.x <= 1e-9 || box.max.y - box.min.y <= 1e-9 || box.max.z - box.min.z <= 1e-9) return null;
  return { min: box.min, max: box.max };
}

function brepFromNurbsPolygons(polygons: THREE.Vector3[][]): Brep | null {
  const facePairs = polygons
    .map((polygon) => ({ polygon, face: trimmedNurbsFace(polygon) }))
    .filter((entry): entry is { polygon: THREE.Vector3[]; face: BrepFace } => Boolean(entry.face));
  const faces = facePairs.map((entry) => entry.face);
  if (faces.length === 0) return null;
  const edgeMap = new Map<string, { from: Point3; to: Point3; faceIndex1: number; faceIndex2: number | null }>();
  const vertexEdges = new Map<string, { point: Point3; edgeIndices: number[] }>();
  const pointKey = (pt: Point3): string => `${pt.x.toFixed(9)},${pt.y.toFixed(9)},${pt.z.toFixed(9)}`;
  const edgeKey = (aPt: Point3, bPt: Point3): string => {
    const ka = pointKey(aPt);
    const kb = pointKey(bPt);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  facePairs.forEach(({ polygon }, faceIndex) => {
    for (let i = 0; i < polygon.length; i++) {
      const from = pointFromVector(polygon[i]);
      const to = pointFromVector(polygon[(i + 1) % polygon.length]);
      const key = edgeKey(from, to);
      const existing = edgeMap.get(key);
      if (existing) existing.faceIndex2 = faceIndex;
      else edgeMap.set(key, { from, to, faceIndex1: faceIndex, faceIndex2: null });
    }
  });
  const edges = [...edgeMap.values()].map((edge, edgeIndex) => {
    for (const point of [edge.from, edge.to]) {
      const key = pointKey(point);
      const vertex = vertexEdges.get(key) ?? { point, edgeIndices: [] };
      vertex.edgeIndices.push(edgeIndex);
      vertexEdges.set(key, vertex);
    }
    return {
      curve: {
        kind: "line" as const,
        from: edge.from,
        to: edge.to,
        domain: { min: 0, max: Math.hypot(edge.to.x - edge.from.x, edge.to.y - edge.from.y, edge.to.z - edge.from.z) },
      },
      faceIndex1: edge.faceIndex1,
      faceIndex2: edge.faceIndex2,
      tolerance: BREP_DEFAULT_TOLERANCE,
    };
  });
  const vertices = [...vertexEdges.values()].map((vertex) => ({
    point: vertex.point,
    edgeIndices: vertex.edgeIndices,
    tolerance: BREP_DEFAULT_TOLERANCE,
  }));
  return { shells: [{ faces, edges, vertices, isClosed: edges.every((edge) => edge.faceIndex2 !== null) }] };
}

function nativeBoxEdgeChamferBrep(source: Brep, edgeFrom: THREE.Vector3, edgeTo: THREE.Vector3, radius: number): Brep | null {
  const bounds = axisBoxBoundsFromBrep(source);
  if (!bounds) return null;
  const mins = [bounds.min.x, bounds.min.y, bounds.min.z];
  const maxs = [bounds.max.x, bounds.max.y, bounds.max.z];
  const a = [edgeFrom.x, edgeFrom.y, edgeFrom.z];
  const b = [edgeTo.x, edgeTo.y, edgeTo.z];
  const axis = [0, 1, 2].find((i) => Math.abs(a[i] - b[i]) > 1e-6);
  if (axis === undefined) return null;
  const constAxes = [0, 1, 2].filter((i) => i !== axis);
  const signs = new Map<number, number>();
  for (const i of constAxes) {
    const value = (a[i] + b[i]) / 2;
    if (Math.abs(value - mins[i]) < 1e-5) signs.set(i, -1);
    else if (Math.abs(value - maxs[i]) < 1e-5) signs.set(i, 1);
    else return null;
  }
  const maxRadius = Math.min(...constAxes.map((i) => (maxs[i] - mins[i]) / 2));
  if (radius >= maxRadius) return null;
  const [u, v] = constAxes;
  const su = signs.get(u)!;
  const sv = signs.get(v)!;
  const uEdge = su < 0 ? mins[u] : maxs[u];
  const vEdge = sv < 0 ? mins[v] : maxs[v];
  const uCut = uEdge - su * radius;
  const vCut = vEdge - sv * radius;
  const p = (axisValue: number, uValue: number, vValue: number): THREE.Vector3 => {
    const coords = [0, 0, 0];
    coords[axis] = axisValue;
    coords[u] = uValue;
    coords[v] = vValue;
    return new THREE.Vector3(coords[0], coords[1], coords[2]);
  };
  const lo = mins[axis];
  const hi = maxs[axis];
  const uOpp = su < 0 ? maxs[u] : mins[u];
  const vOpp = sv < 0 ? maxs[v] : mins[v];
  const polygons = [
    [p(lo, uCut, vEdge), p(lo, uOpp, vEdge), p(lo, uOpp, vOpp), p(lo, uEdge, vOpp), p(lo, uEdge, vCut)],
    [p(hi, uCut, vEdge), p(hi, uEdge, vCut), p(hi, uEdge, vOpp), p(hi, uOpp, vOpp), p(hi, uOpp, vEdge)],
    [p(lo, uOpp, vEdge), p(hi, uOpp, vEdge), p(hi, uOpp, vOpp), p(lo, uOpp, vOpp)],
    [p(lo, uEdge, vOpp), p(hi, uEdge, vOpp), p(hi, uOpp, vOpp), p(lo, uOpp, vOpp)],
    [p(lo, uCut, vEdge), p(hi, uCut, vEdge), p(hi, uOpp, vEdge), p(lo, uOpp, vEdge)],
    [p(lo, uEdge, vCut), p(lo, uEdge, vOpp), p(hi, uEdge, vOpp), p(hi, uEdge, vCut)],
    [p(lo, uCut, vEdge), p(lo, uEdge, vCut), p(hi, uEdge, vCut), p(hi, uCut, vEdge)],
  ];
  return brepFromNurbsPolygons(polygons);
}

function nativeBoxAllEdgeChamferBrep(source: Brep, radius: number): Brep | null {
  const bounds = axisBoxBoundsFromBrep(source);
  if (!bounds) return null;
  const mins = [bounds.min.x, bounds.min.y, bounds.min.z];
  const maxs = [bounds.max.x, bounds.max.y, bounds.max.z];
  const maxRadius = Math.min(...[0, 1, 2].map((i) => (maxs[i] - mins[i]) / 2));
  if (radius >= maxRadius) return null;
  const p = (coords: number[]): THREE.Vector3 => new THREE.Vector3(coords[0], coords[1], coords[2]);
  const at = (axis: number, value: number, b: number, bv: number, c: number, cv: number): THREE.Vector3 => {
    const coords = [0, 0, 0];
    coords[axis] = value;
    coords[b] = bv;
    coords[c] = cv;
    return p(coords);
  };
  const polygons: THREE.Vector3[][] = [];
  for (const axis of [0, 1, 2]) {
    const [b, c] = [0, 1, 2].filter((i) => i !== axis);
    for (const side of [-1, 1]) {
      const value = side < 0 ? mins[axis] : maxs[axis];
      const b0 = mins[b], b1 = maxs[b], c0 = mins[c], c1 = maxs[c];
      polygons.push([
        at(axis, value, b, b0 + radius, c, c0 + radius),
        at(axis, value, b, b1 - radius, c, c0 + radius),
        at(axis, value, b, b1 - radius, c, c1 - radius),
        at(axis, value, b, b0 + radius, c, c1 - radius),
      ]);
    }
  }
  for (const axis of [0, 1, 2]) {
    const [b, c] = [0, 1, 2].filter((i) => i !== axis);
    const lo = mins[axis] + radius;
    const hi = maxs[axis] - radius;
    for (const sb of [-1, 1]) {
      for (const sc of [-1, 1]) {
        const bEdge = sb < 0 ? mins[b] : maxs[b];
        const cEdge = sc < 0 ? mins[c] : maxs[c];
        const bCut = bEdge - sb * radius;
        const cCut = cEdge - sc * radius;
        polygons.push([
          at(axis, lo, b, bCut, c, cEdge),
          at(axis, hi, b, bCut, c, cEdge),
          at(axis, hi, b, bEdge, c, cCut),
          at(axis, lo, b, bEdge, c, cCut),
        ]);
      }
    }
  }
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const xEdge = sx < 0 ? mins[0] : maxs[0];
        const yEdge = sy < 0 ? mins[1] : maxs[1];
        const zEdge = sz < 0 ? mins[2] : maxs[2];
        const xCut = xEdge - sx * radius;
        const yCut = yEdge - sy * radius;
        const zCut = zEdge - sz * radius;
        const a = new THREE.Vector3(xCut, yCut, zEdge);
        const b = new THREE.Vector3(xCut, yEdge, zCut);
        const c = new THREE.Vector3(xEdge, yCut, zCut);
        polygons.push([a, b, c]);
      }
    }
  }
  return brepFromNurbsPolygons(polygons);
}

function nativeBoxShellBrep(source: Brep, thickness: number): Brep | null {
  const bounds = axisBoxBoundsFromBrep(source);
  if (!bounds) return null;
  const { min: mn, max: mx } = bounds;
  const minDim = Math.min(mx.x - mn.x, mx.y - mn.y, mx.z - mn.z);
  if (thickness <= 0 || thickness >= minDim / 2) return null;
  const t = thickness;
  const xi0 = mn.x + t, xi1 = mx.x - t;
  const yi0 = mn.y + t, yi1 = mx.y - t;
  const zi0 = mn.z + t, zi1 = mx.z - t;
  const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  // Outer polygons — normals point outward from the solid
  const outerPolygons: THREE.Vector3[][] = [
    [v(mn.x, mn.y, mx.z), v(mx.x, mn.y, mx.z), v(mx.x, mx.y, mx.z), v(mn.x, mx.y, mx.z)], // +Z top
    [v(mn.x, mn.y, mn.z), v(mn.x, mx.y, mn.z), v(mx.x, mx.y, mn.z), v(mx.x, mn.y, mn.z)], // -Z bottom
    [v(mn.x, mx.y, mn.z), v(mn.x, mx.y, mx.z), v(mx.x, mx.y, mx.z), v(mx.x, mx.y, mn.z)], // +Y back
    [v(mn.x, mn.y, mn.z), v(mx.x, mn.y, mn.z), v(mx.x, mn.y, mx.z), v(mn.x, mn.y, mx.z)], // -Y front
    [v(mx.x, mn.y, mn.z), v(mx.x, mx.y, mn.z), v(mx.x, mx.y, mx.z), v(mx.x, mn.y, mx.z)], // +X right
    [v(mn.x, mn.y, mn.z), v(mn.x, mn.y, mx.z), v(mn.x, mx.y, mx.z), v(mn.x, mx.y, mn.z)], // -X left
  ];
  // Inner polygons — reversed winding so normals point into the hollow cavity
  const innerPolygons: THREE.Vector3[][] = [
    [v(xi0, yi1, zi1), v(xi1, yi1, zi1), v(xi1, yi0, zi1), v(xi0, yi0, zi1)], // inner top (normal -Z)
    [v(xi1, yi0, zi0), v(xi1, yi1, zi0), v(xi0, yi1, zi0), v(xi0, yi0, zi0)], // inner bottom (normal +Z)
    [v(xi1, yi1, zi0), v(xi1, yi1, zi1), v(xi0, yi1, zi1), v(xi0, yi1, zi0)], // inner +Y (normal -Y)
    [v(xi0, yi0, zi0), v(xi0, yi0, zi1), v(xi1, yi0, zi1), v(xi1, yi0, zi0)], // inner -Y (normal +Y)
    [v(xi1, yi1, zi0), v(xi1, yi0, zi0), v(xi1, yi0, zi1), v(xi1, yi1, zi1)], // inner +X (normal -X)
    [v(xi0, yi1, zi0), v(xi0, yi1, zi1), v(xi0, yi0, zi1), v(xi0, yi0, zi0)], // inner -X (normal +X)
  ];
  const outerBrep = brepFromNurbsPolygons(outerPolygons);
  const innerBrep = brepFromNurbsPolygons(innerPolygons);
  if (!outerBrep || !innerBrep) return null;
  return brepConcat(outerBrep, innerBrep);
}

function canonicalEdgeChamferDisplayResult(
  viewer: Viewer,
  obj: THREE.Object3D,
  worldA: THREE.Vector3,
  worldB: THREE.Vector3,
  radius: number,
  metadata: Record<string, unknown>,
): THREE.Mesh | null {
  const store = viewer.getCanonicalGeometryStore();
  const canonical = store.resolveObjectOrAncestor(obj);
  if (canonical?.kind !== "brep") return null;
  const carrier = linkedCanonicalCarrier(obj);
  carrier.updateMatrixWorld(true);
  const source = transformBrep(canonical.brep, threeMatrixToXform(carrier.matrixWorld));
  const brep = nativeBoxEdgeChamferBrep(source, worldA, worldB, radius);
  if (!brep) return null;
  const record = store.create({
    kind: "brep",
    brep,
    source: "edit",
    createdBy: "SdFillet",
    metadata: {
      ...metadata,
      source: canonical.id,
      derivation: "canonical-brep-edge-chamfer",
      conversion: "native-trimmed-nurbs-brep",
      displaySource: "canonical-brep",
    },
  });
  const display = objectFromCanonicalGeometry(record);
  if (!(display instanceof THREE.Mesh)) {
    store.delete(record.id);
    return null;
  }
  const position = display.geometry.getAttribute("position");
  record.displayMesh = {
    revision: 1,
    generatedAt: Date.now(),
    vertexCount: position?.count,
    triangleCount: display.geometry.index ? Math.floor(display.geometry.index.count / 3) : (position ? Math.floor(position.count / 3) : undefined),
    derivation: "tessellated-brep",
  };
  display.userData.kind = "brep";
  display.userData.creator = "SdFillet";
  display.userData.dispatchArgs = metadata;
  display.userData.booleanDisplaySource = "canonical-brep";
  store.linkObject(display, record.id);
  return display;
}

function canonicalAllEdgeChamferDisplayResult(
  viewer: Viewer,
  obj: THREE.Object3D,
  radius: number,
  metadata: Record<string, unknown>,
): THREE.Mesh | null {
  const store = viewer.getCanonicalGeometryStore();
  const canonical = store.resolveObjectOrAncestor(obj);
  if (canonical?.kind !== "brep") return null;
  const carrier = linkedCanonicalCarrier(obj);
  carrier.updateMatrixWorld(true);
  const source = transformBrep(canonical.brep, threeMatrixToXform(carrier.matrixWorld));
  const brep = nativeBoxAllEdgeChamferBrep(source, radius);
  if (!brep) return null;
  const record = store.create({
    kind: "brep",
    brep,
    source: "edit",
    createdBy: "SdFillet",
    metadata: {
      ...metadata,
      source: canonical.id,
      derivation: "canonical-brep-all-edge-chamfer",
      conversion: "native-trimmed-nurbs-brep",
      displaySource: "canonical-brep",
    },
  });
  const display = objectFromCanonicalGeometry(record);
  if (!(display instanceof THREE.Mesh)) {
    store.delete(record.id);
    return null;
  }
  const position = display.geometry.getAttribute("position");
  record.displayMesh = {
    revision: 1,
    generatedAt: Date.now(),
    vertexCount: position?.count,
    triangleCount: display.geometry.index ? Math.floor(display.geometry.index.count / 3) : (position ? Math.floor(position.count / 3) : undefined),
    derivation: "tessellated-brep",
  };
  display.userData.kind = "brep";
  display.userData.creator = "SdFillet";
  display.userData.dispatchArgs = metadata;
  display.userData.booleanDisplaySource = "canonical-brep";
  store.linkObject(display, record.id);
  return display;
}

function unsupportedNativeFilletError(operation: string): { error: string } {
  return {
    error: `SdFillet - ${operation} currently requires a supported canonical box-like BRep. Mesh-derived fallback is disabled so the command cannot create a fake canonical BRep result.`,
  };
}

function canonicalMultiEdgeChamferDisplayResult(
  viewer: Viewer,
  obj: THREE.Object3D,
  edgeCoords: Array<[THREE.Vector3, THREE.Vector3]>,
  radius: number,
  metadata: Record<string, unknown>,
): THREE.Mesh | null {
  const store = viewer.getCanonicalGeometryStore();
  const canonical = store.resolveObjectOrAncestor(obj);
  if (canonical?.kind !== "brep") return null;
  const carrier = linkedCanonicalCarrier(obj);
  carrier.updateMatrixWorld(true);
  let brep = transformBrep(canonical.brep, threeMatrixToXform(carrier.matrixWorld));
  for (const [worldA, worldB] of edgeCoords) {
    const next = nativeBoxEdgeChamferBrep(brep, worldA, worldB, radius);
    if (!next) return null;
    brep = next;
  }
  const record = store.create({
    kind: "brep",
    brep,
    source: "edit",
    createdBy: "SdFillet",
    metadata: {
      ...metadata,
      source: canonical.id,
      derivation: "canonical-brep-multi-edge-chamfer",
      conversion: "native-trimmed-nurbs-brep",
      displaySource: "canonical-brep",
    },
  });
  const display = objectFromCanonicalGeometry(record);
  if (!(display instanceof THREE.Mesh)) {
    store.delete(record.id);
    return null;
  }
  const position = display.geometry.getAttribute("position");
  record.displayMesh = {
    revision: 1,
    generatedAt: Date.now(),
    vertexCount: position?.count,
    triangleCount: display.geometry.index
      ? Math.floor(display.geometry.index.count / 3)
      : (position ? Math.floor(position.count / 3) : undefined),
    derivation: "tessellated-brep",
  };
  display.userData.kind = "brep";
  display.userData.creator = "SdFillet";
  display.userData.dispatchArgs = metadata;
  display.userData.booleanDisplaySource = "canonical-brep";
  store.linkObject(display, record.id);
  return display;
}

function canonicalShellDisplayResult(
  viewer: Viewer,
  obj: THREE.Object3D,
  thickness: number,
  metadata: Record<string, unknown>,
): THREE.Mesh | null {
  const store = viewer.getCanonicalGeometryStore();
  const canonical = store.resolveObjectOrAncestor(obj);
  if (canonical?.kind !== "brep") return null;
  const carrier = linkedCanonicalCarrier(obj);
  carrier.updateMatrixWorld(true);
  const source = transformBrep(canonical.brep, threeMatrixToXform(carrier.matrixWorld));
  const brep = nativeBoxShellBrep(source, thickness);
  if (!brep) return null;
  const record = store.create({
    kind: "brep",
    brep,
    source: "edit",
    createdBy: "SdShell",
    metadata: {
      ...metadata,
      source: canonical.id,
      derivation: "canonical-brep-shell",
      conversion: "native-trimmed-nurbs-brep",
      displaySource: "canonical-brep",
    },
  });
  const display = objectFromCanonicalGeometry(record);
  if (!(display instanceof THREE.Mesh)) {
    store.delete(record.id);
    return null;
  }
  const position = display.geometry.getAttribute("position");
  record.displayMesh = {
    revision: 1,
    generatedAt: Date.now(),
    vertexCount: position?.count,
    triangleCount: display.geometry.index
      ? Math.floor(display.geometry.index.count / 3)
      : (position ? Math.floor(position.count / 3) : undefined),
    derivation: "tessellated-brep",
  };
  display.userData.kind = "brep";
  display.userData.creator = "SdShell";
  display.userData.dispatchArgs = metadata;
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
  const explicit = byTarget ?? getSelected()?.transformTarget ?? viewer.getActiveObject();
  if (explicit) return explicit;
  // Single-object fallback: when nothing is selected, auto-target the only
  // dispatch-created object in the scene to avoid "no selection" no-ops.
  const transformable: THREE.Object3D[] = [];
  viewer.getScene().traverse((obj) => {
    const ud = obj.userData as Record<string, unknown>;
    if (ud.kind && typeof ud.kind === "string") transformable.push(obj);
  });
  return transformable.length === 1 ? transformable[0] : null;
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

  registerHandler("SdMirror", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdMirror requires target" };
    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdMirror — target not found: ${targetId}` };
    if (!(obj instanceof THREE.Mesh)) return { error: "SdMirror — target is not a renderable mesh" };

    const planeName = (args.plane_name as string | undefined)?.toUpperCase() ?? "XY";
    const normalArg = Array.isArray(args.normal) ? (args.normal as number[]) : null;
    const originArg = Array.isArray(args.origin) ? (args.origin as number[]) : null;

    let nx: number, ny: number, nz: number;
    if (normalArg && normalArg.length >= 3) {
      const nv = new THREE.Vector3(normalArg[0] ?? 0, normalArg[1] ?? 0, normalArg[2] ?? 1).normalize();
      nx = nv.x; ny = nv.y; nz = nv.z;
    } else if (planeName === "YZ") {
      nx = 1; ny = 0; nz = 0;
    } else if (planeName === "XZ") {
      nx = 0; ny = 1; nz = 0;
    } else {
      nx = 0; ny = 0; nz = 1;
    }
    const ox = originArg ? (originArg[0] ?? 0) : 0;
    const oy = originArg ? (originArg[1] ?? 0) : 0;
    const oz = originArg ? (originArg[2] ?? 0) : 0;

    // Reflection matrix: R = I - 2*n*n^T, translation = 2*(n·o)*n
    const r00 = 1 - 2*nx*nx, r01 = -2*nx*ny, r02 = -2*nx*nz;
    const r10 = -2*ny*nx, r11 = 1 - 2*ny*ny, r12 = -2*ny*nz;
    const r20 = -2*nz*nx, r21 = -2*nz*ny, r22 = 1 - 2*nz*nz;
    const dot2 = 2 * (nx*ox + ny*oy + nz*oz);
    const reflectMat = new THREE.Matrix4().set(
      r00, r01, r02, nx*dot2,
      r10, r11, r12, ny*dot2,
      r20, r21, r22, nz*dot2,
      0, 0, 0, 1,
    );

    // Build display mesh by reflecting source geometry vertices directly.
    // objectFromCanonicalGeometry on a det=-1 BRep produces winding cancellation;
    // vertex-level reflection is reliable and preserves correct divergence-theorem signs.
    const geo = obj.geometry.clone();
    const posAttr = geo.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < posAttr.count; i++) {
      const v = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      v.applyMatrix4(reflectMat);
      posAttr.setXYZ(i, v.x, v.y, v.z);
    }
    posAttr.needsUpdate = true;
    // Flip face winding so outward normals remain consistent after reflection (det=-1)
    if (geo.index) {
      const idx = geo.index;
      for (let i = 0; i < idx.count; i += 3) {
        const b = idx.getX(i + 1);
        const c = idx.getX(i + 2);
        idx.setX(i + 1, c);
        idx.setX(i + 2, b);
      }
      idx.needsUpdate = true;
    }
    geo.computeVertexNormals();
    const display = new THREE.Mesh(geo, obj.material);
    display.userData.kind = "brep";
    display.userData.creator = "SdMirror";
    display.userData.dispatchArgs = args;

    const store = viewer.getCanonicalGeometryStore();
    const canonical = store.resolveObjectOrAncestor(obj);
    if (canonical?.kind === "brep") {
      obj.updateMatrixWorld(true);
      const worldBrep = transformBrep(canonical.brep, threeMatrixToXform(obj.matrixWorld));
      const mirroredBrep = transformBrep(worldBrep, threeMatrixToXform(reflectMat));
      const record = store.create({
        kind: "brep",
        brep: mirroredBrep,
        source: "edit",
        createdBy: "SdMirror",
        metadata: {
          operation: "mirror",
          source: canonical.id,
          plane: normalArg ? "custom" : planeName,
          normal: [nx, ny, nz],
          origin: [ox, oy, oz],
          derivation: "reflected-display-mesh",
        },
      });
      record.displayMesh = {
        revision: 1,
        generatedAt: Date.now(),
        vertexCount: posAttr.count,
        triangleCount: geo.index
          ? Math.floor(geo.index.count / 3)
          : Math.floor(posAttr.count / 3),
        derivation: "tessellated-brep",
      };
      store.linkObject(display, record.id);
    }

    viewer.addMesh(display, "brep");
    return { created: display.uuid, plane: normalArg ? "custom" : planeName, normal: [nx, ny, nz], origin: [ox, oy, oz] };
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
    const batchObjs: THREE.Object3D[] = [];
    const ids: string[] = [];
    for (let i = 1; i < count; i++) {
      const clone = sel.clone();
      clone.position.x += dx * i; clone.position.y += dy * i; clone.position.z += dz * i;
      clone.userData = { ...sel.userData };
      viewer.addMesh(clone as THREE.Mesh, "brep", { noHistory: true });
      replayCloneSideEffects(clone, viewer.getScene());
      batchObjs.push(clone);
      ids.push(clone.uuid);
    }
    if (batchObjs.length > 0) pushBatchAction(batchObjs, "SdArrayLinear");
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
    const batchObjs: THREE.Object3D[] = [];
    const ids: string[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r === 0 && c === 0) continue;
        const clone = sel.clone();
        clone.position.x += dx * c; clone.position.y += dy * r;
        clone.userData = { ...sel.userData };
        viewer.addMesh(clone as THREE.Mesh, "brep", { noHistory: true });
        replayCloneSideEffects(clone, viewer.getScene());
        batchObjs.push(clone);
        ids.push(clone.uuid);
      }
    }
    if (batchObjs.length > 0) pushBatchAction(batchObjs, "SdArrayGrid");
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
    const batchObjs: THREE.Object3D[] = [];
    const ids: string[] = [];
    for (let i = 1; i < count; i++) {
      const a = (totalAngle / count) * i;
      const clone = sel.clone();
      clone.position.x = cx + ox * Math.cos(a) - oy * Math.sin(a);
      clone.position.y = cy + ox * Math.sin(a) + oy * Math.cos(a);
      clone.userData = { ...sel.userData };
      viewer.addMesh(clone as THREE.Mesh, "brep", { noHistory: true });
      replayCloneSideEffects(clone, viewer.getScene());
      batchObjs.push(clone);
      ids.push(clone.uuid);
    }
    if (batchObjs.length > 0) pushBatchAction(batchObjs, "SdArrayPolar");
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
    if (canonicalResult && !(canonicalResult instanceof THREE.Mesh)) return { error: canonicalResult.error };
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
    if (canonicalResult && !(canonicalResult instanceof THREE.Mesh)) return { error: canonicalResult.error };
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

  // §WEB-CAD#246: short-form boolean verbs
  registerHandler("SdBoolUnion", (args) =>
    _doBoolOp(args.a as string | undefined, args.b as string | undefined, "union")
  );

  registerHandler("SdBoolSubtract", (args) =>
    _doBoolOp(args.outer as string | undefined, args.inner as string | undefined, "difference")
  );

  registerHandler("SdBoolIntersect", (args) =>
    _doBoolOp(args.a as string | undefined, args.b as string | undefined, "intersection")
  );

  registerHandler("SdFillet", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdFillet - target is required" };
    const radius = args.radius as number | undefined;
    if (radius === undefined || radius === null) return { error: "SdFillet - radius is required" };
    if (!Number.isFinite(radius) || radius <= 0) return { error: `SdFillet - radius must be a positive number, got: ${radius}` };
    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdFillet - target not found: ${targetId}` };
    if (!(obj instanceof THREE.Mesh)) return { error: "SdFillet - target is not a Mesh" };
    const edgeId = args.edgeId as number | undefined;
    const edgesArr = (args.edges as number[] | undefined) ?? [];
    const edgeFrom = args.edgeFrom as number[] | undefined;
    const edgeTo = args.edgeTo as number[] | undefined;
    let filleted: THREE.Mesh;
    let edgeCount: number | "all" = "all";
    if (edgesArr.length > 0) {
      const uniqueEdges = getUniqueEdges(obj);
      const edgeCoords: Array<[THREE.Vector3, THREE.Vector3]> = [];
      for (const eid of edgesArr) {
        if (eid < 0 || eid >= uniqueEdges.length) {
          return { error: `SdFillet - edgeId ${eid} out of range [0, ${uniqueEdges.length - 1}]` };
        }
        const [localA, localB] = uniqueEdges[eid];
        edgeCoords.push([
          localA.clone().applyMatrix4(obj.matrixWorld),
          localB.clone().applyMatrix4(obj.matrixWorld),
        ]);
      }
      const operation = { operation: "multi-edge-chamfer", edges: edgesArr, radius };
      const canonicalFillet = canonicalMultiEdgeChamferDisplayResult(viewer, obj, edgeCoords, radius, operation);
      if (!canonicalFillet) return unsupportedNativeFilletError("multi-edge chamfer");
      filleted = canonicalFillet;
      edgeCount = edgesArr.length;
    } else if (edgeId !== undefined && edgeId !== null) {
      const edges = getUniqueEdges(obj);
      if (edgeId < 0 || edgeId >= edges.length) {
        return { error: `SdFillet - edgeId ${edgeId} out of range [0, ${edges.length - 1}]` };
      }
      const [localA, localB] = edges[edgeId];
      const worldA = localA.clone().applyMatrix4(obj.matrixWorld);
      const worldB = localB.clone().applyMatrix4(obj.matrixWorld);
      const operation = { operation: "edge-chamfer", edgeId, radius };
      const canonicalFillet = canonicalEdgeChamferDisplayResult(viewer, obj, worldA, worldB, radius, operation);
      if (!canonicalFillet) return unsupportedNativeFilletError("selected-edge chamfer");
      filleted = canonicalFillet;
      edgeCount = 1;
    } else if (edgeFrom && edgeTo) {
      const worldA = new THREE.Vector3(edgeFrom[0] ?? 0, edgeFrom[1] ?? 0, edgeFrom[2] ?? 0);
      const worldB = new THREE.Vector3(edgeTo[0] ?? 0, edgeTo[1] ?? 0, edgeTo[2] ?? 0);
      const operation = { operation: "edge-chamfer", edgeFrom, edgeTo, radius };
      const canonicalFillet = canonicalEdgeChamferDisplayResult(viewer, obj, worldA, worldB, radius, operation);
      if (!canonicalFillet) return unsupportedNativeFilletError("selected-edge chamfer");
      filleted = canonicalFillet;
      edgeCount = 1;
    } else {
      const operation = { operation: "all-edge-fillet", radius };
      const canonicalFillet = canonicalAllEdgeChamferDisplayResult(viewer, obj, radius, operation);
      if (!canonicalFillet) return unsupportedNativeFilletError("all-edge chamfer");
      filleted = canonicalFillet;
    }
    viewer.getScene().remove(obj); // audit-undo-ok: tracked by pushReplaceAction below
    viewer.addMesh(filleted, "brep", { noHistory: true });
    pushReplaceAction(filleted, [obj], "fillet");
    return { modified: filleted.uuid, edgeCount };
  });

  registerHandler("SdChamfer", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdChamfer - target is required" };
    const distance = (args.distance as number | undefined) ?? (args.radius as number | undefined);
    if (distance === undefined || distance === null) return { error: "SdChamfer - distance is required" };
    if (!Number.isFinite(distance) || distance <= 0) return { error: `SdChamfer - distance must be a positive number, got: ${distance}` };
    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdChamfer - target not found: ${targetId}` };
    if (!(obj instanceof THREE.Mesh)) return { error: "SdChamfer - target is not a Mesh" };
    const edgeId = args.edgeId as number | undefined;
    const edgesArr = (args.edges as number[] | undefined) ?? [];
    let filleted: THREE.Mesh;
    let edgeCount: number | "all" = "all";
    if (edgesArr.length > 0) {
      const uniqueEdges = getUniqueEdges(obj);
      const edgeCoords: Array<[THREE.Vector3, THREE.Vector3]> = [];
      for (const eid of edgesArr) {
        if (eid < 0 || eid >= uniqueEdges.length) {
          return { error: `SdChamfer - edgeId ${eid} out of range [0, ${uniqueEdges.length - 1}]` };
        }
        const [localA, localB] = uniqueEdges[eid];
        edgeCoords.push([
          localA.clone().applyMatrix4(obj.matrixWorld),
          localB.clone().applyMatrix4(obj.matrixWorld),
        ]);
      }
      const operation = { operation: "chamfer-multi-edge", edges: edgesArr, distance };
      const result = canonicalMultiEdgeChamferDisplayResult(viewer, obj, edgeCoords, distance, operation);
      if (!result) return { error: `SdChamfer - multi-edge chamfer requires a supported canonical box-like BRep` };
      filleted = result;
      edgeCount = edgesArr.length;
    } else if (edgeId !== undefined && edgeId !== null) {
      const edges = getUniqueEdges(obj);
      if (edgeId < 0 || edgeId >= edges.length) {
        return { error: `SdChamfer - edgeId ${edgeId} out of range [0, ${edges.length - 1}]` };
      }
      const [localA, localB] = edges[edgeId];
      const worldA = localA.clone().applyMatrix4(obj.matrixWorld);
      const worldB = localB.clone().applyMatrix4(obj.matrixWorld);
      const operation = { operation: "chamfer-edge", edgeId, distance };
      const result = canonicalEdgeChamferDisplayResult(viewer, obj, worldA, worldB, distance, operation);
      if (!result) return { error: `SdChamfer - edge chamfer requires a supported canonical box-like BRep` };
      filleted = result;
      edgeCount = 1;
    } else {
      const operation = { operation: "chamfer-all", distance };
      const result = canonicalAllEdgeChamferDisplayResult(viewer, obj, distance, operation);
      if (!result) return { error: `SdChamfer - all-edge chamfer requires a supported canonical box-like BRep` };
      filleted = result;
    }
    viewer.getScene().remove(obj); // audit-undo-ok: tracked by pushReplaceAction below
    viewer.addMesh(filleted, "brep", { noHistory: true });
    pushReplaceAction(filleted, [obj], "chamfer");
    return { modified: filleted.uuid, edgeCount };
  });

  registerHandler("SdShell", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdShell - target is required" };
    const thickness = args.thickness as number | undefined;
    if (thickness === undefined || thickness === null) return { error: "SdShell - thickness is required" };
    if (!Number.isFinite(thickness) || thickness <= 0) return { error: `SdShell - thickness must be positive, got: ${thickness}` };
    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdShell - target not found: ${targetId}` };
    if (!(obj instanceof THREE.Mesh)) return { error: "SdShell - target is not a Mesh" };
    const operation = { operation: "shell", thickness };
    const shelled = canonicalShellDisplayResult(viewer, obj, thickness, operation);
    if (!shelled) return { error: "SdShell - requires a supported canonical box-like BRep. Thickness must be less than half the smallest dimension." };
    viewer.getScene().remove(obj); // audit-undo-ok: tracked by pushReplaceAction below
    viewer.addMesh(shelled, "brep", { noHistory: true });
    pushReplaceAction(shelled, [obj], "shell");
    return { modified: shelled.uuid, thickness };
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

  registerHandler("SdDeselect", () => {
    clearSelected();
    clearMultiSelected();
    viewer.selectObject(null);
    window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: null } }));
    return { deselected: true };
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
