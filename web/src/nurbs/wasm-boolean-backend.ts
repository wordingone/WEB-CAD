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

// @ts-expect-error — kern.js is a generated Emscripten module; no TS declarations exist.
import createKernModule from '../../kern.js';
import kernWasmUrl from '../../kern.wasm?url';

import type { Brep } from './nurbs-brep';
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
 * The kernel returns `{ ok: true, brep: <BrepJson> }` on success and
 * `{ ok: false, error: <string> }` on failure — never throws.
 */
interface KernModule {
  boolUnion(aJson: string, bJson: string): string;
  boolDifference(aJson: string, bJson: string): string;
  boolIntersection(aJson: string, bJson: string): string;
  fillet(brepJson: string, radius: number): string;
  chamfer(brepJson: string, distance: number): string;
  loft(profilesJson: string): string;
}

// ── Kernel response shape (parsed from JSON) ──────────────────────────────────

type KernOk  = { ok: true;  brep: unknown };
type KernErr = { ok: false; error: string };
type KernResponse = KernOk | KernErr;

// ── Singleton loader ──────────────────────────────────────────────────────────

let _mod: KernModule | null = null;

/**
 * Load and instantiate the Emscripten WASM module. Idempotent — subsequent
 * calls return the already-loaded module immediately.
 */
async function getKern(): Promise<KernModule> {
  if (_mod) return _mod;
  _mod = await createKernModule({ locateFile: () => kernWasmUrl }) as KernModule;
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

  const aJson = JSON.stringify(a);
  const bJson = JSON.stringify(b);

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
    brep:      (resp as KernOk).brep as Brep,
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
