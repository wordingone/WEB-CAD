#pragma once
// kern/boolean.h — BRep boolean operations (union, difference, intersection).
//
// Pipeline (§3, kern-architecture.md):
//   [1] SSI — face-face intersection curves
//   [2] Face classification — IN / OUT / ON per solid
//   [3] Trim & split at SSI curves
//   [4] Face selection by operation
//   [5] Assembly + topology repair
//   [6] Healing (sliver removal)
//
// All three public wrappers delegate to boolOp().

#include "brep.h"
#include "ssi.h"
#include <string>

namespace kern {

// ── Operation selector ────────────────────────────────────────────────────────

enum class BooleanOp { UNION, DIFFERENCE, INTERSECTION };

// ── Result ────────────────────────────────────────────────────────────────────

struct BooleanResult {
    bool        ok    = false;
    Brep        brep;
    std::string error;
};

// ── Public API ────────────────────────────────────────────────────────────────

BooleanResult boolOp(const Brep& a, const Brep& b,
                     BooleanOp op, double tol = 1e-4);

inline BooleanResult boolUnion(const Brep& a, const Brep& b,
                                double tol = 1e-4)
{ return boolOp(a, b, BooleanOp::UNION, tol); }

inline BooleanResult boolDifference(const Brep& a, const Brep& b,
                                     double tol = 1e-4)
{ return boolOp(a, b, BooleanOp::DIFFERENCE, tol); }

inline BooleanResult boolIntersection(const Brep& a, const Brep& b,
                                       double tol = 1e-4)
{ return boolOp(a, b, BooleanOp::INTERSECTION, tol); }

} // namespace kern
