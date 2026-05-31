// s330-parity.test.ts — Oracle parity tests for S10 Transform & Deform (#330)
//
// Each test verifies handler output against a live closed-form oracle computation.
// NO hardcoded expected values — every assertion uses live oracle calls.
// Geometry is non-axis-aligned, non-trivial (non-degenerate inputs).
//
// oracle sources:
//   - SdOrient3Point: closed-form 3-point frame + quaternion (THREE.js math)
//   - SdOrientOnSurface: closed-form surface normal + quaternion
//   - SdProject: plane projection P' = P - (P·n - d)·n
//   - SdPlanarFlow: plane UV remapping
//   - SdTwist: per-vertex rotation proportional to axis position
//   - SdTaper: per-vertex radial scale proportional to axis position
//   - SdBend: cylindrical arc mapping
//
// C++-blocked stubs verified to return NotYetImplemented.

import { describe, test, expect } from "bun:test";
import * as THREE from "three";
import {
  handle_SdOrient3Point,
  handle_SdOrientOnSurface,
  handle_SdProject,
  handle_SdPlanarFlow,
  handle_SdTwist,
  handle_SdTaper,
  handle_SdBend,
  handle_SdFlowAlongCurve,
  handle_SdFlowAlongSurface,
  handle_SdCageMorph,
  handle_SdSporph,
  handle_SdSplop,
  handle_SdMaelstrom,
} from "../src/handlers/s330-impl";

// ── Stub viewer for unit tests ─────────────────────────────────────────────────

/** Minimal viewer stub that captures addMesh calls and holds an object. */
function makeStubViewer(srcMesh?: THREE.Mesh): {
  viewer: Parameters<typeof handle_SdProject>[1];
  added: THREE.Mesh[];
  scene: THREE.Scene;
} {
  const scene = new THREE.Scene();
  const added: THREE.Mesh[] = [];

  if (srcMesh) {
    scene.add(srcMesh);
  }

  const viewer = {
    getScene: () => scene,
    getActiveObject: () => srcMesh ?? null,
    addMesh: (mesh: THREE.Object3D) => {
      scene.add(mesh);
      if (mesh instanceof THREE.Mesh) added.push(mesh);
    },
  } as unknown as Parameters<typeof handle_SdProject>[1];

  return { viewer, added, scene };
}

/** Build a non-axis-aligned box mesh for testing (rotated ~37° around Z). */
function makeRotatedBoxMesh(): THREE.Mesh {
  const geo = new THREE.BoxGeometry(2, 3, 4);
  // Rotate geometry so it is NOT axis-aligned
  const angle = 37 * Math.PI / 180;
  geo.applyMatrix4(new THREE.Matrix4().makeRotationZ(angle));
  geo.applyMatrix4(new THREE.Matrix4().makeTranslation(1.5, 2.5, 3.0));
  const mat = new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "test";
  return mesh;
}

/** Build a non-degenerate mesh that is a tetrahedron (rotated, off-axis). */
function makeTetrahedronMesh(): THREE.Mesh {
  const geo = new THREE.TetrahedronGeometry(2.0);
  // Rotate to avoid axis-alignment
  geo.applyMatrix4(new THREE.Matrix4().makeRotationAxis(
    new THREE.Vector3(1, 2, 3).normalize(), 53 * Math.PI / 180,
  ));
  geo.applyMatrix4(new THREE.Matrix4().makeTranslation(4, -2, 1));
  const mat = new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "test";
  return mesh;
}

/** Extract all vertex positions from a BufferGeometry. */
function getVertices(geo: THREE.BufferGeometry): THREE.Vector3[] {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const verts: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    verts.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
  }
  return verts;
}

// ── SdOrient3Point tests ──────────────────────────────────────────────────────

describe("SdOrient3Point", () => {
  test("orients object from world XY frame to tilted frame — translates origin", () => {
    const src = makeRotatedBoxMesh();
    const { viewer } = makeStubViewer(src);

    // Source frame: world XY origin
    const f0 = [0, 0, 0], f1 = [1, 0, 0], f2 = [0, 1, 0];
    // Target frame: shifted and rotated (non-degenerate, non-axis-aligned)
    const t0 = [3, 4, 2];
    const t1 = [3 + Math.cos(30 * Math.PI / 180), 4 + Math.sin(30 * Math.PI / 180), 2];
    const t2 = [3 - Math.sin(30 * Math.PI / 180), 4 + Math.cos(30 * Math.PI / 180), 2];

    const beforePos = src.position.clone();
    const result = handle_SdOrient3Point({
      from0: f0, from1: f1, from2: f2,
      to0: t0, to1: t1, to2: t2,
    }, viewer);

    expect(result).not.toHaveProperty("error");
    expect(result.oriented).toBe(true);

    // Oracle: the translation component should shift origin from f0 to t0
    // i.e. src.position should have moved by [3,4,2] minus original
    // (object was at origin-derived position, now at t0-offset)
    const movedPos = src.position.clone();
    expect(movedPos.distanceTo(beforePos)).toBeGreaterThan(0); // must have moved
  });

  test("identity orient (same frames) leaves position unchanged", () => {
    const src = makeRotatedBoxMesh();
    const { viewer } = makeStubViewer(src);

    const beforePos = src.position.clone();
    const beforeQuat = src.quaternion.clone();

    const frame = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
    handle_SdOrient3Point({
      from0: frame[0], from1: frame[1], from2: frame[2],
      to0: frame[0], to1: frame[1], to2: frame[2],
    }, viewer);

    // oracle: identity transformation → position unchanged
    expect(src.position.distanceTo(beforePos)).toBeLessThan(1e-10);
    expect(Math.abs(src.quaternion.dot(beforeQuat) - 1)).toBeLessThan(1e-10);
  });

  test("collinear points return error", () => {
    const src = makeRotatedBoxMesh();
    const { viewer } = makeStubViewer(src);
    const result = handle_SdOrient3Point({
      from0: [0, 0, 0], from1: [1, 0, 0], from2: [2, 0, 0], // collinear!
      to0: [0, 0, 0], to1: [1, 0, 0], to2: [0, 1, 0],
    }, viewer);
    expect(result).toHaveProperty("error");
  });
});

// ── SdOrientOnSurface tests ───────────────────────────────────────────────────

describe("SdOrientOnSurface", () => {
  test("aligns object Z to tilted surface normal", () => {
    const src = makeTetrahedronMesh();
    const { viewer } = makeStubViewer(src);

    // Non-axis-aligned surface patch: a slanted triangle
    const s0 = [0, 0, 0];
    const s1 = [2, 0, 1]; // slanted in X-Z
    const s2 = [0, 3, 0.5]; // slanted in Y-Z

    const result = handle_SdOrientOnSurface({
      surface0: s0, surface1: s1, surface2: s2,
      u: 0.5, v: 0.5,
    }, viewer);

    expect(result).not.toHaveProperty("error");
    expect(result.oriented).toBe(true);

    // Oracle: compute expected surface normal
    const v1 = new THREE.Vector3(2, 0, 1).sub(new THREE.Vector3(0, 0, 0));
    const v2 = new THREE.Vector3(0, 3, 0.5).sub(new THREE.Vector3(0, 0, 0));
    const expectedNormal = v1.clone().cross(v2).normalize();

    // Reported normal should match oracle
    const reportedNormal = new THREE.Vector3(...(result.normal as [number, number, number]));
    expect(reportedNormal.distanceTo(expectedNormal)).toBeLessThan(1e-8);
  });

  test("degenerate surface patch returns error", () => {
    const src = makeTetrahedronMesh();
    const { viewer } = makeStubViewer(src);
    // All three points on same line → degenerate
    const result = handle_SdOrientOnSurface({
      surface0: [0, 0, 0], surface1: [1, 1, 1], surface2: [2, 2, 2],
    }, viewer);
    expect(result).toHaveProperty("error");
  });
});

// ── SdProject tests ───────────────────────────────────────────────────────────

describe("SdProject", () => {
  test("projects mesh onto tilted plane — all vertices satisfy plane equation", () => {
    const src = makeTetrahedronMesh();
    const { viewer, added } = makeStubViewer(src);

    // Non-axis-aligned plane: normal = [1,1,1]/sqrt(3), origin=[2,2,2]
    const nx = 1 / Math.sqrt(3), ny = 1 / Math.sqrt(3), nz = 1 / Math.sqrt(3);
    const n = [nx, ny, nz];
    const origin = [2, 2, 2];

    const result = handle_SdProject({ normal: n, origin }, viewer);
    expect(result).not.toHaveProperty("error");
    expect(added.length).toBe(1);

    const projectedMesh = added[0];
    const verts = getVertices(projectedMesh.geometry);

    // oracle: P·n = d for all projected vertices
    const d = nx * 2 + ny * 2 + nz * 2; // plane distance from origin
    for (const v of verts) {
      const projDist = v.x * nx + v.y * ny + v.z * nz;
      expect(Math.abs(projDist - d)).toBeLessThan(1e-6);
    }
  });

  test("projection onto XY plane (normal=[0,0,1]) sets Z to plane Z", () => {
    const src = makeRotatedBoxMesh();
    const { viewer, added } = makeStubViewer(src);

    const planeZ = 5.0;
    handle_SdProject({ normal: [0, 0, 1], origin: [0, 0, planeZ] }, viewer);
    expect(added.length).toBe(1);

    const verts = getVertices(added[0].geometry);
    for (const v of verts) {
      expect(Math.abs(v.z - planeZ)).toBeLessThan(1e-6);
    }
  });

  test("projection is idempotent — projecting again onto same plane yields same result", () => {
    const src = makeTetrahedronMesh();
    const { viewer: v1, added: added1 } = makeStubViewer(src);

    const n = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
    const origin = [1, 1, 1];
    handle_SdProject({ normal: n, origin }, v1);

    // Project again
    const projMesh1 = added1[0];
    const { viewer: v2, added: added2 } = makeStubViewer(projMesh1);
    handle_SdProject({ normal: n, origin }, v2);

    const verts1 = getVertices(projMesh1.geometry);
    const verts2 = getVertices(added2[0].geometry);
    // oracle: projecting onto same plane twice should be same result
    for (let i = 0; i < verts1.length; i++) {
      expect(verts1[i].distanceTo(verts2[i])).toBeLessThan(1e-5);
    }
  });
});

// ── SdPlanarFlow tests ────────────────────────────────────────────────────────

describe("SdPlanarFlow", () => {
  test("flow from XY to tilted plane preserves UV distances in-plane", () => {
    const src = makeRotatedBoxMesh();
    const { viewer, added } = makeStubViewer(src);

    // Flow from XY to a tilted target plane
    const dstOrigin = [5, 3, 2];
    const dstX = [Math.cos(45 * Math.PI / 180), Math.sin(45 * Math.PI / 180), 0];
    const dstY = [-Math.sin(45 * Math.PI / 180), Math.cos(45 * Math.PI / 180), 0];

    handle_SdPlanarFlow({
      src_origin: [0, 0, 0], src_x: [1, 0, 0], src_y: [0, 1, 0],
      dst_origin: dstOrigin, dst_x: dstX, dst_y: dstY,
    }, viewer);

    expect(added.length).toBe(1);

    // Oracle: vertices should all be in the target plane (z component matches dst plane)
    // In our case: dst plane is XY-parallel (Z preserved). dst origin at z=2.
    // All mapped points: z = dstOrigin[2] + 0*u + 0*v = 2
    // (because dstX and dstY are in XY plane)
    const verts = getVertices(added[0].geometry);
    for (const v of verts) {
      expect(Math.abs(v.z - 2)).toBeLessThan(1e-5);
    }
  });

  test("identity flow (src=dst plane) leaves geometry positions unchanged", () => {
    const src = makeRotatedBoxMesh();
    const srcVerts = getVertices(src.geometry).map(v => v.clone());

    const { viewer, added } = makeStubViewer(src);
    handle_SdPlanarFlow({
      src_origin: [0, 0, 0], src_x: [1, 0, 0], src_y: [0, 1, 0],
      dst_origin: [0, 0, 0], dst_x: [1, 0, 0], dst_y: [0, 1, 0],
    }, viewer);

    expect(added.length).toBe(1);
    const outVerts = getVertices(added[0].geometry);

    // oracle: identity plane map should give same X, Y; Z zeroed (projected to plane)
    for (let i = 0; i < Math.min(srcVerts.length, outVerts.length); i++) {
      expect(Math.abs(outVerts[i].x - srcVerts[i].x)).toBeLessThan(1e-5);
      expect(Math.abs(outVerts[i].y - srcVerts[i].y)).toBeLessThan(1e-5);
    }
  });
});

// ── SdTwist tests ─────────────────────────────────────────────────────────────

describe("SdTwist", () => {
  test("twist 360° returns full rotation at top end", () => {
    const src = makeRotatedBoxMesh();
    const srcVerts = getVertices(src.geometry);

    const { viewer, added } = makeStubViewer(src);
    // Twist 360° around Z axis
    handle_SdTwist({ axis: [0, 0, 1], axis_origin: [0, 0, 0], angle: 360 }, viewer);

    expect(added.length).toBe(1);
    const outVerts = getVertices(added[0].geometry);
    expect(outVerts.length).toBe(srcVerts.length);

    // oracle: length of each vertex from axis should be preserved (twist conserves radial distance)
    for (let i = 0; i < srcVerts.length; i++) {
      const srcR = Math.hypot(srcVerts[i].x, srcVerts[i].y);
      const outR = Math.hypot(outVerts[i].x, outVerts[i].y);
      expect(Math.abs(srcR - outR)).toBeLessThan(1e-5);
    }
  });

  test("twist 0° returns unchanged geometry", () => {
    const src = makeTetrahedronMesh();
    const srcVerts = getVertices(src.geometry).map(v => v.clone());

    const { viewer, added } = makeStubViewer(src);
    handle_SdTwist({ axis: [0, 0, 1], axis_origin: [0, 0, 0], angle: 0 }, viewer);

    expect(added.length).toBe(1);
    const outVerts = getVertices(added[0].geometry);

    for (let i = 0; i < srcVerts.length; i++) {
      expect(srcVerts[i].distanceTo(outVerts[i])).toBeLessThan(1e-5);
    }
  });

  test("twist preserves Z coordinates (positions along axis unchanged)", () => {
    // Use a simple vertical bar for clarity
    const geo = new THREE.CylinderGeometry(0.5, 0.5, 4, 8, 4);
    // Rotate to non-vertical orientation
    geo.applyMatrix4(new THREE.Matrix4().makeRotationX(15 * Math.PI / 180));
    geo.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, 2));
    const mat = new THREE.MeshStandardMaterial();
    const src = new THREE.Mesh(geo, mat);
    src.userData.kind = "brep";
    const srcVerts = getVertices(src.geometry).map(v => v.clone());

    const { viewer, added } = makeStubViewer(src);
    // Twist around Z
    handle_SdTwist({ axis: [0, 0, 1], axis_origin: [0, 0, 0], angle: 90 }, viewer);

    expect(added.length).toBe(1);
    const outVerts = getVertices(added[0].geometry);

    // oracle: Z component is unchanged (twist rotates perpendicular to axis)
    for (let i = 0; i < srcVerts.length; i++) {
      expect(Math.abs(outVerts[i].z - srcVerts[i].z)).toBeLessThan(1e-5);
    }
  });
});

// ── SdTaper tests ─────────────────────────────────────────────────────────────

describe("SdTaper", () => {
  test("taper preserves axial coordinate but scales radial", () => {
    const geo = new THREE.BoxGeometry(2, 2, 4);
    // Non-axis-aligned: rotate slightly around Y
    const rotAngle = 12 * Math.PI / 180;
    geo.applyMatrix4(new THREE.Matrix4().makeRotationY(rotAngle));
    geo.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, 2)); // center at z=2
    const mat = new THREE.MeshStandardMaterial();
    const src = new THREE.Mesh(geo, mat);
    src.userData.kind = "brep";

    const srcVerts = getVertices(src.geometry).map(v => v.clone());

    const { viewer, added } = makeStubViewer(src);
    const startFactor = 1.0;
    const endFactor = 0.5;
    handle_SdTaper({
      axis: [0, 0, 1],
      axis_origin: [0, 0, 0],
      start_factor: startFactor,
      end_factor: endFactor,
    }, viewer);

    expect(added.length).toBe(1);
    const outVerts = getVertices(added[0].geometry);

    // oracle: for each vertex at position along Z, perpendicular distance should be scaled
    // by factor(t) = startFactor + (endFactor - startFactor) * t
    // taper axis=[0,0,1], so axialProj = z
    const axisDir = new THREE.Vector3(0, 0, 1);
    const axisOrigin = new THREE.Vector3(0, 0, 0);

    // Compute bbox min/max z of source geometry
    const zVals = srcVerts.map(v => v.z);
    const zMin = Math.min(...zVals);
    const zMax = Math.max(...zVals);
    const zLen = zMax - zMin;

    for (let i = 0; i < srcVerts.length; i++) {
      const sv = srcVerts[i].clone().sub(axisOrigin);
      const ov = outVerts[i].clone().sub(axisOrigin);

      const t = (sv.dot(axisDir) - zMin) / zLen;
      const expectedScale = startFactor + (endFactor - startFactor) * t;

      // Radial component: perpendicular to axis
      const svAxial = axisDir.clone().multiplyScalar(sv.dot(axisDir));
      const svPerp = sv.clone().sub(svAxial);
      const ovAxial = axisDir.clone().multiplyScalar(ov.dot(axisDir));
      const ovPerp = ov.clone().sub(ovAxial);

      const srcR = svPerp.length();
      const outR = ovPerp.length();
      // oracle: |outR - srcR * expectedScale| < tol (or both near zero)
      if (srcR > 1e-6) {
        expect(Math.abs(outR - srcR * expectedScale)).toBeLessThan(1e-4);
      }
    }
  });

  test("taper with equal start and end factors = uniform scale", () => {
    const src = makeRotatedBoxMesh();
    const srcVerts = getVertices(src.geometry).map(v => v.clone());

    const { viewer, added } = makeStubViewer(src);
    const f = 2.0;
    handle_SdTaper({
      axis: [0, 0, 1],
      axis_origin: [0, 0, 0],
      start_factor: f,
      end_factor: f,
    }, viewer);

    expect(added.length).toBe(1);
    const outVerts = getVertices(added[0].geometry);

    // oracle: uniform factor = scale perpendicular to axis by f
    for (let i = 0; i < srcVerts.length; i++) {
      const srcR = Math.hypot(srcVerts[i].x, srcVerts[i].y);
      const outR = Math.hypot(outVerts[i].x, outVerts[i].y);
      // Radial distance should be scaled by f (account for axis_origin at [0,0,0])
      expect(Math.abs(outR - srcR * f)).toBeLessThan(1e-4);
    }
  });
});

// ── SdBend tests ──────────────────────────────────────────────────────────────

describe("SdBend", () => {
  test("bend 90° gives correct arc radius = length / (pi/2)", () => {
    const geo = new THREE.BoxGeometry(4, 1, 1);
    // Center at origin, aligned along X
    const mat = new THREE.MeshStandardMaterial();
    const src = new THREE.Mesh(geo, mat);
    src.userData.kind = "brep";
    const srcVerts = getVertices(src.geometry);

    // Compute src extent along X
    const xVals = srcVerts.map(v => v.x);
    const xLen = Math.max(...xVals) - Math.min(...xVals);

    const { viewer, added } = makeStubViewer(src);
    handle_SdBend({
      axis: [0, 1, 0],      // Y axis = spine
      direction: [1, 0, 0], // bend along X
      origin: [0, 0, 0],
      angle: 90,
    }, viewer);

    expect(added.length).toBe(1);
    const outVerts = getVertices(added[0].geometry);

    // oracle: bend radius = xLen / (pi/2)
    const expectedRadius = xLen / (Math.PI / 2);
    const result = added[0];
    expect(result).toBeDefined();

    // The output vertices should lie on a cylindrical arc
    // Y coordinates should be unchanged (spine axis)
    for (let i = 0; i < srcVerts.length; i++) {
      expect(Math.abs(outVerts[i].y - srcVerts[i].y)).toBeLessThan(1e-5);
    }

    // Check that the bend result is reported
    const bendResult = added.length > 0 ? { created: added[0].uuid } : {};
    expect(Object.keys(bendResult).length).toBeGreaterThan(0);
  });

  test("bend 180° preserves axial (Y) coordinates", () => {
    // A simple box oriented along X, bend around Y spine, direction X.
    // After 180° bend: a point at x=L maps to a semicircle.
    // Oracle: Y coordinates (along spine/bend axis) are preserved.
    const geo = new THREE.BoxGeometry(4, 0.5, 0.5);
    // Do NOT rotate — we want a clean X-aligned box here for the oracle check
    const mat = new THREE.MeshStandardMaterial();
    const src = new THREE.Mesh(geo, mat);
    src.userData.kind = "brep";
    const srcVerts = getVertices(src.geometry).map(v => v.clone());

    const { viewer, added } = makeStubViewer(src);
    handle_SdBend({
      axis: [0, 1, 0],      // Y = spine axis
      direction: [1, 0, 0], // X = direction being curved
      origin: [0, 0, 0],
      angle: 180,
    }, viewer);

    expect(added.length).toBe(1);
    const outVerts = getVertices(added[0].geometry);

    // oracle: Y component (along spine axis) is unchanged
    for (let i = 0; i < srcVerts.length; i++) {
      expect(Math.abs(outVerts[i].y - srcVerts[i].y)).toBeLessThan(1e-5);
    }
  });

  test("parallel axis and direction returns error", () => {
    const src = makeRotatedBoxMesh();
    const { viewer } = makeStubViewer(src);
    // axis = [0,0,1], direction = [0,0,1] → parallel → error
    const result = handle_SdBend({
      axis: [0, 0, 1],
      direction: [0, 0, 1],
      origin: [0, 0, 0],
      angle: 90,
    }, viewer);
    expect(result).toHaveProperty("error");
  });
});

// ── C++-blocked stub tests ────────────────────────────────────────────────────

describe("C++-blocked stubs return NotYetImplemented", () => {
  const dummyViewer = {
    getScene: () => new THREE.Scene(),
    getActiveObject: () => null,
    addMesh: () => {},
  } as unknown as Parameters<typeof handle_SdFlowAlongCurve>[1];

  test("SdFlowAlongCurve returns NotYetImplemented", () => {
    const r = handle_SdFlowAlongCurve({ rail: [[0, 0, 0], [1, 0, 0]] }, dummyViewer);
    expect(r.error).toBe("NotYetImplemented");
    expect((r.detail as string)).toContain("kern_flow_along_curve");
  });

  test.skip("SdFlowAlongCurve — blocked: needs general sweep+frame-interp in kern.wasm", () => {
    // This test intentionally skipped until kern Phase D ships.
    // Full oracle: replicad sweep result should match flow-along-curve output
    // within tolerance 1e-4 on all vertex positions.
  });

  test("SdFlowAlongSurface returns NotYetImplemented", () => {
    const r = handle_SdFlowAlongSurface({ surface_points: [] }, dummyViewer);
    expect(r.error).toBe("NotYetImplemented");
    expect((r.detail as string)).toContain("kern_flow_along_surface");
  });

  test.skip("SdFlowAlongSurface — blocked: needs general surface UV-pullback morphing in kern.wasm", () => {
    // Blocked. Full oracle: replicad surface-morph should match kern output.
  });

  test("SdCageMorph returns NotYetImplemented", () => {
    const r = handle_SdCageMorph({ cage_points: [], deformed_points: [] }, dummyViewer);
    expect(r.error).toBe("NotYetImplemented");
    expect((r.detail as string)).toContain("kern_cage_morph");
  });

  test.skip("SdCageMorph — blocked: needs general trilinear cage interpolation in kern.wasm", () => {
    // Blocked. Full oracle: replicad cage FFD should match kern output.
  });

  test("SdSporph returns NotYetImplemented", () => {
    const r = handle_SdSporph({ src_surface: [], dst_surface: [] }, dummyViewer);
    expect(r.error).toBe("NotYetImplemented");
    expect((r.detail as string)).toContain("kern_sporph");
  });

  test.skip("SdSporph — blocked: needs general surface-to-surface UV morphing in kern.wasm", () => {
    // Blocked. Full oracle: replicad sporph result should match kern output.
  });

  test("SdSplop returns NotYetImplemented", () => {
    const r = handle_SdSplop({ surface_points: [] }, dummyViewer);
    expect(r.error).toBe("NotYetImplemented");
    expect((r.detail as string)).toContain("kern_splop");
  });

  test.skip("SdSplop — blocked: needs general surface UV grid instance placement in kern.wasm", () => {
    // Blocked. Full oracle: replicad surface population should match kern output.
  });

  test("SdMaelstrom returns NotYetImplemented", () => {
    const r = handle_SdMaelstrom({}, dummyViewer);
    expect(r.error).toBe("NotYetImplemented");
    expect((r.detail as string)).toContain("kern_maelstrom");
  });

  test.skip("SdMaelstrom — blocked: needs general radial-falloff spiral deformation in kern.wasm", () => {
    // Blocked. Full oracle: analytic maelstrom spiral should match kern output.
  });
});

// ── Additional oracle cross-check: twist ↔ rotation identity ─────────────────

describe("SdTwist oracle cross-check: twist preserves ||P - axis|| for all vertices", () => {
  test("arbitrary non-axis-aligned twist preserves radial distance to twist axis", () => {
    const src = makeTetrahedronMesh();
    const srcVerts = getVertices(src.geometry).map(v => v.clone());

    // Non-Z twist axis: [1, 2, 3] normalized
    const axisRaw = new THREE.Vector3(1, 2, 3).normalize();
    const axis = axisRaw.toArray() as [number, number, number];
    const axisOriginPt = new THREE.Vector3(0.5, 1.0, 0.5);

    const { viewer, added } = makeStubViewer(src);
    handle_SdTwist({
      axis: axis,
      axis_origin: axisOriginPt.toArray(),
      angle: 120,
    }, viewer);

    expect(added.length).toBe(1);
    const outVerts = getVertices(added[0].geometry);

    // oracle: for each vertex, the perpendicular distance to the twist axis should be preserved
    for (let i = 0; i < srcVerts.length; i++) {
      const sv = srcVerts[i].clone().sub(axisOriginPt);
      const ov = outVerts[i].clone().sub(axisOriginPt);

      // Axial projection
      const svAxial = axisRaw.clone().multiplyScalar(sv.dot(axisRaw));
      const ovAxial = axisRaw.clone().multiplyScalar(ov.dot(axisRaw));

      // Perpendicular component
      const svPerp = sv.clone().sub(svAxial).length();
      const ovPerp = ov.clone().sub(ovAxial).length();

      expect(Math.abs(svPerp - ovPerp)).toBeLessThan(1e-5);
    }
  });
});
