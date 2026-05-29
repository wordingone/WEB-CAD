import { registerHandler, registerRuntimeAlias } from "../commands/dispatch";
import { Viewer } from "../viewer/viewer";
import * as THREE from "three";
import { buildPoint, buildLine, buildRect, buildCircle, buildPolygon, buildPolyline, buildCurve } from "../tools/sketch";
import {
  Interval as PrimInterval,
  Point3 as Prim3,
  Plane as PrimPlane,
  Vector3 as PrimVector3,
  type Arc as PrimArc,
  type Point3,
} from "../nurbs/nurbs-primitives";
import {
  tessellate, createCatmullRomAsNurbs, createClampedUniformNurbs, type Curve,
  pointAt as curvePointAt, domain as curveDomain,
} from "../nurbs/nurbs-curves";
import { nurbsCurveFromArc } from "../nurbs/nurbs-curve-algorithms";
import { tessellateSurface, type Surface } from "../nurbs/nurbs-surfaces";
import { surfaceOfRevolution, sweepSurface, loftSurfaces } from "../nurbs/nurbs-surface-algorithms";
import { extrude as extrudeBrep } from "../nurbs/brep-extrude";
import { BREP_DEFAULT_TOLERANCE, type Brep, type BrepEdge, type BrepFace } from "../nurbs/nurbs-brep";
import { linkCanonicalBrep, linkCanonicalCurve, linkCanonicalPoint, linkCanonicalSurface } from "./canonical-surface";

// Suppress unused-import warnings for curve utilities used only via inference
void curvePointAt; void curveDomain;

function ptToArray(p: { x: number; y: number; z: number }): number[] {
  return [p.x, p.y, p.z];
}

function polylineToGeom(pts: { x: number; y: number; z: number }[]): THREE.BufferGeometry {
  const flat = pts.flatMap(p => [p.x, p.y, p.z]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
  return geom;
}

function curveMat(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color: 0x000000 });
}

function curveParameters(points: Point3[]): number[] {
  const params = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    params.push(params[i - 1] + Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2));
  }
  return params;
}

function lineNurbsCurveFromLocalEndpoints(a: Point3, b: Point3): Curve {
  return {
    kind: "nurbs",
    dim: 3,
    isRational: false,
    order: 2,
    cvCount: 2,
    knots: [0, 1],
    cvs: [a.x, a.y, a.z, b.x, b.y, b.z],
    cvStride: 3,
  };
}

function planeSurfaceFromThreePoints(origin: THREE.Vector3, xPoint: THREE.Vector3, yPoint: THREE.Vector3): Surface {
  const uVec = xPoint.clone().sub(origin);
  const vVec = yPoint.clone().sub(origin);
  const uLen = uVec.length();
  const vLen = vVec.length();
  if (uLen < 1e-9 || vLen < 1e-9) {
    throw new Error("SdPlane requires two non-zero plane axes");
  }
  const normalLen = uVec.clone().cross(vVec).length();
  if (normalLen < 1e-9) {
    throw new Error("SdPlane requires non-collinear xAxis and yAxis points");
  }
  const plane = PrimPlane.create(
    Prim3.create(origin.x, origin.y, origin.z),
    PrimVector3.create(uVec.x, uVec.y, uVec.z),
    PrimVector3.create(vVec.x, vVec.y, vVec.z),
  );
  return {
    kind: "plane",
    plane,
    uDomain: PrimInterval.create(0, uLen),
    vDomain: PrimInterval.create(0, vLen),
    uExtent: PrimInterval.create(0, uLen),
    vExtent: PrimInterval.create(0, vLen),
  };
}

function planarTrimmedBrepFromProfile(points: number[][]): Brep {
  const parsed = points.map((p) => ({
    x: p[0] ?? 0,
    y: p[1] ?? 0,
    z: p[2] ?? 0,
  }));
  const z0 = parsed[0]?.z ?? 0;
  if (parsed.some((p) => Math.abs(p.z - z0) > 1e-6)) {
    throw new Error("SdSurface requires a planar profile with constant z");
  }
  const minX = Math.min(...parsed.map((p) => p.x));
  const maxX = Math.max(...parsed.map((p) => p.x));
  const minY = Math.min(...parsed.map((p) => p.y));
  const maxY = Math.max(...parsed.map((p) => p.y));
  const width = maxX - minX;
  const depth = maxY - minY;
  if (width < 1e-9 || depth < 1e-9) {
    throw new Error("SdSurface requires a profile with non-zero area");
  }

  const surface: Surface = {
    kind: "plane",
    plane: PrimPlane.create(
      Prim3.create(minX, minY, z0),
      PrimVector3.xAxis(),
      PrimVector3.yAxis(),
    ),
    uDomain: PrimInterval.create(0, width),
    vDomain: PrimInterval.create(0, depth),
    uExtent: PrimInterval.create(0, width),
    vExtent: PrimInterval.create(0, depth),
  };
  const uvPoints = parsed.map((p) => Prim3.create(p.x - minX, p.y - minY, 0));
  const closedUvPoints = [...uvPoints];
  const first = closedUvPoints[0];
  const last = closedUvPoints[closedUvPoints.length - 1];
  if (first && last && (Math.abs(first.x - last.x) > 1e-9 || Math.abs(first.y - last.y) > 1e-9)) {
    closedUvPoints.push({ ...first });
  }
  const parameters = curveParameters(closedUvPoints);
  const outerCurve: Curve = {
    kind: "polyline",
    points: closedUvPoints,
    parameters,
  };
  const edges = parsed.map((p, i) => {
    const q = parsed[(i + 1) % parsed.length];
    return {
      curve: {
        kind: "line" as const,
        from: Prim3.create(p.x, p.y, p.z),
        to: Prim3.create(q.x, q.y, q.z),
        domain: PrimInterval.create(0, Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z)),
      },
      faceIndex1: 0,
      faceIndex2: null,
      tolerance: BREP_DEFAULT_TOLERANCE,
    };
  });
  return {
    shells: [{
      faces: [{
        surface,
        outerLoop: { curves: [outerCurve], orientation: true },
        innerLoops: [],
        orientation: true,
        tolerance: BREP_DEFAULT_TOLERANCE,
      }],
      edges,
      vertices: parsed.map((p, i) => ({
        point: Prim3.create(p.x, p.y, p.z),
        edgeIndices: [i, (i + parsed.length - 1) % parsed.length],
        tolerance: BREP_DEFAULT_TOLERANCE,
      })),
      isClosed: false,
    }],
  };
}

function resolveCurve(arg: unknown): Curve {
  if (arg && typeof arg === "object" && !Array.isArray(arg)) {
    const obj = arg as Record<string, unknown>;
    if (obj.kind === "line" && Array.isArray(obj.from) && Array.isArray(obj.to)) {
      const [fx=0,fy=0,fz=0] = obj.from as number[];
      const [tx=0,ty=0,tz=0] = obj.to as number[];
      const len = Math.sqrt((tx-fx)**2+(ty-fy)**2+(tz-fz)**2);
      return { kind: "line", from: {x:fx,y:fy,z:fz}, to: {x:tx,y:ty,z:tz}, domain: {min:0,max:len} };
    }
    if (obj.kind === "arc" && typeof obj.radius === "number") {
      const [cx=0,cy=0,cz=0] = (obj.center as number[] | undefined) ?? [0,0,0];
      return {
        kind: "arc",
        center: {x:cx,y:cy,z:cz},
        radius: obj.radius as number,
        startAngle: (obj.startAngle as number) ?? 0,
        endAngle: (obj.endAngle as number) ?? 2*Math.PI,
        plane: { origin: {x:cx,y:cy,z:cz}, xAxis: {x:1,y:0,z:0}, yAxis: {x:0,y:1,z:0}, normal: {x:0,y:0,z:1} },
        domain: { min: 0, max: (obj.radius as number) * ((obj.endAngle as number ?? 2*Math.PI) - (obj.startAngle as number ?? 0)) },
      };
    }
    if (Array.isArray(obj.points) && (obj.points as unknown[]).length >= 2) {
      const pts = (obj.points as number[][]).map(p => ({x:p[0]??0,y:p[1]??0,z:p[2]??0}));
      const params: number[] = [0];
      for (let i = 1; i < pts.length; i++) {
        const dx=pts[i].x-pts[i-1].x, dy=pts[i].y-pts[i-1].y, dz=pts[i].z-pts[i-1].z;
        params.push(params[i-1] + Math.sqrt(dx*dx+dy*dy+dz*dz));
      }
      return { kind: "polyline", points: pts, parameters: params };
    }
  }
  throw new Error(`resolveCurve: unrecognised curve description: ${JSON.stringify(arg)}`);
}

function surfaceToMesh(tess: ReturnType<typeof tessellateSurface>): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(tess.positions, 3));
  geo.setAttribute("normal",   new THREE.BufferAttribute(tess.normals, 3));
  geo.setAttribute("uv",       new THREE.BufferAttribute(tess.uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(tess.indices, 1));
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, color: 0xe8e0d8 }));
}

function isFullCircle(start: number, end: number): boolean {
  return Math.abs(Math.abs(end - start) - Math.PI * 2) < 1e-4;
}

function isWorldZAxis(axis: { from: Point3; to: Point3 }): boolean {
  return Math.abs(axis.from.x) < 1e-9
    && Math.abs(axis.from.y) < 1e-9
    && Math.abs(axis.to.x) < 1e-9
    && Math.abs(axis.to.y) < 1e-9
    && Math.abs(axis.to.z - axis.from.z) > 1e-9;
}

function trimCircle(radius: number, samples = 64): Curve {
  const points: Point3[] = [];
  const parameters: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * Math.PI * 2;
    points.push({ x: Math.cos(t) * radius, y: Math.sin(t) * radius, z: 0 });
    parameters.push(t * radius);
  }
  return { kind: "polyline", points, parameters };
}

function circularCapFace(z: number, radius: number, orientation: boolean): BrepFace {
  return {
    surface: {
      kind: "plane",
      plane: {
        origin: { x: 0, y: 0, z },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
      },
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
      endAngle: Math.PI * 2,
      plane: {
        origin: { x: 0, y: 0, z },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
      },
      domain: { min: 0, max: Math.PI * 2 * radius },
    },
    faceIndex1,
    faceIndex2,
    tolerance: BREP_DEFAULT_TOLERANCE,
  };
}

function revolvedLineSolidBrep(surface: Surface, profile: Curve, axis: { from: Point3; to: Point3 }, start: number, end: number): Brep | null {
  if (profile.kind !== "line" || !isWorldZAxis(axis) || !isFullCircle(start, end)) return null;
  const r0 = Math.hypot(profile.from.x, profile.from.y);
  const r1 = Math.hypot(profile.to.x, profile.to.y);
  if (r0 < 1e-9 || Math.abs(r0 - r1) > 1e-6) return null;
  const bottom = Math.min(profile.from.z, profile.to.z);
  const top = Math.max(profile.from.z, profile.to.z);
  if (Math.abs(top - bottom) < 1e-9) return null;
  return {
    shells: [{
      faces: [
        {
          surface,
          outerLoop: { curves: [], orientation: true },
          innerLoops: [],
          orientation: true,
          tolerance: BREP_DEFAULT_TOLERANCE,
        },
        circularCapFace(bottom, r0, false),
        circularCapFace(top, r0, true),
      ],
      edges: [
        circleEdge(bottom, r0, 0, 1),
        circleEdge(top, r0, 0, 2),
      ],
      vertices: [],
      isClosed: true,
    }],
  };
}

function closedProfile(profile: Curve): boolean {
  if (profile.kind === "polyline") {
    if (profile.points.length < 4) return false;
    const first = profile.points[0];
    const last = profile.points[profile.points.length - 1];
    return Math.hypot(first.x - last.x, first.y - last.y, first.z - last.z) < 1e-9;
  }
  if (profile.kind === "arc") {
    return Math.abs(Math.abs(profile.endAngle - profile.startAngle) - Math.PI * 2) < 1e-4;
  }
  return false;
}

function translateCurve(curve: Curve, offset: Point3): Curve {
  const translate = (p: Point3): Point3 => ({ x: p.x + offset.x, y: p.y + offset.y, z: p.z + offset.z });
  if (curve.kind === "line") return { ...curve, from: translate(curve.from), to: translate(curve.to) };
  if (curve.kind === "polyline") return { ...curve, points: curve.points.map(translate) };
  if (curve.kind === "arc") return { ...curve, center: translate(curve.center), plane: { ...curve.plane, origin: translate(curve.plane.origin) } };
  const cvs = [...curve.cvs];
  for (let i = 0; i < curve.cvCount; i++) {
    const base = i * curve.cvStride;
    cvs[base] = (cvs[base] ?? 0) + offset.x;
    cvs[base + 1] = (cvs[base + 1] ?? 0) + offset.y;
    cvs[base + 2] = (cvs[base + 2] ?? 0) + offset.z;
  }
  return { ...curve, cvs };
}

function straightRailSolidSweepBrep(profile: Curve, rail: Curve): Brep | null {
  if (rail.kind !== "line" || !closedProfile(profile)) return null;
  const dx = rail.to.x - rail.from.x;
  const dy = rail.to.y - rail.from.y;
  const dz = rail.to.z - rail.from.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (distance < 1e-9) return null;
  const placedProfile = translateCurve(profile, rail.from);
  return extrudeBrep(placedProfile, { x: dx / distance, y: dy / distance, z: dz / distance }, distance);
}

export function registerSketchHandlers(viewer: Viewer): void {
  registerHandler("SdPoint", (args) => {
    const pos = (args.position as number[] | undefined) ?? [0, 0];
    const p = { x: pos[0] ?? 0, y: pos[1] ?? 0 };
    const { mesh, chain } = buildPoint(p);
    mesh.userData.creator = "point";
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    linkCanonicalPoint(viewer, mesh, { x: 0, y: 0, z: 0 }, "SdPoint", {
      worldPoint: [p.x, p.y, 0],
    });
    viewer.addMesh(mesh, "mesh");
    return { created: "point", position: [p.x, p.y, 0] };
  });

  registerHandler("SdLine", (args) => {
    const start = (args.start as number[] | undefined) ?? [0, 0];
    const end   = (args.end   as number[] | undefined) ?? [1, 0];
    const a = { x: start[0] ?? 0, y: start[1] ?? 0 };
    const b = { x: end[0] ?? 1, y: end[1] ?? 0 };
    const { mesh, chain } = buildLine(a, b);
    mesh.userData.creator = "line";
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    const localPoints = (mesh.userData.controlPoints as THREE.Vector3[])
      .map((p) => ({ x: p.x, y: p.y, z: p.z }));
    linkCanonicalCurve(viewer, mesh, lineNurbsCurveFromLocalEndpoints(localPoints[0], localPoints[1]), "SdLine", {
      worldStart: [a.x, a.y, 0],
      worldEnd: [b.x, b.y, 0],
    });
    viewer.addMesh(mesh, "mesh");
    return { created: "line", start, end };
  });

  registerRuntimeAlias("SdRect", "SdRectangle");
  registerHandler("SdRectangle", (args) => {
    const hasShorthand = "w" in args || "d" in args;
    const w = hasShorthand
      ? ((args.w as number | undefined) ?? 1)
      : ((args.width as number | undefined) ?? 1);
    const d = hasShorthand
      ? ((args.d as number | undefined) ?? 1)
      : ((args.length as number | undefined) ?? (args.height as number | undefined) ?? 1);
    const cx = hasShorthand
      ? ((args.x as number | undefined) ?? 0)
      : ((args.center as number[] | undefined)?.[0] ?? 0);
    const cy = hasShorthand
      ? ((args.y as number | undefined) ?? 0)
      : ((args.center as number[] | undefined)?.[1] ?? 0);
    const a = { x: cx - w / 2, y: cy - d / 2 };
    const b = { x: cx + w / 2, y: cy + d / 2 };
    const { mesh, chain } = buildRect(a, b);
    mesh.userData.creator = "rect";
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    const localPoints = [
      { x: -w / 2, y: -d / 2, z: 0 },
      { x:  w / 2, y: -d / 2, z: 0 },
      { x:  w / 2, y:  d / 2, z: 0 },
      { x: -w / 2, y:  d / 2, z: 0 },
      { x: -w / 2, y: -d / 2, z: 0 },
    ];
    linkCanonicalCurve(viewer, mesh, {
      kind: "polyline",
      points: localPoints,
      parameters: curveParameters(localPoints),
    }, "SdRectangle", {
      worldCenter: [cx, cy, 0],
      worldPoints: [[a.x, a.y, 0], [b.x, a.y, 0], [b.x, b.y, 0], [a.x, b.y, 0], [a.x, a.y, 0]],
      closed: true,
    });
    viewer.addMesh(mesh, "mesh");
    return { created: "rectangle", width: w, depth: d };
  });

  registerHandler("SdPolyline", (args) => {
    const points = (args.points as number[][] | undefined) ?? [];
    if (points.length < 2) return { error: "SdPolyline requires at least 2 points", created: null };
    const pts = points.map((p) => ({ x: p[0] ?? 0, y: p[1] ?? 0 }));
    const { mesh, chain } = buildPolyline(pts);
    mesh.userData.creator = "polyline";
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    const localPoints = (mesh.userData.controlPoints as THREE.Vector3[]).map((p) => ({ x: p.x, y: p.y, z: p.z }));
    linkCanonicalCurve(viewer, mesh, {
      kind: "polyline",
      points: localPoints,
      parameters: curveParameters(localPoints),
    }, "SdPolyline", {
      worldPoints: pts.map((p) => [p.x, p.y, 0]),
      closed: mesh.userData.isClosed === true,
    });
    viewer.addMesh(mesh, "mesh");
    return { created: "polyline", points };
  });

  registerHandler("SdArc", (args) => {
    const c = (args.center as number[] | undefined) ?? [0, 0, 0];
    const radius = (args.radius as number | undefined) ?? 1;
    const startAngle = (args.startAngle as number | undefined) ?? 0;
    const endAngle   = (args.endAngle   as number | undefined) ?? Math.PI / 2;
    const arc: PrimArc = {
      center: Prim3.create(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0),
      radius,
      startAngle,
      endAngle,
      plane: PrimPlane.worldXY(),
    };
    const nurbs = nurbsCurveFromArc(arc);
    const pts = tessellate(nurbs, 64);
    const obj = new THREE.Line(polylineToGeom(pts), curveMat());
    obj.userData.kind = "arc";
    obj.userData.creator = "arc";
    linkCanonicalCurve(viewer, obj, {
      kind: "arc",
      center: arc.center,
      radius,
      startAngle,
      endAngle,
      plane: arc.plane,
      domain: { min: 0, max: radius * Math.abs(endAngle - startAngle) },
    }, "SdArc");
    viewer.addMesh(obj, "mesh");
    return { created: "arc", center: ptToArray(arc.center), radius, startAngle, endAngle };
  });

  registerHandler("SdCircle", (args) => {
    const c = (args.center as number[] | undefined) ?? [0, 0];
    const radius = (args.radius as number | undefined) ?? 1;
    const center = { x: c[0] ?? 0, y: c[1] ?? 0 };
    const radial = { x: center.x + radius, y: center.y };
    const { mesh, chain } = buildCircle(center, radial);
    mesh.userData.creator = "circle";
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    linkCanonicalCurve(viewer, mesh, {
      kind: "arc",
      center: { x: 0, y: 0, z: 0 },
      radius,
      startAngle: 0,
      endAngle: 2 * Math.PI,
      plane: PrimPlane.worldXY(),
      domain: { min: 0, max: 2 * Math.PI * radius },
    }, "SdCircle", {
      worldCenter: [center.x, center.y, 0],
      radius,
    });
    viewer.addMesh(mesh, "mesh");
    return { created: "circle", center: [center.x, center.y, 0], radius };
  });

  registerHandler("SdPolygon", (args) => {
    const c = (args.center as number[] | undefined) ?? [0, 0];
    const radius = Math.max(0.05, (args.radius as number | undefined) ?? 1);
    const sides = Math.max(3, Math.floor((args.sides as number | undefined) ?? 6));
    const center = { x: c[0] ?? 0, y: c[1] ?? 0 };
    const radial = { x: center.x + radius, y: center.y };
    const { mesh, chain } = buildPolygon(center, radial, sides);
    mesh.userData.creator = "polygon";
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    const localPoints = ((mesh.userData.controlPoints as THREE.Vector3[] | undefined) ?? [])
      .map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const closedPoints = localPoints.length > 0
      ? [...localPoints, { ...localPoints[0] }]
      : localPoints;
    linkCanonicalCurve(viewer, mesh, {
      kind: "polyline",
      points: closedPoints,
      parameters: curveParameters(closedPoints),
    }, "SdPolygon", {
      worldCenter: [center.x, center.y, 0],
      radius,
      sides,
      closed: true,
    });
    viewer.addMesh(mesh, "mesh");
    return { created: "polygon", center: [center.x, center.y, 0], radius, sides };
  });

  registerHandler("SdEllipse", (args) => {
    const c  = (args.center as number[] | undefined) ?? [0, 0, 0];
    const rx = (args.rx as number | undefined) ?? (args.radiusX as number | undefined) ?? 1;
    const ry = (args.ry as number | undefined) ?? (args.radiusY as number | undefined) ?? 0.5;
    const center = Prim3.create(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0);
    const unitArc: PrimArc = {
      center: { x: 0, y: 0, z: 0 },
      radius: 1,
      startAngle: 0,
      endAngle: 2 * Math.PI,
      plane: PrimPlane.worldXY(),
    };
    const unitNurbs = nurbsCurveFromArc(unitArc);
    const newCvs: number[] = [];
    for (let i = 0; i < unitNurbs.cvCount; i++) {
      const base = i * 4;
      const w  = unitNurbs.cvs[base + 3] ?? 1;
      const ex = (unitNurbs.cvs[base + 0] ?? 0) / w;
      const ey = (unitNurbs.cvs[base + 1] ?? 0) / w;
      const newX = center.x + ex * rx;
      const newY = center.y + ey * ry;
      const newZ = center.z;
      newCvs.push(newX * w, newY * w, newZ * w, w);
    }
    const ellipseNurbs = { ...unitNurbs, cvs: newCvs };
    const pts = tessellate(ellipseNurbs, 128);
    const obj = new THREE.LineLoop(polylineToGeom(pts), curveMat());
    obj.userData.kind = "ellipse";
    obj.userData.creator = "ellipse";
    linkCanonicalCurve(viewer, obj, ellipseNurbs, "SdEllipse", {
      center: ptToArray(center),
      rx,
      ry,
    });
    viewer.addMesh(obj, "mesh");
    return { created: "ellipse", center: ptToArray(center), rx, ry };
  });

  registerHandler("SdSpline", (args) => {
    const rawPts = (args.points as number[][] | undefined) ?? [];
    if (rawPts.length < 4) {
      return { error: "SdSpline requires at least 4 points (cubic spline)", created: null };
    }
    const pts3 = rawPts.map(p => Prim3.create(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0));
    const nurbs = createClampedUniformNurbs(3, 4, pts3);
    const tess = tessellate(nurbs, pts3.length * 16);
    const obj = new THREE.Line(polylineToGeom(tess), curveMat());
    obj.userData.kind = "spline";
    obj.userData.creator = "spline";
    obj.userData.controlPoints = pts3.map(p => new THREE.Vector3(p.x, p.y, p.z));
    linkCanonicalCurve(viewer, obj, nurbs, "SdSpline", {
      controlPoints: pts3.map((p) => ptToArray(p)),
    });
    viewer.addMesh(obj, "mesh");
    return { created: "spline", points: pts3.map(p => ptToArray(p)) };
  });

  registerHandler("SdCurve", (args) => {
    const rawPts = (args.points as number[][] | undefined) ?? [];
    if (rawPts.length < 2) {
      return { error: "SdCurve requires at least 2 points", created: null };
    }
    const pts = rawPts.map(p => ({ x: p[0] ?? 0, y: p[1] ?? 0 }));
    const { mesh } = buildCurve(pts);
    mesh.userData.creator = "curve";
    const localPoints = (mesh.userData.controlPoints as THREE.Vector3[]).map((p) => ({ x: p.x, y: p.y, z: p.z }));
    linkCanonicalCurve(viewer, mesh, createCatmullRomAsNurbs(localPoints, {
      closed: mesh.userData.isClosed === true,
    }), "SdCurve", {
      worldPoints: pts.map((p) => [p.x, p.y, 0]),
      closed: mesh.userData.isClosed === true,
    });
    viewer.addMesh(mesh, "mesh");
    return { created: "curve", points: pts.length, nurbsKind: "catmull-rom" };
  });

  registerHandler("SdRevolve", (args) => {
    try {
      const profile = resolveCurve(args.profile);
      const [ax=0,ay=0,az=0] = (args.axisFrom as number[] | undefined) ?? [0,0,0];
      const [bx=0,by=0,bz=1] = (args.axisTo   as number[] | undefined) ?? [0,0,1];
      const start = (args.angleStart as number) ?? 0;
      const end   = (args.angleEnd   as number) ?? 2 * Math.PI;
      const axis = { from: {x:ax,y:ay,z:az}, to: {x:bx,y:by,z:bz} };
      const surface = surfaceOfRevolution(profile, axis, start, end);
      const tess = tessellateSurface(surface, 32, 64);
      const obj = surfaceToMesh(tess);
      obj.userData.kind = "revolution";
      obj.userData.creator = "revolve";
      const solidBrep = args.solid === true ? revolvedLineSolidBrep(surface, profile, axis, start, end) : null;
      if (solidBrep) {
        obj.userData.kind = "brep";
        linkCanonicalBrep(viewer, obj, solidBrep, "SdRevolve");
      } else {
        linkCanonicalSurface(viewer, obj, "SdRevolve", surface);
      }
      viewer.addMesh(obj, "mesh");
      return { created: "revolution", axisFrom: args.axisFrom, axisTo: args.axisTo, angleStart: start, angleEnd: end, solid: Boolean(solidBrep) };
    } catch (e) {
      return { error: String(e), created: null };
    }
  });

  registerHandler("SdSweep", (args) => {
    try {
      const profile = resolveCurve(args.profile);
      const rail    = resolveCurve((args.rail ?? args.path) as unknown);
      const surface = sweepSurface(profile, rail, { keepFrame: (args.keepFrame as boolean) ?? false });
      const tess = tessellateSurface(surface, 32, 32);
      const obj = surfaceToMesh(tess);
      obj.userData.kind = "sweep";
      obj.userData.creator = "sweep";
      const solidBrep = args.solid === true ? straightRailSolidSweepBrep(profile, rail) : null;
      if (solidBrep) {
        obj.userData.kind = "brep";
        linkCanonicalBrep(viewer, obj, solidBrep, "SdSweep");
      } else {
        linkCanonicalSurface(viewer, obj, "SdSweep", surface);
      }
      viewer.addMesh(obj, "mesh");
      return { created: "sweep", solid: Boolean(solidBrep) };
    } catch (e) {
      return { error: String(e), created: null };
    }
  });

  registerHandler("SdLoft", (args) => {
    try {
      const rawCurves = ((args.curves ?? args.sections) as unknown[] | undefined) ?? [];
      if (rawCurves.length < 2) return { error: "SdLoft requires at least 2 curves", created: null };
      const curves = rawCurves.map((c) => resolveCurve(c));
      const surface = loftSurfaces(curves, {
        closed:  (args.closed  as boolean) ?? false,
        degreeV: (args.degreeV as number)  ?? Math.min(3, curves.length - 1),
      });
      const tess = tessellateSurface(surface, 32, 32);
      const obj = surfaceToMesh(tess);
      obj.userData.kind = "loft";
      obj.userData.creator = "loft";
      linkCanonicalSurface(viewer, obj, "SdLoft", surface);
      viewer.addMesh(obj, "mesh");
      return { created: "loft", curveCount: curves.length };
    } catch (e) {
      return { error: String(e), created: null };
    }
  });

  registerHandler("SdPlane", (args) => {
    try {
      const [ox=0,oy=0,oz=0] = (args.origin  as number[] | undefined) ?? [];
      const [ux=1,uy=0,uz=0] = (args.xAxis   as number[] | undefined) ?? [];
      const [vx=0,vy=1,vz=0] = (args.yAxis   as number[] | undefined) ?? [];
      const o  = new THREE.Vector3(ox, oy, oz);
      const uv = new THREE.Vector3(ux, uy, uz).sub(o);
      const vv = new THREE.Vector3(vx, vy, vz).sub(o);
      const c0 = o.clone();
      const c1 = o.clone().add(uv);
      const c2 = o.clone().add(uv).add(vv);
      const c3 = o.clone().add(vv);
      const positions = new Float32Array([
        c0.x, c0.y, c0.z,
        c1.x, c1.y, c1.z,
        c2.x, c2.y, c2.z,
        c3.x, c3.y, c3.z,
      ]);
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geom.setIndex([0, 1, 2, 0, 2, 3]);
      geom.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: 0x88aacc, side: THREE.DoubleSide, transparent: true, opacity: 0.5 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData.kind = "plane";
      mesh.userData.creator = "plane";
      linkCanonicalSurface(viewer, mesh, "SdPlane", planeSurfaceFromThreePoints(o, c1, c3));
      viewer.addMesh(mesh, "mesh");
      return { created: "plane" };
    } catch (e) {
      return { error: String(e), created: null };
    }
  });

  registerHandler("SdSurface", (args) => {
    try {
      const raw = (args.profile ?? args.points) as unknown;
      let pts: number[][];
      if (Array.isArray(raw) && Array.isArray(raw[0])) {
        pts = raw as number[][];
      } else if (raw && typeof raw === "object" && "points" in (raw as object)) {
        pts = (raw as { points: number[][] }).points;
      } else {
        return { error: "SdSurface: provide profile with points or points array", created: null };
      }
      if (pts.length < 3) return { error: "SdSurface requires at least 3 points", created: null };
      const z0 = pts[0][2] ?? 0;
      const shape = new THREE.Shape();
      shape.moveTo(pts[0][0], pts[0][1]);
      for (const p of pts.slice(1)) shape.lineTo(p[0], p[1]);
      shape.closePath();
      const geom = new THREE.ShapeGeometry(shape);
      geom.translate(0, 0, z0);
      const mat = new THREE.MeshStandardMaterial({ color: 0x4499cc, side: THREE.DoubleSide, transparent: true, opacity: 0.6 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData.kind = "surface";
      mesh.userData.creator = "surface";
      linkCanonicalBrep(viewer, mesh, planarTrimmedBrepFromProfile(pts), "SdSurface");
      viewer.addMesh(mesh, "mesh");
      return { created: "surface" };
    } catch (e) {
      return { error: String(e), created: null };
    }
  });
}
