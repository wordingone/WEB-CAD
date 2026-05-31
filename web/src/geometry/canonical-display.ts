import * as THREE from "three";
import type { CanonicalGeometry } from "./canonical-geometry";
import { tessellate as tessellateCurve } from "../nurbs/nurbs-curves";
import { pointAtUV, tessellateSurface } from "../nurbs/nurbs-surfaces";

function geometryFromSurface(surface: CanonicalGeometry & { kind: "surface" }): THREE.Mesh {
  const tess = tessellateSurface(surface.surface, 16, 16);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(tess.positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(tess.normals, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(tess.uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(tess.indices, 1));
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xe8e0d8, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide }));
}

function geometryFromBrep(record: CanonicalGeometry & { kind: "brep" }): THREE.Mesh | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const groups: Array<{ start: number; count: number; materialIndex: number }> = [];
  let offset = 0;
  let faceIndex = 0;
  for (const shell of record.brep.shells) {
    for (const face of shell.faces) {
      const indexStart = indices.length;
      const trim = face.outerLoop?.curves?.[0];
      if (trim?.kind === "polyline" && trim.points.length >= 4) {
        const pts = trim.points;
        const closed = pts.length > 1
          && Math.abs(pts[0].x - pts[pts.length - 1].x) < 1e-9
          && Math.abs(pts[0].y - pts[pts.length - 1].y) < 1e-9;
        const loop = closed ? pts.slice(0, -1) : pts;
        if (loop.length >= 3) {
          const world = loop.map((p) => pointAtUV(face.surface, p.x, p.y));
          const a = new THREE.Vector3(world[0].x, world[0].y, world[0].z);
          const b = new THREE.Vector3(world[1].x, world[1].y, world[1].z);
          const c = new THREE.Vector3(world[2].x, world[2].y, world[2].z);
          const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
          if (!face.orientation) normal.multiplyScalar(-1);
          for (const p of world) {
            positions.push(p.x, p.y, p.z);
            normals.push(normal.x, normal.y, normal.z);
          }
          for (let i = 1; i + 1 < loop.length; i++) {
            indices.push(offset, offset + i, offset + i + 1);
          }
          offset += loop.length;
        }
      } else {
        const tess = tessellateSurface(face.surface, 4, 4);
        positions.push(...tess.positions);
        normals.push(...tess.normals);
        for (const idx of tess.indices) indices.push(idx + offset);
        offset += tess.positions.length / 3;
      }
      const indexCount = indices.length - indexStart;
      if (indexCount > 0) groups.push({ start: indexStart, count: indexCount, materialIndex: faceIndex });
      faceIndex++;
    }
  }
  if (positions.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(normals), 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  for (const group of groups) geo.addGroup(group.start, group.count, group.materialIndex);
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide }));
}

export function objectFromCanonicalGeometry(record: CanonicalGeometry): THREE.Object3D | null {
  if (record.kind === "brep") return geometryFromBrep(record);
  if (record.kind === "surface") return geometryFromSurface(record);
  if (record.kind === "curve") {
    const pts = tessellateCurve(record.curve, 64).map((p) => new THREE.Vector3(p.x, p.y, p.z));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x88aacc }));
  }
  if (record.kind === "point") {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([record.point.x, record.point.y, record.point.z]), 3));
    return new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 8, sizeAttenuation: false }));
  }
  return null;
}
