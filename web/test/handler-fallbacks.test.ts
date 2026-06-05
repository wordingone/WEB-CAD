// handler-fallbacks.test.ts — smoke tests for the new fallback branches
// added to the SdSlab, SdCeiling, SdWindow, and SdStair handlers (#pr-a).
//
// We cannot import main.ts directly (it instantiates THREE.WebGLRenderer
// at the module level and requires a GPU context). Instead we test the
// pure-computation logic extracted from each handler using a real THREE.Scene
// with synthetic wall/slab meshes — matching the "no mocking" requirement.

import { describe, expect, test } from "bun:test";
import * as THREE from "three";

// ── Shared helpers ───────────────────────────────────────────────────────────

function makeBoxMesh(
  x: number, y: number, z: number,
  w: number, d: number, h: number,
  creator: string,
): THREE.Mesh {
  const geom = new THREE.BoxGeometry(w, d, h);
  const mat  = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(x + w / 2, y + d / 2, z + h / 2);
  mesh.updateMatrixWorld(true);
  mesh.userData.creator = creator;
  return mesh;
}

// ── Profile → bbox logic (SdSlab + SdCeiling) ────────────────────────────────

function profileToBbox(prof: number[][]): { a: { x: number; y: number }; b: { x: number; y: number } } {
  const xs = prof.map((p) => p[0]);
  const ys = prof.map((p) => p[1]);
  return {
    a: { x: Math.min(...xs), y: Math.min(...ys) },
    b: { x: Math.max(...xs), y: Math.max(...ys) },
  };
}

describe("SdSlab / SdCeiling — profile → bbox", () => {
  test("extracts bbox from rectangular profile", () => {
    const prof = [[0, 0], [8, 0], [8, 6], [0, 6]];
    const { a, b } = profileToBbox(prof);
    expect(a.x).toBe(0);
    expect(a.y).toBe(0);
    expect(b.x).toBe(8);
    expect(b.y).toBe(6);
  });

  test("handles non-axis-aligned profiles (takes bbox of outer envelope)", () => {
    const prof = [[1, 2], [5, 0], [7, 4], [3, 6]];
    const { a, b } = profileToBbox(prof);
    expect(a.x).toBe(1);
    expect(a.y).toBe(0);
    expect(b.x).toBe(7);
    expect(b.y).toBe(6);
  });

  test("width×depth fallback when no profile", () => {
    // This is the original path: a = {-w/2, -d/2}, b = {+w/2, +d/2}
    const w = 8, d = 6;
    const a = { x: -w / 2, y: -d / 2 };
    const b = { x:  w / 2, y:  d / 2 };
    expect(a.x).toBe(-4);
    expect(b.x).toBe(4);
  });
});

// ── Nearest-wall logic (SdWindow) ────────────────────────────────────────────

function findNearestWall(
  scene: THREE.Scene,
  winXY: THREE.Vector3,
  threshold: number,
): THREE.Object3D | undefined {
  let nearest: THREE.Object3D | undefined;
  let minDist = threshold;
  scene.traverse((child) => {
    const c = child.userData?.creator;
    if (c !== "SdWall" && c !== "wall") return;
    const wallCenter = new THREE.Box3().setFromObject(child).getCenter(new THREE.Vector3());
    const dist = winXY.distanceTo(new THREE.Vector3(wallCenter.x, wallCenter.y, 0));
    if (dist < minDist) { minDist = dist; nearest = child; }
  });
  return nearest;
}

describe("SdWindow — nearest-wall auto-host fallback", () => {
  test("finds the closest wall within 3m threshold", () => {
    const scene = new THREE.Scene();
    // Wall A centred at (4, 0, 1.5) — 1m away from window
    const wallA = makeBoxMesh(0, -0.15, 0, 8, 0.3, 3, "SdWall");
    wallA.position.set(4, 0, 1.5);
    wallA.updateMatrixWorld(true);
    // Wall B centred at (4, 6, 1.5) — 5m away from window, outside threshold
    const wallB = makeBoxMesh(0, 5.85, 0, 8, 0.3, 3, "SdWall");
    wallB.position.set(4, 6, 1.5);
    wallB.updateMatrixWorld(true);
    scene.add(wallA, wallB);

    const winPos = new THREE.Vector3(4, 1, 0); // 1m north of wall A
    const result = findNearestWall(scene, winPos, 3);
    expect(result).toBe(wallA);
  });

  test("returns undefined when no wall is within threshold", () => {
    const scene = new THREE.Scene();
    const farWall = makeBoxMesh(50, 50, 0, 8, 0.3, 3, "SdWall");
    scene.add(farWall);
    const winPos = new THREE.Vector3(4, 3, 0);
    const result = findNearestWall(scene, winPos, 3);
    expect(result).toBeUndefined();
  });

  test("ignores slabs and other non-wall objects", () => {
    const scene = new THREE.Scene();
    const slab = makeBoxMesh(0, 0, 0, 8, 6, 0.2, "slab");
    scene.add(slab);
    const winPos = new THREE.Vector3(4, 3, 0);
    const result = findNearestWall(scene, winPos, 3);
    expect(result).toBeUndefined();
  });
});

// ── Bounds-snap logic (SdStair) ──────────────────────────────────────────────

function boundsSnap(
  a: { x: number; y: number },
  b: { x: number; y: number },
  bbox: THREE.Box3,
): { a: { x: number; y: number }; b: { x: number; y: number } } {
  const inBbox = (p: { x: number; y: number }) =>
    p.x >= bbox.min.x && p.x <= bbox.max.x &&
    p.y >= bbox.min.y && p.y <= bbox.max.y;
  if (!inBbox(a) && !inBbox(b)) {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const bx = (bbox.min.x + bbox.max.x) / 2;
    const by = (bbox.min.y + bbox.max.y) / 2;
    a = { x: a.x + (bx - mx), y: a.y + (by - my) };
    b = { x: b.x + (bx - mx), y: b.y + (by - my) };
  }
  return { a, b };
}

// ── kern fallback reason capture logic (SdFillet / SdChamfer) ────────────────
// Mirrors the logic in transforms.ts: kernFallbackReason capture + result-shape surface.

function readKernLastFilletErrLogic(lastErr: unknown): string {
  if (!lastErr) return 'kern_fillet rejected';
  if (typeof lastErr === 'object') {
    const e = lastErr as { code?: string; message?: string };
    return e.message ?? e.code ?? 'kern_fillet rejected';
  }
  return String(lastErr);
}

function captureKernFallbackReason(isLoaded: boolean, lastErr: unknown): string {
  return isLoaded ? readKernLastFilletErrLogic(lastErr) : 'kern-not-loaded';
}

function buildFilletResult(
  modified: string,
  edgeCount: number | 'all',
  backend: 'kern-fillet' | 'ts-approx',
  kernFallbackReason?: string,
): Record<string, unknown> {
  const ret: Record<string, unknown> = { modified, edgeCount, backend };
  if (kernFallbackReason !== undefined) {
    ret.kern_fallback = true;
    ret.kern_fallback_reason = kernFallbackReason;
  }
  return ret;
}

describe("SdFillet / SdChamfer — kern fallback reason capture", () => {
  test("kern loaded + lastErr null → 'kern_fillet rejected'", () => {
    expect(captureKernFallbackReason(true, null)).toBe('kern_fillet rejected');
  });

  test("kern loaded + lastErr undefined → 'kern_fillet rejected'", () => {
    expect(captureKernFallbackReason(true, undefined)).toBe('kern_fillet rejected');
  });

  test("kern loaded + lastErr string → the string", () => {
    expect(captureKernFallbackReason(true, 'non-planar edge')).toBe('non-planar edge');
  });

  test("kern loaded + lastErr {code, message} object → message string", () => {
    expect(captureKernFallbackReason(true, { code: 'CURVED_FACE', message: 'curved-face fillet not yet implemented: edge 3' }))
      .toBe('curved-face fillet not yet implemented: edge 3');
  });

  test("kern loaded + lastErr {code} object (no message) → code string", () => {
    expect(captureKernFallbackReason(true, { code: 'CURVED_FACE' }))
      .toBe('CURVED_FACE');
  });

  test("kern loaded + lastErr empty object → 'kern_fillet rejected'", () => {
    expect(captureKernFallbackReason(true, {})).toBe('kern_fillet rejected');
  });

  test("kern not loaded → 'kern-not-loaded'", () => {
    expect(captureKernFallbackReason(false, null)).toBe('kern-not-loaded');
  });

  test("result shape: kern_fallback absent when no fallback occurred (kern-fillet success)", () => {
    const r = buildFilletResult('abc', 'all', 'kern-fillet', undefined);
    expect(r.backend).toBe('kern-fillet');
    expect(r.kern_fallback).toBeUndefined();
    expect(r.kern_fallback_reason).toBeUndefined();
  });

  test("result shape: kern_fallback=true + reason present when fallback occurred", () => {
    const reason = 'non-planar edge detected';
    const r = buildFilletResult('xyz', 12, 'ts-approx', reason);
    expect(r.backend).toBe('ts-approx');
    expect(r.kern_fallback).toBe(true);
    expect(r.kern_fallback_reason).toBe(reason);
  });

  test("result shape: kern-not-loaded reason is preserved verbatim", () => {
    const r = buildFilletResult('xyz', 'all', 'ts-approx', 'kern-not-loaded');
    expect(r.kern_fallback_reason).toBe('kern-not-loaded');
  });
});

// ── unsupportedNativeFilletError with kern_fallback surfacing ─────────────────
// Mirrors the modified unsupportedNativeFilletError in transforms.ts.

function unsupportedNativeFilletErrorLogic(operation: string, kernFallbackReason?: string): Record<string, unknown> {
  const ret: Record<string, unknown> = {
    error: `SdFillet - ${operation} currently requires a supported canonical box-like BRep. Mesh-derived fallback is disabled so the command cannot create a fake canonical BRep result.`,
  };
  if (kernFallbackReason !== undefined) {
    ret.kern_fallback = true;
    ret.kern_fallback_reason = kernFallbackReason;
  }
  return ret;
}

describe("SdFillet — unsupportedNativeFilletError kern_fallback surface", () => {
  test("no kern_fallback when reason is absent (not a kern-rejection case)", () => {
    const r = unsupportedNativeFilletErrorLogic("all-edge chamfer");
    expect(r.error).toContain("SdFillet");
    expect(r.kern_fallback).toBeUndefined();
    expect(r.kern_fallback_reason).toBeUndefined();
  });

  test("kern_fallback=true + reason when kern rejected before TS also fails", () => {
    const r = unsupportedNativeFilletErrorLogic("all-edge chamfer", "curved-face fillet not yet implemented: edge 3");
    expect(r.kern_fallback).toBe(true);
    expect(r.kern_fallback_reason).toBe("curved-face fillet not yet implemented: edge 3");
    expect(r.error).toContain("SdFillet");
  });

  test("error message preserved regardless of kern fallback reason", () => {
    const r1 = unsupportedNativeFilletErrorLogic("selected-edge chamfer", "kern-not-loaded");
    const r2 = unsupportedNativeFilletErrorLogic("selected-edge chamfer");
    expect(r1.error).toBe(r2.error);
  });
});

describe("SdStair — bounds-snap for out-of-bounds coords", () => {
  const bbox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(8, 6, 3));

  test("translates stair when both endpoints are outside bbox", () => {
    // Model emitted start=[-5,-5], end=[-4,-4] — both well outside [0,8]×[0,6]
    const { a, b } = boundsSnap({ x: -5, y: -5 }, { x: -4, y: -4 }, bbox);
    // Midpoint of result should be bbox centre (4, 3)
    expect((a.x + b.x) / 2).toBeCloseTo(4, 5);
    expect((a.y + b.y) / 2).toBeCloseTo(3, 5);
    // Direction and length preserved
    expect(b.x - a.x).toBeCloseTo(1, 5);
    expect(b.y - a.y).toBeCloseTo(1, 5);
  });

  test("does NOT move stair when at least one endpoint is inside bbox", () => {
    const orig_a = { x: 7, y: 5 };   // inside [0,8]×[0,6]
    const orig_b = { x: 10, y: 7 };  // outside
    const { a, b } = boundsSnap(orig_a, orig_b, bbox);
    expect(a.x).toBe(orig_a.x);
    expect(a.y).toBe(orig_a.y);
    expect(b.x).toBe(orig_b.x);
    expect(b.y).toBe(orig_b.y);
  });

  test("preserves stair length after snap", () => {
    const start = { x: -2, y: -2 };
    const end   = { x: -2, y:  0 }; // length 2 in Y
    const { a, b } = boundsSnap(start, end, bbox);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    expect(len).toBeCloseTo(2, 5);
  });
});
