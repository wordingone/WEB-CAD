// cap-harness-triage.test.mjs — unit tests for classifyFailure + assertGeometry (#414)
//
// These functions are copied verbatim from tools/mcp/agent-capability-harness.mjs.
// The harness is a self-contained CC Workflow script (no imports allowed), so the
// pure-logic portion is tested here rather than imported.
//
// Tests cover Leo's gate table from mail #12502:
//   T1  stub/NotYetImplemented on SdFillet        → arch-gap, #400 xref
//   T2  empty dispatch sequence                   → agent-decomposition
//   T3  all-errored non-stub                      → arch-gap (all-errored branch)
//   T4  dispatchMustInclude check fails           → geometry FAIL
//   T5a classifyFailure deterministic (same input → same output)
//   T5b fail→pass retry: assertGeometry passes on 2nd call with real scene
//   T6  assertGeometry zero assertions            → explicit FAIL (not vacuous pass)

import { test, expect } from 'bun:test'

// ---------------------------------------------------------------------------
// Functions under test (verbatim from agent-capability-harness.mjs)
// ---------------------------------------------------------------------------

function classifyFailure(dispatchResults) {
  if (!dispatchResults || dispatchResults.length === 0)
    return { class: 'agent-decomposition', detail: 'No dispatch calls made — agent did not use tools' }
  const stubKws = ['notimplemented','not yet implemented','not implemented','stub','todo']
  const stubEntries = dispatchResults.filter(d => {
    const err = (d.error || '').toLowerCase()
    return !d.ok && stubKws.some(k => err.includes(k))
  })
  if (stubEntries.length > 0)
    return { class: 'arch-gap', detail: `Stub/unimplemented: ${stubEntries.map(d => d.verb).join(', ')}`, note: 'Cross-reference with #400.' }
  if (dispatchResults.every(d => !d.ok))
    return { class: 'arch-gap', detail: `All dispatches errored: ${(dispatchResults[0]?.error||'').slice(0,200)}` }
  return { class: 'agent-decomposition', detail: 'Dispatches made but geometry assertions failed — wrong verb sequence or args' }
}

function assertGeometry(goal, objects, agentText, dispatchedVerbs) {
  const a      = goal.assertions || {}
  const checks = []
  if (Object.keys(a).length === 0) {
    checks.push({ check: 'assertions_present', pass: false, actual: 'goal has no assertions — test mis-specified' })
  }
  if (a.minObjectCount !== undefined) {
    const pass = (objects || []).length >= a.minObjectCount
    checks.push({ check: `minObjectCount(${a.minObjectCount})`, pass, actual: (objects || []).length })
  }
  if (a.anyObjectContains) {
    const allJson = JSON.stringify(objects || []).toLowerCase()
    const pass = a.anyObjectContains.some(s => allJson.includes(s.toLowerCase()))
    checks.push({ check: `anyObjectContains(${a.anyObjectContains.slice(0,3).join('|')})`, pass, actual: allJson.slice(0,200) })
  }
  if (a.agentTextContainsAny) {
    const lower = (agentText || '').toLowerCase()
    const pass  = a.agentTextContainsAny.some(s => lower.includes(s.toLowerCase()))
    checks.push({ check: `agentTextContainsAny(${a.agentTextContainsAny.slice(0,3).join('|')})`, pass, actual: lower.slice(0,200) })
  }
  if (a.dispatchMustInclude) {
    for (const required of a.dispatchMustInclude) {
      const found = (dispatchedVerbs || []).includes(required)
      checks.push({ check: `dispatchMustInclude(${required})`, pass: found, actual: `dispatched:[${(dispatchedVerbs||[]).join(',')}]` })
    }
  }
  return { pass: checks.length > 0 && checks.every(c => c.pass), checks, objectCount: (objects || []).length }
}

// ---------------------------------------------------------------------------
// T1 — stub/NotYetImplemented on SdFillet → arch-gap with #400 xref
// ---------------------------------------------------------------------------
test('T1: NotYetImplemented error → arch-gap + #400 cross-ref', () => {
  const result = classifyFailure([
    { verb: 'SdBox',    ok: true  },
    { verb: 'SdFillet', ok: false, error: 'NotYetImplemented: fillet edge selection not implemented' },
  ])
  expect(result.class).toBe('arch-gap')
  expect(result.detail).toContain('SdFillet')
  expect(result.note).toContain('#400')
})

// variant: lowercase "not implemented"
test('T1b: "not implemented" variant → arch-gap', () => {
  const result = classifyFailure([
    { verb: 'SdBooleanDifference', ok: false, error: 'not implemented' },
  ])
  expect(result.class).toBe('arch-gap')
  expect(result.detail).toContain('SdBooleanDifference')
})

// ---------------------------------------------------------------------------
// T2 — empty dispatch sequence → agent-decomposition
// ---------------------------------------------------------------------------
test('T2: empty dispatch → agent-decomposition', () => {
  const r1 = classifyFailure([])
  expect(r1.class).toBe('agent-decomposition')

  const r2 = classifyFailure(null)
  expect(r2.class).toBe('agent-decomposition')

  const r3 = classifyFailure(undefined)
  expect(r3.class).toBe('agent-decomposition')
})

// ---------------------------------------------------------------------------
// T3 — all dispatches errored, none are stubs → arch-gap (all-errored branch)
// ---------------------------------------------------------------------------
test('T3: all-errored non-stub → arch-gap', () => {
  const result = classifyFailure([
    { verb: 'SdBooleanUnion', ok: false, error: 'ArgValidationError: bodies required' },
    { verb: 'SdBox',          ok: false, error: 'ArgValidationError: width required' },
  ])
  expect(result.class).toBe('arch-gap')
  expect(result.detail).toContain('All dispatches errored')
})

// partial error (some ok) → agent-decomposition, NOT arch-gap
test('T3b: partial error (some ok) → agent-decomposition', () => {
  const result = classifyFailure([
    { verb: 'SdBox',          ok: true  },
    { verb: 'SdBooleanUnion', ok: false, error: 'ArgValidationError: bodies required' },
  ])
  expect(result.class).toBe('agent-decomposition')
})

// ---------------------------------------------------------------------------
// T4 — dispatchMustInclude check: SdBooleanDifference absent → geometry FAIL
// ---------------------------------------------------------------------------
test('T4: dispatchMustInclude missing SdBooleanDifference → geometry FAIL', () => {
  const goal = {
    assertions: {
      minObjectCount: 1,
      dispatchMustInclude: ['SdSphere', 'SdCylinder', 'SdBooleanDifference'],
    },
  }
  // agent dispatched sphere + cylinder but forgot the boolean difference
  const geo = assertGeometry(
    goal,
    [{ uuid: 'aaa', name: 'sphere', type: 'SdSphere' }],
    'created sphere and cylinder',
    ['SdSphere', 'SdCylinder'],  // no SdBooleanDifference
  )
  expect(geo.pass).toBe(false)
  const failedCheck = geo.checks.find(c => c.check.includes('SdBooleanDifference'))
  expect(failedCheck).toBeDefined()
  expect(failedCheck.pass).toBe(false)
})

// all three present → geometry PASS
test('T4b: dispatchMustInclude all present → geometry PASS', () => {
  const goal = {
    assertions: {
      minObjectCount: 1,
      dispatchMustInclude: ['SdSphere', 'SdCylinder', 'SdBooleanDifference'],
    },
  }
  const geo = assertGeometry(
    goal,
    [{ uuid: 'bbb', name: 'hollowSphere', type: 'SdBooleanDifference' }],
    'created hollow sphere',
    ['SdSphere', 'SdCylinder', 'SdBooleanDifference'],
  )
  expect(geo.pass).toBe(true)
  expect(geo.checks.every(c => c.pass)).toBe(true)
})

// ---------------------------------------------------------------------------
// T5a — classifyFailure is deterministic (same inputs → same output)
// ---------------------------------------------------------------------------
test('T5a: classifyFailure deterministic — same inputs same class', () => {
  const dispatches = [{ verb: 'SdFillet', ok: false, error: 'NotYetImplemented: fillet not ready' }]
  const first  = classifyFailure(dispatches)
  const second = classifyFailure(dispatches)
  expect(first.class).toBe(second.class)
  expect(first.detail).toBe(second.detail)
})

// T5b — fail→pass retry: assertGeometry fails on empty scene, passes on populated scene
test('T5b: fail→pass retry — assertGeometry consistent across calls', () => {
  const goal = {
    assertions: {
      minObjectCount: 1,
      anyObjectContains: ['wall', 'Wall', 'SdWall'],
    },
  }

  // First call: empty scene → FAIL (simulates agent's first attempt)
  const firstAttempt = assertGeometry(goal, [], 'could not create wall', ['SdBox'])
  expect(firstAttempt.pass).toBe(false)

  // classifyFailure on the first fail: no stubs, dispatches present → agent-decomposition
  const fc = classifyFailure([{ verb: 'SdBox', ok: true }])
  expect(fc.class).toBe('agent-decomposition')

  // Second call: agent corrected itself → PASS (simulates retry succeeding)
  const retryAttempt = assertGeometry(
    goal,
    [{ uuid: 'ccc', name: 'exteriorWall', type: 'SdWall' }],
    'created exterior wall',
    ['SdWall'],
  )
  expect(retryAttempt.pass).toBe(true)
  // This is the "agent-variance" case: fail→pass = stochastic, not arch-gap
})

// ---------------------------------------------------------------------------
// T6 — assertGeometry with zero assertions → explicit FAIL (not vacuous pass)
// ---------------------------------------------------------------------------
test('T6: zero assertions → explicit FAIL', () => {
  const goal = { assertions: {} }
  const geo = assertGeometry(goal, [{ uuid: 'ddd', name: 'box' }], 'created box', ['SdBox'])
  expect(geo.pass).toBe(false)
  expect(geo.checks.length).toBeGreaterThan(0)
  expect(geo.checks[0].check).toBe('assertions_present')
  expect(geo.checks[0].pass).toBe(false)
})

// missing assertions key entirely
test('T6b: missing assertions → explicit FAIL', () => {
  const goal = {}
  const geo = assertGeometry(goal, [], '', [])
  expect(geo.pass).toBe(false)
})
