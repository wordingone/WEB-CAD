// wasm-boolean-backend.ts — IBooleanBackend backed by the C++/Emscripten geometry kernel.
//
// Architecture:
//   WasmBooleanBackend implements IBooleanBackend with priority 20, beating
//   NurbsBooleanBackend (priority 10) and ToyBooleanBackend (priority 0).
//
//   WASM init is async; the module methods (union/difference/intersection) are
//   synchronous per IBooleanBackend contract. Callers MUST await initWasmKernel()
//   at application startup before registering this backend. If the kernel is not
//   yet loaded, all operations throw — this surfaces misconfigured startup rather
//   than silently returning wrong results.
//
// Startup sequence (app entry point):
//   import { initWasmKernel, wasmBooleanBackend } from './nurbs/wasm-boolean-backend'
//   import { registerBackend } from './nurbs/brep-boolean'
//   await initWasmKernel()
//   registerBackend(wasmBooleanBackend)  // priority 20 beats nurbs (10) + toy (0)
//
// Refs:
//   - Emscripten Module({locateFile}) pattern: docs.emscripten.org/Filesystem-API
//   - IBooleanBackend: brep-boolean.ts:100-121
//   - OCCT BRepAlgoAPI_BooleanOperation objects/tools vocabulary: brep-boolean.ts:92-98

// kern.js and kern.wasm are generated Emscripten outputs (not present until `cmake --build`).
// Use dynamic imports so module load doesn't fail when the WASM is absent.
//
// Path arithmetic: Vite dev serves modules from their source tree depth
// (web/src/nurbs/ → ../../ reaches web root). Production bundles everything into
// assets/ → only one level up reaches the deploy root. Vite substitutes
// import.meta.env.DEV at build time so the wrong branch is dead-code-eliminated.
const _kernJsPath = import.meta.env.DEV ? '../../kern.js' : '../kern.js';
const _kernWasmPath = import.meta.env.DEV ? '../../kern.wasm' : '../kern.wasm';

import type { Brep } from './nurbs-brep';
import type { Surface, NurbsSurface } from './nurbs-surfaces';
import { getNurbsForm } from './nurbs-surfaces';
import type {
  IBooleanBackend,
  BrepResult,
  ChangeMap,
} from './brep-boolean';
import type { BooleanOptions } from './nurbs-brep';

// ── KernModule — shape of the Emscripten-exported C++ API ────────────────────

/**
 * Methods exported from the C++ geometry kernel via Emscripten embind.
 * Each method accepts/returns JSON strings (Brep serialised with JSON.stringify).
 * The kernel returns `{ ok: true, result: <BrepJson> }` on success and
 * `{ ok: false, error: <string> }` on failure — never throws.
 *
 * Single-dispatch ops (kern_*) take a single JSON request string.
 * Two-arg ops (boolUnion/boolDifference/boolIntersection) take two Brep JSON strings.
 */
interface KernModule {
  // Two-arg boolean ops (convenience wrappers, retained from initial API)
  boolUnion(aJson: string, bJson: string): string;
  boolDifference(aJson: string, bJson: string): string;
  boolIntersection(aJson: string, bJson: string): string;
  // Single-dispatch boolean: { op, a, b } → { ok, result? | error? }
  kern_boolean(jsonRequest: string): string;
  // Surface-surface intersection: { surfA, surfB, options? } → { ok, curves? | error? }
  kern_ssi(jsonRequest: string): string;
  // Fillet: { brep, radius, edges? } → { ok, result? | error? }
  kern_fillet(jsonRequest: string): string;
  // Chamfer: { brep, distance, edges? } → { ok, result? | error? }
  kern_chamfer(jsonRequest: string): string;
  // Loft: { profiles: NurbsCurve[], degree? } → { ok, result? | error? }
  kern_loft(jsonRequest: string): string;
}

// ── Kernel response shape (parsed from JSON) ──────────────────────────────────

type KernOk  = { ok: true;  result: unknown }; // kern JSON uses "result", not "brep"
type KernErr = { ok: false; error: string };
type KernResponse = KernOk | KernErr;

// ── JS-Brep → kern JSON conversion ───────────────────────────────────────────
//
// The JS Brep type uses OpenNURBS knot convention (length = cvCount + order - 2,
// first/last repeated clamping knots omitted) and xyz CVs without homogeneous w.
// The C++ kern expects standard full knot vectors (length = cvCount + order) and
// xyzw homogeneous CVs.  Non-NURBS surfaces are tessellated via getNurbsForm.

function _surfaceToKernSurf(s: Surface): {
  degreeU: number; degreeV: number;
  cvCountU: number; cvCountV: number;
  knotsU: number[]; knotsV: number[];
  cvs: number[];
} {
  const ns = s.kind === 'nurbs' ? s : getNurbsForm(s).surface;
  const [nU, nV] = ns.cvCount;
  // OpenNURBS → standard: prepend first knot value, append last knot value
  const knotsU = [ns.knots[0][0], ...ns.knots[0], ns.knots[0][ns.knots[0].length - 1]];
  const knotsV = [ns.knots[1][0], ...ns.knots[1], ns.knots[1][ns.knots[1].length - 1]];
  // CVs: JS xyz (or xyzw rational) → kern xyzw, row-major (U outer, V inner)
  const cvs: number[] = [];
  for (let i = 0; i < nU; i++) {
    for (let j = 0; j < nV; j++) {
      const base = i * ns.cvStride[0] + j * ns.cvStride[1];
      cvs.push(ns.cvs[base], ns.cvs[base + 1], ns.cvs[base + 2]);
      cvs.push(ns.isRational ? (ns.cvs[base + ns.dim] ?? 1) : 1);
    }
  }
  return { degreeU: ns.order[0] - 1, degreeV: ns.order[1] - 1, cvCountU: nU, cvCountV: nV, knotsU, knotsV, cvs };
}

export function brepToKernJson(brep: Brep): string {
  return JSON.stringify({
    shells: brep.shells.map(shell => ({
      faces: shell.faces.map(face => ({
        surface: _surfaceToKernSurf(face.surface),
        outerLoop: { edges: [], orientation: face.outerLoop.orientation },
        innerLoops: [],
        orientation: face.orientation,
        tolerance: face.tolerance,
      })),
      edges: [],
      vertices: [],
      isClosed: shell.isClosed,
    })),
  });
}

// ── Kern result → JS Brep conversion ─────────────────────────────────────────
//
// The kern returns surfaces in full-clamped knot vector format with xyzw CVs.
// Convert to JS NurbsSurface (OpenNURBS knots, xyz CVs) and rebuild face topology.

type KernSurface = {
  degreeU: number; degreeV: number;
  cvCountU: number; cvCountV: number;
  knotsU: number[]; knotsV: number[];
  cvs: number[];
};
type KernFace = { surface: KernSurface; outerLoop?: { orientation?: boolean }; orientation?: boolean; tolerance?: number };
type KernShell = { faces: KernFace[]; isClosed?: boolean };
type KernBrepRaw = { shells: KernShell[] };

export function kernResultToBrep(raw: unknown): Brep {
  const k = raw as KernBrepRaw;
  return {
    shells: k.shells.map(shell => ({
      faces: shell.faces.map(face => {
        const s = face.surface;
        const dU = s.degreeU, dV = s.degreeV;
        const nU = s.cvCountU, nV = s.cvCountV;
        // Full-clamped → OpenNURBS: strip first and last repeated knot
        const knotsU = s.knotsU.slice(1, -1);
        const knotsV = s.knotsV.slice(1, -1);
        // xyzw (homogeneous, 4 per CV) → xyz (3 per CV, non-rational)
        const cvs: number[] = [];
        for (let i = 0; i < nU * nV; i++) {
          const b = i * 4;
          const w = s.cvs[b + 3];
          const wSafe = Math.abs(w) > 1e-14 ? w : 1;
          cvs.push(s.cvs[b] / wSafe, s.cvs[b + 1] / wSafe, s.cvs[b + 2] / wSafe);
        }
        const surface: NurbsSurface = {
          kind: 'nurbs', dim: 3, isRational: false,
          order: [dU + 1, dV + 1],
          cvCount: [nU, nV],
          knots: [knotsU, knotsV],
          cvs,
          cvStride: [nV * 3, 3],
        };
        return {
          surface,
          outerLoop: { curves: [], orientation: face.outerLoop?.orientation ?? true },
          innerLoops: [],
          orientation: face.orientation ?? true,
          tolerance: face.tolerance ?? 1e-6,
        };
      }),
      edges: [],
      vertices: [],
      isClosed: shell.isClosed ?? true,
    })),
  };
}

// ── Singleton loader ──────────────────────────────────────────────────────────

let _mod: KernModule | null = null;

/**
 * Load and instantiate the Emscripten WASM module. Idempotent — subsequent
 * calls return the already-loaded module immediately.
 */
async function getKern(): Promise<KernModule> {
  if (_mod) return _mod;
  // Dynamic import so the module loads cleanly even before cmake produces kern.js.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { default: createKernModule } = await import(/* @vite-ignore */ _kernJsPath) as any;
  const wasmUrl = new URL(_kernWasmPath, import.meta.url).href;
  _mod = await createKernModule({ locateFile: () => wasmUrl }) as KernModule;
  return _mod;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return an empty ChangeMap consistent with ChangeMap in brep-boolean.ts.
 * `modified` is a Map (not a plain object) per the type definition.
 */
function emptyChangeMap(): ChangeMap {
  return {
    created:  [],
    modified: new Map<string, string>(),
    deleted:  [],
  };
}

/**
 * Assert the kernel is loaded. Throws a descriptive error rather than
 * surfacing a cryptic null-dereference if startup order is wrong.
 */
function assertLoaded(): KernModule {
  if (!_mod) {
    throw new Error(
      'WasmBooleanBackend: kernel not initialised. ' +
      'Call `await initWasmKernel()` before using WasmBooleanBackend.',
    );
  }
  return _mod;
}

/**
 * Invoke a binary boolean kernel method and translate the JSON result to a
 * BrepResult. Synchronous — relies on the module already being loaded.
 */
function callBinaryOp(
  method: 'boolUnion' | 'boolDifference' | 'boolIntersection',
  a: Brep,
  b: Brep,
  backendId: string,
): BrepResult {
  const mod = assertLoaded();

  let aJson: string;
  let bJson: string;
  try {
    aJson = brepToKernJson(a);
    bJson = brepToKernJson(b);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'NUMERICAL_FAILURE',
        message: `brepToKernJson: ${e instanceof Error ? e.message : String(e)}`,
        backend: backendId,
      },
    };
  }

  let raw: string;
  try {
    raw = mod[method](aJson, bJson);
  } catch (e) {
    return {
      ok: false,
      error: {
        code:    'NUMERICAL_FAILURE',
        message: e instanceof Error ? e.message : String(e),
        backend: backendId,
      },
    };
  }

  let resp: KernResponse;
  try {
    resp = JSON.parse(raw) as KernResponse;
  } catch {
    return {
      ok: false,
      error: {
        code:    'NUMERICAL_FAILURE',
        message: `kern returned non-JSON: ${raw.slice(0, 120)}`,
        backend: backendId,
      },
    };
  }

  if (!resp.ok) {
    return {
      ok: false,
      error: {
        code:    'NUMERICAL_FAILURE',
        message: (resp as KernErr).error,
        backend: backendId,
      },
    };
  }

  return {
    ok:        true,
    brep:      kernResultToBrep((resp as KernOk).result),
    changeMap: emptyChangeMap(),
  };
}

// ── WasmBooleanBackend ────────────────────────────────────────────────────────

/**
 * IBooleanBackend backed by the C++/Emscripten geometry kernel.
 *
 * Priority 20 — beats NurbsBooleanBackend (10) and ToyBooleanBackend (0).
 *
 * Synchronous contract: all IBooleanBackend methods are synchronous.
 * The async WASM init must be resolved before the first operation call.
 * Use `await initWasmKernel()` at app startup; register with `registerBackend`.
 */
class WasmBooleanBackend implements IBooleanBackend {
  readonly id       = 'wasm-kern' as const;
  readonly priority = 20;

  /**
   * a ∪ b — result contains all material from both inputs.
   * Reference: OCCT BRepAlgoAPI_Fuse.
   */
  union(a: Brep, b: Brep, _opts?: BooleanOptions): BrepResult {
    return callBinaryOp('boolUnion', a, b, this.id);
  }

  /**
   * a − b — result contains material in a but not in b.
   * Reference: OCCT BRepAlgoAPI_Cut (a = objects, b = tools).
   */
  difference(a: Brep, b: Brep, _opts?: BooleanOptions): BrepResult {
    return callBinaryOp('boolDifference', a, b, this.id);
  }

  /**
   * a ∩ b — result contains only material shared by both inputs.
   * Reference: OCCT BRepAlgoAPI_Common.
   */
  intersection(a: Brep, b: Brep, _opts?: BooleanOptions): BrepResult {
    return callBinaryOp('boolIntersection', a, b, this.id);
  }

  /**
   * Section edges of a ∩ b (curves at the intersection boundary).
   * Not yet implemented in the C++ kernel — returns NOT_IMPLEMENTED.
   * Reference: OCCT BRepAlgoAPI_Section.
   */
  section(_a: Brep, _b: Brep, _opts?: BooleanOptions): BrepResult {
    return {
      ok: false,
      error: {
        code:    'NOT_IMPLEMENTED',
        message: 'wasm-kern section not implemented',
        backend: this.id,
      },
    };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Singleton backend instance. Register after `await initWasmKernel()`. */
export const wasmBooleanBackend = new WasmBooleanBackend();

/** True once the WASM module has been loaded via `initWasmKernel()`. */
export function isKernLoaded(): boolean {
  return _mod !== null;
}

/**
 * Load the C++/WASM kernel. Must be awaited once at application startup
 * before `wasmBooleanBackend` is registered or used.
 *
 * Example:
 *   await initWasmKernel()
 *   registerBackend(wasmBooleanBackend)
 */
export async function initWasmKernel(): Promise<void> {
  await getKern();
}

/**
 * Return the raw KernModule for direct JSON-string calls.
 * Only valid after `await initWasmKernel()`. Used by parity-gate tests to
 * bypass TypeScript Brep serialization and call the kern with kern-format JSON.
 * Throws if the module is not yet loaded.
 */
export function rawKernModule(): KernModule {
  return assertLoaded();
}
