---
name: extrude-walls
version: 0.1.0
description: Convert a polyline sketch into a wall solid by extruding to a given height.
keywords: [wall, extrude, polyline, sketch, footprint, height, thickness]
examples:
  - "extrude this polyline into a 3m wall"
  - "make these lines 200mm thick walls"
  - "build walls 2.7m tall from the floor outline"
eval_id: skill-extrude-walls-v01
---

## When to use

Pick this skill when the prompt names a closed footprint (polyline, rectangle,
or four-walls outline) and asks for vertical wall solids of a stated height
and thickness. Typical phrases: "extrude these walls", "make this footprint
into walls", "3m wall along this line".

Do NOT pick this skill for:
- placing a door or window into an existing wall (use `place-doors`),
- generating a room from a textual spec (use `room-from-prompt` — it
  internally invokes this skill once per wall),
- mirroring an already-extruded wall to its other side (use
  `mirror-across-axis`).

## How it works

The skill emits a Tier 1 sketch+extrude sequence per
`docs/tier1-conventions.md`:

```js
// Each segment of the polyline becomes one wall solid; thickness is the
// segment-perpendicular extent. The construction is base-at-origin in Z,
// so the floor sits at z=0 and the wall top at z=height.
const wall = drawRectangle(length, thickness)
  .sketchOnPlane("XY")
  .extrude(height)
  .translate([cx, cy, 0])
  .rotate(angleDeg);
```

For a multi-segment polyline, generate one wall per segment and `fuse` them
in order:

```js
const walls = segments.map(makeWall).reduce((acc, w) => acc.fuse(w));
```

Per the conventions doc: prefer `makeBox(L, T, H)` over the sketch form when
the wall is axis-aligned — the dimension form has fewer ways to go wrong.
`makeBox` is centered in X and Y, base-at-origin in Z, which is the
architectural default ("floor is z=0").

## Examples

Prompt: "extrude this 6m × 4m rectangular footprint into 3m walls 200mm thick"

```js
const T = 0.2, H = 3;
const wallS = makeBox(6, T, H).translate([0, -2 + T / 2, 0]);
const wallN = makeBox(6, T, H).translate([0,  2 - T / 2, 0]);
const wallW = makeBox(T, 4 - 2 * T, H).translate([-3 + T / 2, 0, 0]);
const wallE = makeBox(T, 4 - 2 * T, H).translate([ 3 - T / 2, 0, 0]);
return wallS.fuse(wallN).fuse(wallW).fuse(wallE);
```

Prompt: "make this 5m line a 2.5m tall wall, 150mm thick"

```js
return makeBox(5, 0.15, 2.5);
```

## Failure modes

- Non-planar polyline: T1 `drawPolyline` is XY-only; reject 3D polylines with
  a clear error rather than silently flattening.
- Zero or negative thickness: reject — `makeBox` will produce a degenerate
  solid the mesher rejects downstream.
- Self-intersecting footprint: fuse may return a Compound with internal
  faces. Acceptable for rendering but flag for the IFC builder.
- Off-axis walls (45°): the rotation form is correct but verify the
  rotation pivot is the segment midpoint, not the world origin (see the
  `rotate` notes in `docs/tier1-conventions.md`).
