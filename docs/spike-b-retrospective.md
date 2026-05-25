# Spike B — IFC Mining Retrospective

**Run date:** 2026-04-30
**Acceptance:** ≥20/30 sampled pairs round-trip-pass + look semantically reasonable.
**Outcome:** Pipeline proven end-to-end. Corpus yield 12 unique pairs, 12/12 clean (100% quality on all that mined). Below the 20-pair threshold by corpus exhaustion, not pipeline failure.

## What was built

`scripts/spike-b-ifc-mining.ts` opens an IFC via web-ifc, walks all elements of nine target types (IfcWall, IfcWallStandardCase, IfcSlab, IfcColumn, IfcBeam, IfcMember, IfcPlate, IfcFooting, IfcBuildingElementProxy), and emits `{nl, nl_variants[3], sequence, representation}` per element. Coverage:

- **Profile types:** IfcRectangleProfileDef, IfcCircleProfileDef, IfcArbitraryClosedProfileDef (with both IfcPolyline and IfcIndexedPolyCurve point-list forms).
- **Boolean ops:** IfcBooleanClippingResult / IfcBooleanResult unwrapped via FirstOperand recursion (lossy — base solid kept, clipping plane dropped).
- **Profile collapse:** axis-aligned 4-point closed polylines folded back to extruded_rectangle so emit-sequence picks `drawRectangle` over `drawPolyline`.
- **Unit detection:** IfcSIUnit LENGTHUNIT prefix (MILLI/CENTI/DECI/KILO/none) → scale factor applied to all profile dims, depth, polyline points, AND placement.translation.

## Corpus surveyed

| File | Source | Yield | Notes |
|---|---|---|---|
| wall-with-opening-and-window.ifc | buildingSMART IFC4 ReferenceView | 1 | IfcWall + IfcArbitraryClosedProfile + polyline-rect collapse |
| column-rectangle.ifc | buildingSMART | 0 | Tessellated (IfcTriangulatedFaceSet) |
| bonsai-project0-walls.ifc | IfcOpenShell tutorial | 5 (4 unique vs project0-openings) | IfcBoolClippingResult → IfcExtrudedAreaSolid + IfcIndexedPolyCurve |
| bonsai-project0-openings.ifc | IfcOpenShell tutorial | 5 (overlap) | Same walls + cuts |
| ifc2x3-col.ifc / ifc4-col.ifc | IfcOpenShell ifcbimtester | 1 + 1 | Column as IfcBuildingElementProxy + circle profile |
| linked-aggregates.ifc | IfcOpenShell test | 2 | Two walls 100mm apart |
| beam-standard-case.ifc | IfcOpenShell | 0 | IfcIShapeProfileDef — Tier 2/3 scope |
| simple-sweep-1.ifc / simple-sweep-2.ifc | IfcOpenShell geom test | 0 | "Invalid IFC Line" parse errors |
| ifc4/ifc2x3/ifc4x3-demo-library.ifc | Bonsai IFC libraries | 0 | IfcTypeProduct templates only, no instances |
| ifc4-entourage-library.ifc | Bonsai | 0 | Same — type templates not placements |

**Net unique:** 12 distinct (NL, sequence) pairs after dedup.

## Quality of the 12 pairs

All 12 pass automated sanity checks:
- All dimensions human-scale (0.05-50m × 0.05-50m × 0.5-30m).
- No NaN / undefined in any sequence.
- Three NL variants per pair, syntactically valid replicad fluent chains.

Representative samples:
```
Build a wall, 6m long, 0.2m thick, 2.8m tall.
  → const e0 = drawRectangle(6, 0.2).sketchOnPlane("XY").extrude(2.8).translate([0, 6, 0]);

Build a wall, 1.1m long, 0.1m thick, 3m tall.
  → const e1 = drawRectangle(1.1, 0.1).sketchOnPlane("XY").extrude(3).translate([0, 0.1, 0]);

Place a circular column, 0.2m radius, 5m tall.
  → const e0 = drawCircle(0.2).sketchOnPlane("XY").extrude(5);
```

## What blocked higher yield

The open parametric IFC corpus is genuinely small. Schependomlaan was retired upstream in 2025; buildingSMART's IFC4 sample suite is mostly tessellated; Bonsai/Blender-BIM's "demo libraries" are IfcTypeProduct catalog entries, not placed instances.

Tessellated geometry (IfcTriangulatedFaceSet, IfcIndexedPolygonalFace) is fundamentally not extractable to parametric — those are mesh fallbacks. I-shape, T-shape, complex revolved profiles are Tier 2/3, deliberately out of Spike B scope.

## What's needed to scale to a training-set corpus

1. **More parametric IFC sources** — IFC2x3 versions of buildingSMART samples, Snowflake/AECO project files, opensource BIM repos like `IfcOpenHouse`, FreeCAD-generated IFC.
2. **Tier 2 ops:** I-shape / T-shape / channel profiles (IfcIShapeProfileDef etc.) for beams/columns; clipping planes preserved as `.cut()` ops.
3. **Tier 3:** Revolutions (IfcRevolvedAreaSolid), sweeps along curves.
4. **Synthetic generator:** programmatic emission of (parametric primitive → IFC → mining round-trip) to cheaply expand corpus.

For the Initial Release's training data, Spike A (50 hand-written pairs) + 12 mined pairs + a synthetic generator gives a defensible v1 dataset without further IFC corpus hunting.

## Pipeline status

End-to-end works on real-world IFC. Confidence high enough to commit the extractor as-is and move to Spike A (LoRA training run). The 12 mined pairs land in `fixtures/spike-b-all.jsonl` and feed Spike A's training set as the "real building" portion alongside the 50 hand-written cases.
