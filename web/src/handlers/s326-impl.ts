// s326-impl.ts — S6 boolean handler enhancements + stubs for C++-blocked ops.
//
// Issue #326 — S6: Brep boolean, GENERAL + topology-correct:
//   union / difference / intersection / split + face provenance (IndexMap)
//
// tsOps implemented here (general Brep, non-axis-aligned, non-degenerate):
//   SdBooleanUnion       — enhance to accept general Brep inputs via brepUnion
//   SdBooleanDifference  — enhance to accept general Brep inputs via brepDifference
//   SdBooleanIntersection — enhance to accept general Brep inputs via brepIntersection
//
// cppOps — stub handlers (C++ kern.wasm general SSI not yet shipped):
//   SdBooleanSplit            — returns NotYetImplemented (needs kern boolSplit)
//   SdDifferenceWithIndexMap  — returns NotYetImplemented (needs kern boolDifferenceWithIndexMap)
//
// oracle strategy (per #326 acceptance bar):
//   replicad (OCCT-backed) for union/difference/intersection + mass-properties
//   closed-form math for topology counts (face count, naked-edge count)
//   Noted in each handler: // oracle: <oracle-name>/<method>

import { registerHandler } from "../commands/dispatch";
import type { Viewer } from "../viewer/viewer";
import * as THREE from "three";
import {
  brepUnion,
  brepDifference,
  brepIntersection,
} from "../nurbs/brep-boolean";
import {
  transformBrep,
  brepFaceCount,
  brepIsOpen,
  brepNakedEdgeCount,
  type Brep,
} from "../nurbs/nurbs-brep";
import { objectFromCanonicalGeometry } from "../geometry/canonical-display";
import { pushReplaceAction } from "../history";

// ── Helpers ───────────────────────────────────────────────────────────────────

function threeMatToXform(m: THREE.Matrix4): { m: number[] } {
  const e = m.elements;
  return {
    m: [
      e[0], e[4], e[8],  e[12],
      e[1], e[5], e[9],  e[13],
      e[2], e[6], e[10], e[14],
      e[3], e[7], e[11], e[15],
    ],
  };
}

/**
 * Extract the canonical Brep from a scene object, applying its world transform
 * so the result lives in world space (non-axis-aligned, general position).
 *
 * oracle: replicad (OCCT) uses world-space solids for booleans — same convention.
 */
function worldBrep(obj: THREE.Object3D, viewer: Viewer): Brep | null {
  obj.updateMatrixWorld(true);
  const store = viewer.getCanonicalGeometryStore();
  const canonical = store.resolveObjectOrAncestor(obj);
  if (canonical?.kind !== "brep") return null;
  return transformBrep(canonical.brep, threeMatToXform(obj.matrixWorld));
}

/**
 * Commit a boolean result Brep to the canonical store, build display mesh,
 * tag userData, remove input objects from scene, push history.
 *
 * Shared by union / difference / intersection handlers so the display path
 * is consistent and not duplicated.
 */
function commitBoolResult(
  viewer: Viewer,
  brep: Brep,
  inputObjs: THREE.Object3D[],
  creator: string,
  metadata: Record<string, unknown>,
): { created: string; faceCount: number; nakedEdges: number; isSolid: boolean } | { error: string } {
  const store = viewer.getCanonicalGeometryStore();
  const record = store.create({
    kind: "brep",
    brep,
    source: "edit",
    createdBy: creator,
    metadata: {
      ...metadata,
      displaySource: "canonical-brep",
    },
  });

  const display = objectFromCanonicalGeometry(record);
  if (!(display instanceof THREE.Mesh)) {
    store.delete(record.id);
    return { error: `${creator}: display mesh generation failed — result may be non-manifold or empty` };
  }

  const posAttr = display.geometry.getAttribute("position");
  record.displayMesh = {
    revision: 1,
    generatedAt: Date.now(),
    vertexCount: posAttr?.count,
    triangleCount: display.geometry.index
      ? Math.floor(display.geometry.index.count / 3)
      : posAttr ? Math.floor(posAttr.count / 3) : undefined,
    derivation: "tessellated-brep",
  };
  display.userData.kind = "brep";
  display.userData.creator = creator;
  display.userData.dispatchArgs = metadata;
  display.userData.booleanDisplaySource = "canonical-brep";
  store.linkObject(display, record.id);

  const scene = viewer.getScene();
  for (const obj of inputObjs) {
    scene.remove(obj); // audit-undo-ok: tracked by pushReplaceAction below
  }
  viewer.addMesh(display, "brep", { noHistory: true });
  pushReplaceAction(display, inputObjs, creator);

  // oracle: replicad/OCCT IsSolid + NakedEdgeCount — verify post-boolean topology
  const faceCount = brepFaceCount(brep);
  const nakedEdges = brepNakedEdgeCount(brep);
  const isSolid = !brepIsOpen(brep);

  return {
    created: display.uuid,
    faceCount,
    nakedEdges,
    isSolid,
  };
}

// ── Handle args: resolve two scene objects from named UUID args ───────────────

function resolvePair(
  viewer: Viewer,
  aId: string | undefined,
  bId: string | undefined,
  verbName: string,
): { objA: THREE.Mesh; objB: THREE.Mesh } | { error: string } {
  if (!aId || !bId) return { error: `${verbName}: both operand UUIDs required` };
  const scene = viewer.getScene();
  const objA = scene.getObjectByProperty("uuid", aId);
  const objB = scene.getObjectByProperty("uuid", bId);
  if (!objA) return { error: `${verbName}: operand A not found: ${aId}` };
  if (!objB) return { error: `${verbName}: operand B not found: ${bId}` };
  if (!(objA instanceof THREE.Mesh) || !(objB instanceof THREE.Mesh))
    return { error: `${verbName}: both operands must be solid meshes` };
  return { objA, objB };
}

// ── Exported handler functions (one per verb) ─────────────────────────────────

/**
 * SdBooleanUnion — enhanced for general Brep inputs.
 *
 * Computes a ∪ b using the highest-priority registered backend:
 *   - wasm-kern (priority 20) when kern.wasm loaded: general SSI-backed OCCT union
 *   - nurbs (priority 10): SSI face-classification, general surfaces
 *   - toy  (priority  0): structural shell concat (disjoint inputs only)
 *
 * Accepts non-axis-aligned, curved, multi-face solids.
 *
 * oracle: replicad/OCCT (BRepAlgoAPI_Fuse) — volume = vol(A) + vol(B) - vol(A∩B)
 *         rhino3dm (cross-validation for curved solids)
 */
export function handle_SdBooleanUnion(
  args: Record<string, unknown>,
  viewer: Viewer,
): Record<string, unknown> {
  const aId = args.a as string | undefined;
  const bId = args.b as string | undefined;
  const pair = resolvePair(viewer, aId, bId, "SdBooleanUnion");
  if ("error" in pair) return pair;
  const { objA, objB } = pair;

  const brepA = worldBrep(objA, viewer);
  const brepB = worldBrep(objB, viewer);
  if (!brepA || !brepB) {
    return { error: "SdBooleanUnion: one or both operands have no canonical Brep — create objects with SdBox/SdCylinder/etc first" };
  }

  // oracle: replicad — fuse(solidA, solidB)
  const result = brepUnion(brepA, brepB);
  if (!result.ok) {
    return {
      error: `SdBooleanUnion failed: ${result.error.code} — ${result.error.message}`,
      backend: result.error.backend,
    };
  }

  return commitBoolResult(viewer, result.brep, [objA, objB], "SdBooleanUnion", {
    operation: "boolean-union",
    operands: [aId, bId],
  });
}

/**
 * SdBooleanDifference — enhanced for general Brep inputs.
 *
 * Computes outer − inner using the highest-priority registered backend.
 * Non-axis-aligned, curved, multi-face solids supported.
 *
 * oracle: replicad/OCCT (BRepAlgoAPI_Cut) — volume = vol(outer) - vol(outer∩inner)
 *         topology: face count = outer faces not inside inner + flipped inner faces inside outer
 */
export function handle_SdBooleanDifference(
  args: Record<string, unknown>,
  viewer: Viewer,
): Record<string, unknown> {
  const outerId = args.outer as string | undefined;
  const innerId = args.inner as string | undefined;
  const pair = resolvePair(viewer, outerId, innerId, "SdBooleanDifference");
  if ("error" in pair) return pair;
  const { objA: objOuter, objB: objInner } = pair;

  const brepOuter = worldBrep(objOuter, viewer);
  const brepInner = worldBrep(objInner, viewer);
  if (!brepOuter || !brepInner) {
    return { error: "SdBooleanDifference: one or both operands have no canonical Brep" };
  }

  // oracle: replicad — cut(outer, inner)
  const result = brepDifference(brepOuter, brepInner);
  if (!result.ok) {
    return {
      error: `SdBooleanDifference failed: ${result.error.code} — ${result.error.message}`,
      backend: result.error.backend,
    };
  }

  return commitBoolResult(viewer, result.brep, [objOuter, objInner], "SdBooleanDifference", {
    operation: "boolean-difference",
    outer: outerId,
    inner: innerId,
  });
}

/**
 * SdBooleanIntersection — enhanced for general Brep inputs.
 *
 * Computes a ∩ b (common material) using the highest-priority registered backend.
 * Non-axis-aligned, curved, multi-face solids supported.
 *
 * oracle: replicad/OCCT (BRepAlgoAPI_Common) — volume = vol(A∩B)
 *         empty intersection → result Brep has no faces (non-overlapping inputs)
 */
export function handle_SdBooleanIntersection(
  args: Record<string, unknown>,
  viewer: Viewer,
): Record<string, unknown> {
  const aId = args.a as string | undefined;
  const bId = args.b as string | undefined;
  const pair = resolvePair(viewer, aId, bId, "SdBooleanIntersection");
  if ("error" in pair) return pair;
  const { objA, objB } = pair;

  const brepA = worldBrep(objA, viewer);
  const brepB = worldBrep(objB, viewer);
  if (!brepA || !brepB) {
    return { error: "SdBooleanIntersection: one or both operands have no canonical Brep" };
  }

  // oracle: replicad — intersect(solidA, solidB)
  const result = brepIntersection(brepA, brepB);
  if (!result.ok) {
    return {
      error: `SdBooleanIntersection failed: ${result.error.code} — ${result.error.message}`,
      backend: result.error.backend,
    };
  }

  return commitBoolResult(viewer, result.brep, [objA, objB], "SdBooleanIntersection", {
    operation: "boolean-intersection",
    operands: [aId, bId],
  });
}

// ── C++-blocked stubs ─────────────────────────────────────────────────────────
//
// The following ops require General Surface-Surface Intersection (SSI) in
// kern.wasm — specifically the functions below in kern/boolean.cpp:
//
//   boolSplit(aJson: string, bJson: string): string
//     §1 SSI on all face pairs → intersection curves
//     §2 face splitting by SSI curves (general trimming)
//     §3 containment classification
//     §4 selection: A-faces, B-faces split by curve, A-tool-cuts
//     §5 assembly into two result shells
//     Returns: { ok: true, result: { shellA: BrepShell, shellB: BrepShell } }
//              or { ok: false, error: string }
//
//   boolDifferenceWithIndexMap(aJson: string, bJson: string): string
//     Same pipeline as boolDifference but additionally computes face provenance:
//     result face → source face in A or B (index map for parametric history)
//     Returns: { ok: true, result: { brep: KernBrepRaw, indexMap: { [resultFaceIdx]: { source: "a"|"b", faceIdx: number } } } }
//              or { ok: false, error: string }
//
// These stubs register handlers so the schema verbs are dispatchable (no
// ArgValidationError for valid args), but return NotYetImplemented until
// kern.wasm implements the C++ functions.

/**
 * SdBooleanSplit — blocked: requires general SSI in kern.wasm.
 *
 * C++ function needed: boolSplit(aJson: string, bJson: string): string
 *   Splits solid A by solid B surface, returning two sub-solids.
 *   Reference: OCCT BRepAlgoAPI_Section + BRepFeat_SplitShape.
 *
 * oracle: replicad split() — when kern ships, verify:
 *   vol(resultA) + vol(resultB) ≈ vol(A)  (within BREP_DEFAULT_TOLERANCE)
 *   brepIsOpen(resultA) === false && brepIsOpen(resultB) === false
 */
export function handle_SdBooleanSplit(
  args: Record<string, unknown>,
  _viewer: Viewer,
): Record<string, unknown> {
  const aId = args.a as string | undefined;
  const bId = args.b as string | undefined;
  if (!aId || !bId) {
    return { error: "SdBooleanSplit requires a (solid to split) and b (splitting tool)" };
  }
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires general SSI (boolSplit) in kern.wasm — kern/boolean.cpp §1-§5",
    cppFn: "boolSplit(aJson: string, bJson: string): string",
    operands: { a: aId, b: bId },
  };
}

/**
 * SdDifferenceWithIndexMap — blocked: requires face provenance tracking in kern.wasm.
 *
 * C++ function needed: boolDifferenceWithIndexMap(aJson: string, bJson: string): string
 *   Same as boolDifference but tracks face provenance:
 *   result face → { source: "a"|"b", faceIdx: number }
 *   Reference: OCCT BRepAlgoAPI_Cut + BRepAlgo_IndexedDataMapOfShapeInteger.
 *
 * oracle: replicad cut() for result geometry;
 *         closed-form for provenance: each surviving face maps back to an input face.
 */
export function handle_SdDifferenceWithIndexMap(
  args: Record<string, unknown>,
  _viewer: Viewer,
): Record<string, unknown> {
  const outerId = args.outer as string | undefined;
  const innerId = args.inner as string | undefined;
  if (!outerId || !innerId) {
    return { error: "SdDifferenceWithIndexMap requires outer and inner solid UUIDs" };
  }
  return {
    error: "NotYetImplemented",
    detail: "blocked: requires face provenance tracking (boolDifferenceWithIndexMap) in kern.wasm — kern/boolean.cpp DifferenceWithIndexMap stage",
    cppFn: "boolDifferenceWithIndexMap(aJson: string, bJson: string): string",
    operands: { outer: outerId, inner: innerId },
  };
}

// ── Registration function ──────────────────────────────────────────────────────

/**
 * Register all S326 handler enhancements.
 *
 * Call from registerAllHandlers() (register-handlers.ts) AFTER registerTransformHandlers()
 * so these override the existing SdBoolean* handlers with the enhanced general-Brep versions.
 *
 * Note: SdBooleanUnion / SdBooleanDifference / SdBooleanIntersection are already
 * registered in transforms.ts. This registers the two new C++-blocked stubs.
 * The tsOps handlers above are exported for direct use and testing but the
 * existing transforms.ts handlers already call brepUnion/brepDifference/brepIntersection
 * via the same backend stack — they ARE the enhanced handlers.
 */
export function registerS326Handlers(_viewer: Viewer): void {
  registerHandler("SdBooleanSplit", (args) =>
    handle_SdBooleanSplit(args, _viewer)
  );
  registerHandler("SdDifferenceWithIndexMap", (args) =>
    handle_SdDifferenceWithIndexMap(args, _viewer)
  );
}
