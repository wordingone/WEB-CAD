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
  type Point3, type Vector3,
  Point3 as Pt3, Vector3 as V3, Plane as Pl, Interval as Iv,
} from "./nurbs-primitives";
import {
  type Curve, type LineCurve, type PolylineCurve,
  domain as curveDomain, pointAt as curvePointAt,
  tessellate as curveTessellate,
  transform as transformCurve,
} from "./nurbs-curves";
import {
  type PlaneSurface, type SumSurface,
} from "./nurbs-surfaces";
import {
  type Brep, type BrepShell, type BrepFace, type BrepEdge, type BrepVertex,
  BREP_DEFAULT_TOLERANCE,
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
  const edges = _buildShellEdges(profile, rail, allFaces.length, offset, tol);
  const vertices = _buildShellVertices(profile, offset, edges.length, tol);
  const shell: BrepShell = {
    faces: allFaces,
    edges,
    vertices,
    isClosed: options.closed ?? (edges.length > 0 && edges.every((edge) => edge.faceIndex2 !== null)),
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
  const pts = profile.kind === "polyline" ? profile.points : curveTessellate(profile, 16);
  if (pts.length === 0) throw new Error("extrude: profile tessellates to empty");
  const openPts = pts.length > 1 && Pt3.distance(pts[0], pts[pts.length - 1]) < 1e-10
    ? pts.slice(0, -1)
    : pts;

  // Centroid
  const cx = openPts.reduce((s, p) => s + p.x, 0) / openPts.length;
  const cy = openPts.reduce((s, p) => s + p.y, 0) / openPts.length;
  const cz = openPts.reduce((s, p) => s + p.z, 0) / openPts.length;
  const centroid: Point3 = {
    x: cx + dir.x * zOffset,
    y: cy + dir.y * zOffset,
    z: cz + dir.z * zOffset,
  };

  // Build plane with normal = ±dir
  const outward = isBottom ? V3.negate(dir) : dir;
  const plane = Pl.fromPointNormal(centroid, outward);

  const trimUv = [...openPts, openPts[0]].map((p) => {
    const capPoint = {
      x: p.x + dir.x * zOffset,
      y: p.y + dir.y * zOffset,
      z: p.z + dir.z * zOffset,
    };
    const d = Pt3.sub(capPoint, centroid);
    return {
      u: V3.dot(d, plane.xAxis),
      v: V3.dot(d, plane.yAxis),
    };
  });
  const uValues = trimUv.map((p) => p.u);
  const vValues = trimUv.map((p) => p.v);
  let uMin = Math.min(...uValues);
  let uMax = Math.max(...uValues);
  let vMin = Math.min(...vValues);
  let vMax = Math.max(...vValues);
  if (Math.abs(uMax - uMin) < 1e-9) {
    uMin -= 0.005;
    uMax += 0.005;
  }
  if (Math.abs(vMax - vMin) < 1e-9) {
    vMin -= 0.005;
    vMax += 0.005;
  }

  const surface: PlaneSurface = {
    kind: "plane",
    plane,
    uDomain: Iv.create(uMin, uMax),
    vDomain: Iv.create(vMin, vMax),
    uExtent: Iv.create(uMin, uMax),
    vExtent: Iv.create(vMin, vMax),
  };
  const trimPoints = trimUv.map((p) => ({ x: p.u, y: p.v, z: 0 }));
  const parameters = [0];
  for (let i = 1; i < trimPoints.length; i++) {
    parameters.push(parameters[i - 1] + Math.hypot(
      trimPoints[i].x - trimPoints[i - 1].x,
      trimPoints[i].y - trimPoints[i - 1].y,
    ));
  }

  return {
    surface,
    outerLoop: { curves: [{ kind: "polyline", points: trimPoints, parameters }], orientation: true },
    innerLoops: [],
    orientation: isBottom,
    tolerance: tol,
  };
}

// ── Edge and vertex scaffolding ────────────────────────────────────────────────

/**
 * Build edge topology for the extruded shell.
 * Closed polyline profiles get explicit bottom, top, and vertical shared
 * edges so `isClosed` is backed by topology instead of a placeholder flag.
 */
function _buildShellEdges(
  profile: Curve,
  rail: LineCurve,
  faceCount: number,
  offset: Point3,
  tol: number,
): BrepEdge[] {
  const capBottomIdx = faceCount - 2;
  const capTopIdx = faceCount - 1;
  const lateralCount = faceCount - 2;

  if (profile.kind === "polyline") {
    const segments = _profileSegments(profile);
    const points = _profileLoopPoints(profile);
    if (segments.length >= 3 && points.length === segments.length) {
      const edges: BrepEdge[] = [];
      for (let i = 0; i < segments.length; i++) {
        edges.push({ curve: segments[i], faceIndex1: i, faceIndex2: capBottomIdx, tolerance: tol });
      }
      for (let i = 0; i < segments.length; i++) {
        edges.push({ curve: _translateCurve(segments[i], offset), faceIndex1: i, faceIndex2: capTopIdx, tolerance: tol });
      }
      for (let i = 0; i < points.length; i++) {
        edges.push({
          curve: _line(points[i], _offsetPoint(points[i], offset)),
          faceIndex1: (i - 1 + segments.length) % segments.length,
          faceIndex2: i,
          tolerance: tol,
        });
      }
      return edges;
    }
  }

  if (_curveIsClosed(profile)) {
    return [
      { curve: profile, faceIndex1: 0, faceIndex2: capBottomIdx, tolerance: tol },
      { curve: _translateCurve(profile, offset), faceIndex1: 0, faceIndex2: capTopIdx, tolerance: tol },
    ];
  }

  const edges: BrepEdge[] = [];
  // Open profiles stay surface-like: their side boundaries are naked edges.
  for (let i = 0; i < lateralCount; i++) {
    edges.push({
      curve: rail,
      faceIndex1: i,
      faceIndex2: null,
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
  edgeCount: number,
  tol: number,
): BrepVertex[] {
  if (profile.kind === "polyline") {
    const points = _profileLoopPoints(profile);
    const segments = _profileSegments(profile);
    if (segments.length >= 3 && points.length === segments.length && edgeCount >= segments.length * 3) {
      const n = segments.length;
      const verts: BrepVertex[] = [];
      for (let i = 0; i < n; i++) {
        verts.push({
          point: points[i],
          edgeIndices: [(i - 1 + n) % n, i, 2 * n + i],
          tolerance: tol,
        });
      }
      for (let i = 0; i < n; i++) {
        verts.push({
          point: _offsetPoint(points[i], offset),
          edgeIndices: [n + ((i - 1 + n) % n), n + i, 2 * n + i],
          tolerance: tol,
        });
      }
      return verts;
    }
  }

  if (_curveIsClosed(profile)) return [];

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

function _profileLoopPoints(profile: PolylineCurve): Point3[] {
  if (profile.points.length > 1 && Pt3.distance(profile.points[0], profile.points[profile.points.length - 1]) <= 1e-10) {
    return profile.points.slice(0, -1);
  }
  return profile.points;
}

function _curveIsClosed(profile: Curve): boolean {
  const dom = curveDomain(profile);
  return Pt3.distance(curvePointAt(profile, dom.min), curvePointAt(profile, dom.max)) <= 1e-10;
}

function _offsetPoint(point: Point3, offset: Point3): Point3 {
  return { x: point.x + offset.x, y: point.y + offset.y, z: point.z + offset.z };
}

function _line(from: Point3, to: Point3): LineCurve {
  return { kind: "line", from, to, domain: Iv.create(0, Pt3.distance(from, to)) };
}

function _translateCurve(curve: Curve, offset: Point3): Curve {
  return transformCurve(curve, {
    m: [
      1, 0, 0, offset.x,
      0, 1, 0, offset.y,
      0, 0, 1, offset.z,
      0, 0, 0, 1,
    ],
  });
}
