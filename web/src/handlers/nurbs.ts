import { registerHandler } from "../commands/dispatch";
import { Viewer } from "../viewer/viewer";
import * as THREE from "three";
import { buildBox } from "../tools/structural";
import { resolveCPlane } from "../viewer/cplane";
import { getActiveLevelId } from "../geometry/levels";
import { onElementCommitted } from "../tools/join-groups";
import { resolveLayerId, getActiveLevelElevation } from "./shared";
import { linkCanonicalBrep, linkCanonicalSurface } from "./canonical-surface";
import type { Curve, PolylineCurve } from "../nurbs/nurbs-curves";
import type { Surface } from "../nurbs/nurbs-surfaces";
import { surfaceOfRevolution } from "../nurbs/nurbs-surface-algorithms";
import type { Line, Plane } from "../nurbs/nurbs-primitives";
import { extrude as extrudeBrep } from "../nurbs/brep-extrude";

const TWO_PI = Math.PI * 2;

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

function linkAnalyticSurface(viewer: Viewer, mesh: THREE.Mesh, surface: Surface, createdBy: string): void {
  mesh.userData.nurbsSurface = surface;
  mesh.userData.nurbsKind = "surface";
  linkCanonicalSurface(viewer, mesh, createdBy);
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

export function registerNurbsHandlers(viewer: Viewer): void {
  registerHandler("SdBox", (args) => {
    const w = (args.width as number | undefined) ?? (args.size as number | undefined) ?? 1;
    const d = (args.depth as number | undefined) ?? (args.length as number | undefined) ?? 1;
    const h = (args.height as number | undefined) ?? 1;
    const cplane = resolveCPlane("SdBox", args as Record<string, unknown>, viewer);
    const c1 = { x: -w / 2, y: -d / 2 };
    const c2 = { x: w / 2, y: d / 2 };
    const c3 = { x: h, y: 0 };
    const { mesh, chain } = buildBox(c1, c2, c3);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), cplane.normal);
    mesh.position.z = getActiveLevelElevation();
    mesh.userData.cplaneKind = cplane.kind;
    mesh.userData.layerId = resolveLayerId("SdBox", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.creator = "box";
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    const profile = polylineProfile([
      [-w / 2, -d / 2],
      [w / 2, -d / 2],
      [w / 2, d / 2],
      [-w / 2, d / 2],
      [-w / 2, -d / 2],
    ]);
    linkCanonicalBrep(viewer, mesh, extrudeBrep(profile, { x: 0, y: 0, z: 1 }, h), "SdBox");
    viewer.addMesh(mesh, "brep");
    onElementCommitted(mesh as THREE.Mesh, viewer.getScene());
    return { created: "box", width: w, depth: d, height: h };
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
    linkAnalyticSurface(viewer, mesh, sphereSurface(r), "SdSphere");
    viewer.addMesh(mesh, "brep");
    return { created: "sphere", radius: r };
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
    linkAnalyticSurface(viewer, mesh, cylinderSurface(r, h), "SdCylinder");
    viewer.addMesh(mesh, "brep");
    return { created: "cylinder", radius: r, height: h };
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
    linkAnalyticSurface(viewer, mesh, coneSurface(r, h), "SdCone");
    viewer.addMesh(mesh, "brep");
    return { created: "cone", radius: r, height: h };
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
        srcObj.updateMatrixWorld(true);
        const posAttr = (srcObj as THREE.Line | THREE.Mesh).geometry?.attributes?.position;
        if (posAttr) {
          const tmp = new THREE.Vector3();
          const extracted: [number, number][] = [];
          for (let i = 0; i < posAttr.count; i++) {
            tmp.fromBufferAttribute(posAttr, i);
            tmp.applyMatrix4(srcObj.matrixWorld);
            extracted.push([tmp.x, tmp.y]);
          }
          if (extracted.length >= 3) resolvedProfile = extracted;
        }
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
    return { created: "extrude", profile_points: pts.length, distance };
  });
}
