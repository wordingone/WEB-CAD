// s330-impl.ts — S10 Transform & Deform handlers (#330)
//
// Implements: SdOrient3Point, SdOrientOnSurface, SdProject, SdPlanarFlow,
//             SdTwist, SdTaper, SdBend
// Stubs (C++-blocked): kern_flow_along_curve, kern_flow_along_surface,
//                      kern_cage_morph, kern_sporph, kern_splop, kern_maelstrom
//
// oracle: closed-form 3-point frame + quaternion rotation (SdOrient3Point)
// oracle: plane projection math (SdProject, SdPlanarFlow)
// oracle: closed-form twist/taper/bend deformation matrices
// oracle: replicad for flow/cage — blocked pending kern Phase D

import * as THREE from "three";
import { registerHandler } from "../commands/dispatch";
import { Viewer } from "../viewer/viewer";
import { getSelected } from "../viewer/selection-state";
import { captureTransform, pushTransformAction, pushReplaceAction } from "../history";

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveTarget(viewer: Viewer, args: Record<string, unknown>): THREE.Object3D | null {
  const byTarget = (args.target as string | undefined)
    ? (viewer.getScene().getObjectByProperty("uuid", args.target as string) ?? null)
    : null;
  return byTarget ?? getSelected()?.transformTarget ?? viewer.getActiveObject();
}

function pt3(arr: unknown, fallback: [number, number, number] = [0, 0, 0]): THREE.Vector3 {
  if (!Array.isArray(arr) || arr.length < 3) return new THREE.Vector3(...fallback);
  return new THREE.Vector3(
    typeof arr[0] === "number" ? arr[0] : fallback[0],
    typeof arr[1] === "number" ? arr[1] : fallback[1],
    typeof arr[2] === "number" ? arr[2] : fallback[2],
  );
}

/** Build an orthonormal frame from 3 non-collinear points.
 *  Returns { origin, xAxis, yAxis, zAxis } in right-hand convention.
 *  oracle: closed-form 3-point frame construction (Gram-Schmidt).
 */
function frameFrom3Points(
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  p2: THREE.Vector3,
): { origin: THREE.Vector3; x: THREE.Vector3; y: THREE.Vector3; z: THREE.Vector3 } | null {
  const v1 = p1.clone().sub(p0);
  const v2 = p2.clone().sub(p0);
  if (v1.lengthSq() < 1e-20 || v2.lengthSq() < 1e-20) return null;
  const z = v1.clone().cross(v2);
  if (z.lengthSq() < 1e-20) return null; // collinear
  z.normalize();
  const x = v1.clone().normalize();
  const y = z.clone().cross(x).normalize();
  return { origin: p0.clone(), x, y, z };
}

/** Quaternion that rotates fromFrame to toFrame.
 *  oracle: quaternion from rotation matrix = frame change.
 */
function frameDeltaQuaternion(
  fromFrame: { x: THREE.Vector3; y: THREE.Vector3; z: THREE.Vector3 },
  toFrame: { x: THREE.Vector3; y: THREE.Vector3; z: THREE.Vector3 },
): THREE.Quaternion {
  // Build rotation matrix R = toFrame * fromFrame^T
  // R maps fromFrame axes to toFrame axes
  const mFrom = new THREE.Matrix4().makeBasis(fromFrame.x, fromFrame.y, fromFrame.z);
  const mTo = new THREE.Matrix4().makeBasis(toFrame.x, toFrame.y, toFrame.z);
  const mFromInv = mFrom.clone().transpose(); // orthonormal → inverse = transpose
  const mDelta = mTo.clone().multiply(mFromInv);
  return new THREE.Quaternion().setFromRotationMatrix(mDelta);
}

/** Deform a THREE.BufferGeometry in-place using a per-vertex function. */
function deformGeometry(
  geo: THREE.BufferGeometry,
  fn: (v: THREE.Vector3) => THREE.Vector3,
): void {
  const posAttr = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < posAttr.count; i++) {
    const v = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
    const vOut = fn(v);
    posAttr.setXYZ(i, vOut.x, vOut.y, vOut.z);
  }
  posAttr.needsUpdate = true;
  geo.computeVertexNormals();
}

/** Clone a Mesh with fresh geometry + same userData */
function cloneMesh(src: THREE.Mesh): THREE.Mesh {
  const geo = src.geometry.clone();
  // Apply world transform into the cloned geometry so the clone sits at origin
  src.updateMatrixWorld(true);
  geo.applyMatrix4(src.matrixWorld);
  const mat = Array.isArray(src.material) ? src.material[0] : src.material;
  const m = new THREE.Mesh(geo, mat);
  m.userData = { ...src.userData };
  return m;
}

/** Compute bounding box in local space. */
function localBbox(geo: THREE.BufferGeometry): THREE.Box3 {
  const box = new THREE.Box3();
  box.setFromBufferAttribute(geo.getAttribute("position") as THREE.BufferAttribute);
  return box;
}

// ── SdOrient3Point ────────────────────────────────────────────────────────────
// oracle: closed-form 3-point frame + quaternion rotation

export function handle_SdOrient3Point(
  args: Record<string, unknown>,
  viewer: Viewer,
): Record<string, unknown> {
  const sel = resolveTarget(viewer, args);
  if (!sel) return { error: "SdOrient3Point — no target" };
  if (!(sel instanceof THREE.Mesh)) return { error: "SdOrient3Point — target must be a Mesh" };

  const fp0 = pt3(args.from0 ?? args.f0);
  const fp1 = pt3(args.from1 ?? args.f1, [1, 0, 0]);
  const fp2 = pt3(args.from2 ?? args.f2, [0, 1, 0]);
  const tp0 = pt3(args.to0 ?? args.t0);
  const tp1 = pt3(args.to1 ?? args.t1, [1, 0, 0]);
  const tp2 = pt3(args.to2 ?? args.t2, [0, 1, 0]);

  const fromFrame = frameFrom3Points(fp0, fp1, fp2);
  const toFrame = frameFrom3Points(tp0, tp1, tp2);
  if (!fromFrame || !toFrame) return { error: "SdOrient3Point — degenerate frame (collinear points)" };

  const before = captureTransform(sel);

  // Translation: move fromFrame origin to toFrame origin
  const translation = toFrame.origin.clone().sub(fromFrame.origin);

  // Rotation: quaternion mapping fromFrame axes to toFrame axes
  const q = frameDeltaQuaternion(fromFrame, toFrame);

  // Apply: rotate around fromFrame origin, then translate
  sel.position.sub(fromFrame.origin);
  sel.position.applyQuaternion(q);
  sel.position.add(fromFrame.origin).add(translation);
  sel.quaternion.premultiply(q);
  sel.updateMatrix();
  sel.updateMatrixWorld(true);
  pushTransformAction(sel, before);

  return {
    oriented: true,
    fromOrigin: fromFrame.origin.toArray(),
    toOrigin: toFrame.origin.toArray(),
  };
}

// ── SdOrientOnSurface ─────────────────────────────────────────────────────────
// oracle: closed-form — align object Z-axis to surface normal at UV point.
// Surface approximated as bilinear patch from corner args.

export function handle_SdOrientOnSurface(
  args: Record<string, unknown>,
  viewer: Viewer,
): Record<string, unknown> {
  const sel = resolveTarget(viewer, args);
  if (!sel) return { error: "SdOrientOnSurface — no target" };

  // Surface normal via 3-point frame from surface patch corners
  const sp0 = pt3(args.surface0 ?? args.s0);
  const sp1 = pt3(args.surface1 ?? args.s1, [1, 0, 0]);
  const sp2 = pt3(args.surface2 ?? args.s2, [0, 1, 0]);
  const frame = frameFrom3Points(sp0, sp1, sp2);
  if (!frame) return { error: "SdOrientOnSurface — degenerate surface patch" };

  const targetPos = pt3(args.position ?? args.pos ?? [sp0.x, sp0.y, sp0.z]);
  const u = typeof args.u === "number" ? args.u : 0;
  const v = typeof args.v === "number" ? args.v : 0;

  // Bilinear interpolation for position on surface
  const sp3 = pt3(args.surface3 ?? args.s3, [sp1.x, sp2.y, sp0.z]);
  const surfPos = new THREE.Vector3(
    (1 - u) * (1 - v) * sp0.x + u * (1 - v) * sp1.x + (1 - u) * v * sp2.x + u * v * sp3.x,
    (1 - u) * (1 - v) * sp0.y + u * (1 - v) * sp1.y + (1 - u) * v * sp2.y + u * v * sp3.y,
    (1 - u) * (1 - v) * sp0.z + u * (1 - v) * sp1.z + (1 - u) * v * sp2.z + u * v * sp3.z,
  );

  const before = captureTransform(sel);

  // Current object "up" is Z
  const worldZ = new THREE.Vector3(0, 0, 1).applyQuaternion(sel.quaternion);
  const q = new THREE.Quaternion().setFromUnitVectors(worldZ, frame.z);

  sel.position.copy(args.position ? targetPos : surfPos);
  sel.quaternion.premultiply(q);
  sel.updateMatrix();
  sel.updateMatrixWorld(true);
  pushTransformAction(sel, before);

  return {
    oriented: true,
    position: sel.position.toArray(),
    normal: frame.z.toArray(),
    uv: [u, v],
  };
}

// ── SdProject ─────────────────────────────────────────────────────────────────
// oracle: closed-form plane projection P' = P - (P·n - d)*n

export function handle_SdProject(
  args: Record<string, unknown>,
  viewer: Viewer,
): Record<string, unknown> {
  const sel = resolveTarget(viewer, args);
  if (!sel) return { error: "SdProject — no target" };
  if (!(sel instanceof THREE.Mesh)) return { error: "SdProject — target must be a Mesh" };

  const normalRaw = pt3(args.normal ?? args.plane_normal, [0, 0, 1]);
  const n = normalRaw.clone().normalize();
  if (n.lengthSq() < 1e-10) return { error: "SdProject — normal must be non-zero" };

  const originPt = pt3(args.origin ?? args.plane_origin, [0, 0, 0]);
  const d = n.dot(originPt); // plane distance from world origin

  const result = cloneMesh(sel);
  deformGeometry(result.geometry, (v) => {
    const dist = v.dot(n) - d;
    return v.clone().addScaledVector(n, -dist);
  });
  result.userData.kind = "brep";
  result.userData.creator = "SdProject";
  result.userData.dispatchArgs = args;
  viewer.addMesh(result, "brep");
  return { created: result.uuid, projectedOnto: "plane", normal: n.toArray(), origin: originPt.toArray() };
}

// ── SdPlanarFlow ──────────────────────────────────────────────────────────────
// oracle: closed-form UV mapping from source plane to target plane.
// Maps each vertex from source plane coordinates to target plane coordinates.

export function handle_SdPlanarFlow(
  args: Record<string, unknown>,
  viewer: Viewer,
): Record<string, unknown> {
  const sel = resolveTarget(viewer, args);
  if (!sel) return { error: "SdPlanarFlow — no target" };
  if (!(sel instanceof THREE.Mesh)) return { error: "SdPlanarFlow — target must be a Mesh" };

  // Source plane: origin + xAxis + yAxis
  const srcOrigin = pt3(args.src_origin ?? args.source_origin, [0, 0, 0]);
  const srcX = pt3(args.src_x ?? args.source_x, [1, 0, 0]).normalize();
  const srcY = pt3(args.src_y ?? args.source_y, [0, 1, 0]).normalize();

  // Target plane
  const dstOrigin = pt3(args.dst_origin ?? args.target_origin, [0, 0, 0]);
  const dstX = pt3(args.dst_x ?? args.target_x, [1, 0, 0]).normalize();
  const dstY = pt3(args.dst_y ?? args.target_y, [0, 1, 0]).normalize();

  // Validate axes are roughly unit-length
  if (srcX.lengthSq() < 1e-10 || srcY.lengthSq() < 1e-10) return { error: "SdPlanarFlow — source axes must be non-zero" };
  if (dstX.lengthSq() < 1e-10 || dstY.lengthSq() < 1e-10) return { error: "SdPlanarFlow — target axes must be non-zero" };

  const result = cloneMesh(sel);
  deformGeometry(result.geometry, (v) => {
    // Project vertex into source plane UV
    const rel = v.clone().sub(srcOrigin);
    const u = rel.dot(srcX);
    const vCoord = rel.dot(srcY);
    // Map UV to target plane
    return dstOrigin.clone()
      .addScaledVector(dstX, u)
      .addScaledVector(dstY, vCoord);
  });
  result.userData.kind = "brep";
  result.userData.creator = "SdPlanarFlow";
  result.userData.dispatchArgs = args;
  viewer.addMesh(result, "brep");
  return {
    created: result.uuid,
    srcOrigin: srcOrigin.toArray(),
    dstOrigin: dstOrigin.toArray(),
  };
}

// ── SdTwist ───────────────────────────────────────────────────────────────────
// oracle: closed-form twist — angle proportional to position along axis.
// P' = rotate(P - axis_pt, axis_dir, angle * (P·axis_hat - axis_min) / axisLen) + axis_pt

export function handle_SdTwist(
  args: Record<string, unknown>,
  viewer: Viewer,
): Record<string, unknown> {
  const sel = resolveTarget(viewer, args);
  if (!sel) return { error: "SdTwist — no target" };
  if (!(sel instanceof THREE.Mesh)) return { error: "SdTwist — target must be a Mesh" };

  const axisDir = pt3(args.axis ?? args.direction, [0, 0, 1]).normalize();
  if (axisDir.lengthSq() < 1e-10) return { error: "SdTwist — axis must be non-zero" };

  const axisOrigin = pt3(args.axis_origin ?? args.origin, [0, 0, 0]);
  const angleDeg = typeof args.angle === "number" ? args.angle : 90;
  const angleRad = (angleDeg * Math.PI) / 180;

  // Get bounding extent along twist axis
  sel.updateMatrixWorld(true);
  const bbox = localBbox(sel.geometry);
  // Project bbox corners along axisDir to find min/max
  const corners = [bbox.min, bbox.max];
  const axisProjs = corners.map((c) => c.dot(axisDir));
  const axisMin = Math.min(...axisProjs);
  const axisMax = Math.max(...axisProjs);
  const axisLen = axisMax - axisMin;
  if (axisLen < 1e-10) return { error: "SdTwist — object has zero extent along twist axis" };

  const result = cloneMesh(sel);
  deformGeometry(result.geometry, (v) => {
    // Project v onto axis to find t in [0, 1]
    const projDist = v.dot(axisDir) - axisMin;
    const t = projDist / axisLen;
    const localAngle = angleRad * t;

    // Compute rotation around axis through axisOrigin
    const relToOrigin = v.clone().sub(axisOrigin);
    // Component along axis
    const axialComp = relToOrigin.clone().projectOnVector(axisDir);
    // Component perpendicular to axis
    const perpComp = relToOrigin.clone().sub(axialComp);
    // Rotate perpendicular component
    const cosA = Math.cos(localAngle);
    const sinA = Math.sin(localAngle);
    const cross = axisDir.clone().cross(perpComp);
    const rotPerp = perpComp.clone().multiplyScalar(cosA).addScaledVector(cross, sinA);
    return axisOrigin.clone().add(axialComp).add(rotPerp);
  });
  result.userData.kind = "brep";
  result.userData.creator = "SdTwist";
  result.userData.dispatchArgs = args;
  viewer.addMesh(result, "brep");
  return {
    created: result.uuid,
    angle: angleDeg,
    axis: axisDir.toArray(),
    axisOrigin: axisOrigin.toArray(),
  };
}

// ── SdTaper ───────────────────────────────────────────────────────────────────
// oracle: closed-form taper — scale XY linearly from startFactor to endFactor
//         as function of Z (or arbitrary axis).
//
// For a vertex at parameter t in [0,1] along the taper axis:
//   scale factor s(t) = startFactor + (endFactor - startFactor) * t
//   P'_perp = P_perp * s(t)

export function handle_SdTaper(
  args: Record<string, unknown>,
  viewer: Viewer,
): Record<string, unknown> {
  const sel = resolveTarget(viewer, args);
  if (!sel) return { error: "SdTaper — no target" };
  if (!(sel instanceof THREE.Mesh)) return { error: "SdTaper — target must be a Mesh" };

  const axisDir = pt3(args.axis ?? args.direction, [0, 0, 1]).normalize();
  if (axisDir.lengthSq() < 1e-10) return { error: "SdTaper — axis must be non-zero" };

  const axisOrigin = pt3(args.axis_origin ?? args.origin, [0, 0, 0]);
  const startFactor = typeof args.start_factor === "number" ? args.start_factor : 1.0;
  const endFactor = typeof args.end_factor === "number" ? args.end_factor
    : typeof args.factor === "number" ? args.factor : 0.5;

  if (endFactor <= 0 || startFactor <= 0) return { error: "SdTaper — scale factors must be positive" };

  // Get extent along taper axis
  const bbox = localBbox(sel.geometry);
  const corners = [bbox.min, bbox.max];
  const axisProjs = corners.map((c) => c.dot(axisDir));
  const axisMin = Math.min(...axisProjs);
  const axisMax = Math.max(...axisProjs);
  const axisLen = axisMax - axisMin;
  if (axisLen < 1e-10) return { error: "SdTaper — object has zero extent along taper axis" };

  const result = cloneMesh(sel);
  deformGeometry(result.geometry, (v) => {
    const projDist = v.dot(axisDir) - axisMin;
    const t = projDist / axisLen;
    const scaleFactor = startFactor + (endFactor - startFactor) * t;

    const relToOrigin = v.clone().sub(axisOrigin);
    const axialComp = relToOrigin.clone().projectOnVector(axisDir);
    const perpComp = relToOrigin.clone().sub(axialComp);
    // Scale perpendicular component
    const scaledPerp = perpComp.clone().multiplyScalar(scaleFactor);
    return axisOrigin.clone().add(axialComp).add(scaledPerp);
  });
  result.userData.kind = "brep";
  result.userData.creator = "SdTaper";
  result.userData.dispatchArgs = args;
  viewer.addMesh(result, "brep");
  return {
    created: result.uuid,
    startFactor,
    endFactor,
    axis: axisDir.toArray(),
  };
}

// ── SdBend ────────────────────────────────────────────────────────────────────
// oracle: closed-form bend — deform along bend plane using cylindrical mapping.
// Bends the geometry around a spine axis by mapping linear extent to arc.
//
// Given bend angle α and bend radius R = len / α:
//   A point at distance x from spine maps to angle θ = x / R radians.
//   P'_in_plane = (R + perp) * [cos θ, sin θ], axial stays fixed.

export function handle_SdBend(
  args: Record<string, unknown>,
  viewer: Viewer,
): Record<string, unknown> {
  const sel = resolveTarget(viewer, args);
  if (!sel) return { error: "SdBend — no target" };
  if (!(sel instanceof THREE.Mesh)) return { error: "SdBend — target must be a Mesh" };

  // Bend axis = the axis the object bends "around" (spine of the bend)
  const bendAxisDir = pt3(args.axis ?? args.bend_axis, [0, 1, 0]).normalize();
  if (bendAxisDir.lengthSq() < 1e-10) return { error: "SdBend — bend axis must be non-zero" };

  // Bend plane normal = direction of bending (perpendicular to bend axis in bend plane)
  const bendDirRaw = pt3(args.direction ?? args.bend_direction, [1, 0, 0]);
  // Orthogonalize bend direction to axis
  const bendDir = bendDirRaw.clone()
    .addScaledVector(bendAxisDir, -bendDirRaw.dot(bendAxisDir))
    .normalize();
  if (bendDir.lengthSq() < 1e-10) return { error: "SdBend — bend direction must not be parallel to bend axis" };

  const bendOrigin = pt3(args.origin ?? args.bend_origin, [0, 0, 0]);
  const angleDeg = typeof args.angle === "number" ? args.angle : 90;
  const angleRad = (angleDeg * Math.PI) / 180;

  // Get extent along bend direction
  const bbox = localBbox(sel.geometry);
  const corners = [bbox.min, bbox.max];
  const bendProjs = corners.map((c) => c.dot(bendDir));
  const bendMin = Math.min(...bendProjs);
  const bendMax = Math.max(...bendProjs);
  const bendLen = bendMax - bendMin;
  if (bendLen < 1e-10) return { error: "SdBend — object has zero extent along bend direction" };

  const bendRadius = Math.abs(angleRad) > 1e-10 ? bendLen / Math.abs(angleRad) : 1e6;
  // Perpendicular to both axes = the "outward" direction of the cylinder
  const outDir = bendDir.clone().cross(bendAxisDir).normalize();

  const result = cloneMesh(sel);
  deformGeometry(result.geometry, (v) => {
    const rel = v.clone().sub(bendOrigin);

    // Decompose into: along bendDir, along bendAxisDir, along outDir
    const alongBend = rel.dot(bendDir);
    const alongAxis = rel.dot(bendAxisDir);
    const alongOut = rel.dot(outDir);

    // Map alongBend to arc angle
    const t = (alongBend - bendMin) / bendLen;
    const theta = t * angleRad;

    // New radial distance = bendRadius + alongOut
    const r = bendRadius + alongOut;

    // Position on arc: center of arc is at bendOrigin + bendRadius * (-outDir)
    // (bend inward when bendRadius > 0)
    const arcCenter = bendOrigin.clone().addScaledVector(outDir, -bendRadius);

    // Point on arc
    const arcPoint = arcCenter.clone()
      .addScaledVector(outDir, r * Math.cos(theta))
      .addScaledVector(bendDir, r * Math.sin(theta));

    // Add axial component
    arcPoint.addScaledVector(bendAxisDir, alongAxis);
    return arcPoint;
  });
  result.userData.kind = "brep";
  result.userData.creator = "SdBend";
  result.userData.dispatchArgs = args;
  viewer.addMesh(result, "brep");
  return {
    created: result.uuid,
    angle: angleDeg,
    bendRadius,
    bendAxis: bendAxisDir.toArray(),
  };
}

// ── C++-blocked stub handlers ─────────────────────────────────────────────────

// kern_flow_along_curve: requires sweep + frame interpolation along arbitrary NURBS curve.
// C++ signature: kern_flow_along_curve(src: BRep, rail: NurbsCurve, align: AlignMode) -> BRep
export function handle_SdFlowAlongCurve(
  _args: Record<string, unknown>,
  _viewer: Viewer,
): Record<string, unknown> {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires general sweep + frame interpolation along arbitrary NURBS rail in kern.wasm (kern_flow_along_curve). kern Phase D needed.",
  };
}

// kern_flow_along_surface: UV-space surface morph mapping source base plane to target surface.
// C++ signature: kern_flow_along_surface(src: BRep, basePlane: Plane, targetSurf: NurbsSurface) -> BRep
export function handle_SdFlowAlongSurface(
  _args: Record<string, unknown>,
  _viewer: Viewer,
): Record<string, unknown> {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires surface UV-pullback morphing in kern.wasm (kern_flow_along_surface). kern Phase D needed.",
  };
}

// kern_cage_morph: free-form deformation via trilinear cage interpolation.
// C++ signature: kern_cage_morph(src: BRep, cage: Box<Point3[3][3][3]>, deformed: Box<Point3[3][3][3]>) -> BRep
export function handle_SdCageMorph(
  _args: Record<string, unknown>,
  _viewer: Viewer,
): Record<string, unknown> {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires trilinear cage interpolation in kern.wasm (kern_cage_morph). kern Phase D needed.",
  };
}

// kern_sporph: surface morphing — maps geometry from one surface to another via UV-UV correspondence.
// C++ signature: kern_sporph(src: BRep, srcSurf: NurbsSurface, dstSurf: NurbsSurface) -> BRep
export function handle_SdSporph(
  _args: Record<string, unknown>,
  _viewer: Viewer,
): Record<string, unknown> {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires surface-to-surface UV morphing in kern.wasm (kern_sporph). kern Phase D needed.",
  };
}

// kern_splop: surface placement — distributes geometry instances across a surface at UV grid.
// C++ signature: kern_splop(src: BRep, surface: NurbsSurface, uCount: int, vCount: int, align: AlignMode) -> BRep[]
export function handle_SdSplop(
  _args: Record<string, unknown>,
  _viewer: Viewer,
): Record<string, unknown> {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires surface UV grid instance placement in kern.wasm (kern_splop). kern Phase D needed.",
  };
}

// kern_maelstrom: spiral/vortex deformation along an axis with radial falloff.
// C++ signature: kern_maelstrom(src: BRep, axis: Line, angle: double, falloffRadius: double) -> BRep
export function handle_SdMaelstrom(
  _args: Record<string, unknown>,
  _viewer: Viewer,
): Record<string, unknown> {
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires radial-falloff spiral deformation in kern.wasm (kern_maelstrom). kern Phase D needed.",
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerS330Handlers(viewer: Viewer): void {
  registerHandler("SdOrient3Point", (args) => handle_SdOrient3Point(args, viewer));
  registerHandler("SdOrientOnSurface", (args) => handle_SdOrientOnSurface(args, viewer));
  registerHandler("SdProject", (args) => handle_SdProject(args, viewer));
  registerHandler("SdPlanarFlow", (args) => handle_SdPlanarFlow(args, viewer));
  registerHandler("SdTwist", (args) => handle_SdTwist(args, viewer));
  registerHandler("SdTaper", (args) => handle_SdTaper(args, viewer));
  registerHandler("SdBend", (args) => handle_SdBend(args, viewer));

  // C++-blocked stubs
  registerHandler("SdFlowAlongCurve", (args) => handle_SdFlowAlongCurve(args, viewer));
  registerHandler("SdFlowAlongSurface", (args) => handle_SdFlowAlongSurface(args, viewer));
  registerHandler("SdCageMorph", (args) => handle_SdCageMorph(args, viewer));
  registerHandler("SdSporph", (args) => handle_SdSporph(args, viewer));
  registerHandler("SdSplop", (args) => handle_SdSplop(args, viewer));
  registerHandler("SdMaelstrom", (args) => handle_SdMaelstrom(args, viewer));
}
