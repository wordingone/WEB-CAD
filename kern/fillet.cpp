// kern/fillet.cpp — Rolling-ball fillet for planar adjacent faces.
//
// Algorithm overview (Piegl & Tiller §10.7):
//   For each non-naked edge shared by two planar faces:
//     1. Estimate face normals at the edge midpoint.
//     2. Compute dihedral angle θ = acos(nA · nB).
//     3. Inward offset d = radius / tan(θ/2); each adjacent face is trimmed
//        back by a line at distance d from the original edge.
//     4. Build a rational quadratic (degree-2) NURBS arc for the fillet
//        cross-section, then extrude it along the edge to form a ruled/swept
//        cylindrical surface.
//     5. Assemble: trimmed original faces + fillet patches → new BrepShell.
//
// Parity target: planar-adjacent edge radius within 1e-3 vs replicad fillet.

#include "fillet.h"
#include <Eigen/Geometry>
#include <algorithm>
#include <cmath>
#include <set>
#include <sstream>
#include <stdexcept>

namespace kern {

// ── Internal helpers ──────────────────────────────────────────────────────────

namespace {

// Return a uniform open-end knot vector for the given degree and cvCount.
// Pattern: (degree+1) zeros, (cvCount-degree-1) interior uniforms, (degree+1) ones.
static std::vector<double> uniformKnots(int degree, int cvCount) {
    std::vector<double> knots(cvCount + degree + 1, 0.0);
    int n = cvCount - 1;
    // Leading clamped knots: all 0
    for (int i = 0; i <= degree; ++i) knots[i] = 0.0;
    // Interior
    int interior = n - degree;
    for (int j = 1; j <= interior; ++j)
        knots[degree + j] = static_cast<double>(j) / static_cast<double>(interior + 1);
    // Trailing clamped knots: all 1
    for (int i = 0; i <= degree; ++i) knots[n + 1 + i] = 1.0;
    return knots;
}

// Build a straight-line NurbsCurve (degree 1) between two 3-D points.
static NurbsCurve lineCurve(const Vec3& p0, const Vec3& p1) {
    NurbsCurve c;
    c.degree  = 1;
    c.cvCount = 2;
    c.knots   = {0.0, 0.0, 1.0, 1.0};
    c.cvs     = { Vec4(p0.x(), p0.y(), p0.z(), 1.0),
                  Vec4(p1.x(), p1.y(), p1.z(), 1.0) };
    return c;
}

// Build a straight-line NurbsCurve in UV space between (u0,v0) and (u1,v1).
static NurbsCurve lineUV(double u0, double v0, double u1, double v1) {
    NurbsCurve c;
    c.degree  = 1;
    c.cvCount = 2;
    c.knots   = {0.0, 0.0, 1.0, 1.0};
    c.cvs     = { Vec4(u0, v0, 0.0, 1.0),
                  Vec4(u1, v1, 0.0, 1.0) };
    return c;
}

// Build a TrimEdge pairing 3-D and UV lines.
static TrimEdge makeTrimEdge(const Vec3& p3a, const Vec3& p3b,
                             double ua, double va,
                             double ub, double vb,
                             double tol) {
    TrimEdge te;
    te.curve3d   = lineCurve(p3a, p3b);
    te.curveUV   = lineUV(ua, va, ub, vb);
    te.tolerance = tol;
    return te;
}

// Determine whether a NurbsSurface is planar by sampling 3×3 normals and
// checking they are all within `angTol` (radians) of the centre normal.
static bool isSurfacePlanar(const NurbsSurface& surf, double angTol = 1e-3) {
    const Vec3 n0 = surf.normalAt(0.5, 0.5);
    for (int i = 0; i <= 2; ++i) {
        for (int j = 0; j <= 2; ++j) {
            double u = 0.25 + 0.25 * i;
            double v = 0.25 + 0.25 * j;
            Vec3 n = surf.normalAt(u, v);
            double cosA = std::abs(n0.dot(n));
            if (cosA < std::cos(angTol)) return false;
        }
    }
    return true;
}

/**
 * Build a rational quadratic (degree-2) NURBS arc in the plane defined by
 * centre `C`, start tangent `tA`, end tangent `tB`, sweep angle `sweep`
 * (radians, 0 < sweep < π), and `radius`.
 *
 * The midpoint control point has weight w = cos(sweep/2) (standard rational
 * quadratic arc construction, Piegl & Tiller §7.1).
 *
 * Returns a 3-cv NurbsCurve representing the cross-section arc.
 */
static NurbsCurve buildArcCrossSection(const Vec3& C,
                                       const Vec3& pStart,
                                       const Vec3& pEnd,
                                       double sweep,
                                       double /*radius*/) {
    // Mid-point: bisector direction from C scaled so the arc passes through it
    Vec3 dStart = (pStart - C).normalized();
    Vec3 dEnd   = (pEnd   - C).normalized();
    Vec3 dMid   = (dStart + dEnd).normalized();

    double w1 = std::cos(sweep / 2.0);
    // Rational mid-point: homogeneous coords (x*w, y*w, z*w, w)
    Vec3 pMid = C + dMid * (pStart - C).norm(); // same radius as endpoints
    Vec4 midHom(pMid.x() * w1, pMid.y() * w1, pMid.z() * w1, w1);

    NurbsCurve arc;
    arc.degree  = 2;
    arc.cvCount = 3;
    arc.knots   = {0.0, 0.0, 0.0, 1.0, 1.0, 1.0};
    arc.cvs     = {
        Vec4(pStart.x(), pStart.y(), pStart.z(), 1.0),
        midHom,
        Vec4(pEnd.x(),   pEnd.y(),   pEnd.z(),   1.0)
    };
    return arc;
}

/**
 * Extrude a cross-section NurbsCurve along the direction `along` by length
 * `len` to form a ruled NurbsSurface.
 *
 * The resulting surface has:
 *   - degreeU = cross.degree  (cross-section direction)
 *   - degreeV = 1             (extrusion direction, linear)
 *   - cvCountU = cross.cvCount
 *   - cvCountV = 2
 * Row-major layout: cvs[i*2 + j], j=0 start rail, j=1 end rail.
 */
static NurbsSurface extrudeCurve(const NurbsCurve& cross,
                                 const Vec3& along,
                                 double len) {
    NurbsSurface surf;
    surf.degreeU  = cross.degree;
    surf.degreeV  = 1;
    surf.cvCountU = cross.cvCount;
    surf.cvCountV = 2;
    surf.knotsU   = cross.knots;
    surf.knotsV   = {0.0, 0.0, 1.0, 1.0};

    Vec3 offset = along.normalized() * len;
    surf.cvs.resize(cross.cvCount * 2);
    for (int i = 0; i < cross.cvCount; ++i) {
        const Vec4& cp = cross.cvs[i];
        double w = cp.w();
        Vec3 p(cp.x() / w, cp.y() / w, cp.z() / w);
        surf.cvs[i * 2 + 0] = Vec4(p.x() * w,           p.y() * w,           p.z() * w,           w);
        surf.cvs[i * 2 + 1] = Vec4((p.x() + offset.x()) * w,
                                    (p.y() + offset.y()) * w,
                                    (p.z() + offset.z()) * w, w);
    }
    return surf;
}

/**
 * Build the four-sided trim loop bounding the full [0,1]×[0,1] parameter
 * domain of a surface — used as the outer loop for a freshly-built fillet face.
 */
static TrimLoop fullDomainOuterLoop(const NurbsSurface& surf, double tol) {
    (void)surf; // domain always [0,1]^2 for our constructed surfaces
    TrimLoop loop;
    loop.isOuter = true;
    // Four edges: bottom, right, top (reversed), left (reversed)
    loop.edges.push_back(makeTrimEdge({0,0,0},{1,0,0}, 0,0, 1,0, tol)); // u=0→1, v=0
    loop.edges.push_back(makeTrimEdge({1,0,0},{1,1,0}, 1,0, 1,1, tol)); // v=0→1, u=1
    loop.edges.push_back(makeTrimEdge({1,1,0},{0,1,0}, 1,1, 0,1, tol)); // u=1→0, v=1
    loop.edges.push_back(makeTrimEdge({0,1,0},{0,0,0}, 0,1, 0,0, tol)); // v=1→0, u=0
    return loop;
}

/**
 * Build a straight inner trim loop at constant v=vCut across the full u span
 * [0,1] — used to trim an original face back from an edge by offset distance d.
 *
 * The inner loop is a degenerate rectangle:
 *   bottom-left (0,vCut) → (1,vCut) → (1,1) → (0,1) → (0,vCut)
 * representing the strip of parameter space that is removed.
 *
 * For our simplified planar fillet we add this as an inner (hole) loop on
 * the trimmed face at v = vCut in the face's parameterisation.
 */
static TrimLoop innerTrimAtV(double vCut, double tol) {
    TrimLoop loop;
    loop.isOuter = false; // inner hole
    loop.edges.push_back(makeTrimEdge({0,vCut,0},{1,vCut,0}, 0,vCut, 1,vCut, tol));
    loop.edges.push_back(makeTrimEdge({1,vCut,0},{1,1,0},    1,vCut, 1,1,    tol));
    loop.edges.push_back(makeTrimEdge({1,1,0},  {0,1,0},     1,1,    0,1,    tol));
    loop.edges.push_back(makeTrimEdge({0,1,0},  {0,vCut,0},  0,1,    0,vCut, tol));
    return loop;
}

// Per-filleted-edge record used by the seam sewing assembly stage.
struct FilletRecord {
    int          edgeIdx;
    int          faceA, faceB;   // original face indices (faceIndex1/2 of the edge)
    Vec3         V0, V1;          // edge start / end (world space)
    NurbsSurface surf;             // the extruded arc surface
};

} // namespace (anonymous)

// ── Public API ────────────────────────────────────────────────────────────────

FilletResult fillet(const Brep& input, const FilletOptions& opts) {
    // ── Precondition checks ────────────────────────────────────────────────────
    if (input.shells.empty())
        return {false, {}, "fillet: input Brep has no shells"};
    if (opts.radius <= 0.0)
        return {false, {}, "fillet: radius must be > 0"};

    const BrepShell& shell = input.shells[0];

    // ── Collect target edge indices ────────────────────────────────────────────
    std::vector<int> targets;
    if (opts.edgeIndices.empty()) {
        for (int i = 0; i < static_cast<int>(shell.edges.size()); ++i)
            if (shell.edges[i].faceIndex2 != -1)
                targets.push_back(i);
    } else {
        targets = opts.edgeIndices;
    }

    if (targets.empty())
        return {false, {}, "fillet: no non-naked edges found to fillet"};

    // ── Work on a mutable copy of the shell's faces ───────────────────────────
    std::vector<BrepFace>    outFaces = shell.faces;
    std::vector<BrepEdge>    outEdges = shell.edges;
    std::vector<BrepFace>    filletFaces;
    std::vector<FilletRecord> filletRecords;

    for (int edgeIdx : targets) {
        if (edgeIdx < 0 || edgeIdx >= static_cast<int>(shell.edges.size())) {
            std::ostringstream os;
            os << "fillet: edge index " << edgeIdx << " out of range";
            return {false, {}, os.str()};
        }

        const BrepEdge& edge = shell.edges[edgeIdx];
        if (edge.faceIndex1 < 0 || edge.faceIndex2 < 0) {
            // Naked edge — skip silently (or could error; spec says collect
            // non-naked, so a user-supplied naked index is benign).
            continue;
        }

        const BrepFace& faceA = shell.faces[edge.faceIndex1];
        const BrepFace& faceB = shell.faces[edge.faceIndex2];

        // ── Planarity check (curved faces → not-yet-implemented) ──────────────
        if (!isSurfacePlanar(faceA.surface) || !isSurfacePlanar(faceB.surface)) {
            std::ostringstream os;
            os << "curved-face fillet not yet implemented: edge "
               << std::to_string(edgeIdx);
            return {false, {}, os.str()};
        }

        // ── Face normals at edge midpoint ─────────────────────────────────────
        Vec3 nA = faceA.surface.normalAt(0.5, 0.5);
        Vec3 nB = faceB.surface.normalAt(0.5, 0.5);
        if (!faceA.orientation) nA = -nA;
        if (!faceB.orientation) nB = -nB;

        double cosTheta = std::max(-1.0, std::min(1.0, nA.dot(nB)));
        double theta    = std::acos(cosTheta);

        // ── Skip nearly co-planar edges ───────────────────────────────────────
        if (theta < 1e-3) continue;

        // ── Inward offset distance ─────────────────────────────────────────────
        double d = opts.radius / std::tan(theta / 2.0);

        // ── Edge geometry: start / end / mid / direction ─────────────────────
        const NurbsCurve& edgeCurve = edge.curve;
        Vec3 edgeStart  = edgeCurve.evaluate(0.0);
        Vec3 edgeEnd    = edgeCurve.evaluate(1.0);
        Vec3 edgeMid    = edgeCurve.evaluate(0.5);
        Vec3 edgeDir    = (edgeEnd - edgeStart);
        double edgeLen  = edgeDir.norm();
        if (edgeLen < 1e-10) continue;
        edgeDir /= edgeLen;

        // ── Fillet arc cross-section ──────────────────────────────────────────
        // The rolling-ball centre lies at distance `d` inside each face from
        // the edge, and at distance `radius` from the edge itself along the
        // bisector normal.
        //
        // Compute the bisector of the two inward normals (−nA, −nB).
        Vec3 bisector = (-nA + -nB);
        if (bisector.norm() < 1e-10)
            bisector = nA.cross(nB).cross(nA).normalized(); // fallback
        else
            bisector.normalize();

        // Arc centre in the cross-section plane at the edge midpoint
        Vec3 arcCentre = edgeMid + bisector * opts.radius;

        // Start and end points of the arc on each face's offset line
        Vec3 arcStart = arcCentre + nA.normalized() * opts.radius;
        Vec3 arcEnd   = arcCentre + nB.normalized() * opts.radius;

        double sweep  = M_PI - theta; // arc sweep angle

        NurbsCurve crossSection =
            buildArcCrossSection(arcCentre, arcStart, arcEnd,
                                 sweep, opts.radius);

        // ── Extrude cross-section along edge direction ────────────────────────
        NurbsSurface filletSurf = extrudeCurve(crossSection, edgeDir, edgeLen);

        // ── Build fillet face ─────────────────────────────────────────────────
        BrepFace ff;
        ff.surface     = filletSurf;
        ff.outerLoop   = fullDomainOuterLoop(filletSurf, opts.tolerance);
        ff.orientation = true;
        ff.tolerance   = opts.tolerance;
        filletFaces.push_back(std::move(ff));

        // Capture data for seam sewing (filletSurf is still valid — ff.surface was a copy)
        filletRecords.push_back({edgeIdx, edge.faceIndex1, edge.faceIndex2,
                                  edgeStart, edgeEnd, filletSurf});

        // ── Add inner trim loops to adjacent faces ────────────────────────────
        // Map offset `d` into the face's [0,1] v-parameter range.
        // For a planar face the surface extent can be estimated from the bbox.
        {
            auto bbA = faceA.surface.bbox();
            double extentA = (bbA.max() - bbA.min()).norm();
            double vCutA = (extentA > 1e-10) ? std::min(0.999, d / extentA) : 0.1;
            outFaces[edge.faceIndex1].innerLoops.push_back(
                innerTrimAtV(vCutA, opts.tolerance));
        }
        {
            auto bbB = faceB.surface.bbox();
            double extentB = (bbB.max() - bbB.min()).norm();
            double vCutB = (extentB > 1e-10) ? std::min(0.999, d / extentB) : 0.1;
            outFaces[edge.faceIndex2].innerLoops.push_back(
                innerTrimAtV(vCutB, opts.tolerance));
        }

        // Mark original edge as naked (trimmed out of the topology)
        outEdges[edgeIdx].faceIndex2 = -1;
    }

    // ── Seam-sewing assembly ──────────────────────────────────────────────────
    // Remove filleted edges (they no longer exist in topology)
    std::set<int> removedEdgeSet(targets.begin(), targets.end());
    std::vector<BrepEdge> finalEdges;
    for (int i = 0; i < static_cast<int>(outEdges.size()); ++i) {
        if (!removedEdgeSet.count(i))
            finalEdges.push_back(outEdges[i]);
    }

    // Copy original vertices; fillet corners will be appended
    std::vector<BrepVertex> finalVertices = shell.vertices;

    // For each filleted edge: add fillet face + 2 triangular cap faces + 8 manifold edges
    for (size_t ri = 0; ri < filletRecords.size(); ++ri) {
        const FilletRecord& rec = filletRecords[ri];

        int fFillet = static_cast<int>(outFaces.size());
        int fCap0   = fFillet + 1; // triangular cap at V0 end
        int fCap1   = fFillet + 2; // triangular cap at V1 end

        // Fillet surface corners: evaluate(u, v) — u=arc direction, v=along-edge
        Vec3 P_fA_0 = rec.surf.evaluate(0.0, 0.0); // arc-start at edge-start
        Vec3 P_fA_1 = rec.surf.evaluate(0.0, 1.0); // arc-start at edge-end
        Vec3 P_fB_0 = rec.surf.evaluate(1.0, 0.0); // arc-end   at edge-start
        Vec3 P_fB_1 = rec.surf.evaluate(1.0, 1.0); // arc-end   at edge-end

        // Add 4 fillet corner vertices
        finalVertices.push_back({P_fA_0, {}, opts.tolerance});
        finalVertices.push_back({P_fA_1, {}, opts.tolerance});
        finalVertices.push_back({P_fB_0, {}, opts.tolerance});
        finalVertices.push_back({P_fB_1, {}, opts.tolerance});

        // Append fillet face
        outFaces.push_back(filletFaces[ri]);

        // Build degenerate bilinear cap face (triangle pA→pB→apex).
        // CVs row-major [i*2+j]: (0,0)=pA, (0,1)=pB, (1,0)=apex, (1,1)=apex.
        auto makeCapFace = [&](const Vec3& pA, const Vec3& pB, const Vec3& apex) {
            NurbsSurface cs;
            cs.degreeU  = 1; cs.degreeV  = 1;
            cs.cvCountU = 2; cs.cvCountV = 2;
            cs.knotsU   = {0.0, 0.0, 1.0, 1.0};
            cs.knotsV   = {0.0, 0.0, 1.0, 1.0};
            cs.cvs = {
                Vec4(pA.x(),   pA.y(),   pA.z(),   1.0),
                Vec4(pB.x(),   pB.y(),   pB.z(),   1.0),
                Vec4(apex.x(), apex.y(), apex.z(), 1.0),
                Vec4(apex.x(), apex.y(), apex.z(), 1.0),
            };
            BrepFace cf;
            cf.surface     = cs;
            cf.outerLoop   = fullDomainOuterLoop(cs, opts.tolerance);
            cf.orientation = true;
            cf.tolerance   = opts.tolerance;
            return cf;
        };
        outFaces.push_back(makeCapFace(P_fA_0, P_fB_0, rec.V0)); // cap0 at V0
        outFaces.push_back(makeCapFace(P_fA_1, P_fB_1, rec.V1)); // cap1 at V1

        // 8 manifold edges — every edge shared by exactly 2 faces
        auto addEdge = [&](int f1, int f2, const Vec3& a, const Vec3& b) {
            BrepEdge e;
            e.faceIndex1 = f1; e.faceIndex2 = f2;
            e.tolerance  = opts.tolerance;
            e.curve      = lineCurve(a, b);
            finalEdges.push_back(e);
        };
        addEdge(fFillet, rec.faceA, P_fA_0, P_fA_1); // E1: fillet u=0 ↔ faceA
        addEdge(fFillet, rec.faceB, P_fB_0, P_fB_1); // E2: fillet u=1 ↔ faceB
        addEdge(fFillet, fCap0,     P_fA_0, P_fB_0); // E3: fillet v=0 ↔ cap0
        addEdge(fFillet, fCap1,     P_fA_1, P_fB_1); // E4: fillet v=1 ↔ cap1
        addEdge(fCap0,   rec.faceA, rec.V0, P_fA_0); // E5: cap0 ↔ faceA
        addEdge(fCap0,   rec.faceB, rec.V0, P_fB_0); // E6: cap0 ↔ faceB
        addEdge(fCap1,   rec.faceA, rec.V1, P_fA_1); // E7: cap1 ↔ faceA
        addEdge(fCap1,   rec.faceB, rec.V1, P_fB_1); // E8: cap1 ↔ faceB
    }

    BrepShell outShell;
    outShell.faces    = std::move(outFaces);
    outShell.edges    = std::move(finalEdges);
    outShell.vertices = std::move(finalVertices);
    outShell.isClosed = true; // all edges are manifold after seam sewing

    Brep result;
    result.shells.push_back(std::move(outShell));

    return {true, std::move(result), ""};
}

} // namespace kern
