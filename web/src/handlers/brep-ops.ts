import { registerHandler } from "../commands/dispatch";
import { pushReplaceAction } from "../history";
import { BREP_DEFAULT_TOLERANCE, brepConcat, type Brep, type BrepEdge, type BrepFace, type BrepVertex } from "../nurbs/nurbs-brep";
import type { Curve } from "../nurbs/nurbs-curves";
import { transform as transformCurve } from "../nurbs/nurbs-curves";
import { Interval, type Point3, type Xform } from "../nurbs/nurbs-primitives";
import { Point3 as Pt3 } from "../nurbs/nurbs-primitives";
import { domainU, domainV, getNurbsForm, pointAtUV, tessellateSurface, transformSurface, type NurbsSurface, type PlaneSurface } from "../nurbs/nurbs-surfaces";
import type { Viewer } from "../viewer/viewer";
import * as THREE from "three";
import { linkCanonicalCurve } from "./canonical-surface";

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

function canonicalBrepForObject(viewer: Viewer, obj: THREE.Object3D): Brep | null {
  obj.updateMatrixWorld(true);
  const canonical = viewer.getCanonicalGeometryStore().resolveObjectOrAncestor(obj);
  if (canonical?.kind !== "brep") return null;
  return transformBrepForObject(canonical.brep, threeMatrixToXform(obj.matrixWorld));
}

function transformParamSpaceCurve(curve: Curve): Curve {
  return JSON.parse(JSON.stringify(curve)) as Curve;
}

function transformBrepForObject(brep: Brep, xform: Xform): Brep {
  return {
    shells: brep.shells.map((shell) => ({
      ...shell,
      faces: shell.faces.map((face) => ({
        ...face,
        surface: transformSurface(face.surface, xform),
        outerLoop: {
          ...face.outerLoop,
          curves: face.outerLoop.curves.map(transformParamSpaceCurve),
        },
        innerLoops: face.innerLoops.map((loop) => ({
          ...loop,
          curves: loop.curves.map(transformParamSpaceCurve),
        })),
      })),
      edges: shell.edges.map((edge) => ({
        ...edge,
        curve: transformCurve(edge.curve, xform),
      })),
      vertices: shell.vertices.map((vertex) => ({
        ...vertex,
        point: Pt3.transform(vertex.point, xform),
      })),
    })),
  };
}

function makeFaceGeometry(face: BrepFace): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const trim = face.outerLoop.curves[0];
  if (trim?.kind === "polyline" && trim.points.length >= 4) {
    const closed = trim.points.length > 1
      && Math.abs(trim.points[0].x - trim.points[trim.points.length - 1].x) < 1e-9
      && Math.abs(trim.points[0].y - trim.points[trim.points.length - 1].y) < 1e-9;
    const loop = closed ? trim.points.slice(0, -1) : trim.points;
    if (loop.length >= 3) {
      const world = loop.map((p) => pointAtUV(face.surface, p.x, p.y));
      const normal = faceNormal(world, face.orientation);
      for (const p of world) {
        positions.push(p.x, p.y, p.z);
        normals.push(normal.x, normal.y, normal.z);
      }
      for (let i = 1; i + 1 < loop.length; i++) indices.push(0, i, i + 1);
    }
  }
  if (positions.length === 0) {
    const tess = tessellateSurface(face.surface, 4, 4);
    positions.push(...tess.positions);
    normals.push(...tess.normals);
    indices.push(...tess.indices);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  geo.computeBoundingBox();
  return geo;
}

function makeBrepGeometry(brep: Brep): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let offset = 0;
  for (const shell of brep.shells) {
    for (const face of shell.faces) {
      const faceGeo = makeFaceGeometry(face);
      const pos = faceGeo.getAttribute("position") as THREE.BufferAttribute;
      const nrm = faceGeo.getAttribute("normal") as THREE.BufferAttribute | undefined;
      for (let i = 0; i < pos.count; i++) {
        positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        if (nrm) normals.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      }
      if (faceGeo.index) {
        for (let i = 0; i < faceGeo.index.count; i++) indices.push(faceGeo.index.getX(i) + offset);
      }
      offset += pos.count;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length === positions.length) geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  if (indices.length) geo.setIndex(indices);
  if (!normals.length) geo.computeVertexNormals();
  geo.computeBoundingBox();
  return geo;
}

function faceNormal(points: Point3[], orientation: boolean): THREE.Vector3 {
  const a = new THREE.Vector3(points[0].x, points[0].y, points[0].z);
  const b = new THREE.Vector3(points[1].x, points[1].y, points[1].z);
  const c = new THREE.Vector3(points[2].x, points[2].y, points[2].z);
  const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
  if (!orientation) normal.multiplyScalar(-1);
  return normal;
}

function cloneMaterial(mat: THREE.Material | THREE.Material[]): THREE.Material {
  return (Array.isArray(mat) ? mat[0] : mat).clone();
}

function exactPlaneToLinearNurbs(surface: PlaneSurface): NurbsSurface {
  const u0 = surface.uDomain.min;
  const u1 = surface.uDomain.max;
  const v0 = surface.vDomain.min;
  const v1 = surface.vDomain.max;
  const p00 = pointAtUV(surface, u0, v0);
  const p01 = pointAtUV(surface, u0, v1);
  const p10 = pointAtUV(surface, u1, v0);
  const p11 = pointAtUV(surface, u1, v1);
  return {
    kind: "nurbs",
    dim: 3,
    isRational: false,
    order: [2, 2],
    cvCount: [2, 2],
    knots: [[u0, u1], [v0, v1]],
    cvs: [
      p00.x, p00.y, p00.z,
      p01.x, p01.y, p01.z,
      p10.x, p10.y, p10.z,
      p11.x, p11.y, p11.z,
    ],
    cvStride: [6, 3],
  };
}

function remapCurveUV(curve: Curve, oldU: { min: number; max: number }, oldV: { min: number; max: number }, newU: { min: number; max: number }, newV: { min: number; max: number }): Curve {
  const remapU = (u: number) => newU.min + ((u - oldU.min) / (oldU.max - oldU.min || 1)) * (newU.max - newU.min);
  const remapV = (v: number) => newV.min + ((v - oldV.min) / (oldV.max - oldV.min || 1)) * (newV.max - newV.min);
  if (curve.kind !== "polyline") return transformParamSpaceCurve(curve);
  return {
    ...curve,
    points: curve.points.map((p) => ({ x: remapU(p.x), y: remapV(p.y), z: p.z })),
  };
}

function rebuildFaceToNurbs(face: BrepFace): BrepFace {
  const oldU = domainU(face.surface);
  const oldV = domainV(face.surface);
  const rebuilt = face.surface.kind === "nurbs"
    ? face.surface
    : face.surface.kind === "plane"
      ? exactPlaneToLinearNurbs(face.surface)
      : getNurbsForm(face.surface).surface;
  const newU = domainU(rebuilt);
  const newV = domainV(rebuilt);
  const loopsNeedRemap = oldU.min !== newU.min || oldU.max !== newU.max || oldV.min !== newV.min || oldV.max !== newV.max;
  return {
    ...face,
    surface: rebuilt,
    outerLoop: {
      ...face.outerLoop,
      curves: loopsNeedRemap
        ? face.outerLoop.curves.map((curve) => remapCurveUV(curve, oldU, oldV, newU, newV))
        : face.outerLoop.curves.map(transformParamSpaceCurve),
    },
    innerLoops: face.innerLoops.map((loop) => ({
      ...loop,
      curves: loopsNeedRemap
        ? loop.curves.map((curve) => remapCurveUV(curve, oldU, oldV, newU, newV))
        : loop.curves.map(transformParamSpaceCurve),
    })),
  };
}

function rebuildBrepToNurbs(brep: Brep): Brep {
  return {
    shells: brep.shells.map((shell) => ({
      ...shell,
      faces: shell.faces.map(rebuildFaceToNurbs),
      edges: shell.edges.map((edge) => ({ ...edge, curve: transformParamSpaceCurve(edge.curve) })),
      vertices: shell.vertices.map((vertex) => ({ ...vertex, point: { ...vertex.point }, edgeIndices: [...vertex.edgeIndices] })),
    })),
  };
}

function rebuildCanonicalBrep(viewer: Viewer, obj: THREE.Mesh, args: Record<string, unknown>): { rebuilt: string; original: string; originalFaces: number; rebuiltFaces: number; source: string; surfaceKind: string } | null {
  const store = viewer.getCanonicalGeometryStore();
  const sourceCanonical = store.resolveObjectOrAncestor(obj);
  if (sourceCanonical?.kind !== "brep") return null;
  const brep = canonicalBrepForObject(viewer, obj);
  if (!brep) return null;
  const rebuiltBrep = rebuildBrepToNurbs(brep);
  const originalFaces = brep.shells.reduce((n, shell) => n + shell.faces.length, 0);
  const rebuiltFaces = rebuiltBrep.shells.reduce((n, shell) => n + shell.faces.length, 0);
  const mesh = new THREE.Mesh(
    makeBrepGeometry(rebuiltBrep),
    cloneMaterial(obj.material as THREE.Material | THREE.Material[]),
  );
  mesh.userData.kind = "brep";
  mesh.userData.creator = "rebuild";
  mesh.userData.dispatchArgs = args;
  const record = store.create({
    kind: "brep",
    brep: rebuiltBrep,
    source: "edit",
    createdBy: "SdRebuild",
    metadata: {
      operation: "rebuild-nurbs",
      source: sourceCanonical.id,
      exactPlaneSurfaces: brep.shells.reduce((n, shell) => n + shell.faces.filter((face) => face.surface.kind === "plane").length, 0),
      originalFaces,
      rebuiltFaces,
    },
  });
  store.linkObject(mesh, record.id);
  viewer.getScene().remove(obj);
  viewer.addMesh(mesh, "brep", { noHistory: true });
  pushReplaceAction(mesh, [obj], "rebuild");
  return { rebuilt: mesh.uuid, original: obj.uuid, originalFaces, rebuiltFaces, source: "canonical-brep", surfaceKind: "nurbs" };
}

function faceLoopWorldPoints(face: BrepFace): Point3[] {
  const trim = face.outerLoop.curves[0];
  if (trim?.kind !== "polyline" || trim.points.length < 2) {
    const du = domainU(face.surface);
    const dv = domainV(face.surface);
    return [
      pointAtUV(face.surface, du.min, dv.min),
      pointAtUV(face.surface, du.max, dv.min),
      pointAtUV(face.surface, du.max, dv.max),
      pointAtUV(face.surface, du.min, dv.max),
    ];
  }
  const closed = trim.points.length > 1
    && Math.abs(trim.points[0].x - trim.points[trim.points.length - 1].x) < 1e-9
    && Math.abs(trim.points[0].y - trim.points[trim.points.length - 1].y) < 1e-9;
  const loop = closed ? trim.points.slice(0, -1) : trim.points;
  return loop.map((p) => pointAtUV(face.surface, p.x, p.y));
}

function brepZBounds(brep: Brep): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const shell of brep.shells) {
    for (const vertex of shell.vertices) {
      min = Math.min(min, vertex.point.z);
      max = Math.max(max, vertex.point.z);
    }
  }
  for (const shell of brep.shells) {
    for (const face of shell.faces) {
      for (const p of faceLoopWorldPoints(face)) {
        min = Math.min(min, p.z);
        max = Math.max(max, p.z);
      }
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

function contourSegmentsForFace(face: BrepFace, z: number): Array<[Point3, Point3]> {
  const loop = faceLoopWorldPoints(face);
  if (loop.length === 0 && face.surface.kind === "sum") {
    const du = domainU(face.surface);
    const dv = domainV(face.surface);
    const z0 = pointAtUV(face.surface, du.min, dv.min).z;
    const z1 = pointAtUV(face.surface, du.min, dv.max).z;
    if ((z < Math.min(z0, z1) && Math.abs(z - Math.min(z0, z1)) > 1e-9)
      || (z > Math.max(z0, z1) && Math.abs(z - Math.max(z0, z1)) > 1e-9)
      || Math.abs(z1 - z0) < 1e-9) return [];
    const t = (z - z0) / (z1 - z0);
    const v = dv.min + (dv.max - dv.min) * t;
    return [[
      pointAtUV(face.surface, du.min, v),
      pointAtUV(face.surface, du.max, v),
    ]];
  }
  if (loop.length < 2) return [];
  const hits: Point3[] = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    const da = a.z - z;
    const db = b.z - z;
    if (Math.abs(da) < 1e-9 && Math.abs(db) < 1e-9) continue;
    if (Math.abs(da) < 1e-9) {
      hits.push(a);
      continue;
    }
    if (da * db < 0 || Math.abs(db) < 1e-9) {
      const t = da / (da - db);
      hits.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z,
      });
    }
  }
  const unique: Point3[] = [];
  for (const hit of hits) {
    if (!unique.some((p) => Math.hypot(p.x - hit.x, p.y - hit.y, p.z - hit.z) < 1e-7)) unique.push(hit);
  }
  const segments: Array<[Point3, Point3]> = [];
  for (let i = 0; i + 1 < unique.length; i += 2) segments.push([unique[i], unique[i + 1]]);
  return segments;
}

function pointsClose(a: Point3, b: Point3, tolerance = 1e-7): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= tolerance;
}

function makeContourCurve(points: Point3[]): Curve {
  const parameters = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    parameters.push(parameters[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  return {
    kind: "polyline",
    points,
    parameters,
  };
}

function stitchContourSegments(segments: Array<[Point3, Point3]>): Point3[][] {
  const remaining = segments
    .filter(([a, b]) => !pointsClose(a, b))
    .map(([a, b]) => [{ ...a }, { ...b }] as [Point3, Point3]);
  const chains: Point3[][] = [];
  while (remaining.length > 0) {
    const [first] = remaining.splice(0, 1);
    const chain: Point3[] = [first[0], first[1]];
    let changed = true;
    while (changed) {
      changed = false;
      const head = chain[0];
      const tail = chain[chain.length - 1];
      for (let i = 0; i < remaining.length; i++) {
        const [a, b] = remaining[i];
        if (pointsClose(tail, a)) {
          chain.push(b);
        } else if (pointsClose(tail, b)) {
          chain.push(a);
        } else if (pointsClose(head, b)) {
          chain.unshift(a);
        } else if (pointsClose(head, a)) {
          chain.unshift(b);
        } else {
          continue;
        }
        remaining.splice(i, 1);
        changed = true;
        break;
      }
    }
    chains.push(chain);
  }
  return chains.filter((chain) => chain.length >= 2);
}

function addContourLine(viewer: Viewer, curve: Curve, metadata: Record<string, unknown>, args: Record<string, unknown>): string {
  if (curve.kind !== "polyline") throw new Error("Contour curve must be a polyline");
  const points = curve.points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x4f8cff }));
  line.userData.kind = "curve";
  line.userData.creator = "contour";
  line.userData.dispatchArgs = args;
  const record = viewer.getCanonicalGeometryStore().create({
    kind: "curve",
    curve,
    source: "edit",
    createdBy: "SdContour",
    metadata,
  });
  viewer.getCanonicalGeometryStore().linkObject(line, record.id);
  viewer.addMesh(line, "curve");
  return line.uuid;
}

function contourCanonicalBrep(viewer: Viewer, obj: THREE.Mesh, args: Record<string, unknown>): { target: string; contourLevels: number[]; sliceCount: number; interval: number; created: string[]; source: string } | null {
  const sourceCanonical = viewer.getCanonicalGeometryStore().resolveObjectOrAncestor(obj);
  if (sourceCanonical?.kind !== "brep") return null;
  const brep = canonicalBrepForObject(viewer, obj);
  if (!brep) return null;
  const bounds = brepZBounds(brep);
  if (!bounds) return null;
  const interval = (args.interval as number | undefined) ?? 1;
  const countArg = (args.count as number | undefined) ?? 5;
  const zRange = bounds.max - bounds.min;
  const sliceCount = interval > 0 ? Math.max(1, Math.floor(zRange / interval)) : Math.max(1, countArg);
  const levels: number[] = [];
  for (let i = 1; i <= sliceCount; i++) levels.push(bounds.min + (zRange * i) / (sliceCount + 1));
  const created: string[] = [];
  for (const level of levels) {
    let faceIndex = 0;
    const levelSegments: Array<[Point3, Point3]> = [];
    const faceIndices: number[] = [];
    for (const shell of brep.shells) {
      for (const face of shell.faces) {
        for (const [a, b] of contourSegmentsForFace(face, level)) {
          levelSegments.push([a, b]);
          faceIndices.push(faceIndex);
        }
        faceIndex++;
      }
    }
    for (const chain of stitchContourSegments(levelSegments)) {
      const closed = chain.length > 2 && pointsClose(chain[0], chain[chain.length - 1]);
      const curve = makeContourCurve([...chain]);
      created.push(addContourLine(viewer, curve, {
        operation: "contour",
        source: sourceCanonical.id,
        level,
        faceIndices: [...new Set(faceIndices)],
        segmentCount: levelSegments.length,
        closed,
      }, args));
    }
  }
  return { target: obj.uuid, contourLevels: levels, sliceCount: levels.length, interval, created, source: "canonical-brep" };
}

function explodeCanonicalBrep(viewer: Viewer, obj: THREE.Mesh, args: Record<string, unknown>): { exploded: string[]; faceCount: number; source: string } | null {
  const store = viewer.getCanonicalGeometryStore();
  const sourceCanonical = store.resolveObjectOrAncestor(obj);
  if (sourceCanonical?.kind !== "brep") return null;
  const brep = canonicalBrepForObject(viewer, obj);
  if (!brep) return null;

  const scene = viewer.getScene();
  const material = obj.material as THREE.Material | THREE.Material[];
  const createdUuids: string[] = [];
  let faceIndex = 0;
  for (const shell of brep.shells) {
    for (const face of shell.faces) {
      const faceMesh = new THREE.Mesh(makeFaceGeometry(face), cloneMaterial(material));
      faceMesh.userData.kind = "brep";
      faceMesh.userData.creator = "explode-face";
      faceMesh.userData.dispatchArgs = args;
      const record = store.create({
        kind: "brep",
        brep: singleFaceBrep(face),
        source: "edit",
        createdBy: "SdExplode",
        metadata: {
          operation: "explode-face",
          source: sourceCanonical.id,
          faceIndex,
        },
      });
      store.linkObject(faceMesh, record.id);
      viewer.addMesh(faceMesh, "brep", { noHistory: true });
      createdUuids.push(faceMesh.uuid);
      faceIndex++;
    }
  }
  if (createdUuids.length === 0) return null;
  scene.remove(obj); // audit-undo-ok - tracked by pushReplaceAction below
  pushReplaceAction(createdUuids.length === 1
    ? scene.getObjectByProperty("uuid", createdUuids[0]) as THREE.Mesh
    : (() => { const m = new THREE.Mesh(); m.uuid = createdUuids[0]; return m; })(),
    [obj], "explode");
  return { exploded: createdUuids, faceCount: createdUuids.length, source: "canonical-brep" };
}

function singleFaceBrep(face: BrepFace): Brep {
  const loop = faceLoopWorldPoints(face);
  const vertices: BrepVertex[] = loop.map((point) => ({
    point: { ...point },
    edgeIndices: [],
    tolerance: BREP_DEFAULT_TOLERANCE,
  }));
  const edges: BrepEdge[] = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    edges.push({
      curve: {
        kind: "line",
        from: { ...a },
        to: { ...b },
        domain: Interval.create(0, length),
      },
      faceIndex1: 0,
      faceIndex2: null,
      tolerance: BREP_DEFAULT_TOLERANCE,
    });
    vertices[i].edgeIndices.push(i);
    vertices[(i + 1) % loop.length].edgeIndices.push(i);
  }
  return {
    shells: [{
      faces: [face],
      edges,
      vertices,
      isClosed: false,
    }],
  };
}

function pointKey(point: Point3): string {
  const q = (n: number) => Math.round(n * 1e7);
  return `${q(point.x)},${q(point.y)},${q(point.z)}`;
}

function edgeEndpoints(edge: BrepEdge): [Point3, Point3] | null {
  if (edge.curve.kind === "line") return [edge.curve.from, edge.curve.to];
  if (edge.curve.kind === "polyline" && edge.curve.points.length >= 2) {
    return [edge.curve.points[0], edge.curve.points[edge.curve.points.length - 1]];
  }
  return null;
}

type JoinEdgeDraft = {
  a: Point3;
  b: Point3;
  curve: Curve;
  faces: number[];
};

function sameFaceSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const aa = [...a].sort((left, right) => left - right);
  const bb = [...b].sort((left, right) => left - right);
  return aa.every((face, index) => face === bb[index]);
}

function collinear(a: Point3, b: Point3, c: Point3): boolean {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const cross = {
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  };
  return Math.hypot(cross.x, cross.y, cross.z) < 1e-7;
}

function lineCurve(a: Point3, b: Point3): Curve {
  return {
    kind: "line",
    from: { ...a },
    to: { ...b },
    domain: Interval.create(0, Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)),
  };
}

function simplifyCollinearJoinEdges(input: JoinEdgeDraft[]): JoinEdgeDraft[] {
  const edges = input.map((edge) => ({ ...edge, a: { ...edge.a }, b: { ...edge.b }, faces: [...edge.faces] }));
  let changed = true;
  while (changed) {
    changed = false;
    mergeSearch:
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        if (!sameFaceSet(edges[i].faces, edges[j].faces)) continue;
        const candidates: Array<[Point3, Point3, Point3]> = [];
        if (pointKey(edges[i].a) === pointKey(edges[j].a)) candidates.push([edges[i].b, edges[i].a, edges[j].b]);
        if (pointKey(edges[i].a) === pointKey(edges[j].b)) candidates.push([edges[i].b, edges[i].a, edges[j].a]);
        if (pointKey(edges[i].b) === pointKey(edges[j].a)) candidates.push([edges[i].a, edges[i].b, edges[j].b]);
        if (pointKey(edges[i].b) === pointKey(edges[j].b)) candidates.push([edges[i].a, edges[i].b, edges[j].a]);
        const merge = candidates.find(([left, shared, right]) => (
          pointKey(left) !== pointKey(right) && collinear(left, shared, right)
        ));
        if (!merge) continue;
        const [a, , b] = merge;
        edges.splice(j, 1);
        edges[i] = {
          a,
          b,
          curve: lineCurve(a, b),
          faces: [...edges[i].faces],
        };
        changed = true;
        break mergeSearch;
      }
    }
  }
  return edges;
}

function tryWeldCoincidentBoundaryShells(...breps: Brep[]): Brep | null {
  const sourceShells = breps.flatMap((brep) => brep.shells);
  if (sourceShells.length < 2 || sourceShells.some((shell) => shell.isClosed)) return null;

  const faces: BrepFace[] = [];
  const pointByKey = new Map<string, Point3>();
  const edgeDrafts = new Map<string, JoinEdgeDraft>();
  let matchedEdges = 0;

  const getPoint = (point: Point3): Point3 => {
    const key = pointKey(point);
    const existing = pointByKey.get(key);
    if (existing) return existing;
    const stored = { ...point };
    pointByKey.set(key, stored);
    return stored;
  };

  for (const shell of sourceShells) {
    const faceOffset = faces.length;
    faces.push(...shell.faces);
    for (const edge of shell.edges) {
      const endpoints = edgeEndpoints(edge);
      if (!endpoints) return null;
      const [a, b] = endpoints;
      const pa = getPoint(a);
      const pb = getPoint(b);
      const ka = pointKey(pa);
      const kb = pointKey(pb);
      const edgeKey = ka < kb ? `${ka}:${kb}` : `${kb}:${ka}`;
      const adjacentFaces = [edge.faceIndex1, edge.faceIndex2]
        .filter((faceIndex): faceIndex is number => faceIndex !== null && faceIndex !== undefined)
        .map((faceIndex) => faceOffset + faceIndex);
      const existing = edgeDrafts.get(edgeKey);
      if (existing) {
        matchedEdges++;
        existing.faces.push(...adjacentFaces);
        if (existing.faces.length > 2) return null;
      } else {
        edgeDrafts.set(edgeKey, {
          curve: transformParamSpaceCurve(edge.curve),
          faces: adjacentFaces,
          a: pa,
          b: pb,
        });
      }
    }
  }
  if (matchedEdges === 0) return null;

  const simplified = simplifyCollinearJoinEdges([...edgeDrafts.values()]);
  const vertices: BrepVertex[] = [];
  const vertexByKey = new Map<string, number>();
  const getVertex = (point: Point3): number => {
    const key = pointKey(point);
    const existing = vertexByKey.get(key);
    if (existing !== undefined) return existing;
    const index = vertices.length;
    vertexByKey.set(key, index);
    vertices.push({ point: { ...point }, edgeIndices: [], tolerance: BREP_DEFAULT_TOLERANCE });
    return index;
  };
  const edges: BrepEdge[] = [];
  for (const draft of simplified) {
    const edgeIndex = edges.length;
    const va = getVertex(draft.a);
    const vb = getVertex(draft.b);
    vertices[va].edgeIndices.push(edgeIndex);
    vertices[vb].edgeIndices.push(edgeIndex);
    edges.push({
      curve: draft.curve,
      faceIndex1: draft.faces[0],
      faceIndex2: draft.faces[1] ?? null,
      tolerance: BREP_DEFAULT_TOLERANCE,
    });
  }

  return {
    shells: [{
      faces,
      edges,
      vertices,
      isClosed: edges.length > 0 && edges.every((edge) => edge.faceIndex2 !== null),
    }],
  };
}

function linkJoinedCanonicalBreps(viewer: Viewer, meshes: THREE.Mesh[], joined: THREE.Object3D): void {
  const store = viewer.getCanonicalGeometryStore();
  const operands = meshes.map((mesh) => store.resolveObjectOrAncestor(mesh));
  const breps = meshes.map((mesh) => canonicalBrepForObject(viewer, mesh));
  if (breps.some((brep) => !brep) || operands.some((record) => record?.kind !== "brep")) return;
  const welded = tryWeldCoincidentBoundaryShells(...breps as Brep[]);
  const record = store.create({
    kind: "brep",
    brep: welded ?? brepConcat(...breps as Brep[]),
    source: "edit",
    createdBy: "SdJoin",
    metadata: {
      operation: "join",
      operands: operands.map((record) => record?.id),
      topology: welded ? "welded-coincident-boundary-edges" : "concatenated-shells",
    },
  });
  store.linkObject(joined, record.id);
}

export function registerBrepOpHandlers(viewer: Viewer): void {
  registerHandler("SdExplode", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdExplode - target is required" };
    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdExplode - object not found: ${targetId}` };
    if (obj instanceof THREE.Group) {
      const children = [...obj.children];
      if (children.length === 0) return { error: "SdExplode - group is empty" };
      scene.remove(obj);
      const exploded: string[] = [];
      for (const child of children) {
        child.applyMatrix4(obj.matrixWorld);
        child.updateMatrixWorld(true);
        child.userData.dispatchArgs = args;
        scene.add(child);
        exploded.push(child.uuid);
      }
      pushReplaceAction(children[0], [obj], "SdExplode");
      return { exploded, faceCount: exploded.length };
    }
    if (!(obj instanceof THREE.Mesh)) return { error: "SdExplode - target must be a Mesh" };
    const canonicalResult = explodeCanonicalBrep(viewer, obj, args);
    if (canonicalResult) return canonicalResult;
    const geo = obj.geometry as THREE.BufferGeometry;
    const mat = obj.material as THREE.Material;
    const groups = geo.groups.length > 0 ? geo.groups : [{ start: 0, count: geo.index ? geo.index.count : geo.attributes.position.count, materialIndex: 0 }];
    const createdUuids: string[] = [];
    for (const [faceIndex, g] of groups.entries()) {
      const faceGeo = new THREE.BufferGeometry();
      const srcPos = geo.attributes.position as THREE.BufferAttribute;
      const srcNrm = geo.attributes.normal as THREE.BufferAttribute | undefined;
      if (geo.index) {
        const idxArr = geo.index.array;
        const triCount = Math.floor(g.count / 3);
        const pos: number[] = [];
        const nrm: number[] = [];
        for (let t = 0; t < triCount; t++) {
          for (let v = 0; v < 3; v++) {
            const i = idxArr[g.start + t * 3 + v];
            pos.push(srcPos.getX(i), srcPos.getY(i), srcPos.getZ(i));
            if (srcNrm) nrm.push(srcNrm.getX(i), srcNrm.getY(i), srcNrm.getZ(i));
          }
        }
        faceGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        if (nrm.length) faceGeo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
      } else {
        const slicedPos = (srcPos.array as Float32Array).slice(g.start * 3, (g.start + g.count) * 3);
        faceGeo.setAttribute("position", new THREE.Float32BufferAttribute(slicedPos, 3));
        if (srcNrm) {
          const slicedNrm = (srcNrm.array as Float32Array).slice(g.start * 3, (g.start + g.count) * 3);
          faceGeo.setAttribute("normal", new THREE.Float32BufferAttribute(slicedNrm, 3));
        }
      }
      faceGeo.computeBoundingBox();
      const faceMesh = new THREE.Mesh(faceGeo, mat.clone());
      faceMesh.userData.kind = "brep";
      faceMesh.userData.creator = "explode-face";
      faceMesh.userData.dispatchArgs = args;
      faceMesh.position.copy(obj.position);
      faceMesh.quaternion.copy(obj.quaternion);
      faceMesh.scale.copy(obj.scale);
      viewer.addMesh(faceMesh, "brep", { noHistory: true });
      createdUuids.push(faceMesh.uuid);
    }
    scene.remove(obj); // audit-undo-ok - tracked by pushReplaceAction below
    pushReplaceAction(createdUuids.length === 1
      ? scene.getObjectByProperty("uuid", createdUuids[0]) as THREE.Mesh
      : (() => { const m = new THREE.Mesh(); m.uuid = createdUuids[0]; return m; })(),
      [obj], "explode");
    return { exploded: createdUuids, faceCount: createdUuids.length };
  });

  registerHandler("SdJoin", (args) => {
    const targetIds = args.targets as string[] | undefined;
    if (!Array.isArray(targetIds) || targetIds.length < 2)
      return { error: "SdJoin - targets must be an array of at least 2 UUIDs" };
    const scene = viewer.getScene();
    const meshes: THREE.Mesh[] = [];
    for (const id of targetIds) {
      const obj = scene.getObjectByProperty("uuid", id);
      if (!obj) return { error: `SdJoin - object not found: ${id}` };
      if (!(obj instanceof THREE.Mesh)) return { error: `SdJoin - target ${id} is not a Mesh` };
      meshes.push(obj);
    }
    const positions: number[] = [];
    const normals: number[] = [];
    let indexOffset = 0;
    const indices: number[] = [];
    for (const m of meshes) {
      const g = m.geometry as THREE.BufferGeometry;
      const pos = g.attributes.position as THREE.BufferAttribute;
      const nrm = g.attributes.normal as THREE.BufferAttribute | undefined;
      for (let i = 0; i < pos.count; i++) {
        const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m.matrixWorld);
        positions.push(v.x, v.y, v.z);
        if (nrm) normals.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      }
      if (g.index) {
        for (let i = 0; i < g.index.count; i++) indices.push(g.index.getX(i) + indexOffset);
      }
      indexOffset += pos.count;
    }
    const joinedGeo = new THREE.BufferGeometry();
    joinedGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    if (normals.length) joinedGeo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    if (indices.length) joinedGeo.setIndex(indices);
    if (!normals.length) joinedGeo.computeVertexNormals();
    joinedGeo.computeBoundingBox();
    const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
    const joined = new THREE.Mesh(joinedGeo, mat);
    joined.userData.kind = "brep";
    joined.userData.creator = "join";
    joined.userData.dispatchArgs = args;
    linkJoinedCanonicalBreps(viewer, meshes, joined);
    for (const m of meshes) scene.remove(m); // audit-undo-ok - tracked by pushReplaceAction below
    viewer.addMesh(joined, "brep", { noHistory: true });
    pushReplaceAction(joined, meshes, "join");
    return { created: joined.uuid, faceCount: meshes.length };
  });

  registerHandler("SdRebuild", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdRebuild - target is required" };
    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdRebuild - object not found: ${targetId}` };
    if (obj instanceof THREE.Line) {
      const cps = obj.userData.controlPoints as Array<{ x: number; y: number; z?: number }> | undefined;
      const sourcePts = cps?.length
        ? cps.map((p) => new THREE.Vector3(p.x, p.y, p.z ?? 0).applyMatrix4(obj.matrixWorld))
        : (() => {
          const pos = obj.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
          if (!pos) return [];
          const pts: THREE.Vector3[] = [];
          for (let i = 0; i < pos.count; i++) pts.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(obj.matrixWorld));
          return pts;
        })();
      if (sourcePts.length < 2) return { error: "SdRebuild - curve has insufficient points" };
      const count = Math.max((args.count as number | undefined) ?? sourcePts.length * 32, sourcePts.length * 2);
      const rebuiltPts: THREE.Vector3[] = [];
      for (let i = 0; i <= count; i++) {
        const t = i / count;
        const idx = Math.min(Math.floor(t * (sourcePts.length - 1)), sourcePts.length - 2);
        const localT = (t * (sourcePts.length - 1)) - idx;
        rebuiltPts.push(sourcePts[idx].clone().lerp(sourcePts[idx + 1], localT));
      }
      const geom = new THREE.BufferGeometry().setFromPoints(rebuiltPts);
      const mat = (obj.material as THREE.LineBasicMaterial).clone();
      const rebuilt = new THREE.Line(geom, mat);
      rebuilt.userData = { ...obj.userData, creator: "rebuild", dispatchArgs: args };
      const curvePts = rebuiltPts.map((p) => ({ x: p.x, y: p.y, z: p.z }));
      const parameters = [0];
      for (let i = 1; i < curvePts.length; i++) {
        parameters.push(parameters[i - 1] + Math.hypot(
          curvePts[i].x - curvePts[i - 1].x,
          curvePts[i].y - curvePts[i - 1].y,
          curvePts[i].z - curvePts[i - 1].z,
        ));
      }
      linkCanonicalCurve(viewer, rebuilt, { kind: "polyline", points: curvePts, parameters }, "SdRebuild", {
        operation: "curve-rebuild",
        source: targetId,
        count,
      });
      scene.remove(obj);
      viewer.addMesh(rebuilt as unknown as THREE.Mesh, "mesh", { noHistory: true });
      pushReplaceAction(rebuilt as unknown as THREE.Mesh, [obj], "SdRebuild");
      return { rebuilt: rebuilt.uuid, originalVertices: sourcePts.length, targetCount: rebuiltPts.length };
    }
    if (!(obj instanceof THREE.Mesh)) return { error: "SdRebuild - target must be a Mesh" };
    const canonicalResult = rebuildCanonicalBrep(viewer, obj, args);
    if (canonicalResult) return canonicalResult;
    const count = (args.count as number | undefined) ?? 0;
    const geo = obj.geometry as THREE.BufferGeometry;
    const vertexCount = (geo.attributes.position as THREE.BufferAttribute).count;
    const targetCount = count > 0 ? count : vertexCount * 2;
    return { rebuilt: obj.uuid, originalVertices: vertexCount, targetCount, note: "rebuild scheduled - full NURBS reparameterisation deferred to GPU kernel" };
  });

  registerHandler("SdContour", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdContour - target is required" };
    const scene = viewer.getScene();
    const obj = scene.getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdContour - object not found: ${targetId}` };
    if (!(obj instanceof THREE.Mesh)) return { error: "SdContour - target must be a Mesh" };
    const canonicalResult = contourCanonicalBrep(viewer, obj, args);
    if (canonicalResult) return canonicalResult;
    const interval = (args.interval as number | undefined) ?? 1;
    const countArg = (args.count as number | undefined) ?? 5;
    obj.geometry.computeBoundingBox();
    const bbox = obj.geometry.boundingBox!;
    const zMin = bbox.min.z + (obj.position?.z ?? 0);
    const zMax = bbox.max.z + (obj.position?.z ?? 0);
    const zRange = zMax - zMin;
    const sliceCount = interval > 0 ? Math.max(1, Math.floor(zRange / interval)) : countArg;
    const levels: number[] = [];
    for (let i = 1; i <= sliceCount; i++) levels.push(zMin + (zRange * i) / (sliceCount + 1));
    return { target: targetId, contourLevels: levels, sliceCount: levels.length, interval };
  });
}
