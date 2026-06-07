// Dual-kernel router (T17 scaffold) — updated to reflect actual routing (#530).
//
// This file was originally written to plan a replicad → nurbs-webgpu migration
// (T17). kern.wasm landed and took over booleans/fillet/chamfer, superseding
// the replicad plan for those ops. This file's KERNEL_TABLE now reflects the
// current (2026-06) actual routing rather than the original migration plan.
//
// Actual routing as of master:
//   kern-wasm  : booleans (union/cut/fuse), fillet, chamfer (via kern_fillet, kern_chamfer)
//   nurbs-ts   : drawRectangle, drawCircle, drawLine, drawPolyline, makeBox, makeCylinder
//   nurbs-webgpu (planned): nurbsSurface, nurbsCurve, revolve, sweep
//
// NOTE: this module's executeOp() is currently unused. detail.kernel was
// removed from dispatch events (#532 dead-data cleanup — zero read-sites).
// KERNEL_TABLE is kept for documentation of actual routing; wiring executeOp()
// into dispatch is deferred (#530).

import {
  NurbsKernel,
  type NurbsCurve,
  type NurbsSurface,
  type Mesh,
  buildSampleNurbsSurface,
} from "../nurbs/nurbs-kernel.js";

export type KernelTag = "nurbs-webgpu" | "nurbs-ts" | "kern-wasm" | "replicad";

/** Actual routing table as of 2026-06 (confirmed from handler code, #530 / #419). */
export const KERNEL_TABLE: Readonly<Record<string, KernelTag>> = Object.freeze({
  // kern.wasm ops (custom C++ via Emscripten — no OCCT)
  fuse:    "kern-wasm",
  cut:     "kern-wasm",
  fillet:  "kern-wasm",
  chamfer: "kern-wasm",
  // Pure TS NURBS handlers
  makeBox:       "nurbs-ts",
  makeCylinder:  "nurbs-ts",
  drawRectangle: "nurbs-ts",
  drawCircle:    "nurbs-ts",
  drawLine:      "nurbs-ts",
  drawPolyline:  "nurbs-ts",
  // Planned GPU-accelerated NURBS path (T17 — stubs until WebGPU kernel lands)
  nurbsSurface: "nurbs-webgpu",
  nurbsCurve:   "nurbs-webgpu",
  revolve:      "nurbs-webgpu",
  sweep:        "nurbs-webgpu",
  // replicad (OpenCascade) — live for Tier 1 JS eval + STEP/IGES import (worker.ts)
  // No verb-dispatch verbs currently route here; replicad path is worker-level only.
});

export function kernelFor(canonicalName: string): KernelTag {
  return KERNEL_TABLE[canonicalName] ?? "nurbs-ts";
}

// Replicad-side outputs — opaque handles into the worker. We do not need
// strict types here because the router is the boundary; the worker
// resolves them via tier1Bindings.
export type Solid = unknown;
export type Curve = NurbsCurve | unknown;
export type Surface = NurbsSurface | unknown;

export type ExecuteResult = Solid | Curve | Surface | Mesh;

const sharedNurbsKernel = new NurbsKernel();

/**
 * Dispatch a canonical-named op to the right kernel. Replicad ops throw
 * "not wired" — the existing dsl-eval / worker path stays in charge until
 * each verb is bridged through executeOp().
 *
 * NURBS ops are bridged immediately because the kernel is in this same
 * module. The shape returned is whatever the op naturally produces:
 *   - nurbsSurface → NurbsSurface
 *   - nurbsCurve   → NurbsCurve
 *   - revolve      → NurbsSurface (NURBS-native revolution; stub for T17)
 *   - sweep        → NurbsSurface (NURBS-native sweep; stub for T17)
 */
export async function executeOp(
  canonicalName: string,
  args: Record<string, unknown>,
): Promise<ExecuteResult> {
  const tag = kernelFor(canonicalName);

  if (tag === "replicad") {
    throw new Error(
      `kernel.executeOp: replicad route '${canonicalName}' not wired through router yet — ` +
      `caller should use the existing worker.ts evaluation path. Wiring is planned ` +
      `as a follow-up to T17 once Spatial Dictionary (T5) lands.`,
    );
  }

  // tag === "nurbs-webgpu"
  switch (canonicalName) {
    case "nurbsSurface": {
      // Args are pass-through to the constructor; "sample" returns the
      // canned cylindrical patch so a smoke test can run end-to-end.
      if (args.sample === true) return buildSampleNurbsSurface();
      throw new Error(
        "kernel.executeOp(nurbsSurface): pass {sample:true} for the canned patch, " +
        "or call nurbsSurfaceFromGrid() directly. Full arg-shape spec is queued.",
      );
    }
    case "nurbsCurve": {
      throw new Error(
        "kernel.executeOp(nurbsCurve): stub — call nurbsCurveFromControlPoints() directly until args are speccd.",
      );
    }
    case "revolve": {
      throw new Error(
        "kernel.executeOp(revolve): NURBS-native revolution stub. Plan: take a profile NurbsCurve + axis + angle " +
        "and emit a NurbsSurface via Piegl-Tiller §8.5 surface-of-revolution. Replicad fallback available.",
      );
    }
    case "sweep": {
      throw new Error(
        "kernel.executeOp(sweep): NURBS-native sweep stub. Plan: profile + rail → translational/rational sweep. " +
        "Replicad fallback available.",
      );
    }
    default:
      throw new Error(`kernel.executeOp: unknown NURBS op '${canonicalName}'`);
  }
}

/** Tessellate any NURBS surface produced by the router. */
export async function tessellateNurbs(surface: NurbsSurface, tol: number = 0.01): Promise<Mesh> {
  return sharedNurbsKernel.tessellateSurface(surface, tol);
}
