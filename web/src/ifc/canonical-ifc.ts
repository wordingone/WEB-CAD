import * as THREE from "three";
import type { CanonicalGeometry } from "../geometry/canonical-geometry";
import type { Curve } from "../nurbs/nurbs-curves";
import type { Point3 } from "../nurbs/nurbs-primitives";
import type { Surface } from "../nurbs/nurbs-surfaces";
import {
  nurbsSurfaceFromGrid,
  type NurbsSurface as KernelNurbsSurface,
  type Vec3,
} from "../nurbs/nurbs-kernel";

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
