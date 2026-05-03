# Wall thickness conventions

Common wall thickness ranges in real-world architecture and the
parametric defaults gemma-architect emits when the natural-language
prompt doesn't specify thickness.

## Partition walls

Interior non-load-bearing partitions: **minimum 100mm** (~4 in.) for
metal-stud + double-layer gypsum, **150mm** for plumbing-wet walls
that need to host vertical drains. Below 100mm the wall cannot host
standard outlet boxes and is acoustically transparent.

Default emission: `wall ... thickness=0.1` for "interior partition,"
`thickness=0.15` for "wet wall" or "plumbing wall."

## Load-bearing walls

Concrete masonry unit (CMU): **190mm or 290mm** nominal (8 in. /
12 in.). Cast-in-place reinforced concrete: **200mm minimum** for
single-curtain rebar, **300mm** for double-curtain.

Wood-stud bearing wall: **150mm** (6 in. nominal) including double
layer of gypsum. **240mm** for two-layer staggered-stud assemblies
that achieve STC 60+.

Default emission: `thickness=0.2` for unspecified bearing walls,
`thickness=0.3` for "thick concrete wall" or "fortress wall."

## Exterior walls

Wood-frame with cavity insulation + continuous exterior insulation +
cladding: **280mm to 350mm** total. Mass walls (CMU + ext. ci.):
**340mm to 400mm**. Passive-house double-stud: **400mm to 500mm**.

Default emission: `thickness=0.3` for "exterior wall" (matches the
median of code-compliant climate-zone-4 walls).

## Why the asymmetry matters

In gemma-architect's tier-1 DSL, `wall (a) (b) thickness=t` produces
a wall whose centerline runs from `a` to `b` and whose thickness
is split symmetrically. So `thickness=0.2` means 0.1m to either side
of the centerline. When walls meet at a T-junction the second wall's
centerline must offset by the **inner-face** of the first (`thickness/2`).

This asymmetry is the single most common source of "wall-stubs visible
in the model" errors when a prompt says "two walls forming an L"
without specifying the offset.

## See also

- `tier1-conventions.md` for the full T-junction recipe.
- `gable-roof.md` for how wall thickness affects ridge-board geometry.
