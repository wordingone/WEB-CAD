#pragma once

// kern/brep.h — BRep data model for the WEB-CAD geometry kernel.
//
// All types mirror the TypeScript definitions in web/src/nurbs/nurbs-brep.ts.
// JSON serialization (nlohmann/json) is the interchange contract across the
// WASM boundary. Control points are homogeneous (x,y,z,w); w=1 for rational.
//
// Reference: Piegl & Tiller, "The NURBS Book" (1997), §2, §11.

#include <Eigen/Core>
#include <Eigen/Geometry>
#include <nlohmann/json.hpp>
#include <array>
#include <string>
#include <vector>

namespace kern {

// ── Aliases ───────────────────────────────────────────────────────────────────

using Vec3 = Eigen::Vector3d;
using Vec4 = Eigen::Vector4d;  // homogeneous control point (x,y,z,w)

// ── Tolerance ─────────────────────────────────────────────────────────────────

constexpr double BREP_DEFAULT_TOLERANCE = 1e-6;

// ── NURBS primitives ──────────────────────────────────────────────────────────

/**
 * NURBS curve: degree d, n+1 control points, n+d+2 knots.
 * Mirrors TS Curve type in nurbs-curves.ts.
 */
struct NurbsCurve {
    int                  degree;
    int                  cvCount;
    std::vector<double>  knots;   // size: cvCount + degree + 1
    std::vector<Vec4>    cvs;     // homogeneous; w=1 for non-rational

    /** Evaluate point on curve at parameter t (Cox-de Boor). */
    Vec3 evaluate(double t) const;
};

/**
 * NURBS surface: bi-degree (degreeU, degreeV).
 * Control net stored row-major: cvs[i*cvCountV + j] = P_{i,j}.
 * Mirrors TS Surface type in nurbs-surfaces.ts.
 */
struct NurbsSurface {
    int                  degreeU, degreeV;
    int                  cvCountU, cvCountV;
    std::vector<double>  knotsU;  // size: cvCountU + degreeU + 1
    std::vector<double>  knotsV;  // size: cvCountV + degreeV + 1
    std::vector<Vec4>    cvs;     // row-major: cvs[i*cvCountV + j]

    /** Evaluate surface point at (u, v) using Cox-de Boor. */
    Vec3 evaluate(double u, double v) const;

    /** Surface normal at (u, v) via finite differences (h=1e-6). */
    Vec3 normalAt(double u, double v) const;

    /** Axis-aligned bounding box sampled over su*sv grid. */
    Eigen::AlignedBox3d bbox(int su = 8, int sv = 8) const;
};

// ── Trim topology ─────────────────────────────────────────────────────────────

/**
 * One trim edge: a 3D curve paired with its parameter-space (u,v) image.
 * Mirrors TS TrimEdge (future extension; kept minimal for now).
 */
struct TrimEdge {
    NurbsCurve curve3d;
    NurbsCurve curveUV;
    double     tolerance = BREP_DEFAULT_TOLERANCE;
};

/**
 * An ordered sequence of trim edges forming a closed boundary on a face.
 * isOuter=true → outer boundary; isOuter=false → inner hole (void).
 * Mirrors TS TrimLoop.
 */
struct TrimLoop {
    std::vector<TrimEdge> edges;
    bool                  isOuter = true;
};

// ── BRep topology ─────────────────────────────────────────────────────────────

/**
 * One face: a surface patch bounded by one outer and zero or more inner loops.
 * orientation=true → face normal agrees with surface normal (outward).
 * Mirrors TS BrepFace.
 */
struct BrepFace {
    NurbsSurface         surface;
    TrimLoop             outerLoop;
    std::vector<TrimLoop> innerLoops;
    bool                 orientation = true;
    double               tolerance   = BREP_DEFAULT_TOLERANCE;
};

/**
 * Topological edge: 3D curve shared by at most 2 faces.
 * faceIndex2 == -1 denotes a naked (boundary) edge.
 * Mirrors TS BrepEdge (faceIndex2 null → -1).
 */
struct BrepEdge {
    NurbsCurve curve;
    int        faceIndex1 = -1;
    int        faceIndex2 = -1;  // -1 = naked edge (TS null)
    double     tolerance  = BREP_DEFAULT_TOLERANCE;
};

/**
 * Topological vertex: geometric point where edges meet.
 * Mirrors TS BrepVertex.
 */
struct BrepVertex {
    Vec3              point;
    std::vector<int>  edgeIndices;
    double            tolerance = BREP_DEFAULT_TOLERANCE;
};

/**
 * Connected set of faces forming one manifold (or open) shell.
 * isClosed=true → all edges shared by exactly 2 faces (watertight).
 * Mirrors TS BrepShell.
 */
struct BrepShell {
    std::vector<BrepFace>   faces;
    std::vector<BrepEdge>   edges;
    std::vector<BrepVertex> vertices;
    bool                    isClosed = false;
};

/**
 * Boundary Representation: one or more shells.
 * Mirrors TS Brep.
 */
struct Brep {
    std::vector<BrepShell> shells;
};

// ── Free functions ────────────────────────────────────────────────────────────

/** Serialize Brep to JSON string. cvs as flat [x,y,z,w,...] doubles. */
std::string brepToJson(const Brep& brep);

/** Deserialize Brep from JSON string produced by brepToJson. */
Brep brepFromJson(const std::string& json);

/** True if every shell is closed (fully watertight solid). */
bool brepIsSolid(const Brep& brep);

/** Total face count across all shells. */
int brepFaceCount(const Brep& brep);

/** Count of naked edges (faceIndex2 == -1) across all shells. */
int brepNakedEdgeCount(const Brep& brep);

} // namespace kern
