import * as THREE from "three";
import { linkCanonicalBrep } from "../handlers/canonical-surface";
import { extrude as extrudeBrep } from "../nurbs/brep-extrude";
import type { Curve, PolylineCurve } from "../nurbs/nurbs-curves";
import type { Plane } from "../nurbs/nurbs-primitives";
import type { Viewer } from "./viewer";

type FootprintPoint = { x: number; y: number };

function polylineProfile(points: FootprintPoint[]): PolylineCurve | null {
  if (points.length < 3) return null;
  const profilePoints = points.map(({ x, y }) => ({ x, y, z: 0 }));
  const first = profilePoints[0];
  const last = profilePoints[profilePoints.length - 1];
  if (Math.hypot(first.x - last.x, first.y - last.y, first.z - last.z) > 1e-9) {
    profilePoints.push({ ...first });
  }
  const parameters = [0];
  for (let i = 1; i < profilePoints.length; i++) {
    const a = profilePoints[i - 1];
    const b = profilePoints[i];
    parameters.push(parameters[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  return { kind: "polyline", points: profilePoints, parameters };
}

function footprintCurve(mesh: THREE.Mesh): Curve | null {
  const footprintCircle = mesh.userData.footprintCircle as { cx: number; cy: number; r: number } | undefined;
  if (footprintCircle && footprintCircle.r > 0) {
    const plane: Plane = {
      origin: { x: footprintCircle.cx, y: footprintCircle.cy, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    };
    return {
      kind: "arc",
      center: { x: footprintCircle.cx, y: footprintCircle.cy, z: 0 },
      radius: footprintCircle.r,
      startAngle: 0,
      endAngle: Math.PI * 2,
      plane,
      domain: { min: 0, max: Math.PI * 2 * footprintCircle.r },
    };
  }

  const footprint = mesh.userData.footprintPts as FootprintPoint[] | undefined;
  return footprint ? polylineProfile(footprint) : null;
}

export function linkOpToolExtrudeCanonical(viewer: Viewer, mesh: THREE.Mesh, height: number): boolean {
  const profile = footprintCurve(mesh);
  if (!profile || height <= 0) return false;
  linkCanonicalBrep(viewer, mesh, extrudeBrep(profile, { x: 0, y: 0, z: 1 }, height), "SdExtrude");
  return true;
}
