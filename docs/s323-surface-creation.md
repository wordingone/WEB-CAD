# S3 Surface Creation — Issue #323

Implementation of sub-issue #323 from umbrella #320 (Rhino-parity batch 1).

## Summary

Implements 6 TypeScript-side NURBS surface operations and analytic primitives:

- **SdNurbsSurfaceFromGrid** — build NURBS surface from control-point grid
- **SdNurbsSurfaceEvaluate** — evaluate surface point at (u, v)
- **SdNurbsSurfaceNormal** — compute surface normal at (u, v)
- **SdNurbsSurfaceDerivatives** — first/second derivatives (intrinsic curvature)
- **SdTorusSurface** — analytic torus of revolution
- **SdSumSurface** — sum/blend two surfaces (weighted envelope)

## Implementation Details

### Handler Location
- `web/src/handlers/s323-impl.ts` — 633 lines
- TypeScript-only; all C++ operations stubbed for future kernel rebuild

### Test Coverage
- `web/test/s323-parity.test.ts` — 645 lines
- 78 oracle assertions covering:
  - NURBS evaluation parity (de Boor algorithm vs oracle)
  - Torus parametric surface math
  - Surface blending envelope correctness
  - Normal vector consistency

### Schema Integration
- 6 entries in `web/src/commands/spatial-api.yaml`
- Handler registration in `web/src/register-handlers.ts`

## Blocked Operations (C++ dependency)

The following operations require kernel rebuild:
- **SdEdgeSurface** — ruled surface between two curves
- **SdNetworkSurface** — multi-curve network surface
- **SdTorusSurfaceExact** — torus as parametric BRep (vs tessellated mesh)
- **SdNurbsSurfaceDerivativesExact** — derivatives via rational BRep evaluation
- **SdTrimmedNurbsSurface** — surface with trimming curves and topology

## Verification

- `bun run verify` — typecheck, audit:stubs, audit:parity, audit:dispatch (all PASS)
- `bun test web/test/s323-parity.test.ts` — 78 assertions (all PASS)
- Schema validator / handler signature match: ✓
- Handler output consistency with unified mesh builder: ✓

## Related Issues

- Parent umbrella: #320
- Related S-clusters: S1–S14 (batch 1)
- Related infra: #319 (SSI boolean), #335 (wasmBooleanBackend), #337 (brep display)
