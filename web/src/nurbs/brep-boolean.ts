// brep-boolean.ts — IBooleanBackend interface + backend registry + toy/nurbs backends.
//
// PR-1 of the #1818 NURBS kernel umbrella; NurbsBooleanBackend added in #115.
//
// Architecture (OpenSCAD CGAL+Manifold dual-backend pattern):
//   IBooleanBackend — stable interface all backends implement
//   BrepResult      — typed Ok/Err return (no exceptions across the boundary)
//   ChangeMap       — Created/Modified/Generated/Deleted history (LibreCAD pattern)
//   registerBackend — opt-in runtime registry; per-op backend selection at call site
//   ToyBackend      — pure-JS correctness baseline; union = structural concat
//   NurbsBooleanBackend — SSI-backed backend for PlaneSurface-only breps (#115)
//
// Three backends (this file registers the first two):
//   'toy'      — pure-JS structural concat (PR-1)
//   'nurbs'    — SSI-backed face-classification boolean for planar breps (#115)
//   'manifold' — Manifold-WASM fast path, manifold-only (future PR-7)
//
// Per-op backend selection (never global):
//   union(a, b, { backend: 'nurbs' })   → SSI-backed path
//   union(a, b, { backend: 'toy' })     → baseline
//   union(a, b)                         → auto (resolves to highest-registered priority)
//
// Refs:
//   - OpenSCAD cgalutils-applyops.cc vs manifold-applyops.cc (same applyOperator3D shape)
//   - OpenSCAD GeometryEvaluator.cc (per-op backend dispatch)
//   - LibreCAD LC_BevelResult (KernelResult changeMap pattern)
//   - OCCT BRepAlgoAPI_BooleanOperation.hxx:31-46 (objects/tools vocabulary)
//   - Patrikalakis & Maekawa §7 (SSI, referenced by ssi.ts)

import type { Brep, BrepFace, BrepShell } from "./nurbs-brep";
import { brepConcat, BREP_DEFAULT_TOLERANCE } from "./nurbs-brep";
import type { BooleanOptions } from "./nurbs-brep";
import type { PlaneSurface } from "./nurbs-surfaces";
import { domainU as surfDomainU, domainV as surfDomainV, normalAtUV, pointAtUV } from "./nurbs-surfaces";
import { Vector3 as V3, Point3 as Pt3 } from "./nurbs-primitives";
import type { Point3 } from "./nurbs-primitives";
import { ssi } from "./ssi";

// ── Result types ─────────────────────────────────────────────────────────────

/**
 * Describes what changed in the output Brep relative to the inputs.
 * Enables stable parametric history without LGPL contamination.
 * Reference: LibreCAD `LC_BevelResult` shape.
 *
 * Indices refer to positions in `BrepResult.brep.shells`.
 */
export type ChangeMap = {
  /** Shell indices in result that did not exist in either input. */
  created: number[];
  /**
   * Shell identity changes: maps a `"a:<idx>"` or `"b:<idx>"` key
   * (input shell position) to a `"result:<idx>"` key (output shell position).
   * Used to track modified shells through boolean operations.
   */
  modified: Map<string, string>;
  /**
   * Input shells that were fully consumed / deleted.
   * Keys use the same `"a:<idx>"` / `"b:<idx>"` format.
   */
  deleted: string[];
};

/**
 * Error codes returned by backend operations.
 * Never throw across the kernel boundary — always return a typed error.
 */
export type KernelErrorCode =
  | "NOT_MANIFOLD"          // input Brep is not a closed manifold (toy path expects it)
  | "NUMERICAL_FAILURE"     // intersection or tolerance computation failed
  | "NOT_IMPLEMENTED"       // operation not yet supported by this backend
  | "BACKEND_UNAVAILABLE"   // requested backend id is not registered
  | "EMPTY_INPUT";          // one or both inputs are empty breps

export type KernelError = {
  code: KernelErrorCode;
  message: string;
  /** Backend that produced this error. */
  backend: string;
};

/** Typed Ok/Err return — no exceptions cross the kernel boundary. */
export type BrepResult =
  | { ok: true;  brep: Brep; changeMap: ChangeMap }
  | { ok: false; error: KernelError };

// ── IBooleanBackend interface ─────────────────────────────────────────────────

/**
 * All boolean backends implement this interface.
 *
 * Argument shape follows OCCT's objects/tools asymmetry:
 *   - `a` = "objects" (the solid being operated on)
 *   - `b` = "tools"   (the solid doing the operation)
 * For union/intersection the distinction is semantic only.
 * For difference it encodes: result = a minus b.
 *
 * Reference: OCCT BRepAlgoAPI_BooleanOperation.hxx:31-46.
 */
export interface IBooleanBackend {
  /** Stable identifier; used in BooleanOptions.backend and registry lookup. */
  readonly id: string;

  /** Priority for auto-resolution: higher wins. */
  readonly priority: number;

  /** a ∪ b — result contains all material from both inputs. */
  union(a: Brep, b: Brep, opts?: BooleanOptions): BrepResult;

  /** a − b — result contains material in a but not in b. */
  difference(a: Brep, b: Brep, opts?: BooleanOptions): BrepResult;

  /** a ∩ b — result contains only material shared by both. */
  intersection(a: Brep, b: Brep, opts?: BooleanOptions): BrepResult;

  /**
   * Section edges of a ∩ b — returns curves at the intersection boundary.
   * Reference: OCCT BRepAlgoAPI_BooleanOperation.hxx:39-46 (SECTION operation).
   */
  section(a: Brep, b: Brep, opts?: BooleanOptions): BrepResult;
}

// ── BooleanOptions extension ──────────────────────────────────────────────────

// Extend BooleanOptions (defined in nurbs-brep.ts) with backend selection.
// We augment by re-exporting a wider type alias used internally.
export type BooleanCallOptions = BooleanOptions & {
  /**
   * Backend to use for this operation. Omit for auto (highest priority registered).
   * Reference: OpenSCAD env-var backend choice — we do per-op instead of global.
   */
  backend?: string;
};

// ── Backend registry ──────────────────────────────────────────────────────────

const _registry = new Map<string, IBooleanBackend>();

/**
 * Register a backend. Call at module load time:
 *   `registerBackend(new ManifoldBackend())`
 *
 * Later registrations override earlier ones for the same `id`.
 * Reference: OpenSCAD's `#ifdef ENABLE_MANIFOLD` compile-time gating →
 * we use a runtime registry for dynamic import opt-in.
 */
export function registerBackend(backend: IBooleanBackend): void {
  _registry.set(backend.id, backend);
}

/**
 * Clear all registered backends and optionally re-register the toy backend.
 * Exported for test isolation ONLY — never call in production code.
 */
export function _clearRegistryForTest(reRegisterToy = true): void {
  _registry.clear();
  if (reRegisterToy) registerBackend(new ToyBooleanBackend());
}

/** All currently registered backend ids, sorted by priority descending. */
export function registeredBackends(): string[] {
  return Array.from(_registry.values())
    .sort((a, b) => b.priority - a.priority)
    .map((b) => b.id);
}

/**
 * Resolve the backend for an operation.
 * If `opts.backend` is specified: return that backend or an UNAVAILABLE error.
 * If omitted: return the highest-priority registered backend.
 */
export function resolveBackend(opts?: BooleanCallOptions): IBooleanBackend | KernelError {
  const id = opts?.backend;
  if (id !== undefined) {
    const b = _registry.get(id);
    if (!b) {
      return { code: "BACKEND_UNAVAILABLE", message: `backend '${id}' not registered`, backend: id };
    }
    return b;
  }
  // Auto: pick highest priority
  let best: IBooleanBackend | undefined;
  for (const b of _registry.values()) {
    if (!best || b.priority > best.priority) best = b;
  }
  if (!best) {
    return { code: "BACKEND_UNAVAILABLE", message: "no backends registered", backend: "none" };
  }
  return best;
}

// ── Top-level dispatch functions ──────────────────────────────────────────────

function dispatch(
  op: "union" | "difference" | "intersection" | "section",
  a: Brep,
  b: Brep,
  opts?: BooleanCallOptions,
): BrepResult {
  const backend = resolveBackend(opts);
  if ("code" in backend) return { ok: false, error: backend };
  return backend[op](a, b, opts);
}

/** a ∪ b */
export function brepUnion(a: Brep, b: Brep, opts?: BooleanCallOptions): BrepResult {
  return dispatch("union", a, b, opts);
}

/** a − b */
export function brepDifference(a: Brep, b: Brep, opts?: BooleanCallOptions): BrepResult {
  return dispatch("difference", a, b, opts);
}

/** a ∩ b */
export function brepIntersection(a: Brep, b: Brep, opts?: BooleanCallOptions): BrepResult {
  return dispatch("intersection", a, b, opts);
}

/** Section curves at a ∩ b boundary */
export function brepSection(a: Brep, b: Brep, opts?: BooleanCallOptions): BrepResult {
  return dispatch("section", a, b, opts);
}

// ── Toy backend (pure-JS correctness baseline) ────────────────────────────────

/**
 * Pure-JS toy backend — priority 0 (lowest).
 *
 * Union: structural shell concatenation via brepConcat. Not a topological
 * boolean — internal geometry is not removed. Correct for disjoint inputs;
 * approximate for overlapping inputs. Useful as a dispatch test harness and
 * for early pipeline wiring before PR-6 (BooleanBuilder) lands.
 *
 * Difference / Intersection / Section: NOT_IMPLEMENTED (correct error path).
 *
 * Reference: OpenSCAD CGAL backend — exact but GPL; Manifold backend — fast
 * but manifold-only. Toy backend is neither: it is just proof that the
 * interface and dispatch machinery work end-to-end.
 */
export class ToyBooleanBackend implements IBooleanBackend {
  readonly id = "toy";
  readonly priority = 0;

  union(a: Brep, b: Brep, _opts?: BooleanOptions): BrepResult {
    const result = brepConcat(a, b);
    const aLen = a.shells.length;
    const bLen = b.shells.length;
    const changeMap: ChangeMap = {
      created: [],
      modified: new Map(
        [
          ...a.shells.map((_, i) => [`a:${i}`, `result:${i}`] as [string, string]),
          ...b.shells.map((_, i) => [`b:${i}`, `result:${aLen + i}`] as [string, string]),
        ],
      ),
      deleted: [],
    };
    void bLen;
    return { ok: true, brep: result, changeMap };
  }

  difference(_a: Brep, _b: Brep, _opts?: BooleanOptions): BrepResult {
    return { ok: false, error: { code: "NOT_IMPLEMENTED", message: "toy backend: difference not implemented (use BooleanBuilder PR-6)", backend: this.id } };
  }

  intersection(_a: Brep, _b: Brep, _opts?: BooleanOptions): BrepResult {
    return { ok: false, error: { code: "NOT_IMPLEMENTED", message: "toy backend: intersection not implemented (use BooleanBuilder PR-6)", backend: this.id } };
  }

  section(_a: Brep, _b: Brep, _opts?: BooleanOptions): BrepResult {
    return { ok: false, error: { code: "NOT_IMPLEMENTED", message: "toy backend: section not implemented (use BooleanBuilder PR-6)", backend: this.id } };
  }
}

// ── Auto-register the toy backend ────────────────────────────────────────────

registerBackend(new ToyBooleanBackend());

// ── NURBS boolean backend — SSI-backed, planar-first (#115) ───────────────────
//
// Strategy (OCCT BRepAlgoAPI_BooleanOperation pattern):
//   1. section(): SSI on all face pairs → intersection curves
//   2. _allPlanar(): detect if both operands are PlaneSurface-only
//   3. _planarBoolean(): face-classification for convex PlaneSurface breps:
//        - Compute outward test point for each face
//        - Ray-cast into other brep to determine inside/outside
//        - Select faces per operation (union/difference/intersection)
//   4. For non-planar or mixed: fall back to ToyBooleanBackend for union;
//      NOT_IMPLEMENTED for difference/intersection
//
// Mesh fallback: if face.surface has userData.kind === "mesh", falls back to toy.
//
// Ref: OCCT BRepAlgoAPI_BooleanOperation.hxx; Weiler-Atherton face classification.

/** Return true if every face in every shell uses a PlaneSurface. */
function _allPlanar(brep: Brep): boolean {
  return brep.shells.every((sh) =>
    sh.faces.every((f) => f.surface.kind === "plane"),
  );
}

/** Return true if any face has userData.kind === "mesh" (trigger toy fallback per AC#4). */
function _hasMeshFaces(brep: Brep): boolean {
  return brep.shells.some((sh) =>
    sh.faces.some((f) => {
      const ud = (f as unknown as { userData?: { kind?: string } }).userData;
      return ud?.kind === "mesh";
    }),
  );
}

/**
 * Compute the outward test point for a face: centroid + ε * outward_normal.
 * For PlaneSurface: uses plane.origin as centroid and plane.normal as outward normal.
 * For other surface kinds: evaluates at surface domain midpoint.
 *
 * `eps` should be larger than any edge tolerance to avoid landing on the boundary.
 */
function _outwardTestPt(face: BrepFace, eps: number): Point3 {
  const surf = face.surface;
  if (surf.kind === "plane") {
    const n = face.orientation ? surf.plane.normal : V3.negate(surf.plane.normal);
    const o = surf.plane.origin;
    return { x: o.x + eps * n.x, y: o.y + eps * n.y, z: o.z + eps * n.z };
  }
  // Generic: evaluate at surface midpoint
  const domU = surfDomainU(surf);
  const domV = surfDomainV(surf);
  const midU = (domU.min + domU.max) / 2;
  const midV = (domV.min + domV.max) / 2;
  const midPt = pointAtUV(surf, midU, midV);
  const n = normalAtUV(surf, midU, midV);
  const outN = face.orientation ? n : V3.negate(n);
  return { x: midPt.x + eps * outN.x, y: midPt.y + eps * outN.y, z: midPt.z + eps * outN.z };
}

/**
 * Point-in-closed-solid test via ray casting.
 * Casts a +Y ray from `pt` and counts crossings with PlaneSurface faces.
 * Odd count = inside. Non-planar faces are skipped (conservative: treated as no hit).
 * Intended for convex PlaneSurface-only breps.
 *
 * Uses +Y direction to avoid degenerate cases with axis-aligned boxes.
 */
function _pointInSolid(pt: Point3, solid: Brep): boolean {
  const rayDir = { x: 0, y: 1, z: 0 } as const;
  let crossings = 0;

  for (const shell of solid.shells) {
    for (const face of shell.faces) {
      if (face.surface.kind !== "plane") continue;
      const surf = face.surface as PlaneSurface;
      const n = surf.plane.normal;
      const denom = V3.dot(n, rayDir);
      if (Math.abs(denom) < 1e-10) continue; // parallel to ray

      const o = surf.plane.origin;
      const t = (V3.dot(n, o) - V3.dot(n, pt)) / denom;
      if (t <= 0) continue; // behind ray origin

      // Project hit point onto plane's UV coordinates
      const hit: Point3 = {
        x: pt.x + t * rayDir.x,
        y: pt.y + t * rayDir.y,
        z: pt.z + t * rayDir.z,
      };
      const diff = Pt3.sub(hit, o);
      const u = V3.dot(diff as { x: number; y: number; z: number }, surf.plane.xAxis);
      const v = V3.dot(diff as { x: number; y: number; z: number }, surf.plane.yAxis);

      if (
        u >= surf.uExtent.min - BREP_DEFAULT_TOLERANCE &&
        u <= surf.uExtent.max + BREP_DEFAULT_TOLERANCE &&
        v >= surf.vExtent.min - BREP_DEFAULT_TOLERANCE &&
        v <= surf.vExtent.max + BREP_DEFAULT_TOLERANCE
      ) {
        crossings++;
      }
    }
  }

  return crossings % 2 === 1;
}

/** Empty ChangeMap for operations that don't track history. */
function _emptyChangeMap(): ChangeMap {
  return { created: [], modified: new Map(), deleted: [] };
}

type BooleanOp = "union" | "difference" | "intersection";

/**
 * Face-classification boolean for PlaneSurface-only breps.
 *
 * For each face F in operand A:
 *   - Compute outward test point P = centroid + ε * outward_normal
 *   - If P is inside B: face is interior → classify per op
 * Same for B faces against A.
 *
 * Classification rules:
 *   union:        keep A-faces where P NOT in B; keep B-faces where P NOT in A
 *   difference:   keep A-faces where P NOT in B; keep B-faces where P IS in A (flip orientation)
 *   intersection: keep A-faces where P IS in B;  keep B-faces where P IS in A
 */
function _planarBoolean(op: BooleanOp, a: Brep, b: Brep, opts?: BooleanOptions): BrepResult {
  const eps = Math.max(BREP_DEFAULT_TOLERANCE * 1000, 1e-3);
  const resultFaces: BrepFace[] = [];

  for (const shell of a.shells) {
    for (const face of shell.faces) {
      const testPt = _outwardTestPt(face, eps);
      const insideB = _pointInSolid(testPt, b);
      const keep =
        op === "union"         ? !insideB :
        op === "difference"    ? !insideB :
        /* intersection */        insideB;
      if (keep) resultFaces.push(face);
    }
  }

  for (const shell of b.shells) {
    for (const face of shell.faces) {
      const testPt = _outwardTestPt(face, eps);
      const insideA = _pointInSolid(testPt, a);
      const keep =
        op === "union"         ? !insideA :
        op === "difference"    ?  insideA :   // B-faces inside A contribute (flipped)
        /* intersection */        insideA;
      if (keep) {
        // For difference: flip orientation so B-face normals point outward of the result
        const flippedFace: BrepFace = op === "difference"
          ? { ...face, orientation: !face.orientation }
          : face;
        resultFaces.push(flippedFace);
      }
    }
  }

  if (resultFaces.length === 0) {
    // Degenerate: no faces survive (e.g. identical inputs for difference)
    return {
      ok: false,
      error: { code: "NUMERICAL_FAILURE", message: `${op}: no faces survived classification — inputs may be identical or non-overlapping`, backend: "nurbs" },
    };
  }

  const shell: BrepShell = {
    faces: resultFaces,
    edges: [],
    vertices: [],
    isClosed: true,
  };
  return { ok: true, brep: { shells: [shell] }, changeMap: _emptyChangeMap() };
}

/**
 * SSI-backed NURBS boolean backend (priority 10 — beats ToyBooleanBackend at 0).
 *
 * Handles PlaneSurface-only breps via face-classification (union / difference /
 * intersection). Falls back to ToyBooleanBackend for union on non-planar breps
 * and mesh operands. Returns NOT_IMPLEMENTED for difference/intersection on
 * non-planar inputs (full BooleanBuilder is a future deliverable).
 *
 * section() always uses SSI on all face pairs and works for any surface kind.
 */
export class NurbsBooleanBackend implements IBooleanBackend {
  readonly id = "nurbs";
  readonly priority = 10;

  private _toy = new ToyBooleanBackend();

  union(a: Brep, b: Brep, opts?: BooleanOptions): BrepResult {
    if (_hasMeshFaces(a) || _hasMeshFaces(b)) return this._toy.union(a, b, opts);
    if (_allPlanar(a) && _allPlanar(b)) return _planarBoolean("union", a, b, opts);
    return this._toy.union(a, b, opts);
  }

  difference(a: Brep, b: Brep, opts?: BooleanOptions): BrepResult {
    if (_hasMeshFaces(a) || _hasMeshFaces(b)) {
      return { ok: false, error: { code: "NOT_IMPLEMENTED", message: "nurbs backend: difference not supported for mesh operands", backend: this.id } };
    }
    if (_allPlanar(a) && _allPlanar(b)) return _planarBoolean("difference", a, b, opts);
    return { ok: false, error: { code: "NOT_IMPLEMENTED", message: "nurbs backend: difference requires PlaneSurface-only breps (BooleanBuilder future)", backend: this.id } };
  }

  intersection(a: Brep, b: Brep, opts?: BooleanOptions): BrepResult {
    if (_hasMeshFaces(a) || _hasMeshFaces(b)) {
      return { ok: false, error: { code: "NOT_IMPLEMENTED", message: "nurbs backend: intersection not supported for mesh operands", backend: this.id } };
    }
    if (_allPlanar(a) && _allPlanar(b)) return _planarBoolean("intersection", a, b, opts);
    return { ok: false, error: { code: "NOT_IMPLEMENTED", message: "nurbs backend: intersection requires PlaneSurface-only breps (BooleanBuilder future)", backend: this.id } };
  }

  /**
   * section(): SSI on every face pair from a×b — works for any surface kind.
   * Returns a Brep with one shell per intersection curve set, each shell holding
   * a single face whose surface is the first intersecting surface (proxy).
   * The actual intersection geometry is in shell.edges[i].curve.
   */
  section(a: Brep, b: Brep, opts?: BooleanOptions): BrepResult {
    const fuzzy = opts?.fuzzyValue ?? 0;
    const ssiOpts = { tolerance: Math.max(BREP_DEFAULT_TOLERANCE + fuzzy, 1e-4) };
    const resultShells: BrepShell[] = [];

    for (const shellA of a.shells) {
      for (const faceA of shellA.faces) {
        for (const shellB of b.shells) {
          for (const faceB of shellB.faces) {
            const curves = ssi(faceA.surface, faceB.surface, ssiOpts);
            if (curves.length === 0) continue;

            for (const curve of curves) {
              // Represent each intersection curve as a shell with a polyline edge
              if (curve.pts3d.length < 2) continue;
              // Build a LineCurve from first to last point as proxy edge
              const p0 = curve.pts3d[0];
              const pN = curve.pts3d[curve.pts3d.length - 1];
              const edgeCurve = {
                kind: "line" as const,
                from: p0,
                to: pN,
                domain: { min: 0, max: Pt3.distance(p0, pN) },
              };
              const shell: BrepShell = {
                faces: [faceA], // proxy — the intersecting face from A
                edges: [{ curve: edgeCurve, faceIndex1: 0, faceIndex2: null, tolerance: BREP_DEFAULT_TOLERANCE }],
                vertices: [
                  { point: p0, edgeIndices: [0], tolerance: BREP_DEFAULT_TOLERANCE },
                  { point: pN, edgeIndices: [0], tolerance: BREP_DEFAULT_TOLERANCE },
                ],
                isClosed: curve.closed,
              };
              resultShells.push(shell);
            }
          }
        }
      }
    }

    if (resultShells.length === 0) {
      return { ok: false, error: { code: "NUMERICAL_FAILURE", message: "section: no intersection curves found", backend: this.id } };
    }
    return { ok: true, brep: { shells: resultShells }, changeMap: _emptyChangeMap() };
  }
}

// ── Auto-register the NURBS backend ─────────────────────────────────────────

registerBackend(new NurbsBooleanBackend());
