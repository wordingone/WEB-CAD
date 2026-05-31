/**
 * s332-impl.ts — Issue #332: S12 SubD handler stubs
 *
 * ALL operations in this file are blocked on kern.wasm SubD extensions.
 * No SubD representation or Catmull-Clark evaluator exists in this codebase yet.
 * Each handler returns { error: "NotYetImplemented", detail: "blocked: ..." } until:
 *   1. kern/subd.cpp is written + compiled into kern.wasm
 *   2. web/src/nurbs/subd-mesh.ts (SubDMesh type) is created
 *   3. web/src/nurbs/subd-tessellate.ts (Catmull-Clark tessellator) is created
 *   4. web/src/viewer/subd-display.ts (Three.js display helper) is created
 *
 * See docs/spec-332-subd.md for the full architectural spec.
 *
 * C++ function signatures needed (kern/subd.cpp):
 *
 *   std::string kern_subd_from_mesh(const std::string& geometry_json, double crease_weight)
 *   std::string kern_subd_box(double w, double d, double h, double cx, double cy, double cz)
 *   std::string kern_subd_sphere(double radius, double cx, double cy, double cz)
 *   std::string kern_subd_cylinder(double radius, double height, int sides, double cx, double cy, double cz)
 *   std::string kern_subd_cone(double radius, double height, int sides, double cx, double cy, double cz)
 *   std::string kern_subd_plane(double w, double d, int u_div, int v_div, double cx, double cy, double cz)
 *   std::string kern_subd_torus(double major_r, double minor_r, int u_sides, int v_sides, double cx, double cy, double cz)
 *   std::string kern_subd_subdivide_global(const std::string& mesh_json, int levels)
 *   std::string kern_subd_subdivide_local(const std::string& mesh_json, const std::vector<int>& face_indices, int levels)
 *   std::string kern_subd_crease_set(const std::string& mesh_json, const std::vector<int>& edge_indices, double weight)
 *   std::string kern_subd_crease_remove(const std::string& mesh_json, const std::vector<int>& edge_indices)
 *   std::string kern_subd_to_brep(const std::string& mesh_json, bool smooth, double tolerance)
 *   std::string kern_subd_to_nurbs(const std::string& mesh_json, int degree, double tolerance)
 */

import type { Viewer } from "../viewer/viewer";

// Shared "not yet implemented" response shape for all blocked SubD ops.
function notYetImplemented(op: string, detail: string): {
  error: "NotYetImplemented";
  op: string;
  detail: string;
} {
  return {
    error: "NotYetImplemented",
    op,
    detail: `blocked: ${detail}`,
  };
}

// ─── oracle: Rhino3dm SubD.CreateFromMesh + closed-form vertex/face count ───
// C++ requirement: kern_subd_from_mesh(geometry_json, crease_weight) → SubDMesh JSON
export function handle_SdSubDFromMesh(
  args: Record<string, unknown>,
  _viewer: Viewer,
): ReturnType<typeof notYetImplemented> {
  void args;
  return notYetImplemented(
    "SdSubDFromMesh",
    "requires kern_subd_from_mesh in kern.wasm (SubD module not yet compiled) " +
    "and SubDMesh type + Catmull-Clark tessellator not yet implemented",
  );
}

// ─── oracle: closed-form — 8 verts, 6 quad faces, AABB == input dims ────────
// C++ requirement: kern_subd_box(w, d, h, cx, cy, cz) → SubDMesh JSON
export function handle_SdSubDBox(
  args: Record<string, unknown>,
  _viewer: Viewer,
): ReturnType<typeof notYetImplemented> {
  void args;
  return notYetImplemented(
    "SdSubDBox",
    "requires kern_subd_box in kern.wasm (SubD module not yet compiled) " +
    "and SubDMesh type + Three.js display layer",
  );
}

// ─── oracle: Rhino3dm SubD.CreateSphere vertex count; ToBrep bounding sphere radius 0.5% ───
// C++ requirement: kern_subd_sphere(radius, cx, cy, cz) → SubDMesh JSON
export function handle_SdSubDSphere(
  args: Record<string, unknown>,
  _viewer: Viewer,
): ReturnType<typeof notYetImplemented> {
  void args;
  return notYetImplemented(
    "SdSubDSphere",
    "requires kern_subd_sphere in kern.wasm (Catmull-Clark control point tables for sphere " +
    "approximation are non-trivial; blocked on SubD module)",
  );
}

// ─── oracle: closed-form — lateral vertices on circle of radius at z=0,z=height ───
// C++ requirement: kern_subd_cylinder(radius, height, sides, cx, cy, cz) → SubDMesh JSON
export function handle_SdSubDCylinder(
  args: Record<string, unknown>,
  _viewer: Viewer,
): ReturnType<typeof notYetImplemented> {
  void args;
  return notYetImplemented(
    "SdSubDCylinder",
    "requires kern_subd_cylinder in kern.wasm (SubD module not yet compiled)",
  );
}

// ─── oracle: closed-form — apex at (cx,cy,cz+height), base ring at radius ──
// C++ requirement: kern_subd_cone(radius, height, sides, cx, cy, cz) → SubDMesh JSON
export function handle_SdSubDCone(
  args: Record<string, unknown>,
  _viewer: Viewer,
): ReturnType<typeof notYetImplemented> {
  void args;
  return notYetImplemented(
    "SdSubDCone",
    "requires kern_subd_cone in kern.wasm (SubD module not yet compiled)",
  );
}

// ─── oracle: closed-form — (uDiv+1)*(vDiv+1) verts, uDiv*vDiv quad faces, all z=cz ───
// C++ requirement: kern_subd_plane(w, d, u_div, v_div, cx, cy, cz) → SubDMesh JSON
// Note: TS-implementable for data construction; display blocked on SubDMesh type + tessellator.
export function handle_SdSubDPlane(
  args: Record<string, unknown>,
  _viewer: Viewer,
): ReturnType<typeof notYetImplemented> {
  void args;
  return notYetImplemented(
    "SdSubDPlane",
    "requires SubDMesh type (subd-mesh.ts), Catmull-Clark tessellator (subd-tessellate.ts), " +
    "and Three.js display helper (subd-display.ts) — partially TS-implementable but display blocked",
  );
}

// ─── oracle: closed-form torus parametric formula — uSides*vSides verts ─────
// C++ requirement: kern_subd_torus(major_r, minor_r, u_sides, v_sides, cx, cy, cz) → SubDMesh JSON
export function handle_SdSubDTorus(
  args: Record<string, unknown>,
  _viewer: Viewer,
): ReturnType<typeof notYetImplemented> {
  void args;
  return notYetImplemented(
    "SdSubDTorus",
    "requires kern_subd_torus in kern.wasm (SubD module not yet compiled)",
  );
}

// ─── oracle: post-crease subdivision — edge remains straight vs smooth reference ───
// C++ requirement: kern_subd_crease_set(mesh_json, edge_indices[], weight) → SubDMesh JSON
// Note: data mutation (setting creaseWeight on SubDMesh.edges[i]) is TS-implementable;
//       the visual effect (Catmull-Clark with crease weights) requires the kern.wasm tessellator.
export function handle_SdSubDCreaseSet(
  args: Record<string, unknown>,
  _viewer: Viewer,
): ReturnType<typeof notYetImplemented> {
  void args;
  return notYetImplemented(
    "SdSubDCreaseSet",
    "requires SubDMesh type to exist in scene object (no SubD objects exist yet); " +
    "display of crease effect blocked on Catmull-Clark tessellator with crease weight support",
  );
}

// ─── oracle: crease weight resets to 0; subdivision reverts to smooth ────────
// C++ requirement: kern_subd_crease_remove(mesh_json, edge_indices[]) → SubDMesh JSON
export function handle_SdSubDCreaseRemove(
  args: Record<string, unknown>,
  _viewer: Viewer,
): ReturnType<typeof notYetImplemented> {
  void args;
  return notYetImplemented(
    "SdSubDCreaseRemove",
    "requires SubDMesh type to exist in scene; blocked on SubD object creation ops",
  );
}

// ─── oracle: brepIsSolid=true, nakedEdgeCount=0; points within 0.02 of limit surface ───
// C++ requirement: kern_subd_to_brep(mesh_json, smooth, tolerance) → Brep JSON
export function handle_SdSubDToBrep(
  args: Record<string, unknown>,
  _viewer: Viewer,
): ReturnType<typeof notYetImplemented> {
  void args;
  return notYetImplemented(
    "SdSubDToBrep",
    "requires kern_subd_to_brep in kern.wasm — limit surface extraction with " +
    "Catmull-Clark + NURBS patch fitting for extraordinary vertices is hard-blocked on kern.wasm",
  );
}

// ─── oracle: verb-nurbs Surface.fromControlNet eval vs Catmull-Clark limit surface ───
// C++ requirement: kern_subd_to_nurbs(mesh_json, degree, tolerance) → NurbsSurface[] JSON
export function handle_SdSubDToNurbs(
  args: Record<string, unknown>,
  _viewer: Viewer,
): ReturnType<typeof notYetImplemented> {
  void args;
  return notYetImplemented(
    "SdSubDToNurbs",
    "requires kern_subd_to_nurbs in kern.wasm — per-patch NURBS conversion " +
    "for Catmull-Clark limit surface is hard-blocked on kern.wasm SubD module",
  );
}

// ─── oracle: vertex[i].position === supplied position (exact); display updates ───
// Note: data mutation is TS-implementable; blocked on SubDMesh type existing in scene.
export function handle_SdSubDControlPointEdit(
  args: Record<string, unknown>,
  _viewer: Viewer,
): ReturnType<typeof notYetImplemented> {
  void args;
  return notYetImplemented(
    "SdSubDControlPointEdit",
    "requires SubDMesh type to exist in scene (no SubD objects yet); " +
    "vertex position mutation is TS-implementable once SubDMesh objects exist in scene",
  );
}

/**
 * Register all S332 SubD stub handlers.
 * Called from register-handlers.ts once the SubD subsystem is ready.
 * Currently all return NotYetImplemented.
 */
export function registerSubDHandlers(_viewer: Viewer): void {
  // Dynamic import to avoid circular deps when this module is loaded.
  // Using dynamic require pattern compatible with the existing handler registration style.
  import("../commands/dispatch").then(({ registerHandler }) => {
    registerHandler("SdSubDFromMesh",         (args) => handle_SdSubDFromMesh(args, _viewer));
    registerHandler("SdSubDBox",              (args) => handle_SdSubDBox(args, _viewer));
    registerHandler("SdSubDSphere",           (args) => handle_SdSubDSphere(args, _viewer));
    registerHandler("SdSubDCylinder",         (args) => handle_SdSubDCylinder(args, _viewer));
    registerHandler("SdSubDCone",             (args) => handle_SdSubDCone(args, _viewer));
    registerHandler("SdSubDPlane",            (args) => handle_SdSubDPlane(args, _viewer));
    registerHandler("SdSubDTorus",            (args) => handle_SdSubDTorus(args, _viewer));
    registerHandler("SdSubDCreaseSet",        (args) => handle_SdSubDCreaseSet(args, _viewer));
    registerHandler("SdSubDCreaseRemove",     (args) => handle_SdSubDCreaseRemove(args, _viewer));
    registerHandler("SdSubDToBrep",           (args) => handle_SdSubDToBrep(args, _viewer));
    registerHandler("SdSubDToNurbs",          (args) => handle_SdSubDToNurbs(args, _viewer));
    registerHandler("SdSubDControlPointEdit", (args) => handle_SdSubDControlPointEdit(args, _viewer));
  }).catch(() => {
    // Dispatch module failed to load — no-op; handlers remain unregistered.
  });
}
