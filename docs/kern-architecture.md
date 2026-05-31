# Geometry Kernel Architecture

## 1. Overview

### Purpose

The C++/WASM geometry kernel (`kern/`) implements the compute-intensive operations that the current TypeScript layer either delegates to replicad/OpenCASCADE or avoids entirely:

- Surface-surface intersection (SSI) with full curve output
- Boolean solids (union, difference, intersection, section)
- Fillet and chamfer on BRep edges
- Loft between profile curves
- Offset surfaces and shells

### What Replicad Does Now

Replicad wraps `opencascade.js` (an Emscripten port of OpenCASCADE Technology). It handles mesh generation, basic solid creation (`makeBaseBox`, `makeCylinder`), and STL export. The current `worker.ts` executes a JavaScript string in the replicad context and returns a mesh blob.

Replicad is retained as the **oracle backend** for parity testing (see `kern-parity-gate.md`). Its `IBooleanBackend` registration at priority 10 means it answers automatically when the WASM kernel is unavailable.

### Oracle Relationship

```
IBooleanBackend registry
  priority 20 → WasmBooleanBackend   (kern/ — this kernel)
  priority 10 → ReplicadBackend      (existing worker.ts path)
```

`resolveBackend()` with no explicit `backend` option always picks the highest registered priority. Callers that need the oracle explicitly pass `{ backend: "replicad" }`.

---

## 2. C++ BRep Data Model

All geometric types mirror the TypeScript definitions in `nurbs-brep.ts` exactly; the JSON serialization across the WASM boundary is the interchange contract.

```cpp
// kern/brep.h

#include <Eigen/Core>
#include <vector>
#include <optional>

namespace kern {

using Vec3 = Eigen::Vector3d;
using Vec4 = Eigen::Vector4d;  // homogeneous control points (x,y,z,w)

// NURBS curve: degree d, n+1 control points, n+d+2 knots
struct NurbsCurve {
    int degree;
    std::vector<double>  knots;      // size: n + degree + 2
    std::vector<Vec4>    ctrlPts;    // homogeneous; w=1 for non-rational
    std::array<double,2> domain;     // [uMin, uMax]
};

// NURBS surface: bi-degree (du, dv)
struct NurbsSurface {
    int degreeU, degreeV;
    std::vector<double> knotsU;      // size: nu + degreeU + 2
    std::vector<double> knotsV;      // size: nv + degreeV + 2
    // Control net stored row-major: ctrlPts[i*nv + j] = P_{i,j}
    std::vector<Vec4>   ctrlPts;
    int nu, nv;                      // control point counts per axis
    std::array<double,2> domainU;
    std::array<double,2> domainV;
};

// Trim loop: ordered boundary curves in surface parameter space
struct TrimLoop {
    std::vector<NurbsCurve> curves;
    bool orientation;                // true = outward normal consistent
};

struct BrepFace {
    NurbsSurface surface;
    TrimLoop     outerLoop;
    std::vector<TrimLoop> innerLoops;
    bool   orientation;
    double tolerance;                // default: BREP_DEFAULT_TOLERANCE = 1e-6
};

struct BrepEdge {
    NurbsCurve curve;
    int  faceIndex1;
    std::optional<int> faceIndex2;   // null for naked edges
    double tolerance;
};

struct BrepVertex {
    Vec3             point;
    std::vector<int> edgeIndices;
    double           tolerance;
};

struct BrepShell {
    std::vector<BrepFace>   faces;
    std::vector<BrepEdge>   edges;
    std::vector<BrepVertex> vertices;
    bool isClosed;
};

struct Brep {
    std::vector<BrepShell> shells;
};

} // namespace kern
```

`BREP_DEFAULT_TOLERANCE = 1e-6` matches the TypeScript constant. Every face carries its own per-face tolerance to accommodate imported geometry with inconsistent precision.

---

## 3. Boolean Evaluation Pipeline

The pipeline follows the classical BRep boolean decomposition:

```
Input A, B (Brep)
        │
        ▼
[1] SSI — Surface-Surface Intersection
        Compute intersection curves between every face pair (A_i, B_j).
        Output: list of 3D curve segments with (u,v) parameter pairs on
        each surface. Algorithm: kern-ssi-algorithm.md.
        │
        ▼
[2] Face Classification
        Each face of A and B is classified relative to the other solid:
        IN (interior), OUT (exterior), ON-SAME, ON-REVERSED.
        Method: point-in-solid test (ray casting) at face centroid.
        │
        ▼
[3] Trim & Split
        Faces crossed by SSI curves are split along those curves.
        Sub-faces inherit the parent surface; new trim loops built from
        SSI curve segments + original boundary arcs.
        │
        ▼
[4] Face Selection (operation-specific)
        Union:        keep OUT faces of A + OUT faces of B
        Difference:   keep OUT faces of A + IN faces of B (reversed)
        Intersection: keep IN faces of A + IN faces of B
        Section:      keep ON-SAME faces
        │
        ▼
[5] Assembly & Topology Repair
        Stitch selected faces: match edges within tolerance, weld vertices.
        Build new BrepEdge/BrepVertex connectivity for result BrepShell.
        Mark isClosed = true if no naked edges remain.
        │
        ▼
[6] Healing
        Remove slivers (edges shorter than tolerance).
        Merge coplanar faces sharing a full common edge.
        Re-parameterize degenerate trim curves if needed.
        │
        ▼
Output Brep + ChangeMap
```

`ChangeMap` tracks shell index provenance for parametric history:
- `created`: shell indices that have no ancestor in A or B
- `modified`: map from `"a:<i>"` / `"b:<j>"` to `"result:<k>"`
- `deleted`: shells fully consumed by the operation

---

## 4. C++ Module Layout

```
kern/
├── brep.h          — BRep type definitions (all structs above)
├── brep.cpp        — brepFromShell, brepConcat, transformBrep,
│                     brepIsSolid, brepFaceCount, brepNakedEdgeCount
├── ssi.h           — SsiResult, SsiOptions, ssi() declaration
├── ssi.cpp         — seed finding, Newton refinement, curve marching
├── boolean.h       — BooleanResult, booleanUnion/Diff/Intersect/Section
├── boolean.cpp     — full pipeline (stages 1-6 above)
├── fillet.h/.cpp   — edge fillet: radius, affected edge indices
├── chamfer.h/.cpp  — edge chamfer: distance or distance-pair
├── loft.h/.cpp     — loft between N profile NurbsCurves
└── module.cpp      — Emscripten bindings; JSON in → JSON out entry points
```

`module.cpp` is the sole file that includes `<emscripten/bind.h>`. Every other `.cpp` compiles cleanly under both native GCC/Clang (for unit tests) and Emscripten.

---

## 5. WASM Boundary

### Serialization Contract

All data crosses the WASM boundary as UTF-8 JSON strings. `nlohmann/json` (header-only, v3.11+) handles serialization on the C++ side; `JSON.parse`/`JSON.stringify` on the TypeScript side.

Entry points exported by `module.cpp`:

```cpp
// module.cpp (Emscripten EXPORTED_FUNCTIONS)
std::string kern_boolean(const std::string& jsonRequest) noexcept;
std::string kern_ssi    (const std::string& jsonRequest) noexcept;
std::string kern_fillet (const std::string& jsonRequest) noexcept;
std::string kern_chamfer(const std::string& jsonRequest) noexcept;
std::string kern_loft   (const std::string& jsonRequest) noexcept;
```

All functions return a JSON string of shape `{ ok: true, result: ... }` or `{ ok: false, error: { code, message } }`. No C++ exceptions cross the boundary; every catch block serializes to the error envelope.

### Emscripten Build Flags

```cmake
target_link_options(kern PRIVATE
    -sEXPORT_ES6=1
    -sMODULARIZE=1
    -sSINGLE_FILE=0          # separate .wasm asset for Vite ?url import
    -sEXPORTED_FUNCTIONS='["_kern_boolean","_kern_ssi","_kern_fillet","_kern_chamfer","_kern_loft"]'
    -sEXPORTED_RUNTIME_METHODS='["UTF8ToString","stringToUTF8","lengthBytesUTF8"]'
    -O3
    -msimd128
    --closure 1
)
```

### Vite ?url Import Pattern

Following the same pattern as `replicad-opencascadejs` (from `worker.ts`):

```typescript
// kern/wasm-backend.ts
import kernWasmUrl from "../kern/kern.wasm?url";

let _kernReady: Promise<KernModule> | null = null;

export function initKern(): Promise<KernModule> {
  if (_kernReady) return _kernReady;
  _kernReady = KernModuleFactory({
    locateFile: () => kernWasmUrl,
  });
  return _kernReady;
}
```

`?url` rewrites to a content-hashed CDN path at build time; the runtime never hardcodes `/kern.wasm`.

### WasmBooleanBackend Registration

```typescript
// kern/wasm-backend.ts
import { registerBackend } from "../boolean-registry";

registerBackend({
  id: "wasm-kern",
  priority: 20,           // above replicad's priority 10
  union:        (a, b, opts) => kernOp("union",        a, b, opts),
  difference:   (a, b, opts) => kernOp("difference",   a, b, opts),
  intersection: (a, b, opts) => kernOp("intersection", a, b, opts),
  section:      (a, b, opts) => kernOp("section",      a, b, opts),
});
```

`registerBackend` is defined in `boolean-registry.ts` per the `IBooleanBackend` interface.

---

## 6. Build System

### CMakeLists.txt Overview

```cmake
cmake_minimum_required(VERSION 3.25)
project(kern LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)

# Eigen — header-only, fetched via FetchContent
include(FetchContent)
FetchContent_Declare(eigen
    GIT_REPOSITORY https://gitlab.com/libeigen/eigen.git
    GIT_TAG        3.4.0)
FetchContent_MakeAvailable(eigen)

# nlohmann/json — header-only
FetchContent_Declare(json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG        v3.11.3)
FetchContent_MakeAvailable(json)

add_library(kern_lib STATIC
    kern/brep.cpp kern/ssi.cpp kern/boolean.cpp
    kern/fillet.cpp kern/chamfer.cpp kern/loft.cpp)
target_include_directories(kern_lib PUBLIC kern/ ${eigen_SOURCE_DIR} ${json_SOURCE_DIR}/include)

if(EMSCRIPTEN)
    add_executable(kern kern/module.cpp)
    target_link_libraries(kern PRIVATE kern_lib)
    # Emscripten flags applied here (see §5)
    set_target_properties(kern PROPERTIES SUFFIX ".mjs")
else()
    # Native build for unit tests (Google Test)
    enable_testing()
    add_subdirectory(kern/test)
endif()
```

### emsdk Toolchain

```bash
# One-time setup
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install 3.1.50 && ./emsdk activate 3.1.50
source ./emsdk_env.sh   # or emsdk_env.bat on Windows

# WASM build
emcmake cmake -B build-wasm -DCMAKE_BUILD_TYPE=Release
cmake --build build-wasm --target kern -j$(nproc)
# Outputs: build-wasm/kern.mjs + kern.wasm
# Copy kern.wasm to web/public/kern/ for Vite serving
```

### Third-Party Dependencies

| Library | Version | Inclusion | Notes |
|---|---|---|---|
| Eigen | 3.4.0 | FetchContent header-only | Linear algebra, AlignedBox3d |
| nlohmann/json | 3.11.3 | FetchContent header-only | WASM boundary serialization |
| Google Test | 1.14.0 | FetchContent (native only) | kern/test/ unit tests |

No dynamic libraries. The WASM binary is fully self-contained after linking.
