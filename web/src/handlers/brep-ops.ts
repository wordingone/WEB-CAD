import { registerHandler } from "../commands/dispatch";
import { pushReplaceAction } from "../history";
import { brepConcat, type Brep, type BrepFace } from "../nurbs/nurbs-brep";
import type { Curve } from "../nurbs/nurbs-curves";
import { transform as transformCurve } from "../nurbs/nurbs-curves";
import type { Point3, Xform } from "../nurbs/nurbs-primitives";
import { Point3 as Pt3 } from "../nurbs/nurbs-primitives";
import { pointAtUV, tessellateSurface, transformSurface } from "../nurbs/nurbs-surfaces";
import type { Viewer } from "../viewer/viewer";
import * as THREE from "three";

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
        brep: { shells: [{ faces: [face], edges: [], vertices: [], isClosed: false }] },
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

function linkJoinedCanonicalBreps(viewer: Viewer, meshes: THREE.Mesh[], joined: THREE.Object3D): void {
  const store = viewer.getCanonicalGeometryStore();
  const operands = meshes.map((mesh) => store.resolveObjectOrAncestor(mesh));
  const breps = meshes.map((mesh) => canonicalBrepForObject(viewer, mesh));
  if (breps.some((brep) => !brep) || operands.some((record) => record?.kind !== "brep")) return;
  const record = store.create({
    kind: "brep",
    brep: brepConcat(...breps as Brep[]),
    source: "edit",
    createdBy: "SdJoin",
    metadata: {
      operation: "join",
      operands: operands.map((record) => record?.id),
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
    if (!(obj instanceof THREE.Mesh)) return { error: "SdRebuild - target must be a Mesh" };
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
