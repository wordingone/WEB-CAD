# Building codes 101

What a model emitting parametric architecture needs to know about
building-code constraints in residential and small-commercial work.
This is reference material for early-design conversations, not
substitute for a licensed professional's code review.

## Setbacks

Most US residential zones (R-1, R-2) require:

- **Front setback:** 20 - 25 ft (6 - 7.5m) from the property line.
- **Side setback:** 5 - 15 ft (1.5 - 4.5m) per side, 10 ft each total.
- **Rear setback:** 20 - 30 ft (6 - 9m), increased to 25 - 35 ft when
  abutting another residential lot.

Boston's Article 32 (R-1): front 20 ft, side 10 ft each, rear 25 ft.
Height cap 35 ft (10.7m) without variance.

When a prompt says "house on a 60-foot-wide lot," the buildable
envelope is 60 - (10 + 10) = 40 ft wide max. Default emission limits
building width to lot width minus 6m total.

## Egress

Bedrooms require an egress window or door:

- **Window opening:** minimum 0.84 m² (5.7 sq ft) net clear opening,
  minimum 600mm clear height, 500mm clear width.
- **Sill height:** maximum 1118mm (44 in.) above finished floor.

Stairs:

- **Rise:** 178mm (7 in.) max, 102mm (4 in.) min.
- **Run:** 280mm (11 in.) min, 254mm (10 in.) min in some jurisdictions.
- **Width:** 914mm (36 in.) clear minimum for residential, 1118mm (44 in.)
  for assembly.
- **Headroom:** 2032mm (80 in.) minimum.

Default tier-1 emission for unspecified stair: rise=178, run=280,
width=914.

## Fire separation

- Single-family wood-frame: no rated assemblies required between
  rooms within the dwelling.
- Townhouse common wall (separation between two dwelling units):
  **2-hour rated** assembly required, typically two layers of
  Type-X gypsum each side of staggered-stud wall.
- Garage-to-house: **1-hour rated** wall + ceiling assembly,
  20-minute self-closing door.

## Energy code

ASHRAE 90.1-2022 (commercial) and IECC (residential) set envelope
performance:

- Climate zone 4: wall U ≤ 0.090, roof U ≤ 0.030.
- Climate zone 5: wall U ≤ 0.060, roof U ≤ 0.026.
- Climate zone 6: wall U ≤ 0.050, roof U ≤ 0.026.

These are translated to R-values in the field: zone 4 wall ~ R-20
cavity + R-7.5 continuous = R-27.5 nominal.

Air leakage (whole-building blower-door): ≤ 3 ACH50 baseline,
≤ 1.5 ACH50 high-performance, ≤ 0.6 ACH50 passive house.

## Accessibility

Residential type-B and townhouse units: ANSI A117.1 / Fair Housing.

- Door clear width: **815mm (32 in.)** minimum at any required door.
- Hallway width: **915mm (36 in.)** clear.
- Bathroom: **1525mm (60 in.)** turning radius in the accessible bath.

## See also

- `wall-thickness.md` for assemblies that meet the rated requirements
  above.
- `daylight-calc.md` for SHGC bounds tied to climate zones.
- `ifc4-schema-basics.md` for how rated assemblies could roundtrip as
  property sets (currently not emitted).
