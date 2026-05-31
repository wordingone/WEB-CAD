# kern parity report — Phase B source complete

Date: 2026-05-31
Status: PHASE_B_SOURCE_COMPLETE

## Phase B file inventory

| File | Lines | Limit | Status |
|---|---|---|---|
| kern/ssi.h | 35 | 100 | OK |
| kern/ssi.cpp | 463 | 500 | OK |
| kern/brep.h | 193 | — | OK |
| kern/brep.cpp | 327 | — | OK |
| kern/boolean.h | 49 | 100 | OK |
| kern/boolean.cpp | 295 | 500 | OK |
| kern/module.cpp | 160 | 200 | OK |
| CMakeLists.txt | 76 | 80 | OK |
| web/src/nurbs/wasm-boolean-backend.ts | 233 | — | OK |
| web/test/parity-gate.test.ts | 398 | — | OK |

## Component summaries

### SSI — kern/ssi.cpp

Simultaneous Newton on 4D parameter space (u0, v0, u1, v1). Three stages:

- Stage 1 `findSeeds()`: recursive bbox subdivision to `maxDepth=8`. Patches sampled on 5x5 grid; boxes expanded by `tol` to catch near-touching pairs. Splits the larger-diagonal surface at each recursion level. Seeds deduplicated within `tol*5` in 3D.
- Stage 2 `newtonRefine()`: builds 3x4 Jacobian via central FD (h=1e-6). Min-norm step `Δp = Jᵀ(JJᵀ)⁻¹F` via LDLT with FullPivLU fallback. Clamps to domain. Near-tangent guard `|nA × nB| < 1e-3` at entry and convergence.
- Stage 3 `marchCurve()`: tangent `nA × nB` direction, param update via gradient projection + Newton re-refinement. Terminates on near-tangent (`tlen < 1e-12`), divergence (`|F| > tol*100`), closure (step > 10, dist < step*1.5), or `maxSteps`. Visited 4D keys (quantized to `tol*5`) deduplicate re-traversal.

NURBS evaluation: de Boor tensor-product, row-major control net. No external NURBS library — compiles under GCC/Clang and Emscripten.

### BRep data model — kern/brep.h + kern/brep.cpp

Mirrors TS types in `web/src/nurbs/nurbs-brep.ts` exactly:
- `NurbsCurve`, `NurbsSurface` with explicit `cvCount`/`cvCountU`/`cvCountV`.
- `TrimEdge` (curve3d + curveUV), `TrimLoop` (isOuter), `BrepFace`, `BrepEdge` (`faceIndex2=-1` = naked), `BrepVertex`, `BrepShell`, `Brep`.
- Cox-de Boor basis (Algorithms A2.1, A2.2 from Piegl & Tiller).
- JSON serialization: `cvs` as flat `[x,y,z,w,...]`; `faceIndex2=-1` round-trips cleanly (TS maps `null` ↔ `-1`).

### Boolean pipeline — kern/boolean.h + kern/boolean.cpp

Stages:
1. SSI grid across all face pairs.
2. Containment test: +Z ray cast, 6x6 grid sample per face, odd-crossing = inside.
3. Face classification: `classify(inside, fromB)` returns `{keep, reverse}` per op.
4. Face split via `_applyFaceSplit()`: SSI curve → inner trim loop (keepOuter) or new outer loop.
5. Assembly: `_stitchEdges()` matches half-edge endpoints within `tol`; sets `isClosed` if no naked edges.
6. Healing: `_healSlivers()` removes zero-span edges.

No-intersection fallback:
- UNION → concatenate both shells.
- DIFFERENCE → return A.
- INTERSECTION → error "no intersection".

Complex split guard: SSI curves with >32 points refused with "complex split not yet implemented".

### WASM boundary — kern/module.cpp + CMakeLists.txt

`module.cpp` (160 lines):
- Primary dispatch: `kern_boolean(jsonRequest)` — single-dispatch entry point used by `wasm-boolean-backend.ts`.
- Convenience wrappers: `js_boolUnion`, `js_boolDifference`, `js_boolIntersection` (two-arg form).
- Phase C stubs: `kern_fillet`, `kern_chamfer`, `kern_loft` — return NOT_IMPLEMENTED.
- SSI pass-through: `kern_ssi`.
- Five `EMSCRIPTEN_BINDINGS` entries: `kern_boolean`, `kern_ssi`, `kern_fillet`, `kern_chamfer`, `kern_loft` + three per-op wrappers.

`CMakeLists.txt` (76 lines):
- `cmake_minimum_required(3.25)`, C++20.
- FetchContent: Eigen 3.4.0, nlohmann/json 3.11.3.
- `kern_lib STATIC` (brep.cpp, ssi.cpp, boolean.cpp) — no module.cpp.
- Emscripten: suffix `.mjs`, `EXPORT_ES6=1`, `MODULARIZE=1`, `ALLOW_MEMORY_GROWTH`, `-O3 -msimd128`, `--closure 1`.
- `EXPORTED_FUNCTIONS`: `_kern_boolean`, `_kern_ssi`, `_kern_fillet`, `_kern_chamfer`, `_kern_loft`.
- `EXPORTED_RUNTIME_METHODS`: `UTF8ToString`, `stringToUTF8`, `lengthBytesUTF8`.
- Native: Google Test 1.14.0, `add_subdirectory(kern/test)`.

### TS binding — web/src/nurbs/wasm-boolean-backend.ts

- `WasmBooleanBackend` implements `IBooleanBackend`, `priority=20` (beats nurbs=10, toy=0), `id='wasm-kern'`.
- Async init: `initWasmKernel()` / `getKern()` singleton, `locateFile` for `.wasm` URL.
- `callBinaryOp()` private helper handles JSON serialisation, `assertLoaded()` guard, method dispatch, response parsing, error translation.
- `section()` returns `NOT_IMPLEMENTED` as specified.
- `emptyChangeMap()` returns `{ created:[], modified: new Map(), deleted:[] }` matching actual `ChangeMap` type.
- One `@ts-expect-error` on `kern.js` import (generated Emscripten module, no TS types); no `@ts-ignore`.

### Parity harness — web/test/parity-gate.test.ts

398 lines covering:

- SSI corpus (5 cases): orthogonal flat/tilted planes produce ≥1 curve; residual < 1e-3; partial-overlap guard; near-tangent (0.05 deg) no crash no NaN; grazing/coincident no crash no NaN.
- Boolean cases (3, WASM-gated): fuse identical boxes, cut smaller from larger, intersect overlapping — each returns ok-or-typed-error without throw.
- Volume oracle TODOs (3): fuse/cut/intersect 1x1x1 vs 0.5x0.5x0.5, target volumes vs replicad baseline.
- Fuzz (1): 20 iterations, `i%3`/`i%2` dimension variation, all three ops, vertex finite-check on `ok` results.

## Compilation

Status: PENDING — emsdk installing at `B:/M/emsdk`.

After emsdk activate:

```
cmake \
  -DCMAKE_TOOLCHAIN_FILE=B:/M/emsdk/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake \
  -B build \
  && cmake --build build
```

Output: `build/kern.mjs` + `build/kern.wasm`.

Copy `kern.mjs` and `kern.wasm` to `web/public/` (or `web/src/`) so the Vite import resolves.

## Runtime parity

Status: PENDING compilation.

Once `kern.wasm` builds: run `bun test web/test/parity-gate.test.ts` — WASM-gated cases will activate and verify the boolean pipeline against the TS ssi parity cases.

## Phase C next

- `kern/fillet.h` + `kern/fillet.cpp` — edge fillet via rolling-ball algorithm.
- `kern/chamfer.h` + `kern/chamfer.cpp` — edge chamfer.
- `kern/loft.h` + `kern/loft.cpp` — profile lofting.
- Replace `kern_fillet`/`kern_chamfer`/`kern_loft` NOT_IMPLEMENTED stubs in `module.cpp`.

---

# kern parity report — Phase C source complete

Date: 2026-05-30
Status: PHASE_C_SOURCE_COMPLETE

## Phase C file inventory

| File | Lines | Limit | Status |
|---|---|---|---|
| kern/fillet.h | 62 | 80 | OK |
| kern/fillet.cpp | 375 | 400 | OK |
| kern/chamfer.h | 59 | — | OK |
| kern/chamfer.cpp | 238 | — | OK |
| kern/loft.h | 57 | 80 | OK |
| kern/loft.cpp | 386 | 400 | OK |
| kern/module.cpp | — | 200 | updated |
| CMakeLists.txt | — | 80 | updated |

## Component summaries

### fillet — kern/fillet.cpp

Rolling-ball fillet for planar-face edges. Algorithm:

- `uniformKnots` — clamped open-end knot vector helper.
- `lineCurve` / `lineUV` — degree-1 NURBS stub curves for trim edges.
- `isSurfacePlanar` — 3×3 normal sampling; rejects curved faces with `"curved-face fillet not yet implemented: edge N"`.
- `buildArcCrossSection` — rational quadratic (degree-2) NURBS arc via Piegl & Tiller §7.1; mid-point weight `w = cos(sweep/2)`.
- `extrudeCurve` — sweeps cross-section along edge direction producing degreeU=arc.degree, degreeV=1 ruled surface.
- `fullDomainOuterLoop` / `innerTrimAtV` — trim loop builders.

Main `fillet()` flow:
1. Collects non-naked edges when `edgeIndices` is empty.
2. Rejects curved faces; skips co-planar edges (theta < 1e-3).
3. Computes dihedral theta, offset `d = radius / tan(theta/2)`, bisector arc centre.
4. Builds cylindrical fillet surface + inner trim loops on both adjacent faces.
5. Assembles trimmed original faces + fillet patches into a new `BrepShell`; marks filleted edges naked.

### chamfer — kern/chamfer.cpp

Equal-distance offset chamfer for planar-face edges.

- `planarFaceNormal` — 4-point interior UV sample; rejects curved faces.
- `offsetEdgeOnFace` — in-plane offset by `distance` along `(faceNormal × edgeTangent)` direction; returns degree-1 NURBS line.
- `ruledSurface` — bilinear NurbsSurface (degreeU=degreeV=1, 2×2 CV) between the two offset lines.
- `makeTrimLoop` — 3-edge inner TrimLoop (setback line + two cap curves) to clip adjacent faces at offset lines. UV curves identity-mapped.
- `chamfer()` — validates, fans out per edge via `processEdge`, deep-copies all faces, appends inner trim loops, appends chamfer faces, assembles result BrepShell. `isClosed=false` (half-edge adjacency wiring deferred).

### loft — kern/loft.cpp

Global-interpolation skinning (Piegl & Tiller §9.2) + planar caps.

1. **Validation** — degree, cvCount, knot identity across profiles.
2. **Chord-length v parameterisation** — centroid-to-centroid distances normalised to [0,1].
3. **v knot vector** — P&T Eq. 9.8 averaging formula; interpolation degree `dv = min(3, N-1)`.
4. **Column-by-column global interpolation** — collocation matrix A (shared; v params uniform), `fullPivLu` solve per column.
5. **Planar caps** (`buildPlanarCap`) — degree-1×1 bilinear NurbsSurface at profile z-plane; profile used as outer trim loop; start-cap normals flipped outward.

### module.cpp updates

- Uncommented `#include "fillet.h"`, `"chamfer.h"`, `"loft.h"`.
- Added `#include <nlohmann/json.hpp>`.
- Replaced `kern_fillet` stub with real implementation: parses `{ brep, radius, edges }`, calls `kern::fillet()`, returns `{ ok, result }` or `{ ok, error }`.
- Replaced `kern_chamfer` stub: parses `{ brep, distance, edges }`, calls `kern::chamfer()`.
- Replaced `kern_loft` stub: parses `{ profiles[], degree }`, deserialises each `NurbsCurve`, calls `kern::loft()`.
- All six `EMSCRIPTEN_BINDINGS` entries retained; stubs are now live.

### CMakeLists.txt updates

- `kern_lib STATIC` now includes `kern/fillet.cpp`, `kern/chamfer.cpp`, `kern/loft.cpp`.

## Full build command

```
cmake \
  -DCMAKE_TOOLCHAIN_FILE=B:/M/emsdk/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake \
  -B build/wasm \
  -DCMAKE_BUILD_TYPE=Release \
  && cmake --build build/wasm --target kern
```

Output: `build/wasm/kern.mjs` + `build/wasm/kern.wasm`

Copy both to `web/public/` for Vite URL import.

## Runtime parity

Status: PENDING compilation (emsdk required).

Once built: `bun test web/test/parity-gate.test.ts` — WASM-gated boolean cases activate; Phase C fillet/chamfer/loft exercised via parity-gate once test cases added.
