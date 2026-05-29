# Canonical Leftside Palette Architecture

Current audit for the MODEL left palette. This document is evidence for the
BRep/NURBS migration, not a claim that all tools are complete.

Authoritative sources:
- `web/src/shell/workbench-panels.ts` defines the palette inventory.
- `web/src/app-state.ts` maps hidden subtools to visible parent buttons.
- `web/src/tools/index.ts` routes create-mode tools and links create-mode canonical records.
- `web/src/viewer/op-tool.ts` routes operation tools.
- `web/src/handlers/*.ts` implement agent-facing `Sd*` commands.
- `web/test/model-palette-canonical-coverage.test.ts` gates the current inventory and ARCH/CAD visibility split.

## Visibility Model

The first transform section, analysis section, and annotation section are visible
in both ARCH and CAD. The ARCH tab shows architectural/BIM creation sections and
hides CAD sketch/solid/BRep sections. The CAD tab shows sketch/solid/BRep
sections and hides architectural/BIM creation sections.

## Button Routing

All model palette buttons dispatch through:

```text
palette button -> dispatchSync("setActiveTool", { toolId })
  -> app-state activeTool subscriber
  -> one of:
     - precision transform state machine
     - create-mode TOOL_HANDLERS click pipeline
     - op-tool phase machine
     - immediate align/distribute command
```

Hidden long-press subtools highlight their visible parent button:

| Hidden active tool | Visible parent |
|---|---|
| `wall-polyline`, `wall-curve`, `wall-pick` | `wall` |
| `stair-polyline`, `stair-curve` | `stair` |
| `clip-section` | `clip` |
| `scale-1d`, `scale-2d` | `scale` |
| `sel-window`, `sel-lasso`, `sel-boundary` | `select` |

## Shared Buttons

| ID | Label | User interaction | Runtime chain | Canonical status |
|---|---|---|---|---|
| `select` | Select | click; long-press selects Standard/Window/Lasso/Boundary | selection or `opStartTool(sel-*)` | no creation |
| `move` | Move | select object, point/typed displacement | precision transform -> `SdMove` | preserves canonical links |
| `rotate` | Rotate | select object, axis/angle points or typed input | precision transform -> `SdRotate` | preserves canonical links |
| `scale` | Scale | click 3D scale; long-press 1D/2D/3D | precision transform -> `SdScale` | preserves canonical links |
| `copy` | Copy | select source then destination or typed delta | `opStartTool(copy)` -> `SdCopy` | duplicate links to same canonical record |
| `array` | Array | source then Linear/Rectangular/Polar/Curve mode | `opStartTool(array)` -> `SdArray*` | instances preserve canonical links |
| `align-*`, `dist-*` | Align/Distribute | requires multi-selection | `execAlignTool` | transform-only; no new geometry |
| `section` | Section Box | two clicks | create-mode -> `SdSectionBox` | clip state/reference mesh, not BRep creation |
| `clip` | Clip Plane | one click; long-press section mode uses two clicks | create-mode -> `SdClippingPlane` | clip state/reference mesh, not BRep creation |
| `aligned-dim` | Aligned Dim | two points plus label placement | `opStartTool(dim)` -> `SdAlignedDim` | annotation |
| `angular-dim` | Angular Dim | vertex and two rays | `opStartTool(dim)` -> `SdAngularDim` | annotation |
| `area-dim` | Area | polygon points, Enter commit | `opStartTool(dim)` -> `SdAreaDim` | annotation |
| `volume-dim` | Volume | click object | `opStartTool(dim)` -> `SdVolumeDim` | annotation/measurement |
| `label` | Label | point then text | `opStartTool(label)` -> `SdLabel` | annotation |
| `transient-measure` | Transient | two points | `opStartTool(tmeasure)` | transient annotation |

## CAD Buttons

| ID | Label | User interaction | Runtime chain | Agent command | Canonical status |
|---|---|---|---|---|---|
| `line` | Line | two clicks | `TOOL_HANDLERS.line` | `SdLine` | canonical NURBS/line curve |
| `rect` | Rectangle | two clicks | `TOOL_HANDLERS.rect` | `SdRectangle` | canonical closed polyline curve |
| `circle` | Circle | center + radius click | `TOOL_HANDLERS.circle` | `SdCircle` | canonical arc/full-circle curve |
| `polygon` | Polygon | center + radius; `[`/`]` sides | `TOOL_HANDLERS.polygon` | `SdPolygon` | canonical closed polyline curve |
| `arc` | Arc | center, radius point, endpoint | `TOOL_HANDLERS.arc` | `SdArc` | canonical NURBS arc curve |
| `polyline` | Polyline | unlimited points, Enter/double-click commit | `TOOL_HANDLERS.polyline` | `SdPolyline` | canonical polyline curve |
| `curve` | Curve | unlimited control points, Enter commit | `TOOL_HANDLERS.curve` | `SdCurve` | canonical Catmull-Rom/NURBS curve |
| `spline` | Spline | >=4 control points, Enter commit | `TOOL_HANDLERS.spline` | `SdSpline` | canonical clamped NURBS curve |
| `point` | Point | one click | `TOOL_HANDLERS.point` | `SdPoint` | canonical point |
| `extrude` | Extrude | pick profile/solid/surface, height interaction | `opStartTool(extrude)` | `SdExtrude` | command path creates canonical BRep; UI path still uses mesh display generation plus canonical link |
| `loft` | Loft | pick two profile curves | `opStartTool(loft)` | `SdLoft` | canonical NURBS surface |
| `sweep` | Sweep | pick rail, then profile | `opStartTool(sweep)` | `SdSweep` | canonical NURBS surface |
| `revolve` | Revolve | pick profile, two axis points | `opStartTool(revolve)` | `SdRevolve` | canonical revolution surface |
| `plane` | Plane | three points | `opStartTool(plane)` | `SdPlane` | canonical plane surface |
| `surface` | Surface | pick closed curve | `opStartTool(surface)` | `SdSurface` | canonical trimmed planar BRep |
| `boolean` | Boolean | pick A, B, choose op | `opStartTool(boolean)` | `SdBoolean` | display still uses mesh CSG; canonical result uses BRep backend when both operands have BRep records, including exact planar NURBS faces |
| `bool-union` | Union | pick A then B | `opStartTool(bool-union)` | `SdBooleanUnion` | display still uses mesh CSG; canonical result uses BRep backend when both operands have BRep records, including exact planar NURBS faces |
| `bool-diff` | Difference | pick A then B | `opStartTool(bool-diff)` | `SdBooleanDifference` | display still uses mesh CSG; canonical result uses BRep backend when both operands have BRep records, including exact planar NURBS faces |
| `bool-intersect` | Intersect | pick A then B | `opStartTool(bool-intersect)` | `SdBooleanIntersection` | display still uses mesh CSG; canonical result uses BRep backend when both operands have BRep records, including exact planar NURBS faces |
| `fillet` | Fillet | pick solid edge or curve corner, radius | `opStartTool(fillet)` | `SdFillet` | edge and all-edge paths now link planarized BRep results; not NURBS-native fillet |
| `brep-explode` | Explode | click group/object | `opStartTool(brep-explode)` | `SdExplode` | canonical BRep targets extract one open BRep shell per face, preserving face surface plus explicit naked boundary edges/vertices |
| `brep-join` | Join | click two objects | `opStartTool(brep-join)` | `SdJoin` | canonical open BRep faces/surfaces with coincident boundary edges are welded into one shell; separated closed solids still concatenate as separate shells |
| `brep-rebuild` | Rebuild | pick curve | `opStartTool(brep-rebuild)` | `SdRebuild` | retessellation/sample rebuild; not NURBS surface rebuild |
| `brep-contour` | Contour | pick solid | `opStartTool(brep-contour)` | `SdContour` | display contour generation; not robust BRep/surface intersection |

## ARCH Buttons

| ID | Label | User interaction | Runtime chain | Agent command | Canonical status |
|---|---|---|---|---|---|
| `wall` | Wall | two clicks; long-press wall/polyline/curve/pick | `TOOL_HANDLERS.wall*` | `SdWall` | straight/polyline walls use extruded BRep; curve wall is planarized mesh BRep |
| `slab` | Slab | two corners | `TOOL_HANDLERS.slab` | `SdSlab` | canonical extruded BRep |
| `column` | Column | one point | `TOOL_HANDLERS.column` | `SdColumn` | canonical extruded BRep |
| `beam` | Beam | two points | `TOOL_HANDLERS.beam` | `SdBeam` | canonical extruded BRep |
| `roof` | Roof | two footprint corners | `TOOL_HANDLERS.roof` | `SdRoof` | component meshes planarized into BRep records; no single semantic roof BRep |
| `space` | Space | two corners | `TOOL_HANDLERS.space` | `SdSpace` | canonical extruded BRep |
| `foundation` | Foundation | two corners | `TOOL_HANDLERS.foundation` | `SdFoundation` | canonical extruded BRep |
| `ceiling` | Ceiling | two corners | `TOOL_HANDLERS.ceiling` | `SdCeiling` | canonical extruded BRep |
| `grid` | Grid | two points | `TOOL_HANDLERS.grid` | `SdRefGrid` | canonical reference curve |
| `level` | Level | one point/elevation pick | `TOOL_HANDLERS.level` | `SdLevel` | canonical reference plane surface |
| `datum` | Reference Line | two points | `TOOL_HANDLERS.datum` | `SdDatum` | canonical reference curve |
| `stair` | Stair | two clicks; long-press polyline/curve | `TOOL_HANDLERS.stair*` | `SdStair` | component meshes planarized into BRep records; no single semantic stair BRep |
| `door` | Door | one click on/near wall; variant picker | `TOOL_HANDLERS.door` | `SdDoor` | canonical opening-envelope BRep; visible insert remains display mesh |
| `window` | Window | one click on/near wall; variant picker | `TOOL_HANDLERS.window` | `SdWindow` | canonical opening-envelope BRep; visible insert remains display mesh |
| `ramp` | Ramp | two points | `TOOL_HANDLERS.ramp` | `SdRamp` | canonical extruded BRep |
| `railing` | Railing | two points | `TOOL_HANDLERS.railing` | `SdRailing` | canonical extruded BRep |
| `curtainwall` | Curtain Wall | two points | `TOOL_HANDLERS.curtainwall` | `SdCurtainWall` | canonical envelope BRep linked to visible group and join shell |
| `skylight` | Skylight | two points | `TOOL_HANDLERS.skylight` | `SdSkylight` | canonical extruded BRep |
| `opening` | Opening | one click | `TOOL_HANDLERS.opening` | `SdOpening` | canonical opening-envelope BRep |

## Current Hard Gaps

These are known limitations, not acceptable final-state claims:

| Area | Gap |
|---|---|
| BRep booleans | UI display generation still relies on mesh CSG. Canonical records now use the planar BRep boolean backend when possible, including exact planar NURBS boxes, but this is still not a full trimmed-surface BooleanBuilder. |
| Fillet | Current fillet is mesh/polyline based and is now canonically linked for edge and all-edge paths. It does not create exact NURBS fillet surfaces between BRep faces. |
| BRep join/rebuild/contour | Join now welds coincident boundary edges for open canonical BRep face shells, but does not do tolerance-heavy sewing for arbitrary nonmatching trims; rebuild converts face surfaces to NURBS form but does not reparameterize to a new fit count; contour samples canonical BRep faces but is not a full surface/solid intersection kernel. |
| BRep explode | Canonical BRep explode now extracts one open BRep shell per face with explicit naked boundary topology; remaining gap is multi-face subobject selection/extraction rather than whole-object explode only. |
| Curved architectural elements | Curve wall, stair, and roof paths are mostly planarized display meshes rather than coherent semantic BRep/NURBS objects. |
| IFC semantic solids | FZK conversion now merges connected coplanar triangles per IFC element into planar NURBS-trimmed BRep faces. It is still not semantic IFC solid reconstruction or higher-order analytic surface recovery. |

## Regression Gates

Minimum gates for this document:

```text
bun test web/test/model-palette-canonical-coverage.test.ts
bun test web/test/transforms.test.ts web/test/surface-nurbs-userdata.test.ts
```
