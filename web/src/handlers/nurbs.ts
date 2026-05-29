import { registerHandler } from "../commands/dispatch";
import { Viewer } from "../viewer/viewer";
import * as THREE from "three";
import { buildBox } from "../tools/structural";
import { resolveCPlane } from "../viewer/cplane";
import { getActiveLevelId } from "../geometry/levels";
import { onElementCommitted } from "../tools/join-groups";
import { resolveLayerId, getActiveLevelElevation } from "./shared";
import { linkCanonicalBrep } from "./canonical-surface";
import { tessellate as tessellateCurve, type Curve, type PolylineCurve } from "../nurbs/nurbs-curves";
import type { NurbsSurface, Surface } from "../nurbs/nurbs-surfaces";
import { surfaceOfRevolution } from "../nurbs/nurbs-surface-algorithms";
import type { Line, Plane, Point3 } from "../nurbs/nurbs-primitives";
import { BREP_DEFAULT_TOLERANCE, type Brep, type BrepEdge, type BrepFace, type BrepVertex } from "../nurbs/nurbs-brep";
import { extrude as extrudeBrep } from "../nurbs/brep-extrude";
import { CANONICAL_GEOMETRY_USERDATA_KEY } from "../geometry/canonical-geometry";

const TWO_PI = Math.PI * 2;

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numericTuple3(value: unknown): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  const x = finiteNumber(value[0], NaN);
  const y = finiteNumber(value[1], NaN);
  const z = finiteNumber(value[2], NaN);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? [x, y, z] : undefined;
}

function uvOuterLoop(): PolylineCurve {
  return {
    kind: "polyline",
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
    ],
    parameters: [0, 1, 2, 3, 4],
  };
}

function linearNurbsSurface(p00: Point3, p01: Point3, p10: Point3, p11: Point3): NurbsSurface {
  return {
    kind: "nurbs",
    dim: 3,
    isRational: false,
    order: [2, 2],
    cvCount: [2, 2],
    knots: [[0, 1], [0, 1]],
    cvs: [
      p00.x, p00.y, p00.z,
      p01.x, p01.y, p01.z,
      p10.x, p10.y, p10.z,
      p11.x, p11.y, p11.z,
    ],
    cvStride: [6, 3],
  };
}

function brepFace(surface: NurbsSurface): BrepFace {
  return {
    surface,
    outerLoop: { curves: [uvOuterLoop()], orientation: true },
    innerLoops: [],
    orientation: true,
    tolerance: BREP_DEFAULT_TOLERANCE,
  };
}

function lineEdge(from: Point3, to: Point3, faceIndex1: number, faceIndex2: number): BrepEdge {
  return {
    curve: {
      kind: "line",
      from,
      to,
      domain: { min: 0, max: Math.sqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2 + (to.z - from.z) ** 2) },
    },
    faceIndex1,
    faceIndex2,
    tolerance: BREP_DEFAULT_TOLERANCE,
  };
}

function vertex(point: Point3, edgeIndices: number[]): BrepVertex {
  return { point, edgeIndices, tolerance: BREP_DEFAULT_TOLERANCE };
}

function axisAlignedNurbsBoxBrep(width: number, depth: number, height: number): Brep {
  const x0 = -width / 2, x1 = width / 2;
  const y0 = -depth / 2, y1 = depth / 2;
  const z0 = 0, z1 = height;
  const p000 = { x: x0, y: y0, z: z0 };
  const p100 = { x: x1, y: y0, z: z0 };
  const p110 = { x: x1, y: y1, z: z0 };
  const p010 = { x: x0, y: y1, z: z0 };
  const p001 = { x: x0, y: y0, z: z1 };
  const p101 = { x: x1, y: y0, z: z1 };
  const p111 = { x: x1, y: y1, z: z1 };
  const p011 = { x: x0, y: y1, z: z1 };
  const faces = [
    brepFace(linearNurbsSurface(p000, p001, p010, p011)), // -X
    brepFace(linearNurbsSurface(p100, p110, p101, p111)), // +X
    brepFace(linearNurbsSurface(p000, p100, p001, p101)), // -Y
    brepFace(linearNurbsSurface(p010, p011, p110, p111)), // +Y
    brepFace(linearNurbsSurface(p000, p010, p100, p110)), // -Z
    brepFace(linearNurbsSurface(p001, p101, p011, p111)), // +Z
  ];
  const edges = [
    lineEdge(p000, p100, 2, 4),
    lineEdge(p100, p110, 1, 4),
    lineEdge(p010, p110, 3, 4),
    lineEdge(p000, p010, 0, 4),
    lineEdge(p001, p101, 2, 5),
    lineEdge(p101, p111, 1, 5),
    lineEdge(p011, p111, 3, 5),
    lineEdge(p001, p011, 0, 5),
    lineEdge(p000, p001, 0, 2),
    lineEdge(p100, p101, 1, 2),
    lineEdge(p110, p111, 1, 3),
    lineEdge(p010, p011, 0, 3),
  ];
  const vertices = [
    vertex(p000, [0, 3, 8]),
    vertex(p100, [0, 1, 9]),
    vertex(p110, [1, 2, 10]),
    vertex(p010, [2, 3, 11]),
    vertex(p001, [4, 7, 8]),
    vertex(p101, [4, 5, 9]),
    vertex(p111, [5, 6, 10]),
    vertex(p011, [6, 7, 11]),
  ];
  return { shells: [{ faces, edges, vertices, isClosed: true }] };
}

function zAxis(): Line {
  return { from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 1 } };
}

function lineProfile(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): Curve {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  return {
    kind: "line",
    from,
    to,
    domain: { min: 0, max: Math.sqrt(dx * dx + dy * dy + dz * dz) },
  };
}

function cylinderSurface(radius: number, height: number): Surface {
  return surfaceOfRevolution(lineProfile({ x: radius, y: 0, z: -height / 2 }, { x: radius, y: 0, z: height / 2 }), zAxis(), 0, TWO_PI);
}

function coneSurface(radius: number, height: number): Surface {
  return surfaceOfRevolution(lineProfile({ x: radius, y: 0, z: -height / 2 }, { x: 0, y: 0, z: height / 2 }), zAxis(), 0, TWO_PI);
}

function sphereSurface(radius: number): Surface {
  const profilePlane: Plane = {
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 0, z: 1 },
    normal: { x: 0, y: -1, z: 0 },
  };
  return surfaceOfRevolution({
    kind: "arc",
    center: { x: 0, y: 0, z: 0 },
    radius,
    startAngle: -Math.PI / 2,
    endAngle: Math.PI / 2,
    plane: profilePlane,
    domain: { min: 0, max: Math.PI * radius },
  }, zAxis(), 0, TWO_PI);
}

function trimCircle(radius: number, samples = 64): PolylineCurve {
  const points: Point3[] = [];
  const parameters: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * TWO_PI;
    points.push({ x: Math.cos(t) * radius, y: Math.sin(t) * radius, z: 0 });
    parameters.push(t * radius);
  }
  return { kind: "polyline", points, parameters };
}

function capFace(z: number, radius: number, orientation: boolean): BrepFace {
  const plane: Plane = {
    origin: { x: 0, y: 0, z },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
  };
  return {
    surface: {
      kind: "plane",
      plane,
      uDomain: { min: -radius, max: radius },
      vDomain: { min: -radius, max: radius },
      uExtent: { min: -radius, max: radius },
      vExtent: { min: -radius, max: radius },
    },
    outerLoop: { curves: [trimCircle(radius)], orientation },
    innerLoops: [],
    orientation,
    tolerance: BREP_DEFAULT_TOLERANCE,
  };
}

function circleEdge(z: number, radius: number, faceIndex1: number, faceIndex2: number): BrepEdge {
  return {
    curve: {
      kind: "arc",
      center: { x: 0, y: 0, z },
      radius,
      startAngle: 0,
      endAngle: TWO_PI,
      plane: {
        origin: { x: 0, y: 0, z },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
      },
      domain: { min: 0, max: TWO_PI * radius },
    },
    faceIndex1,
    faceIndex2,
    tolerance: BREP_DEFAULT_TOLERANCE,
  };
}

function sphereBrep(radius: number): Brep {
  return {
    shells: [{
      faces: [{
        surface: sphereSurface(radius),
        outerLoop: { curves: [], orientation: true },
        innerLoops: [],
        orientation: true,
        tolerance: BREP_DEFAULT_TOLERANCE,
      }],
      edges: [],
      vertices: [],
      isClosed: true,
    }],
  };
}

function cylinderBrep(radius: number, height: number): Brep {
  const bottom = -height / 2;
  const top = height / 2;
  return {
    shells: [{
      faces: [
        {
          surface: cylinderSurface(radius, height),
          outerLoop: { curves: [], orientation: true },
          innerLoops: [],
          orientation: true,
          tolerance: BREP_DEFAULT_TOLERANCE,
        },
        capFace(bottom, radius, false),
        capFace(top, radius, true),
      ],
      edges: [
        circleEdge(bottom, radius, 0, 1),
        circleEdge(top, radius, 0, 2),
      ],
      vertices: [],
      isClosed: true,
    }],
  };
}

function coneBrep(radius: number, height: number): Brep {
  const bottom = -height / 2;
  return {
    shells: [{
      faces: [
        {
          surface: coneSurface(radius, height),
          outerLoop: { curves: [], orientation: true },
          innerLoops: [],
          orientation: true,
          tolerance: BREP_DEFAULT_TOLERANCE,
        },
        capFace(bottom, radius, false),
      ],
      edges: [
        circleEdge(bottom, radius, 0, 1),
      ],
      vertices: [],
      isClosed: true,
    }],
  };
}

function polylineProfile(points: Array<[number, number]>): PolylineCurve {
  const profilePoints = points.map(([x, y]) => ({ x, y, z: 0 }));
  const parameters = [0];
  for (let i = 1; i < profilePoints.length; i++) {
    const a = profilePoints[i - 1];
    const b = profilePoints[i];
    parameters.push(parameters[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  return { kind: "polyline", points: profilePoints, parameters };
}

function canonicalCurveProfile2d(viewer: Viewer, srcObj: THREE.Object3D): [number, number][] | undefined {
  const record = viewer.getCanonicalGeometryStore?.().resolveObjectOrAncestor(srcObj);
  if (record?.kind !== "curve") return undefined;
  const sourcePoints = record.curve.kind === "polyline"
    ? record.curve.points
    : tessellateCurve(record.curve, record.curve.kind === "line" ? 2 : 64);
  if (sourcePoints.length < 3) return undefined;
  srcObj.updateMatrixWorld(true);
  const tmp = new THREE.Vector3();
  const extracted: [number, number][] = [];
  for (const point of sourcePoints) {
    tmp.set(point.x, point.y, point.z).applyMatrix4(srcObj.matrixWorld);
    extracted.push([tmp.x, tmp.y]);
  }
  const first = extracted[0];
  const last = extracted[extracted.length - 1];
  if (first && last && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-8) {
    extracted.pop();
  }
  return extracted.length >= 3 ? extracted : undefined;
}

function displayGeometryProfile2d(srcObj: THREE.Object3D): [number, number][] | undefined {
  srcObj.updateMatrixWorld(true);
  const posAttr = (srcObj as THREE.Line | THREE.Mesh).geometry?.attributes?.position;
  if (!posAttr) return undefined;
  const tmp = new THREE.Vector3();
  const extracted: [number, number][] = [];
  for (let i = 0; i < posAttr.count; i++) {
    tmp.fromBufferAttribute(posAttr, i).applyMatrix4(srcObj.matrixWorld);
    extracted.push([tmp.x, tmp.y]);
  }
  return extracted.length >= 3 ? extracted : undefined;
}

export function registerNurbsHandlers(viewer: Viewer): void {
  registerHandler("SdBox", (args) => {
    const sizeTuple = numericTuple3(args.size);
    const scalarSize = finiteNumber(args.size, 1);
    const w = finiteNumber(args.width, sizeTuple?.[0] ?? scalarSize);
    const d = finiteNumber(args.depth, finiteNumber(args.length, sizeTuple?.[1] ?? scalarSize));
    const h = finiteNumber(args.height, sizeTuple?.[2] ?? scalarSize);
    const center = numericTuple3(args.center);
    const cplane = resolveCPlane("SdBox", args as Record<string, unknown>, viewer);
    const c1 = { x: -w / 2, y: -d / 2 };
    const c2 = { x: w / 2, y: d / 2 };
    const c3 = { x: h, y: 0 };
    const { mesh, chain } = buildBox(c1, c2, c3);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), cplane.normal);
    const levelElevation = getActiveLevelElevation();
    if (center) {
      mesh.position.set(center[0], center[1], center[2] - h / 2);
    } else {
      mesh.position.z = levelElevation;
    }
    mesh.userData.cplaneKind = cplane.kind;
    mesh.userData.layerId = resolveLayerId("SdBox", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.creator = "box";
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    linkCanonicalBrep(viewer, mesh, axisAlignedNurbsBoxBrep(w, d, h), "SdBox");
    viewer.addMesh(mesh, "brep");
    onElementCommitted(mesh as THREE.Mesh, viewer.getScene());
    return { created: mesh.uuid, object_id: mesh.uuid, canonical_id: mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY], primitive: "box", width: w, depth: d, height: h };
  });

  registerHandler("SdSphere", (args) => {
    const r = (args.radius as number | undefined) ?? 1;
    const cplane = resolveCPlane("SdSphere", args as Record<string, unknown>, viewer);
    const geom = new THREE.SphereGeometry(r, 32, 16);
    const mat = new THREE.MeshStandardMaterial({ color: 0xb6d59a, roughness: 0.4, metalness: 0.0 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(cplane.normal.clone().multiplyScalar(r));
    mesh.userData.kind = "brep";
    mesh.userData.creator = "sphere";
    mesh.userData.cplaneKind = cplane.kind;
    linkCanonicalBrep(viewer, mesh, sphereBrep(r), "SdSphere");
    viewer.addMesh(mesh, "brep");
    return { created: mesh.uuid, object_id: mesh.uuid, canonical_id: mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY], primitive: "sphere", radius: r };
  });

  registerHandler("SdCylinder", (args) => {
    const r = (args.radius as number | undefined) ?? 0.5;
    const h = (args.height as number | undefined) ?? 2;
    const cplane = resolveCPlane("SdCylinder", args as Record<string, unknown>, viewer);
    const geom = new THREE.CylinderGeometry(r, r, h, 32);
    geom.rotateX(Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x9ec5d8, roughness: 0.55, metalness: 0.05 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), cplane.normal);
    mesh.position.copy(cplane.normal.clone().multiplyScalar(h / 2));
    mesh.userData.kind = "brep";
    mesh.userData.creator = "cylinder";
    mesh.userData.cplaneKind = cplane.kind;
    linkCanonicalBrep(viewer, mesh, cylinderBrep(r, h), "SdCylinder");
    viewer.addMesh(mesh, "brep");
    return { created: mesh.uuid, object_id: mesh.uuid, canonical_id: mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY], primitive: "cylinder", radius: r, height: h };
  });

  registerHandler("SdCone", (args) => {
    const r = ((args.radius ?? args.radius1) as number | undefined) ?? 0.5;
    const h = (args.height as number | undefined) ?? 2;
    const cplane = resolveCPlane("SdCone", args as Record<string, unknown>, viewer);
    const geom = new THREE.ConeGeometry(r, h, 32);
    geom.rotateX(Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xd0a868, roughness: 0.55, metalness: 0.05 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), cplane.normal);
    mesh.position.copy(cplane.normal.clone().multiplyScalar(h / 2));
    mesh.userData.kind = "brep";
    mesh.userData.creator = "cone";
    mesh.userData.cplaneKind = cplane.kind;
    linkCanonicalBrep(viewer, mesh, coneBrep(r, h), "SdCone");
    viewer.addMesh(mesh, "brep");
    return { created: mesh.uuid, object_id: mesh.uuid, canonical_id: mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY], primitive: "cone", radius: r, height: h };
  });

  registerHandler("SdExtrude", (args) => {
    const distance = (args.distance as number | undefined) ?? (args.height as number | undefined) ?? 1;
    const rawProfile = args.profile as [number, number][] | undefined;
    const objectId = args.object_id as string | undefined;
    const dirRaw = args.direction as [number, number, number] | undefined;

    let resolvedProfile: [number, number][] | undefined;
    if (objectId) {
      const srcObj = viewer.getScene().getObjectByProperty("uuid", objectId)
        ?? viewer.getScene().getObjectByProperty("name", objectId);
      if (srcObj) {
        resolvedProfile = canonicalCurveProfile2d(viewer, srcObj)
          ?? displayGeometryProfile2d(srcObj);
      }
    }

    const pts: [number, number][] | null = resolvedProfile
      ?? (Array.isArray(rawProfile) && rawProfile.length >= 3 ? (rawProfile as [number, number][]) : null);
    if (!pts) return { error: "SdExtrude — provide object_id referencing a sketch profile, or a profile array of [x,y] pairs (min 3 points); no profile resolved" };
    const shape = new THREE.Shape();
    shape.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
    shape.closePath();

    const geom = new THREE.ExtrudeGeometry(shape, { depth: distance, bevelEnabled: false });
    const mat = new THREE.MeshStandardMaterial({ color: 0xb8c4d4, roughness: 0.5, metalness: 0.05 });
    const mesh = new THREE.Mesh(geom, mat);

    if (dirRaw && !(dirRaw[0] === 0 && dirRaw[1] === 0 && dirRaw[2] === 1)) {
      const dir = new THREE.Vector3(...dirRaw).normalize();
      const up = new THREE.Vector3(0, 0, 1);
      mesh.quaternion.setFromUnitVectors(up, dir);
    }

    const cplane = resolveCPlane("SdExtrude", args as Record<string, unknown>, viewer);
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const bx = r3(pts[0][0]), by = r3(pts[0][1]), bd = r3(distance);
    const chain = `const ext = drawRectangle(1, 1).sketchOnPlane("XY").extrude(${bd}).translate([${bx}, ${by}, 0]);`;
    mesh.userData.kind = "brep";
    mesh.userData.creator = "extrude";
    mesh.userData.cplaneKind = cplane.kind;
    mesh.userData.layerId = resolveLayerId("SdExtrude", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    linkCanonicalBrep(viewer, mesh, extrudeBrep(polylineProfile(pts), { x: 0, y: 0, z: 1 }, distance), "SdExtrude");
    viewer.addMesh(mesh, "brep");
    return { created: mesh.uuid, object_id: mesh.uuid, canonical_id: mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY], primitive: "extrude", profile_points: pts.length, distance };
  });
}
