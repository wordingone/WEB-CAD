// kern/loft.cpp — Loft (skinning) surface implementation.
//
// Algorithm: global-interpolation skinning, Piegl & Tiller §9.2.
//
// Notation follows P&T:
//   N      = number of profiles (>= 2)
//   n      = N - 1
//   m      = profile cvCount
//   d_u    = profile degree (u direction)
//   d_v    = interpolation degree in v direction (cubic = 3, or N-1 if < 3)
//   v_k    = chord-length parameter values for k = 0..n
//   Q_{i,k}= column i of profile k's control points  (Cartesian, w-divided)
//   P_{i,j}= interpolated control net of result surface

#include "loft.h"

#include <Eigen/Dense>
#include <algorithm>
#include <cmath>
#include <numeric>
#include <sstream>
#include <stdexcept>

namespace kern {

// ── Internal helpers ──────────────────────────────────────────────────────────

namespace {

// Compute Euclidean distance between two homogeneous CVs (w-divided).
static double cvDist(const Vec4& a, const Vec4& b) {
    double wa = (std::abs(a.w()) < 1e-14) ? 1.0 : a.w();
    double wb = (std::abs(b.w()) < 1e-14) ? 1.0 : b.w();
    Vec3 pa = a.head<3>() / wa;
    Vec3 pb = b.head<3>() / wb;
    return (pa - pb).norm();
}

// Centroid of a profile curve's CVs (Cartesian, w-divided).
static Vec3 profileCentroid(const NurbsCurve& c) {
    Vec3 sum = Vec3::Zero();
    for (const Vec4& cv : c.cvs) {
        double w = (std::abs(cv.w()) < 1e-14) ? 1.0 : cv.w();
        sum += cv.head<3>() / w;
    }
    return sum / static_cast<double>(c.cvs.size());
}

// Build a uniform clamped knot vector for n+1 points and degree d.
// Ref: P&T §9.2, Eq. (9.8) variant; standard clamped uniform.
static std::vector<double> clampedUniformKnots(int n, int d) {
    // n+1 data points → n+1 control points → knot vector size n+d+2
    int m = n + d + 2;
    std::vector<double> knots(m, 0.0);
    // Fill interior knots using averaging of v_k (here uniform)
    // For the global interpolation we construct the knot vector from the
    // parameter sequence v_k using the averaging formula (P&T Eq. 9.8).
    // Called with already-computed params passed in via the wrapper below.
    return knots; // placeholder; real path uses buildKnotsFromParams
}

// Build clamped knot vector from parameter sequence v[0..n] and degree d.
// P&T Algorithm A9.1, knot averaging Eq. (9.8).
static std::vector<double> buildKnotsFromParams(
        const std::vector<double>& v, int d) {
    int n = static_cast<int>(v.size()) - 1; // n+1 data points
    int m = n + d + 2;                       // knot vector length
    std::vector<double> knots(m, 0.0);
    // Clamp first d+1 and last d+1 knots
    for (int i = m - d - 1; i < m; ++i) knots[i] = 1.0;
    // Interior knots: average of d consecutive parameters
    for (int j = 1; j <= n - d; ++j) {
        double s = 0.0;
        for (int k = j; k <= j + d - 1; ++k) s += v[k];
        knots[j + d] = s / static_cast<double>(d);
    }
    return knots;
}

// Find knot span (P&T Algorithm A2.1).
static int findSpan(int n, int d, double t, const std::vector<double>& knots) {
    if (t >= knots[n + 1]) return n;
    if (t <= knots[d])     return d;
    int lo = d, hi = n + 1, mid = (lo + hi) / 2;
    while (t < knots[mid] || t >= knots[mid + 1]) {
        (t < knots[mid]) ? hi = mid : lo = mid;
        mid = (lo + hi) / 2;
    }
    return mid;
}

// Evaluate non-zero B-spline basis N[0..d] (P&T Algorithm A2.2).
static std::vector<double> basisFns(int span, double t, int d,
                                    const std::vector<double>& knots) {
    std::vector<double> N(d + 1, 0.0);
    std::vector<double> left(d + 1), right(d + 1);
    N[0] = 1.0;
    for (int j = 1; j <= d; ++j) {
        left[j]  = t - knots[span + 1 - j];
        right[j] = knots[span + j] - t;
        double saved = 0.0;
        for (int r = 0; r < j; ++r) {
            double denom = right[r + 1] + left[j - r];
            if (std::abs(denom) < 1e-14) { N[r] = saved; saved = 0.0; }
            else {
                double tmp = N[r] / denom;
                N[r] = saved + right[r + 1] * tmp;
                saved = left[j - r] * tmp;
            }
        }
        N[j] = saved;
    }
    return N;
}

// Build the (n+1)x(n+1) B-spline collocation matrix A for global interpolation.
// A[k][j] = N_j^d(v_k).  Ref: P&T §9.2.
static Eigen::MatrixXd buildCollocationMatrix(
        const std::vector<double>& v,
        const std::vector<double>& knots,
        int d) {
    int n = static_cast<int>(v.size()) - 1;
    Eigen::MatrixXd A = Eigen::MatrixXd::Zero(n + 1, n + 1);
    A(0, 0) = 1.0;
    A(n, n) = 1.0;
    for (int k = 1; k < n; ++k) {
        int span = findSpan(n, d, v[k], knots);
        std::vector<double> N = basisFns(span, v[k], d, knots);
        for (int j = 0; j <= d; ++j)
            A(k, span - d + j) = N[j];
    }
    return A;
}

// Solve A * X = B column-by-column for each spatial component.
// Returns X (n+1) x 3 (Cartesian).
static Eigen::MatrixXd solveInterpolation(
        const Eigen::MatrixXd& A,
        const Eigen::MatrixXd& B) {
    // A is square; use LU decomposition.
    return A.fullPivLu().solve(B);
}

// Build a planar cap NurbsSurface from a profile curve.
// Strategy: compute centroid, build a bilinear patch from the AABB of the
// profile CVs lying in the profile plane, then record the profile as the
// outerLoop trim curve (3D = profile itself, UV = linear edge in [0,1]^2).
static BrepFace buildPlanarCap(const NurbsCurve& profile,
                               double tolerance) {
    // Compute centroid and AABB of the profile CVs
    Vec3 centroid = profileCentroid(profile);
    Vec3 lo(1e30, 1e30, 1e30), hi(-1e30, -1e30, -1e30);
    for (const Vec4& cv : profile.cvs) {
        double w = (std::abs(cv.w()) < 1e-14) ? 1.0 : cv.w();
        Vec3 p = cv.head<3>() / w;
        lo = lo.cwiseMin(p);
        hi = hi.cwiseMax(p);
    }
    // Pad AABB slightly to avoid degenerate surface
    double pad = std::max((hi - lo).maxCoeff() * 0.01, tolerance);
    lo.array() -= pad;
    hi.array() += pad;

    // Bilinear NURBS surface (degree 1 x 1) spanning the AABB.
    // Four corner CVs (w=1).
    NurbsSurface surf;
    surf.degreeU = 1;
    surf.degreeV = 1;
    surf.cvCountU = 2;
    surf.cvCountV = 2;
    surf.knotsU = {0.0, 0.0, 1.0, 1.0};
    surf.knotsV = {0.0, 0.0, 1.0, 1.0};
    // Layout: cvs[i*2+j] = P_{i,j}
    // Use the dominant plane of the profile: take the z-value from centroid.
    double z = centroid.z();
    surf.cvs = {
        Vec4(lo.x(), lo.y(), z, 1.0),  // P_{0,0}
        Vec4(lo.x(), hi.y(), z, 1.0),  // P_{0,1}
        Vec4(hi.x(), lo.y(), z, 1.0),  // P_{1,0}
        Vec4(hi.x(), hi.y(), z, 1.0),  // P_{1,1}
    };

    // Build the outer trim loop from the profile curve (identity: the profile
    // boundary IS the trim boundary in 3D; UV curve is a unit-square loop).
    TrimEdge te3d;
    te3d.curve3d = profile;
    te3d.tolerance = tolerance;

    // UV curve: linear loop along the AABB in parameter space.
    // Four edges of the unit square [0,1]^2 — degree-1 segments.
    // Represented as a single degree-1 polyline NurbsCurve in UV.
    NurbsCurve uvLoop;
    uvLoop.degree = 1;
    uvLoop.cvCount = 5;
    uvLoop.knots = {0.0, 0.0, 0.25, 0.5, 0.75, 1.0, 1.0};
    // Four corners of [0,1]^2 then back to start (closed loop)
    uvLoop.cvs = {
        Vec4(0.0, 0.0, 0.0, 1.0),
        Vec4(1.0, 0.0, 0.0, 1.0),
        Vec4(1.0, 1.0, 0.0, 1.0),
        Vec4(0.0, 1.0, 0.0, 1.0),
        Vec4(0.0, 0.0, 0.0, 1.0),
    };
    te3d.curveUV = uvLoop;

    TrimLoop outerLoop;
    outerLoop.isOuter = true;
    outerLoop.edges.push_back(te3d);

    BrepFace face;
    face.surface   = surf;
    face.outerLoop = outerLoop;
    face.orientation = true;
    face.tolerance   = tolerance;
    return face;
}

} // anonymous namespace

// ── Public entry point ────────────────────────────────────────────────────────

LoftResult loft(const std::vector<NurbsCurve>& profiles,
                const LoftOptions& opts) {
    // ── 1. Validate ──────────────────────────────────────────────────────────

    int N = static_cast<int>(profiles.size());
    if (N < 2) {
        return {false, {}, "loft requires at least 2 profiles"};
    }

    int duRef    = profiles[0].degree;
    int mRef     = profiles[0].cvCount;
    const auto& kRef = profiles[0].knots;

    for (int k = 1; k < N; ++k) {
        if (profiles[k].degree != duRef) {
            std::ostringstream ss;
            ss << "profile " << k << " degree " << profiles[k].degree
               << " != profile 0 degree " << duRef
               << "; pre-elevate all profiles to the same degree before lofting";
            return {false, {}, ss.str()};
        }
        if (profiles[k].cvCount != mRef) {
            std::ostringstream ss;
            ss << "profile " << k << " cvCount " << profiles[k].cvCount
               << " != profile 0 cvCount " << mRef
               << "; all profiles must share the same CV count";
            return {false, {}, ss.str()};
        }
        if (profiles[k].knots.size() != kRef.size()) {
            std::ostringstream ss;
            ss << "profile " << k << " knot vector length "
               << profiles[k].knots.size() << " != " << kRef.size();
            return {false, {}, ss.str()};
        }
        for (int i = 0; i < static_cast<int>(kRef.size()); ++i) {
            if (std::abs(profiles[k].knots[i] - kRef[i]) > 1e-10) {
                std::ostringstream ss;
                ss << "profile " << k << " knot[" << i << "] "
                   << profiles[k].knots[i] << " != " << kRef[i]
                   << "; knot vectors must be identical (Phase C)";
                return {false, {}, ss.str()};
            }
        }
    }

    // ── 2. Chord-length parameterization in v ────────────────────────────────

    // v_k from centroid chord lengths.  v_0=0, v_{N-1}=1.
    std::vector<double> vParams(N, 0.0);
    {
        double total = 0.0;
        std::vector<double> chord(N - 1);
        for (int k = 0; k < N - 1; ++k) {
            Vec3 ca = profileCentroid(profiles[k]);
            Vec3 cb = profileCentroid(profiles[k + 1]);
            chord[k] = (cb - ca).norm();
            if (chord[k] < 1e-12) chord[k] = 1e-12; // guard degenerate
            total += chord[k];
        }
        for (int k = 1; k < N; ++k)
            vParams[k] = vParams[k - 1] + chord[k - 1] / total;
        vParams[N - 1] = 1.0; // exact
    }

    // ── 3. v knot vector (cubic interpolation in v direction) ────────────────

    int dv = std::min(3, N - 1); // cubic if N>=4, else N-1
    std::vector<double> knotsV = buildKnotsFromParams(vParams, dv);

    // ── 4. Global interpolation column-by-column ─────────────────────────────

    // Collocation matrix A is the same for all columns (same v params, same knot).
    Eigen::MatrixXd A = buildCollocationMatrix(vParams, knotsV, dv);

    // Result surface: cvCountU = mRef, cvCountV = N
    // cvs[i*N + k] = interpolated P_{i,k}
    int cvU = mRef;
    int cvV = N;
    std::vector<Vec4> surfCvs(cvU * cvV);

    for (int col = 0; col < cvU; ++col) {
        // Build RHS: N x 3 matrix of data points Q_{col, k=0..N-1}
        // Data point = w-divided CV col from profile k.
        Eigen::MatrixXd B(N, 3);
        for (int k = 0; k < N; ++k) {
            const Vec4& cv = profiles[k].cvs[col];
            double w = (std::abs(cv.w()) < 1e-14) ? 1.0 : cv.w();
            B.row(k) = (cv.head<3>() / w).transpose();
        }

        // Solve for N control points in this column
        Eigen::MatrixXd P = solveInterpolation(A, B); // N x 3

        for (int j = 0; j < cvV; ++j) {
            surfCvs[col * cvV + j] = Vec4(P(j, 0), P(j, 1), P(j, 2), 1.0);
        }
    }

    // ── 5. Assemble NurbsSurface ─────────────────────────────────────────────

    NurbsSurface loftSurf;
    loftSurf.degreeU  = duRef;
    loftSurf.degreeV  = dv;
    loftSurf.cvCountU = cvU;
    loftSurf.cvCountV = cvV;
    loftSurf.knotsU   = kRef;       // same as all profiles
    loftSurf.knotsV   = knotsV;
    loftSurf.cvs      = surfCvs;

    // ── 6. Build faces ───────────────────────────────────────────────────────

    BrepFace loftFace;
    loftFace.surface     = loftSurf;
    loftFace.orientation = true;
    loftFace.tolerance   = opts.tolerance;

    // Outer trim loop: four boundary edges of [0,1]x[0,1] param space.
    // Degree-1 line segments for each boundary edge.
    auto makeLineSeg = [](const Vec4& a, const Vec4& b) -> NurbsCurve {
        NurbsCurve c;
        c.degree  = 1;
        c.cvCount = 2;
        c.knots   = {0.0, 0.0, 1.0, 1.0};
        c.cvs     = {a, b};
        return c;
    };
    // UV boundary: bottom, right, top (reversed), left (reversed)
    TrimEdge eBot, eRight, eTop, eLeft;
    eBot.curveUV  = makeLineSeg({0,0,0,1}, {1,0,0,1});
    eRight.curveUV= makeLineSeg({1,0,0,1}, {1,1,0,1});
    eTop.curveUV  = makeLineSeg({1,1,0,1}, {0,1,0,1});
    eLeft.curveUV = makeLineSeg({0,1,0,1}, {0,0,0,1});
    // 3D boundary curves: isoparameter curves of the loft surface
    // (left as empty NurbsCurve stubs; full extraction is a separate operation)
    TrimLoop outerLoop;
    outerLoop.isOuter = true;
    outerLoop.edges   = {eBot, eRight, eTop, eLeft};
    loftFace.outerLoop = outerLoop;

    BrepShell shell;
    shell.faces.push_back(loftFace);

    // ── 7. Planar caps ───────────────────────────────────────────────────────

    if (opts.solid && !opts.closed) {
        BrepFace capFirst = buildPlanarCap(profiles.front(), opts.tolerance);
        BrepFace capLast  = buildPlanarCap(profiles.back(),  opts.tolerance);
        // Orient caps: first cap faces outward (flip), last cap faces outward.
        capFirst.orientation = false;
        capLast.orientation  = true;
        shell.faces.push_back(capFirst);
        shell.faces.push_back(capLast);
        shell.isClosed = true;
    } else if (opts.closed) {
        shell.isClosed = true;
    }

    // ── 8. Return ────────────────────────────────────────────────────────────

    Brep brep;
    brep.shells.push_back(shell);
    return {true, brep, ""};
}

} // namespace kern
