---
name: stair-from-points
version: 0.1.0
description: Generate a straight-run stair between two clicked points at different heights.
keywords: [stair, stairs, staircase, steps, riser, tread, climb, points, between]
examples:
  - "make a stair from this point to that point"
  - "generate stairs between these two clicked positions"
  - "build a 12-tread staircase climbing 3m here"
eval_id: skill-stair-from-points-v01
---

## When to use

The prompt asks for a stair between two world-space anchor points (start
and end). Typical phrases: "stair from A to B", "stairs between these
points", "build a staircase climbing 3m here". The skill picks tread/riser
counts to match the rise/run with sensible building-code defaults
(riser ≤ 0.18m, tread ≥ 0.25m) unless overridden.

Do NOT pick this skill for:
- spiral stairs (separate skill),
- stairs with an L-shape or landing (compose two straight stairs and
  fuse with `align-to-grid`),
- ramps (no risers — different skill).

## How it works

The skill emits a stack of `makeBox` solids, one per tread, fused into a
single Compound. Each tread sits at the correct (x, y, z) per the rise
and run. Per `docs/tier1-conventions.md`, `makeBox` is base-at-origin in
Z, so each tread's z-translate is the cumulative rise from the start
point.

```js
const startP = [x0, y0, z0];
const endP   = [x1, y1, z1];
const totalRise = endP[2] - startP[2];
const horizontalRun = Math.hypot(endP[0] - startP[0], endP[1] - startP[1]);

// Building-code defaults: 0.18m riser max, 0.25m tread min.
const N = Math.ceil(totalRise / 0.18);
const riser = totalRise / N;
const tread = horizontalRun / N;

const dirX = (endP[0] - startP[0]) / horizontalRun;
const dirY = (endP[1] - startP[1]) / horizontalRun;
const width = 1.0;     // 1m default tread width

let stair = null;
for (let i = 0; i < N; i++) {
  const t = makeBox(tread, width, riser * (i + 1))
    .translate([
      startP[0] + dirX * tread * (i + 0.5),
      startP[1] + dirY * tread * (i + 0.5),
      startP[2],
    ]);
  stair = stair ? stair.fuse(t) : t;
}
return stair;
```

Each tread is a column rising from `startP[2]` to `startP[2] + riser*(i+1)`,
so the front face of step `i+1` sits flush against the back face of step
`i`.

## Examples

Prompt: "make a straight stair from (0,0,0) to (4, 0, 3) — 12 treads"

```js
const N = 12, riser = 3 / N, tread = 4 / N, width = 1.0;
let stair = null;
for (let i = 0; i < N; i++) {
  const t = makeBox(tread, width, riser * (i + 1))
    .translate([tread * (i + 0.5), 0, 0]);
  stair = stair ? stair.fuse(t) : t;
}
return stair;
```

Prompt: "stairs between these two points climbing 2.7m, default proportions"

```js
const startP = [0, 0, 0], endP = [3.6, 0, 2.7];
const N = Math.ceil((endP[2] - startP[2]) / 0.18);
const riser = (endP[2] - startP[2]) / N;
const tread = Math.hypot(endP[0] - startP[0], endP[1] - startP[1]) / N;
let stair = null;
for (let i = 0; i < N; i++) {
  const t = makeBox(tread, 1.0, riser * (i + 1))
    .translate([tread * (i + 0.5), 0, 0]);
  stair = stair ? stair.fuse(t) : t;
}
return stair;
```

## Failure modes

- Endpoints at the same Z: zero rise — no stair needed; emit a clear error
  rather than a degenerate `N=0` loop.
- Slope too steep (rise/run > 1): the riser-cap of 0.18m makes the
  staircase very long horizontally; warn the user that an alternative
  (ladder, ramp) may be more appropriate.
- Non-axis-aligned run: the example uses `dirX/dirY` to project; this is
  correct for any direction in XY. Verify the projection produces real
  numbers (no division by zero when the points are vertically stacked).
- Tread width default: 1m fits a single-occupancy stair; widen to 1.2m
  for accessibility-compliant runs (call out in the prompt; don't pick
  silently).
