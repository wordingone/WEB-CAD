import * as THREE from "three";
import type { CanonicalGeometryStore } from "../geometry/canonical-geometry";
import { tessellate } from "../nurbs/nurbs-curves";
import { pointAtUV } from "../nurbs/nurbs-surfaces";
import type { Brep, BrepFace } from "../nurbs/nurbs-brep";

function pushSegment(points: number[], a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): void {
  points.push(a.x, a.y, a.z, b.x, b.y, b.z);
}

function pushCurveSegments(points: number[], curve: Parameters<typeof tessellate>[0], samples = 16): void {
  if (curve.kind === "line") {
    pushSegment(points, curve.from, curve.to);
    return;
  }
  if (curve.kind === "polyline") {
    for (let i = 0; i + 1 < curve.points.length; i++) pushSegment(points, curve.points[i], curve.points[i + 1]);
    return;
  }
  const pts = tessellate(curve, samples);
  for (let i = 0; i + 1 < pts.length; i++) pushSegment(points, pts[i], pts[i + 1]);
}

function pushFaceTrimSegments(points: number[], face: BrepFace): void {
  for (const loop of [face.outerLoop, ...face.innerLoops]) {
    for (const curve of loop.curves) {
      if (curve.kind === "polyline") {
        const pts = curve.points.map((p) => pointAtUV(face.surface, p.x, p.y));
        for (let i = 0; i + 1 < pts.length; i++) pushSegment(points, pts[i], pts[i + 1]);
      } else {
        const pts = tessellate(curve, 16).map((p) => pointAtUV(face.surface, p.x, p.y));
        for (let i = 0; i + 1 < pts.length; i++) pushSegment(points, pts[i], pts[i + 1]);
      }
    }
  }
}

export function brepEdgeGeometry(brep: Brep): THREE.BufferGeometry | null {
  const points: number[] = [];
  for (const shell of brep.shells) {
    if (shell.edges.length > 0) {
      for (const edge of shell.edges) pushCurveSegments(points, edge.curve);
      continue;
    }
    for (const face of shell.faces) pushFaceTrimSegments(points, face);
  }
  if (points.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(points), 3));
  return geometry;
}

export function canonicalBrepEdgeGeometryForObject(
  store: CanonicalGeometryStore | undefined,
  obj: THREE.Object3D,
): THREE.BufferGeometry | null {
  const record = store?.resolveObject(obj);
  if (record?.kind !== "brep") return null;
  return brepEdgeGeometry(record.brep);
}
