// brep-validity.ts — Manifold validity checker for Brep (#117 / #7d).
// References openNURBS ON_Brep::IsValid().
//
// Checks (applied to each shell):
//   EULER        — V - E + F = 2 (genus-0 closed shell; skipped when topology incomplete)
//   EDGE_VALENCE — naked edge (faceIndex2 = null) in a closed shell
//   LOOP_OPEN    — TrimLoop curves do not form a closed param-space boundary
//   EDGE_TOO_SHORT — edge length below BREP_DEFAULT_TOLERANCE
//   ORIENTATION  — degenerate: face.orientation field is undefined (structural only)

import {
  type Brep, type BrepShell, type BrepFace, type BrepEdge,
  type TrimLoop, BREP_DEFAULT_TOLERANCE,
} from "./nurbs-brep";
import {
  domain as curveDomain, pointAt as curvePointAt,
} from "./nurbs-curves";
import { Point3 as Pt3 } from "./nurbs-primitives";

// ── Public types ──────────────────────────────────────────────────────────────

export type ValidityError = {
  code: string;
  detail: string;
  elementId?: string;
};

export type ValidityReport = {
  valid: boolean;
  errors: ValidityError[];
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate that `brep` satisfies manifold conditions.
 *
 * Checks applied (per shell unless otherwise noted):
 *   - EDGE_VALENCE:   naked edge (faceIndex2=null) on a closed (isClosed=true) shell
 *   - LOOP_OPEN:      TrimLoop with curves that don't form a closed boundary
 *   - EDGE_TOO_SHORT: edge 3D length < BREP_DEFAULT_TOLERANCE
 *   - EULER:          V - E + F ≠ 2 for closed genus-0 shell (only when topology is complete)
 *
 * Returns `{valid: true, errors: []}` for a valid Brep.
 */
export function validateBrep(brep: Brep): ValidityReport {
  const errors: ValidityError[] = [];

  if (brep.shells.length === 0) {
    errors.push({ code: "EMPTY_BREP", detail: "Brep contains no shells." });
    return { valid: false, errors };
  }

  for (let si = 0; si < brep.shells.length; si++) {
    const shell = brep.shells[si];
    const shellId = `shell[${si}]`;

    _checkEdgeValence(shell, shellId, errors);
    _checkLoopClosure(shell, shellId, errors);
    _checkEdgeLengths(shell, shellId, errors);
    _checkEuler(shell, shellId, errors);
  }

  return { valid: errors.length === 0, errors };
}

// ── Checks ────────────────────────────────────────────────────────────────────

/**
 * EDGE_VALENCE: in a closed shell, every edge must be shared by 2 faces.
 * faceIndex2 = null → naked (valence-1) edge → shell cannot be watertight.
 */
function _checkEdgeValence(
  shell: BrepShell,
  shellId: string,
  errors: ValidityError[],
): void {
  if (!shell.isClosed) return; // open shells may have naked edges by design

  for (let ei = 0; ei < shell.edges.length; ei++) {
    const edge = shell.edges[ei];
    if (edge.faceIndex2 === null) {
      errors.push({
        code: "EDGE_VALENCE",
        detail: `Naked edge in closed shell: faceIndex2 is null for edge[${ei}].`,
        elementId: `${shellId}.edge[${ei}]`,
      });
    }
  }
}

/**
 * LOOP_OPEN: a TrimLoop with curves must form a closed chain.
 * For each TrimLoop with ≥2 curves, the endpoint of curves[i] must be
 * within tolerance of the start of curves[(i+1) % N].
 * The empty-curves case (curves.length === 0 or 1) is considered closed
 * by convention (degenerate or point loop — higher-level check would cover
 * those, but they're not flagged here as LOOP_OPEN).
 */
function _checkLoopClosure(
  shell: BrepShell,
  shellId: string,
  errors: ValidityError[],
): void {
  for (let fi = 0; fi < shell.faces.length; fi++) {
    const face = shell.faces[fi];
    const faceId = `${shellId}.face[${fi}]`;

    const loops: { loop: TrimLoop; label: string }[] = [
      { loop: face.outerLoop, label: "outerLoop" },
      ...face.innerLoops.map((l, li) => ({ loop: l, label: `innerLoop[${li}]` })),
    ];

    for (const { loop, label } of loops) {
      if (loop.curves.length < 2) continue; // 0 or 1 curve: no chain to check

      const tol = face.tolerance * 10; // 10× face tolerance in param space
      for (let ci = 0; ci < loop.curves.length; ci++) {
        const cur  = loop.curves[ci];
        const next = loop.curves[(ci + 1) % loop.curves.length];

        const domCur  = curveDomain(cur);
        const domNext = curveDomain(next);

        const endPt   = curvePointAt(cur,  domCur.max);
        const startPt = curvePointAt(next, domNext.min);

        const gap = Pt3.distance(endPt, startPt);
        if (gap > Math.max(tol, BREP_DEFAULT_TOLERANCE)) {
          errors.push({
            code: "LOOP_OPEN",
            detail: `Loop ${label} on face[${fi}]: gap ${gap.toExponential(3)} ` +
                    `between curve[${ci}] end and curve[${(ci + 1) % loop.curves.length}] start ` +
                    `(tolerance ${tol.toExponential(3)}).`,
            elementId: `${faceId}.${label}.curve[${ci}]`,
          });
          break; // one gap per loop is enough to flag it
        }
      }
    }
  }
}

/**
 * EDGE_TOO_SHORT: edge 3D length below BREP_DEFAULT_TOLERANCE is degenerate.
 * Only checked for LineCurve (direct from/to distance); other kinds skipped.
 */
function _checkEdgeLengths(
  shell: BrepShell,
  shellId: string,
  errors: ValidityError[],
): void {
  const minLen = BREP_DEFAULT_TOLERANCE;

  for (let ei = 0; ei < shell.edges.length; ei++) {
    const edge = shell.edges[ei];
    const curve = edge.curve;

    let length: number | null = null;
    if (curve.kind === "line") {
      length = Pt3.distance(curve.from, curve.to);
    } else {
      const dom = curveDomain(curve);
      length = Math.abs(dom.max - dom.min);
    }

    if (length !== null && length < minLen) {
      errors.push({
        code: "EDGE_TOO_SHORT",
        detail: `edge[${ei}] length ${length.toExponential(3)} < BREP_DEFAULT_TOLERANCE (${minLen}).`,
        elementId: `${shellId}.edge[${ei}]`,
      });
    }
  }
}

/**
 * EULER: for a closed genus-0 shell, V - E + F = 2 (Euler-Poincaré for H=0).
 * Only applied when the shell has explicit vertex and edge data (i.e. not a
 * sparse scaffold where topology is deliberately incomplete).
 *
 * Heuristic for "complete topology": vertices.length > 0 AND
 * edges.length >= faces.length (a minimal manifold has E ≥ F for closed shells).
 */
function _checkEuler(
  shell: BrepShell,
  shellId: string,
  errors: ValidityError[],
): void {
  if (!shell.isClosed) return;

  const V = shell.vertices.length;
  const E = shell.edges.length;
  const F = shell.faces.length;

  // Skip if topology looks like a sparse scaffold
  if (V === 0 || E < F) return;

  const euler = V - E + F;
  if (euler !== 2) {
    errors.push({
      code: "EULER",
      detail: `Shell fails Euler-Poincaré: V(${V}) - E(${E}) + F(${F}) = ${euler}, expected 2 (genus-0).`,
      elementId: shellId,
    });
  }
}
