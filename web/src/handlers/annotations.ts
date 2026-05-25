import { registerHandler } from "../commands/dispatch";
import { Viewer } from "../viewer/viewer";
import * as THREE from "three";
import { formatLength, formatArea, formatVolume } from "../units";
import { opAddLabel, opBuildAnnotLine } from "../viewer/op-tool";

export function registerAnnotationHandlers(viewer: Viewer): void {
  registerHandler("SdAlignedDim", (args) => {
    const aArr = (args.a as number[] | undefined) ?? [0, 0, 0];
    const bArr = (args.b as number[] | undefined) ?? [1, 0, 0];
    const ptA = new THREE.Vector3(aArr[0] ?? 0, aArr[1] ?? 0, aArr[2] ?? 0);
    const ptB = new THREE.Vector3(bArr[0] ?? 0, bArr[1] ?? 0, bArr[2] ?? 0);
    const dist = ptA.distanceTo(ptB);
    const mid = ptA.clone().add(ptB).multiplyScalar(0.5);
    const lineObj = opBuildAnnotLine([ptA, ptB]);
    lineObj.userData.creator = "SdAlignedDim";
    viewer.addMesh(lineObj, "mesh");
    opAddLabel(formatLength(dist), mid, viewer);
    return { measured: "length", distance: parseFloat(dist.toFixed(4)), unit: "m", annotationUuid: lineObj.uuid };
  });

  registerHandler("SdAngularDim", (args) => {
    const vArr  = (args.vertex as number[] | undefined) ?? [0, 0, 0];
    const r1Arr = (args.ray1   as number[] | undefined) ?? [1, 0, 0];
    const r2Arr = (args.ray2   as number[] | undefined) ?? [0, 1, 0];
    const vertex = new THREE.Vector3(vArr[0] ?? 0, vArr[1] ?? 0, vArr[2] ?? 0);
    const ray1 = new THREE.Vector3(r1Arr[0] ?? 0, r1Arr[1] ?? 0, r1Arr[2] ?? 0);
    const ray2 = new THREE.Vector3(r2Arr[0] ?? 0, r2Arr[1] ?? 0, r2Arr[2] ?? 0);
    const d1 = ray1.clone().sub(vertex).normalize();
    const d2 = ray2.clone().sub(vertex).normalize();
    const angleDeg = (Math.acos(Math.max(-1, Math.min(1, d1.dot(d2)))) * 180) / Math.PI;
    const lineObj = opBuildAnnotLine([vertex, ray1, vertex, ray2]);
    lineObj.userData.creator = "SdAngularDim";
    viewer.addMesh(lineObj, "mesh");
    opAddLabel(`${angleDeg.toFixed(1)}°`, vertex, viewer);
    return { measured: "angle", angleDeg: parseFloat(angleDeg.toFixed(2)), unit: "deg", annotationUuid: lineObj.uuid };
  });

  registerHandler("SdAreaDim", (args) => {
    const rawPts = (args.points as number[][] | undefined) ?? [];
    if (rawPts.length < 3) return { error: "SdAreaDim requires at least 3 points", measured: null };
    let area = 0;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < rawPts.length; i++) {
      const j = (i + 1) % rawPts.length;
      area += (rawPts[i][0] ?? 0) * (rawPts[j][1] ?? 0) - (rawPts[j][0] ?? 0) * (rawPts[i][1] ?? 0);
      cx += rawPts[i][0] ?? 0; cy += rawPts[i][1] ?? 0; cz += rawPts[i][2] ?? 0;
    }
    area = Math.abs(area) / 2;
    const n = rawPts.length;
    const centroid = new THREE.Vector3(cx / n, cy / n, cz / n);
    const vec3Pts = rawPts.map((p) => new THREE.Vector3(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0));
    const lineObj = opBuildAnnotLine([...vec3Pts, vec3Pts[0]]);
    viewer.addMesh(lineObj, "mesh");
    opAddLabel(`Area: ${formatArea(area)}`, centroid, viewer);
    return { measured: "area", area: parseFloat(area.toFixed(4)), unit: "m2", annotationUuid: lineObj.uuid };
  });

  registerHandler("SdVolumeDim", (args) => {
    const id = args.id as string | undefined;
    if (!id) return { error: "SdVolumeDim requires id", measured: null };
    const obj = viewer.getScene().getObjectByProperty("uuid", id);
    if (!obj) return { error: `SdVolumeDim — object not found: ${id}`, measured: null };
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    const ctr = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(ctr);
    const volume = size.x * size.y * size.z;
    const lineObj = opBuildAnnotLine([box.min, box.max]);
    viewer.addMesh(lineObj, "mesh");
    opAddLabel(`Vol: ${formatVolume(volume)}`, ctr, viewer);
    return { measured: "volume", volume: parseFloat(volume.toFixed(4)), unit: "m3", annotationUuid: lineObj.uuid };
  });

  registerHandler("SdLabel", (args) => {
    const text = (args.text as string | undefined) ?? "";
    if (!text) return { error: "SdLabel requires text" };
    const posArr = (args.position as number[] | undefined) ?? [0, 0, 0];
    const pt = new THREE.Vector3(posArr[0] ?? 0, posArr[1] ?? 0, posArr[2] ?? 0);
    opAddLabel(text, pt, viewer);
    return { placed: true, text };
  });

  registerHandler("SdTransientMeasure", (args) => {
    const aArr = (args.a as number[] | undefined) ?? [0, 0, 0];
    const bArr = (args.b as number[] | undefined) ?? [1, 0, 0];
    const ptA = new THREE.Vector3(aArr[0] ?? 0, aArr[1] ?? 0, aArr[2] ?? 0);
    const ptB = new THREE.Vector3(bArr[0] ?? 0, bArr[1] ?? 0, bArr[2] ?? 0);
    const dist = ptA.distanceTo(ptB);
    const mid = ptA.clone().add(ptB).multiplyScalar(0.5);
    const lineObj = opBuildAnnotLine([ptA, ptB]);
    viewer.getScene().add(lineObj); // audit-undo-ok — transient measurement line, no undo entry intentional
    opAddLabel(formatLength(dist), mid, viewer);
    return { measured: "length", distance: parseFloat(dist.toFixed(4)), unit: "m" };
  });
}
