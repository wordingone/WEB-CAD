import { registerHandler } from "../commands/dispatch";
import { Viewer } from "../viewer/viewer";
import * as THREE from "three";
import {
  buildWall, buildWallPitchedTop, buildSlab, buildColumn, buildBeam,
  buildRoof, buildSpace, buildFoundation, buildCeiling, buildCurtainWall,
  buildSkylight, buildStair, buildReferenceLine,
  type RoofParams, type CurtainWallParams, type StairParams,
  DEFAULT_WALL_HEIGHT, DEFAULT_SLAB_THICKNESS,
} from "../tools/structural";
import { buildRamp, buildRailing } from "../tools/sketch";
import { resolveCPlane } from "../viewer/cplane";
import { levelStore, getActiveLevelId } from "../geometry/levels";
import { onElementCommitted, cutSlabVoidFromBoxMesh } from "../tools/join-groups";
import { attemptWallCornerJoins } from "../tools/wall-corners";
import { pushCustomAction, beginTransaction, endTransaction } from "../history";
import { DEFAULT_CEILING_OFFSET } from "../tools/index";
import { STAIR_STEP_RISE, STAIR_STEP_DEPTH, STAIR_WIDTH } from "../tools/dimensions";
import { resolveLayerId, getActiveLevelElevation } from "./shared";
import { getState } from "../app-state";
import { linkCanonicalBrep } from "./canonical-surface";
import { linkPlanarizedMeshCommandBrep } from "./mesh-planar-brep";
import type { LineCurve, PolylineCurve } from "../nurbs/nurbs-curves";
import { extrude as extrudeBrep } from "../nurbs/brep-extrude";
import { transformBrep } from "../nurbs/nurbs-brep";

function rectangleProfile(minX: number, maxX: number, minY: number, maxY: number): PolylineCurve {
  return profileFrom2dPoints([
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ]);
}

function profileFrom2dPoints(points2d: Array<[number, number]>): PolylineCurve {
  const points = [
    ...points2d,
    ...(points2d.length > 0 && (points2d[0][0] !== points2d[points2d.length - 1][0] || points2d[0][1] !== points2d[points2d.length - 1][1])
      ? [points2d[0]]
      : []),
  ].map(([x, y]) => ({ x, y, z: 0 }));
  const parameters = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    parameters.push(parameters[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  return { kind: "polyline", points, parameters };
}

function profileFrom3dPoints(points3d: Array<[number, number, number]>): PolylineCurve {
  const points = [
    ...points3d,
    ...(points3d.length > 0 && (
      points3d[0][0] !== points3d[points3d.length - 1][0]
      || points3d[0][1] !== points3d[points3d.length - 1][1]
      || points3d[0][2] !== points3d[points3d.length - 1][2]
    ) ? [points3d[0]] : []),
  ].map(([x, y, z]) => ({ x, y, z }));
  const parameters = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    parameters.push(parameters[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  return { kind: "polyline", points, parameters };
}

function linkExtrudedRectangleBrep(
  viewer: Viewer,
  obj: THREE.Object3D,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  height: number,
  createdBy: string,
  zOffset = 0,
): void {
  const brep = extrudeBrep(rectangleProfile(minX, maxX, minY, maxY), { x: 0, y: 0, z: 1 }, height);
  const localBrep = zOffset === 0
    ? brep
    : transformBrep(brep, { m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, zOffset, 0, 0, 0, 1] });
  linkCanonicalBrep(viewer, obj, localBrep, createdBy);
}

function linkPitchedWallBrep(
  viewer: Viewer,
  obj: THREE.Object3D,
  length: number,
  thickness: number,
  eaveHeight: number,
  ridgeHeight: number,
): void {
  const halfLen = length / 2;
  const profile = profileFrom3dPoints([
    [-halfLen, -thickness / 2, 0],
    [halfLen, -thickness / 2, 0],
    [halfLen, -thickness / 2, eaveHeight],
    [0, -thickness / 2, eaveHeight + ridgeHeight],
    [-halfLen, -thickness / 2, eaveHeight],
    [-halfLen, -thickness / 2, 0],
  ]);
  linkCanonicalBrep(viewer, obj, extrudeBrep(profile, { x: 0, y: 1, z: 0 }, thickness), "SdWall");
}

function linkCompoundMeshBreps(
  viewer: Viewer,
  obj: THREE.Object3D,
  createdBy: string,
  metadata: Record<string, unknown>,
): void {
  obj.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    if (viewer.getCanonicalGeometryStore().resolveObjectOrAncestor(child)) return;
    linkPlanarizedMeshCommandBrep(viewer, child, createdBy, {
      ...metadata,
      ifcClass: child.userData.ifcClass,
      name: child.userData.name,
      parentId: child.userData.parentId,
    });
  });
}

export function registerStructuralHandlers(viewer: Viewer): void {
  registerHandler("SdWall", (args) => {
    const cplane = resolveCPlane("SdWall", args as Record<string, unknown>, viewer);
    const startArg = args.start as { x?: number; y?: number } | undefined;
    const endArg = args.end as { x?: number; y?: number } | undefined;
    const rawProfile = args.profile as [number, number][] | undefined;
    const wallLen = (args.length as number | undefined) ?? 4;
    let a: { x: number; y: number }, b: { x: number; y: number };
    if (rawProfile && rawProfile.length >= 2) {
      a = { x: rawProfile[0][0], y: rawProfile[0][1] };
      b = { x: rawProfile[rawProfile.length - 1][0], y: rawProfile[rawProfile.length - 1][1] };
    } else if (startArg && endArg) {
      a = { x: startArg.x ?? 0, y: startArg.y ?? 0 };
      b = { x: endArg.x ?? wallLen, y: endArg.y ?? 0 };
    } else {
      a = { x: 0, y: 0 };
      b = { x: wallLen, y: 0 };
    }
    // §#1555: reject degenerate walls below minimum span (corner-filler zero-length bug).
    const dxCheck = b.x - a.x, dyCheck = b.y - a.y;
    const wallLenCheck = Math.sqrt(dxCheck * dxCheck + dyCheck * dyCheck);
    if (wallLenCheck < 0.5) throw new Error(`degenerate-wall: p1=${JSON.stringify([a.x,a.y])} p2=${JSON.stringify([b.x,b.y])} dist=${wallLenCheck.toFixed(3)} — endpoints must differ by ≥0.5m; for attached structures offset the new footprint from the shared wall face`);
    const topProfile = (args.topProfile as string | undefined) ?? "level";
    const eaveH = (args.eaveHeight as number | undefined) ?? DEFAULT_WALL_HEIGHT;
    const ridgeH = (args.ridgeHeight as number | undefined) ?? 1.5;
    const explicitH = (args.height as number | undefined);
    // §#1569/#1558: clamp suspiciously-small explicit height to GARDEN_WALL_MIN_H (1.2m).
    const GARDEN_WALL_MIN_H = 1.2;
    const _clampedExplicitH = (explicitH !== undefined && explicitH < GARDEN_WALL_MIN_H)
      ? GARDEN_WALL_MIN_H : explicitH;
    const activeLvl = levelStore.getActive();
    const allLevels = levelStore.all().sort((x, y) => x.elevation - y.elevation);
    const nextLvl = allLevels.find(l => l.elevation > activeLvl.elevation + 0.01);
    const MIN_WALL_HEIGHT = 0.5;
    const baseH = _clampedExplicitH ?? DEFAULT_WALL_HEIGHT;
    const effectiveH = Math.max(
      MIN_WALL_HEIGHT,
      nextLvl
        ? Math.min(baseH, nextLvl.elevation - activeLvl.elevation - DEFAULT_SLAB_THICKNESS)
        : baseH,
    );
    const { mesh, chain } = topProfile === "pitched"
      ? buildWallPitchedTop(a, b, eaveH, ridgeH)
      : buildWall(a, b, effectiveH);
    mesh.position.z = getActiveLevelElevation();
    mesh.userData.cplaneKind = cplane.kind;
    mesh.userData.layerId = resolveLayerId("SdWall", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.creator = "wall";
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    if (topProfile === "pitched") {
      const t = (mesh.userData.wallThickness as number | undefined) ?? 0.2;
      linkPitchedWallBrep(viewer, mesh, wallLenCheck, t, eaveH, ridgeH);
    } else {
      const t = (mesh.userData.wallThickness as number | undefined) ?? 0.2;
      linkExtrudedRectangleBrep(viewer, mesh, -wallLenCheck / 2, wallLenCheck / 2, -t / 2, t / 2, effectiveH, "SdWall");
    }
    viewer.addMesh(mesh, "brep");
    if (topProfile !== "pitched") attemptWallCornerJoins(mesh, viewer.getScene());
    onElementCommitted(mesh, viewer.getScene());
    const dx = b.x - a.x, dy = b.y - a.y;
    return { created: "wall", length: Math.sqrt(dx * dx + dy * dy) || wallLen };
  });

  registerHandler("SdSlab", (args) => {
    const cplane = resolveCPlane("SdSlab", args as Record<string, unknown>, viewer);
    const w = (args.width as number | undefined) ?? (args.length as number | undefined) ?? 4;
    const d = (args.depth as number | undefined) ?? (args.width as number | undefined) ?? 4;
    const elev = (args.elevation as number | undefined) ?? getActiveLevelElevation();
    let a = { x: -w / 2, y: -d / 2 };
    let b = { x: w / 2, y: d / 2 };
    const slabProf = args.profile as number[][] | undefined;
    if (slabProf && slabProf.length >= 2) {
      const xs = slabProf.map((p) => p[0]);
      const ys = slabProf.map((p) => p[1]);
      a = { x: Math.min(...xs), y: Math.min(...ys) };
      b = { x: Math.max(...xs), y: Math.max(...ys) };
    }
    const t = (args.thickness as number | undefined) ?? DEFAULT_SLAB_THICKNESS;
    const { mesh, chain } = buildSlab(a, b, t);
    mesh.position.z = elev - t;
    mesh.userData.cplaneKind = cplane.kind;
    mesh.userData.layerId = resolveLayerId("SdSlab", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    linkExtrudedRectangleBrep(viewer, mesh, -Math.abs(b.x - a.x) / 2, Math.abs(b.x - a.x) / 2, -Math.abs(b.y - a.y) / 2, Math.abs(b.y - a.y) / 2, t, "SdSlab");
    viewer.addMesh(mesh, "brep");
    onElementCommitted(mesh, viewer.getScene());
    return { created: "slab", width: w, depth: d };
  });

  registerHandler("SdColumn", (args) => {
    const cplane = resolveCPlane("SdColumn", args as Record<string, unknown>, viewer);
    const posArr = args.position as [number, number] | undefined;
    const p = { x: posArr?.[0] ?? 0, y: posArr?.[1] ?? 0 };
    const { mesh, chain } = buildColumn(p);
    mesh.position.z = getActiveLevelElevation();
    mesh.userData.cplaneKind = cplane.kind;
    mesh.userData.layerId = resolveLayerId("SdColumn", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    linkExtrudedRectangleBrep(viewer, mesh, -0.15, 0.15, -0.15, 0.15, 4, "SdColumn");
    viewer.addMesh(mesh, "brep");
    onElementCommitted(mesh, viewer.getScene());
    return { created: "column" };
  });

  registerHandler("SdBeam", (args) => {
    const s = args.start as number[] | undefined;
    const e = args.end as number[] | undefined;
    const a = { x: s?.[0] ?? 0, y: s?.[1] ?? 0 };
    const b = { x: e?.[0] ?? 4, y: e?.[1] ?? 0 };
    const dx = b.x - a.x, dy = b.y - a.y;
    const { mesh, chain } = buildBeam(a, b);
    mesh.position.z += getActiveLevelElevation();
    mesh.userData.layerId = resolveLayerId("SdBeam", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    const beamLen = Math.sqrt(dx * dx + dy * dy) || 4;
    linkExtrudedRectangleBrep(viewer, mesh, -beamLen / 2, beamLen / 2, -0.1, 0.1, 0.2, "SdBeam", -0.1);
    viewer.addMesh(mesh, "brep");
    onElementCommitted(mesh, viewer.getScene());
    return { created: "beam", length: beamLen };
  });

  registerHandler("SdMember", (args) => {
    const length   = (args.length as number | undefined) ?? 3;
    const axisRaw  = args.axis_curve as [number, number, number] | undefined;
    const axis     = axisRaw ?? [0, 0, 1];
    const rawProfile = args.profile as [number, number][] | undefined;
    const pts: [number, number][] = Array.isArray(rawProfile) && rawProfile.length >= 3
      ? (rawProfile as [number, number][])
      : [[-0.05, -0.05], [0.05, -0.05], [0.05, 0.05], [-0.05, 0.05]];
    const shape = new THREE.Shape();
    shape.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
    shape.closePath();
    const geom = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false });
    const mat = new THREE.MeshStandardMaterial({ color: 0x7a8fa6, roughness: 0.5, metalness: 0.2 });
    const mesh = new THREE.Mesh(geom, mat);
    const up = new THREE.Vector3(0, 0, 1);
    const dir = new THREE.Vector3(axis[0], axis[1], axis[2]).normalize();
    if (Math.abs(dir.dot(up)) < 0.9999) mesh.quaternion.setFromUnitVectors(up, dir);
    mesh.userData.kind = "brep";
    mesh.userData.creator = "member";
    mesh.userData.layerId = resolveLayerId("SdMember", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    linkCanonicalBrep(viewer, mesh, extrudeBrep(profileFrom2dPoints(pts), { x: 0, y: 0, z: 1 }, length), "SdMember");
    viewer.addMesh(mesh, "brep");
    return { created: "member", length, profile_points: pts.length };
  });

  registerHandler("SdStair", (args) => {
    const toXY = (v: unknown, dx: number, dy: number): { x: number; y: number } => {
      if (Array.isArray(v)) return { x: (v[0] as number) ?? dx, y: (v[1] as number) ?? dy };
      if (v && typeof v === "object") {
        const obj = v as Record<string, unknown>;
        return { x: (obj.x as number) ?? dx, y: (obj.y as number) ?? dy };
      }
      return { x: dx, y: dy };
    };
    let a = toXY(args.start, 0, 0);
    let b = toXY(args.end,   4, 0);
    const stairBbox = new THREE.Box3();
    let hasBounds = false;
    viewer.forEachSceneChild((child) => {
      const c = child.userData?.creator;
      if (c === "SdWall" || c === "wall" || c === "SdSlab" || c === "slab") {
        stairBbox.expandByObject(child);
        hasBounds = true;
      }
    });
    if (hasBounds && !stairBbox.isEmpty()) {
      const inBbox = (p: { x: number; y: number }) =>
        p.x >= stairBbox.min.x && p.x <= stairBbox.max.x &&
        p.y >= stairBbox.min.y && p.y <= stairBbox.max.y;
      if (!inBbox(a) && !inBbox(b)) {
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const bx = (stairBbox.min.x + stairBbox.max.x) / 2;
        const by = (stairBbox.min.y + stairBbox.max.y) / 2;
        a = { x: a.x + (bx - mx), y: a.y + (by - my) };
        b = { x: b.x + (bx - mx), y: b.y + (by - my) };
      }
    }
    const explicitCount = typeof args.count === "number" ? Math.max(1, Math.round(args.count)) : null;
    const explicitRiser = typeof args.riser === "number" ? args.riser : null;
    const explicitTread = typeof args.tread === "number" ? args.tread : null;
    const FT_TO_M = 0.3048;
    const isImperial = getState("unitSystem") === "imperial";
    const stairParams: StairParams = {
      type:        (args.type as StairParams["type"] | undefined) ?? "straight",
      width:       isImperial ? STAIR_WIDTH / FT_TO_M : STAIR_WIDTH,
      treadDepth:  explicitTread  ?? (isImperial ? STAIR_STEP_DEPTH / FT_TO_M : STAIR_STEP_DEPTH),
      riserHeight: explicitRiser  ?? (isImperial ? STAIR_STEP_RISE / FT_TO_M : STAIR_STEP_RISE),
      ...(explicitCount != null ? { count: explicitCount } : {}),
    };
    const { group, chain, footprint } = buildStair(a, b, stairParams);
    const elev = getActiveLevelElevation();
    group.position.z = elev;
    group.userData.layerId = resolveLayerId("SdStair", args);
    group.userData.levelId = getActiveLevelId();
    group.userData.dispatchArgs = args;
    group.userData.chain = chain;
    linkCompoundMeshBreps(viewer, group, "SdStairComponent", {
      parentCreator: "stair",
      stairId: group.userData.stairId,
      stairParams: group.userData.stairParams,
      levelId: group.userData.levelId,
    });
    viewer.addMesh(group, "brep");

    const targetH = levelStore.get(getActiveLevelId())?.height ?? (isImperial ? 9.0 : 3.0);
    const voidElev = elev + targetH;
    const clearance = 0.1;
    let closestSlab: THREE.Object3D | null = null;
    let closestDist = Infinity;
    viewer.forEachSceneChild((child) => {
      if (child.userData?.creator !== "slab") return;
      const dist = Math.abs(child.position.z - voidElev);
      if (dist < closestDist) { closestDist = dist; closestSlab = child; }
    });
    if (closestSlab && closestDist < 2.0) {
      cutSlabVoidFromBoxMesh(
        closestSlab as THREE.Mesh,
        footprint.minX - clearance, footprint.minY - clearance,
        footprint.maxX + clearance, footprint.maxY + clearance,
      );
      (closestSlab as THREE.Object3D).userData.ceilingHole = true;
    }

    return { created: "stair", type: stairParams.type };
  });

  registerHandler("SdRoof", (args) => {
    const rawType = (args.roofType as string | undefined) ?? "pitched";
    const typeMap: Record<string, RoofParams["type"]> = {
      pitched: "pitched", gable: "pitched", hip: "hip", hipped: "hip",
      shed: "shed", mono: "shed", "mono-pitch": "shed",
      flat: "flat", mansard: "flat", combination: "flat",
    };
    const roofType: RoofParams["type"] = typeMap[rawType] ?? "pitched";
    const pitchDeg = (args.pitchDeg as number | undefined) ?? (args.pitchAngleDeg as number | undefined) ?? 30;
    const overhang = (args.overhang as number | undefined) ?? 0.5;
    const thickness = (args.thickness as number | undefined) ?? 0.15;

    const fp = args.footprint as number[][] | undefined;
    let w = 8, d = 10;
    let centerX = 0, centerY = 0;
    if (fp && fp.length >= 2) {
      const xs = fp.map((p) => p[0]);
      const ys = fp.map((p) => p[1]);
      w = (Math.max(...xs) - Math.min(...xs)) || 8;
      d = (Math.max(...ys) - Math.min(...ys)) || 10;
      centerX = (Math.max(...xs) + Math.min(...xs)) / 2;
      centerY = (Math.max(...ys) + Math.min(...ys)) / 2;
    } else {
      // Footprint absent — infer bounding box from scene walls at the active level (#1756).
      const inferElev = getActiveLevelElevation();
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let hasWalls = false;
      viewer.getScene().traverse((child) => {
        if (child.userData?.creator !== "wall") return;
        const _wp = new THREE.Vector3();
        child.getWorldPosition(_wp);
        if (Math.abs(_wp.z - inferElev) > 0.5) return;
        const _eps = child.userData.endpoints as Array<{ x: number; y: number }> | undefined;
        if (!_eps || _eps.length < 2) return;
        for (const _ep of _eps) {
          if (_ep.x < minX) minX = _ep.x;
          if (_ep.x > maxX) maxX = _ep.x;
          if (_ep.y < minY) minY = _ep.y;
          if (_ep.y > maxY) maxY = _ep.y;
        }
        hasWalls = true;
      });
      if (hasWalls && minX !== Infinity) {
        w = (maxX - minX) || 8;
        d = (maxY - minY) || 10;
        centerX = (maxX + minX) / 2;
        centerY = (maxY + minY) / 2;
      }
    }
    const a = { x: -w / 2, y: -d / 2 };
    const b = { x: w / 2, y: d / 2 };
    const roofParams: RoofParams = { type: roofType, pitchDeg, overhang, thickness, showStructure: true };
    const { mesh, chain } = buildRoof(a, b, roofParams);

    const activeLevelElev = getActiveLevelElevation();
    let eaveOffset = DEFAULT_WALL_HEIGHT;
    {
      const FOOT_EXPAND = 1.5;
      viewer.getScene().traverse((child) => {
        if (child.userData?.creator !== "wall") return;
        const wp = new THREE.Vector3();
        child.getWorldPosition(wp);
        if (Math.abs(wp.z - activeLevelElev) > 0.5) return;
        const eps = child.userData.endpoints as Array<{ x: number; y: number }> | undefined;
        if (!eps || eps.length < 2) return;
        const midX = (eps[0].x + eps[1].x) / 2;
        const midY = (eps[0].y + eps[1].y) / 2;
        if (midX < centerX - w / 2 - FOOT_EXPAND || midX > centerX + w / 2 + FOOT_EXPAND) return;
        if (midY < centerY - d / 2 - FOOT_EXPAND || midY > centerY + d / 2 + FOOT_EXPAND) return;
        const wh = (child.userData.wallHeight as number | undefined) ?? DEFAULT_WALL_HEIGHT;
        if (wh > eaveOffset) eaveOffset = wh;
      });
    }
    mesh.position.set(centerX, centerY, activeLevelElev + eaveOffset);
    mesh.userData.roofType = roofType;
    mesh.userData.ifcPredefinedType = ({
      pitched: "GABLE_ROOF",
      hip: "HIP_ROOF",
      shed: "SHED_ROOF",
      flat: "FLAT_ROOF",
    } as Record<string, string>)[roofType ?? "pitched"] ?? "NOTDEFINED";
    mesh.userData.layerId = resolveLayerId("SdRoof", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    linkCompoundMeshBreps(viewer, mesh, "SdRoofComponent", {
      parentCreator: "roof",
      roofType,
      roofParams: mesh.userData.roofParams,
      levelId: mesh.userData.levelId,
      ifcPredefinedType: mesh.userData.ifcPredefinedType,
    });

    beginTransaction("SdRoof+gable-trim");
    viewer.addMesh(mesh, "brep");
    if (mesh instanceof THREE.Mesh) onElementCommitted(mesh, viewer.getScene());

    if (roofType === "pitched") {
      const pitchRad2 = (pitchDeg * Math.PI) / 180;
      const landscape = w >= d;
      const spanHalf = (landscape ? d : w) / 2 + overhang;
      const rH = spanHalf * Math.tan(pitchRad2);
      const TOL = 0.8;

      const _gableWallCandidates: THREE.Mesh[] = [];
      viewer.getScene().traverse((child) => {
        if (child.userData?.creator !== "wall") return;
        if (child.userData?.topProfile === "pitched") return;
        const worldPos = new THREE.Vector3();
        child.getWorldPosition(worldPos);
        if (Math.abs(worldPos.z - activeLevelElev) > 0.5) return;
        if (child instanceof THREE.Mesh) {
          _gableWallCandidates.push(child);
        } else if (child instanceof THREE.Group) {
          const dims = (child.userData as Record<string, unknown>).originalWallDims as { w: number; d: number; h: number } | undefined;
          if (!dims) return;
          let _srcMat: THREE.Material | undefined;
          child.traverse((c) => {
            if (!_srcMat && (c as THREE.Mesh).isMesh) {
              const m = (c as THREE.Mesh).material;
              _srcMat = (Array.isArray(m) ? m[0] : m) as THREE.Material;
            }
          });
          const _rGeom = new THREE.BoxGeometry(dims.w, dims.d, dims.h);
          _rGeom.translate(0, 0, dims.h / 2);
          const _rMesh = new THREE.Mesh(_rGeom, _srcMat ?? new THREE.MeshStandardMaterial({ color: 0x9ec5d8 }));
          _rMesh.position.copy(child.position);
          _rMesh.rotation.copy(child.rotation);
          _rMesh.scale.copy(child.scale);
          _rMesh.userData = { ...child.userData };
          delete (_rMesh.userData as Record<string, unknown>).originalWallDims;
          _gableWallCandidates.push(_rMesh);
          (_rMesh as unknown as { _replaceGroup: THREE.Group })._replaceGroup = child;
        }
      });

      for (const _c of _gableWallCandidates) {
        const _grp = (_c as unknown as { _replaceGroup?: THREE.Group })._replaceGroup;
        if (_grp) {
          const _parent = _grp.parent ?? viewer.getScene();
          _parent.remove(_grp);
          _parent.add(_c);
          _c.updateMatrixWorld(true);
        }
      }

      // §#1724: derive gable-end coordinates from scene wall bounding box.
      // §#1756: apply footprint+FOOT_EXPAND filter.
      const FOOT_EXPAND_GABLE = 1.5;
      let sceneGMin = Infinity, sceneGMax = -Infinity;
      for (const cand of _gableWallCandidates) {
        const ep = cand.userData.endpoints as Array<{ x: number; y: number }> | undefined;
        if (!ep || ep.length < 2) continue;
        const midX = (ep[0].x + ep[1].x) / 2;
        const midY = (ep[0].y + ep[1].y) / 2;
        if (midX < centerX - w / 2 - FOOT_EXPAND_GABLE || midX > centerX + w / 2 + FOOT_EXPAND_GABLE) continue;
        if (midY < centerY - d / 2 - FOOT_EXPAND_GABLE || midY > centerY + d / 2 + FOOT_EXPAND_GABLE) continue;
        const v0 = landscape ? ep[0].x : ep[0].y;
        const v1 = landscape ? ep[1].x : ep[1].y;
        if (v0 < sceneGMin) sceneGMin = v0;
        if (v0 > sceneGMax) sceneGMax = v0;
        if (v1 < sceneGMin) sceneGMin = v1;
        if (v1 > sceneGMax) sceneGMax = v1;
      }

      for (const child of _gableWallCandidates) {
        const eps = child.userData.endpoints as Array<{ x: number; y: number }> | undefined;
        if (!eps || eps.length < 2) continue;
        const wx0 = eps[0].x, wy0 = eps[0].y;
        const wx1 = eps[1].x, wy1 = eps[1].y;

        const vA = landscape ? wx0 : wy0;
        const vB = landscape ? wx1 : wy1;
        const isGable = Math.abs(vA - vB) < TOL &&
          (Math.abs(vA - sceneGMin) < TOL || Math.abs(vA - sceneGMax) < TOL);
        if (!isGable) continue;

        const wallMesh = child;
        const wallEaveH = eaveOffset;
        const cps = wallMesh.userData.controlPoints as THREE.Vector3[] | undefined;
        const len = cps && cps.length >= 2 ? cps[0].distanceTo(cps[1]) : (() => {
          const ddx = wx1 - wx0, ddy = wy1 - wy0;
          return Math.sqrt(ddx * ddx + ddy * ddy);
        })();
        const wt = (wallMesh.userData.wallThickness as number | undefined) ?? 0.2;

        const shape = new THREE.Shape();
        shape.moveTo(-len / 2, 0);
        shape.lineTo( len / 2, 0);
        shape.lineTo( len / 2, wallEaveH);
        shape.lineTo( 0,       wallEaveH + rH);
        shape.lineTo(-len / 2, wallEaveH);
        shape.closePath();
        const pitchedGeom = new THREE.ExtrudeGeometry(shape, { depth: wt, bevelEnabled: false });
        pitchedGeom.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
        pitchedGeom.translate(0, wt / 2, 0);

        const oldGeom = wallMesh.geometry;
        wallMesh.geometry = pitchedGeom;
        wallMesh.userData.topProfile = "pitched";
        wallMesh.userData.eaveHeight = wallEaveH;
        wallMesh.userData.ridgeHeight = rH;

        pushCustomAction(
          () => {
            wallMesh.geometry = oldGeom;
            delete (wallMesh.userData as Record<string, unknown>).topProfile;
            delete (wallMesh.userData as Record<string, unknown>).eaveHeight;
            delete (wallMesh.userData as Record<string, unknown>).ridgeHeight;
          },
          () => {
            wallMesh.geometry = pitchedGeom;
            wallMesh.userData.topProfile = "pitched";
            wallMesh.userData.eaveHeight = wallEaveH;
            wallMesh.userData.ridgeHeight = rH;
          },
        );
      }
    }

    endTransaction();
    return { created: "roof", roofType, width: w, depth: d, ifcPredefinedType: mesh.userData.ifcPredefinedType };
  });

  registerHandler("SdSpace", (args) => {
    const fp = args.footprint as number[][] | undefined;
    let w = 5, d = 4;
    let centerX = 0, centerY = 0;
    if (fp && fp.length >= 2) {
      const xs = fp.map((p) => p[0]);
      const ys = fp.map((p) => p[1]);
      w = (Math.max(...xs) - Math.min(...xs)) || 5;
      d = (Math.max(...ys) - Math.min(...ys)) || 4;
      centerX = (Math.max(...xs) + Math.min(...xs)) / 2;
      centerY = (Math.max(...ys) + Math.min(...ys)) / 2;
    }
    const a = { x: -w / 2, y: -d / 2 };
    const b = { x: w / 2, y: d / 2 };
    const { mesh, chain } = buildSpace(a, b);
    mesh.position.x = centerX;
    mesh.position.y = centerY;
    mesh.position.z = getActiveLevelElevation();
    mesh.userData.layerId = resolveLayerId("SdSpace", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    linkExtrudedRectangleBrep(viewer, mesh, -Math.abs(b.x - a.x) / 2, Math.abs(b.x - a.x) / 2, -Math.abs(b.y - a.y) / 2, Math.abs(b.y - a.y) / 2, 2.8, "SdSpace");
    if (args.name) mesh.userData.spaceName = args.name as string;
    viewer.addMesh(mesh, "brep");
    onElementCommitted(mesh, viewer.getScene());
    return { created: "space", width: w, depth: d };
  });

  registerHandler("SdFoundation", (args) => {
    const w = (args.width as number | undefined) ?? 6;
    const d = (args.depth as number | undefined) ?? 6;
    const pos = args.position as number[] | undefined;
    const a = { x: -w / 2, y: -d / 2 };
    const b = { x: w / 2, y: d / 2 };
    const { mesh, chain } = buildFoundation(a, b);
    mesh.position.x = pos?.[0] ?? 0;
    mesh.position.y = pos?.[1] ?? 0;
    mesh.position.z = getActiveLevelElevation();
    mesh.userData.layerId = resolveLayerId("SdFoundation", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    linkExtrudedRectangleBrep(viewer, mesh, -Math.abs(b.x - a.x) / 2, Math.abs(b.x - a.x) / 2, -Math.abs(b.y - a.y) / 2, Math.abs(b.y - a.y) / 2, 0.5, "SdFoundation", -0.5);
    viewer.addMesh(mesh, "brep");
    onElementCommitted(mesh, viewer.getScene());
    return { created: "foundation", width: w, depth: d };
  });

  registerHandler("SdCeiling", (args) => {
    const w = (args.width as number | undefined) ?? 5;
    const d = (args.depth as number | undefined) ?? 4;
    const pos = args.position as number[] | undefined;
    let a = { x: -w / 2, y: -d / 2 };
    let b = { x: w / 2, y: d / 2 };
    const ceilProf = args.profile as number[][] | undefined;
    if (ceilProf && ceilProf.length >= 2) {
      const xs = ceilProf.map((p) => p[0]);
      const ys = ceilProf.map((p) => p[1]);
      a = { x: Math.min(...xs), y: Math.min(...ys) };
      b = { x: Math.max(...xs), y: Math.max(...ys) };
    }
    const { mesh, chain } = buildCeiling(a, b);
    mesh.position.x = pos?.[0] ?? 0;
    mesh.position.y = pos?.[1] ?? 0;
    mesh.position.z = getActiveLevelElevation() + DEFAULT_CEILING_OFFSET;
    mesh.userData.layerId = resolveLayerId("SdCeiling", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    linkExtrudedRectangleBrep(viewer, mesh, -Math.abs(b.x - a.x) / 2, Math.abs(b.x - a.x) / 2, -Math.abs(b.y - a.y) / 2, Math.abs(b.y - a.y) / 2, 0.05, "SdCeiling", -0.025);
    viewer.addMesh(mesh, "brep");
    onElementCommitted(mesh, viewer.getScene());
    return { created: "ceiling", width: w, depth: d };
  });

  registerHandler("SdCurtainWall", (args) => {
    const wallLen = (args.length as number | undefined) ?? 6;
    const startArg = args.start as number[] | undefined;
    const endArg = args.end as number[] | undefined;
    let a: { x: number; y: number }, b: { x: number; y: number };
    if (startArg && endArg) {
      a = { x: startArg[0] ?? 0, y: startArg[1] ?? 0 };
      b = { x: endArg[0] ?? wallLen, y: endArg[1] ?? 0 };
    } else {
      a = { x: 0, y: 0 };
      b = { x: wallLen, y: 0 };
    }
    const cwParams: CurtainWallParams = {
      mullionSpacing:  (args.mullionSpacing  as number | undefined) ?? undefined,
      transomSpacing:  (args.transomSpacing  as number | undefined) ?? undefined,
    };
    const { mesh, chain } = buildCurtainWall(a, b, cwParams);
    mesh.position.z = getActiveLevelElevation();
    mesh.userData.layerId = resolveLayerId("SdCurtainWall", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    const cwLen = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2) || wallLen;
    const _joinShell = mesh.userData.joinableShell as THREE.Mesh | undefined;
    if (_joinShell instanceof THREE.Mesh) {
      _joinShell.position.z = mesh.position.z;
      _joinShell.userData.levelId = getActiveLevelId();
      _joinShell.userData.layerId = resolveLayerId("SdCurtainWall", args);
    }
    linkExtrudedRectangleBrep(viewer, mesh, -cwLen / 2, cwLen / 2, -0.05, 0.05, DEFAULT_WALL_HEIGHT, "SdCurtainWall");
    const canonical = viewer.getCanonicalGeometryStore().resolveObjectOrAncestor(mesh);
    if (canonical && _joinShell instanceof THREE.Mesh) {
      viewer.getCanonicalGeometryStore().linkObject(_joinShell, canonical.id);
    }
    viewer.addMesh(mesh, "brep");
    if (_joinShell instanceof THREE.Mesh) {
      viewer.addMesh(_joinShell, "brep");
      onElementCommitted(_joinShell, viewer.getScene());
    }
    return { created: "curtainwall", length: wallLen };
  });

  registerHandler("SdPlate", (args) => {
    const thickness = (args.thickness as number | undefined) ?? 0.05;
    const normRaw   = args.orientation as [number, number, number] | undefined;
    const norm      = normRaw ?? [0, 1, 0];
    const rawProfile = args.profile as [number, number][] | undefined;
    const pts: [number, number][] = Array.isArray(rawProfile) && rawProfile.length >= 3
      ? (rawProfile as [number, number][])
      : [[0, 0], [1, 0], [1, 1], [0, 1]];
    const shape = new THREE.Shape();
    shape.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
    shape.closePath();
    const geom = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
    const mat  = new THREE.MeshStandardMaterial({ color: 0xc8d8e8, roughness: 0.4, metalness: 0.1 });
    const mesh = new THREE.Mesh(geom, mat);
    const up  = new THREE.Vector3(0, 0, 1);
    const dir = new THREE.Vector3(norm[0], norm[1], norm[2]).normalize();
    if (Math.abs(dir.dot(up)) < 0.9999) mesh.quaternion.setFromUnitVectors(up, dir);
    mesh.userData.kind = "brep";
    mesh.userData.creator = "plate";
    mesh.userData.layerId = resolveLayerId("SdPlate", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    linkCanonicalBrep(viewer, mesh, extrudeBrep(profileFrom2dPoints(pts), { x: 0, y: 0, z: 1 }, thickness), "SdPlate");
    viewer.addMesh(mesh, "brep");
    return { created: "plate", thickness, profile_points: pts.length };
  });

  registerHandler("SdSkylight", (args) => {
    const w = (args.width as number | undefined) ?? 1.2;
    const d = (args.depth as number | undefined) ?? 1.2;
    const pos = args.position as number[] | undefined;
    const a = { x: -w / 2, y: -d / 2 };
    const b = { x: w / 2, y: d / 2 };
    const { mesh, chain } = buildSkylight(a, b);
    mesh.position.x = pos?.[0] ?? 0;
    mesh.position.y = pos?.[1] ?? 0;
    mesh.position.z = getActiveLevelElevation() + DEFAULT_CEILING_OFFSET;
    mesh.userData.layerId = resolveLayerId("SdSkylight", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    linkExtrudedRectangleBrep(viewer, mesh, -w / 2, w / 2, -d / 2, d / 2, 0.04, "SdSkylight", -0.02);
    viewer.addMesh(mesh, "brep");
    onElementCommitted(mesh, viewer.getScene());
    return { created: "skylight", width: w, depth: d };
  });

  registerHandler("SdRamp", (args) => {
    const s = (args.start as number[] | undefined) ?? [0, 0];
    const e = (args.end   as number[] | undefined) ?? [4, 0];
    const a = { x: s[0] ?? 0, y: s[1] ?? 0 };
    const b = { x: e[0] ?? 4, y: e[1] ?? 0 };
    const dx = b.x - a.x, dy = b.y - a.y;
    const { mesh, chain } = buildRamp(a, b);
    mesh.position.z = getActiveLevelElevation();
    mesh.userData.layerId = resolveLayerId("SdRamp", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    const rampRun = Math.sqrt(dx * dx + dy * dy) || 1;
    linkExtrudedRectangleBrep(viewer, mesh, -rampRun / 2, rampRun / 2, -0.6, 0.6, 0.15, "SdRamp", rampRun / 24 - 0.075);
    viewer.addMesh(mesh, "brep");
    onElementCommitted(mesh, viewer.getScene());
    return { created: "ramp", run: rampRun };
  });

  registerHandler("SdRailing", (args) => {
    const s = (args.start as number[] | undefined) ?? [0, 0];
    const e = (args.end   as number[] | undefined) ?? [3, 0];
    const a = { x: s[0] ?? 0, y: s[1] ?? 0 };
    const b = { x: e[0] ?? 3, y: e[1] ?? 0 };
    const dx = b.x - a.x, dy = b.y - a.y;
    const { mesh, chain } = buildRailing(a, b);
    mesh.position.z = getActiveLevelElevation();
    mesh.userData.layerId = resolveLayerId("SdRailing", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    const railingLen = Math.sqrt(dx * dx + dy * dy) || 1;
    linkExtrudedRectangleBrep(viewer, mesh, -railingLen / 2, railingLen / 2, -0.025, 0.025, 1, "SdRailing");
    viewer.addMesh(mesh, "brep");
    onElementCommitted(mesh, viewer.getScene());
    return { created: "railing", length: railingLen };
  });

  registerHandler("SdReferenceLine", (args) => {
    const origin = (args.origin as number[] | undefined) ?? [0, 0];
    const end    = (args.end    as number[] | undefined) ?? [5, 0];
    const a = { x: origin[0] ?? 0, y: origin[1] ?? 0 };
    const b = { x: end[0]    ?? 5, y: end[1]    ?? 0 };
    const { mesh, chain } = buildReferenceLine(a, b);
    mesh.userData.layerId = resolveLayerId("SdReferenceLine", args);
    mesh.userData.levelId = getActiveLevelId();
    mesh.userData.dispatchArgs = args;
    mesh.userData.chain = chain;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const curve: LineCurve = {
      kind: "line",
      from: { x: 0, y: -len / 2, z: 0 },
      to: { x: 0, y: len / 2, z: 0 },
      domain: { min: 0, max: len },
    };
    const canonical = viewer.getCanonicalGeometryStore().create({
      kind: "curve",
      curve,
      source: "command",
      createdBy: "SdReferenceLine",
      displayMesh: {
        revision: 1,
        generatedAt: Date.now(),
        vertexCount: 2,
        derivation: "tessellated-curve",
      },
      metadata: {
        worldStart: [a.x, a.y, 0],
        worldEnd: [b.x, b.y, 0],
      },
    });
    viewer.getCanonicalGeometryStore().linkObject(mesh, canonical.id);
    viewer.addMesh(mesh, "brep");
    return { created: "reference-line", origin: [a.x, a.y], end: [b.x, b.y] };
  });
}
