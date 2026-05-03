---
name: room-from-prompt
version: 0.1.0
description: Emit four walls, a slab, and a single door for a footprint specification.
keywords: [room, four-walls, slab, floor, door, footprint, enclosure, space]
examples:
  - "make a 5x4 room with a door on the south side"
  - "create a 6m by 4m room, 3m tall, with one door"
  - "build a small office, 4 by 3.5 meters"
eval_id: skill-room-from-prompt-v01
---

## When to use

The prompt asks for a complete enclosed room from a textual spec:
dimensions, optional height, optional door. Typical phrases: "make a 5×4
room", "build a 4m by 3m office", "create a 5×4×3 room with a door".

Do NOT pick this skill for:
- editing an existing room (the four-wall recipe is whole-room only),
- multi-room layouts (run this skill per room, then `fuse` floors and walls
  manually — better handled by a higher-level layout skill),
- non-rectangular footprints (use `extrude-walls` directly with a
  polyline).

## How it works

The skill emits the canonical four-walled room recipe from
`docs/tier1-conventions.md`, using `makeBox` (centered XY, base-at-origin
in Z) for each wall and the slab. Wall offsets correctly account for wall
thickness so the *interior* footprint matches the requested dimensions.

```js
const W = 5, D = 4, H = 3, T = 0.2, SLAB_T = 0.15;
const slab = makeBox(W, D, SLAB_T).translate([0, 0, -SLAB_T]);
const wallS = makeBox(W, T, H).translate([0, -D/2 + T/2, 0]);
const wallN = makeBox(W, T, H).translate([0,  D/2 - T/2, 0]);
const wallW = makeBox(T, D - 2*T, H).translate([-W/2 + T/2, 0, 0]);
const wallE = makeBox(T, D - 2*T, H).translate([ W/2 - T/2, 0, 0]);

// Optional door on the south wall.
const door = makeBox(0.9, T, 2.1).translate([0, -D/2 + T/2, 0]);
const wallSwithDoor = wallS.cut(door);

return slab
  .fuse(wallSwithDoor)
  .fuse(wallN)
  .fuse(wallW)
  .fuse(wallE);
```

The slab Z-translate `-SLAB_T` is intentional: it puts the slab top face at
z=0 so the walls (base-at-origin) sit on top of it. This is the same
"floor at z=0" convention the rest of the conventions doc relies on.

## Examples

Prompt: "make a 5x4 room with a door on the south side, 3m tall"

```js
const W = 5, D = 4, H = 3, T = 0.2, ST = 0.15;
const slab = makeBox(W, D, ST).translate([0, 0, -ST]);
const south = makeBox(W, T, H).translate([0, -D/2 + T/2, 0]);
const north = makeBox(W, T, H).translate([0,  D/2 - T/2, 0]);
const west  = makeBox(T, D - 2*T, H).translate([-W/2 + T/2, 0, 0]);
const east  = makeBox(T, D - 2*T, H).translate([ W/2 - T/2, 0, 0]);
const door  = makeBox(0.9, T, 2.1).translate([0, -D/2 + T/2, 0]);
return slab.fuse(south.cut(door)).fuse(north).fuse(west).fuse(east);
```

Prompt: "create a 4m by 3.5m office, 2.7m tall, no door"

```js
const W = 4, D = 3.5, H = 2.7, T = 0.2, ST = 0.15;
const slab = makeBox(W, D, ST).translate([0, 0, -ST]);
return slab
  .fuse(makeBox(W, T, H).translate([0, -D/2 + T/2, 0]))
  .fuse(makeBox(W, T, H).translate([0,  D/2 - T/2, 0]))
  .fuse(makeBox(T, D - 2*T, H).translate([-W/2 + T/2, 0, 0]))
  .fuse(makeBox(T, D - 2*T, H).translate([ W/2 - T/2, 0, 0]));
```

## Failure modes

- Wall-thickness drift: known issue from the v2 LoRA self-harness — the
  bounding-box of the four-walled room is sometimes a wall-thickness wider
  than the spec calls for. Match the recipe above EXACTLY (T/2 offsets, not
  T offsets) to avoid it.
- Door positioned past the wall corner: clamp the door so it stays at least
  `T` away from each wall end — otherwise the cut produces a wall split.
- Negative dimensions: reject with a clear error before emitting.
- Slab Z-translate omission: produces a "building 0.5m below grade" failure
  per the conventions doc — make sure the slab is at z=[-ST, 0], not
  [0, ST].
