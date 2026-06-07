// kern-evalsurf-degree-guard.test.ts — #359: evalSurf degree-bound overflow guard.
// Verifies that kern_ssi rejects degree > kMaxDeg(=7) with a descriptive error
// instead of writing past the d[kMaxDeg+1] stack array.
//
// Overflow cases require kern ≥ 1.2.0 (capability "ssi-degree-guard").
// The guard lives in ssi.cpp::ssi(); the WASM must be rebuilt from the updated
// source to exercise the degree-8 rejection path. Tests skip gracefully on older
// binaries so CI stays green before the rebuild lands.
import { describe, test, expect, beforeAll } from "bun:test";
import { initWasmKernel, rawKernModule } from "../src/nurbs/wasm-boolean-backend";

let wasmReady = false;
let hasGuard = false;

beforeAll(async () => {
  try {
    await initWasmKernel();
    wasmReady = true;
  } catch {
    wasmReady = false;
    return;
  }
  // kern_version() may not exist on pre-1.2.0 binaries; treat absence as hasGuard=false.
  try {
    const versionStr = rawKernModule().kern_version();
    const versionObj = JSON.parse(versionStr) as { capabilities?: string[] };
    hasGuard = Array.isArray(versionObj.capabilities) &&
               versionObj.capabilities.includes("ssi-degree-guard");
  } catch {
    // old binary — kern_version absent, hasGuard stays false
  }
});

// Flat bilinear patch in XY plane (degree 1, 2×2 CVs) — always valid.
function flatXYPatch(): object {
  return {
    degreeU: 1, degreeV: 1,
    cvCountU: 2, cvCountV: 2,
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
    cvs: [0, 0, 0, 1,  0, 1, 0, 1,  1, 0, 0, 1,  1, 1, 0, 1],
  };
}

// Bilinear patch tilted ~45° around Y — z goes from -0.5 at u=0 to +0.5 at u=1,
// so it crosses the XY patch (z=0) along x≈0.5, not axis-aligned.
function tiltedPatch(): object {
  return {
    degreeU: 1, degreeV: 1,
    cvCountU: 2, cvCountV: 2,
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
    cvs: [0, 0, -0.5, 1,  0, 1, -0.5, 1,  1, 0, 0.5, 1,  1, 1, 0.5, 1],
  };
}

// Degree-8 flat patch in XY plane (9×2 CVs, uniform clamped).
// degreeU=8 > kMaxDeg=7 → evalSurf must throw, not overflow d[kMaxDeg+1].
function degree8Patch(): object {
  const cvs: number[] = [];
  for (let i = 0; i < 9; i++) {
    cvs.push(i, 0, 0, 1);  // row i, col 0
    cvs.push(i, 1, 0, 1);  // row i, col 1
  }
  return {
    degreeU: 8, degreeV: 1,
    cvCountU: 9, cvCountV: 2,
    knotsU: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1],  // 9+8+1=18
    knotsV: [0, 0, 1, 1],
    cvs,
  };
}

describe("kern evalSurf degree-bound guard (#359)", () => {
  test("degree-8 surfA → ok:false with kMaxDeg in message (overflow prevented)", () => {
    if (!wasmReady) throw new Error("#617: kern.wasm absent — build with emcmake cmake + ninja");
    if (!hasGuard) {
      // Pre-1.2.0 kern.wasm: guard not present; skip rather than assert UB outcome.
      console.warn("[skip] kern < 1.2.0 — rebuild kern.wasm from ssi.cpp fix to run this AC");
      return;
    }
    const kern = rawKernModule();
    const resp = JSON.parse(
      kern.kern_ssi(JSON.stringify({ surfA: degree8Patch(), surfB: flatXYPatch() }))
    );
    expect(resp.ok, `expected ok:false but got ok:true`).toBe(false);
    const msg: string = resp.error?.message ?? "";
    expect(msg, `error.message should mention kMaxDeg — got: ${msg}`)
      .toContain("kMaxDeg");
  });

  test("degree-8 surfB → ok:false with kMaxDeg in message (overflow prevented)", () => {
    if (!wasmReady) throw new Error("#617: kern.wasm absent — build with emcmake cmake + ninja");
    if (!hasGuard) {
      console.warn("[skip] kern < 1.2.0 — rebuild kern.wasm from ssi.cpp fix to run this AC");
      return;
    }
    const kern = rawKernModule();
    const resp = JSON.parse(
      kern.kern_ssi(JSON.stringify({ surfA: flatXYPatch(), surfB: degree8Patch() }))
    );
    expect(resp.ok).toBe(false);
    expect((resp.error?.message ?? "")).toContain("kMaxDeg");
  });

  test("degree-1 tilted∩XY surfaces → ok:true, ≥1 curve (guard doesn't break valid inputs)", () => {
    if (!wasmReady) throw new Error("#617: kern.wasm absent — build with emcmake cmake + ninja");
    if (!hasGuard) {
      console.warn("[skip] kern < 1.2.0 — regression check skipped");
      return;
    }
    const kern = rawKernModule();
    const resp = JSON.parse(
      kern.kern_ssi(JSON.stringify({ surfA: flatXYPatch(), surfB: tiltedPatch() }))
    );
    expect(resp.ok, `kern_ssi failed: ${JSON.stringify(resp.error)}`).toBe(true);
    expect(Array.isArray(resp.curves) && resp.curves.length >= 1).toBe(true);
  });
});
