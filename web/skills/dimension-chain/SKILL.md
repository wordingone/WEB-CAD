---
name: dimension-chain
version: 0.1.0
description: Annotate selected edges with linear dimensions in a continuous chain.
keywords: [dimension, annotate, measure, label, chain, edge, length, callout]
examples:
  - "dimension these edges as a chain"
  - "annotate the lengths of the selected walls"
  - "add a continuous dimension line along the south facade"
eval_id: skill-dimension-chain-v01
---

## When to use

The prompt asks for measurement annotations on a selection of edges,
arranged head-to-tail along a single direction (a "dimension chain"
in drafting parlance). Typical phrases: "dimension these edges",
"annotate the lengths", "add a chain dimension along the south wall".

Do NOT pick this skill for:
- a single dimension on an edge (use the simpler `dimension-edge` skill —
  not yet shipped),
- ordinate dimensions from a fixed datum (different convention),
- 3D / sloped dimensions (this skill is XY only).

## How it works

Dimensioning is a non-geometric annotation layer — it does not modify
the replicad solid. Instead, the skill emits a structured
`DimensionChain` object the renderer overlays on the canvas.

The replicad-side helper computes edge lengths from the host solid's
face graph; the chain records cumulative offsets so the renderer can
draw a single continuous dimension line.

```js
// edges = array of {start: [x,y], end: [x,y]} in world space.
// `direction` is the chain axis; segments are projected onto it.
const dim = dimensionChain({
  edges,
  direction: [1, 0],         // chain runs along +X
  offset_y: -0.5,             // dimension line 0.5m south of edges
  units: "m",
});
return { solid: existing, annotations: [dim] };
```

The `dimensionChain` helper is a renderer-side primitive (not a
replicad op). Skills that need geometric output should NOT mutate
the solid — they emit annotations on the side channel.

## Examples

Prompt: "dimension these three wall edges as a chain along the south facade"

```js
return {
  annotations: [
    dimensionChain({
      edges: selectedEdges,
      direction: [1, 0],
      offset_y: -0.6,
      units: "m",
    }),
  ],
};
```

Prompt: "annotate the lengths of the selected edges in millimeters"

```js
return {
  annotations: [
    dimensionChain({
      edges: selectedEdges,
      direction: chainAxis(selectedEdges),  // auto-detect from edge directions
      offset_y: -0.5,
      units: "mm",
    }),
  ],
};
```

## Failure modes

- Edges not collinear: the chain projects each segment onto the
  `direction` vector, so non-collinear edges will visibly mis-align.
  Detect with a tolerance check (`abs(cross(e, direction)) < epsilon`
  per edge) and warn.
- Empty selection: no edges to dimension — return an empty
  `annotations` array instead of erroring; the UI handles it.
- Mixed units in the prompt ("dimension in m and mm"): pick one and
  flag the conflict; do not silently convert.
- 3D edges: project to XY by default; if the edge has non-trivial Z
  span, warn — the user probably wanted ordinate or 3D dimensioning.
