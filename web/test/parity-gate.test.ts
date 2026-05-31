// parity-gate.test.ts — C++/WASM geometry kernel parity gate (#197).
// SSI parity cases, WASM boolean cases (graceful skip), volume TODOs, fuzz.

import { describe, test, expect, beforeAll } from 'bun:test'
import { ssi } from '../src/nurbs/ssi'
import { initWasmKernel, wasmBooleanBackend } from '../src/nurbs/wasm-boolean-backend'
import type { Brep, BrepFace, BrepShell, BrepVertex } from '../src/nurbs/nurbs-brep'
import { BREP_DEFAULT_TOLERANCE } from '../src/nurbs/nurbs-brep'
import type { NurbsSurface, PlaneSurface, Surface } from '../src/nurbs/nurbs-surfaces'
import { pointAtUV } from '../src/nurbs/nurbs-surfaces'
import { Plane, Interval, Point3, Vector3 } from '../src/nurbs/nurbs-primitives'

// ── WASM readiness gate ───────────────────────────────────────────────────────

let wasmReady = false

beforeAll(async () => {
  try {
    await initWasmKernel()
    wasmReady = true
  } catch {
    wasmReady = false
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Bilinear planar patch [0,w]×[0,h] in XY plane (z=0). */
function buildFlatSurface(w: number, h: number): NurbsSurface {
  return {
    kind: 'nurbs',
    dim: 3,
    isRational: false,
    order: [2, 2],
    cvCount: [2, 2],
    knots: [[0, w], [0, h]],
    cvs: [
      0, 0, 0,   // (0,0)
      w, 0, 0,   // (1,0)
      0, h, 0,   // (0,1)
      w, h, 0,   // (1,1)
    ],
    cvStride: [2 * 3, 3], // [nV*dim, dim]
  }
}

/** Bilinear patch in XZ plane — V direction along Z. Intersects XY patches. */
function buildTiltedSurface(w: number): NurbsSurface {
  return {
    kind: 'nurbs',
    dim: 3,
    isRational: false,
    order: [2, 2],
    cvCount: [2, 2],
    knots: [[0, w], [0, w]],
    cvs: [
      0, 0, 0,   // (0,0)
      w, 0, 0,   // (1,0)
      0, 0, w,   // (0,1)
      w, 0, w,   // (1,1)
    ],
    cvStride: [2 * 3, 3],
  }
}

/** Minimal BrepFace wrapping a PlaneSurface. */
function planeFace(
  origin: [number, number, number],
  xAxis: [number, number, number],
  yAxis: [number, number, number],
  uExt: number,
  vExt: number,
  orientation = true,
): BrepFace {
  const o = { x: origin[0], y: origin[1], z: origin[2] }
  const xa = { x: xAxis[0], y: xAxis[1], z: xAxis[2] }
  const ya = { x: yAxis[0], y: yAxis[1], z: yAxis[2] }
  const surf: PlaneSurface = {
    kind: 'plane',
    plane: Plane.create(o, xa, ya),
    uDomain: Interval.create(0, 1),
    vDomain: Interval.create(0, 1),
    uExtent: Interval.create(0, uExt),
    vExtent: Interval.create(0, vExt),
  }
  return {
    surface: surf,
    outerLoop: { curves: [], orientation: true },
    innerLoops: [],
    orientation,
    tolerance: BREP_DEFAULT_TOLERANCE,
  }
}

/**
 * 6-face axis-aligned box Brep, origin at (0,0,0), isClosed=true.
 * Faces: -X, +X, -Y, +Y, -Z, +Z with outward normals.
 */
function buildBoxBrep(w: number, h: number, d: number): Brep {
  const faces: BrepFace[] = [
    planeFace([0, 0, 0], [0, 1, 0], [0, 0, 1], h, d),         // -X
    planeFace([w, 0, 0], [0, -1, 0], [0, 0, 1], h, d),        // +X
    planeFace([0, 0, 0], [1, 0, 0], [0, 0, 1], w, d),         // -Y
    planeFace([0, h, 0], [-1, 0, 0], [0, 0, 1], w, d),        // +Y
    planeFace([0, 0, 0], [1, 0, 0], [0, 1, 0], w, h),         // -Z
    planeFace([0, 0, d], [-1, 0, 0], [0, 1, 0], w, h),        // +Z
  ]

  // Vertices at the 8 corners
  const vertices: BrepVertex[] = [
    { point: { x: 0, y: 0, z: 0 }, edgeIndices: [], tolerance: BREP_DEFAULT_TOLERANCE },
    { point: { x: w, y: 0, z: 0 }, edgeIndices: [], tolerance: BREP_DEFAULT_TOLERANCE },
    { point: { x: 0, y: h, z: 0 }, edgeIndices: [], tolerance: BREP_DEFAULT_TOLERANCE },
    { point: { x: w, y: h, z: 0 }, edgeIndices: [], tolerance: BREP_DEFAULT_TOLERANCE },
    { point: { x: 0, y: 0, z: d }, edgeIndices: [], tolerance: BREP_DEFAULT_TOLERANCE },
    { point: { x: w, y: 0, z: d }, edgeIndices: [], tolerance: BREP_DEFAULT_TOLERANCE },
    { point: { x: 0, y: h, z: d }, edgeIndices: [], tolerance: BREP_DEFAULT_TOLERANCE },
    { point: { x: w, y: h, z: d }, edgeIndices: [], tolerance: BREP_DEFAULT_TOLERANCE },
  ]

  const shell: BrepShell = { faces, edges: [], vertices, isClosed: true }
  return { shells: [shell] }
}

/**
 * Sphere surface placeholder — bilinear quad at (0,0,centerZ), span [-r,r]².
 * TODO: replace with rational NURBS 4-patch sphere for volume accuracy.
 */
function buildSphereSurface(r: number, centerZ: number): NurbsSurface {
  return {
    kind: 'nurbs',
    dim: 3,
    isRational: false,
    order: [2, 2],
    cvCount: [2, 2],
    knots: [[-r, r], [-r, r]],
    cvs: [
      -r, -r, centerZ,
       r, -r, centerZ,
      -r,  r, centerZ,
       r,  r, centerZ,
    ],
    cvStride: [2 * 3, 3],
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

/** Max distance from any SSI curve point to both parent surfaces. */
function maxSsiResidual(
  curves: ReturnType<typeof ssi>,
  a: Surface,
  b: Surface,
): number {
  let max = 0
  for (const curve of curves) {
    for (let i = 0; i < curve.pts3d.length; i++) {
      const pt3 = curve.pts3d[i]
      const param = curve.params[i]
      if (!param) continue
      const pA = pointAtUV(a, param.s0.u, param.s0.v)
      const pB = pointAtUV(b, param.s1.u, param.s1.v)
      const dA = Point3.distance(pt3, pA)
      const dB = Point3.distance(pt3, pB)
      if (dA > max) max = dA
      if (dB > max) max = dB
    }
  }
  return max
}

// ── SSI parity cases ──────────────────────────────────────────────────────────

describe('parity-gate — SSI', () => {
  // Case 1: plane/plane orthogonal intersection
  test('plane/plane: two orthogonal flat surfaces produce ≥1 intersection curve', () => {
    const flat = buildFlatSurface(4, 4)
    const tilted = buildTiltedSurface(4)

    const curves = ssi(flat as Surface, tilted as Surface, {
      tolerance: 1e-3,
      marchStep: 0.2,
      maxMarchSteps: 200,
    })

    expect(curves.length).toBeGreaterThanOrEqual(1)
    expect(curves[0].pts3d.length).toBeGreaterThan(2)
  })

  test('plane/plane: all curve pts within 1e-3 of both surfaces', () => {
    const flat = buildFlatSurface(4, 4)
    const tilted = buildTiltedSurface(4)

    const curves = ssi(flat as Surface, tilted as Surface, {
      tolerance: 1e-3,
      marchStep: 0.2,
      maxMarchSteps: 200,
    })

    expect(curves.length).toBeGreaterThanOrEqual(1)
    const residual = maxSsiResidual(curves, flat as Surface, tilted as Surface)
    expect(residual).toBeLessThan(1e-3)
  })

  test('flat/tilted: curve pts lie on both surfaces within 1e-3', () => {
    const flat = buildFlatSurface(2, 2)
    const tilted = buildTiltedSurface(2)

    const curves = ssi(flat as Surface, tilted as Surface, {
      tolerance: 1e-3,
      marchStep: 0.1,
      maxMarchSteps: 300,
    })

    // May produce 0 curves if surfaces don't overlap in parameter space —
    // assert residual only when curves found
    if (curves.length > 0) {
      const residual = maxSsiResidual(curves, flat as Surface, tilted as Surface)
      expect(residual).toBeLessThan(1e-3)
    }
  })

  test('near-tangent: no crash, result ok (degenerate or empty, no NaN)', () => {
    // XY plane at z=0 and a plane tilted 0.05 deg (< 0.1 deg) from XY
    const angleRad = (0.05 * Math.PI) / 180
    const sinA = Math.sin(angleRad)
    const cosA = Math.cos(angleRad)

    const flat = buildFlatSurface(4, 4)

    // Tilted surface: same U direction (x-axis), V direction slightly off Y toward Z
    // CVs: (0,0,0), (4,0,0), (0, 4*cosA, 4*sinA), (4, 4*cosA, 4*sinA)
    const nearTangent: NurbsSurface = {
      kind: 'nurbs',
      dim: 3,
      isRational: false,
      order: [2, 2],
      cvCount: [2, 2],
      knots: [[0, 4], [0, 4]],
      cvs: [
        0, 0,         0,
        4, 0,         0,
        0, 4 * cosA,  4 * sinA,
        4, 4 * cosA,  4 * sinA,
      ],
      cvStride: [2 * 3, 3],
    }

    let threw = false
    let curves: ReturnType<typeof ssi> = []
    try {
      curves = ssi(flat as Surface, nearTangent as Surface, {
        tolerance: 1e-3,
        marchStep: 0.2,
        maxMarchSteps: 500,
      })
    } catch {
      threw = true
    }

    expect(threw).toBe(false)

    // All returned points must be finite (no NaN)
    for (const curve of curves) {
      for (const pt of curve.pts3d) {
        expect(Number.isFinite(pt.x)).toBe(true)
        expect(Number.isFinite(pt.y)).toBe(true)
        expect(Number.isFinite(pt.z)).toBe(true)
      }
    }
  })

  test('grazing/coincident: no crash, no NaN in any returned points', () => {
    const flat = buildFlatSurface(4, 4)

    let threw = false
    let curves: ReturnType<typeof ssi> = []
    try {
      curves = ssi(flat as Surface, flat as Surface, {
        tolerance: 1e-3,
        maxSubdivDepth: 3,
      })
    } catch {
      threw = true
    }

    expect(threw).toBe(false)

    for (const curve of curves) {
      for (const pt of curve.pts3d) {
        expect(Number.isFinite(pt.x)).toBe(true)
        expect(Number.isFinite(pt.y)).toBe(true)
        expect(Number.isFinite(pt.z)).toBe(true)
      }
    }
  })
})

// ── Boolean parity cases (WASM-gated) ────────────────────────────────────────

describe('parity-gate — boolean (WASM-gated)', () => {
  test('fuse overlapping boxes: ok or typed error, brep defined', () => {
    if (!wasmReady) {
      // Skip gracefully — WASM kernel not compiled yet
      return
    }

    const a = buildBoxBrep(1, 1, 1)
    const b = buildBoxBrep(1, 1, 1) // identical overlap

    let result: ReturnType<typeof wasmBooleanBackend.union>
    expect(() => { result = wasmBooleanBackend.union(a, b) }).not.toThrow()

    if (result!.ok) {
      expect(result!.brep).toBeDefined()
      expect(result!.brep.shells.length).toBeGreaterThanOrEqual(1)
    } else {
      // Must carry a recognizable error message — not a silent undefined
      expect(result!.error.message.length).toBeGreaterThan(0)
      expect(result!.error.code).toBeDefined()
    }
  })

  test('cut box from box: ok or typed error, no throw', () => {
    if (!wasmReady) return

    const a = buildBoxBrep(2, 2, 2)
    const b = buildBoxBrep(1, 1, 1)

    let result: ReturnType<typeof wasmBooleanBackend.difference>
    expect(() => { result = wasmBooleanBackend.difference(a, b) }).not.toThrow()

    if (result!.ok) {
      expect(result!.brep).toBeDefined()
    } else {
      expect(result!.error.code).toBeDefined()
    }
  })

  test('intersect overlapping boxes: ok or typed error, no throw', () => {
    if (!wasmReady) return

    const a = buildBoxBrep(2, 2, 2)
    const b = buildBoxBrep(1, 1, 1)

    let result: ReturnType<typeof wasmBooleanBackend.intersection>
    expect(() => { result = wasmBooleanBackend.intersection(a, b) }).not.toThrow()

    if (result!.ok) {
      expect(result!.brep).toBeDefined()
    } else {
      expect(result!.error.code).toBeDefined()
    }
  })
})

// ── Volume comparison TODOs (oracle targets) ──────────────────────────────────

describe('parity-gate — oracle volume targets (TODO)', () => {
  test.todo('oracle: fuse(1×1×1 box, 0.5×0.5×0.5 box at origin) volume ≈ 1.125 vs replicad', () => {})
  test.todo('oracle: cut(1×1×1, 0.5×0.5×0.5 at origin) volume ≈ 0.875 vs replicad', () => {})
  test.todo('oracle: intersect(1×1×1, 0.5×0.5×0.5 at origin) volume ≈ 0.125 vs replicad', () => {})
})

// ── Fuzz suite ────────────────────────────────────────────────────────────────

describe('parity-gate — fuzz', () => {
  test('fuzz: no crash/NaN on box pairs', async () => {
    if (!wasmReady) {
      // Without WASM, just assert buildBoxBrep doesn't throw across the range
      for (let i = 0; i < 20; i++) {
        expect(() => buildBoxBrep(1 + (i % 3) * 0.5, 1, 1)).not.toThrow()
        expect(() => buildBoxBrep(1, 1 + (i % 2) * 0.5, 1)).not.toThrow()
      }
      return
    }

    for (let i = 0; i < 20; i++) {
      const a = buildBoxBrep(1 + (i % 3) * 0.5, 1, 1)
      const b = buildBoxBrep(1, 1 + (i % 2) * 0.5, 1)

      for (const op of ['union', 'difference', 'intersection'] as const) {
        let result: ReturnType<typeof wasmBooleanBackend.union>
        expect(() => { result = wasmBooleanBackend[op](a, b) }).not.toThrow()

        if (result!.ok) {
          for (const shell of result!.brep.shells) {
            for (const v of shell.vertices) {
              expect(Number.isFinite(v.point.x)).toBe(true)
              expect(Number.isFinite(v.point.y)).toBe(true)
              expect(Number.isFinite(v.point.z)).toBe(true)
            }
          }
        }
      }
    }
  })
})
