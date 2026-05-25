// op-tool-fillet-2d.ts — 2D polyline corner fillet operation.
// Pure function; no dependency on op-tool.ts module state.

import * as THREE from "three";
import type { Viewer } from "./viewer";
import { pushReplaceAction } from "../history";

export function opApply2DFillet(
  viewer: Viewer,
  line: THREE.Line,
  prevPtWorld: THREE.Vector3,
  cornerPtWorld: THREE.Vector3,
  nextPtWorld: THREE.Vector3,
  r: number,
): void {
  // Directions from corner toward each adjacent vertex
  const d1 = prevPtWorld.clone().sub(cornerPtWorld).normalize();
  const d2 = nextPtWorld.clone().sub(cornerPtWorld).normalize();

  // Dot product → half-angle of the corner opening
  const dotD = Math.max(-1, Math.min(1, d1.dot(d2)));
  const theta = Math.acos(dotD);          // angle at corner (between the two segments)
  const halfAngle = theta / 2;
  if (halfAngle < 1e-4 || Math.PI - halfAngle < 1e-4) return; // collinear — skip

  // Standard arc fillet: tangent distance from corner to each tangent point
  const tanDist = r / Math.tan(halfAngle);
  // Clamp to 90% of the shorter adjacent segment so we don't overshoot
  const maxDist = Math.min(prevPtWorld.distanceTo(cornerPtWorld), nextPtWorld.distanceTo(cornerPtWorld)) * 0.9;
  const td = Math.min(tanDist, maxDist);
  const actualR = td * Math.tan(halfAngle);

  const t1 = cornerPtWorld.clone().add(d1.clone().multiplyScalar(td));
  const t2 = cornerPtWorld.clone().add(d2.clone().multiplyScalar(td));

  // Arc center: along bisector at distance r / sin(halfAngle) from corner
  const bisect = d1.clone().add(d2).normalize();
  const centerDist = actualR / Math.sin(halfAngle);
  const center = cornerPtWorld.clone().add(bisect.clone().multiplyScalar(centerDist));

  // Arc sweep using the cross-product z-sign to determine orientation
  const crossZ = d1.x * d2.y - d1.y * d2.x;
  const arcAngle = Math.PI - theta;
  const sweep    = arcAngle * (crossZ > 0 ? -1 : 1);

  const a1 = Math.atan2(t1.y - center.y, t1.x - center.x);
  const ARC_SEGS = 12;
  const arcPtsWorld: THREE.Vector3[] = [];
  for (let i = 0; i <= ARC_SEGS; i++) {
    const a = a1 + (sweep * i) / ARC_SEGS;
    arcPtsWorld.push(new THREE.Vector3(
      center.x + actualR * Math.cos(a),
      center.y + actualR * Math.sin(a),
      cornerPtWorld.z,
    ));
  }

  // Map world arc points into line-local space
  const invMat = line.matrixWorld.clone().invert();
  const localT1  = t1.clone().applyMatrix4(invMat);
  const localT2  = t2.clone().applyMatrix4(invMat);
  const localCorner = cornerPtWorld.clone().applyMatrix4(invMat);
  const localArcPts = arcPtsWorld.map((p) => p.clone().applyMatrix4(invMat));

  // Find corner vertex index in existing geometry
  const pos = line.geometry.getAttribute("position") as THREE.BufferAttribute;
  const allVerts: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    allVerts.push(new THREE.Vector3().fromBufferAttribute(pos, i));
  }
  let cornerIdx = -1;
  let minD = Infinity;
  for (let i = 0; i < allVerts.length; i++) {
    const d = allVerts[i].distanceTo(localCorner);
    if (d < minD) { minD = d; cornerIdx = i; }
  }
  // For a closed LineLoop all corner indices are valid (including 0 and last).
  const isLoop = line instanceof THREE.LineLoop;
  if (!isLoop && (cornerIdx <= 0 || cornerIdx >= allVerts.length - 1)) return;

  // Rebuild vertex array with arc replacing the corner
  const newVerts: THREE.Vector3[] = [
    ...allVerts.slice(0, cornerIdx),
    localT1,
    ...localArcPts,
    localT2,
    ...allVerts.slice(cornerIdx + 1),
  ];

  const lineGeo = new THREE.BufferGeometry().setFromPoints(newVerts);
  const lineMat = (line.material as THREE.LineBasicMaterial).clone();
  const newLine = new THREE.Line(lineGeo, lineMat);
  newLine.position.copy(line.position);
  newLine.rotation.copy(line.rotation);
  newLine.scale.copy(line.scale);
  newLine.userData = { ...line.userData, endpoints: newVerts.map((v) => ({ x: v.x, y: v.y, z: v.z })) };

  viewer.getScene().remove(line); // audit-undo-ok — tracked by pushReplaceAction below
  viewer.addMesh(newLine as unknown as THREE.Mesh, "line", { noHistory: true });
  pushReplaceAction(newLine as unknown as THREE.Mesh, [line as unknown as THREE.Mesh], "fillet");
}
