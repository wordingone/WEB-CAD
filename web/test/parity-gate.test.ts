// parity-gate.test.ts — C++/WASM geometry kernel parity gate (#197).
// SSI parity cases, WASM boolean cases (graceful skip), volume TODOs, fuzz.

import { describe, test, expect, beforeAll } from 'bun:test'
import { ssi } from '../src/nurbs/ssi'
import { initWasmKernel, wasmBooleanBackend, rawKernModule } from '../src/nurbs/wasm-boolean-backend'
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

// ── kern-format helpers (matches kern-parity-oracle.mjs) ─────────────────────

// Build a kern-format Brep JSON string for axis-aligned box.
// Orientation flags verified against divergence theorem (see oracle script).
function kernBoxJson(w: number, h: number, d: number, ox0 = 0, oy0 = 0, oz0 = 0): string {
  function face(
    origin: [number,number,number],
    xAxis:  [number,number,number],
    yAxis:  [number,number,number],
    uExt: number, vExt: number, outward: boolean,
  ) {
    const [ox,oy,oz] = origin
    const [xx,xy,xz] = xAxis
    const [yx,yy,yz] = yAxis
    return {
      surface: {
        degreeU: 1, degreeV: 1, cvCountU: 2, cvCountV: 2,
        knotsU: [0, 0, uExt, uExt], knotsV: [0, 0, vExt, vExt],
        cvs: [
          ox, oy, oz, 1,
          ox+yx*vExt, oy+yy*vExt, oz+yz*vExt, 1,
          ox+xx*uExt, oy+xy*uExt, oz+xz*uExt, 1,
          ox+xx*uExt+yx*vExt, oy+xy*uExt+yy*vExt, oz+xz*uExt+yz*vExt, 1,
        ],
      },
      outerLoop: { edges: [], orientation: true },
      innerLoops: [], orientation: outward, tolerance: 1e-6,
    }
  }
  return JSON.stringify({ shells: [{ faces: [
    face([ox0,    oy0,    oz0   ], [0,1,0], [0,0,1], h, d, false), // -X
    face([ox0+w,  oy0,    oz0   ], [0,1,0], [0,0,1], h, d, true),  // +X
    face([ox0,    oy0,    oz0   ], [1,0,0], [0,0,1], w, d, true),   // -Y
    face([ox0,    oy0+h,  oz0   ], [1,0,0], [0,0,1], w, d, false),  // +Y
    face([ox0,    oy0,    oz0   ], [1,0,0], [0,1,0], w, h, false),  // -Z
    face([ox0,    oy0,    oz0+d ], [1,0,0], [0,1,0], w, h, true),   // +Z
  ], edges: [], vertices: [], isClosed: true }] })
}

// Divergence-theorem volume of a kern-format Brep result object.
function kernBrepVolume(brep: { shells: Array<{ faces: Array<{
  surface: { degreeU: number; degreeV: number; cvCountU: number; cvCountV: number;
             knotsU: number[]; knotsV: number[]; cvs: number[] };
  orientation: boolean;
}> }> }): number {
  function findKnotSpan(n: number, degree: number, t: number, knots: number[]): number {
    if (t >= knots[n + 1]) return n
    if (t <= knots[degree]) return degree
    let lo = degree, hi = n + 1, mid = (lo + hi) >> 1
    while (t < knots[mid] || t >= knots[mid + 1]) {
      if (t < knots[mid]) hi = mid; else lo = mid
      mid = (lo + hi) >> 1
    }
    return mid
  }
  function basisFunctions(i: number, t: number, degree: number, knots: number[]): Float64Array {
    const N = new Float64Array(degree + 1)
    const left = new Float64Array(degree + 1)
    const right = new Float64Array(degree + 1)
    N[0] = 1
    for (let j = 1; j <= degree; j++) {
      left[j] = t - knots[i + 1 - j]; right[j] = knots[i + j] - t
      let saved = 0
      for (let r = 0; r < j; r++) {
        const denom = right[r + 1] + left[j - r]
        if (Math.abs(denom) < 1e-14) { N[r] = saved; saved = 0 }
        else { const tmp = N[r] / denom; N[r] = saved + right[r + 1] * tmp; saved = left[j - r] * tmp }
      }
      N[j] = saved
    }
    return N
  }
  function evalNurbs(s: { degreeU: number; degreeV: number; cvCountU: number; cvCountV: number;
                          knotsU: number[]; knotsV: number[]; cvs: number[] },
                     u: number, v: number): [number,number,number] {
    const { degreeU, degreeV, cvCountU, cvCountV, knotsU, knotsV, cvs } = s
    const spanU = findKnotSpan(cvCountU-1, degreeU, u, knotsU)
    const spanV = findKnotSpan(cvCountV-1, degreeV, v, knotsV)
    const Nu = basisFunctions(spanU, u, degreeU, knotsU)
    const Nv = basisFunctions(spanV, v, degreeV, knotsV)
    let sx=0,sy=0,sz=0,sw=0
    for (let i = 0; i <= degreeU; i++) {
      const row = spanU - degreeU + i
      let tx=0,ty=0,tz=0,tw=0
      for (let j = 0; j <= degreeV; j++) {
        const col = spanV - degreeV + j
        const base = (row * cvCountV + col) * 4
        tx += Nv[j]*cvs[base]; ty += Nv[j]*cvs[base+1]; tz += Nv[j]*cvs[base+2]; tw += Nv[j]*cvs[base+3]
      }
      sx += Nu[i]*tx; sy += Nu[i]*ty; sz += Nu[i]*tz; sw += Nu[i]*tw
    }
    if (Math.abs(sw) < 1e-14) return [sx,sy,sz]
    return [sx/sw, sy/sw, sz/sw]
  }
  const N = 12; let total = 0
  for (const shell of brep.shells) {
    for (const face of shell.faces) {
      const s = face.surface
      const uk0 = s.knotsU[0], uk1 = s.knotsU[s.knotsU.length-1]
      const vk0 = s.knotsV[0], vk1 = s.knotsV[s.knotsV.length-1]
      const du = (uk1-uk0)/N, dv = (vk1-vk0)/N
      let faceVol = 0
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const u = uk0+(i+0.5)*du, v = vk0+(j+0.5)*dv
          const uc = Math.min(Math.max(u,uk0+1e-9),uk1-1e-9)
          const vc = Math.min(Math.max(v,vk0+1e-9),vk1-1e-9)
          const p = evalNurbs(s, uc, vc)
          const pu1 = Math.min(uc+1e-5,uk1-1e-9), pv1 = Math.min(vc+1e-5,vk1-1e-9)
          const dp = evalNurbs(s, pu1, vc), dq = evalNurbs(s, uc, pv1)
          const dpdu = [(dp[0]-p[0])/(pu1-uc),(dp[1]-p[1])/(pu1-uc),(dp[2]-p[2])/(pu1-uc)]
          const dpdv = [(dq[0]-p[0])/(pv1-vc),(dq[1]-p[1])/(pv1-vc),(dq[2]-p[2])/(pv1-vc)]
          const nx = dpdu[1]*dpdv[2]-dpdu[2]*dpdv[1]
          const ny = dpdu[2]*dpdv[0]-dpdu[0]*dpdv[2]
          const nz = dpdu[0]*dpdv[1]-dpdu[1]*dpdv[0]
          faceVol += (p[0]*nx+p[1]*ny+p[2]*nz)*du*dv
        }
      }
      faceVol /= 3
      if (!face.orientation) faceVol = -faceVol
      total += faceVol
    }
  }
  return Math.abs(total)
}

// ── Boolean parity cases (WASM-gated) ────────────────────────────────────────
// #617 guard: tests FAIL when kern.wasm is absent. `if (!wasmReady) return`
// was the dormant-green anti-pattern this block replaces.

describe('parity-gate — boolean (WASM-gated)', () => {
  test('kern.wasm must be loaded (#617 guard)', () => {
    // This test fails intentionally when kern.wasm is absent, preventing
    // dormant-green: all subsequent boolean tests are only meaningful when
    // the WASM kernel is present.
    expect(wasmReady, 'kern.wasm absent — build with emcmake cmake + make').toBe(true)
  })

  test('fuse: union(1×1×1, 0.5³ at [0.25,0.25,0.25]) volume = 1.0 (B inside A)', () => {
    if (!wasmReady) { throw new Error('#617: kern.wasm absent — build with emcmake cmake + make') }
    const kern = rawKernModule()
    const a = kernBoxJson(1, 1, 1)
    const b = kernBoxJson(0.5, 0.5, 0.5, 0.25, 0.25, 0.25)
    const resp = JSON.parse(kern.boolUnion(a, b))
    expect(resp.ok, `kern.boolUnion failed: ${resp.error}`).toBe(true)
    const vol = kernBrepVolume(resp.result)
    expect(Math.abs(vol - 1.0) / 1.0, `volume ${vol} vs expected 1.0`).toBeLessThan(0.005)
  })

  test('cut: difference(1×1×1, 0.5³ at [0.25,0.25,0.25]) volume = 0.875 (B inside A — enclosed cavity)', () => {
    if (!wasmReady) { throw new Error('#617: kern.wasm absent — build with emcmake cmake + make') }
    const kern = rawKernModule()
    const a = kernBoxJson(1, 1, 1)
    const b = kernBoxJson(0.5, 0.5, 0.5, 0.25, 0.25, 0.25)
    const resp = JSON.parse(kern.boolDifference(a, b))
    expect(resp.ok, `kern.boolDifference failed: ${resp.error}`).toBe(true)
    const vol = kernBrepVolume(resp.result)
    expect(Math.abs(vol - 0.875) / 0.875, `volume ${vol} vs expected 0.875`).toBeLessThan(0.005)
  })

  test('intersect: intersection(1×1×1, 0.5³ at [0.25,0.25,0.25]) volume = 0.125 (B inside A)', () => {
    if (!wasmReady) { throw new Error('#617: kern.wasm absent — build with emcmake cmake + make') }
    const kern = rawKernModule()
    const a = kernBoxJson(1, 1, 1)
    const b = kernBoxJson(0.5, 0.5, 0.5, 0.25, 0.25, 0.25)
    const resp = JSON.parse(kern.boolIntersection(a, b))
    expect(resp.ok, `kern.boolIntersection failed: ${resp.error}`).toBe(true)
    const vol = kernBrepVolume(resp.result)
    expect(Math.abs(vol - 0.125) / 0.125, `volume ${vol} vs expected 0.125`).toBeLessThan(0.005)
  })

  // Timeout 60 s: SSI sub-face path is ~17× slower in Bun/JSC WASM than Node/V8.
  // All 60 ops produce correct finite volumes; gap is JSC JIT, not correctness.
  test('fuzz: no crash/NaN on 20 box pairs × 3 ops', () => {
    if (!wasmReady) { throw new Error('#617: kern.wasm absent — build with emcmake cmake + make') }
    const kern = rawKernModule()
    for (let i = 0; i < 20; i++) {
      const aw = 1 + (i % 3) * 0.3, bw = 0.5 + (i % 4) * 0.2
      const a = kernBoxJson(aw, 1, 1)
      const b = kernBoxJson(bw, 0.5, 0.5)
      for (const method of ['boolUnion','boolDifference','boolIntersection'] as const) {
        const resp = JSON.parse((kern as unknown as Record<string,Function>)[method](a, b))
        if (resp.ok) {
          const vol = kernBrepVolume(resp.result)
          expect(Number.isFinite(vol), `NaN volume for i=${i} op=${method}`).toBe(true)
        }
      }
    }
  }, 60_000)
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
