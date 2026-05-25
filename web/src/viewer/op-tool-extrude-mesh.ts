// op-tool-extrude-mesh.ts — pure geometry builders for the extrude op-tool phase.
// No dependency on op-tool.ts module state — safe to import from either side.

import * as THREE from "three";
import type { Viewer } from "./viewer";
import { makeSnapId, closestPtOnSegToRay } from "./snap-state";
import { projectToScreen } from "./projection";
import { createCatmullRomAsNurbs, tessellate } from "../nurbs/nurbs-curves.js";

// Creators that are valid extrude profiles (click-select in extrude_select phase).
export const EXTRUDABLE_CREATORS = new Set([
  "rect", "circle", "polygon", "arc", "polyline", "curve", "line",
  "wall", "slab", "column", "box", "beam", "roof", "space",
  "extrude", "boolean-union", "boolean-difference", "boolean-split",
]);

// 2D sketch creators for auto-selection at tool-activation time.
// Narrower than EXTRUDABLE_CREATORS — avoids auto-selecting large 3D solids
// (slabs, roofs, walls) as profiles when the user activates extrude.
export const SKETCH_PROFILE_CREATORS = new Set([
  "rect", "circle", "polygon", "arc", "polyline", "curve", "line",
]);

// Closed 2D sketch creators that can be auto-extruded before boolean.
export const CLOSED_SKETCH_CREATORS = new Set(["circle", "rect", "polygon"]);

// Creators valid for click-selection as extrude profile.
// Excludes raw 3D primitives (wall, slab, column, box, beam, roof, space)
// to prevent accidentally extruding large structural elements as a profile.
// Includes previous extrude/boolean/CSG results so re-extrusion and surface
// selection work (e.g. extruding a boolean result or a CSG brep surface).
export const CLICK_PROFILE_CREATORS = new Set([
  "rect", "circle", "polygon", "arc", "polyline", "curve", "line",
  "extrude", "boolean-union", "boolean-difference", "boolean-split", "brep",
]);

// ── Snap helpers ──────────────────────────────────────────────────────────────

// Build snap endpoints from a flat list of world-space XY points at z=0 and z=h.
// Stored in mesh.userData.endpoints so section-1a vertex snap finds them.
export function snapEndpointsFromProfile(pts: Array<{x: number; y: number}>, h: number) {
  const eps = [];
  for (const p of pts) {
    eps.push({ id: makeSnapId(p.x, p.y, 0), x: p.x, y: p.y, z: 0 });
    eps.push({ id: makeSnapId(p.x, p.y, h), x: p.x, y: p.y, z: h });
  }
  return eps;
}

// Build explicit edge pairs for section-1d snap, avoiding the spurious diagonal
// segments that arise when section-1d iterates the interleaved [z=0,z=h] endpoint array.
// Encodes vertical edges (z=0↔z=h at each profile point) and horizontal ring edges
// (adjacent profile points at z=0 and at z=h).
type EdgePtPair = [{ x: number; y: number; z: number }, { x: number; y: number; z: number }];
export function snapEdgePairsFromProfile(pts: Array<{x: number; y: number}>, h: number): EdgePtPair[] {
  const pairs: EdgePtPair[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    // Vertical edge
    pairs.push([{ x: p.x, y: p.y, z: 0 }, { x: p.x, y: p.y, z: h }]);
    // Horizontal ring edges at z=0 and z=h (adjacent profile points)
    if (i < pts.length - 1) {
      const q = pts[i + 1];
      pairs.push([{ x: p.x, y: p.y, z: 0 }, { x: q.x, y: q.y, z: 0 }]);
      pairs.push([{ x: p.x, y: p.y, z: h }, { x: q.x, y: q.y, z: h }]);
    }
  }
  return pairs;
}

// ── Extrude mesh builder ──────────────────────────────────────────────────────

export function opBuildExtrudeMesh(profile: THREE.Object3D, h: number): THREE.Mesh {
  const creator = profile.userData.creator as string | undefined;
  const box = new THREE.Box3().setFromObject(profile);
  const size = new THREE.Vector3(); box.getSize(size);
  const ctr = new THREE.Vector3(); box.getCenter(ctr);

  if (creator === "circle") {
    const r = Math.max(0.05, size.x / 2);
    const geom = new THREE.CylinderGeometry(r, r, h, 64);
    geom.rotateX(Math.PI / 2);
    geom.translate(0, 0, h / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xb6d59a, roughness: 0.55, metalness: 0.05 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(ctr.x, ctr.y, 0);
    mesh.userData._snapCreationPos = { x: ctr.x, y: ctr.y, z: 0 };
    // Cardinal snap points on top + bottom circles (N/S/E/W + center)
    const cx = ctr.x, cy = ctr.y;
    const circlePts = [
      { x: cx, y: cy },
      { x: cx + r, y: cy }, { x: cx - r, y: cy },
      { x: cx, y: cy + r }, { x: cx, y: cy - r },
    ];
    mesh.userData.footprintCircle = { cx, cy, r };
    mesh.userData.endpoints = snapEndpointsFromProfile(circlePts, h);
    mesh.userData.edgePairs = snapEdgePairsFromProfile(circlePts, h);
    return mesh;
  }

  if (creator === "arc") {
    profile.updateMatrixWorld();
    const worldCenter = new THREE.Vector3(0, 0, 0).applyMatrix4(profile.matrixWorld);
    const arcR = (profile.userData.radius as number | undefined) ?? 1;
    const sa = (profile.userData.startAngle as number | undefined) ?? 0;
    const ea = (profile.userData.endAngle as number | undefined) ?? Math.PI / 2;
    const segs = 64;
    const span = ea - sa;
    const worldPts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= segs; i++) {
      const a = sa + (i / segs) * span;
      worldPts.push({ x: worldCenter.x + arcR * Math.cos(a), y: worldCenter.y + arcR * Math.sin(a) });
    }
    // Open arc → ribbon surface
    const verts: number[] = [];
    const idxs: number[] = [];
    worldPts.forEach((p, i) => {
      verts.push(p.x, p.y, 0, p.x, p.y, h);
      if (i < worldPts.length - 1) {
        const b = i * 2;
        idxs.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geom.setIndex(idxs);
    geom.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x5585cc, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData.endpoints = snapEndpointsFromProfile(worldPts, h);
    mesh.userData.edgePairs = snapEdgePairsFromProfile(worldPts, h);
    return mesh;
  }

  if (creator === "curve") {
    const cpLocal: THREE.Vector3[] = (profile.userData.controlPoints as THREE.Vector3[] | undefined) ?? [];
    const isClosed = !!(profile.userData.isClosed as boolean | undefined);
    if (cpLocal.length >= 2) {
      profile.updateMatrixWorld();
      const cpWorld = cpLocal.map((p) => p.clone().applyMatrix4(profile.matrixWorld));
      const sampleCt = Math.max(cpLocal.length * 16, 64);
      const crWPts = cpWorld.map((v) => ({ x: v.x, y: v.y, z: v.z }));
      const crWNurbs = createCatmullRomAsNurbs(crWPts, { closed: isClosed });
      const samples = tessellate(crWNurbs, sampleCt + 1).map((p) => new THREE.Vector3(p.x, p.y, p.z));
      const color = 0x88aacc;
      const snapPts2d = cpWorld.map((v) => ({ x: v.x, y: v.y }));
      if (isClosed) {
        const shape = new THREE.Shape();
        shape.moveTo(samples[0].x, samples[0].y);
        for (let i = 1; i < samples.length; i++) shape.lineTo(samples[i].x, samples[i].y);
        shape.closePath();
        const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.userData.footprintPts = snapPts2d;
        mesh.userData.endpoints = snapEndpointsFromProfile(snapPts2d, h);
        mesh.userData.edgePairs = snapEdgePairsFromProfile(snapPts2d, h);
        return mesh;
      } else {
        const verts: number[] = [];
        const idxs: number[] = [];
        samples.forEach((p, i) => {
          verts.push(p.x, p.y, 0, p.x, p.y, h);
          if (i < samples.length - 1) {
            const b = i * 2;
            idxs.push(b, b+2, b+1, b+1, b+2, b+3);
          }
        });
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
        geom.setIndex(idxs);
        geom.computeVertexNormals();
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.userData.endpoints = snapEndpointsFromProfile(snapPts2d, h);
        mesh.userData.edgePairs = snapEdgePairsFromProfile(snapPts2d, h);
        return mesh;
      }
    }
  }

  if (creator === "polygon") {
    const cpLocal: THREE.Vector3[] = (profile.userData.controlPoints as THREE.Vector3[] | undefined) ?? [];
    if (cpLocal.length >= 3) {
      profile.updateMatrixWorld();
      const cpWorld = cpLocal.map((p) => p.clone().applyMatrix4(profile.matrixWorld));
      const shape = new THREE.Shape();
      shape.moveTo(cpWorld[0].x, cpWorld[0].y);
      for (let i = 1; i < cpWorld.length; i++) shape.lineTo(cpWorld[i].x, cpWorld[i].y);
      shape.closePath();
      const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
      const mat = new THREE.MeshStandardMaterial({ color: 0xd0a868, roughness: 0.55, metalness: 0.05 });
      const mesh = new THREE.Mesh(geom, mat);
      const polPts = cpWorld.map((v) => ({ x: v.x, y: v.y }));
      mesh.userData.footprintPts = polPts;
      mesh.userData.endpoints = snapEndpointsFromProfile(polPts, h);
      mesh.userData.edgePairs = snapEdgePairsFromProfile(polPts, h);
      return mesh;
    }
  }

  if (creator === "line" || creator === "polyline") {
    const pts: THREE.Vector3[] = (profile.userData.controlPoints as THREE.Vector3[] | undefined) ?? [];
    const isClosed = !!(profile.userData.isClosed as boolean | undefined);
    profile.updateMatrixWorld();
    const worldPts = pts.map((p) => p.clone().applyMatrix4(profile.matrixWorld));
    if (worldPts.length >= 2) {
      if (isClosed && worldPts.length >= 3) {
        // Closed polyline → solid extrusion (same as polygon)
        const shape = new THREE.Shape();
        shape.moveTo(worldPts[0].x, worldPts[0].y);
        for (let i = 1; i < worldPts.length; i++) shape.lineTo(worldPts[i].x, worldPts[i].y);
        shape.closePath();
        const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        const mat = new THREE.MeshStandardMaterial({ color: 0x88aacc, roughness: 0.55, metalness: 0.05 });
        const mesh = new THREE.Mesh(geom, mat);
        const polPts = worldPts.map((v) => ({ x: v.x, y: v.y }));
        mesh.userData.footprintPts = polPts;
        mesh.userData.endpoints = snapEndpointsFromProfile(polPts, h);
        mesh.userData.edgePairs = snapEdgePairsFromProfile(polPts, h);
        return mesh;
      }
      // Open line/polyline → ribbon surface
      const verts: number[] = [];
      const idxs: number[] = [];
      worldPts.forEach((p, i) => {
        verts.push(p.x, p.y, 0, p.x, p.y, h);
        if (i < worldPts.length - 1) {
          const b = i * 2;
          idxs.push(b, b+2, b+1, b+1, b+2, b+3);
        }
      });
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      geom.setIndex(idxs);
      geom.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: 0x88aacc, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geom, mat);
      const linPts = worldPts.map((p) => ({ x: p.x, y: p.y }));
      mesh.userData.endpoints = snapEndpointsFromProfile(linPts, h);
      mesh.userData.edgePairs = snapEdgePairsFromProfile(linPts, h);
      return mesh;
    }
  }

  // rect: read corner positions directly from LineLoop geometry buffer for exact world-space shape.
  if (creator === "rect") {
    profile.updateMatrixWorld();
    const profileAsLine = profile as THREE.Object3D & { geometry?: THREE.BufferGeometry };
    const posAttr = profileAsLine.geometry?.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (posAttr && posAttr.count >= 3) {
      const worldPts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < posAttr.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(profile.matrixWorld);
        worldPts.push({ x: v.x, y: v.y });
      }
      const shape = new THREE.Shape();
      shape.moveTo(worldPts[0].x, worldPts[0].y);
      for (let i = 1; i < worldPts.length; i++) shape.lineTo(worldPts[i].x, worldPts[i].y);
      shape.closePath();
      const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
      const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData.footprintPts = worldPts;
      mesh.userData.endpoints = snapEndpointsFromProfile(worldPts, h);
      mesh.userData.edgePairs = snapEdgePairsFromProfile(worldPts, h);
      return mesh;
    }
  }

  // Solid mesh used as profile: re-extrude from stored footprint or by extracting
  // the bottom-face polygon. Fixes "circle → box" when re-extruding an extrude result.
  if (profile instanceof THREE.Mesh) {
    // 1. Stored footprint circle (cylinders from circle extrusions).
    const fc = profile.userData.footprintCircle as { cx: number; cy: number; r: number } | undefined;
    if (fc) {
      const geom = new THREE.CylinderGeometry(fc.r, fc.r, h, 64);
      geom.rotateX(Math.PI / 2);
      geom.translate(0, 0, h / 2);
      const mat = new THREE.MeshStandardMaterial({ color: 0xb6d59a, roughness: 0.55, metalness: 0.05 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(fc.cx, fc.cy, 0);
      const circlePts = [
        { x: fc.cx, y: fc.cy },
        { x: fc.cx + fc.r, y: fc.cy }, { x: fc.cx - fc.r, y: fc.cy },
        { x: fc.cx, y: fc.cy + fc.r }, { x: fc.cx, y: fc.cy - fc.r },
      ];
      mesh.userData.footprintCircle = fc;
      mesh.userData.endpoints = snapEndpointsFromProfile(circlePts, h);
      mesh.userData.edgePairs = snapEdgePairsFromProfile(circlePts, h);
      return mesh;
    }
    // 2. Stored footprint polygon (polygon/polyline/rect/curve extrusions).
    const fp = profile.userData.footprintPts as Array<{ x: number; y: number }> | undefined;
    if (fp && fp.length >= 3) {
      const shape = new THREE.Shape();
      shape.moveTo(fp[0].x, fp[0].y);
      for (let i = 1; i < fp.length; i++) shape.lineTo(fp[i].x, fp[i].y);
      shape.closePath();
      const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
      const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData.footprintPts = fp;
      mesh.userData.endpoints = snapEndpointsFromProfile(fp, h);
      mesh.userData.edgePairs = snapEdgePairsFromProfile(fp, h);
      return mesh;
    }
    // 3. Extract bottom-face vertices from world-space geometry (fallback for imported/CSG meshes).
    profile.updateMatrixWorld();
    const posAttr = profile.geometry.getAttribute("position") as THREE.BufferAttribute | null;
    if (posAttr && posAttr.count >= 3) {
      const mat4 = profile.matrixWorld;
      let minZw = Infinity;
      for (let i = 0; i < posAttr.count; i++) {
        const z = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(mat4).z;
        if (z < minZw) minZw = z;
      }
      const rawPts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < posAttr.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(mat4);
        if (Math.abs(v.z - minZw) > 0.01) continue;
        rawPts.push({ x: v.x, y: v.y });
      }
      const uniq: Array<{ x: number; y: number }> = [];
      const DEDUP = 0.01;
      for (const p of rawPts) {
        if (!uniq.some(q => Math.hypot(p.x - q.x, p.y - q.y) < DEDUP)) uniq.push(p);
      }
      if (uniq.length >= 3) {
        // Filter out interior points that are near the centroid (e.g. fan-center vertex).
        const fcx = uniq.reduce((s, p) => s + p.x, 0) / uniq.length;
        const fcy = uniq.reduce((s, p) => s + p.y, 0) / uniq.length;
        const dists = uniq.map(p => Math.hypot(p.x - fcx, p.y - fcy));
        const avgDist = dists.reduce((s, d) => s + d, 0) / dists.length;
        const perimeter = avgDist > 0.01 ? uniq.filter((_, i) => dists[i] > avgDist * 0.4) : uniq;
        if (perimeter.length >= 3) {
          const pcx = perimeter.reduce((s, p) => s + p.x, 0) / perimeter.length;
          const pcy = perimeter.reduce((s, p) => s + p.y, 0) / perimeter.length;
          perimeter.sort((a, b) => Math.atan2(a.y - pcy, a.x - pcx) - Math.atan2(b.y - pcy, b.x - pcx));
          const shape = new THREE.Shape();
          shape.moveTo(perimeter[0].x, perimeter[0].y);
          for (let i = 1; i < perimeter.length; i++) shape.lineTo(perimeter[i].x, perimeter[i].y);
          shape.closePath();
          const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
          const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05 });
          const mesh = new THREE.Mesh(geom, mat);
          mesh.userData.footprintPts = perimeter;
          mesh.userData.endpoints = snapEndpointsFromProfile(perimeter, h);
          mesh.userData.edgePairs = snapEdgePairsFromProfile(perimeter, h);
          return mesh;
        }
      }
    }
    // 4. Last resort: bounding box.
    const geom = new THREE.BoxGeometry(Math.max(0.05, size.x), Math.max(0.05, size.y || size.x), h);
    geom.translate(ctr.x, ctr.y, h / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05 });
    const mesh = new THREE.Mesh(geom, mat);
    const hw = size.x / 2, hd = (size.y || size.x) / 2;
    const boxPts = [
      { x: ctr.x - hw, y: ctr.y - hd }, { x: ctr.x + hw, y: ctr.y - hd },
      { x: ctr.x + hw, y: ctr.y + hd }, { x: ctr.x - hw, y: ctr.y + hd },
    ];
    mesh.userData.endpoints = snapEndpointsFromProfile(boxPts, h);
    mesh.userData.edgePairs = snapEdgePairsFromProfile(boxPts, h);
    return mesh;
  }

  const w = Math.max(0.05, size.x);
  const d = Math.max(0.05, size.y || size.x);
  const geom = new THREE.BoxGeometry(w, d, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(ctr.x, ctr.y, 0);
  const cx = ctr.x, cy = ctr.y, hw = w / 2, hd = d / 2;
  const boxPts = [
    { x: cx - hw, y: cy - hd }, { x: cx + hw, y: cy - hd },
    { x: cx + hw, y: cy + hd }, { x: cx - hw, y: cy + hd },
    { x: cx, y: cy },
  ];
  mesh.userData.endpoints = snapEndpointsFromProfile(boxPts, h);
  mesh.userData.edgePairs = snapEdgePairsFromProfile(boxPts, h);
  return mesh;
}

// ── Raycast ───────────────────────────────────────────────────────────────────

export function opRaycastObject(
  viewer: Viewer,
  clientX: number,
  clientY: number,
  profileOnly = false,
  hoverMode = false,
): { obj: THREE.Object3D; point: THREE.Vector3 } | null {
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const rc = new THREE.Raycaster();
  rc.setFromCamera(ndc, viewer.getActiveCamera());

  const hitThresh = hoverMode ? 20 : (profileOnly ? 40 : 10);
  let thinHit: { obj: THREE.Object3D; point: THREE.Vector3 } | null = null;
  let thinHitD = hitThresh;
  viewer.getScene().traverse((o) => {
    if (o.userData.noSnap) return;
    if (profileOnly && !CLICK_PROFILE_CREATORS.has(o.userData.creator ?? "")) return;
    const isLine = o instanceof THREE.Line;
    const isPts = o instanceof THREE.Points;
    if (!isLine && !isPts) return;
    const posAttr = o.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!posAttr) return;
    const count = posAttr.count;
    for (let i = 0; i < count; i++) {
      const wp = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(o.matrixWorld);
      const sc = projectToScreen(viewer, wp.x, wp.y, wp.z);
      if (!sc) continue;
      const d = Math.hypot(sc.x - clientX, sc.y - clientY);
      if (d < thinHitD) { thinHitD = d; thinHit = { obj: o, point: wp }; }
    }
    if (isLine) {
      const looped = o instanceof THREE.LineLoop;
      for (let i = 0; i < count - (looped ? 0 : 1); i++) {
        const A = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(o.matrixWorld);
        const B = new THREE.Vector3().fromBufferAttribute(posAttr, (i + 1) % count).applyMatrix4(o.matrixWorld);
        const ep = closestPtOnSegToRay(viewer, clientX, clientY, A, B);
        if (!ep) continue;
        const sc = projectToScreen(viewer, ep.x, ep.y, ep.z);
        if (!sc) continue;
        const d = Math.hypot(sc.x - clientX, sc.y - clientY);
        if (d < thinHitD) { thinHitD = d; thinHit = { obj: o, point: ep }; }
      }
    }
  });
  if (thinHit) return thinHit;

  // For profile-only selection: also accept clicks inside closed LineLoop shapes
  // (circles, rects, polygons drawn on XY plane) via 2D ray-plane containment.
  if (profileOnly) {
    const rayOrigin = new THREE.Vector3(); const rayDir = new THREE.Vector3();
    rc.ray.origin.clone().copy(rayOrigin); // avoid mutation
    rc.ray.direction.clone().copy(rayDir);
    const rayO = rc.ray.origin, rayD = rc.ray.direction;
    // Intersect the ray with Z=0 plane
    if (Math.abs(rayD.z) > 1e-6) {
      const t = -rayO.z / rayD.z;
      if (t > 0) {
        const hitPt = new THREE.Vector3(rayO.x + t * rayD.x, rayO.y + t * rayD.y, 0);
        let best: { obj: THREE.Object3D; dist: number } | null = null;
        viewer.getScene().traverse((o) => {
          if (o.userData.noSnap) return;
          if (!CLICK_PROFILE_CREATORS.has(o.userData.creator ?? "")) return;
          // Accept LineLoop (circles, rects) and closed Line curves (isClosed=true).
          const isLooped = o instanceof THREE.LineLoop;
          const isClosedLine = o instanceof THREE.Line && !!(o.userData.isClosed as boolean | undefined);
          if (!isLooped && !isClosedLine) return;
          const posAttr = o.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
          if (!posAttr) return;
          // 2D point-in-polygon using ray-cast method
          const n = posAttr.count;
          let inside = false;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            const ai = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(o.matrixWorld);
            const aj = new THREE.Vector3().fromBufferAttribute(posAttr, j).applyMatrix4(o.matrixWorld);
            if (((ai.y > hitPt.y) !== (aj.y > hitPt.y)) &&
                hitPt.x < ai.x + (aj.x - ai.x) * (hitPt.y - ai.y) / (aj.y - ai.y)) {
              inside = !inside;
            }
          }
          if (inside) {
            const ctr = new THREE.Vector3(); new THREE.Box3().setFromObject(o).getCenter(ctr);
            const dist = hitPt.distanceTo(ctr);
            if (!best || dist < best.dist) best = { obj: o, dist };
          }
        });
        if (best) return { obj: (best as { obj: THREE.Object3D; dist: number }).obj, point: hitPt };
      }
    }
  }

  const meshes: THREE.Mesh[] = [];
  viewer.getScene().traverse((o) => {
    const isDisplay = !!o.userData.isJoinDisplay;
    if (o.userData.noSnap && !isDisplay) return;
    if (!(o instanceof THREE.Mesh)) return;
    if (!o.geometry?.getAttribute("position")) return;
    if (profileOnly && !CLICK_PROFILE_CREATORS.has(o.userData.creator ?? "")) return;
    // Skip very large flat meshes as extrude profiles (e.g., floor slabs > 50m² footprint)
    // to prevent accidentally extruding the ground plane.
    if (profileOnly) {
      const b = new THREE.Box3().setFromObject(o); const s = new THREE.Vector3(); b.getSize(s);
      if (s.x * s.y > 50) return;
    }
    // #950: skip meshes that are effectively invisible (parent-group visibility).
    if (!isDisplay) {
      let anc: THREE.Object3D | null = o;
      while (anc) { if (!anc.visible) return; anc = anc.parent; }
    }
    meshes.push(o);
  });
  const hits = rc.intersectObjects(meshes, false);
  if (!hits.length) return null;
  const hit = hits[0];
  let hitObj: THREE.Object3D = hit.object;
  // Resolve child mesh of any creator-tagged Group (roof, void-cut wall, etc.) to the Group.
  if (hitObj.parent instanceof THREE.Group && hitObj.parent.userData.creator) hitObj = hitObj.parent;
  return { obj: hitObj, point: hit.point.clone() };
}
