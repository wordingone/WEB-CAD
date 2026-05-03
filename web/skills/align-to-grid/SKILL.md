---
name: align-to-grid
version: 0.1.0
description: Snap a selection of solids to the nearest grid intersection.
keywords: [align, snap, grid, nearest, intersection, position, translate, round]
examples:
  - "align these to the grid"
  - "snap the selection to the nearest 100mm gridpoint"
  - "round all positions to the nearest 0.5m"
eval_id: skill-align-to-grid-v01
---

## When to use

The prompt asks to align one or more solids to a grid (canonically the
construction-plane grid). Typical phrases: "align to grid", "snap to
nearest 100mm", "round positions to half-meter".

Do NOT pick this skill for:
- aligning to another solid's edge (use `align-to-edge` — TBD),
- aligning along a single axis only (use `align-to-axis` — TBD; this
  skill rounds in all three axes simultaneously),
- mirror or radial alignment (use `mirror-across-axis` or
  `radial-array`).

## How it works

The skill computes the centroid of each solid, rounds it to the nearest
grid intersection, and emits a `translate` to move the solid by the
delta. Per `docs/tier1-conventions.md`, `translate` does not change the
solid's local origin — so rounding the centroid is equivalent to
rounding the solid's reference point.

```js
const cell = 0.1;   // 100mm grid
function snap(p) {
  return [
    Math.round(p[0] / cell) * cell,
    Math.round(p[1] / cell) * cell,
    Math.round(p[2] / cell) * cell,
  ];
}
const out = selection.map((solid) => {
  const c = bbox(solid).center;
  const target = snap(c);
  const delta = [target[0] - c[0], target[1] - c[1], target[2] - c[2]];
  return solid.translate(delta);
});
return out;
```

The default cell is 0.1m (100mm); override from the prompt when stated.
Z is snapped along with X and Y by default, but per the conventions doc,
Z=0 is the floor, so the user often wants Z snapped to integer story
heights — ask if unclear.

## Examples

Prompt: "snap these walls to the nearest 100mm grid intersection"

```js
const cell = 0.1;
const snap = (p) => p.map((v) => Math.round(v / cell) * cell);
return walls.map((w) => {
  const c = bbox(w).center;
  const t = snap(c);
  return w.translate([t[0] - c[0], t[1] - c[1], t[2] - c[2]]);
});
```

Prompt: "align all selected to nearest 0.5m, XY only"

```js
const cell = 0.5;
return selected.map((s) => {
  const c = bbox(s).center;
  const dx = Math.round(c[0] / cell) * cell - c[0];
  const dy = Math.round(c[1] / cell) * cell - c[1];
  return s.translate([dx, dy, 0]);
});
```

## Failure modes

- Cell size of 0: division by zero — reject before emitting.
- Solid centroid coincides exactly with a grid intersection: the delta
  is `[0, 0, 0]` and the `translate` is a no-op. Acceptable; do not
  filter the solid out — downstream pipelines may rely on the
  position log.
- Rotated solids: rounding the centroid does not square the solid to
  the grid. If the user asks to "align rotation too", that's a
  separate skill (use `align-to-axis`).
- Z snapping with non-zero floor: per the conventions doc, Z=0 is the
  floor; snapping Z=0.05 to 0.1 lifts the floor 5cm. Ask first if Z is
  in scope.
