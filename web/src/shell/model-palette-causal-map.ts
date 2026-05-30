export type PaletteRoute =
  | "direct"
  | "transform"
  | "immediate"
  | "create"
  | "op";

export type CanonicalOutcome =
  | "selection-state"
  | "transform-preserves-canonical"
  | "canonical-instance"
  | "canonical-array"
  | "canonical-curve"
  | "canonical-point"
  | "canonical-surface"
  | "canonical-brep"
  | "canonical-brep-edit"
  | "canonical-brep-derived-curves"
  | "canonical-reference"
  | "canonical-annotation-curve"
  | "dom-annotation"
  | "section-state"
  | "clipping-state";

export type ModelPaletteCausalSpec = {
  paletteId: string;
  command: string;
  route: PaletteRoute;
  inputs: string[];
  canonicalOutcome: CanonicalOutcome;
  implementationStatus?: "canonical" | "canonical-with-mesh-display" | "mesh-derived-gap" | "state-only";
  evidence?: string[];
  weaknesses?: string[];
  notes?: string;
};

export const MODEL_PALETTE_CAUSAL_SPECS: Record<string, ModelPaletteCausalSpec> = {
  select: {
    paletteId: "select",
    command: "SdSelect",
    route: "direct",
    inputs: ["click object or subobject; hold menu exposes window, lasso, boundary modes"],
    canonicalOutcome: "selection-state",
  },
  move: {
    paletteId: "move",
    command: "SdMove",
    route: "transform",
    inputs: ["select target", "drag gizmo or enter x/y/z delta"],
    canonicalOutcome: "transform-preserves-canonical",
  },
  rotate: {
    paletteId: "rotate",
    command: "SdRotate",
    route: "transform",
    inputs: ["select target", "drag rotation ring or enter angle/base/axis"],
    canonicalOutcome: "transform-preserves-canonical",
  },
  scale: {
    paletteId: "scale",
    command: "SdScale",
    route: "transform",
    inputs: ["select target", "drag scale handle or choose scale mode", "enter factor/base point"],
    canonicalOutcome: "transform-preserves-canonical",
  },
  copy: {
    paletteId: "copy",
    command: "SdCopy",
    route: "op",
    inputs: ["select or click source object", "click destination or enter dx/dy/dz"],
    canonicalOutcome: "canonical-instance",
  },
  array: {
    paletteId: "array",
    command: "SdArray",
    route: "op",
    inputs: ["select or click source object", "choose linear/rectangular/polar/along-curve mode", "enter count and spacing/path inputs"],
    canonicalOutcome: "canonical-array",
    notes: "Specialized modes dispatch SdArrayLinear, SdArrayGrid, SdArrayPolar, or SdArrayAlongCurve.",
  },
  "align-left": {
    paletteId: "align-left",
    command: "SdAlignObjects",
    route: "immediate",
    inputs: ["select at least two objects"],
    canonicalOutcome: "transform-preserves-canonical",
  },
  "align-center-h": {
    paletteId: "align-center-h",
    command: "SdAlignObjects",
    route: "immediate",
    inputs: ["select at least two objects"],
    canonicalOutcome: "transform-preserves-canonical",
  },
  "align-right": {
    paletteId: "align-right",
    command: "SdAlignObjects",
    route: "immediate",
    inputs: ["select at least two objects"],
    canonicalOutcome: "transform-preserves-canonical",
  },
  "align-top": {
    paletteId: "align-top",
    command: "SdAlignObjects",
    route: "immediate",
    inputs: ["select at least two objects"],
    canonicalOutcome: "transform-preserves-canonical",
  },
  "align-center-v": {
    paletteId: "align-center-v",
    command: "SdAlignObjects",
    route: "immediate",
    inputs: ["select at least two objects"],
    canonicalOutcome: "transform-preserves-canonical",
  },
  "align-bottom": {
    paletteId: "align-bottom",
    command: "SdAlignObjects",
    route: "immediate",
    inputs: ["select at least two objects"],
    canonicalOutcome: "transform-preserves-canonical",
  },
  "dist-h": {
    paletteId: "dist-h",
    command: "SdAlignObjects",
    route: "immediate",
    inputs: ["select at least three objects"],
    canonicalOutcome: "transform-preserves-canonical",
  },
  "dist-v": {
    paletteId: "dist-v",
    command: "SdAlignObjects",
    route: "immediate",
    inputs: ["select at least three objects"],
    canonicalOutcome: "transform-preserves-canonical",
  },
  line: {
    paletteId: "line",
    command: "SdLine",
    route: "create",
    inputs: ["click start point", "click end point"],
    canonicalOutcome: "canonical-curve",
  },
  rect: {
    paletteId: "rect",
    command: "SdRectangle",
    route: "create",
    inputs: ["click first corner", "click opposite corner"],
    canonicalOutcome: "canonical-curve",
  },
  circle: {
    paletteId: "circle",
    command: "SdCircle",
    route: "create",
    inputs: ["click center", "click radius point"],
    canonicalOutcome: "canonical-curve",
  },
  polygon: {
    paletteId: "polygon",
    command: "SdPolygon",
    route: "create",
    inputs: ["click center", "click radius point"],
    canonicalOutcome: "canonical-curve",
  },
  arc: {
    paletteId: "arc",
    command: "SdArc",
    route: "create",
    inputs: ["click center", "click start point", "click end point"],
    canonicalOutcome: "canonical-curve",
  },
  polyline: {
    paletteId: "polyline",
    command: "SdPolyline",
    route: "create",
    inputs: ["click two or more points", "press Enter to finish"],
    canonicalOutcome: "canonical-curve",
  },
  curve: {
    paletteId: "curve",
    command: "SdCurve",
    route: "create",
    inputs: ["click two or more control points", "press Enter to finish"],
    canonicalOutcome: "canonical-curve",
  },
  spline: {
    paletteId: "spline",
    command: "SdSpline",
    route: "create",
    inputs: ["click at least four control points", "press Enter to finish"],
    canonicalOutcome: "canonical-curve",
  },
  point: {
    paletteId: "point",
    command: "SdPoint",
    route: "create",
    inputs: ["click point position"],
    canonicalOutcome: "canonical-point",
  },
  extrude: {
    paletteId: "extrude",
    command: "SdExtrude",
    route: "op",
    inputs: ["click profile curve, solid, or surface", "move cursor for height preview", "click to commit height"],
    canonicalOutcome: "canonical-brep",
  },
  loft: {
    paletteId: "loft",
    command: "SdLoft",
    route: "op",
    inputs: ["click first profile curve", "click second profile curve"],
    canonicalOutcome: "canonical-surface",
    notes: "Closed profile pairs dispatch solid=true and create a canonical BRep.",
  },
  sweep: {
    paletteId: "sweep",
    command: "SdSweep",
    route: "op",
    inputs: ["click rail curve", "click profile curve"],
    canonicalOutcome: "canonical-surface",
    notes: "Closed profile dispatches solid=true and creates a canonical BRep.",
  },
  revolve: {
    paletteId: "revolve",
    command: "SdRevolve",
    route: "op",
    inputs: ["click profile curve", "click first axis point", "click second axis point"],
    canonicalOutcome: "canonical-brep",
  },
  plane: {
    paletteId: "plane",
    command: "SdPlane",
    route: "op",
    inputs: ["click origin", "click point on x-axis", "click point on y-axis"],
    canonicalOutcome: "canonical-surface",
  },
  surface: {
    paletteId: "surface",
    command: "SdSurface",
    route: "op",
    inputs: ["click closed curve profile"],
    canonicalOutcome: "canonical-brep",
  },
  boolean: {
    paletteId: "boolean",
    command: "SdBoolean",
    route: "op",
    inputs: ["click first solid", "click second solid", "choose union/difference/intersection"],
    canonicalOutcome: "canonical-brep-edit",
  },
  "bool-union": {
    paletteId: "bool-union",
    command: "SdBooleanUnion",
    route: "op",
    inputs: ["click first solid", "click second solid"],
    canonicalOutcome: "canonical-brep-edit",
  },
  "bool-diff": {
    paletteId: "bool-diff",
    command: "SdBooleanDifference",
    route: "op",
    inputs: ["click outer solid", "click inner/cutter solid"],
    canonicalOutcome: "canonical-brep-edit",
  },
  "bool-intersect": {
    paletteId: "bool-intersect",
    command: "SdBooleanIntersection",
    route: "op",
    inputs: ["click first solid", "click second solid"],
    canonicalOutcome: "canonical-brep-edit",
  },
  fillet: {
    paletteId: "fillet",
    command: "SdFillet",
    route: "op",
    inputs: ["click solid mesh or polyline/curve", "click highlighted edge or corner", "enter radius"],
    canonicalOutcome: "canonical-brep-edit",
    implementationStatus: "canonical",
    evidence: [
      "viewer/op-tool.ts routes palette completion through dispatchSync(\"SdFillet\")",
      "handlers/transforms.ts uses canonicalEdgeChamferDisplayResult for selected supported BRep box edges",
      "handlers/transforms.ts uses canonicalAllEdgeChamferDisplayResult for supported box-like BRep all-edge chamfers",
      "handlers/transforms.ts returns an explicit unsupported-native-kernel error for unsupported-shape paths instead of creating a mesh-derived canonical fallback",
    ],
    weaknesses: [
      "Selected-edge and all-edge chamfer are BRep-native only for supported canonical box-like BReps; broader curved/complex BRep fillets are not implemented.",
      "Unsupported-shape Fillet now fails explicitly rather than preserving the old mesh-era visual fallback; full feature parity still requires a general BRep-native fillet/chamfer kernel.",
    ],
  },
  "brep-explode": {
    paletteId: "brep-explode",
    command: "SdExplode",
    route: "op",
    inputs: ["click group, solid, or BRep"],
    canonicalOutcome: "canonical-brep-edit",
  },
  "brep-join": {
    paletteId: "brep-join",
    command: "SdJoin",
    route: "op",
    inputs: ["click first BRep/surface/face", "click second BRep/surface/face"],
    canonicalOutcome: "canonical-brep-edit",
  },
  "brep-rebuild": {
    paletteId: "brep-rebuild",
    command: "SdRebuild",
    route: "op",
    inputs: ["click curve, surface, or BRep"],
    canonicalOutcome: "canonical-brep-edit",
  },
  "brep-contour": {
    paletteId: "brep-contour",
    command: "SdContour",
    route: "op",
    inputs: ["click solid or BRep"],
    canonicalOutcome: "canonical-brep-derived-curves",
  },
  wall: {
    paletteId: "wall",
    command: "SdWall",
    route: "create",
    inputs: ["click start endpoint", "click end endpoint"],
    canonicalOutcome: "canonical-brep",
  },
  slab: {
    paletteId: "slab",
    command: "SdSlab",
    route: "create",
    inputs: ["click first footprint corner", "click opposite footprint corner"],
    canonicalOutcome: "canonical-brep",
  },
  column: {
    paletteId: "column",
    command: "SdColumn",
    route: "create",
    inputs: ["click column position"],
    canonicalOutcome: "canonical-brep",
  },
  beam: {
    paletteId: "beam",
    command: "SdBeam",
    route: "create",
    inputs: ["click beam start", "click beam end"],
    canonicalOutcome: "canonical-brep",
  },
  roof: {
    paletteId: "roof",
    command: "SdRoof",
    route: "create",
    inputs: ["click first footprint corner", "click opposite footprint corner"],
    canonicalOutcome: "canonical-brep",
  },
  space: {
    paletteId: "space",
    command: "SdSpace",
    route: "create",
    inputs: ["click first footprint corner", "click opposite footprint corner"],
    canonicalOutcome: "canonical-brep",
  },
  foundation: {
    paletteId: "foundation",
    command: "SdFoundation",
    route: "create",
    inputs: ["click first footprint corner", "click opposite footprint corner"],
    canonicalOutcome: "canonical-brep",
  },
  ceiling: {
    paletteId: "ceiling",
    command: "SdCeiling",
    route: "create",
    inputs: ["click first footprint corner", "click opposite footprint corner"],
    canonicalOutcome: "canonical-brep",
  },
  grid: {
    paletteId: "grid",
    command: "SdRefGrid",
    route: "create",
    inputs: ["click grid origin", "click spacing/direction point"],
    canonicalOutcome: "canonical-reference",
  },
  level: {
    paletteId: "level",
    command: "SdLevel",
    route: "create",
    inputs: ["click level elevation/position"],
    canonicalOutcome: "canonical-surface",
  },
  datum: {
    paletteId: "datum",
    command: "SdDatum",
    route: "create",
    inputs: ["click reference start", "click reference end"],
    canonicalOutcome: "canonical-reference",
  },
  stair: {
    paletteId: "stair",
    command: "SdStair",
    route: "create",
    inputs: ["click stair start", "click stair end"],
    canonicalOutcome: "canonical-brep",
  },
  door: {
    paletteId: "door",
    command: "SdDoor",
    route: "create",
    inputs: ["click insertion point; optional wall host is resolved from context"],
    canonicalOutcome: "canonical-brep",
  },
  window: {
    paletteId: "window",
    command: "SdWindow",
    route: "create",
    inputs: ["click insertion point; optional wall host is resolved from context"],
    canonicalOutcome: "canonical-brep",
  },
  ramp: {
    paletteId: "ramp",
    command: "SdRamp",
    route: "create",
    inputs: ["click ramp start", "click ramp end"],
    canonicalOutcome: "canonical-brep",
  },
  railing: {
    paletteId: "railing",
    command: "SdRailing",
    route: "create",
    inputs: ["click railing start", "click railing end"],
    canonicalOutcome: "canonical-brep",
  },
  curtainwall: {
    paletteId: "curtainwall",
    command: "SdCurtainWall",
    route: "create",
    inputs: ["click curtain wall start", "click curtain wall end"],
    canonicalOutcome: "canonical-brep",
  },
  skylight: {
    paletteId: "skylight",
    command: "SdSkylight",
    route: "create",
    inputs: ["click first footprint corner", "click opposite footprint corner"],
    canonicalOutcome: "canonical-brep",
  },
  opening: {
    paletteId: "opening",
    command: "SdOpening",
    route: "create",
    inputs: ["click insertion point; optional wall host is resolved from context"],
    canonicalOutcome: "canonical-brep",
  },
  section: {
    paletteId: "section",
    command: "SdSectionBox",
    route: "create",
    inputs: ["click first section-box corner", "click opposite section-box corner"],
    canonicalOutcome: "section-state",
  },
  clip: {
    paletteId: "clip",
    command: "SdClippingPlane",
    route: "create",
    inputs: ["click horizontal cut height/position; hold menu exposes section mode"],
    canonicalOutcome: "clipping-state",
  },
  "aligned-dim": {
    paletteId: "aligned-dim",
    command: "SdAlignedDim",
    route: "op",
    inputs: ["click first point", "click second point"],
    canonicalOutcome: "canonical-annotation-curve",
  },
  "angular-dim": {
    paletteId: "angular-dim",
    command: "SdAngularDim",
    route: "op",
    inputs: ["click vertex", "click first ray point", "click second ray point"],
    canonicalOutcome: "canonical-annotation-curve",
  },
  "area-dim": {
    paletteId: "area-dim",
    command: "SdAreaDim",
    route: "op",
    inputs: ["click at least three polygon points", "press Enter to compute"],
    canonicalOutcome: "canonical-annotation-curve",
  },
  "volume-dim": {
    paletteId: "volume-dim",
    command: "SdVolumeDim",
    route: "op",
    inputs: ["click object to measure"],
    canonicalOutcome: "canonical-annotation-curve",
  },
  label: {
    paletteId: "label",
    command: "SdLabel",
    route: "op",
    inputs: ["click label anchor point", "enter label text"],
    canonicalOutcome: "dom-annotation",
  },
  "transient-measure": {
    paletteId: "transient-measure",
    command: "SdTransientMeasure",
    route: "op",
    inputs: ["click first point", "click second point"],
    canonicalOutcome: "canonical-annotation-curve",
  },
  "sel-window": {
    paletteId: "sel-window",
    command: "SdSelectWindow",
    route: "op",
    inputs: ["choose crossing/window mode", "drag screen rectangle"],
    canonicalOutcome: "selection-state",
  },
  "sel-lasso": {
    paletteId: "sel-lasso",
    command: "SdSelectLasso",
    route: "op",
    inputs: ["choose crossing/window mode", "drag freehand lasso"],
    canonicalOutcome: "selection-state",
  },
  "sel-boundary": {
    paletteId: "sel-boundary",
    command: "SdSelectBoundary",
    route: "op",
    inputs: ["choose pick-curve or draw-polygon mode", "provide boundary polygon"],
    canonicalOutcome: "selection-state",
  },
  "scale-1d": {
    paletteId: "scale-1d",
    command: "SdScale",
    route: "transform",
    inputs: ["select target", "provide one-axis scale factor/base"],
    canonicalOutcome: "transform-preserves-canonical",
  },
  "scale-2d": {
    paletteId: "scale-2d",
    command: "SdScale",
    route: "transform",
    inputs: ["select target", "provide two-axis scale factor/base"],
    canonicalOutcome: "transform-preserves-canonical",
  },
  "wall-polyline": {
    paletteId: "wall-polyline",
    command: "SdWall",
    route: "create",
    inputs: ["click chain of wall vertices", "press Enter to finish"],
    canonicalOutcome: "canonical-brep",
  },
  "wall-curve": {
    paletteId: "wall-curve",
    command: "SdCurveWall",
    route: "create",
    inputs: ["click control points", "press Enter to finish"],
    canonicalOutcome: "canonical-brep",
  },
  "wall-pick": {
    paletteId: "wall-pick",
    command: "SdWall",
    route: "create",
    inputs: ["pick existing line, curve, or polygon profile"],
    canonicalOutcome: "canonical-brep",
  },
  "stair-polyline": {
    paletteId: "stair-polyline",
    command: "SdStair",
    route: "create",
    inputs: ["click stair path vertices", "press Enter to finish"],
    canonicalOutcome: "canonical-brep",
  },
  "stair-curve": {
    paletteId: "stair-curve",
    command: "SdStair",
    route: "create",
    inputs: ["click stair curve control points", "press Enter to finish"],
    canonicalOutcome: "canonical-brep",
  },
  "clip-section": {
    paletteId: "clip-section",
    command: "SdClippingPlane",
    route: "create",
    inputs: ["click section line start", "click section line end"],
    canonicalOutcome: "clipping-state",
  },
};
