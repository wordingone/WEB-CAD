/**
 * translate.mjs — Rhino/Dynamo/Revit verb → WEB-CAD verb translation table.
 *
 * Static mapping: source-tool command → WEB-CAD verb name + geometry_class.
 * Used by extract.mjs to tag each mined step with a WEB-CAD dispatch target.
 * Imperial conversion for dimension parameters is handled in extract.mjs.
 */

/** @typedef {{ verb: string; geometry_class: string }} VerbTarget */

/** @type {Map<string, VerbTarget>} */
export const VERB_MAP = new Map([
  // §1 Sketch primitives
  ["rectangle",         { verb: "SdRect",      geometry_class: "sketch" }],
  ["rect",              { verb: "SdRect",      geometry_class: "sketch" }],
  ["_rectangle",        { verb: "SdRect",      geometry_class: "sketch" }],
  ["box2d",             { verb: "SdRect",      geometry_class: "sketch" }],
  ["circle",            { verb: "SdCircle",    geometry_class: "sketch" }],
  ["_circle",           { verb: "SdCircle",    geometry_class: "sketch" }],
  ["line",              { verb: "SdLine",      geometry_class: "sketch" }],
  ["_line",             { verb: "SdLine",      geometry_class: "sketch" }],
  ["arc",               { verb: "SdArc",       geometry_class: "sketch" }],
  ["_arc",              { verb: "SdArc",       geometry_class: "sketch" }],
  ["polyline",          { verb: "SdPolyline",  geometry_class: "sketch" }],
  ["_polyline",         { verb: "SdPolyline",  geometry_class: "sketch" }],
  ["polygon",           { verb: "SdPolygon",   geometry_class: "sketch" }],
  ["_polygon",          { verb: "SdPolygon",   geometry_class: "sketch" }],
  ["ellipse",           { verb: "SdEllipse",   geometry_class: "sketch" }],
  ["_ellipse",          { verb: "SdEllipse",   geometry_class: "sketch" }],
  ["spline",            { verb: "SdSpline",    geometry_class: "sketch" }],
  ["_spline",           { verb: "SdSpline",    geometry_class: "sketch" }],
  ["intcrv",            { verb: "SdSpline",    geometry_class: "sketch" }],

  // §2 Solid primitives
  ["box",               { verb: "SdBox",       geometry_class: "solid" }],
  ["_box",              { verb: "SdBox",       geometry_class: "solid" }],
  ["cube",              { verb: "SdBox",       geometry_class: "solid" }],
  ["cylinder",          { verb: "SdCylinder",  geometry_class: "solid" }],
  ["_cylinder",         { verb: "SdCylinder",  geometry_class: "solid" }],
  ["sphere",            { verb: "SdSphere",    geometry_class: "solid" }],
  ["_sphere",           { verb: "SdSphere",    geometry_class: "solid" }],
  ["cone",              { verb: "SdCone",      geometry_class: "solid" }],
  ["_cone",             { verb: "SdCone",      geometry_class: "solid" }],

  // §3 Solid creation
  ["extrudecrv",        { verb: "SdExtrude",   geometry_class: "solid" }],
  ["extrude",           { verb: "SdExtrude",   geometry_class: "solid" }],
  ["_extrude",          { verb: "SdExtrude",   geometry_class: "solid" }],
  ["revolve",           { verb: "SdRevolve",   geometry_class: "solid" }],
  ["_revolve",          { verb: "SdRevolve",   geometry_class: "solid" }],
  ["sweep1",            { verb: "SdSweep",     geometry_class: "solid" }],
  ["sweep2",            { verb: "SdSweep",     geometry_class: "solid" }],
  ["sweep",             { verb: "SdSweep",     geometry_class: "solid" }],
  ["_sweep1",           { verb: "SdSweep",     geometry_class: "solid" }],
  ["loft",              { verb: "SdLoft",      geometry_class: "solid" }],
  ["_loft",             { verb: "SdLoft",      geometry_class: "solid" }],

  // §4 Boolean ops
  ["booleanunion",      { verb: "SdUnion",        geometry_class: "solid" }],
  ["_booleanunion",     { verb: "SdUnion",        geometry_class: "solid" }],
  ["union",             { verb: "SdUnion",        geometry_class: "solid" }],
  ["booleandifference", { verb: "SdDifference",   geometry_class: "solid" }],
  ["_booleandifference",{ verb: "SdDifference",   geometry_class: "solid" }],
  ["difference",        { verb: "SdDifference",   geometry_class: "solid" }],
  ["booleanintersection",{ verb: "SdIntersection", geometry_class: "solid" }],
  ["intersection",      { verb: "SdIntersection", geometry_class: "solid" }],

  // §5 Edge/surface ops
  ["filletedge",        { verb: "SdFillet",    geometry_class: "solid" }],
  ["fillet",            { verb: "SdFillet",    geometry_class: "solid" }],
  ["_filletedge",       { verb: "SdFillet",    geometry_class: "solid" }],
  ["chamferedge",       { verb: "SdChamfer",   geometry_class: "solid" }],
  ["chamfer",           { verb: "SdChamfer",   geometry_class: "solid" }],
  ["offsetsrf",         { verb: "SdOffset",    geometry_class: "solid" }],
  ["offset",            { verb: "SdOffset",    geometry_class: "solid" }],
  ["shell",             { verb: "SdShell",     geometry_class: "solid" }],
  ["_shell",            { verb: "SdShell",     geometry_class: "solid" }],

  // §6 Transform
  ["move",              { verb: "SdMove",      geometry_class: "transform" }],
  ["_move",             { verb: "SdMove",      geometry_class: "transform" }],
  ["rotate",            { verb: "SdRotate",    geometry_class: "transform" }],
  ["rotate3d",          { verb: "SdRotate",    geometry_class: "transform" }],
  ["_rotate",           { verb: "SdRotate",    geometry_class: "transform" }],
  ["scale",             { verb: "SdScale",     geometry_class: "transform" }],
  ["_scale",            { verb: "SdScale",     geometry_class: "transform" }],
  ["mirror",            { verb: "SdMirror",    geometry_class: "transform" }],
  ["_mirror",           { verb: "SdMirror",    geometry_class: "transform" }],
  ["array",             { verb: "SdArray",     geometry_class: "transform" }],
  ["arrayrect",         { verb: "SdArray",     geometry_class: "transform" }],
  ["arraypolar",        { verb: "SdArray",     geometry_class: "transform" }],
  ["_arrayrect",        { verb: "SdArray",     geometry_class: "transform" }],

  // §7 Architectural (Rhino + Dynamo primer + Revit community)
  ["wall",              { verb: "SdWall",      geometry_class: "architectural" }],
  ["createwall",        { verb: "SdWall",      geometry_class: "architectural" }],
  ["slab",              { verb: "SdSlab",      geometry_class: "architectural" }],
  ["floor",             { verb: "SdSlab",      geometry_class: "architectural" }],
  ["createfloor",       { verb: "SdSlab",      geometry_class: "architectural" }],
  ["column",            { verb: "SdColumn",    geometry_class: "architectural" }],
  ["createcolumn",      { verb: "SdColumn",    geometry_class: "architectural" }],
  ["beam",              { verb: "SdBeam",      geometry_class: "architectural" }],
  ["door",              { verb: "SdDoor",      geometry_class: "architectural" }],
  ["createdoor",        { verb: "SdDoor",      geometry_class: "architectural" }],
  ["window",            { verb: "SdWindow",    geometry_class: "architectural" }],
  ["createwindow",      { verb: "SdWindow",    geometry_class: "architectural" }],
  ["roof",              { verb: "SdRoof",      geometry_class: "architectural" }],
  ["createroofbyoutline",{ verb: "SdRoof",     geometry_class: "architectural" }],
  ["stair",             { verb: "SdStair",     geometry_class: "architectural" }],
  ["stairbysketch",     { verb: "SdStair",     geometry_class: "architectural" }],
]);

/**
 * Look up a source-tool verb token and return the WEB-CAD target, or null if unmapped.
 * @param {string} token  lowercase source verb token
 * @returns {VerbTarget | null}
 */
export function lookupVerb(token) {
  return VERB_MAP.get(token.toLowerCase().replace(/[^a-z0-9]/g, "")) ?? null;
}

/**
 * All WEB-CAD verbs present in the map (for coverage reporting).
 * @returns {Set<string>}
 */
export function coveredVerbs() {
  return new Set([...VERB_MAP.values()].map(v => v.verb));
}
