#pragma once
// kern/fillet.h — Rolling-ball fillet for planar-adjacent faces.
//
// Only planar face pairs are supported in this iteration. Curved-face edges
// return a non-ok result with a descriptive error string so the caller can
// route the failure gracefully.
//
// Reference: Piegl & Tiller §10.7 (ruled/swept NURBS surfaces).

#include "brep.h"
#include <string>
#include <vector>

namespace kern {

/**
 * Options controlling fillet generation.
 *
 * radius       Rolling-ball radius (model units, must be > 0).
 * edgeIndices  Indices into BrepShell::edges to fillet. If empty, every
 *              non-naked edge (faceIndex2 != -1) in the first shell is used.
 * tolerance    Geometric tolerance forwarded to produced trim edges / faces.
 */
struct FilletOptions {
    double           radius;
    std::vector<int> edgeIndices; // empty = all non-naked edges
    double           tolerance = 1e-4;
};

/**
 * Result returned by fillet().
 *
 * ok    true  → brep is the filleted solid; error is empty.
 *       false → brep is unchanged / empty; error describes the first failure.
 */
struct FilletResult {
    bool        ok;
    Brep        brep;
    std::string error;
};

/**
 * Produce a fillet on every requested edge of the first shell of `input`.
 *
 * For each target edge the algorithm:
 *   1. Evaluates face normals of the two adjacent planar faces.
 *   2. Computes the dihedral angle θ between them.
 *   3. Offsets each face inward by d = radius / tan(θ/2).
 *   4. Builds a cylindrical arc NurbsSurface sweeping (π − θ) along the edge.
 *   5. Adds inner TrimLoops to both adjacent faces at offset d.
 *   6. Assembles trimmed original faces + fillet patches into a new BrepShell.
 *
 * Returns FilletResult{false, {}, "curved-face fillet not yet implemented …"}
 * for any edge whose adjacent faces are not planar.
 *
 * Preconditions:
 *   - input has at least one shell.
 *   - opts.radius > 0.
 */
FilletResult fillet(const Brep& input, const FilletOptions& opts);

} // namespace kern
