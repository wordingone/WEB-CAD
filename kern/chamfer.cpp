// kern/chamfer.cpp — Equal-distance planar chamfer for BRep edges.
// Reference: Piegl & Tiller §11 (ruled surface), §5 (trim topology).

#include "chamfer.h"
#include <cmath>
#include <string>

namespace {

using namespace kern;

// ── Planarity check ───────────────────────────────────────────────────────────

// Returns the constant outward normal of a planar face.
// Sets ok=false / fills err when the face surface is not planar (curved face).
static Vec3 planarFaceNormal(const BrepFace& face, double tol,
                             bool& ok, std::string& err) {
    const NurbsSurface& s = face.surface;
    double u0 = s.knotsU.front(), u1 = s.knotsU.back();
    double v0 = s.knotsV.front(), v1 = s.knotsV.back();
    Vec3 nRef = s.normalAt(0.5*(u0+u1), 0.5*(v0+v1)).normalized();

    // Sample four interior points to verify constant normal (planarity).
    for (double fu : {0.25, 0.75}) {
        for (double fv : {0.25, 0.75}) {
            Vec3 n = s.normalAt(u0+(u1-u0)*fu, v0+(v1-v0)*fv).normalized();
            if (std::abs(1.0 - std::abs(n.dot(nRef))) > tol) {
                ok  = false;
                err = "curved-face chamfer not yet implemented";
                return Vec3::Zero();
            }
        }
    }
    ok = true;
    return face.orientation ? nRef : -nRef;
}

// ── Offset line ───────────────────────────────────────────────────────────────

// Returns a degree-1 NURBS line offset `distance` inward from `edge` along
// the face whose outward normal is `faceNormal`.
// "Inward" direction = (faceNormal × edgeTangent) projected onto face plane.
static NurbsCurve offsetEdgeOnFace(const NurbsCurve& edge,
                                   const Vec3& faceNormal, double distance) {
    Vec3 p0 = edge.evaluate(edge.knots.front());
    Vec3 p1 = edge.evaluate(edge.knots.back());

    Vec3 tangent = p1 - p0;
    double len = tangent.norm();
    if (len > 1e-12) tangent /= len;

    // In-plane offset direction
    Vec3 dir = faceNormal.cross(tangent);
    dir -= faceNormal * faceNormal.dot(dir);  // project onto face plane
    double dn = dir.norm();
    if (dn > 1e-12) dir /= dn;

    Vec3 o0 = p0 + dir * distance;
    Vec3 o1 = p1 + dir * distance;

    NurbsCurve c;
    c.degree = 1; c.cvCount = 2;
    c.knots  = {0.0, 0.0, 1.0, 1.0};
    c.cvs    = {Vec4(o0.x(), o0.y(), o0.z(), 1.0),
                Vec4(o1.x(), o1.y(), o1.z(), 1.0)};
    return c;
}

// ── Ruled surface ─────────────────────────────────────────────────────────────

// Bi-linear ruled NurbsSurface (degreeU=1, degreeV=1) between two lines.
// Row 0 = line0 endpoints; row 1 = line1 endpoints.
static NurbsSurface ruledSurface(const NurbsCurve& line0,
                                 const NurbsCurve& line1) {
    Vec3 a0 = line0.evaluate(0.0), a1 = line0.evaluate(1.0);
    Vec3 b0 = line1.evaluate(0.0), b1 = line1.evaluate(1.0);

    NurbsSurface s;
    s.degreeU = s.degreeV = 1;
    s.cvCountU = s.cvCountV = 2;
    s.knotsU = s.knotsV = {0.0, 0.0, 1.0, 1.0};
    s.cvs = {
        Vec4(a0.x(), a0.y(), a0.z(), 1.0), Vec4(a1.x(), a1.y(), a1.z(), 1.0),
        Vec4(b0.x(), b0.y(), b0.z(), 1.0), Vec4(b1.x(), b1.y(), b1.z(), 1.0),
    };
    return s;
}

// ── Trim helpers ──────────────────────────────────────────────────────────────

static TrimEdge makeTrimEdge(const NurbsCurve& c3d, double tol) {
    TrimEdge te;
    te.curve3d = te.curveUV = c3d;  // UV identity approx for planar faces
    te.tolerance = tol;
    return te;
}

// Makes a degenerate 3-edge inner TrimLoop clipping a face at `setbackLine`.
// Cap edges are zero-length (point) curves at each endpoint.
static TrimLoop makeTrimLoop(const NurbsCurve& setbackLine, double tol) {
    TrimLoop loop;
    loop.isOuter = false;
    loop.edges.push_back(makeTrimEdge(setbackLine, tol));

    for (const Vec3& pt : {setbackLine.evaluate(1.0),
                           setbackLine.evaluate(0.0)}) {
        NurbsCurve cap;
        cap.degree = 1; cap.cvCount = 2;
        cap.knots  = {0.0, 0.0, 1.0, 1.0};
        cap.cvs    = {Vec4(pt.x(), pt.y(), pt.z(), 1.0),
                      Vec4(pt.x(), pt.y(), pt.z(), 1.0)};
        loop.edges.push_back(makeTrimEdge(cap, tol));
    }
    return loop;
}

// ── Per-edge work unit ────────────────────────────────────────────────────────

struct EdgeChamfer {
    int        faceIdx1, faceIdx2;
    NurbsCurve offsetLine1, offsetLine2;
    BrepFace   chamferFace;
};

static bool processEdge(const BrepShell& shell, int edgeIdx,
                        double distance, double tol,
                        EdgeChamfer& out, std::string& err) {
    if (edgeIdx < 0 || edgeIdx >= (int)shell.edges.size()) {
        err = "edge index out of range: " + std::to_string(edgeIdx);
        return false;
    }
    const BrepEdge& edge = shell.edges[edgeIdx];
    if (edge.faceIndex1 < 0 || edge.faceIndex2 < 0) {
        err = "edge " + std::to_string(edgeIdx) + " is naked; chamfer requires two adjacent faces";
        return false;
    }

    bool ok1, ok2; std::string e1, e2;
    Vec3 n1 = planarFaceNormal(shell.faces[edge.faceIndex1], tol, ok1, e1);
    Vec3 n2 = planarFaceNormal(shell.faces[edge.faceIndex2], tol, ok2, e2);
    if (!ok1) { err = e1; return false; }
    if (!ok2) { err = e2; return false; }

    out.faceIdx1    = edge.faceIndex1;
    out.faceIdx2    = edge.faceIndex2;
    out.offsetLine1 = offsetEdgeOnFace(edge.curve, n1, distance);
    out.offsetLine2 = offsetEdgeOnFace(edge.curve, n2, distance);

    // Build chamfer face as a ruled surface between the two offset lines.
    BrepFace cf;
    cf.surface     = ruledSurface(out.offsetLine1, out.offsetLine2);
    cf.orientation = true;
    cf.tolerance   = tol;

    // Outer trim loop: four edges of the ruled quad.
    Vec3 c00 = out.offsetLine1.evaluate(0.0), c01 = out.offsetLine1.evaluate(1.0);
    Vec3 c10 = out.offsetLine2.evaluate(0.0), c11 = out.offsetLine2.evaluate(1.0);
    auto seg = [&](const Vec3& a, const Vec3& b) {
        NurbsCurve lc; lc.degree = 1; lc.cvCount = 2;
        lc.knots = {0.0,0.0,1.0,1.0};
        lc.cvs = {Vec4(a.x(),a.y(),a.z(),1.0), Vec4(b.x(),b.y(),b.z(),1.0)};
        return lc;
    };
    TrimLoop outer; outer.isOuter = true;
    for (const auto& lc : {seg(c00,c01), seg(c01,c11), seg(c11,c10), seg(c10,c00)})
        outer.edges.push_back(makeTrimEdge(lc, tol));
    cf.outerLoop = outer;

    out.chamferFace = cf;
    return true;
}

} // namespace

// ── Public entry point ────────────────────────────────────────────────────────

ChamferResult chamfer(const kern::Brep& input, const ChamferOptions& opts) {
    if (input.shells.empty())
        return {false, {}, "input Brep has no shells"};
    if (opts.distance <= 0.0)
        return {false, {}, "chamfer distance must be positive"};
    if (opts.edgeIndices.empty())
        return {true, input, {}};

    const kern::BrepShell& src = input.shells[0];

    // Phase 1: validate edges, compute offset geometry.
    std::vector<EdgeChamfer> chamfers;
    chamfers.reserve(opts.edgeIndices.size());
    for (int idx : opts.edgeIndices) {
        EdgeChamfer ec; std::string err;
        if (!processEdge(src, idx, opts.distance, opts.tolerance, ec, err))
            return {false, {}, err};
        chamfers.push_back(std::move(ec));
    }

    // Phase 2: copy faces; add inner trim loops on each adjacent face.
    std::vector<kern::BrepFace> newFaces = src.faces;
    for (const EdgeChamfer& ec : chamfers) {
        newFaces[ec.faceIdx1].innerLoops.push_back(
            makeTrimLoop(ec.offsetLine1, opts.tolerance));
        newFaces[ec.faceIdx2].innerLoops.push_back(
            makeTrimLoop(ec.offsetLine2, opts.tolerance));
    }

    // Phase 3: append chamfer faces.
    for (const EdgeChamfer& ec : chamfers)
        newFaces.push_back(ec.chamferFace);

    // Phase 4: carry original edges; add naked boundary edges for chamfer faces.
    std::vector<kern::BrepEdge> newEdges = src.edges;
    int base = (int)src.faces.size();
    for (int ci = 0; ci < (int)chamfers.size(); ++ci) {
        int cfi = base + ci;
        for (const auto& te : newFaces[cfi].outerLoop.edges) {
            kern::BrepEdge be;
            be.curve      = te.curve3d;
            be.faceIndex1 = cfi;
            be.faceIndex2 = -1;
            be.tolerance  = opts.tolerance;
            newEdges.push_back(be);
        }
    }

    // Phase 5: assemble result shell + preserve extra shells.
    kern::BrepShell shell;
    shell.faces    = std::move(newFaces);
    shell.edges    = std::move(newEdges);
    shell.vertices = src.vertices;
    shell.isClosed = false;

    kern::Brep result;
    result.shells.push_back(std::move(shell));
    for (std::size_t i = 1; i < input.shells.size(); ++i)
        result.shells.push_back(input.shells[i]);

    return {true, std::move(result), {}};
}
