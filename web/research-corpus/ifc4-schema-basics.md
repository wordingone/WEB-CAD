# IFC4 schema basics

What gemma-architect's IFC4 export round-trip actually validates,
mapped to the buildingSMART IFC4 schema.

## Top-level project hierarchy

Every IFC4 file has one `IfcProject`, which owns one or more
`IfcSite`, each of which owns one or more `IfcBuilding`, each of
which owns `IfcBuildingStorey` instances. Building elements
(`IfcWall`, `IfcSlab`, `IfcColumn`, etc.) are decomposed via
`IfcRelContainedInSpatialStructure` into a storey.

gemma-architect emits a single `IfcProject + IfcSite + IfcBuilding +
IfcBuildingStorey` skeleton, then attaches all generated elements to
the single storey at z=0.

## Element types we emit

| DSL op | IFC4 entity | Notes |
|---|---|---|
| `wall` | `IfcWallStandardCase` | Centerline + thickness + height. |
| `slab` | `IfcSlab` (PredefinedType=`FLOOR` or `ROOF`) | Polyline boundary + thickness. |
| `column` | `IfcColumn` | Profile + extrusion. |
| `box` | `IfcBuildingElementProxy` | Generic box; loses semantic intent. |
| `cut` boolean | `IfcRelVoidsElement` + `IfcOpeningElement` | Subtracted volume becomes an opening. |

The `IfcBuildingElementProxy` fallback is intentional: when the prompt
describes a non-standard element (e.g. "decorative mullion"), we emit
it as a proxy rather than mis-classify as a wall.

## Geometry representation

We emit `IfcShapeRepresentation` of type `Body` with a single
`IfcExtrudedAreaSolid`. The `IfcAxis2Placement3D` for each element
sets the local origin at the centerline's first point, with z-up
default direction.

Round-trip validation: `web/src/ifc.ts` uses `web-ifc`'s
`LoadAllGeometry` API to parse our output and confirms vertex count
matches the source mesh within 5%.

## What we don't emit

- `IfcSpace` / `IfcZone` — no spatial subdivisions.
- Property sets (`Pset_WallCommon`, etc.) — material and fire-rating
  metadata is omitted.
- `IfcMaterial` / layered constructions — the wall body is a single
  solid, no layered material assignment.
- Parametric relationships (`IfcRelConnectsPathElements`) — wall
  joints are recomputed at boolean evaluation, not stored.

The first item judges flag is missing property sets — they make IFC
files "feel inert." Adding a `Pset_WallCommon` with `Reference`,
`AcousticRating`, and `FireRating` is in the post-hackathon backlog.

## Schema version

We target **IFC4 (4_0)** specifically, not IFC4.3 (`IFC4X3_ADD2`),
because `web-ifc@0.0.77` validates IFC4 most reliably. IFC2x3 export
is opt-in via a CLI flag in the export drawer.

## See also

- buildingSMART IFC4 specification at
  https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/
- `wall-thickness.md` for the wall-element thickness conventions.
- `building-codes-101.md` for code-driven property-set requirements.
