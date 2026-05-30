// dimension-style.ts — Revit-quality dimension assembly (#204).
// Produces THREE.Group objects containing: dim line, witness lines, tick marks.
// Text labels are placed separately via opAddLabel (camera-following HTML).

import * as THREE from "three";

export interface DimStyle {
  lineColor: number;
  tickSize: number;
  witnessGap: number;
  witnessExtend: number;
  offsetDist: number;
  arcSegments: number;
}

export const DEFAULT_DIM_STYLE: DimStyle = {
  lineColor: 0x1a56cc,
  tickSize: 0.06,
  witnessGap: 0.04,
  witnessExtend: 0.06,
  offsetDist: 0.35,
  arcSegments: 32,
};

function merged(overrides?: Partial<DimStyle>): DimStyle {
  return { ...DEFAULT_DIM_STYLE, ...(overrides ?? {}) };
}

function makeLineGroup(segments: [THREE.Vector3, THREE.Vector3][], color: number): THREE.Group {
  const g = new THREE.Group();
  g.userData.noSnap = true;
  g.userData.noDim = true;
  for (const [a, b] of segments) {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const mat = new THREE.LineBasicMaterial({ color, depthTest: false });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 100;
    line.userData.noSnap = true;
    g.add(line);
  }
  return g;
}

/**
 * Aligned dimension between ptA and ptB.
 * offsetDir: unit vector perpendicular to AB in the measurement plane.
 * Returns {group, dimLineMid} where dimLineMid is the center of the dim line (for label placement).
 */
export function buildAlignedDim(
  ptA: THREE.Vector3,
  ptB: THREE.Vector3,
  offsetDir?: THREE.Vector3,
  style?: Partial<DimStyle>,
): { group: THREE.Group; dimLineMid: THREE.Vector3 } {
  const s = merged(style);
  const ab = ptB.clone().sub(ptA);
  const abLen = ab.length();

  // Default offset direction: perpendicular to AB, in-plane (XY cross Z first, fallback Y).
  let perp: THREE.Vector3;
  if (offsetDir) {
    perp = offsetDir.clone().normalize();
  } else {
    const up = new THREE.Vector3(0, 0, 1);
    perp = new THREE.Vector3().crossVectors(ab, up).normalize();
    if (perp.lengthSq() < 0.0001) {
      perp = new THREE.Vector3().crossVectors(ab, new THREE.Vector3(0, 1, 0)).normalize();
    }
    if (perp.lengthSq() < 0.0001) perp.set(0, 1, 0);
  }

  const offsetVec = perp.clone().multiplyScalar(s.offsetDist);
  const extendVec = perp.clone().multiplyScalar(s.witnessExtend);
  const gapVec = perp.clone().multiplyScalar(s.witnessGap);

  const dimA = ptA.clone().add(offsetVec);
  const dimB = ptB.clone().add(offsetVec);
  const dimLineMid = dimA.clone().lerp(dimB, 0.5);

  // Tick direction: along the dim line direction
  const dimDir = dimB.clone().sub(dimA).normalize();
  const tickHalf = dimDir.clone().multiplyScalar(s.tickSize);

  const segments: [THREE.Vector3, THREE.Vector3][] = [
    // Main dim line
    [dimA, dimB],
    // Witness line A
    [ptA.clone().add(gapVec), dimA.clone().add(extendVec)],
    // Witness line B
    [ptB.clone().add(gapVec), dimB.clone().add(extendVec)],
    // Tick at A
    [dimA.clone().sub(tickHalf), dimA.clone().add(tickHalf)],
    // Tick at B
    [dimB.clone().sub(tickHalf), dimB.clone().add(tickHalf)],
  ];

  // Skip dim line ticks if distance is very small
  if (abLen < s.tickSize * 3) segments.splice(3, 2);

  const group = makeLineGroup(segments, s.lineColor);
  return { group, dimLineMid };
}

/**
 * Angular dimension between two rays from a vertex.
 * Draws an arc at `radius` from vertex, plus the two radial rays.
 * Returns {group, arcMid} where arcMid is the mid-point on the arc (for label placement).
 */
export function buildAngularDim(
  vertex: THREE.Vector3,
  ptA: THREE.Vector3,
  ptB: THREE.Vector3,
  style?: Partial<DimStyle>,
): { group: THREE.Group; arcMid: THREE.Vector3 } {
  const s = merged(style);
  const d1 = ptA.clone().sub(vertex).normalize();
  const d2 = ptB.clone().sub(vertex).normalize();

  // Determine the arc radius as a fraction of the shorter ray.
  const r1 = ptA.distanceTo(vertex);
  const r2 = ptB.distanceTo(vertex);
  const radius = Math.max(0.1, Math.min(r1, r2) * 0.6);

  // Angle span in the plane of d1/d2.
  const cosA = Math.max(-1, Math.min(1, d1.dot(d2)));
  const angleSpan = Math.acos(cosA);

  // Build arc using Rodrigues rotation of d1 around the axis normal to the d1/d2 plane.
  const arcAxis = new THREE.Vector3().crossVectors(d1, d2).normalize();
  if (arcAxis.lengthSq() < 0.0001) {
    // Degenerate: parallel rays, return empty group
    const group = new THREE.Group();
    group.userData.noSnap = true;
    return { group, arcMid: vertex.clone() };
  }

  const arcPts: THREE.Vector3[] = [];
  for (let i = 0; i <= s.arcSegments; i++) {
    const theta = (i / s.arcSegments) * angleSpan;
    const dir = d1.clone().applyAxisAngle(arcAxis, theta);
    arcPts.push(vertex.clone().addScaledVector(dir, radius));
  }

  const arcMid = arcPts[Math.floor(arcPts.length / 2)].clone();
  const arcStart = arcPts[0];
  const arcEnd = arcPts[arcPts.length - 1];

  // Draw arc as a polyline
  const geo = new THREE.BufferGeometry().setFromPoints(arcPts);
  const mat = new THREE.LineBasicMaterial({ color: s.lineColor, depthTest: false });
  const arcLine = new THREE.Line(geo, mat);
  arcLine.renderOrder = 100;
  arcLine.userData.noSnap = true;

  const group = new THREE.Group();
  group.userData.noSnap = true;
  group.userData.noDim = true;
  group.add(arcLine);

  // Radial rays from vertex to arc start/end
  for (const endPt of [arcStart, arcEnd]) {
    const segGeo = new THREE.BufferGeometry().setFromPoints([vertex, endPt]);
    const segMat = new THREE.LineBasicMaterial({ color: s.lineColor, depthTest: false });
    const segLine = new THREE.Line(segGeo, segMat);
    segLine.renderOrder = 100;
    segLine.userData.noSnap = true;
    group.add(segLine);
  }

  return { group, arcMid };
}

/**
 * Volume dimension: a box wireframe showing the bounding box.
 * Returns {group, boxCenter} where boxCenter is the center (for label placement).
 */
export function buildVolumeDimBox(
  box: THREE.Box3,
  style?: Partial<DimStyle>,
): { group: THREE.Group; boxCenter: THREE.Vector3 } {
  const s = merged(style);
  const boxCenter = new THREE.Vector3();
  box.getCenter(boxCenter);

  const helper = new THREE.Box3Helper(box, new THREE.Color(s.lineColor));
  helper.renderOrder = 100;
  helper.userData.noSnap = true;
  helper.userData.noDim = true;

  const group = new THREE.Group();
  group.userData.noSnap = true;
  group.userData.noDim = true;
  group.add(helper);

  return { group, boxCenter };
}

/**
 * Grid bubble sprite: circle with letter label, always faces camera (THREE.Sprite).
 */
export function makeGridBubble(label: string): THREE.Sprite {
  const SIZE = 64;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE; canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.strokeStyle = "#1a56cc";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#1a56cc";
    ctx.font = `bold ${SIZE * 0.45}px system-ui,sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, SIZE / 2, SIZE / 2 + 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.01, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.4, 0.4, 1);
  sprite.userData.noSnap = true;
  sprite.userData.isGridBubble = true;
  return sprite;
}
