#pragma once
// kern/loft.h — Loft (skinning) surface construction.
//
// Builds a NURBS loft surface through a sequence of NURBS profile curves using
// global-interpolation skinning (Piegl & Tiller §9.2).  Optionally caps the
// first and last profiles with planar faces to produce a closed solid BRep.
//
// Phase C constraint: all profiles must already share the same degree and a
// compatible knot vector.  Incompatible input returns LoftResult{ok=false}.

#include "brep.h"
#include <string>
#include <vector>

namespace kern {

// ── Options ───────────────────────────────────────────────────────────────────

struct LoftOptions {
    bool   closed   = false;   // close the loft in the v (profile) direction
    bool   solid    = true;    // cap first/last profiles with planar faces
    double tolerance = 1e-4;   // geometric tolerance for cap construction
};

// ── Result ────────────────────────────────────────────────────────────────────

struct LoftResult {
    bool        ok;
    Brep        brep;
    std::string error;
};

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Build a loft surface through @p profiles.
 *
 * Requirements (Phase C):
 *  - profiles.size() >= 2
 *  - all profiles have identical degree and cvCount
 *  - all profiles share the same knot vector
 *
 * Returns LoftResult{ok=false, error=...} on any violation or degenerate input.
 *
 * Algorithm summary:
 *  1. Validate compatibility.
 *  2. Chord-length parameterize the v direction from profile centroids.
 *  3. For each CV column i, global-interpolate a cubic spline through the N
 *     control points using the chord-length v parameters (tridiagonal solve).
 *  4. Assemble the resulting NurbsSurface.
 *  5. If solid=true, build planar cap faces for profile[0] and profile[N-1].
 *  6. Pack into BrepShell{isClosed = solid || closed} and return.
 */
LoftResult loft(const std::vector<NurbsCurve>& profiles,
                const LoftOptions& opts = {});

} // namespace kern
