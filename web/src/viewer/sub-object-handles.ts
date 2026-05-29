// Sub-object handle system for line / polyline / curve (#32).
// When a parent line/polyline/curve is selected, this module renders small
// sphere handles at each control point. Clicking a handle enters sub-object
// mode: the gumball attaches to the handle and dragging it stretches the
// parent geometry through the new control point position.

import * as THREE from "three";
import type { Viewer } from "./viewer.js";
import { createClampedUniformNurbs, createCatmullRomAsNurbs, tessellate, type NurbsCurve } from "../nurbs/nurbs-curves.js";
import type { Curve, LineCurve, PolylineCurve } from "../nurbs/nurbs-curves.js";
import type { SumSurface } from "../nurbs/nurbs-surfaces.js";
import { Interval as Iv } from "../nurbs/nurbs-primitives.js";
import { extrude as extrudeBrep } from "../nurbs/brep-extrude.js";
import { makeSnapId } from "./snap-state.js";
import type { CanonicalGeometryStore } from "../geometry/canonical-geometry.js";
import { transformBrep, type Brep } from "../nurbs/nurbs-brep.js";
import type { Point3, Xform } from "../nurbs/nurbs-primitives.js";
import { transformSurface } from "../nurbs/nurbs-surfaces.js";

const HANDLE_RADIUS = 0.06;

let _handles: THREE.Object3D[] = [];
let _parentObj: THREE.Object3D | null = null;

// Returns a group: outer dark sphere (outline) + inner white sphere (fill),
// matching the sketch cursor-dot visual (black outline + white fill).
function makeHandleMesh(pos: THREE.Vector3, index: number, parentUuid: string): THREE.Object3D {
  const group = new THREE.Group();
  group.position.copy(pos);
  group.renderOrder = 10;
  group.userData.isSubObjectHandle = true;
  group.userData.cpIndex = index;
  group.userData.parentUuid = parentUuid;

  const outerGeom = new THREE.SphereGeometry(HANDLE_RADIUS * 1.5, 10, 7);
  const outerMat = new THREE.MeshBasicMaterial({ color: 0x111111, depthTest: false });
  const outerMesh = new THREE.Mesh(outerGeom, outerMat);
  outerMesh.renderOrder = 10;

  const innerGeom = new THREE.SphereGeometry(HANDLE_RADIUS, 10, 7);
  const innerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
  const innerMesh = new THREE.Mesh(innerGeom, innerMat);
  innerMesh.renderOrder = 11;

  group.add(outerMesh, innerMesh);
  return group;
}

export function showHandlesFor(parent: THREE.Object3D, viewer: Viewer): void {
  clearHandles(viewer);
  const cps = parent.userData.controlPoints as THREE.Vector3[] | undefined;
  if (!cps || cps.length === 0) return;
  _parentObj = parent;
  for (let i = 0; i < cps.length; i++) {
    const wp = parent.localToWorld(cps[i].clone());
    const h = makeHandleMesh(wp, i, parent.uuid);
    viewer.getScene().add(h);
    _handles.push(h);
  }
}

export function clearHandles(viewer: Viewer): void {
  for (const h of _handles) {
    viewer.getScene().remove(h);
    h.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    });
  }
  _handles = [];
  _parentObj = null;
}

export function getHandles(): THREE.Object3D[] { return _handles; }

export function getHandleParent(): THREE.Object3D | null { return _parentObj; }

export function isSubObjectHandle(obj: THREE.Object3D): boolean {
  return !!obj.userData.isSubObjectHandle;
}

function meshDisplayRevision(parent: THREE.Object3D): number {
  const existing = parent.userData.canonicalDisplayRevision;
  const revision = typeof existing === "number" ? existing + 1 : 2;
  parent.userData.canonicalDisplayRevision = revision;
  return revision;
}

function syncCanonicalCurve(parent: THREE.Object3D, store: CanonicalGeometryStore | undefined, curve: Curve): void {
  if (!store) return;
  const record = store.resolveObjectOrAncestor(parent);
  if (!record || record.kind !== "curve") return;
  store.upsert({
    ...record,
    curve,
    source: "edit",
    displayMesh: record.displayMesh
      ? { ...record.displayMesh, revision: meshDisplayRevision(parent), generatedAt: Date.now() }
      : undefined,
    metadata: {
      ...record.metadata,
      editedBy: "refitParentGeometry",
    },
  });
}

function syncCanonicalSurface(parent: THREE.Object3D, store: CanonicalGeometryStore | undefined, surface: SumSurface): void {
  if (!store) return;
  const record = store.resolveObjectOrAncestor(parent);
  if (!record || record.kind !== "surface") return;
  store.upsert({
    ...record,
    surface,
    source: "edit",
    displayMesh: record.displayMesh
      ? { ...record.displayMesh, revision: meshDisplayRevision(parent), generatedAt: Date.now() }
      : undefined,
    metadata: {
      ...record.metadata,
      editedBy: "refitParentGeometry",
    },
  });
}

function rectangleProfile(minX: number, maxX: number, minY: number, maxY: number): PolylineCurve {
  const points = [
    { x: minX, y: minY, z: 0 },
    { x: maxX, y: minY, z: 0 },
    { x: maxX, y: maxY, z: 0 },
    { x: minX, y: maxY, z: 0 },
    { x: minX, y: minY, z: 0 },
  ];
  const parameters = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    parameters.push(parameters[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  return { kind: "polyline", points, parameters };
}

function syncCanonicalWallBrep(
  parent: THREE.Object3D,
  store: CanonicalGeometryStore | undefined,
  length: number,
  thickness: number,
  height: number,
): void {
  if (!store) return;
  const record = store.resolveObjectOrAncestor(parent);
  if (!record || record.kind !== "brep") return;
  store.upsert({
    ...record,
    brep: extrudeBrep(rectangleProfile(-length / 2, length / 2, -thickness / 2, thickness / 2), { x: 0, y: 0, z: 1 }, height),
    source: "edit",
    displayMesh: record.displayMesh
      ? { ...record.displayMesh, revision: meshDisplayRevision(parent), generatedAt: Date.now() }
      : undefined,
    metadata: {
      ...record.metadata,
      editedBy: "refitParentGeometry",
    },
  });
}

// Rebuild the parent mesh's geometry in-place after a control point has moved.
// Works for line (2 CPs), polyline (N CPs), curve/spline (N CPs via B-spline),
// and wall Mesh/Group (Group = void-cut wall: only transform updates, no segment rebuild).
export function refitParentGeometry(parent: THREE.Object3D, canonicalStore?: CanonicalGeometryStore): void {
  const cps = parent.userData.controlPoints as THREE.Vector3[] | undefined;
  if (!cps || cps.length < 2) return;
  const creator = parent.userData.creator as string;

  // Wall branch — handled before the geometry guard so Group (void-cut) walls work too.
  if (creator === "wall" && cps.length >= 2) {
    const t = (parent.userData.wallThickness as number | undefined) ?? 0.2;
    const h = (parent.userData.wallHeight as number | undefined) ?? 3;
    parent.updateMatrixWorld(true);
    const wA = cps[0].clone().applyMatrix4(parent.matrixWorld);
    const wB = cps[1].clone().applyMatrix4(parent.matrixWorld);
    const len = wA.distanceTo(wB);
    if (len < 0.01) return;
    const cx = (wA.x + wB.x) / 2, cy = (wA.y + wB.y) / 2;
    const angRad = Math.atan2(wB.y - wA.y, wB.x - wA.x);
    if (parent instanceof THREE.Mesh) {
      const wallGeom = new THREE.BoxGeometry(len, t, h);
      wallGeom.translate(0, 0, h / 2);
      parent.geometry.dispose();
      parent.geometry = wallGeom;
    }
    // Both Mesh and Group: update transform + snap data.
    parent.position.set(cx, cy, 0);
    parent.rotation.z = angRad;
    parent.updateMatrixWorld(true);
    cps[0].set(-len / 2, 0, 0);
    cps[1].set(len / 2, 0, 0);
    parent.userData.endpoints = [
      { x: wA.x, y: wA.y, z: 0, id: makeSnapId(wA.x, wA.y, 0) },
      { x: wB.x, y: wB.y, z: 0, id: makeSnapId(wB.x, wB.y, 0) },
    ];
    // §WEB-CAD#30 G7: keep nurbsSurface in sync (front face, local space).
    const cU: LineCurve = { kind: "line", from: {x:0,y:0,z:0}, to: {x:len,y:0,z:0}, domain: Iv.create(0,len) };
    const cV: LineCurve = { kind: "line", from: {x:0,y:0,z:0}, to: {x:0,y:0,z:h}, domain: Iv.create(0,h) };
    const ss: SumSurface = { kind: "sum", curveU: cU, curveV: cV, basepoint: {x:-len/2,y:t/2,z:0} };
    parent.userData.nurbsSurface = ss;
    parent.userData.nurbsKind = "surface";
    syncCanonicalSurface(parent, canonicalStore, ss);
    syncCanonicalWallBrep(parent, canonicalStore, len, t, h);
    return;
  }

  // Non-wall curves: require a geometry object.
  const obj = parent as THREE.Object3D & { geometry?: THREE.BufferGeometry };
  if (!obj.geometry) return;

  let newGeom: THREE.BufferGeometry | null = null;
  if (creator === "line" && cps.length === 2) {
    newGeom = new THREE.BufferGeometry().setFromPoints([cps[0], cps[1]]);
    // §WEB-CAD#30 G7: keep nurbsCurve in sync (local-space CVs).
    const nc: NurbsCurve = {
      kind: "nurbs", dim: 3, isRational: false,
      order: 2, cvCount: 2,
      knots: [0, 1],
      cvs: [cps[0].x, cps[0].y, cps[0].z, cps[1].x, cps[1].y, cps[1].z],
      cvStride: 3,
    };
    parent.userData.nurbsCurve = nc;
    parent.userData.nurbsDegree = 1;
    syncCanonicalCurve(parent, canonicalStore, nc);
  } else if (creator === "polyline") {
    newGeom = new THREE.BufferGeometry().setFromPoints(cps);
    const points = cps.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const parameters = [0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      parameters.push(parameters[i - 1] + Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2));
    }
    syncCanonicalCurve(parent, canonicalStore, { kind: "polyline", points, parameters });
  } else if (creator === "curve") {
    // Curve tool: Catmull-Rom — handle positions ARE the data points.
    const isClosed = !!(parent.userData.isClosed as boolean | undefined);
    const sampleCount = Math.max(cps.length * 16, 64);
    const dataPts = cps.map((v) => ({ x: v.x, y: v.y, z: v.z }));
    const nurbs = createCatmullRomAsNurbs(dataPts, { closed: isClosed });
    const raw = tessellate(nurbs, sampleCount + 1);
    newGeom = new THREE.BufferGeometry().setFromPoints(raw.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
    syncCanonicalCurve(parent, canonicalStore, nurbs);
  } else if (creator === "spline") {
    // Spline tool: approximating — handles are NURBS control points (curve pulled toward them).
    const isClosed = !!(parent.userData.isClosed as boolean | undefined);
    const degree = Math.min((parent.userData.nurbsDegree as number | undefined) ?? 3, cps.length - 1);
    const order = degree + 1;
    const wrapped = isClosed && cps.length >= order ? [...cps, ...cps.slice(0, degree)] : cps;
    const nurbsPts = wrapped.map((v) => ({ x: v.x, y: v.y, z: v.z }));
    const nurbs = createClampedUniformNurbs(3, order, nurbsPts);
    const sampleCount = Math.max(cps.length * 16, 64);
    const raw = tessellate(nurbs, sampleCount);
    const sampled = raw.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    if (isClosed && sampled.length > 1) sampled[sampled.length - 1].copy(sampled[0]);
    newGeom = new THREE.BufferGeometry().setFromPoints(sampled);
    // §WEB-CAD#30 G7: keep nurbsCurve in sync.
    parent.userData.nurbsCurve = nurbs;
    parent.userData.nurbsDegree = degree;
    parent.userData.nurbsCVs = nurbs.cvs;
    syncCanonicalCurve(parent, canonicalStore, nurbs);
  }

  if (!newGeom) return;
  obj.geometry.dispose();
  obj.geometry = newGeom;
}

// Apply a world-space translation delta to a set of vertex indices on a BRep mesh.
// Restores from snapshotPositions first (drag-start state) so the total delta from
// dWorld is applied idempotently across the drag frames — no per-frame drift.
export function deformBrepSubObject(
  parent: THREE.Mesh,
  affectedVertexIndices: number[],
  worldDelta: THREE.Vector3,
  snapshotPositions: Float32Array | undefined,
  store?: CanonicalGeometryStore,
  subObject?: { topology?: string; faceIndex?: number; edgeIndex?: number; vertexIndex?: number },
): void {
  const pos = parent.geometry.getAttribute("position") as THREE.BufferAttribute;

  if (snapshotPositions) {
    (pos.array as Float32Array).set(snapshotPositions);
  }

  parent.updateMatrixWorld(true);
  const localDelta = worldDelta.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(parent.matrixWorld).invert());
  const selectedLocalPoints = affectedVertexIndices.map((vi) => ({
    x: pos.getX(vi),
    y: pos.getY(vi),
    z: pos.getZ(vi),
  }));

  for (const vi of affectedVertexIndices) {
    pos.setXYZ(vi, pos.getX(vi) + localDelta.x, pos.getY(vi) + localDelta.y, pos.getZ(vi) + localDelta.z);
  }

  pos.needsUpdate = true;
  parent.geometry.computeVertexNormals();
  parent.geometry.computeBoundingSphere();
  parent.geometry.computeBoundingBox();

  if (store) {
    const record = store.resolveObjectOrAncestor(parent);
    if (record?.kind === "brep") {
      const nextBrep = deformCanonicalBrep(record.brep, subObject, localDelta, selectedLocalPoints);
      store.upsert({
        ...record,
        brep: nextBrep,
        source: "edit",
        displayMesh: record.displayMesh
          ? { ...record.displayMesh, revision: meshDisplayRevision(parent), generatedAt: Date.now() }
          : undefined,
        metadata: {
          ...record.metadata,
          editedBy: "deformBrepSubObject",
          deformTopology: subObject?.topology ?? "display-vertices",
        },
      });
    }
  }
}

function translationXform(delta: THREE.Vector3): Xform {
  return { m: [1, 0, 0, delta.x, 0, 1, 0, delta.y, 0, 0, 1, delta.z, 0, 0, 0, 1] };
}

function addDelta(p: Point3, delta: THREE.Vector3): Point3 {
  return { x: p.x + delta.x, y: p.y + delta.y, z: p.z + delta.z };
}

function pointNear(a: Point3, b: Point3, tolerance = 1e-5): boolean {
  return Math.abs(a.x - b.x) <= tolerance
    && Math.abs(a.y - b.y) <= tolerance
    && Math.abs(a.z - b.z) <= tolerance;
}

function pointInSet(point: Point3, selectedLocalPoints: Point3[]): boolean {
  return selectedLocalPoints.some((selected) => pointNear(point, selected));
}

function moveCurveEndpoints(curve: Curve, delta: THREE.Vector3): Curve {
  switch (curve.kind) {
    case "line":
      return { ...curve, from: addDelta(curve.from, delta), to: addDelta(curve.to, delta) };
    case "polyline":
      return { ...curve, points: curve.points.map((point) => addDelta(point, delta)) };
    case "arc":
      return {
        ...curve,
        center: addDelta(curve.center, delta),
        plane: { ...curve.plane, origin: addDelta(curve.plane.origin, delta) },
      };
    case "nurbs": {
      const cvs = [...curve.cvs];
      for (let i = 0; i < curve.cvCount; i++) {
        const base = i * curve.cvStride;
        const w = curve.isRational ? cvs[base + curve.dim] ?? 1 : 1;
        cvs[base] = (cvs[base] ?? 0) + delta.x * w;
        cvs[base + 1] = (cvs[base + 1] ?? 0) + delta.y * w;
        cvs[base + 2] = (cvs[base + 2] ?? 0) + delta.z * w;
      }
      return { ...curve, cvs };
    }
  }
}

function moveCurveSelectedPoints(curve: Curve, selectedLocalPoints: Point3[], delta: THREE.Vector3): Curve {
  switch (curve.kind) {
    case "line": {
      const fromSelected = pointInSet(curve.from, selectedLocalPoints);
      const toSelected = pointInSet(curve.to, selectedLocalPoints);
      if (!fromSelected && !toSelected) return curve;
      return {
        ...curve,
        from: fromSelected ? addDelta(curve.from, delta) : curve.from,
        to: toSelected ? addDelta(curve.to, delta) : curve.to,
      };
    }
    case "polyline": {
      const points = curve.points.map((point) => pointInSet(point, selectedLocalPoints) ? addDelta(point, delta) : point);
      return points.some((point, index) => point !== curve.points[index]) ? { ...curve, points } : curve;
    }
    case "arc":
      return pointInSet(curve.center, selectedLocalPoints) ? moveCurveEndpoints(curve, delta) : curve;
    case "nurbs": {
      let changed = false;
      const cvs = [...curve.cvs];
      for (let i = 0; i < curve.cvCount; i++) {
        const base = i * curve.cvStride;
        const w = curve.isRational ? cvs[base + curve.dim] ?? 1 : 1;
        const point = { x: (cvs[base] ?? 0) / w, y: (cvs[base + 1] ?? 0) / w, z: (cvs[base + 2] ?? 0) / w };
        if (!pointInSet(point, selectedLocalPoints)) continue;
        cvs[base] = (cvs[base] ?? 0) + delta.x * w;
        cvs[base + 1] = (cvs[base + 1] ?? 0) + delta.y * w;
        cvs[base + 2] = (cvs[base + 2] ?? 0) + delta.z * w;
        changed = true;
      }
      return changed ? { ...curve, cvs } : curve;
    }
  }
}

function deformCanonicalBrep(
  brep: Brep,
  subObject: { topology?: string; faceIndex?: number; edgeIndex?: number; vertexIndex?: number } | undefined,
  localDelta: THREE.Vector3,
  selectedLocalPoints: Point3[],
): Brep {
  if (!subObject?.topology) return transformBrep(brep, translationXform(localDelta));
  if (subObject.topology === "face" && typeof subObject.faceIndex === "number") {
    let globalFaceIndex = 0;
    return {
      shells: brep.shells.map((shell) => {
        const shellFaceBase = globalFaceIndex;
        globalFaceIndex += shell.faces.length;
        const localFaceIndex = subObject.faceIndex! - shellFaceBase;
        if (localFaceIndex < 0 || localFaceIndex >= shell.faces.length) return shell;
        return {
          ...shell,
          faces: shell.faces.map((face, faceIndex) => faceIndex === localFaceIndex
            ? { ...face, surface: transformSurface(face.surface, translationXform(localDelta)) }
            : face),
          edges: shell.edges.map((edge) => (edge.faceIndex1 === localFaceIndex || edge.faceIndex2 === localFaceIndex)
            ? { ...edge, curve: moveCurveEndpoints(edge.curve, localDelta) }
            : edge),
          vertices: shell.vertices.map((vertex) => vertex.edgeIndices.some((edgeIndex) => {
            const edge = shell.edges[edgeIndex];
            return edge && (edge.faceIndex1 === localFaceIndex || edge.faceIndex2 === localFaceIndex);
          }) ? { ...vertex, point: addDelta(vertex.point, localDelta) } : vertex),
        };
      }),
    };
  }
  if (subObject.topology === "edge") {
    return {
      shells: brep.shells.map((shell) => ({
        ...shell,
        edges: shell.edges.map((edge) => {
          const curve = moveCurveSelectedPoints(edge.curve, selectedLocalPoints, localDelta);
          return curve === edge.curve ? edge : { ...edge, curve };
        }),
        vertices: shell.vertices.map((vertex) => pointInSet(vertex.point, selectedLocalPoints)
          ? { ...vertex, point: addDelta(vertex.point, localDelta) }
          : vertex),
      })),
    };
  }
  if (subObject.topology === "vertex") {
    return {
      shells: brep.shells.map((shell) => ({
        ...shell,
        edges: shell.edges.map((edge) => {
          const curve = moveCurveSelectedPoints(edge.curve, selectedLocalPoints, localDelta);
          return curve === edge.curve ? edge : { ...edge, curve };
        }),
        vertices: shell.vertices.map((vertex) => pointInSet(vertex.point, selectedLocalPoints)
          ? { ...vertex, point: addDelta(vertex.point, localDelta) }
          : vertex),
      })),
    };
  }
  return transformBrep(brep, translationXform(localDelta));
}
