// kern/brep.cpp — BRep geometry and serialization implementations.
//
// Algorithms:
//   Cox-de Boor basis evaluation (Piegl & Tiller §2.2, §2.3).
//   Surface normal via central finite differences.
//   JSON serialization via nlohmann/json; cvs stored as flat [x,y,z,w,...].

#include "brep.h"

#include <Eigen/Geometry>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace kern {

// ── Cox-de Boor helpers ───────────────────────────────────────────────────────

/** Find the knot span index i such that knots[i] <= t < knots[i+1].
 *  Clamps t to [knots[degree], knots[n]] to avoid out-of-range access.
 *  n = cvCount - 1.  Ref: Piegl & Tiller, Algorithm A2.1. */
static int findKnotSpan(int n, int degree, double t,
                        const std::vector<double>& knots) {
    // Clamp to valid domain
    if (t >= knots[n + 1]) return n;
    if (t <= knots[degree]) return degree;

    int lo = degree, hi = n + 1;
    int mid = (lo + hi) / 2;
    while (t < knots[mid] || t >= knots[mid + 1]) {
        if (t < knots[mid]) hi = mid;
        else                lo = mid;
        mid = (lo + hi) / 2;
    }
    return mid;
}

/** Compute non-zero B-spline basis functions N[0..degree] at parameter t
 *  for knot span i.  Ref: Piegl & Tiller, Algorithm A2.2. */
static std::vector<double> basisFunctions(int i, double t, int degree,
                                          const std::vector<double>& knots) {
    std::vector<double> N(degree + 1, 0.0);
    std::vector<double> left(degree + 1), right(degree + 1);

    N[0] = 1.0;
    for (int j = 1; j <= degree; ++j) {
        left[j]  = t - knots[i + 1 - j];
        right[j] = knots[i + j] - t;
        double saved = 0.0;
        for (int r = 0; r < j; ++r) {
            double denom = right[r + 1] + left[j - r];
            if (std::abs(denom) < 1e-14) {
                N[r] = saved;
                saved = 0.0;
            } else {
                double tmp = N[r] / denom;
                N[r] = saved + right[r + 1] * tmp;
                saved = left[j - r] * tmp;
            }
        }
        N[j] = saved;
    }
    return N;
}

// ── NurbsCurve::evaluate ──────────────────────────────────────────────────────

Vec3 NurbsCurve::evaluate(double t) const {
    int n = cvCount - 1;
    int span = findKnotSpan(n, degree, t, knots);
    auto N = basisFunctions(span, t, degree, knots);

    // Accumulate homogeneous sum
    Vec4 Cw = Vec4::Zero();
    for (int j = 0; j <= degree; ++j)
        Cw += N[j] * cvs[span - degree + j];

    // Divide by weight
    if (std::abs(Cw.w()) < 1e-14) return Cw.head<3>();
    return Cw.head<3>() / Cw.w();
}

// ── NurbsSurface::evaluate ────────────────────────────────────────────────────

Vec3 NurbsSurface::evaluate(double u, double v) const {
    int nu = cvCountU - 1;
    int nv = cvCountV - 1;

    int spanU = findKnotSpan(nu, degreeU, u, knotsU);
    int spanV = findKnotSpan(nv, degreeV, v, knotsV);
    auto Nu = basisFunctions(spanU, u, degreeU, knotsU);
    auto Nv = basisFunctions(spanV, v, degreeV, knotsV);

    Vec4 Sw = Vec4::Zero();
    for (int i = 0; i <= degreeU; ++i) {
        Vec4 tmp = Vec4::Zero();
        int row = spanU - degreeU + i;
        for (int j = 0; j <= degreeV; ++j) {
            int col = spanV - degreeV + j;
            tmp += Nv[j] * cvs[row * cvCountV + col];
        }
        Sw += Nu[i] * tmp;
    }

    if (std::abs(Sw.w()) < 1e-14) return Sw.head<3>();
    return Sw.head<3>() / Sw.w();
}

// ── NurbsSurface::normalAt ────────────────────────────────────────────────────

Vec3 NurbsSurface::normalAt(double u, double v) const {
    constexpr double h = 1e-6;
    Vec3 du = (evaluate(u + h, v) - evaluate(u - h, v)) / (2.0 * h);
    Vec3 dv = (evaluate(u, v + h) - evaluate(u, v - h)) / (2.0 * h);
    Vec3 n  = du.cross(dv);
    double len = n.norm();
    if (len < 1e-14) return Vec3(0.0, 0.0, 1.0);
    return n / len;
}

// ── NurbsSurface::bbox ────────────────────────────────────────────────────────

Eigen::AlignedBox3d NurbsSurface::bbox(int su, int sv) const {
    Eigen::AlignedBox3d box;
    double uMin = knotsU.front(), uMax = knotsU.back();
    double vMin = knotsV.front(), vMax = knotsV.back();

    for (int i = 0; i < su; ++i) {
        double u = uMin + (uMax - uMin) * i / (su - 1);
        for (int j = 0; j < sv; ++j) {
            double v = vMin + (vMax - vMin) * j / (sv - 1);
            box.extend(evaluate(u, v));
        }
    }
    return box;
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

using json = nlohmann::json;

static json cvToJson(const std::vector<Vec4>& cvs) {
    json arr = json::array();
    for (const auto& p : cvs) {
        arr.push_back(p.x());
        arr.push_back(p.y());
        arr.push_back(p.z());
        arr.push_back(p.w());
    }
    return arr;
}

static std::vector<Vec4> cvFromJson(const json& arr) {
    std::vector<Vec4> out;
    out.reserve(arr.size() / 4);
    for (size_t i = 0; i + 3 < arr.size(); i += 4)
        out.emplace_back(arr[i].get<double>(), arr[i+1].get<double>(),
                         arr[i+2].get<double>(), arr[i+3].get<double>());
    return out;
}

static json curveToJson(const NurbsCurve& c) {
    return {{"degree", c.degree}, {"cvCount", c.cvCount},
            {"knots",  c.knots},  {"cvs",     cvToJson(c.cvs)}};
}

static NurbsCurve curveFromJson(const json& j) {
    NurbsCurve c;
    c.degree  = j.at("degree").get<int>();
    c.cvCount = j.at("cvCount").get<int>();
    c.knots   = j.at("knots").get<std::vector<double>>();
    c.cvs     = cvFromJson(j.at("cvs"));
    return c;
}

static json surfaceToJson(const NurbsSurface& s) {
    return {{"degreeU",  s.degreeU},  {"degreeV",  s.degreeV},
            {"cvCountU", s.cvCountU}, {"cvCountV", s.cvCountV},
            {"knotsU",   s.knotsU},   {"knotsV",   s.knotsV},
            {"cvs",      cvToJson(s.cvs)}};
}

static NurbsSurface surfaceFromJson(const json& j) {
    NurbsSurface s;
    s.degreeU  = j.at("degreeU").get<int>();
    s.degreeV  = j.at("degreeV").get<int>();
    s.cvCountU = j.at("cvCountU").get<int>();
    s.cvCountV = j.at("cvCountV").get<int>();
    s.knotsU   = j.at("knotsU").get<std::vector<double>>();
    s.knotsV   = j.at("knotsV").get<std::vector<double>>();
    s.cvs      = cvFromJson(j.at("cvs"));
    return s;
}

static json trimEdgeToJson(const TrimEdge& e) {
    return {{"curve3d",   curveToJson(e.curve3d)},
            {"curveUV",   curveToJson(e.curveUV)},
            {"tolerance", e.tolerance}};
}

static TrimEdge trimEdgeFromJson(const json& j) {
    TrimEdge e;
    e.curve3d  = curveFromJson(j.at("curve3d"));
    e.curveUV  = curveFromJson(j.at("curveUV"));
    e.tolerance = j.value("tolerance", BREP_DEFAULT_TOLERANCE);
    return e;
}

static json trimLoopToJson(const TrimLoop& l) {
    json edges = json::array();
    for (const auto& e : l.edges) edges.push_back(trimEdgeToJson(e));
    return {{"edges", edges}, {"isOuter", l.isOuter}};
}

static TrimLoop trimLoopFromJson(const json& j) {
    TrimLoop l;
    l.isOuter = j.value("isOuter", true);
    for (const auto& e : j.at("edges")) l.edges.push_back(trimEdgeFromJson(e));
    return l;
}

static json faceToJson(const BrepFace& f) {
    json inners = json::array();
    for (const auto& il : f.innerLoops) inners.push_back(trimLoopToJson(il));
    return {{"surface",    surfaceToJson(f.surface)},
            {"outerLoop",  trimLoopToJson(f.outerLoop)},
            {"innerLoops", inners},
            {"orientation", f.orientation},
            {"tolerance",   f.tolerance}};
}

static BrepFace faceFromJson(const json& j) {
    BrepFace f;
    f.surface     = surfaceFromJson(j.at("surface"));
    f.outerLoop   = trimLoopFromJson(j.at("outerLoop"));
    f.orientation = j.value("orientation", true);
    f.tolerance   = j.value("tolerance", BREP_DEFAULT_TOLERANCE);
    for (const auto& il : j.at("innerLoops")) f.innerLoops.push_back(trimLoopFromJson(il));
    return f;
}

static json edgeToJson(const BrepEdge& e) {
    return {{"curve",      curveToJson(e.curve)},
            {"faceIndex1", e.faceIndex1},
            {"faceIndex2", e.faceIndex2},
            {"tolerance",  e.tolerance}};
}

static BrepEdge edgeFromJson(const json& j) {
    BrepEdge e;
    e.curve      = curveFromJson(j.at("curve"));
    e.faceIndex1 = j.value("faceIndex1", -1);
    e.faceIndex2 = j.value("faceIndex2", -1);
    e.tolerance  = j.value("tolerance", BREP_DEFAULT_TOLERANCE);
    return e;
}

static json vertexToJson(const BrepVertex& v) {
    return {{"point",       {v.point.x(), v.point.y(), v.point.z()}},
            {"edgeIndices", v.edgeIndices},
            {"tolerance",   v.tolerance}};
}

static BrepVertex vertexFromJson(const json& j) {
    BrepVertex v;
    auto& p = j.at("point");
    v.point = Vec3(p[0].get<double>(), p[1].get<double>(), p[2].get<double>());
    v.edgeIndices = j.at("edgeIndices").get<std::vector<int>>();
    v.tolerance   = j.value("tolerance", BREP_DEFAULT_TOLERANCE);
    return v;
}

static json shellToJson(const BrepShell& s) {
    json faces = json::array(), edges = json::array(), verts = json::array();
    for (const auto& f : s.faces)    faces.push_back(faceToJson(f));
    for (const auto& e : s.edges)    edges.push_back(edgeToJson(e));
    for (const auto& v : s.vertices) verts.push_back(vertexToJson(v));
    return {{"faces", faces}, {"edges", edges}, {"vertices", verts},
            {"isClosed", s.isClosed}};
}

static BrepShell shellFromJson(const json& j) {
    BrepShell s;
    s.isClosed = j.value("isClosed", false);
    for (const auto& f : j.at("faces"))    s.faces.push_back(faceFromJson(f));
    for (const auto& e : j.at("edges"))    s.edges.push_back(edgeFromJson(e));
    for (const auto& v : j.at("vertices")) s.vertices.push_back(vertexFromJson(v));
    return s;
}

// ── Public free functions ─────────────────────────────────────────────────────

std::string brepToJson(const Brep& brep) {
    json shells = json::array();
    for (const auto& s : brep.shells) shells.push_back(shellToJson(s));
    return json{{"shells", shells}}.dump();
}

Brep brepFromJson(const std::string& str) {
    Brep brep;
    auto j = json::parse(str);
    for (const auto& s : j.at("shells")) brep.shells.push_back(shellFromJson(s));
    return brep;
}

bool brepIsSolid(const Brep& brep) {
    if (brep.shells.empty()) return false;
    for (const auto& s : brep.shells)
        if (!s.isClosed) return false;
    return true;
}

int brepFaceCount(const Brep& brep) {
    int n = 0;
    for (const auto& s : brep.shells) n += static_cast<int>(s.faces.size());
    return n;
}

int brepNakedEdgeCount(const Brep& brep) {
    int n = 0;
    for (const auto& s : brep.shells)
        for (const auto& e : s.edges)
            if (e.faceIndex2 == -1) ++n;
    return n;
}

} // namespace kern
