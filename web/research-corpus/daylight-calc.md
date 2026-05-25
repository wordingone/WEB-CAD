# Daylight calculations

Quick conventions for sizing daylighting in early-design prompts.
WEB-CAD doesn't run a full radiance / climate-based daylight
simulation — these are the rules-of-thumb the model emits when a
prompt mentions "daylight," "window," or "glazing."

## Window-to-wall ratio (WWR)

| Use case | Recommended WWR | Notes |
|---|---|---|
| Office | 30 - 40% | Above 40% drives cooling load; below 30% requires supplementary lighting. |
| Residential | 15 - 25% | Lower bound for thermal performance; bedroom egress code may force higher. |
| Classroom | 35 - 45% | Higher daylight target for visual tasks. |
| Warehouse | 5 - 10% | Daylight from clerestories, not vertical glazing. |

Default emission for unspecified residential: **WWR = 0.20** distributed
preferentially on south + east facades (climate-zone-4 northern hemisphere).

## Solar Heat Gain Coefficient (SHGC)

ASHRAE 90.1-2022 §5.5 sets the upper bound by climate zone:

- Zone 1-3 (hot): SHGC ≤ 0.25 (south), ≤ 0.40 (north).
- Zone 4-5 (mixed): SHGC ≤ 0.36 (south + west when PF < 0.5),
  ≤ 0.45 (north).
- Zone 6-8 (cold): SHGC unrestricted (≤ 0.55 typical), passive
  solar gain is desirable.

PF (projection factor) is the overhang depth divided by the height
from the window head to the bottom of the overhang. PF ≥ 0.5
relaxes the SHGC cap because a deep overhang shades direct summer sun.

## Daylight factor

Rule of thumb: **window head height divided by 2** approximates the
useful daylight depth into the room (in meters). A 2.4m-head window
lights 1.2m deep at 2% daylight factor.

For sidelighting >2.5m deep, supplement with clerestories or
top-lighting (skylights, monitor roofs).

## Glazing types

- **Clear single pane:** SHGC ~0.85, U ~5.5 W/m²K. Code-noncompliant
  except in unconditioned spaces.
- **Low-e double:** SHGC ~0.40, U ~1.7 W/m²K. Code baseline.
- **Triple-pane / argon:** SHGC ~0.30, U ~0.9 W/m²K. Passive house.
- **Spectrally selective low-e:** SHGC ~0.25, U ~1.6 W/m²K, VLT
  ~0.65. Decouples solar gain from light transmittance — what
  schools and offices want.

Default emission for unspecified residential exterior glazing:
**low-e double, SHGC=0.40, U=1.7.**

## See also

- `building-codes-101.md` for code-driven SHGC + WWR caps.
- `gable-roof.md` for gable-end glazing patterns.
- `wall-thickness.md` for window-jamb depths in thick walls.
