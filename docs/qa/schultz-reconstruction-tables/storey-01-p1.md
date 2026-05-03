# P1 — storey #1

Elevation: -1.105m  ·  Elements: 3

## IfcWallStandardCase (2)

| id | name | x | y | z | dx | dy | dz |
|---|---|---|---|---|---|---|---|
| 573623 | Basic Wall:Retaining - 12" Concrete:1079974 | 4.216 | -1.729 | -0.469 | 1.619 | 0.155 | 0.093 |
| 573821 | Basic Wall:Retaining - 12" Concrete:1081039 | 3.453 | -1.729 | -1.377 | 0.093 | 0.155 | 1.723 |

## IfcStair (1)

| id | name | x | y | z | dx | dy | dz |
|---|---|---|---|---|---|---|---|
| 574103 | Assembled Stair:Stair:1081827 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |

---

All coordinates are in meters (file's native unit normalised via `IfcSIUnit`).
Bounding-box dx/dy/dz are world-axis-aligned (post-`COORDINATE_TO_ORIGIN`).

Phase-1 fields only. Phase-2 follow-up adds wall start/end axis,
door/window host_id + position-along-wall, profile cross-section, and material layers.