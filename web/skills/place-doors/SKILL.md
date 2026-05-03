---
name: place-doors
version: 0.1.0
description: Insert a door at a clicked wall position by cutting an opening and placing a frame.
keywords: [door, opening, doorway, wall, cut, insert, frame, clicked]
examples:
  - "put a door at this point on the wall"
  - "insert a 900mm door here"
  - "cut a doorway 2.1m tall in this wall"
eval_id: skill-place-doors-v01
---

## When to use

The prompt names a host wall (existing solid) and a position where a door
should appear. Typical phrases: "place a door here", "cut a doorway in this
wall", "insert a 900mm × 2.1m door at the clicked point".

Do NOT pick this skill for:
- generating a wall from scratch (use `extrude-walls`),
- emitting a full room with door openings (use `room-from-prompt` — it
  delegates here per door),
- placing windows (a future `place-windows` skill — for now reject and ask).

## How it works

The skill emits a Tier 1 boolean cut against the host wall solid. Per
`docs/tier1-conventions.md`, the door opening is itself a base-at-origin
`makeBox` so its sill sits naturally at z=0 (floor); no Z-translate needed.
The frame is an optional thin solid offset around the cut.

```js
// host wall is a Solid named `wall` already in scope.
const door = makeBox(door_w, wall_t, door_h)
  .translate([cx, 0, 0]);             // cx = clicked X relative to wall centerline
const wallWithDoor = wall.cut(door);
```

If the wall runs along Y instead of X, swap the door-box dimensions:

```js
const door = makeBox(wall_t, door_w, door_h).translate([0, cy, 0]);
```

The frame (optional, when the prompt mentions one) is a thin shell around
the cut; emit it as a second solid `fuse`d back in:

```js
const frame = makeBox(door_w + 2*F, wall_t, door_h + F).cut(door);
const result = wallWithDoor.fuse(frame);
```

## Examples

Prompt: "place a 900mm wide, 2.1m tall door at the centerline of this wall"

```js
// wall = previously-extruded wall solid
const door = makeBox(0.9, 0.2, 2.1);
return wall.cut(door);
```

Prompt: "cut a doorway 800mm wide here, 2m tall, 1.2m from the left end of a 5m wall"

```js
// wall is 5m along X, 0.2m thick in Y, 3m tall.
const door_w = 0.8, door_h = 2.0;
const offset_x = 1.2 + door_w / 2 - 5 / 2;   // wall is centered, so re-base to its midpoint
const door = makeBox(door_w, 0.2, door_h).translate([offset_x, 0, 0]);
return wall.cut(door);
```

## Failure modes

- Door taller than wall: cut succeeds but leaves a roofless gap. Validate
  `door_h <= wall_h` before emitting.
- Door extends past wall ends: the cut still works but produces a wall split
  in two — usually not what the user wants. Clamp `cx` to keep the door
  fully inside the wall.
- Wall solid is a `Compound` (already fused with another wall): cut still
  works but the result is a Compound. Document this for downstream IFC
  builder per the `fuse and Compound` note in tier1-conventions.
- Floor offset wrong: per the conventions doc, the door box's natural
  z=[0, door_h] is correct (sill at floor); do NOT translate up.
