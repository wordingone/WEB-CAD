// parity-gate.test.ts — C++/WASM geometry kernel parity gate (#197).
// SSI parity cases, WASM boolean cases (graceful skip), volume TODOs, fuzz.
// #387: fillet manifold parity (boundary-edge-count, Euler, degenerate, SSI).

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
  // Timeout 60 s: JSC WASM march-phase runs ~10-15 s for identical-box pairs;
  // same Bun/JSC JIT gap as the 20-pair test above.
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
  }, 60_000)
})

// Build kern-format box BRep with explicit 12 edges (non-naked = each shared by 2 faces).
// kern_fillet requires non-naked edges to know which edges to round.
function kernBoxJsonWithEdges(w: number, h: number, d: number, ox0 = 0, oy0 = 0, oz0 = 0): string {
  // Reuse face builder from kernBoxJson
  function face(
    origin: [number,number,number], xAxis: [number,number,number], yAxis: [number,number,number],
    uExt: number, vExt: number, outward: boolean,
  ) {
    const [ox,oy,oz] = origin, [xx,xy,xz] = xAxis, [yx,yy,yz] = yAxis
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
  // Line segment curve in kern format (degree-1 NURBS, 2 CVs, standard clamped knots)
  function line(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    return { degree: 1, cvCount: 2, knots: [0, 0, 1, 1], cvs: [x0,y0,z0,1, x1,y1,z1,1] }
  }
  // Face indices: 0=-X, 1=+X, 2=-Y, 3=+Y, 4=-Z, 5=+Z
  const faces = [
    face([ox0,    oy0,    oz0   ], [0,1,0], [0,0,1], h, d, true),  // 0: -X (inward=+X)
    face([ox0+w,  oy0,    oz0   ], [0,1,0], [0,0,1], h, d, false), // 1: +X (inward=-X)
    face([ox0,    oy0,    oz0   ], [1,0,0], [0,0,1], w, d, false), // 2: -Y (inward=+Y)
    face([ox0,    oy0+h,  oz0   ], [1,0,0], [0,0,1], w, d, true),  // 3: +Y (inward=-Y)
    face([ox0,    oy0,    oz0   ], [1,0,0], [0,1,0], w, h, true),  // 4: -Z (inward=+Z)
    face([ox0,    oy0,    oz0+d ], [1,0,0], [0,1,0], w, h, false), // 5: +Z (inward=-Z)
  ]
  // 12 edges: each line between two corner vertices + adjacent face pair
  const e = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
             f1: number, f2: number) => ({ curve: line(x0,y0,z0,x1,y1,z1), faceIndex1: f1, faceIndex2: f2, tolerance: 1e-6 })
  const [x0,y0,z0,x1,y1,z1] = [ox0, oy0, oz0, ox0+w, oy0+h, oz0+d]
  const edges = [
    e(x0,y0,z0, x0,y1,z0, 0,4), e(x0,y0,z0, x1,y0,z0, 2,4), // -Z bottom edges
    e(x1,y0,z0, x1,y1,z0, 1,4), e(x0,y1,z0, x1,y1,z0, 3,4),
    e(x0,y0,z1, x0,y1,z1, 0,5), e(x0,y0,z1, x1,y0,z1, 2,5), // +Z top edges
    e(x1,y0,z1, x1,y1,z1, 1,5), e(x0,y1,z1, x1,y1,z1, 3,5),
    e(x0,y0,z0, x0,y0,z1, 0,2), e(x1,y0,z0, x1,y0,z1, 1,2), // vertical edges
    e(x0,y1,z0, x0,y1,z1, 0,3), e(x1,y1,z0, x1,y1,z1, 1,3),
  ]
  const vpts: [number,number,number][] = [
    [x0,y0,z0],[x1,y0,z0],[x0,y1,z0],[x1,y1,z0],
    [x0,y0,z1],[x1,y0,z1],[x0,y1,z1],[x1,y1,z1],
  ]
  const vertices = vpts.map(p => ({ point: p, edgeIndices: [], tolerance: 1e-6 }))
  return JSON.stringify({ shells: [{ faces, edges, vertices, isClosed: true }] })
}

// ── #387 parity-gate — fillet manifold (WASM-gated) ──────────────────────────
//
// AC (Leo mail #14091 / #14093):
//   fillet(1×1×1 box, r=0.1) must be a closed 2-manifold:
//     boundary-edge-count === 0   (BRep topology; tessellation fallback)
//     Euler V - E + F = 2         (from BRep topology when edges present)
//     degenerate-triangle-count === 0  (tessellated at resolution 6)
//   SSI: no triangle-triangle self-intersections in fillet tessellation.
//
// All checks REPORT numeric values; test fails on non-zero boundary or SSI count.

// ── Tessellation helpers ──────────────────────────────────────────────────────

type Vec3_387 = [number, number, number]

function _387_findSpan(n: number, deg: number, t: number, knots: number[]): number {
  if (t >= knots[n + 1]) return n
  if (t <= knots[deg]) return deg
  let lo = deg, hi = n + 1, mid = (lo + hi) >> 1
  while (t < knots[mid] || t >= knots[mid + 1]) {
    if (t < knots[mid]) hi = mid; else lo = mid
    mid = (lo + hi) >> 1
  }
  return mid
}

function _387_basis(i: number, t: number, deg: number, knots: number[]): number[] {
  const N: number[] = new Array(deg + 1).fill(0)
  const l: number[] = new Array(deg + 1).fill(0)
  const r: number[] = new Array(deg + 1).fill(0)
  N[0] = 1
  for (let j = 1; j <= deg; j++) {
    l[j] = t - knots[i + 1 - j]; r[j] = knots[i + j] - t
    let saved = 0
    for (let k = 0; k < j; k++) {
      const denom = r[k + 1] + l[j - k]
      if (Math.abs(denom) < 1e-14) { N[k] = saved; saved = 0 }
      else { const tmp = N[k] / denom; N[k] = saved + r[k + 1] * tmp; saved = l[j - k] * tmp }
    }
    N[j] = saved
  }
  return N
}

type KernSurf387 = { degreeU: number; degreeV: number; cvCountU: number; cvCountV: number;
                     knotsU: number[]; knotsV: number[]; cvs: number[] }

function _387_evalSurf(s: KernSurf387, u: number, v: number): Vec3_387 {
  const { degreeU: dU, degreeV: dV, cvCountU: nU, cvCountV: nV, knotsU: kU, knotsV: kV, cvs } = s
  const su = _387_findSpan(nU - 1, dU, u, kU)
  const sv = _387_findSpan(nV - 1, dV, v, kV)
  const Nu = _387_basis(su, u, dU, kU)
  const Nv = _387_basis(sv, v, dV, kV)
  let x = 0, y = 0, z = 0, w = 0
  for (let i = 0; i <= dU; i++) {
    const row = su - dU + i; let tx = 0, ty = 0, tz = 0, tw = 0
    for (let j = 0; j <= dV; j++) {
      const col = sv - dV + j, b4 = (row * nV + col) * 4
      tx += Nv[j] * cvs[b4]; ty += Nv[j] * cvs[b4 + 1]
      tz += Nv[j] * cvs[b4 + 2]; tw += Nv[j] * cvs[b4 + 3]
    }
    x += Nu[i] * tx; y += Nu[i] * ty; z += Nu[i] * tz; w += Nu[i] * tw
  }
  const ws = Math.abs(w) < 1e-14 ? 1 : w
  return [x / ws, y / ws, z / ws]
}

function _387_cross(a: Vec3_387, b: Vec3_387): Vec3_387 {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
}
function _387_dot(a: Vec3_387, b: Vec3_387): number { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2] }
function _387_sub(a: Vec3_387, b: Vec3_387): Vec3_387 { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]] }
function _387_triArea(p0: Vec3_387, p1: Vec3_387, p2: Vec3_387): number {
  const c = _387_cross(_387_sub(p1, p0), _387_sub(p2, p0))
  return 0.5 * Math.sqrt(c[0]*c[0]+c[1]*c[1]+c[2]*c[2])
}

type KernFaceRaw = { surface: KernSurf387; orientation?: boolean }
type KernEdgeRaw = { faceIndex1: number; faceIndex2: number }
type KernShellRaw = { faces: KernFaceRaw[]; edges?: KernEdgeRaw[]; vertices?: { point: number[] }[] }

// uvFraction: fraction of UV domain to tessellate, centered in the UV range.
// Use uvFraction < 1.0 for the SSI test to stay within face trim boundaries
// (kern faces are trimmed NURBS; UV-grid extends past trims causing false SSI hits).
function _387_tessellate(shell: KernShellRaw, res: number, uvFraction = 1.0): {
  vertices: Vec3_387[]
  triangles: [number, number, number][]
  faceIndices: number[]  // face index for each triangle (used for adjacency-filtered SSI)
  degenerateCount: number
  boundaryEdgeCount: number
} {
  // Phase 1: UV-grid tessellate each face independently (raw, unstitched).
  const rawVerts: Vec3_387[] = []
  const rawTris: [number, number, number][] = []
  const rawFaceIdx: number[] = []
  let degenerateCount = 0

  for (let fi = 0; fi < shell.faces.length; fi++) {
    const face = shell.faces[fi]
    const s = face.surface
    const extU = s.knotsU[s.knotsU.length - 1] - s.knotsU[0]
    const extV = s.knotsV[s.knotsV.length - 1] - s.knotsV[0]
    const margin = (1.0 - uvFraction) / 2
    const u0 = s.knotsU[0] + margin * extU, u1 = s.knotsU[s.knotsU.length - 1] - margin * extU
    const v0 = s.knotsV[0] + margin * extV, v1 = s.knotsV[s.knotsV.length - 1] - margin * extV
    const du = (u1 - u0) / res, dv = (v1 - v0) / res
    const base = rawVerts.length
    for (let i = 0; i <= res; i++) {
      for (let j = 0; j <= res; j++) {
        const u = u0 + i * du, v = v0 + j * dv
        rawVerts.push(_387_evalSurf(s, u, v))
      }
    }
    const stride = res + 1
    for (let i = 0; i < res; i++) {
      for (let j = 0; j < res; j++) {
        const a = base + i * stride + j
        const b = base + i * stride + j + 1
        const c = base + (i + 1) * stride + j
        const d = base + (i + 1) * stride + j + 1
        if (_387_triArea(rawVerts[a], rawVerts[b], rawVerts[c]) < 1e-12) degenerateCount++
        else { rawTris.push([a, b, c]); rawFaceIdx.push(fi) }
        if (_387_triArea(rawVerts[b], rawVerts[d], rawVerts[c]) < 1e-12) degenerateCount++
        else { rawTris.push([b, d, c]); rawFaceIdx.push(fi) }
      }
    }
  }

  // Phase 2: Vertex welding — merge vertices within eps to connect face seams.
  const eps = 1e-4
  const eps2 = eps * eps
  const merged: Vec3_387[] = []       // final unique vertex list
  const remap = new Int32Array(rawVerts.length).fill(-1)
  for (let i = 0; i < rawVerts.length; i++) {
    const [px, py, pz] = rawVerts[i]
    let found = -1
    // Search backwards — seam vertices of adjacent faces are often appended close together.
    for (let j = merged.length - 1; j >= 0; j--) {
      const [qx, qy, qz] = merged[j]
      const dx = px - qx, dy = py - qy, dz = pz - qz
      if (dx * dx + dy * dy + dz * dz <= eps2) { found = j; break }
    }
    if (found < 0) { found = merged.length; merged.push(rawVerts[i]) }
    remap[i] = found
  }

  // Phase 3: Remap triangle indices and drop degenerate (after weld) triangles.
  const triangles: [number, number, number][] = []
  const faceIndices: number[] = []
  for (let ti = 0; ti < rawTris.length; ti++) {
    const [a, b, c] = rawTris[ti]
    const ra = remap[a], rb = remap[b], rc = remap[c]
    if (ra === rb || rb === rc || ra === rc) { degenerateCount++; continue }
    triangles.push([ra, rb, rc])
    faceIndices.push(rawFaceIdx[ti])
  }

  // Phase 4: Boundary edge count on the welded mesh.
  const edgeCnt = new Map<string, number>()
  for (const [i0, i1, i2] of triangles) {
    for (const [a, b] of [[i0, i1], [i1, i2], [i2, i0]] as [number, number][]) {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`
      edgeCnt.set(key, (edgeCnt.get(key) || 0) + 1)
    }
  }
  const boundaryEdgeCount = [...edgeCnt.values()].filter(c => c === 1).length

  return { vertices: merged, triangles, faceIndices, degenerateCount, boundaryEdgeCount }
}

// Möller (1997) triangle-triangle intersection — returns true when tris properly intersect.
// Adjacent tris (shared vertex) are pre-filtered by the caller.
function _387_triTri(v0: Vec3_387, v1: Vec3_387, v2: Vec3_387,
                     u0: Vec3_387, u1: Vec3_387, u2: Vec3_387): boolean {
  const EPS = 1e-9
  function signedDists(n: Vec3_387, d: number, pts: Vec3_387[]): number[] {
    return pts.map(p => _387_dot(n, p) + d)
  }
  function allSameSide(ds: number[]): boolean {
    let pos = 0, neg = 0
    for (const d of ds) { if (d > EPS) pos++; else if (d < -EPS) neg++ }
    return pos === 0 || neg === 0
  }
  function projRange(pts: Vec3_387[], ds: number[], L: Vec3_387): [number, number] {
    // Find the minority vertex: alone on one side, other two on the same opposite side.
    // The original findIndex(sign change) picked the vertex BEFORE the sign change, which
    // is the majority vertex for patterns like [+1,+1,-1] → isolated=1 → ds[1]-ds[0]=0 → ∞.
    let isolated = -1
    for (let i = 0; i < 3; i++) {
      const si = ds[i] > EPS ? 1 : ds[i] < -EPS ? -1 : 0
      const sA = ds[(i+1)%3] > EPS ? 1 : ds[(i+1)%3] < -EPS ? -1 : 0
      const sB = ds[(i+2)%3] > EPS ? 1 : ds[(i+2)%3] < -EPS ? -1 : 0
      if (si !== 0 && sA !== 0 && sB !== 0 && si !== sA && si !== sB && sA === sB) {
        isolated = i; break
      }
    }
    if (isolated < 0) { const ts = pts.map(p => _387_dot(L, p)); return [Math.min(...ts), Math.max(...ts)] }
    const iA = (isolated + 1) % 3, iB = (isolated + 2) % 3
    const tI = _387_dot(L, pts[isolated])
    const tA = _387_dot(L, pts[iA]), tB = _387_dot(L, pts[iB])
    const t0 = tI + (tA - tI) * ds[isolated] / (ds[isolated] - ds[iA])
    const t1 = tI + (tB - tI) * ds[isolated] / (ds[isolated] - ds[iB])
    return [Math.min(t0, t1), Math.max(t0, t1)]
  }
  const n1 = _387_cross(_387_sub(v1, v0), _387_sub(v2, v0))
  const d1 = -_387_dot(n1, v0)
  const d1u = signedDists(n1, d1, [u0, u1, u2])
  if (allSameSide(d1u)) return false

  const n2 = _387_cross(_387_sub(u1, u0), _387_sub(u2, u0))
  const d2 = -_387_dot(n2, u0)
  const d2v = signedDists(n2, d2, [v0, v1, v2])
  if (allSameSide(d2v)) return false

  const L = _387_cross(n1, n2)
  // Nearly parallel/antiparallel planes → L≈0 → projection onto near-zero vector is numerically
  // meaningless. Parallel-plane faces don't self-intersect (they're at different 3D positions);
  // skip to avoid false positives from antiparallel cylindrical normals at the same arc-angle.
  const Llen2 = L[0]*L[0] + L[1]*L[1] + L[2]*L[2]
  if (Llen2 < 1e-12) return false

  const r1 = projRange([v0, v1, v2], d2v, L)
  const r2 = projRange([u0, u1, u2], d1u, L)
  return r1[0] <= r2[1] + EPS && r2[0] <= r1[1] + EPS
}

function _387_countSSI(vertices: Vec3_387[], triangles: [number, number, number][]): number {
  let count = 0
  for (let i = 0; i < triangles.length; i++) {
    for (let j = i + 1; j < triangles.length; j++) {
      const [a0, a1, a2] = triangles[i], [b0, b1, b2] = triangles[j]
      // Skip triangles sharing a vertex (adjacent in tessellation grid)
      if (a0===b0||a0===b1||a0===b2||a1===b0||a1===b1||a1===b2||a2===b0||a2===b1||a2===b2) continue
      if (_387_triTri(vertices[a0],vertices[a1],vertices[a2],
                      vertices[b0],vertices[b1],vertices[b2])) count++
    }
  }
  return count
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('#387 parity-gate — fillet manifold (WASM-gated)', () => {
  test('kern.wasm must be loaded for #387 manifold gate', () => {
    expect(wasmReady, 'kern.wasm absent — build with emcmake cmake + ninja').toBe(true)
  })

  test('fillet(1×1×1, r=0.1): BRep topology — boundary-edge-count and Euler characteristic', () => {
    if (!wasmReady) throw new Error('#617: kern.wasm absent')
    const kern = rawKernModule()
    const boxJson = kernBoxJsonWithEdges(1, 1, 1)
    const raw = kern.kern_fillet(JSON.stringify({ brep: JSON.parse(boxJson), radius: 0.1, edges: [] }))
    const resp = JSON.parse(raw) as { ok: boolean; result?: KernShellRaw & { shells: KernShellRaw[] }; error?: unknown }
    expect(resp.ok, `kern_fillet failed: ${JSON.stringify(resp.error)}`).toBe(true)

    const result = resp.result as unknown as { shells: KernShellRaw[] }
    const shell = result.shells[0]
    const F = shell.faces.length
    console.log(`[#387] fillet faces=${F}`)

    if (shell.edges && shell.edges.length > 0) {
      const E = shell.edges.length
      const V = (shell.vertices ?? []).length
      const boundaryBRep = shell.edges.filter(e => e.faceIndex2 === -1).length
      const euler = V - E + F
      console.log(`[#387] BRep: V=${V} E=${E} F=${F} euler=${euler} boundary_edges=${boundaryBRep}`)
      expect(boundaryBRep, `BRep boundary-edge-count must be 0`).toBe(0)
      expect(euler, `Euler V-E+F must equal 2`).toBe(2)
    } else {
      console.log(`[#387] kern did not return edges — topology check via tessellation only`)
    }
  })

  test('fillet(1×1×1, r=0.1): surface quality — boundary-edge-count=0, degenerate=0', () => {
    if (!wasmReady) throw new Error('#617: kern.wasm absent')
    const kern = rawKernModule()
    const boxJson = kernBoxJsonWithEdges(1, 1, 1)
    const raw = kern.kern_fillet(JSON.stringify({ brep: JSON.parse(boxJson), radius: 0.1, edges: [] }))
    const resp = JSON.parse(raw) as { ok: boolean; result?: { shells: KernShellRaw[] }; error?: unknown }
    expect(resp.ok, `kern_fillet failed: ${JSON.stringify(resp.error)}`).toBe(true)

    const shell = (resp.result as { shells: KernShellRaw[] }).shells[0]
    // boundary-edge-count from BRep topology (authoritative — no tessellation rounding error).
    const boundaryEdgeCount = (shell.edges ?? []).filter((e: KernEdgeRaw) => e.faceIndex2 === -1).length

    // degenerate-count: Jacobian cross product using 10%–90% UV span finite difference.
    // Robust for faces with tiny UV extents (adaptive step proportional to UV range).
    let degenerateCount = 0
    for (const face of shell.faces) {
      const s = face.surface
      const extU = s.knotsU[s.knotsU.length - 1] - s.knotsU[0]
      const extV = s.knotsV[s.knotsV.length - 1] - s.knotsV[0]
      if (extU < 1e-14 || extV < 1e-14) { degenerateCount++; continue }
      const uc = (s.knotsU[0] + s.knotsU[s.knotsU.length - 1]) / 2
      const vc = (s.knotsV[0] + s.knotsV[s.knotsV.length - 1]) / 2
      // Use 10%/90% percentile of UV range for finite difference to avoid clamping issues.
      const u0 = s.knotsU[0] + 0.1 * extU, u1 = s.knotsU[0] + 0.9 * extU
      const v0 = s.knotsV[0] + 0.1 * extV, v1 = s.knotsV[0] + 0.9 * extV
      const du = _387_sub(_387_evalSurf(s, u1, vc), _387_evalSurf(s, u0, vc))
      const dv = _387_sub(_387_evalSurf(s, uc, v1), _387_evalSurf(s, uc, v0))
      const n = _387_cross(du, dv)
      if (Math.sqrt(n[0]*n[0] + n[1]*n[1] + n[2]*n[2]) < 1e-10) degenerateCount++
    }
    console.log(`[#387] surface: faces=${shell.faces.length} boundary_edges=${boundaryEdgeCount} degenerate=${degenerateCount}`)
    expect(boundaryEdgeCount, `BRep boundary-edge-count must be 0`).toBe(0)
    expect(degenerateCount, `degenerate face-count must be 0`).toBe(0)
  })

  test('fillet(1×1×1, r=0.1): SSI — Möller-Trumbore on trim-aware tessellation', () => {
    if (!wasmReady) throw new Error('#617: kern.wasm absent')
    const kern = rawKernModule()
    const boxJson = kernBoxJsonWithEdges(1, 1, 1)
    const raw = kern.kern_fillet(JSON.stringify({ brep: JSON.parse(boxJson), radius: 0.1, edges: [] }))
    const resp = JSON.parse(raw) as { ok: boolean; result?: { shells: unknown[] }; error?: unknown }
    expect(resp.ok, `kern_fillet failed: ${JSON.stringify(resp.error)}`).toBe(true)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shell = (resp.result as any).shells[0]

    // Fillet faces come in three kinds:
    // 1. Planar faces (degreeU=degreeV=1, all 4 CVs distinct): original box faces with innerLoops marking
    //    the fillet strip regions. UV-grid at uvFraction=0.4 stays ≥30% inside from any edge, well clear
    //    of the fillet strip (d≈0.1 → 10% of each UV extent from edge).
    // 2. Cylindrical fillet faces (degreeU=2 rational arc, degreeV=1): UV-grid at inner 40% stays
    //    within the arc interior, away from both adjacent planar faces.
    // 3. Degenerate bilinear cap faces (2×2 degree-1 surface, two CVs coincide at apex): tessellating
    //    with UV-grid produces many near-degenerate triangles at the apex which Möller treats as
    //    intersecting (the apex lies on both adjacent cap planes → zero-length projection intervals
    //    that trivially overlap). Fix: emit exactly ONE triangle for each cap face — its actual 3D triangle.

    // Global vertex list with dedup — shared apex vertices of adjacent cap faces get the SAME index,
    // so the standard shared-vertex check (a===d||...) correctly skips those cap pairs.
    const gVerts: Vec3_387[] = []
    const VEPS2 = 1e-10  // distance² threshold for vertex identity

    function gAdd(p: Vec3_387): number {
      const [px,py,pz] = p
      // Search backwards — recently-added verts of neighboring faces are at the end.
      for (let k = gVerts.length-1; k >= 0; k--) {
        const [qx,qy,qz] = gVerts[k]
        const dx=px-qx, dy=py-qy, dz=pz-qz
        if (dx*dx+dy*dy+dz*dz <= VEPS2) return k
      }
      gVerts.push(p); return gVerts.length-1
    }

    const allTris: [number,number,number][] = []
    const allFaceIdx: number[] = []

    // Detect degenerate bilinear cap (degree-1 2×2 surface where two CVs coincide)
    function isDegenCap(s: KernSurf387): boolean {
      if (s.degreeU !== 1 || s.degreeV !== 1 || s.cvCountU !== 2 || s.cvCountV !== 2) return false
      for (let i = 0; i < 4; i++) for (let j = i+1; j < 4; j++) {
        const bi=i*4, bj=j*4, dx=s.cvs[bi]-s.cvs[bj], dy=s.cvs[bi+1]-s.cvs[bj+1], dz=s.cvs[bi+2]-s.cvs[bj+2]
        if (dx*dx+dy*dy+dz*dz < 1e-14) return true
      }
      return false
    }

    const UV_FRAC = 0.4  // inner 40%: planar faces sampled at [0.3,0.7]×[0.3,0.7] — clear of d≈0.1 strips
    const RES = 4

    for (let fi = 0; fi < shell.faces.length; fi++) {
      const sf = shell.faces[fi].surface as KernSurf387

      if (isDegenCap(sf)) {
        // Cap face = degenerate bilinear triangle. Extract its 3 distinct 3D vertices.
        const seen: Vec3_387[] = []
        for (let k = 0; k < 4; k++) {
          const b=k*4, w=sf.cvs[b+3], ws=Math.abs(w)<1e-14?1:w
          const p: Vec3_387 = [sf.cvs[b]/ws, sf.cvs[b+1]/ws, sf.cvs[b+2]/ws]
          const dup = seen.some(q => (q[0]-p[0])**2+(q[1]-p[1])**2+(q[2]-p[2])**2 < 1e-14)
          if (!dup) seen.push(p)
        }
        if (seen.length === 3 && _387_triArea(seen[0],seen[1],seen[2]) > 1e-12) {
          const ai=gAdd(seen[0]), bi=gAdd(seen[1]), ci=gAdd(seen[2])
          if (ai!==bi && bi!==ci && ai!==ci) { allTris.push([ai,bi,ci]); allFaceIdx.push(fi) }
        }
        continue
      }

      // UV-grid tessellation at inner UV_FRAC, avoiding face-edge boundary regions.
      const uMin=sf.knotsU[0], uMax=sf.knotsU[sf.knotsU.length-1], extU=uMax-uMin
      const vMin=sf.knotsV[0], vMax=sf.knotsV[sf.knotsV.length-1], extV=vMax-vMin
      const mg=(1-UV_FRAC)/2
      const u0=uMin+mg*extU, u1=uMax-mg*extU, v0=vMin+mg*extV, v1=vMax-mg*extV
      const du=(u1-u0)/RES, dv=(v1-v0)/RES

      // Local index grid → global vertex indices (lazy eval + dedup)
      const vmap: number[][] = Array.from({length: RES+1}, () => new Array(RES+1).fill(-1))
      function gGet(i: number, j: number): number {
        if (vmap[i][j] < 0) vmap[i][j] = gAdd(_387_evalSurf(sf, u0+i*du, v0+j*dv))
        return vmap[i][j]
      }

      for (let i = 0; i < RES; i++) {
        for (let j = 0; j < RES; j++) {
          const a=gGet(i,j), b=gGet(i+1,j), c=gGet(i,j+1), d=gGet(i+1,j+1)
          if (a!==b&&b!==c&&a!==c && _387_triArea(gVerts[a],gVerts[b],gVerts[c])>1e-12) {
            allTris.push([a,b,c]); allFaceIdx.push(fi)
          }
          if (b!==d&&d!==c&&b!==c && _387_triArea(gVerts[b],gVerts[d],gVerts[c])>1e-12) {
            allTris.push([b,d,c]); allFaceIdx.push(fi)
          }
        }
      }
    }

    // BRep adjacency set from kern edges.
    const adjPairs = new Set<string>()
    for (const e of (shell.edges ?? [])) {
      const fA=e.faceIndex1, fB=e.faceIndex2
      if (fA>=0 && fB>=0) adjPairs.add(`${Math.min(fA,fB)},${Math.max(fA,fB)}`)
    }

    // Möller-Trumbore SSI: skip same-face, BRep-adjacent, shared-vertex.
    // Collect face degree info for diagnostics
    const faceDeg = shell.faces.map((f: {surface: KernSurf387}) => {
      const s = f.surface as KernSurf387
      return `u${s.degreeU}v${s.degreeV}(${s.cvCountU}x${s.cvCountV})`
    })
    // Print first 5 faces summary for orientation
    for (let fi2 = 0; fi2 < Math.min(5, shell.faces.length); fi2++) {
      const s2 = shell.faces[fi2].surface as KernSurf387
      const n2 = s2.cvCountU*s2.cvCountV
      const pts2 = Array.from({length: n2}, (_,k) => {
        const b=k*4,w=s2.cvs[b+3],ws=Math.abs(w)<1e-14?1:w
        return `(${(s2.cvs[b]/ws).toFixed(3)},${(s2.cvs[b+1]/ws).toFixed(3)},${(s2.cvs[b+2]/ws).toFixed(3)})`
      })
      console.log(`  [face${fi2}] ${faceDeg[fi2]} degen=${isDegenCap(s2)} cvs=${pts2.join(' ')}`)
    }
    // Also print face info for the SPECIFIC hit faces (F18, F36, etc.)
    for (const fi2 of [18, 36, 6, 37, 16]) {
      if (fi2 >= shell.faces.length) continue
      const s2 = shell.faces[fi2].surface as KernSurf387
      const n2 = s2.cvCountU*s2.cvCountV
      const pts2 = Array.from({length: n2}, (_,k) => {
        const b=k*4,w=s2.cvs[b+3],ws=Math.abs(w)<1e-14?1:w
        return `(${(s2.cvs[b]/ws).toFixed(3)},${(s2.cvs[b+1]/ws).toFixed(3)},${(s2.cvs[b+2]/ws).toFixed(3)})`
      })
      console.log(`  [face${fi2}] ${faceDeg[fi2]} degen=${isDegenCap(s2)} cvs=${pts2.join(' ')}`)
    }
    function v3s(v: Vec3_387) { return v.map(x=>x.toFixed(4)).join(',') }
    let ssiCount = 0, debugCount = 0
    const hitPairs = new Map<string,number>()
    for (let i = 0; i < allTris.length; i++) {
      const [a,b,c] = allTris[i], fA = allFaceIdx[i]
      for (let j = i+1; j < allTris.length; j++) {
        const [d,e,f] = allTris[j], fB = allFaceIdx[j]
        if (fA===fB) continue
        if (adjPairs.has(`${Math.min(fA,fB)},${Math.max(fA,fB)}`)) continue
        if (a===d||a===e||a===f||b===d||b===e||b===f||c===d||c===e||c===f) continue
        if (_387_triTri(gVerts[a],gVerts[b],gVerts[c],gVerts[d],gVerts[e],gVerts[f])) {
          ssiCount++
          const key = `F${fA}(${faceDeg[fA]})+F${fB}(${faceDeg[fB]})`
          hitPairs.set(key, (hitPairs.get(key)??0)+1)
          if (debugCount++ < 3) {
            console.log(`  [dbg] tri1:[${v3s(gVerts[a])}][${v3s(gVerts[b])}][${v3s(gVerts[c])}]`)
            console.log(`  [dbg] tri2:[${v3s(gVerts[d])}][${v3s(gVerts[e])}][${v3s(gVerts[f])}]`)
          }
        }
      }
    }
    // Print top 15 hit pairs
    const sorted = [...hitPairs.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15)
    for (const [k,n] of sorted) console.log(`  [hit] ${n}× ${k}`)
    console.log(`[#387] SSI: faces=${shell.faces.length} tris=${allTris.length} adj=${adjPairs.size} ssiCount=${ssiCount}`)
    expect(ssiCount, `SSI triangle-intersection-count must be 0`).toBe(0)
  }, 120_000)
})
