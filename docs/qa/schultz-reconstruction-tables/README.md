# Schultz Residence reconstruction parameter tables

Source: `web/public/samples/Schultz_Residence.ifc`
File length scale: 0.3048 (file unit → meters; FOOT)
Total architectural elements: **538** across 12 storeys

## Per-class totals

| class | count |
|---|---|
| IfcWall | 4 |
| IfcWallStandardCase | 101 |
| IfcSlab | 12 |
| IfcDoor | 17 |
| IfcWindow | 25 |
| IfcStair | 10 |
| IfcStairFlight | 2 |
| IfcColumn | 25 |
| IfcBeam | 83 |
| IfcRailing | 253 |
| IfcRoof | 3 |
| IfcSpace | 3 |

## Storeys (sorted by elevation, low → high)

| # | storey | elevation (m) | elements | file |
|---|---|---|---|---|
| 1 | P1 | -1.105 | 3 | [storey-01-p1.md](./storey-01-p1.md) |
| 2 | P2 | -0.597 | 1 | [storey-02-p2.md](./storey-02-p2.md) |
| 3 | Basement | 0.000 | 16 | [storey-03-basement.md](./storey-03-basement.md) |
| 4 | P4 | 0.419 | 41 | [storey-04-p4.md](./storey-04-p4.md) |
| 5 | 1st Floor | 1.003 | 55 | [storey-05-1st-floor.md](./storey-05-1st-floor.md) |
| 6 | P6 | 1.372 | 70 | [storey-06-p6.md](./storey-06-p6.md) |
| 7 | P7 | 1.829 | 14 | [storey-07-p7.md](./storey-07-p7.md) |
| 8 | 2nd Floor | 1.905 | 275 | [storey-08-2nd-floor.md](./storey-08-2nd-floor.md) |
| 9 | 3rd Floor | 4.496 | 48 | [storey-09-3rd-floor.md](./storey-09-3rd-floor.md) |
| 10 | Roof | 6.217 | 2 | [storey-10-roof.md](./storey-10-roof.md) |
| 11 | Roof_Garage | 6.782 | 1 | [storey-11-roof-garage.md](./storey-11-roof-garage.md) |
| 12 | Unassigned | n/a | 12 | [storey-12-unassigned.md](./storey-12-unassigned.md) |

## Per-storey class breakdown

| storey | IfcWall | IfcWallStandardCase | IfcSlab | IfcDoor | IfcWindow | IfcStair | IfcStairFlight | IfcColumn | IfcBeam | IfcRailing | IfcRoof | IfcSpace |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P1 | 0 | 2 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| P2 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Basement | 0 | 16 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| P4 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 1 | 37 | 0 | 0 | 0 |
| 1st Floor | 1 | 17 | 2 | 1 | 4 | 3 | 0 | 22 | 2 | 3 | 0 | 0 |
| P6 | 0 | 4 | 0 | 0 | 0 | 0 | 0 | 2 | 36 | 28 | 0 | 0 |
| P7 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 11 | 0 | 0 |
| 2nd Floor | 2 | 30 | 3 | 8 | 11 | 2 | 0 | 0 | 8 | 211 | 0 | 0 |
| 3rd Floor | 1 | 25 | 3 | 8 | 10 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| Roof | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| Roof_Garage | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| Unassigned | 0 | 0 | 3 | 0 | 0 | 4 | 2 | 0 | 0 | 0 | 0 | 3 |

## Reconstruction sequencing recommendation

Walk storeys low → high. Within a storey:

1. IfcBuildingStorey itself (set elevation in scene before placing elements)
2. IfcSlab (floor) — establishes the level surface
3. IfcWall + IfcWallStandardCase — walls reference slab + storey
4. IfcColumn + IfcBeam — structural members
5. IfcDoor + IfcWindow — hosted in walls; place after wall
6. IfcStair + IfcStairFlight — connect storeys (place after both ends exist)
7. IfcRailing — usually attached to stairs / balconies
8. IfcRoof — top storey only
9. IfcSpace — defined last (logical, not geometric)

After every storey, run:
```
bun scripts/qa/diff-ifc.ts <ref> <recon-export>.ifc --tolerance-mm 1
```

Look at the per-storey delta lines to spot drift early — don't wait until all 549 are placed.