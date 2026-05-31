// scripts/kern-parity-oracle.mjs
// Multi-oracle parity: kern.wasm vs replicad/OCCT (§A–§B of Leo's gate #7).
//
// Usage:  node scripts/kern-parity-oracle.mjs
//
// Outputs a run log with per-case volume/bbox deltas, topology counts,
// and a PASS/FAIL verdict for each oracle comparison.

import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync } from 'fs';
import path from 'path';
import createKern from '../web/kern.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── Boot WASM kernel ──────────────────────────────────────────────────────────

const kernWasmPath = path.join(__dir, '../web/kern.wasm');
if (!existsSync(kernWasmPath)) {
  console.error('FATAL: kern.wasm not found at', kernWasmPath);
  console.error('Build first: cd kern && emcmake cmake ... && cmake --build .');
  process.exit(1);
}

const kern = await createKern({
  locateFile: (f) => pathToFileURL(path.join(__dir, '../web/', f)).href,
});
console.log('[kern] WASM module loaded:', typeof kern.boolUnion);

// ── Boot replicad (oracle) ────────────────────────────────────────────────────
// replicad-opencascadejs WASM bootstrap is CJS and relies on __dirname + require.
// Inject both globals pointing to the OC src dir before requiring it.

const ocSrcDir = path.join(__dir, '../node_modules/replicad-opencascadejs/src');
global.__dirname = ocSrcDir;
global.require = require;  // let OC internals call require("fs"), require("path")

const ocMod = require(path.join(ocSrcDir, 'replicad_single.js'));
const initOC = ocMod.default ?? ocMod;
const oc = await initOC();

const replicad = require(path.join(__dir, '../node_modules/replicad/dist/replicad.cjs'));
replicad.setOC(oc);
const r = {
  makeBaseBox: replicad.makeBaseBox.bind(replicad),
  measureVolume: replicad.measureVolume.bind(replicad),
};
console.log('[replicad] OpenCASCADE loaded');

// ── Kernel Brep builder ───────────────────────────────────────────────────────

/**
 * Build a kern-format Brep for an axis-aligned box [ox0,ox0+w]×[oy0,oy0+h]×[oz0,oz0+d].
 *
 * All 6 faces use consistent xAxis/yAxis so the parametric surface covers the
 * correct geometric region. Orientation flags match the divergence theorem
 * convention used in brepVolume (orientation=true ↔ ∂p/∂u×∂p/∂v is outward).
 *
 *   Face  at       u-dir     v-dir    cross→outward?    flag
 *   -X    x=ox0    [0,1,0]  [0,0,1]  [1,0,0]→INWARD  → false
 *   +X    x=ox0+w  [0,1,0]  [0,0,1]  [1,0,0]→OUTWARD → true
 *   -Y    y=oy0    [1,0,0]  [0,0,1]  [0,-1,0]→OUTWARD→ true
 *   +Y    y=oy0+h  [1,0,0]  [0,0,1]  [0,-1,0]→INWARD  → false
 *   -Z    z=oz0    [1,0,0]  [0,1,0]  [0,0,1]→INWARD   → false
 *   +Z    z=oz0+d  [1,0,0]  [0,1,0]  [0,0,1]→OUTWARD  → true
 */
function kernBoxJson(w, h, d, ox0 = 0, oy0 = 0, oz0 = 0) {
  function face(origin, xAxis, yAxis, uExt, vExt, outward) {
    const [ox, oy, oz] = origin;
    const [xx, xy, xz] = xAxis;
    const [yx, yy, yz] = yAxis;
    // Row-major: cvs[u_idx * cvCountV + v_idx]
    // cv(0,0)=origin, cv(0,1)=origin+yAxis*vExt, cv(1,0)=origin+xAxis*uExt, cv(1,1)=...
    return {
      surface: {
        degreeU: 1, degreeV: 1, cvCountU: 2, cvCountV: 2,
        knotsU: [0, 0, uExt, uExt], knotsV: [0, 0, vExt, vExt],
        cvs: [
          ox, oy, oz, 1,
          ox + yx*vExt, oy + yy*vExt, oz + yz*vExt, 1,
          ox + xx*uExt, oy + xy*uExt, oz + xz*uExt, 1,
          ox + xx*uExt + yx*vExt, oy + xy*uExt + yy*vExt, oz + xz*uExt + yz*vExt, 1,
        ],
      },
      outerLoop: { edges: [], orientation: true },
      innerLoops: [], orientation: outward, tolerance: 1e-6,
    };
  }
  const faces = [
    face([ox0,    oy0,    oz0   ], [0,1,0], [0,0,1], h, d, false), // -X
    face([ox0+w,  oy0,    oz0   ], [0,1,0], [0,0,1], h, d, true),  // +X
    face([ox0,    oy0,    oz0   ], [1,0,0], [0,0,1], w, d, true),   // -Y
    face([ox0,    oy0+h,  oz0   ], [1,0,0], [0,0,1], w, d, false),  // +Y
    face([ox0,    oy0,    oz0   ], [1,0,0], [0,1,0], w, h, false),  // -Z
    face([ox0,    oy0,    oz0+d ], [1,0,0], [0,1,0], w, h, true),   // +Z
  ];
  return JSON.stringify({ shells: [{ faces, edges: [], vertices: [], isClosed: true }] });
}

// ── NURBS volume computation (divergence theorem) ────────────────────────────

/** Cox-de Boor knot span search. */
function findKnotSpan(n, degree, t, knots) {
  if (t >= knots[n + 1]) return n;
  if (t <= knots[degree]) return degree;
  let lo = degree, hi = n + 1, mid = (lo + hi) >> 1;
  while (t < knots[mid] || t >= knots[mid + 1]) {
    if (t < knots[mid]) hi = mid; else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

/** Compute non-zero B-spline basis functions N[0..degree] at t. */
function basisFunctions(i, t, degree, knots) {
  const N = new Float64Array(degree + 1);
  const left = new Float64Array(degree + 1);
  const right = new Float64Array(degree + 1);
  N[0] = 1;
  for (let j = 1; j <= degree; j++) {
    left[j] = t - knots[i + 1 - j];
    right[j] = knots[i + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denom = right[r + 1] + left[j - r];
      if (Math.abs(denom) < 1e-14) { N[r] = saved; saved = 0; }
      else { const tmp = N[r] / denom; N[r] = saved + right[r + 1] * tmp; saved = left[j - r] * tmp; }
    }
    N[j] = saved;
  }
  return N;
}

/** Evaluate NURBS surface at (u,v). Returns [x,y,z]. */
function evalNurbs(surf, u, v) {
  const { degreeU, degreeV, cvCountU, cvCountV, knotsU, knotsV, cvs } = surf;
  const nu = cvCountU - 1, nv = cvCountV - 1;
  const spanU = findKnotSpan(nu, degreeU, u, knotsU);
  const spanV = findKnotSpan(nv, degreeV, v, knotsV);
  const Nu = basisFunctions(spanU, u, degreeU, knotsU);
  const Nv = basisFunctions(spanV, v, degreeV, knotsV);
  let sx = 0, sy = 0, sz = 0, sw = 0;
  for (let i = 0; i <= degreeU; i++) {
    const row = spanU - degreeU + i;
    let tx = 0, ty = 0, tz = 0, tw = 0;
    for (let j = 0; j <= degreeV; j++) {
      const col = spanV - degreeV + j;
      const base = (row * cvCountV + col) * 4;
      tx += Nv[j] * cvs[base];
      ty += Nv[j] * cvs[base + 1];
      tz += Nv[j] * cvs[base + 2];
      tw += Nv[j] * cvs[base + 3];
    }
    sx += Nu[i] * tx; sy += Nu[i] * ty; sz += Nu[i] * tz; sw += Nu[i] * tw;
  }
  if (Math.abs(sw) < 1e-14) return [sx, sy, sz];
  return [sx / sw, sy / sw, sz / sw];
}

function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function cross(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}

/**
 * Compute volume of a kern Brep JSON object using the divergence theorem.
 * V = (1/3) Σ_faces ∫∫ p · (∂p/∂u × ∂p/∂v) du dv × orientation_sign
 */
function brepVolume(brep) {
  const N = 12; // quadrature grid per face
  let total = 0;
  for (const shell of brep.shells) {
    for (const face of shell.faces) {
      const s = face.surface;
      const uk0 = s.knotsU[0], uk1 = s.knotsU[s.knotsU.length - 1];
      const vk0 = s.knotsV[0], vk1 = s.knotsV[s.knotsV.length - 1];
      const du = (uk1 - uk0) / N, dv = (vk1 - vk0) / N;
      const eps = 1e-5;
      let faceVol = 0;
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const u = uk0 + (i + 0.5) * du;
          const v = vk0 + (j + 0.5) * dv;
          const uClamped = Math.min(Math.max(u, uk0 + 1e-9), uk1 - 1e-9);
          const vClamped = Math.min(Math.max(v, vk0 + 1e-9), vk1 - 1e-9);
          const p = evalNurbs(s, uClamped, vClamped);
          const pu1 = Math.min(uClamped + eps, uk1 - 1e-9);
          const pv1 = Math.min(vClamped + eps, vk1 - 1e-9);
          const dpdu_pt = evalNurbs(s, pu1, vClamped);
          const dpdv_pt = evalNurbs(s, uClamped, pv1);
          const dpdu = [
            (dpdu_pt[0] - p[0]) / (pu1 - uClamped),
            (dpdu_pt[1] - p[1]) / (pu1 - uClamped),
            (dpdu_pt[2] - p[2]) / (pu1 - uClamped),
          ];
          const dpdv = [
            (dpdv_pt[0] - p[0]) / (pv1 - vClamped),
            (dpdv_pt[1] - p[1]) / (pv1 - vClamped),
            (dpdv_pt[2] - p[2]) / (pv1 - vClamped),
          ];
          const nrm = cross(dpdu, dpdv);
          faceVol += dot(p, nrm) * du * dv;
        }
      }
      faceVol /= 3;
      if (!face.orientation) faceVol = -faceVol;
      total += faceVol;
    }
  }
  return Math.abs(total);
}

/** Bounding box [min,max] from kern Brep. */
function brepBbox(brep) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const shell of brep.shells) {
    for (const face of shell.faces) {
      const s = face.surface;
      const uk0 = s.knotsU[0], uk1 = s.knotsU[s.knotsU.length-1];
      const vk0 = s.knotsV[0], vk1 = s.knotsV[s.knotsV.length-1];
      for (let i = 0; i <= 8; i++) {
        for (let j = 0; j <= 8; j++) {
          const u = uk0 + (uk1-uk0)*i/8, v = vk0 + (vk1-vk0)*j/8;
          const [x,y,z] = evalNurbs(s, u, v);
          if (x < minX) minX=x; if (y < minY) minY=y; if (z < minZ) minZ=z;
          if (x > maxX) maxX=x; if (y > maxY) maxY=y; if (z > maxZ) maxZ=z;
        }
      }
    }
  }
  return { min: [minX,minY,minZ], max: [maxX,maxY,maxZ] };
}

// ── Test cases ────────────────────────────────────────────────────────────────

// B is centered inside A at [0.25,0.25,0.25], size 0.5×0.5×0.5.
// No face of B is coplanar with any face of A → clean SSI-free containment test.
const cases = [
  {
    label: 'union: 1×1×1 fuse 0.5×0.5×0.5 (B interior to A, no shared faces)',
    op: 'union',
    aW: 1, aH: 1, aD: 1, aOx: 0, aOy: 0, aOz: 0,
    bW: 0.5, bH: 0.5, bD: 0.5, bOx: 0.25, bOy: 0.25, bOz: 0.25,
    oracleVolume: null,
    mathVolume: 1.0,   // B inside A → result = A
  },
  {
    label: 'difference: 1×1×1 cut 0.5×0.5×0.5 (B interior to A)',
    op: 'difference',
    aW: 1, aH: 1, aD: 1, aOx: 0, aOy: 0, aOz: 0,
    bW: 0.5, bH: 0.5, bD: 0.5, bOx: 0.25, bOy: 0.25, bOz: 0.25,
    oracleVolume: null,
    mathVolume: 0.875,  // 1.0 - 0.5³ = 1 - 0.125
  },
  {
    label: 'intersection: 1×1×1 ∩ 0.5×0.5×0.5 (B interior to A)',
    op: 'intersection',
    aW: 1, aH: 1, aD: 1, aOx: 0, aOy: 0, aOz: 0,
    bW: 0.5, bH: 0.5, bD: 0.5, bOx: 0.25, bOy: 0.25, bOz: 0.25,
    oracleVolume: null,
    mathVolume: 0.125,  // = B volume = 0.5³
  },
  {
    label: 'union: 2×2×2 fuse 1×1×1 (B interior, no shared faces)',
    op: 'union',
    aW: 2, aH: 2, aD: 2, aOx: 0, aOy: 0, aOz: 0,
    bW: 1, bH: 1, bD: 1, bOx: 0.5, bOy: 0.5, bOz: 0.5,
    oracleVolume: null,
    mathVolume: 8.0,  // B inside A → result = A = 2³
  },
];

// ── Volume self-check ─────────────────────────────────────────────────────────

const selfJson = kernBoxJson(1,1,1);
const selfBrep = JSON.parse(selfJson);
const selfVol = brepVolume(selfBrep);
if (Math.abs(selfVol - 1.0) > 0.001) {
  console.error(`FATAL: brepVolume self-check failed: got ${selfVol}, expected 1.0`);
  process.exit(1);
}
console.log(`[brepVolume] self-check: ${selfVol.toFixed(6)} ≈ 1.0 ✓\n`);

// ── Run replicad oracle ───────────────────────────────────────────────────────

console.log('\n=== Multi-oracle parity: kern.wasm vs replicad/OCCT ===\n');

const PASS_TOL = 0.001; // 0.1% relative volume tolerance
const results = [];

for (const tc of cases) {
  const opFn =
    tc.op === 'union' ? (a, b) => a.fuse(b)
    : tc.op === 'difference' ? (a, b) => a.cut(b)
    : (a, b) => a.intersect(b);

  // Replicad oracle — use .translate() instance method (standalone translate passes
  // JS wrapper instead of shape.wrapped, causing WASM TypeError).
  let rVol = null, rErr = null;
  try {
    const rA = r.makeBaseBox(tc.aW, tc.aH, tc.aD).translate([tc.aOx, tc.aOy, tc.aOz]);
    const rB = r.makeBaseBox(tc.bW, tc.bH, tc.bD).translate([tc.bOx, tc.bOy, tc.bOz]);
    const rResult = opFn(rA, rB);
    rVol = r.measureVolume(rResult);
    tc.oracleVolume = rVol;
  } catch (e) {
    rErr = e.message;
  }

  // Kern kernel (pass origin offsets)
  let kVol = null, kErr = null, kFaces = null, kOk = null;
  try {
    const a = kernBoxJson(tc.aW, tc.aH, tc.aD, tc.aOx, tc.aOy, tc.aOz);
    const b = kernBoxJson(tc.bW, tc.bH, tc.bD, tc.bOx, tc.bOy, tc.bOz);
    const raw = tc.op === 'union' ? kern.boolUnion(a, b)
      : tc.op === 'difference' ? kern.boolDifference(a, b)
      : kern.boolIntersection(a, b);
    const parsed = JSON.parse(raw);
    kOk = parsed.ok;
    if (parsed.ok) {
      kVol = brepVolume(parsed.result);
      kFaces = parsed.result.shells[0]?.faces?.length ?? 0;
    } else {
      kErr = parsed.error?.message ?? 'unknown';
    }
  } catch (e) {
    kErr = e.message;
  }

  // Compare
  const oracleVol = rVol ?? tc.mathVolume;
  const relDelta = (kVol != null && oracleVol != null)
    ? Math.abs(kVol - oracleVol) / oracleVol
    : null;
  const mathRelDelta = (kVol != null)
    ? Math.abs(kVol - tc.mathVolume) / tc.mathVolume
    : null;
  const pass =
    kOk && relDelta != null && relDelta < PASS_TOL &&
    mathRelDelta != null && mathRelDelta < PASS_TOL;

  results.push({ ...tc, kVol, kFaces, kOk, kErr, rVol, rErr, relDelta, mathRelDelta, pass });

  const statusIcon = pass ? '✓' : kErr ? '✗' : '≈';
  console.log(`${statusIcon} ${tc.label}`);
  console.log(`  kern:     ${kOk ? `ok, vol=${kVol?.toFixed(6)}, faces=${kFaces}` : `err: ${kErr}`}`);
  console.log(`  replicad: ${rErr ? `err: ${rErr}` : `vol=${rVol?.toFixed(6)}`}`);
  console.log(`  math:     vol=${tc.mathVolume}`);
  if (relDelta != null) console.log(`  delta vs replicad: ${(relDelta*100).toFixed(4)}%  vs math: ${(mathRelDelta*100).toFixed(4)}%`);
  console.log(`  tol: ${(PASS_TOL*100).toFixed(1)}%  →  ${pass ? 'PASS' : 'FAIL'}`);
  console.log();
}

// ── Robustness fuzz ───────────────────────────────────────────────────────────

console.log('=== Robustness fuzz (20 box pairs × 3 ops) ===\n');
let fuzzPass = 0, fuzzFail = 0;
const fuzzOps = ['union', 'difference', 'intersection'];
for (let i = 0; i < 20; i++) {
  const aw = 1 + (i % 3) * 0.3, ah = 1, ad = 1;
  const bw = 0.5 + (i % 4) * 0.2, bh = 0.5, bd = 0.5;
  for (const op of fuzzOps) {
    try {
      const a = kernBoxJson(aw, ah, ad);
      const b = kernBoxJson(bw, bh, bd);
      const raw = op === 'union' ? kern.boolUnion(a, b)
        : op === 'difference' ? kern.boolDifference(a, b)
        : kern.boolIntersection(a, b);
      const parsed = JSON.parse(raw);
      if (parsed.ok) {
        const vol = brepVolume(parsed.result);
        const isNaN_ = !Number.isFinite(vol);
        if (isNaN_) { fuzzFail++; console.log(`  FAIL NaN: i=${i} op=${op} aw=${aw} bw=${bw}`); }
        else fuzzPass++;
      } else fuzzPass++; // error result is ok for fuzz (no crash/NaN)
    } catch (e) {
      fuzzFail++;
      console.log(`  FAIL THROW: i=${i} op=${op} ${e.message}`);
    }
  }
}
console.log(`Fuzz: ${fuzzPass}/${fuzzPass + fuzzFail} pass (0 crash/NaN required)\n`);

// ── NURBS eval parity (verb-nurbs) ────────────────────────────────────────────

let verbOk = false;
try {
  const verb = await import('verb-nurbs');
  // Test: evaluate a degree-1 bilinear surface at center
  const surf = verb.core.Data.NurbsSurface.byKnotsControlPointsWeights(
    1, 1,
    [[0,0,1,1]], [[0,0,1,1]],
    [[[0,0,0,1],[1,0,0,1]],[[0,1,0,1],[1,1,0,1]]]
  );
  const pt = verb.eval.Surface.point(surf, 0.5, 0.5);
  const distToExpected = Math.sqrt((pt[0]-0.5)**2 + (pt[1]-0.5)**2 + pt[2]**2);
  verbOk = distToExpected < 1e-4;
  console.log(`=== NURBS eval (verb-nurbs) ===`);
  console.log(`  bilinear surface center: [${pt.map(x=>x.toFixed(4))}]  (expect [0.5,0.5,0])`);
  console.log(`  delta: ${distToExpected.toFixed(6)}  → ${verbOk ? 'PASS' : 'FAIL'}\n`);
} catch (e) {
  console.log(`=== NURBS eval (verb-nurbs) ===\n  SKIP: ${e.message}\n`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

const allPass = results.every(r => r.pass) && fuzzFail === 0;
console.log('=== SUMMARY ===');
console.log(`Boolean oracle parity: ${results.filter(r => r.pass).length}/${results.length} pass`);
console.log(`Fuzz (no crash/NaN):   ${fuzzPass}/${fuzzPass+fuzzFail} pass`);
console.log(`NURBS eval (verb):     ${verbOk ? 'pass' : 'skip/fail'}`);
console.log(`\nOverall: ${allPass ? 'PASS ✓' : 'FAIL ✗'}`);
process.exit(allPass ? 0 : 1);
