// kern-ops.ts — High-level TypeScript wrappers around rawKernModule() C++ calls.
//
// Each function checks isKernLoaded() and returns null when the WASM module
// hasn't been initialised yet. Callers treat null as "fall back to TS path".
//
// Input / output types are plain JS Brep (OpenNURBS knots, xyz CVs).
// Serialization to/from the C++ kern JSON format is handled internally.

import type { Brep } from './nurbs-brep';
import {
  isKernLoaded,
  rawKernModule,
  brepToKernJson,
  kernResultToBrep,
} from './wasm-boolean-backend';

type KernOkResp  = { ok: true;  result: unknown };
type KernErrResp = { ok: false; error: { code: string; message: string } };
type KernResp = KernOkResp | KernErrResp;

/**
 * Apply a rolling-ball fillet to a brep using the C++ kern.
 *
 * @param brep    Input brep (world-space, OpenNURBS knot convention).
 * @param radius  Fillet radius (same units as the brep).
 * @param edges   Optional 0-based edge indices. Empty = fillet all edges.
 * @returns Filleted brep, or null if kern not loaded / operation failed.
 */
export function kernFillet(
  brep: Brep,
  radius: number,
  edges: number[] = [],
): Brep | null {
  if (!isKernLoaded()) return null;
  try {
    const brepJson = JSON.parse(brepToKernJson(brep)) as unknown;
    const req = JSON.stringify({ brep: brepJson, radius, edges });
    const raw = rawKernModule().kern_fillet(req);
    const resp = JSON.parse(raw) as KernResp;
    if (!resp.ok) return null;
    return kernResultToBrep((resp as KernOkResp).result);
  } catch {
    return null;
  }
}

/**
 * Apply a chamfer to a brep using the C++ kern.
 *
 * @param brep     Input brep (world-space).
 * @param distance Chamfer distance.
 * @param edges    Optional 0-based edge indices. Empty = chamfer all edges.
 * @returns Chamfered brep, or null if kern not loaded / operation failed.
 */
export function kernChamfer(
  brep: Brep,
  distance: number,
  edges: number[] = [],
): Brep | null {
  if (!isKernLoaded()) return null;
  try {
    const brepJson = JSON.parse(brepToKernJson(brep)) as unknown;
    const req = JSON.stringify({ brep: brepJson, distance, edges });
    const raw = rawKernModule().kern_chamfer(req);
    const resp = JSON.parse(raw) as KernResp;
    if (!resp.ok) return null;
    return kernResultToBrep((resp as KernOkResp).result);
  } catch {
    return null;
  }
}
