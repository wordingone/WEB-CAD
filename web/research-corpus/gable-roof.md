# Gable roof construction recipe

How to emit a gable roof in tier-1 DSL when a prompt asks for
"a gabled roof on a 6m by 4m building, 3m eave height, 30 degree
pitch."

## Geometry primer

A gable roof is two rectangular planes meeting at a ridge.
Parameters needed:

- Building footprint: width `W`, depth `D`.
- Eave height `He` (top of wall, base of rafter).
- Ridge height `Hr = He + (D/2) * tan(pitch)` for a symmetric gable
  with the ridge running parallel to the long axis.
- Roof thickness `Tr` — defaults to 0.2m for a structural-deck assembly
  with insulation between rafters, 0.3m for cathedral-ceiling assemblies
  with continuous exterior insulation.

## Decomposition

Two extruded triangular prisms can be expressed as two boxes that
have been sheared, but tier-1 DSL has no shear primitive. The
practical recipe is:

1. Build a triangular profile `tri` via `polyline` from
   `(0, 0)`, `(W, 0)`, `(W/2, H_ridge_local)` where
   `H_ridge_local = (D/2) * tan(pitch)`.
2. Extrude along the depth axis to length `D`.
3. Translate to sit at the eave height.

In current tier-1 DSL this collapses to a manually-built `mesh` op or
two `box` halves with `transform` ops. **Tier-2 (post-hackathon) will
add a `roof` primitive that takes pitch + footprint directly.**

## Default pitch values

- **30 degrees** — temperate-climate residential default.
- **45 degrees** — heavy-snow regions (Alpine, Scandinavian, US
  northern Rockies).
- **15 degrees** — modern minimal-mono-pitch reads as "shed roof" not
  "gable" but DSL emits the same primitive.
- **60+ degrees** — historical / Gothic / specialty.

## Overhang

A gable typically has 300-600mm of overhang at the eave (rake +
gable-end). Tier-1 DSL emits the overhang as part of the roof prism
extension beyond the wall outer face. Emit `width = W + 2*overhang`
and `depth = D + 2*overhang`.

## Daylighting interaction

Gables create directional daylighting via gable-end windows.
A south-facing gable end with a 60% glazed area yields significant
solar gain in winter; pair with `daylight-calc.md` for SHGC sizing.

## See also

- `wall-thickness.md` for wall-roof junction thicknesses.
- `daylight-calc.md` for window-to-wall ratio calculations.
- `ifc4-schema-basics.md` — `IfcRoof` is not yet emitted; gables
  currently roundtrip as `IfcSlab` PredefinedType=`ROOF`.
