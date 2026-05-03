---
name: mirror-across-axis
version: 0.1.0
description: Duplicate a selection across the construction plane's mirror axis.
keywords: [mirror, reflect, duplicate, symmetric, axis, flip, copy, cplane]
examples:
  - "mirror this across the cplane"
  - "reflect the selection over the X axis"
  - "make a symmetric copy across the Y axis"
eval_id: skill-mirror-across-axis-v01
---

## When to use

The prompt asks for a symmetric duplicate of a selection about a named
axis or the construction plane (cplane). Typical phrases: "mirror these
across the X axis", "reflect this", "make a symmetric copy on the other
side of cplane".

Do NOT pick this skill for:
- arrays or repetitions on a grid (use `linear-array` — TBD),
- radial mirrors / rotational symmetry (use `radial-array`),
- mirroring just the geometry without keeping the original (use
  `flip-in-place` — TBD).

## How it works

Replicad's `Solid` does not ship a `mirror` op directly; the canonical
recipe in `docs/tier1-conventions.md` is to `rotate(180°)` around the
mirror axis through a point on the plane, which produces a 2-fold
symmetric copy. For a Y-axis mirror through the origin, that is
`rotate(180, [0,0,0], [0,1,0])`. Then `fuse` to keep both copies.

```js
// Mirror across the YZ plane (i.e., flip X). The mirror axis is Y, so
// rotate 180° around Y through the origin.
const mirrored = original.clone().rotate(180, [0, 0, 0], [0, 1, 0]);
return original.fuse(mirrored);
```

For the XZ plane (flip Y), rotate around X:

```js
const mirrored = original.clone().rotate(180, [0, 0, 0], [1, 0, 0]);
return original.fuse(mirrored);
```

Per the conventions doc's `rotate` notes: angle is in **degrees**, default
position is `[0,0,0]`, and translate-then-rotate rotates the translated
position — so for an off-origin solid, factor the translation out, mirror,
translate the mirrored copy to the symmetric position.

## Examples

Prompt: "mirror this wall across the X axis"

```js
const mirrored = wall.clone().rotate(180, [0, 0, 0], [1, 0, 0]);
return wall.fuse(mirrored);
```

Prompt: "make a symmetric copy of this room across the cplane Y axis"

```js
const mirrored = room.clone().rotate(180, [0, 0, 0], [0, 1, 0]);
return room.fuse(mirrored);
```

Prompt: "reflect the column across the X axis through the point (2, 0, 0)"

```js
const mirrored = column.clone().rotate(180, [2, 0, 0], [1, 0, 0]);
return column.fuse(mirrored);
```

## Failure modes

- Mirroring across an axis the solid already straddles: the result is
  a 2x-fused copy of (most of) the original solid in the same place.
  Detect by checking the solid's bbox against the mirror plane;
  warn the user.
- `clone` not available: replicad's API is mutating in some versions;
  if `clone()` is missing, re-emit the source construction sequence
  to get a second instance. Document the version-skew check.
- Rotate-after-translate ambiguity: per the conventions doc, the order
  matters. If the source solid was already translated, the mirror
  through the origin will not be the symmetric position. Either rotate
  first, then translate, or use a custom `position` argument to
  `rotate`.
- Fuse of two coincident solids: produces a single solid, not a
  Compound. Acceptable, but note in any selection-tracking log.
