// kern/ssi.cpp — Surface-Surface Intersection
// Stages: bbox seed-finding, simultaneous Newton refinement, tangent marching.
// All NURBS evaluation via de Boor's algorithm; no external NURBS library dependency.
//
// Reference: docs/kern-ssi-algorithm.md

#include "ssi.h"
#include <Eigen/Geometry>
#include <algorithm>
#include <cmath>
#include <unordered_set>
#include <string>

namespace kern {

// ---------------------------------------------------------------------------
// §0 — NURBS evaluation helpers (de Boor, tensor-product)
// ---------------------------------------------------------------------------

// Find the knot span index: largest i s.t. knots[i] <= t < knots[i+1].
// Clamped: returns n (= nCtrl - 1) when t == knots.back().
static int knotSpan(const std::vector<double>& knots, int degree, int nCtrl, double t) {
    if (t >= knots[nCtrl]) return nCtrl - 1;  // clamp to last valid span
    int lo = degree, hi = nCtrl;
    while (hi - lo > 1) {
        int mid = (lo + hi) / 2;
        (t < knots[mid]) ? hi = mid : lo = mid;
    }
    return lo;
}

// De Boor: evaluate a NURBS curve (homogeneous) at parameter t.
// Returns homogeneous Vec4 (x*w, y*w, z*w, w).
static Eigen::Vector4d deBoor(const std::vector<double>& knots,
                               const std::vector<Eigen::Vector4d>& ctrl,
                               int degree, int nCtrl, double t) {
    int span = knotSpan(knots, degree, nCtrl, t);
    // Local copy of p+1 control points in the active span
    std::vector<Eigen::Vector4d> d(degree + 1);
    for (int i = 0; i <= degree; ++i) d[i] = ctrl[span - degree + i];
    for (int r = 1; r <= degree; ++r) {
        for (int j = degree; j >= r; --j) {
            double denom = knots[span + j - r + 1] - knots[span + j - degree];
            double alpha = (std::abs(denom) < 1e-14) ? 0.0
                         : (t - knots[span + j - degree]) / denom;
            d[j] = (1.0 - alpha) * d[j - 1] + alpha * d[j];
        }
    }
    return d[degree];
}

// Evaluate tensor-product NURBS surface at (u, v). Returns Cartesian Vec3.
static Eigen::Vector3d evalSurf(const NurbsSurface& s, double u, double v) {
    // Build isoparametric curve in v-direction at parameter u, then evaluate at v.
    int spanU = knotSpan(s.knotsU, s.degreeU, s.cvCountU, u);
    // Basis functions in U: compute temporary control points along V
    std::vector<Eigen::Vector4d> tempCtrl(s.cvCountV);
    for (int j = 0; j < s.cvCountV; ++j) {
        // Collect cvCountU control points at column j
        std::vector<Eigen::Vector4d> col(s.degreeU + 1);
        for (int i = 0; i <= s.degreeU; ++i)
            col[i] = s.cvs[(spanU - s.degreeU + i) * s.cvCountV + j];
        // De Boor in U direction for this column
        std::vector<Eigen::Vector4d> d(s.degreeU + 1);
        for (int i = 0; i <= s.degreeU; ++i) d[i] = col[i];
        for (int r = 1; r <= s.degreeU; ++r) {
            for (int jj = s.degreeU; jj >= r; --jj) {
                double denom = s.knotsU[spanU + jj - r + 1] - s.knotsU[spanU + jj - s.degreeU];
                double alpha = (std::abs(denom) < 1e-14) ? 0.0
                             : (u - s.knotsU[spanU + jj - s.degreeU]) / denom;
                d[jj] = (1.0 - alpha) * d[jj - 1] + alpha * d[jj];
            }
        }
        tempCtrl[j] = d[s.degreeU];
    }
    Eigen::Vector4d hw = deBoor(s.knotsV, tempCtrl, s.degreeV, s.cvCountV, v);
    double w = (std::abs(hw[3]) < 1e-14) ? 1.0 : hw[3];
    return Eigen::Vector3d(hw[0] / w, hw[1] / w, hw[2] / w);
}

// Partial derivatives via central finite difference (h = 1e-6).
static Eigen::Vector3d partialU(const NurbsSurface& s, double u, double v) {
    constexpr double h = 1e-6;
    double u0 = std::max(s.knotsU.front(), u - h);
    double u1 = std::min(s.knotsU.back(),  u + h);
    return (evalSurf(s, u1, v) - evalSurf(s, u0, v)) / (u1 - u0);
}

static Eigen::Vector3d partialV(const NurbsSurface& s, double u, double v) {
    constexpr double h = 1e-6;
    double v0 = std::max(s.knotsV.front(), v - h);
    double v1 = std::min(s.knotsV.back(),  v + h);
    return (evalSurf(s, u, v1) - evalSurf(s, u, v0)) / (v1 - v0);
}

static Eigen::Vector3d surfNormal(const NurbsSurface& s, double u, double v) {
    return partialU(s, u, v).cross(partialV(s, u, v)).normalized();
}

// ---------------------------------------------------------------------------
// §1 — Seed data structure
// ---------------------------------------------------------------------------

struct Seed {
    double u0, v0;   // params on surface A
    double u1, v1;   // params on surface B
    Eigen::Vector3d pt;
    bool degenerate = false;
};

// ---------------------------------------------------------------------------
// §2 — Newton refinement (simultaneous, min-norm step via pseudoinverse)
// ---------------------------------------------------------------------------

struct RefineResult {
    Seed   seed;
    bool   converged = false;
};

static RefineResult newtonRefine(const NurbsSurface& A, const NurbsSurface& B,
                                  double u0, double v0, double u1, double v1,
                                  const SsiOptions& opts) {
    Eigen::Vector4d p(u0, v0, u1, v1);

    // Near-tangent check at initial guess
    Eigen::Vector3d nA0 = surfNormal(A, p[0], p[1]);
    Eigen::Vector3d nB0 = surfNormal(B, p[2], p[3]);
    bool degenerate = (nA0.cross(nB0).norm() < 1e-3);

    for (int iter = 0; iter < opts.maxIter; ++iter) {
        Eigen::Vector3d ptA = evalSurf(A, p[0], p[1]);
        Eigen::Vector3d ptB = evalSurf(B, p[2], p[3]);
        Eigen::Vector3d F   = ptA - ptB;

        if (F.norm() < opts.tolerance) {
            // Re-check near-tangent at converged point
            Eigen::Vector3d nAc = surfNormal(A, p[0], p[1]);
            Eigen::Vector3d nBc = surfNormal(B, p[2], p[3]);
            bool degen = (nAc.cross(nBc).norm() < 1e-3);
            Seed s;
            s.u0 = p[0]; s.v0 = p[1];
            s.u1 = p[2]; s.v1 = p[3];
            s.pt = ptA;
            s.degenerate = degen;
            return { s, true };
        }

        // Build J (3×4)
        Eigen::Matrix<double, 3, 4> J;
        J.col(0) =  partialU(A, p[0], p[1]);
        J.col(1) =  partialV(A, p[0], p[1]);
        J.col(2) = -partialU(B, p[2], p[3]);
        J.col(3) = -partialV(B, p[2], p[3]);

        // Min-norm step: Δp = Jᵀ (J Jᵀ)⁻¹ F
        Eigen::Matrix3d JJt = J * J.transpose();
        Eigen::Vector3d z;
        Eigen::LDLT<Eigen::Matrix3d> ldlt(JJt);
        if (ldlt.info() == Eigen::Success) {
            z = ldlt.solve(F);
        } else {
            z = JJt.fullPivLu().solve(F);
        }
        p -= J.transpose() * z;

        // Clamp to domain
        p[0] = std::clamp(p[0], A.knotsU.front(), A.knotsU.back());
        p[1] = std::clamp(p[1], A.knotsV.front(), A.knotsV.back());
        p[2] = std::clamp(p[2], B.knotsU.front(), B.knotsU.back());
        p[3] = std::clamp(p[3], B.knotsV.front(), B.knotsV.back());
    }

    // Final loose check (tol * 2) to accept marginally-converged seeds
    Eigen::Vector3d ptA = evalSurf(A, p[0], p[1]);
    Eigen::Vector3d ptB = evalSurf(B, p[2], p[3]);
    bool ok = (ptA - ptB).norm() < opts.tolerance * 2.0;
    Seed s;
    s.u0 = p[0]; s.v0 = p[1];
    s.u1 = p[2]; s.v1 = p[3];
    s.pt = ptA;
    s.degenerate = degenerate;
    return { s, ok };
}

// ---------------------------------------------------------------------------
// §3 — Bounding-box seed finding via recursive subdivision
// ---------------------------------------------------------------------------

static Eigen::AlignedBox3d patchBounds(const NurbsSurface& s,
                                        double ua, double ub,
                                        double va, double vb,
                                        int samples = 4) {
    Eigen::AlignedBox3d box;
    for (int i = 0; i <= samples; ++i)
        for (int j = 0; j <= samples; ++j) {
            double u = ua + (ub - ua) * i / samples;
            double v = va + (vb - va) * j / samples;
            box.extend(evalSurf(s, u, v));
        }
    return box;
}

static void findSeedsRec(const NurbsSurface& A, const NurbsSurface& B,
                          double uA0, double uA1, double vA0, double vA1,
                          double uB0, double uB1, double vB0, double vB1,
                          int depthA, int depthB,
                          const SsiOptions& opts,
                          std::vector<Seed>& seeds) {
    // Compute bounding boxes via 5×5 sampling
    Eigen::AlignedBox3d boxA = patchBounds(A, uA0, uA1, vA0, vA1);
    Eigen::AlignedBox3d boxB = patchBounds(B, uB0, uB1, vB0, vB1);

    // Expand boxes by tolerance to catch near-touching pairs
    boxA.min() -= Eigen::Vector3d::Constant(opts.tolerance);
    boxA.max() += Eigen::Vector3d::Constant(opts.tolerance);
    boxB.min() -= Eigen::Vector3d::Constant(opts.tolerance);
    boxB.max() += Eigen::Vector3d::Constant(opts.tolerance);

    if (!boxA.intersects(boxB)) return;

    if (depthA >= opts.maxDepth && depthB >= opts.maxDepth) {
        // Leaf: attempt Newton refinement from midpoint
        double mu0 = 0.5 * (uA0 + uA1);
        double mv0 = 0.5 * (vA0 + vA1);
        double mu1 = 0.5 * (uB0 + uB1);
        double mv1 = 0.5 * (vB0 + vB1);
        auto r = newtonRefine(A, B, mu0, mv0, mu1, mv1, opts);
        if (r.converged) seeds.push_back(r.seed);
        return;
    }

    // Choose which surface to subdivide: pick the one with larger bbox diagonal
    double diagA = (depthA < opts.maxDepth) ? boxA.diagonal().norm() : 0.0;
    double diagB = (depthB < opts.maxDepth) ? boxB.diagonal().norm() : 0.0;

    if (diagA >= diagB) {
        // Split A along its longer axis
        double midU = 0.5 * (uA0 + uA1);
        double midV = 0.5 * (vA0 + vA1);
        bool splitU = ((uA1 - uA0) >= (vA1 - vA0));
        if (splitU) {
            findSeedsRec(A, B, uA0, midU, vA0, vA1, uB0, uB1, vB0, vB1, depthA + 1, depthB, opts, seeds);
            findSeedsRec(A, B, midU, uA1, vA0, vA1, uB0, uB1, vB0, vB1, depthA + 1, depthB, opts, seeds);
        } else {
            findSeedsRec(A, B, uA0, uA1, vA0, midV, uB0, uB1, vB0, vB1, depthA + 1, depthB, opts, seeds);
            findSeedsRec(A, B, uA0, uA1, midV, vA1, uB0, uB1, vB0, vB1, depthA + 1, depthB, opts, seeds);
        }
    } else {
        // Split B
        double midU = 0.5 * (uB0 + uB1);
        double midV = 0.5 * (vB0 + vB1);
        bool splitU = ((uB1 - uB0) >= (vB1 - vB0));
        if (splitU) {
            findSeedsRec(A, B, uA0, uA1, vA0, vA1, uB0, midU, vB0, vB1, depthA, depthB + 1, opts, seeds);
            findSeedsRec(A, B, uA0, uA1, vA0, vA1, midU, uB1, vB0, vB1, depthA, depthB + 1, opts, seeds);
        } else {
            findSeedsRec(A, B, uA0, uA1, vA0, vA1, uB0, uB1, vB0, midV, depthA, depthB + 1, opts, seeds);
            findSeedsRec(A, B, uA0, uA1, vA0, vA1, uB0, uB1, midV, vB1, depthA, depthB + 1, opts, seeds);
        }
    }
}

static std::vector<Seed> findSeeds(const NurbsSurface& A, const NurbsSurface& B,
                                    const SsiOptions& opts) {
    std::vector<Seed> raw;
    findSeedsRec(A, B,
                 A.knotsU.front(), A.knotsU.back(), A.knotsV.front(), A.knotsV.back(),
                 B.knotsU.front(), B.knotsU.back(), B.knotsV.front(), B.knotsV.back(),
                 0, 0, opts, raw);

    // Deduplicate: discard seeds within tol*5 of an already-accepted seed
    std::vector<Seed> deduped;
    deduped.reserve(raw.size());
    for (const Seed& s : raw) {
        bool dup = false;
        for (const Seed& acc : deduped) {
            if ((s.pt - acc.pt).norm() < opts.tolerance * 5.0) { dup = true; break; }
        }
        if (!dup) deduped.push_back(s);
    }
    return deduped;
}

// ---------------------------------------------------------------------------
// §4 — Curve marching
// ---------------------------------------------------------------------------

// Quantize a 4D parameter tuple to a hash key for visited-set tracking.
static std::string paramKey(double u0, double v0, double u1, double v1, double bin) {
    auto qi = [&](double x) { return static_cast<long long>(std::round(x / bin)); };
    return std::to_string(qi(u0)) + "," + std::to_string(qi(v0)) + ","
         + std::to_string(qi(u1)) + "," + std::to_string(qi(v1));
}

// March one half of the intersection curve from seed in direction +1 or -1.
// Returns points appended to `curve` (exclusive of seed itself).
static void marchHalf(const NurbsSurface& A, const NurbsSurface& B,
                       const Seed& seed,
                       int direction,   // +1 or -1
                       const SsiOptions& opts,
                       SsiCurve& curve,
                       std::unordered_set<std::string>& visited) {
    double u0 = seed.u0, v0 = seed.v0;
    double u1 = seed.u1, v1 = seed.v1;
    Eigen::Vector3d pt = seed.pt;
    const double binSize = opts.tolerance * 5.0;
    const Eigen::Vector3d& startPt = seed.pt;

    for (int step = 0; step < opts.maxSteps; ++step) {
        // Compute surface normals and intersection tangent
        Eigen::Vector3d nA = surfNormal(A, u0, v0);
        Eigen::Vector3d nB = surfNormal(B, u1, v1);
        Eigen::Vector3d tang = nA.cross(nB);
        double tlen = tang.norm();
        if (tlen < 1e-12) break;  // near-tangent: stop marching
        tang = tang * (direction / tlen);

        // Step forward in 3D
        Eigen::Vector3d ptNext = pt + opts.marchStep * tang;

        // Re-refine from current params as initial guess
        // Project ptNext onto each surface to get updated param estimate
        // (simplified: use current params + perturbation from step)
        // Estimate new params via gradient step on A
        Eigen::Vector3d dA_du = partialU(A, u0, v0);
        Eigen::Vector3d dA_dv = partialV(A, u0, v0);
        double dtu = dA_du.dot(tang) * opts.marchStep;
        double dtv = dA_dv.dot(tang) * opts.marchStep;
        double denom = dA_du.squaredNorm() + dA_dv.squaredNorm();
        double u0n = u0, v0n = v0;
        if (denom > 1e-14) {
            u0n = u0 + dA_du.dot(ptNext - pt) / denom;
            v0n = v0 + dA_dv.dot(ptNext - pt) / denom;
        }

        Eigen::Vector3d dB_du = partialU(B, u1, v1);
        Eigen::Vector3d dB_dv = partialV(B, u1, v1);
        double denomB = dB_du.squaredNorm() + dB_dv.squaredNorm();
        double u1n = u1, v1n = v1;
        if (denomB > 1e-14) {
            u1n = u1 + dB_du.dot(ptNext - pt) / denomB;
            v1n = v1 + dB_dv.dot(ptNext - pt) / denomB;
        }

        // Clamp initial guesses to domain
        u0n = std::clamp(u0n, A.knotsU.front(), A.knotsU.back());
        v0n = std::clamp(v0n, A.knotsV.front(), A.knotsV.back());
        u1n = std::clamp(u1n, B.knotsU.front(), B.knotsU.back());
        v1n = std::clamp(v1n, B.knotsV.front(), B.knotsV.back());

        auto r = newtonRefine(A, B, u0n, v0n, u1n, v1n, opts);

        // Divergence guard
        if (!r.converged) {
            Eigen::Vector3d pA = evalSurf(A, r.seed.u0, r.seed.v0);
            Eigen::Vector3d pB = evalSurf(B, r.seed.u1, r.seed.v1);
            if ((pA - pB).norm() > opts.tolerance * 100.0) break;
        }

        u0 = r.seed.u0; v0 = r.seed.v0;
        u1 = r.seed.u1; v1 = r.seed.v1;
        pt = r.seed.pt;

        // Closed-curve detection: within step*1.5 of start after enough steps
        if (step > 10 && (pt - startPt).norm() < opts.marchStep * 1.5) {
            curve.closed = true;
            break;
        }

        // Visited parameter check (avoid re-tracing)
        std::string key = paramKey(u0, v0, u1, v1, binSize);
        if (visited.count(key)) break;
        visited.insert(key);

        curve.pts3d.push_back(pt);
        curve.paramsA.emplace_back(u0, v0);
        curve.paramsB.emplace_back(u1, v1);
    }
}

static SsiCurve marchCurve(const NurbsSurface& A, const NurbsSurface& B,
                             const Seed& seed, const SsiOptions& opts,
                             std::unordered_set<std::string>& visited) {
    SsiCurve curve;
    curve.degenerate = seed.degenerate;

    // Forward half
    SsiCurve fwd;
    fwd.closed = false;
    marchHalf(A, B, seed, +1, opts, fwd, visited);

    // Backward half
    SsiCurve bwd;
    bwd.closed = false;
    marchHalf(A, B, seed, -1, opts, bwd, visited);

    // Assemble: reverse(bwd) + seed + fwd
    for (int i = static_cast<int>(bwd.pts3d.size()) - 1; i >= 0; --i) {
        curve.pts3d.push_back(bwd.pts3d[i]);
        curve.paramsA.push_back(bwd.paramsA[i]);
        curve.paramsB.push_back(bwd.paramsB[i]);
    }
    // Seed point itself
    curve.pts3d.push_back(seed.pt);
    curve.paramsA.emplace_back(seed.u0, seed.v0);
    curve.paramsB.emplace_back(seed.u1, seed.v1);
    // Forward points
    for (size_t i = 0; i < fwd.pts3d.size(); ++i) {
        curve.pts3d.push_back(fwd.pts3d[i]);
        curve.paramsA.push_back(fwd.paramsA[i]);
        curve.paramsB.push_back(fwd.paramsB[i]);
    }

    curve.closed = fwd.closed || bwd.closed;
    return curve;
}

// ---------------------------------------------------------------------------
// §5 — Main entry point
// ---------------------------------------------------------------------------

SsiResult ssi(const NurbsSurface& a, const NurbsSurface& b, const SsiOptions& opts) {
    SsiResult result;
    result.ok = true;

    // Stage 1: find seeds
    std::vector<Seed> seeds;
    try {
        seeds = findSeeds(a, b, opts);
    } catch (const std::exception& e) {
        result.ok    = false;
        result.error = std::string("seed finding failed: ") + e.what();
        return result;
    }

    if (seeds.empty()) return result;  // no intersection

    // Stage 3: march each seed into a curve
    std::unordered_set<std::string> visited;
    const double binSize = opts.tolerance * 5.0;

    for (const Seed& seed : seeds) {
        // Skip seeds whose parameter position was already traced
        std::string key = paramKey(seed.u0, seed.v0, seed.u1, seed.v1, binSize);
        if (visited.count(key)) continue;
        visited.insert(key);

        try {
            SsiCurve curve = marchCurve(a, b, seed, opts, visited);
            if (curve.pts3d.size() >= 2 || seed.degenerate) {
                result.curves.push_back(std::move(curve));
            }
        } catch (const std::exception& e) {
            result.ok    = false;
            result.error = std::string("marching failed: ") + e.what();
            return result;
        }
    }

    return result;
}

} // namespace kern
