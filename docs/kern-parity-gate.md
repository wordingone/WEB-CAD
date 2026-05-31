# Kernel Parity Gate

The parity gate validates the C++ WASM kernel against the replicad/OCCT oracle on a
fixed geometric corpus. CI must pass this gate before any kernel PR merges to master.

---

## 1. Oracle

**Oracle backend:** replicad/OpenCASCADE via the existing `worker.ts` path.

Invocation: call `executeAndMesh(jsCode)` in the replicad worker, extract the resulting
mesh, compute volume via the shoelace formula on the mesh triangles, count faces from
the BrepShell.

```typescript
// Utility used by parity tests
async function oracleBoolean(
    op: "union" | "difference" | "intersection",
    aCode: string,
    bCode: string
): Promise<{ volume: number; faceCount: number; brep: Brep }> {
    const result = await replicadBackend[op](
        await buildBrep(aCode), await buildBrep(bCode)
    );
    if (!result.ok) throw new Error(result.error.message);
    return {
        volume:    meshVolume(result.brep),
        faceCount: brepFaceCount(result.brep),
        brep:      result.brep,
    };
}
```

The kernel under test is the `WasmBooleanBackend` at priority 20. Tests force both
backends explicitly via `{ backend: "wasm-kern" }` and `{ backend: "replicad" }`.

---

## 2. Geometric Corpus

### Case 1 — Planar/Planar: Intersecting Boxes

```
A = axis-aligned box  2×2×2  centered at origin
B = axis-aligned box  2×2×2  centered at (1, 0, 0)
```

Operations: union, difference (A−B), intersection.
Expected: intersection is a 2×2×1 box. Exact face counts for simple axis-aligned cases.

### Case 2 — Planar/Curved: Box Intersecting Sphere

```
A = axis-aligned box  4×4×4  centered at origin
B = unit sphere       r=1    centered at (2, 0, 0)
```

Operations: union, difference (A−B), intersection.
Expected: intersection is a hemisphere cap. Volume comparison only (curved faces
preclude exact face count matching).

### Case 3 — Curved/Curved: Two Spheres Partial Overlap

```
A = unit sphere  r=1  centered at (0, 0, 0)
B = unit sphere  r=1  centered at (1, 0, 0)
```

Operations: union, intersection.
Overlap distance = 1.0 < 2r. Expected intersection volume: lens formula
`V = π h²(3r−h)/3` where `h = r − d/2 = 0.5`. Two lenses → total = 2 × V(0.5).

### Case 4 — Near-Tangent: Two Unit Spheres

```
A = unit sphere  r=1  centered at (0, 0, 0)
B = unit sphere  r=1  centered at (1.99, 0, 0)
```

Centers 1.99m apart → touching distance 0.01m. Near-tangent intersection.
Gate: kernel must not crash or return NaN. Volume within 0.1% of oracle.

### Case 5 — Grazing: Two Cylinders

```
A = cylinder  r=0.5  h=4  axis along Z
B = cylinder  r=0.5  h=4  axis along Y, center offset (1.0, 0, 0)
```

Cylinders graze along a line. Gate: kernel returns `ok:true` or a typed
`NUMERICAL_FAILURE` error — no unhandled exception, no NaN in result geometry.

### Case 6 — Degenerate: Identical Spheres

```
A = B = unit sphere  r=1  centered at origin
```

Union should return A unchanged (or equivalent volume). Difference returns empty.
Gate: no crash, no infinite loop, `ok:true` for union, `ok:true` for difference with
empty/zero-volume result OR typed `EMPTY_INPUT` error code.

### Case 7 — Fuzz: 100 Random Pairs

```typescript
for (let seed = 0; seed < 100; seed++) {
    const rng = lcg(seed);
    const shapeA = randomShape(rng);   // box | sphere | cylinder
    const shapeB = randomShape(rng);
    const op     = randomOp(rng);      // union | difference | intersection
    // Assert: no thrown exception, no NaN in result, no non-manifold
}
```

`randomShape` samples center in `[−2,2]³`, radius/half-dimensions in `[0.25, 1.5]`.
Gate: zero crashes, zero NaN values in vertex coordinates, zero naked-edge violations
when `isClosed === true`.

---

## 3. Numerical Comparison Criteria

### SSI Curve Points

For each point `p` on a kernel-computed SSI curve, with parameters `(u₀,v₀)` on A and
`(u₁,v₁)` on B:

```
|A(u₀,v₀) − p|  < 1e-3   // point lies on surface A
|B(u₁,v₁) − p|  < 1e-3   // point lies on surface B
```

Tolerance `1e-3` is 10× the SSI convergence tolerance `1e-4` to account for floating
point accumulation during marching.

### Boolean Volume

```
|V_kern − V_oracle| / V_oracle < 0.001   // within 0.1%
```

Applies to cases 1–4. Not applied to cases 5–6 (grazing/degenerate) or fuzz (crash-free
only).

### Face Count

Exact face count match is asserted only for **axis-aligned box/box** cases (cases 1a
intersection, 1b union) where the expected count is analytically known. All curved-face
cases compare volume only.

---

## 4. Pass Criteria

A kernel build passes the parity gate if and only if:

1. Cases 1–4: `ok: true`, volume within 0.1% of oracle, face count exact for case 1.
2. Case 5 (grazing): `ok: true` OR `error.code === "NUMERICAL_FAILURE"` — no unhandled
   exception, no NaN.
3. Case 6 (identical): union `ok: true`, difference `ok: true` or `EMPTY_INPUT`, no
   crash.
4. Case 7 (fuzz): 0 crashes, 0 NaN vertices, 0 naked-edge violations for closed shells,
   across all 100 seeds.
5. SSI accuracy (cases 2–3): all intersection curve points within `1e-3` of both
   surfaces.

---

## 5. Test File

`web/test/parity-gate.test.ts`

```typescript
import { describe, it, expect, beforeAll } from "bun:test";
import { initKern }       from "../src/kern/wasm-backend";
import { initReplicad }   from "../src/kern/replicad-backend";
import { brepFaceCount }  from "../src/kern/nurbs-brep";
import { meshVolume }     from "../src/kern/mesh-utils";
import { corpus }         from "./fixtures/parity-corpus";

beforeAll(async () => {
    await Promise.all([initKern(), initReplicad()]);
});

describe("Parity gate — kern vs oracle", () => {
    for (const c of corpus) {
        it(c.name, async () => {
            const kern    = await kernBackend[c.op](c.a, c.b);
            const oracle  = await replicadBackend[c.op](c.a, c.b);

            expect(kern.ok).toBe(true);
            expect(oracle.ok).toBe(true);
            if (!kern.ok || !oracle.ok) return;

            const vKern   = meshVolume(kern.brep);
            const vOracle = meshVolume(oracle.brep);

            if (c.checkVolume) {
                expect(Math.abs(vKern - vOracle) / vOracle).toBeLessThan(0.001);
            }
            if (c.exactFaceCount !== undefined) {
                expect(brepFaceCount(kern.brep)).toBe(c.exactFaceCount);
            }
        });
    }
});

describe("Parity gate — fuzz", () => {
    it("100 random pairs: no crash / NaN / non-manifold", async () => {
        for (let seed = 0; seed < 100; seed++) {
            const { a, b, op } = randomPair(seed);
            const result = await kernBackend[op](a, b);
            if (result.ok) {
                assertNoNaN(result.brep);
                assertManifold(result.brep);
            } else {
                expect(result.error.code).not.toBe(undefined);
            }
        }
    });
});
```

`corpus` is defined in `web/test/fixtures/parity-corpus.ts` as a typed array of
`{ name, op, a, b, checkVolume, exactFaceCount? }` records, one per case 1–6.
