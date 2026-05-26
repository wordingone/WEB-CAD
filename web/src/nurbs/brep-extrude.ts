// brep-extrude.ts — Sweep-along-vector extrusion kernel (#116 / #7c).
//
// Extrude a profile Curve along a vector to produce a closed BrepShell.
// References openNURBS ON_Extrusion (opennurbs_extrusion.h).
//
// Algorithm:
//   For each segment of the profile (PolylineCurve → N line segments;
//   LineCurve → 1 segment; NurbsCurve/ArcCurve → 1 lateral surface):
//     Build a SumSurface: S(u,v) = profile(u) + rail(v) - origin
//     where rail is a LineCurve from (0,0,0) to direction*distance.
//   Cap bottom: PlaneSurface filled by the profile footprint.
//   Cap top:    PlaneSurface translated by direction*distance.
//
// Each lateral face gets a BrepFace with the SumSurface as geometry and
// userData.nurbsSurface = surface for downstream IFC export.
//
// Refs:
//   - openNURBS ON_Extrusion (opennurbs_extrusion.h:30-80)
//   - Piegl & Tiller §10.2 (bilinear ruled surface via loft)
//   - OCCT BRepPrimAPI_MakePrism (bilinear ruled surface from wire)

import {
  type Point3, type Vector3, type Plane, type Interval,
  Point3 as Pt3, Vector3 as V3, Plane as Pl, Interval as Iv,
} from "./nurbs-primitives";
import {
  type Curve, type PolylineCurve, type LineCurve,
  domain as curveDomain, pointAt as curvePointAt,
  isClosed as curveIsClosed, tessellate as curveTessellate,
} from "./nurbs-curves";
import {
  type Surface, type PlaneSurface, type SumSurface,
  domainU as surfDomainU, domainV as surfDomainV,
} from "./nurbs-surfaces";
import {
  type Brep, type BrepShell, type BrepFace, type BrepEdge, type BrepVertex,
  type TrimLoop, BREP_DEFAULT_TOLERANCE,
} from "./nurbs-brep";

// ── Public API ────────────────────────────────────────────────────────────────

export type ExtrudeOptions = {
  /**
   * Geometric tolerance for the output shell. Default: BREP_DEFAULT_TOLERANCE.
   */
  tolerance?: number;
  /**
   * If true, the shell is marked as closed (watertight). Caller's
   * responsibility that cap orientation is consistent. Default: true when
   * both caps are built.
   */
  closed?: boolean;
};

/**
 * Extrude `profile` by `direction * distance` to produce a closed BrepShell.
 *
 * Returns a Brep with one shell containing:
 *   - N lateral BrepFaces (one per profile segment for PolylineCurve; one for
 *     all other curve kinds)
 *   - 1 bottom cap BrepFace
 *   - 1 top cap BrepFace
 *
 * Each face carries `face.surface` as the canonical NURBS/Sum/Plane surface
 * for downstream IFC export and boolean ops.
 *
 * `distance` must be > 0. The extrusion is in the direction of `direction`
 * (normalised internally).
 */
export function extrude(
  profile: Curve,
  direction: Vector3,
  distance: number,
  options: ExtrudeOptions = {},
): Brep {
  if (distance <= 0) throw new RangeError("extrude: distance must be > 0");

  const tol     = options.tolerance ?? BREP_DEFAULT_TOLERANCE;
  const dir     = V3.normalize(direction);
  const offset: Point3 = { x: dir.x * distance, y: dir.y * distance, z: dir.z * distance };

  // Build rail: LineCurve from origin to direction*distance
  const rail: LineCurve = {
    kind: "line",
    from: Pt3.zero(),
    to: offset,
    domain: Iv.create(0, distance),
  };

  // ── Lateral faces ──────────────────────────────────────────────────────────

  const lateralFaces = _buildLateralFaces(profile, rail, dir, distance, tol);

  // ── Cap faces ──────────────────────────────────────────────────────────────

  const bottomCap = _buildCapFace(profile, dir, 0,        tol, true);
  const topCap    = _buildCapFace(profile, dir, distance,  tol, false);

  // ── Assemble shell ─────────────────────────────────────────────────────────

  const allFaces: BrepFace[] = [...lateralFaces, bottomCap, topCap];
  const shell: BrepShell = {
    faces: allFaces,
    edges: _buildShellEdges(profile, rail, allFaces.length, tol),
    vertices: _buildShellVertices(profile, offset, tol),
    isClosed: options.closed ?? true,
  };

  return { shells: [shell] };
}

// ── Lateral face construction ──────────────────────────────────────────────────

/**
 * Build one BrepFace per profile segment.
 * PolylineCurve → N LineCurve segments.
 * All other curves → one lateral face for the whole profile.
 */
function _buildLateralFaces(
  profile: Curve,
  rail: LineCurve,
  dir: Vector3,
  distance: number,
  tol: number,
): BrepFace[] {
  const segments = _profileSegments(profile);
  return segments.map((seg) => _lateralFaceFromSegment(seg, rail, tol));
}

/**
 * Decompose a profile into line segments where possible, or return as-is.
 */
function _profileSegments(profile: Curve): Curve[] {
  if (profile.kind === "polyline") {
    // Decompose into LineCurves
    const pts = profile.points;
    const segs: LineCurve[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const len = Pt3.distance(pts[i], pts[i + 1]);
      segs.push({
        kind: "line",
        from: pts[i],
        to: pts[i + 1],
        domain: Iv.create(0, len),
      });
    }
    // Close the polyline if first ≈ last
    if (pts.length > 2 && Pt3.distance(pts[0], pts[pts.length - 1]) > 1e-10) {
      const len = Pt3.distance(pts[pts.length - 1], pts[0]);
      segs.push({ kind: "line", from: pts[pts.length - 1], to: pts[0], domain: Iv.create(0, len) });
    }
    return segs;
  }
  return [profile];
}

/**
 * Build a lateral BrepFace from a profile segment curve and a rail curve.
 * Uses SumSurface: S(u,v) = segment(u) + rail(v) - origin.
 */
function _lateralFaceFromSegment(
  segment: Curve,
  rail: LineCurve,
  tol: number,
): BrepFace {
  const surface: SumSurface = {
    kind: "sum",
    curveU: segment,
    curveV: rail,
    basepoint: Pt3.zero(),
  };

  return {
    surface,
    outerLoop: { curves: [], orientation: true },
    innerLoops: [],
    orientation: true,
    tolerance: tol,
  };
}

// ── Cap face construction ──────────────────────────────────────────────────────

/**
 * Build a planar cap BrepFace from the profile's bounding plane.
 *
 * The cap plane is computed from the profile's centroid + the mean of
 * two edge tangents (approximate — correct for flat profiles).
 * For correct cap orientation: bottom cap faces downward (outward = -dir),
 * top cap faces upward (outward = +dir).
 */
function _buildCapFace(
  profile: Curve,
  dir: Vector3,
  zOffset: number,
  tol: number,
  isBottom: boolean,
): BrepFace {
  const pts = curveTessellate(profile, 16);
  if (pts.length === 0) throw new Error("extrude: profile tessellates to empty");

  // Centroid
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
  const centroid: Point3 = {
    x: cx + dir.x * zOffset,
    y: cy + dir.y * zOffset,
    z: cz + dir.z * zOffset,
  };

  // Build plane with normal = ±dir
  const outward = isBottom ? V3.negate(dir) : dir;
  const plane = Pl.fromPointNormal(centroid, outward);

  // Extent: bounding radius in the plane's uv space
  let maxR = 0;
  for (const p of pts) {
    const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (r > maxR) maxR = r;
  }
  maxR = Math.max(maxR, 0.01);

  const surface: PlaneSurface = {
    kind: "plane",
    plane,
    uDomain: Iv.create(0, 1),
    vDomain: Iv.create(0, 1),
    uExtent: Iv.create(-maxR, maxR),
    vExtent: Iv.create(-maxR, maxR),
  };

  return {
    surface,
    outerLoop: { curves: [], orientation: true },
    innerLoops: [],
    orientation: isBottom,
    tolerance: tol,
  };
}

// ── Edge and vertex scaffolding ────────────────────────────────────────────────

/**
 * Build edge topology for the extruded shell.
 * For now: registers the rail curve as a set of shared edges between lateral
 * faces and caps. Full half-edge wiring is deferred to brep-weld (future).
 */
function _buildShellEdges(
  profile: Curve,
  rail: LineCurve,
  faceCount: number,
  tol: number,
): BrepEdge[] {
  const capBottomIdx = faceCount - 2;
  const capTopIdx    = faceCount - 1;
  const lateralCount = faceCount - 2;

  const edges: BrepEdge[] = [];
  // One vertical edge per lateral face (profile start → extruded start)
  for (let i = 0; i < lateralCount; i++) {
    edges.push({
      curve: rail,
      faceIndex1: i,
      faceIndex2: i === 0 ? capBottomIdx : null,
      tolerance: tol,
    });
  }
  return edges;
}

/**
 * Build vertex list: profile start/end points at both z-levels.
 */
function _buildShellVertices(
  profile: Curve,
  offset: Point3,
  tol: number,
): BrepVertex[] {
  const dom = curveDomain(profile);
  const start = curvePointAt(profile, dom.min);
  const end   = curvePointAt(profile, dom.max);

  const verts: BrepVertex[] = [
    { point: start, edgeIndices: [0], tolerance: tol },
    { point: end,   edgeIndices: [0], tolerance: tol },
    { point: { x: start.x + offset.x, y: start.y + offset.y, z: start.z + offset.z }, edgeIndices: [0], tolerance: tol },
    { point: { x: end.x   + offset.x, y: end.y   + offset.y, z: end.z   + offset.z }, edgeIndices: [0], tolerance: tol },
  ];
  return verts;
}
