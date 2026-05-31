#pragma once
// kern/chamfer.h — Equal-distance planar chamfer for BRep edges.
//
// Supported: edges between two planar faces (degree-1 surface normals constant).
// Not supported: curved-face edges — returns ChamferResult{false, {}, error}.
//
// Parity target: distance match within 1e-3 vs replicad Shape.chamfer().
//
// Usage:
//   ChamferOptions opts;
//   opts.distance     = 2.0;
//   opts.edgeIndices  = {0, 3};
//   ChamferResult r   = chamfer(brep, opts);
//   if (r.ok) use(r.brep);

#include "brep.h"
#include <string>
#include <vector>

// ── Options ───────────────────────────────────────────────────────────────────

struct ChamferOptions {
    /// Chamfer distance (set-back on each adjacent face).
    double distance;

    /// Zero-based indices into BrepShell::edges of the first shell.
    /// All referenced edges must connect two planar faces.
    std::vector<int> edgeIndices;

    /// Geometric coincidence tolerance used for trim-loop construction.
    double tolerance = 1e-4;
};

// ── Result ────────────────────────────────────────────────────────────────────

struct ChamferResult {
    bool        ok;
    kern::Brep  brep;   // populated only when ok == true
    std::string error;  // populated only when ok == false
};

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Apply equal-distance chamfer to the listed edges of the first shell in
 * `input`.  Only planar-face edges are supported; curved-face edges return an
 * error without modifying the Brep.
 *
 * Algorithm (per edge):
 *  1. Retrieve the two adjacent BrepFaces.
 *  2. Evaluate each face's constant normal; verify planarity.
 *  3. Offset the shared edge line inward on each face by `distance`.
 *  4. Build a ruled NurbsSurface (degreeU=1, degreeV=1) spanning the two
 *     offset lines — this is the chamfer face.
 *  5. Add an inner TrimLoop to each adjacent face clipping it at the offset
 *     line (replaces the outer edge segment with the setback line).
 *  6. Collect trimmed original faces + new chamfer faces into a new BrepShell.
 */
ChamferResult chamfer(const kern::Brep& input, const ChamferOptions& opts);
