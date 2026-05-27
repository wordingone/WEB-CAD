import * as THREE from "three";
import type { CanonicalGeometry } from "../geometry/canonical-geometry";
import type { Curve } from "../nurbs/nurbs-curves";
import type { Point3 } from "../nurbs/nurbs-primitives";
import type { RevSurface, Surface } from "../nurbs/nurbs-surfaces";
import {
  nurbsSurfaceFromGrid,
  type NurbsSurface as KernelNurbsSurface,
  type Vec3,
} from "../nurbs/nurbs-kernel";

const TOLERANCE = 1e-9;
const TWO_PI = Math.PI * 2;
const QUARTER_ARC_WEIGHT = Math.SQRT1_2;
const FULL_CIRCLE_KNOTS = [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1];

type WeightedProfilePoint = {
  radial: number;
  z: number;
  weight: number;
};

function toVec3(point: Point3, matrix?: THREE.Matrix4): Vec3 {
  const v = new THREE.Vector3(point.x, point.y, point.z);
  if (matrix) v.applyMatrix4(matrix);
  return [v.x, v.y, v.z];
}

function lineDelta(curve: Curve): Point3 | null {
  if (curve.kind !== "line") return null;
  return {
    x: curve.to.x - curve.from.x,
    y: curve.to.y - curve.from.y,
    z: curve.to.z - curve.from.z,
  };
}

function isFullZAxisRevolution(surface: RevSurface): boolean {
  const axis = surface.axis;
  return !surface.transposed
    && Math.abs(axis.from.x) <= TOLERANCE
    && Math.abs(axis.from.y) <= TOLERANCE
    && Math.abs(axis.from.z) <= TOLERANCE
    && Math.abs(axis.to.x) <= TOLERANCE
    && Math.abs(axis.to.y) <= TOLERANCE
    && Math.abs(axis.to.z - 1) <= TOLERANCE
    && Math.abs(surface.angle.min) <= TOLERANCE
    && Math.abs(surface.angle.max - TWO_PI) <= TOLERANCE;
}

function pointToProfileControl(point: Point3, weight = 1): WeightedProfilePoint {
  return {
    radial: Math.hypot(point.x, point.y),
    z: point.z,
    weight,
  };
}

function knotsForQuadraticSegments(segmentCount: number): number[] {
  const knots = [0, 0, 0];
  for (let i = 1; i < segmentCount; i++) {
    const t = i / segmentCount;
    knots.push(t, t);
  }
  knots.push(1, 1, 1);
  return knots;
}

function arcProfileControls(curve: Extract<Curve, { kind: "arc" }>): {
  controls: WeightedProfilePoint[];
  knots: number[];
} | null {
  const total = curve.endAngle - curve.startAngle;
  const segmentCount = Math.max(1, Math.ceil(Math.abs(total) / (Math.PI / 2)));
  const delta = total / segmentCount;
  if (Math.abs(delta) > Math.PI / 2 + TOLERANCE) return null;

  const controls: WeightedProfilePoint[] = [];
  for (let i = 0; i < segmentCount; i++) {
    const a0 = curve.startAngle + delta * i;
    const a1 = curve.startAngle + delta * (i + 1);
    const mid = (a0 + a1) / 2;
    const half = (a1 - a0) / 2;
    const weight = Math.cos(half);
    if (Math.abs(weight) <= TOLERANCE) return null;

    const startPoint = {
      x: curve.center.x + curve.radius * (Math.cos(a0) * curve.plane.xAxis.x + Math.sin(a0) * curve.plane.yAxis.x),
      y: curve.center.y + curve.radius * (Math.cos(a0) * curve.plane.xAxis.y + Math.sin(a0) * curve.plane.yAxis.y),
      z: curve.center.z + curve.radius * (Math.cos(a0) * curve.plane.xAxis.z + Math.sin(a0) * curve.plane.yAxis.z),
    };
    const midPoint = {
      x: curve.center.x + (curve.radius / weight) * (Math.cos(mid) * curve.plane.xAxis.x + Math.sin(mid) * curve.plane.yAxis.x),
      y: curve.center.y + (curve.radius / weight) * (Math.cos(mid) * curve.plane.xAxis.y + Math.sin(mid) * curve.plane.yAxis.y),
      z: curve.center.z + (curve.radius / weight) * (Math.cos(mid) * curve.plane.xAxis.z + Math.sin(mid) * curve.plane.yAxis.z),
    };
    const endPoint = {
      x: curve.center.x + curve.radius * (Math.cos(a1) * curve.plane.xAxis.x + Math.sin(a1) * curve.plane.yAxis.x),
      y: curve.center.y + curve.radius * (Math.cos(a1) * curve.plane.xAxis.y + Math.sin(a1) * curve.plane.yAxis.y),
      z: curve.center.z + curve.radius * (Math.cos(a1) * curve.plane.xAxis.z + Math.sin(a1) * curve.plane.yAxis.z),
    };

    if (i === 0) controls.push(pointToProfileControl(startPoint));
    controls.push(pointToProfileControl(midPoint, weight));
    controls.push(pointToProfileControl(endPoint));
  }

  return { controls, knots: knotsForQuadraticSegments(segmentCount) };
}

function profileControlsForRevolution(surface: RevSurface): {
  controls: WeightedProfilePoint[];
  knots: number[];
  degree: number;
} | null {
  const profile = surface.profile;
  if (profile.kind === "line") {
    return {
      controls: [pointToProfileControl(profile.from), pointToProfileControl(profile.to)],
      knots: [0, 0, 1, 1],
      degree: 1,
    };
  }
  if (profile.kind === "arc") {
    const arc = arcProfileControls(profile);
    if (!arc) return null;
    return { ...arc, degree: 2 };
  }
  return null;
}

function revSurfaceToIfcNurbs(surface: RevSurface, matrix?: THREE.Matrix4): KernelNurbsSurface | null {
  if (!isFullZAxisRevolution(surface)) return null;
  const profile = profileControlsForRevolution(surface);
  if (!profile) return null;

  const circle = [
    { x: 1, y: 0, weight: 1 },
    { x: 1, y: 1, weight: QUARTER_ARC_WEIGHT },
    { x: 0, y: 1, weight: 1 },
    { x: -1, y: 1, weight: QUARTER_ARC_WEIGHT },
    { x: -1, y: 0, weight: 1 },
    { x: -1, y: -1, weight: QUARTER_ARC_WEIGHT },
    { x: 0, y: -1, weight: 1 },
    { x: 1, y: -1, weight: QUARTER_ARC_WEIGHT },
    { x: 1, y: 0, weight: 1 },
  ];

  const grid: Vec3[][] = [];
  const weights: number[][] = [];
  for (const p of profile.controls) {
    const row: Vec3[] = [];
    const weightRow: number[] = [];
    for (const c of circle) {
      row.push(toVec3({ x: p.radial * c.x, y: p.radial * c.y, z: p.z }, matrix));
      weightRow.push(p.weight * c.weight);
    }
    grid.push(row);
    weights.push(weightRow);
  }

  return nurbsSurfaceFromGrid(grid, weights, profile.knots, FULL_CIRCLE_KNOTS, profile.degree, 2);
}

export function surfaceToIfcNurbs(surface: Surface, matrix?: THREE.Matrix4): KernelNurbsSurface | null {
  switch (surface.kind) {
    case "sum": {
      const u = lineDelta(surface.curveU);
      const v = lineDelta(surface.curveV);
      if (!u || !v) return null;
      const p00 = surface.basepoint;
      const p10 = { x: p00.x + u.x, y: p00.y + u.y, z: p00.z + u.z };
      const p01 = { x: p00.x + v.x, y: p00.y + v.y, z: p00.z + v.z };
      const p11 = { x: p00.x + u.x + v.x, y: p00.y + u.y + v.y, z: p00.z + u.z + v.z };
      return nurbsSurfaceFromGrid(
        [
          [toVec3(p00, matrix), toVec3(p01, matrix)],
          [toVec3(p10, matrix), toVec3(p11, matrix)],
        ],
        undefined,
        undefined,
        undefined,
        1,
        1,
      );
    }
    case "nurbs": {
      const [countU, countV] = surface.cvCount;
      const [orderU, orderV] = surface.order;
      const stride = surface.dim + (surface.isRational ? 1 : 0);
      const grid: Vec3[][] = [];
      const weights: number[][] = [];
      for (let i = 0; i < countU; i++) {
        const row: Vec3[] = [];
        const weightRow: number[] = [];
        for (let j = 0; j < countV; j++) {
          const base = (i * countV + j) * stride;
          const w = surface.isRational ? surface.cvs[base + surface.dim] ?? 1 : 1;
          const point = {
            x: surface.isRational && w !== 0 ? surface.cvs[base] / w : surface.cvs[base],
            y: surface.isRational && w !== 0 ? surface.cvs[base + 1] / w : surface.cvs[base + 1],
            z: surface.isRational && w !== 0 ? surface.cvs[base + 2] / w : surface.cvs[base + 2],
          };
          row.push(toVec3(point, matrix));
          weightRow.push(w);
        }
        grid.push(row);
        weights.push(weightRow);
      }
      return nurbsSurfaceFromGrid(grid, weights, surface.knots[0], surface.knots[1], orderU - 1, orderV - 1);
    }
    case "rev":
      return revSurfaceToIfcNurbs(surface, matrix);
    default:
      return null;
  }
}

export function canonicalGeometryToIfcNurbs(
  canonical: CanonicalGeometry | undefined,
  matrix?: THREE.Matrix4,
): KernelNurbsSurface | null {
  if (!canonical || canonical.kind !== "surface") return null;
  return surfaceToIfcNurbs(canonical.surface, matrix);
}
