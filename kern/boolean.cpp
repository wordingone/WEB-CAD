// kern/boolean.cpp — Boolean evaluation pipeline (§3, kern-architecture.md).
//
// Stages:
//   [1] SSI pass — face-pair surface-surface intersection
//   [2] Containment test — ray-cast centroid against opposite solid
//   [3] Face classification — IN / OUT
//   [4] Face selection by operation
//   [5] Assembly — stitch selected faces; detect naked edges; set isClosed
//   [6] Healing — remove degenerate (zero-length) edges
//
// Convex split: faces with SSI curves get an inner trim loop added (outer half
// kept) or outer loop replaced by the SSI boundary (inner half kept). Curves
// with >32 points are refused with "complex split not yet implemented".

#include "boolean.h"
#include <Eigen/Dense>
#include <algorithm>
#include <cmath>
#include <vector>

namespace kern {
namespace {

// ---------------------------------------------------------------------------
// [2] Point-in-solid: +Z ray from pt; odd crossings = inside.
//
// Uses Newton iteration to invert S(u,v) → find (u,v) s.t. S.x=pt.x,
// S.y=pt.y, then checks S.z > pt.z. The prior coarse-grid/exact-match
// approach failed whenever pt.(x|y) did not land on a 1/N grid sample.
// ---------------------------------------------------------------------------
bool _pointInBrep(const Vec3& pt, const Brep& b, double tol)
{
    const double xyTol = tol > 0 ? tol : 1e-6;
    int crossings = 0;
    for (const auto& shell : b.shells) {
        for (const auto& face : shell.faces) {
            const NurbsSurface& s = face.surface;
            const double uMin = s.knotsU.front(), uMax = s.knotsU.back();
            const double vMin = s.knotsV.front(), vMax = s.knotsV.back();

            // Multi-start Newton: try 9 seed points spread over the parametric domain.
            // This avoids missing the root when the face has large extent.
            const int NS = 3;
            bool hit = false;
            for (int si = 0; si < NS && !hit; ++si) {
              for (int sj = 0; sj < NS && !hit; ++sj) {
                double u = uMin + (uMax - uMin) * (si + 0.5) / NS;
                double v = vMin + (vMax - vMin) * (sj + 0.5) / NS;

                for (int iter = 0; iter < 30; ++iter) {
                    u = std::max(uMin, std::min(uMax, u));
                    v = std::max(vMin, std::min(vMax, v));
                    Vec3 sp = s.evaluate(u, v);
                    double rx = sp.x() - pt.x();
                    double ry = sp.y() - pt.y();
                    if (std::abs(rx) < xyTol && std::abs(ry) < xyTol) {
                        // Converged — check z.
                        if (sp.z() - pt.z() > xyTol) { ++crossings; hit = true; }
                        break;
                    }
                    // Finite-difference Jacobian.
                    const double hu = 1e-5 * (uMax - uMin + 1e-9);
                    const double hv = 1e-5 * (vMax - vMin + 1e-9);
                    Vec3 su = s.evaluate(std::min(u + hu, uMax), v);
                    Vec3 sv = s.evaluate(u, std::min(v + hv, vMax));
                    double dxdu = (su.x() - sp.x()) / hu;
                    double dydu = (su.y() - sp.y()) / hu;
                    double dxdv = (sv.x() - sp.x()) / hv;
                    double dydv = (sv.y() - sp.y()) / hv;
                    double det = dxdu * dydv - dxdv * dydu;
                    if (std::abs(det) < 1e-12) break; // face parallel to +Z ray
                    u -= ( dydv * rx - dxdv * ry) / det;
                    v -= (-dydu * rx + dxdu * ry) / det;
                }
              }
            }
        }
    }
    return (crossings % 2) == 1;
}

Vec3 _faceCentroid(const BrepFace& f)
{
    const NurbsSurface& s = f.surface;
    return s.evaluate((s.knotsU.front() + s.knotsU.back()) * 0.5,
                      (s.knotsV.front() + s.knotsV.back()) * 0.5);
}

// Average of all face centroids — a reliable interior probe for convex solids.
// Avoids using a single face centroid that may lie on a shared boundary.
Vec3 _brepCenter(const std::vector<const BrepFace*>& faces)
{
    if (faces.empty()) return Vec3::Zero();
    Vec3 sum = Vec3::Zero();
    for (const auto* f : faces) sum += _faceCentroid(*f);
    return sum / static_cast<double>(faces.size());
}

// Build a degree-1 polyline NurbsCurve over n points with uniform open knots.
NurbsCurve _polylineCurve(int n)
{
    NurbsCurve c;
    c.degree  = 1;
    c.cvCount = n;
    c.knots.resize(n + 2);
    c.knots[0] = 0.0;
    for (int k = 1; k < n; ++k)
        c.knots[k] = static_cast<double>(k - 1) / (n > 2 ? n - 2 : 1);
    c.knots[n] = c.knots[n + 1] = 1.0;
    return c;
}

// [3] Build a TrimLoop from an SsiCurve (UV + 3D polylines).
TrimLoop _ssiToTrimLoop(const SsiCurve& curve, bool useParamsA)
{
    const auto& params = useParamsA ? curve.paramsA : curve.paramsB;
    if (params.size() < 2) return {};

    int n = static_cast<int>(params.size());
    NurbsCurve uv = _polylineCurve(n);
    uv.cvs.reserve(n);
    for (const auto& [u, v] : params)
        uv.cvs.push_back(Vec4(u, v, 0.0, 1.0));

    int m = static_cast<int>(curve.pts3d.size());
    NurbsCurve c3d = _polylineCurve(m);
    c3d.cvs.reserve(m);
    for (const Vec3& p : curve.pts3d)
        c3d.cvs.push_back(Vec4(p.x(), p.y(), p.z(), 1.0));

    TrimEdge edge;
    edge.curveUV  = uv;
    edge.curve3d  = c3d;

    TrimLoop loop;
    loop.isOuter = false;
    loop.edges.push_back(edge);
    return loop;
}

// [5] Build BrepEdge list; match coincident endpoints within tol.
void _stitchEdges(BrepShell& shell, double tol)
{
    shell.edges.clear();
    shell.vertices.clear();

    struct HalfEdge { NurbsCurve curve; int faceIdx; };
    std::vector<HalfEdge> half;
    for (int fi = 0; fi < static_cast<int>(shell.faces.size()); ++fi)
        for (const TrimEdge& te : shell.faces[fi].outerLoop.edges)
            half.push_back({te.curve3d, fi});

    std::vector<bool> matched(half.size(), false);
    for (int i = 0; i < static_cast<int>(half.size()); ++i) {
        if (matched[i]) continue;
        BrepEdge edge;
        edge.curve      = half[i].curve;
        edge.faceIndex1 = half[i].faceIdx;
        edge.faceIndex2 = -1;
        Vec3 s1 = half[i].curve.evaluate(half[i].curve.knots.front());
        Vec3 e1 = half[i].curve.evaluate(half[i].curve.knots.back());
        for (int j = i + 1; j < static_cast<int>(half.size()); ++j) {
            if (matched[j]) continue;
            Vec3 s2 = half[j].curve.evaluate(half[j].curve.knots.front());
            Vec3 e2 = half[j].curve.evaluate(half[j].curve.knots.back());
            if (((s1-s2).norm() < tol && (e1-e2).norm() < tol) ||
                ((s1-e2).norm() < tol && (e1-s2).norm() < tol)) {
                edge.faceIndex2 = half[j].faceIdx;
                matched[j] = true;
                break;
            }
        }
        matched[i] = true;
        shell.edges.push_back(edge);
    }
}

// [6] Remove zero-span edges.
void _healSlivers(BrepShell& shell, double tol)
{
    shell.edges.erase(std::remove_if(shell.edges.begin(), shell.edges.end(),
        [&](const BrepEdge& e) {
            if (e.curve.cvs.empty()) return true;
            return (e.curve.evaluate(e.curve.knots.front()) -
                    e.curve.evaluate(e.curve.knots.back())).norm() < tol;
        }), shell.edges.end());
}

// Apply split to one face using the SSI curve; push result(s) to outFaces.
// keepOuter=true → add SSI as inner trim (cut out overlap region).
// keepOuter=false → replace outer loop with SSI boundary (keep inside portion).
void _applyFaceSplit(const BrepFace& face, const SsiCurve& sc,
                     bool useParamsA, bool keepOuter, bool reverse,
                     std::vector<BrepFace>& outFaces)
{
    BrepFace f = face;
    if (reverse) f.orientation = !f.orientation;
    if (keepOuter) {
        TrimLoop inner = _ssiToTrimLoop(sc, useParamsA);
        if (!inner.edges.empty()) f.innerLoops.push_back(inner);
        outFaces.push_back(f);
    } else {
        TrimLoop newOuter = _ssiToTrimLoop(sc, useParamsA);
        newOuter.isOuter = true;
        if (!newOuter.edges.empty()) { f.outerLoop = newOuter; outFaces.push_back(f); }
    }
}

} // anonymous namespace

// ── Main pipeline ─────────────────────────────────────────────────────────────

BooleanResult boolOp(const Brep& a, const Brep& b, BooleanOp op, double tol)
{
    BooleanResult result;
    if (a.shells.empty()) { result.error = "input A has no shells"; return result; }
    if (b.shells.empty()) { result.error = "input B has no shells"; return result; }

    // [1] Collect faces.
    std::vector<const BrepFace*> facesA, facesB;
    for (const auto& sh : a.shells) for (const auto& f : sh.faces) facesA.push_back(&f);
    for (const auto& sh : b.shells) for (const auto& f : sh.faces) facesB.push_back(&f);
    const int nA = static_cast<int>(facesA.size());
    const int nB = static_cast<int>(facesB.size());

    // [0] Early containment check — skip SSI when B's centroid is inside A.
    // Using B's centroid (average of face centroids) reliably detects B-inside-A for
    // convex solids. We do NOT probe A's centroid against B here: when B is strictly
    // interior to A the two centroids coincide (symmetric case), giving a false
    // "A inside B" reading that would wrongly return an empty difference.
    {
        bool bInA = !facesB.empty() && _pointInBrep(_brepCenter(facesB), a, tol);
        if (bInA) {
            switch (op) {
                case BooleanOp::UNION:
                    result.brep = a; result.ok = true; return result;
                case BooleanOp::DIFFERENCE:
                    // B fully enclosed in A: A outer shell + reversed B shells as inner voids.
                    result.brep = a;
                    for (const auto& sh : b.shells) {
                        BrepShell bVoid;
                        for (const auto& f : sh.faces) {
                            BrepFace rev = f;
                            rev.orientation = !rev.orientation;
                            bVoid.faces.push_back(rev);
                        }
                        bVoid.edges    = sh.edges;
                        bVoid.vertices = sh.vertices;
                        bVoid.isClosed = sh.isClosed;
                        result.brep.shells.push_back(bVoid);
                    }
                    result.ok = true; return result;
                case BooleanOp::INTERSECTION:
                    result.brep = b; result.ok = true; return result;
            }
        }
    }

    // [1] SSI grid — only reached for partial-overlap or disjoint inputs.
    std::vector<std::vector<SsiResult>> ssiGrid(nA, std::vector<SsiResult>(nB));
    bool anySsi = false;
    SsiOptions opts; opts.tolerance = tol;
    for (int ia = 0; ia < nA; ++ia)
        for (int ib = 0; ib < nB; ++ib) {
            ssiGrid[ia][ib] = ssi(facesA[ia]->surface, facesB[ib]->surface, opts);
            if (ssiGrid[ia][ib].ok && !ssiGrid[ia][ib].curves.empty()) anySsi = true;
        }

    // [4-fallback] No face-face intersection and no containment: disjoint solids.
    if (!anySsi) {
        switch (op) {
            case BooleanOp::UNION:
                result.brep.shells.insert(result.brep.shells.end(),
                                          a.shells.begin(), a.shells.end());
                result.brep.shells.insert(result.brep.shells.end(),
                                          b.shells.begin(), b.shells.end());
                result.ok = true; return result;
            case BooleanOp::DIFFERENCE:
                result.brep = a; result.ok = true; return result;
            case BooleanOp::INTERSECTION:
                result.error = "no intersection"; return result;
        }
    }

    // [2][3][4] Classify and (optionally) split each face.
    std::vector<BrepFace> outFaces;

    // Helper: classify containment → selection booleans.
    auto classify = [&](bool inside, bool fromB) -> std::pair<bool,bool> {
        // returns {keep, reverse}
        switch (op) {
            case BooleanOp::UNION:        return {!inside, false};
            case BooleanOp::DIFFERENCE:   return fromB ? std::make_pair(inside, true)
                                                       : std::make_pair(!inside, false);
            case BooleanOp::INTERSECTION: return {inside, false};
        }
        return {false, false};
    };

    for (int ia = 0; ia < nA; ++ia) {
        std::vector<const SsiCurve*> hits;
        for (int ib = 0; ib < nB; ++ib)
            if (ssiGrid[ia][ib].ok)
                for (const auto& c : ssiGrid[ia][ib].curves) hits.push_back(&c);

        if (hits.empty()) {
            auto [keep, rev] = classify(_pointInBrep(_faceCentroid(*facesA[ia]), b, tol), false);
            if (keep) { BrepFace f = *facesA[ia]; if (rev) f.orientation=!f.orientation; outFaces.push_back(f); }
        } else {
            const SsiCurve* sc = hits[0];
            if (sc->pts3d.size() < 2) {
                auto [keep, rev] = classify(_pointInBrep(_faceCentroid(*facesA[ia]), b, tol), false);
                if (keep) { BrepFace f = *facesA[ia]; if (rev) f.orientation=!f.orientation; outFaces.push_back(f); }
                continue;
            }
            if (sc->pts3d.size() > 10000) { result.error = "SSI curve exceeds 10000 points"; return result; }
            // A faces: UNION/DIFFERENCE → keep outer; INTERSECTION → keep inner.
            bool keepOuter = (op != BooleanOp::INTERSECTION);
            _applyFaceSplit(*facesA[ia], *sc, /*useParamsA=*/true, keepOuter, false, outFaces);
        }
    }

    for (int ib = 0; ib < nB; ++ib) {
        std::vector<const SsiCurve*> hits;
        for (int ia = 0; ia < nA; ++ia)
            if (ssiGrid[ia][ib].ok)
                for (const auto& c : ssiGrid[ia][ib].curves) hits.push_back(&c);

        if (hits.empty()) {
            auto [keep, rev] = classify(_pointInBrep(_faceCentroid(*facesB[ib]), a, tol), true);
            if (keep) { BrepFace f = *facesB[ib]; if (rev) f.orientation=!f.orientation; outFaces.push_back(f); }
        } else {
            const SsiCurve* sc = hits[0];
            if (sc->pts3d.size() < 2) {
                auto [keep, rev] = classify(_pointInBrep(_faceCentroid(*facesB[ib]), a, tol), true);
                if (keep) { BrepFace f = *facesB[ib]; if (rev) f.orientation=!f.orientation; outFaces.push_back(f); }
                continue;
            }
            if (sc->pts3d.size() > 10000) { result.error = "SSI curve exceeds 10000 points"; return result; }
            // B faces: UNION → keep outer; DIFFERENCE → keep inner reversed; INTERSECTION → keep inner.
            bool keepOuter = (op == BooleanOp::UNION);
            bool reverse   = (op == BooleanOp::DIFFERENCE);
            _applyFaceSplit(*facesB[ib], *sc, /*useParamsA=*/false, keepOuter, reverse, outFaces);
        }
    }

    if (outFaces.empty()) { result.error = "no faces survived classification"; return result; }

    // [5] Assembly.
    BrepShell outShell;
    outShell.faces = std::move(outFaces);
    _stitchEdges(outShell, tol);
    int nakedCount = 0;
    for (const auto& e : outShell.edges) if (e.faceIndex2 == -1) ++nakedCount;
    outShell.isClosed = (nakedCount == 0);

    // [6] Healing.
    _healSlivers(outShell, tol);

    result.brep.shells.push_back(std::move(outShell));
    result.ok = true;
    return result;
}

} // namespace kern
