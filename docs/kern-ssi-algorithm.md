# SSI Algorithm — Surface-Surface Intersection

## 1. Problem Statement

Given two NURBS surfaces A(u₀,v₀) and B(u₁,v₁), find the set of curves
C = { (u₀,v₀,u₁,v₁) : A(u₀,v₀) = B(u₁,v₁) }.

This is a system of 3 scalar equations in 4 unknowns; the solution is generically a
1-manifold (a curve). The algorithm proceeds in three stages:

1. **Seed finding** — locate one point per intersection curve via recursive bounding-box
   subdivision.
2. **Newton refinement** — converge each seed to tolerance using simultaneous Newton
   on the full 4D parameter space.
3. **Curve marching** — trace each intersection curve from its seed in both directions.

The TypeScript implementation in `web/src/kern/ssi.ts` uses alternating projection for
stage 2 (simpler, more robust on degenerate surfaces). The C++ kernel upgrades stage 2
to simultaneous Newton with the Moore-Penrose pseudoinverse for faster convergence on
well-conditioned cases, while retaining the alternating fallback for near-tangent cases.

---

## 2. Stage 1: Seed Finding

### Algorithm

Recursively subdivide both surfaces' parameter domains. At each recursion level, compute
axis-aligned bounding boxes for each sub-patch and test for overlap. Recurse only into
overlapping pairs; discard non-overlapping pairs early.

```
findSeeds(A, B, depthA, depthB, seeds):
    boxA = AlignedBox3d(A.evalRange())
    boxB = AlignedBox3d(B.evalRange())
    if not boxA.intersects(boxB): return

    if depthA >= maxDepth and depthB >= maxDepth:
        seed = newtonRefine(A.center(), B.center())
        if seed.converged: seeds.push_back(seed)
        return

    split whichever surface has the larger box diagonal:
        for each sub-patch: findSeeds(subA, subB, d+1, depthB, seeds)
```

### Eigen AlignedBox3d Usage

```cpp
#include <Eigen/Geometry>

Eigen::AlignedBox3d patchBounds(const NurbsSurface& s,
                                double u0, double u1,
                                double v0, double v1,
                                int samples = 5) {
    Eigen::AlignedBox3d box;
    for (int i = 0; i <= samples; ++i)
        for (int j = 0; j <= samples; ++j) {
            double u = u0 + (u1-u0)*i/samples;
            double v = v0 + (v1-v0)*j/samples;
            box.extend(s.eval(u, v));
        }
    return box;
}
```

Sampling at a 6×6 grid per sub-patch is sufficient for degree ≤5 surfaces at depth 6
(sub-patch spans ≤ 1/64 of the original domain).

### Deduplication

Seeds within `tol * 5` of an existing accepted seed in 3D are discarded. Quantized
parameter keys `(u₀, v₀, u₁, v₁)` rounded to `tol * 5` bins prevent duplicate
traversal during marching.

---

## 3. Stage 2: Simultaneous Newton Refinement

### Mathematical Derivation

Define the residual:

```
F(u₀, v₀, u₁, v₁) = A(u₀,v₀) − B(u₁,v₁)   ∈ ℝ³
```

The Jacobian is a 3×4 matrix:

```
J = [∂A/∂u₀ | ∂A/∂v₀ | −∂B/∂u₁ | −∂B/∂v₁]
```

where each column is a 3-vector (partial derivative of the surface). Since F ∈ ℝ³ and
the parameter vector p = (u₀,v₀,u₁,v₁) ∈ ℝ⁴, the system is underdetermined (one
degree of freedom — motion along the intersection curve). We seek the **minimum-norm**
Newton step via the Moore-Penrose pseudoinverse:

```
Δp = Jᵀ (J Jᵀ)⁻¹ F
```

`J Jᵀ` is a 3×3 matrix; its inverse is computed via Eigen's LLT (Cholesky) when `J Jᵀ`
is positive definite, or `FullPivLU` as fallback.

The step is:

```
p_{n+1} = p_n − Δp
```

### C++ Pseudocode

```cpp
struct SsiPoint {
    Eigen::Vector4d params;    // (u0, v0, u1, v1)
    Eigen::Vector3d point;     // 3D point on intersection
    bool converged;
};

SsiPoint newtonRefine(const NurbsSurface& A, const NurbsSurface& B,
                      Eigen::Vector4d p0, const SsiOptions& opts) {
    const int MAX_ITER = 50;
    Eigen::Vector4d p = p0;

    for (int iter = 0; iter < MAX_ITER; ++iter) {
        Eigen::Vector3d  a  = A.eval(p[0], p[1]);
        Eigen::Vector3d  b  = B.eval(p[2], p[3]);
        Eigen::Vector3d  F  = a - b;

        if (F.norm() < opts.tolerance) {
            return { p, a, true };
        }

        // Build J (3×4)
        Eigen::Matrix<double,3,4> J;
        J.col(0) =  A.du(p[0], p[1]);
        J.col(1) =  A.dv(p[0], p[1]);
        J.col(2) = -B.du(p[2], p[3]);
        J.col(3) = -B.dv(p[2], p[3]);

        // JJᵀ is 3×3
        Eigen::Matrix3d JJt = J * J.transpose();

        // Minimum-norm step: Δp = Jᵀ (JJᵀ)⁻¹ F
        Eigen::Vector3d z = JJt.ldlt().solve(F);
        if (JJt.ldlt().info() != Eigen::Success) {
            // Fallback: full pivot LU
            z = JJt.fullPivLu().solve(F);
        }
        p -= J.transpose() * z;

        // Clamp to domain
        p[0] = std::clamp(p[0], A.domainU[0], A.domainU[1]);
        p[1] = std::clamp(p[1], A.domainV[0], A.domainV[1]);
        p[2] = std::clamp(p[2], B.domainU[0], B.domainU[1]);
        p[3] = std::clamp(p[3], B.domainV[0], B.domainV[1]);
    }

    // Final convergence check at tol*2 (prevents seed drift during march)
    Eigen::Vector3d a = A.eval(p[0], p[1]);
    Eigen::Vector3d b = B.eval(p[2], p[3]);
    bool ok = (a - b).norm() < opts.tolerance * 2.0;
    return { p, a, ok };
}
```

### Near-Tangent Handling

Before entering the Newton loop, check the angle between surface normals:

```cpp
Eigen::Vector3d nA = A.du(p[0],p[1]).cross(A.dv(p[0],p[1])).normalized();
Eigen::Vector3d nB = B.du(p[2],p[3]).cross(B.dv(p[2],p[3])).normalized();
double sinAngle = nA.cross(nB).norm();   // |nA × nB| = sin(θ)

if (sinAngle < 1e-3) {
    // Near-tangent: fall back to alternating projection (cheaper, more stable)
    return alternatingProjectionRefine(A, B, p0, opts);
}
```

The alternating fallback mirrors the TypeScript implementation (MAX_ITER=50, alternating
closest-point projections on A then B).

---

## 4. Stage 3: Curve Marching

### Tangent Direction

At each march point, the intersection curve tangent is the cross-product of the surface
normals:

```cpp
Eigen::Vector3d nA = A.du(u0,v0).cross(A.dv(u0,v0));
Eigen::Vector3d nB = B.du(u1,v1).cross(B.dv(u1,v1));
Eigen::Vector3d tangent = nA.cross(nB);
double tlen = tangent.norm();
if (tlen < 1e-12) break;  // near-tangent: march halts
tangent /= tlen;
```

### Adaptive Step

Default step is `opts.marchStep = 0.05` (world units). Step is scaled by local curvature:
higher curvature → smaller step. The curvature estimate uses `d²A/du²` at the current
point; if the local radius of curvature r < 10 × marchStep, step is clamped to r / 10.

### March in Both Directions

```
marchHalf(A, B, seed, +tangent, opts, curve_fwd)
marchHalf(A, B, seed, -tangent, opts, curve_bwd)
result_curve = reverse(curve_bwd) + seed + curve_fwd
```

### Termination Conditions

1. `tlen < 1e-12` — near-tangent; curve locally degenerate.
2. Newton refinement after step fails: `|F| > tol * 100` — diverged, stop this direction.
3. Closed-curve detection: new point within `step * 1.5` of the seed (or any earlier
   point in the first 10 steps skipped to avoid premature closure).
4. `maxMarchSteps` (default 5000) exceeded — safety cap.

### Deduplication

Visited parameter keys quantized to `tol * 5` bins in 4D parameter space prevent
re-traversal of already-marched curve segments during multi-curve scenarios.

---

## 5. Degenerate Cases

| Case | Detection | Behavior |
|---|---|---|
| Coincident surfaces | All seeds converge; `|F|=0` everywhere | Return `SsiResult::COINCIDENT`; no curves emitted |
| No intersection | Bounding boxes never overlap at any subdivision depth | Return empty curve list |
| Grazing (tangent touch) | `sinAngle < 1e-3` at every seed | Newton may converge to a point; march halts immediately; return single degenerate point curve |
| Self-intersecting | SSI of surface with itself | Caller must detect `a == b` identity; guard with pointer comparison before calling `ssi()` |

---

## 6. C++ Function Signature

```cpp
// kern/ssi.h

namespace kern {

struct SsiOptions {
    double tolerance     = 1e-4;   // geometric tolerance, metres
    double marchStep     = 0.05;   // default march distance, world units
    int    maxMarchSteps = 5000;   // safety cap per curve half
    int    maxSubdivDepth = 6;     // 2^6 = 64 sub-patches per axis
};

struct SsiCurve {
    std::vector<Eigen::Vector3d>  points;     // 3D points on intersection
    std::vector<Eigen::Vector2d>  paramsA;    // (u0,v0) on surface A
    std::vector<Eigen::Vector2d>  paramsB;    // (u1,v1) on surface B
    bool isClosed;
};

enum class SsiStatus {
    OK, COINCIDENT, NO_INTERSECTION, NUMERICAL_FAILURE
};

struct SsiResult {
    SsiStatus           status;
    std::vector<SsiCurve> curves;
    std::string         message;   // non-empty on NUMERICAL_FAILURE
};

SsiResult ssi(const NurbsSurface& a,
              const NurbsSurface& b,
              const SsiOptions&   opts = {});

} // namespace kern
```
