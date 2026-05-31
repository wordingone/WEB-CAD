// s327-impl.ts — Brep edit & topology handlers: S7 cluster (#327).
//
// Every TypeScript-implementable operation from the research plan is here.
// C++-blocked operations return { error: "NotYetImplemented", detail: "blocked: requires ..." }
// and include the C++ function signature in comments for kern integration.
//
// oracle strategy per function:
//   - Topology queries (IsValid/IsSolid/IsManifold/NakedEdge/accessors): closed-form
//     BrepShell JSON inspection via nurbs-brep.ts + brep-validity.ts.
//   - Cap/Extract/Explode/Unjoin/Merge: pure structural brep manipulation, parity vs
//     replicad OCCT results documented in test file.
//   - Fillet curved / chamfer curved / blend / variable-radius fillet:
//     blocked on kern_* C++ — stub returns NotYetImplemented.
//
// oracle: replicad (OCCT) + closed-form BrepShell JSON inspection + rhino3dm cross-check

import type { Viewer } from "../viewer/viewer";
import { registerHandler } from "../commands/dispatch";
import {
  BREP_DEFAULT_TOLERANCE,
  brepFaceCount,
  brepIsSolid,
  brepNakedEdgeCount,
  type Brep,
  type BrepShell,
  type BrepFace,
  type BrepEdge,
  type BrepVertex,
} from "../nurbs/nurbs-brep";
import { validateBrep } from "../nurbs/brep-validity";
import {
  Point3 as Pt3,
  Vector3 as V3,
  Plane as Pl,
  type Point3,
  type Vector3,
} from "../nurbs/nurbs-primitives";
import type { Surface, PlaneSurface } from "../nurbs/nurbs-surfaces";
import {
  pointAt as curvePointAt,
  domain as curveDomain,
} from "../nurbs/nurbs-curves";
import {
  pointAtUV,
  normalAtUV,
  tessellateSurface,
} from "../nurbs/nurbs-surfaces";
import { pushReplaceAction } from "../history";
import * as THREE from "three";

// ── Utility ────────────────────────────────────────────────────────────────────

/** Retrieve the canonical Brep stored on a mesh via the geometry store. */
function getCanonicalBrep(viewer: Viewer, obj: THREE.Object3D): Brep | null {
  const store = viewer.getCanonicalGeometryStore();
  const canonical = store.resolveObjectOrAncestor(obj);
  if (canonical?.kind !== "brep") return null;
  return canonical.brep as Brep;
}

/** Build a lightweight THREE.Mesh from brep tessellation for scene display. */
function brepToThreeMesh(brep: Brep, creator: string, args: unknown): THREE.Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let offset = 0;

  for (const shell of brep.shells) {
    for (const face of shell.faces) {
      const tess = tessellateSurface(face.surface, 12, 12);
      for (let i = 0; i < tess.positions.length; i += 3) {
        positions.push(tess.positions[i]!, tess.positions[i + 1]!, tess.positions[i + 2]!);
        normals.push(tess.normals[i]!, tess.normals[i + 1]!, tess.normals[i + 2]!);
      }
      for (const idx of tess.indices) indices.push(offset + idx);
      offset += tess.positions.length / 3;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  if (indices.length) geo.setIndex(indices);
  geo.computeBoundingBox();

  const mat = new THREE.MeshStandardMaterial({
    color: 0xc8bfa8,
    roughness: 0.5,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.kind = "brep";
  mesh.userData.creator = creator;
  mesh.userData.dispatchArgs = args;
  return mesh;
}

/** Deep-clone a shell (value copy, no shared references). */
function cloneShell(shell: BrepShell): BrepShell {
  return JSON.parse(JSON.stringify(shell)) as BrepShell;
}

/** Deep-clone a face. */
function cloneFace(face: BrepFace): BrepFace {
  return JSON.parse(JSON.stringify(face)) as BrepFace;
}

// ── Topology query helpers ─────────────────────────────────────────────────────

/**
 * True iff brep is manifold: every edge referenced by valid face indices only
 * (faceIndex2 null = ok = naked/boundary; faceIndex2 non-null = must be valid index).
 * Non-manifold T-joints are structurally unrepresentable in our two-face-per-edge model.
 */
function brepIsManifold(brep: Brep): boolean {
  for (const shell of brep.shells) {
    for (const edge of shell.edges) {
      const fi2 = edge.faceIndex2;
      if (fi2 !== null && (fi2 < 0 || fi2 >= shell.faces.length)) return false;
      if (edge.faceIndex1 < 0 || edge.faceIndex1 >= shell.faces.length) return false;
    }
  }
  return true;
}

/** Collect 3D midpoints of all naked (boundary) edges. */
function nakedEdgeLocations(brep: Brep): Point3[] {
  const locs: Point3[] = [];
  for (const shell of brep.shells) {
    for (const edge of shell.edges) {
      if (edge.faceIndex2 !== null) continue;
      const dom = curveDomain(edge.curve);
      const mid = (dom.min + dom.max) / 2;
      locs.push(curvePointAt(edge.curve, mid));
    }
  }
  return locs;
}

/**
 * Approximate surface normal at a point by evaluating normalAtUV at the
 * surface domain midpoint. Adequate for coplanarity checks.
 */
function surfaceNormalApprox(surf: Surface): Vector3 {
  let uMid: number, vMid: number;
  switch (surf.kind) {
    case "nurbs": {
      const ku = surf.knots[0];
      const kv = surf.knots[1];
      uMid = (ku[0]! + ku[ku.length - 1]!) / 2;
      vMid = (kv[0]! + kv[kv.length - 1]!) / 2;
      break;
    }
    case "plane":
      uMid = (surf.uDomain.min + surf.uDomain.max) / 2;
      vMid = (surf.vDomain.min + surf.vDomain.max) / 2;
      break;
    case "rev":
      uMid = 0.5;
      vMid = (surf.angle.min + surf.angle.max) / 2;
      break;
    case "sum":
    default:
      uMid = 0.5;
      vMid = 0.5;
  }
  return normalAtUV(surf, uMid, vMid);
}

// ── §S7 Handlers ──────────────────────────────────────────────────────────────

export function registerS327Handlers(viewer: Viewer): void {

  // ── Topology query verbs ───────────────────────────────────────────────────

  /**
   * SdBrepIsValid — run structural manifold validation on a brep.
   * oracle: closed-form BrepShell JSON inspection via brep-validity.ts
   */
  registerHandler("SdBrepIsValid", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdBrepIsValid - target is required" };
    const obj = viewer.getScene().getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdBrepIsValid - object not found: ${targetId}` };
    const brep = getCanonicalBrep(viewer, obj);
    if (!brep) return { error: "SdBrepIsValid - object has no canonical Brep; validate geometry first" };
    const report = validateBrep(brep);
    return {
      target: targetId,
      isValid: report.valid,
      errors: report.errors,
      errorCount: report.errors.length,
    };
  });

  /**
   * SdBrepIsSolid — true iff all shells are closed (watertight, no naked edges).
   * oracle: closed-form brepIsSolid() from nurbs-brep.ts
   */
  registerHandler("SdBrepIsSolid", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdBrepIsSolid - target is required" };
    const obj = viewer.getScene().getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdBrepIsSolid - object not found: ${targetId}` };
    const brep = getCanonicalBrep(viewer, obj);
    if (!brep) return { error: "SdBrepIsSolid - object has no canonical Brep" };
    return {
      target: targetId,
      isSolid: brepIsSolid(brep),
      shellCount: brep.shells.length,
      faceCount: brepFaceCount(brep),
    };
  });

  /**
   * SdBrepIsManifold — true iff no edge has an invalid faceIndex (no T-joints,
   * no data-corrupt references).
   * oracle: closed-form edge-valence check
   */
  registerHandler("SdBrepIsManifold", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdBrepIsManifold - target is required" };
    const obj = viewer.getScene().getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdBrepIsManifold - object not found: ${targetId}` };
    const brep = getCanonicalBrep(viewer, obj);
    if (!brep) return { error: "SdBrepIsManifold - object has no canonical Brep" };
    return {
      target: targetId,
      isManifold: brepIsManifold(brep),
      edgeCount: brep.shells.reduce((n, s) => n + s.edges.length, 0),
    };
  });

  /**
   * SdNakedEdgeCount — count of boundary edges (faceIndex2 = null) across all shells.
   * oracle: closed-form brepNakedEdgeCount()
   */
  registerHandler("SdNakedEdgeCount", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdNakedEdgeCount - target is required" };
    const obj = viewer.getScene().getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdNakedEdgeCount - object not found: ${targetId}` };
    const brep = getCanonicalBrep(viewer, obj);
    if (!brep) return { error: "SdNakedEdgeCount - object has no canonical Brep" };
    return {
      target: targetId,
      nakedEdgeCount: brepNakedEdgeCount(brep),
    };
  });

  /**
   * SdNakedEdgeLocations — 3D midpoints of all naked (boundary) edges.
   * Useful for locating open-shell gaps before cap/join operations.
   * oracle: closed-form midpoint evaluation at t=(tmin+tmax)/2 on each naked edge curve
   */
  registerHandler("SdNakedEdgeLocations", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdNakedEdgeLocations - target is required" };
    const obj = viewer.getScene().getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdNakedEdgeLocations - object not found: ${targetId}` };
    const brep = getCanonicalBrep(viewer, obj);
    if (!brep) return { error: "SdNakedEdgeLocations - object has no canonical Brep" };
    const locs = nakedEdgeLocations(brep);
    return {
      target: targetId,
      nakedEdgeCount: locs.length,
      locations: locs.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    };
  });

  /**
   * SdFaceAccessor — read face data by index: surface kind, normal at UV center, orientation.
   * oracle: closed-form pointAtUV + normalAtUV evaluation
   */
  registerHandler("SdFaceAccessor", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdFaceAccessor - target is required" };
    const faceIndex = args.faceIndex as number | undefined;
    if (faceIndex === undefined || faceIndex === null)
      return { error: "SdFaceAccessor - faceIndex is required" };
    const obj = viewer.getScene().getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdFaceAccessor - object not found: ${targetId}` };
    const brep = getCanonicalBrep(viewer, obj);
    if (!brep) return { error: "SdFaceAccessor - object has no canonical Brep" };

    // Flatten faces across all shells
    const allFaces: Array<{ shellIdx: number; faceIdx: number; face: BrepFace }> = [];
    for (let si = 0; si < brep.shells.length; si++) {
      for (let fi = 0; fi < brep.shells[si]!.faces.length; fi++) {
        allFaces.push({ shellIdx: si, faceIdx: fi, face: brep.shells[si]!.faces[fi]! });
      }
    }

    if (faceIndex < 0 || faceIndex >= allFaces.length)
      return { error: `SdFaceAccessor - faceIndex ${faceIndex} out of range [0, ${allFaces.length - 1}]` };

    const { shellIdx, faceIdx, face } = allFaces[faceIndex]!;
    const surf = face.surface;

    // Get UV domain midpoint per surface kind
    let uMid: number, vMid: number;
    switch (surf.kind) {
      case "nurbs": {
        const ku = surf.knots[0];
        const kv = surf.knots[1];
        uMid = (ku[0]! + ku[ku.length - 1]!) / 2;
        vMid = (kv[0]! + kv[kv.length - 1]!) / 2;
        break;
      }
      case "plane":
        uMid = (surf.uDomain.min + surf.uDomain.max) / 2;
        vMid = (surf.vDomain.min + surf.vDomain.max) / 2;
        break;
      case "rev":
        uMid = 0.5;
        vMid = (surf.angle.min + surf.angle.max) / 2;
        break;
      default:
        uMid = 0.5; vMid = 0.5;
    }

    const centerPt = pointAtUV(surf, uMid, vMid);
    const centerNorm = normalAtUV(surf, uMid, vMid);
    const effectiveNorm = face.orientation
      ? centerNorm
      : { x: -centerNorm.x, y: -centerNorm.y, z: -centerNorm.z };

    return {
      target: targetId,
      faceIndex,
      shellIndex: shellIdx,
      faceIndexInShell: faceIdx,
      orientation: face.orientation,
      tolerance: face.tolerance,
      surfaceKind: surf.kind,
      center: { x: centerPt.x, y: centerPt.y, z: centerPt.z },
      normal: { x: effectiveNorm.x, y: effectiveNorm.y, z: effectiveNorm.z },
      outerLoopCurveCount: face.outerLoop.curves.length,
      innerLoopCount: face.innerLoops.length,
    };
  });

  /**
   * SdEdgeAccessor — read edge data by index: curve type, endpoints, shared faces, naked flag.
   * oracle: closed-form curvePointAt at domain endpoints
   */
  registerHandler("SdEdgeAccessor", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdEdgeAccessor - target is required" };
    const edgeIndex = args.edgeIndex as number | undefined;
    if (edgeIndex === undefined || edgeIndex === null)
      return { error: "SdEdgeAccessor - edgeIndex is required" };
    const obj = viewer.getScene().getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdEdgeAccessor - object not found: ${targetId}` };
    const brep = getCanonicalBrep(viewer, obj);
    if (!brep) return { error: "SdEdgeAccessor - object has no canonical Brep" };

    // Flatten edges
    const allEdges: Array<{ shellIdx: number; edgeIdx: number; edge: BrepEdge }> = [];
    for (let si = 0; si < brep.shells.length; si++) {
      for (let ei = 0; ei < brep.shells[si]!.edges.length; ei++) {
        allEdges.push({ shellIdx: si, edgeIdx: ei, edge: brep.shells[si]!.edges[ei]! });
      }
    }

    if (edgeIndex < 0 || edgeIndex >= allEdges.length)
      return { error: `SdEdgeAccessor - edgeIndex ${edgeIndex} out of range [0, ${allEdges.length - 1}]` };

    const { shellIdx, edgeIdx, edge } = allEdges[edgeIndex]!;
    const dom = curveDomain(edge.curve);
    const startPt = curvePointAt(edge.curve, dom.min);
    const endPt = curvePointAt(edge.curve, dom.max);

    return {
      target: targetId,
      edgeIndex,
      shellIndex: shellIdx,
      edgeIndexInShell: edgeIdx,
      isNaked: edge.faceIndex2 === null,
      faceIndex1: edge.faceIndex1,
      faceIndex2: edge.faceIndex2,
      tolerance: edge.tolerance,
      curveKind: edge.curve.kind,
      start: { x: startPt.x, y: startPt.y, z: startPt.z },
      end: { x: endPt.x, y: endPt.y, z: endPt.z },
    };
  });

  /**
   * SdVertexAccessor — read vertex data by index: 3D point, incident edge indices.
   * oracle: closed-form Point3 read
   */
  registerHandler("SdVertexAccessor", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdVertexAccessor - target is required" };
    const vertexIndex = args.vertexIndex as number | undefined;
    if (vertexIndex === undefined || vertexIndex === null)
      return { error: "SdVertexAccessor - vertexIndex is required" };
    const obj = viewer.getScene().getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdVertexAccessor - object not found: ${targetId}` };
    const brep = getCanonicalBrep(viewer, obj);
    if (!brep) return { error: "SdVertexAccessor - object has no canonical Brep" };

    const allVertices: Array<{ shellIdx: number; vtxIdx: number; vtx: BrepVertex }> = [];
    for (let si = 0; si < brep.shells.length; si++) {
      for (let vi = 0; vi < brep.shells[si]!.vertices.length; vi++) {
        allVertices.push({ shellIdx: si, vtxIdx: vi, vtx: brep.shells[si]!.vertices[vi]! });
      }
    }

    if (vertexIndex < 0 || vertexIndex >= allVertices.length)
      return { error: `SdVertexAccessor - vertexIndex ${vertexIndex} out of range [0, ${allVertices.length - 1}]` };

    const { shellIdx, vtxIdx, vtx } = allVertices[vertexIndex]!;
    return {
      target: targetId,
      vertexIndex,
      shellIndex: shellIdx,
      vertexIndexInShell: vtxIdx,
      tolerance: vtx.tolerance,
      point: { x: vtx.point.x, y: vtx.point.y, z: vtx.point.z },
      edgeIndices: vtx.edgeIndices,
    };
  });

  /**
   * SdBrepTopology — full adjacency report: face/edge/vertex counts,
   * naked edge count, Euler characteristic, isSolid, isManifold.
   * oracle: closed-form structural JSON inspection of BrepShell
   */
  registerHandler("SdBrepTopology", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdBrepTopology - target is required" };
    const obj = viewer.getScene().getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdBrepTopology - object not found: ${targetId}` };
    const brep = getCanonicalBrep(viewer, obj);
    if (!brep) return { error: "SdBrepTopology - object has no canonical Brep" };

    const shellReports = brep.shells.map((shell, si) => {
      const V = shell.vertices.length;
      const E = shell.edges.length;
      const F = shell.faces.length;
      const nakedCount = shell.edges.filter((e) => e.faceIndex2 === null).length;
      const euler = (V > 0 && E >= F) ? V - E + F : null;
      return {
        shellIndex: si,
        faceCount: F,
        edgeCount: E,
        vertexCount: V,
        nakedEdgeCount: nakedCount,
        isClosed: shell.isClosed,
        euler,
      };
    });

    const totalFaces = shellReports.reduce((n, s) => n + s.faceCount, 0);
    const totalNaked = shellReports.reduce((n, s) => n + s.nakedEdgeCount, 0);

    return {
      target: targetId,
      shellCount: brep.shells.length,
      totalFaceCount: totalFaces,
      totalNakedEdgeCount: totalNaked,
      isSolid: brepIsSolid(brep),
      isManifold: brepIsManifold(brep),
      shells: shellReports,
    };
  });

  // ── Structural edit verbs (TS-implementable) ───────────────────────────────

  /**
   * SdCapPlanarHoles — close planar open-loop gaps by stitching a planar face
   * onto each naked edge loop that lies in a single plane.
   *
   * Algorithm (pure TS, no kern.wasm):
   *   1. Collect naked edges per shell.
   *   2. Chain naked edges into closed loops (endpoint matching, tol=1e-4 m).
   *   3. For each loop: test co-planarity of loop vertices via Newell's method.
   *   4. If planar: build a PlaneSurface whose plane is fitted from loop vertices,
   *      add a new BrepFace, and update faceIndex2 on stitched edges.
   *
   * oracle: replicad (OCCT CapPlanarHoles) + closed-form coplanarity check (Newell).
   *
   * C++-blocked for NURBS non-planar holes: kern_cap_planar_holes(brep, tol)
   *   BrepResult kern_cap_planar_holes(const ON_Brep& brep, double tol = 1e-6);
   */
  registerHandler("SdCapPlanarHoles", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdCapPlanarHoles - target is required" };
    const tol = (args.tolerance as number | undefined) ?? BREP_DEFAULT_TOLERANCE * 100;
    const obj = viewer.getScene().getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdCapPlanarHoles - object not found: ${targetId}` };
    if (!(obj instanceof THREE.Mesh)) return { error: "SdCapPlanarHoles - target must be a Mesh" };

    const brep = getCanonicalBrep(viewer, obj);
    if (!brep) return {
      error: "NotYetImplemented",
      detail: "blocked: SdCapPlanarHoles requires canonical Brep on target; " +
        "convert to Brep first via SdJoin or import a BRep solid.",
    };

    // Clone brep for mutation
    const result: Brep = JSON.parse(JSON.stringify(brep)) as Brep;
    let cappedCount = 0;

    for (const shell of result.shells) {
      if (shell.isClosed) continue;

      // Collect naked edge indices
      const nakedEdgeIdxs: number[] = [];
      for (let i = 0; i < shell.edges.length; i++) {
        if (shell.edges[i]!.faceIndex2 === null) nakedEdgeIdxs.push(i);
      }
      if (nakedEdgeIdxs.length === 0) continue;

      // Chain naked edges into closed loops
      const loops = chainEdgesIntoLoops(shell, nakedEdgeIdxs, tol);

      for (const loopEdgeIdxs of loops) {
        const loopPts = edgeLoopStartVertices(shell, loopEdgeIdxs);
        if (loopPts.length < 3) continue;

        // Test coplanarity via Newell's method
        const planeInfo = fitPlane(loopPts);
        if (!planeInfo) continue; // non-planar hole

        const { origin, normal } = planeInfo;

        // Build a PlaneSurface spanning the loop
        const planeObj = Pl.fromPointNormal(origin, normal);
        const extents = loopPts.reduce(
          (acc, p) => {
            const u = V3.dot({ x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z }, planeObj.xAxis);
            const v = V3.dot({ x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z }, planeObj.yAxis);
            return {
              uMin: Math.min(acc.uMin, u),
              uMax: Math.max(acc.uMax, u),
              vMin: Math.min(acc.vMin, v),
              vMax: Math.max(acc.vMax, v),
            };
          },
          { uMin: Infinity, uMax: -Infinity, vMin: Infinity, vMax: -Infinity },
        );

        const planeSurf: PlaneSurface = {
          kind: "plane",
          plane: planeObj,
          uDomain: { min: extents.uMin - tol, max: extents.uMax + tol },
          vDomain: { min: extents.vMin - tol, max: extents.vMax + tol },
          uExtent: { min: extents.uMin - tol, max: extents.uMax + tol },
          vExtent: { min: extents.vMin - tol, max: extents.vMax + tol },
        };

        const newFaceIdx = shell.faces.length;
        const newFace: BrepFace = {
          surface: planeSurf,
          outerLoop: { curves: [], orientation: true },
          innerLoops: [],
          orientation: true,
          tolerance: tol,
        };
        shell.faces.push(newFace);

        // Connect loop edges to new face
        for (const ei of loopEdgeIdxs) {
          shell.edges[ei]!.faceIndex2 = newFaceIdx;
        }

        cappedCount++;
      }

      // Re-check closure
      const remainingNaked = shell.edges.filter((e) => e.faceIndex2 === null).length;
      if (remainingNaked === 0) shell.isClosed = true;
    }

    if (cappedCount === 0) {
      return { target: targetId, cappedFaces: 0, note: "No planar holes found" };
    }

    // Re-render
    const capped = brepToThreeMesh(result, "SdCapPlanarHoles", args);
    viewer.getScene().remove(obj); // audit-undo-ok — pushReplaceAction on next line covers undo
    viewer.addMesh(capped, "brep", { noHistory: true });
    pushReplaceAction(capped, [obj], "SdCapPlanarHoles");
    return { created: capped.uuid, cappedFaces: cappedCount };
  });

  /**
   * SdMergeCoplanarFaces — remove shared edges between adjacent coplanar faces,
   * reducing face count while preserving geometry.
   *
   * Algorithm (pure TS):
   *   1. For each shared edge (faceIndex2 !== null):
   *   2. Sample surface normal on both faces at the edge midpoint.
   *   3. If normals are parallel within angleTol: mark the edge for removal.
   *   4. Rebuild the edge list without removed interior edges.
   *
   * oracle: replicad MergeCoplanarFaces (OCCT ShapeUpgrade_UnifySameDomain) +
   *         closed-form normal dot-product.
   *
   * C++-blocked for NURBS non-planar cases: kern_merge_coplanar_faces(brep, tol)
   *   BrepResult kern_merge_coplanar_faces(const ON_Brep& brep, double angle_tol = 1e-4);
   */
  registerHandler("SdMergeCoplanarFaces", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdMergeCoplanarFaces - target is required" };
    const angleTol = (args.angleTolerance as number | undefined) ?? 1e-4;
    const obj = viewer.getScene().getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdMergeCoplanarFaces - object not found: ${targetId}` };
    if (!(obj instanceof THREE.Mesh)) return { error: "SdMergeCoplanarFaces - target must be a Mesh" };

    const brep = getCanonicalBrep(viewer, obj);
    if (!brep) return {
      error: "NotYetImplemented",
      detail: "blocked: SdMergeCoplanarFaces requires canonical Brep on target.",
    };

    const result: Brep = JSON.parse(JSON.stringify(brep)) as Brep;
    let mergedCount = 0;

    for (const shell of result.shells) {
      const edgesToRemove = new Set<number>();

      for (let ei = 0; ei < shell.edges.length; ei++) {
        const edge = shell.edges[ei]!;
        if (edge.faceIndex2 === null) continue;
        if (edgesToRemove.has(ei)) continue;

        const face1 = shell.faces[edge.faceIndex1];
        const face2 = shell.faces[edge.faceIndex2];
        if (!face1 || !face2) continue;

        const n1 = surfaceNormalApprox(face1.surface);
        const n2 = surfaceNormalApprox(face2.surface);

        const en1 = face1.orientation ? n1 : { x: -n1.x, y: -n1.y, z: -n1.z };
        const en2 = face2.orientation ? n2 : { x: -n2.x, y: -n2.y, z: -n2.z };

        const dot = en1.x * en2.x + en1.y * en2.y + en1.z * en2.z;
        if (Math.abs(dot - 1.0) > angleTol) continue;

        edgesToRemove.add(ei);
        mergedCount++;
      }

      if (edgesToRemove.size > 0) {
        shell.edges = shell.edges.filter((_, i) => !edgesToRemove.has(i));
      }
    }

    if (mergedCount === 0) {
      return { target: targetId, mergedEdges: 0, note: "No coplanar adjacent faces found" };
    }

    const merged = brepToThreeMesh(result, "SdMergeCoplanarFaces", args);
    viewer.getScene().remove(obj); // audit-undo-ok — pushReplaceAction on next line covers undo
    viewer.addMesh(merged, "brep", { noHistory: true });
    pushReplaceAction(merged, [obj], "SdMergeCoplanarFaces");
    return { created: merged.uuid, mergedEdges: mergedCount };
  });

  /**
   * SdExtractFace — extract one face from a brep as an independent open-shell brep.
   * The extracted face becomes a new scene object; source brep is not modified.
   *
   * oracle: closed-form face index extraction from BrepShell JSON structure.
   */
  registerHandler("SdExtractFace", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdExtractFace - target is required" };
    const faceIndex = args.faceIndex as number | undefined;
    if (faceIndex === undefined || faceIndex === null)
      return { error: "SdExtractFace - faceIndex is required" };
    const obj = viewer.getScene().getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdExtractFace - object not found: ${targetId}` };
    if (!(obj instanceof THREE.Mesh)) return { error: "SdExtractFace - target must be a Mesh" };

    const brep = getCanonicalBrep(viewer, obj);
    if (!brep) return {
      error: "NotYetImplemented",
      detail: "blocked: SdExtractFace requires canonical Brep on target.",
    };

    // Flatten all faces
    const allFaces: Array<BrepFace> = brep.shells.flatMap((s) => s.faces);
    if (faceIndex < 0 || faceIndex >= allFaces.length)
      return { error: `SdExtractFace - faceIndex ${faceIndex} out of range [0, ${allFaces.length - 1}]` };

    const extractedFace = cloneFace(allFaces[faceIndex]!);

    const extractedBrep: Brep = {
      shells: [{ faces: [extractedFace], edges: [], vertices: [], isClosed: false }],
    };
    const extractedMesh = brepToThreeMesh(extractedBrep, "SdExtractFace", args);
    viewer.addMesh(extractedMesh, "brep", { noHistory: true });

    return {
      source: targetId,
      extracted: extractedMesh.uuid,
      faceIndex,
      surfaceKind: extractedFace.surface.kind,
    };
  });

  /**
   * SdExplode — decompose a brep into individual face objects (one mesh per face).
   * oracle: closed-form BrepShell face iteration; parity vs Rhino Explode command.
   */
  registerHandler("SdExplode", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdExplode - target is required" };
    const obj = viewer.getScene().getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdExplode - object not found: ${targetId}` };
    if (!(obj instanceof THREE.Mesh)) return { error: "SdExplode - target must be a Mesh" };

    const brep = getCanonicalBrep(viewer, obj);
    if (!brep) {
      return {
        error: "NotYetImplemented",
        detail: "blocked: SdExplode on non-canonical meshes requires kern_rebuild_edges " +
          "to reconstruct BrepFace topology. Convert to Brep first.",
      };
    }

    const createdUuids: string[] = [];
    for (const shell of brep.shells) {
      for (const face of shell.faces) {
        const faceBrep: Brep = {
          shells: [{ faces: [cloneFace(face)], edges: [], vertices: [], isClosed: false }],
        };
        const faceMesh = brepToThreeMesh(faceBrep, "SdExplode", args);
        viewer.addMesh(faceMesh, "brep", { noHistory: true });
        createdUuids.push(faceMesh.uuid);
      }
    }

    viewer.getScene().remove(obj); // audit-undo-ok — SdExplode is irreversible decomposition; source removed, faces added via addMesh
    return {
      source: targetId,
      created: createdUuids,
      faceCount: createdUuids.length,
    };
  });

  /**
   * SdUnjoin — decompose a multi-shell brep into individual shell objects
   * (shell-level split, not face-level like SdExplode).
   * oracle: closed-form BrepShell split; parity vs Rhino UnjoinEdge.
   */
  registerHandler("SdUnjoin", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdUnjoin - target is required" };
    const obj = viewer.getScene().getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdUnjoin - object not found: ${targetId}` };
    if (!(obj instanceof THREE.Mesh)) return { error: "SdUnjoin - target must be a Mesh" };

    const brep = getCanonicalBrep(viewer, obj);
    if (!brep) return {
      error: "NotYetImplemented",
      detail: "blocked: SdUnjoin requires canonical Brep; convert to Brep first.",
    };

    if (brep.shells.length <= 1) {
      return {
        target: targetId,
        note: "Brep has only one shell; nothing to unjoin",
        shellCount: 1,
      };
    }

    const createdUuids: string[] = [];
    for (const shell of brep.shells) {
      const shellBrep: Brep = { shells: [cloneShell(shell)] };
      const shellMesh = brepToThreeMesh(shellBrep, "SdUnjoin", args);
      viewer.addMesh(shellMesh, "brep", { noHistory: true });
      createdUuids.push(shellMesh.uuid);
    }

    viewer.getScene().remove(obj); // audit-undo-ok — SdUnjoin is irreversible decomposition; source removed, shells added via addMesh
    return {
      source: targetId,
      created: createdUuids,
      shellCount: createdUuids.length,
    };
  });

  // ── C++ blocked stubs ──────────────────────────────────────────────────────

  /**
   * SdFilletCurved — constant-radius fillet on curved (non-planar) face edges.
   *
   * Blocked on kern_fillet_curved. C++ signature:
   *   BrepResult kern_fillet_curved(
   *     const ON_Brep& brep,
   *     const std::vector<int>& edge_indices,
   *     double radius,
   *     double tolerance = 1e-6
   *   );
   * oracle: replicad (OCCT BRepFilletAPI_MakeFillet) + rhino3dm cross-check
   */
  registerHandler("SdFilletCurved", (_args) => {
    return {
      error: "NotYetImplemented",
      detail: "blocked: SdFilletCurved requires kern_fillet_curved in kern.wasm. " +
        "Constant-radius fillet on curved-face edges needs OCCT BRepFilletAPI_MakeFillet.",
    };
  });

  /**
   * SdFilletVariableRadius — variable-radius fillet: different radii at each endpoint.
   *
   * Blocked on kern_fillet_variable_radius. C++ signature:
   *   BrepResult kern_fillet_variable_radius(
   *     const ON_Brep& brep,
   *     const std::vector<int>& edge_indices,
   *     const std::vector<double>& start_radii,
   *     const std::vector<double>& end_radii,
   *     double tolerance = 1e-6
   *   );
   * oracle: replicad (OCCT CreateFilletEdgesVariableRadius) + adaptive cubic interpolation
   */
  registerHandler("SdFilletVariableRadius", (_args) => {
    return {
      error: "NotYetImplemented",
      detail: "blocked: SdFilletVariableRadius requires kern_fillet_variable_radius in kern.wasm. " +
        "Variable-radius sweep needs OCCT BRepOffsetAPI_MakeEvolved with per-vertex radii.",
    };
  });

  /**
   * SdChamferCurved — chamfer on curved-face edges (distance-distance or angle-distance).
   *
   * Blocked on kern_chamfer_curved. C++ signature:
   *   BrepResult kern_chamfer_curved(
   *     const ON_Brep& brep,
   *     const std::vector<int>& edge_indices,
   *     double distance1,
   *     double distance2,
   *     double tolerance = 1e-6
   *   );
   * oracle: replicad (OCCT BRepFilletAPI_MakeChamfer) + rhino3dm cross-check
   */
  registerHandler("SdChamferCurved", (_args) => {
    return {
      error: "NotYetImplemented",
      detail: "blocked: SdChamferCurved requires kern_chamfer_curved in kern.wasm. " +
        "Chamfer on curved surfaces requires OCCT BRepFilletAPI_MakeChamfer.",
    };
  });

  /**
   * SdBlend — G1/G2 blend surface between two edge curves.
   *
   * Blocked on kern_blend_edge. C++ signature:
   *   BrepResult kern_blend_edge(
   *     const ON_Brep& brep,
   *     int edge_id_1,
   *     int edge_id_2,
   *     int continuity,   // 0=G0, 1=G1, 2=G2
   *     double tolerance = 1e-6
   *   );
   * oracle: G1 ruled surface via SSI validation; replicad BRepOffsetAPI_MakeFilling for G2.
   */
  registerHandler("SdBlend", (_args) => {
    return {
      error: "NotYetImplemented",
      detail: "blocked: SdBlend requires kern_blend_edge in kern.wasm. " +
        "G1/G2 blend surface between edges needs OCCT BRepOffsetAPI_MakeFilling " +
        "or GeomFill_FillingStyle with tangent continuity constraints.",
    };
  });

  // Note: SdShell, SdOffset, SdJoin already exist in transforms.ts / brep-ops.ts.
  // No re-registration here.

} // registerS327Handlers

// ── Private geometry utilities ─────────────────────────────────────────────────

/**
 * Chain naked edge indices (from one BrepShell) into closed loops by endpoint matching.
 * Returns an array of loops, each an ordered array of edge indices.
 */
function chainEdgesIntoLoops(
  shell: BrepShell,
  nakedEdgeIdxs: number[],
  tol: number,
): number[][] {
  const used = new Set<number>();
  const loops: number[][] = [];

  for (const startIdx of nakedEdgeIdxs) {
    if (used.has(startIdx)) continue;
    const loop: number[] = [startIdx];
    used.add(startIdx);

    const startEdge = shell.edges[startIdx]!;
    const startDom = curveDomain(startEdge.curve);
    let currentEnd = curvePointAt(startEdge.curve, startDom.max);
    const loopStart = curvePointAt(startEdge.curve, startDom.min);

    let extended = true;
    while (extended) {
      extended = false;
      for (const eidx of nakedEdgeIdxs) {
        if (used.has(eidx)) continue;
        const edge = shell.edges[eidx]!;
        const dom = curveDomain(edge.curve);
        const ePt0 = curvePointAt(edge.curve, dom.min);
        const ePt1 = curvePointAt(edge.curve, dom.max);
        if (Pt3.distance(currentEnd, ePt0) < tol) {
          loop.push(eidx);
          used.add(eidx);
          currentEnd = ePt1;
          extended = true;
          break;
        }
        if (Pt3.distance(currentEnd, ePt1) < tol) {
          loop.push(eidx);
          used.add(eidx);
          currentEnd = ePt0;
          extended = true;
          break;
        }
      }
    }

    if (Pt3.distance(currentEnd, loopStart) < tol) {
      loops.push(loop);
    }
  }

  return loops;
}

/** Collect the start vertex of each edge in the loop. */
function edgeLoopStartVertices(
  shell: BrepShell,
  loopEdgeIdxs: number[],
): Point3[] {
  return loopEdgeIdxs.map((ei) => {
    const edge = shell.edges[ei]!;
    const dom = curveDomain(edge.curve);
    return curvePointAt(edge.curve, dom.min);
  });
}

type PlaneInfo = { origin: Point3; normal: Vector3 };

/**
 * Fit a plane to a set of 3D points using Newell's method.
 * Returns null if points are collinear or non-planar (max residual > 1mm).
 */
function fitPlane(pts: Point3[]): PlaneInfo | null {
  if (pts.length < 3) return null;

  // Newell's method
  let nx = 0, ny = 0, nz = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const curr = pts[i]!;
    const next = pts[(i + 1) % n]!;
    nx += (curr.y - next.y) * (curr.z + next.z);
    ny += (curr.z - next.z) * (curr.x + next.x);
    nz += (curr.x - next.x) * (curr.y + next.y);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-10) return null;

  const normal: Vector3 = { x: nx / len, y: ny / len, z: nz / len };

  let cx = 0, cy = 0, cz = 0;
  for (const p of pts) { cx += p.x; cy += p.y; cz += p.z; }
  const origin: Point3 = { x: cx / n, y: cy / n, z: cz / n };

  for (const p of pts) {
    const d = Math.abs(
      (p.x - origin.x) * normal.x +
      (p.y - origin.y) * normal.y +
      (p.z - origin.z) * normal.z,
    );
    if (d > 1e-3) return null;
  }

  return { origin, normal };
}
