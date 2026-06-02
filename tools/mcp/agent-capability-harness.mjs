// agent-capability-harness.mjs — WEB-CAD agentic capability validation (#414)
//
// CC Workflow script. Invoke via:
//   Workflow({ scriptPath: 'B:/M/WEB-CAD/tools/mcp/agent-capability-harness.mjs' })
// No ANTHROPIC_API_KEY — uses CC OAuth. webcad MCP wired via .mcp.json.

export const meta = {
  name: 'agent-capability-414',
  description: 'WEB-CAD agentic capability validation — CC-OAuth Haiku driver (#414)',
  phases: [
    { title: 'Role Matrix', detail: 'static keyword scoring — no API calls' },
    { title: 'Isolation',   detail: 'sequential slot isolation — UUID cross-absence' },
    { title: 'Goals',       detail: 'Haiku agent per goal: discover schema, dispatch, verify' },
  ],
}

// Optional override via args.pages_url — defaults to stable Pages deployment
const WC_URL = (args && args.pages_url) ? args.pages_url : 'https://wordingone.github.io/WEB-CAD/';
const HAIKU  = 'haiku';

// ============================================================================
// Corpus (embedded inline — args.goals not reliable for large payloads)
// ============================================================================
const GOALS = [
  {
    id: 'A1', type: 'architectural', expectedRole: 'architectural',
    prompt: 'Build a 20ft x 30ft single-story room with 4 exterior walls, each 9ft tall.',
    visualCheck: true,
    assertions: { minObjectCount: 4, anyObjectContains: ['wall','Wall','SdWall'] },
  },
  {
    id: 'A2', type: 'architectural', expectedRole: 'architectural',
    prompt: 'Place 4 structural columns in a 24ft x 36ft rectangular layout, one column at each corner.',
    assertions: { minObjectCount: 4, anyObjectContains: ['column','Column','SdColumn'] },
  },
  {
    id: 'A3', type: 'architectural', expectedRole: 'architectural',
    prompt: 'Create a straight staircase with 10 steps, each step 7 inches tall and 11 inches deep.',
    assertions: { minObjectCount: 1, anyObjectContains: ['stair','Stair','SdStair','step','Step'] },
  },
  {
    id: 'G1', type: 'geometry', expectedRole: 'geometry',
    prompt: 'Create a 6ft-diameter sphere at the origin. Then subtract a 2ft-diameter cylinder from its center to hollow it out.',
    visualCheck: true,
    assertions: { minObjectCount: 1, dispatchMustInclude: ['SdSphere','SdCylinder','SdBooleanDifference'] },
  },
  {
    id: 'G2', type: 'geometry', expectedRole: 'geometry',
    prompt: 'Create a cylinder 4ft in diameter and 8ft tall, centered at the origin.',
    assertions: { minObjectCount: 1, anyObjectContains: ['cylinder','Cylinder','SdCylinder'] },
  },
  {
    id: 'G3', type: 'geometry', expectedRole: 'geometry',
    prompt: 'Create a box 10ft long, 4ft wide, and 8ft tall. Then apply a 3-inch fillet to all vertical edges.',
    assertions: { minObjectCount: 1, dispatchMustInclude: ['SdBox','SdFillet'] },
  },
  {
    id: 'N1', type: 'analysis', expectedRole: 'analysis',
    prompt: 'List all objects currently in the scene. Report the total count and object names.',
    assertions: { agentTextContainsAny: ['0','empty','no object','count','objects','none'] },
  },
  {
    id: 'N2', type: 'analysis', expectedRole: 'analysis',
    prompt: 'Inspect the scene and report how many objects are present and what types they are.',
    assertions: { agentTextContainsAny: ['0','empty','no object','type','object','found','none'] },
  },
  {
    id: 'X1', type: 'cross-role', expectedRole: null,
    prompt: 'Draw a 16ft wall on level 1. Then measure and report its length.',
    assertions: {
      minObjectCount: 1,
      anyObjectContains: ['wall','Wall','SdWall'],
      agentTextContainsAny: ['16','ft','feet','foot','length','measure'],
    },
  },
  {
    id: 'X2', type: 'geometry', expectedRole: 'geometry',
    prompt: 'Create a 5ft sphere and a 3ft cube. Boolean-union them into a single solid object.',
    assertions: { minObjectCount: 1, dispatchMustInclude: ['SdSphere','SdBox','SdBooleanUnion'] },
  },
]

// ============================================================================
// Role classifier (mirrors agent-roles.ts keyword scoring)
// ============================================================================
const ROLE_KW = {
  architectural: ['wall','door','window','slab','column','beam','stair','ramp','railing',
                  'curtain wall','opening','void','ifc','room'],
  geometry:      ['sphere','cylinder','box','cube','cone','torus','nurbs','extrude','revolve',
                  'boolean','union','subtract','intersect','chamfer','fillet','sweep','loft','brep'],
  analysis:      ['measure','count','area','volume','distance','perimeter','how many','list all',
                  'get all','report','inspect','query','properties','find all','what is','how far'],
}

function selectAgentRole(prompt) {
  const lower = prompt.toLowerCase()
  const scores = { architectural: 0, geometry: 0, analysis: 0 }
  for (const [role, kws] of Object.entries(ROLE_KW))
    for (const kw of kws) if (lower.includes(kw)) scores[role]++
  const nonZero = Object.entries(scores).filter(([, s]) => s > 0)
  return nonZero.length === 1 ? nonZero[0][0] : null
}

// ============================================================================
// Geometry assertions
// ============================================================================
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

// ============================================================================
// Failure classifier
// ============================================================================
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

// ============================================================================
// Schemas
// ============================================================================

// Isolation: combined per-slot (create + dispatch + list in one agent call)
// Using explicit boolean + counts to minimize UUID hallucination surface.
const ISO_SLOT_SCHEMA = {
  type: 'object',
  required: ['slotId', 'dispatchOk', 'sceneObjectCount', 'sceneUuids'],
  properties: {
    slotId:           { type: 'string',  description: 'slotId value from slot_create response' },
    dispatchOk:       { type: 'boolean', description: 'true if dispatch returned ok:true, false if error or not ok' },
    dispatchError:    { type: 'string',  description: 'error string if dispatch failed, empty string if ok' },
    createdUuid:      { type: 'string',  description: 'result.created UUID if dispatch ok:true, empty string if failed' },
    sceneObjectCount: { type: 'integer', description: 'count field from list_scene_objects result (0 if empty or error)' },
    sceneUuids:       {
      type: 'array',
      items: { type: 'string' },
      description: 'uuid field of every object in the list_scene_objects result, empty array if none',
    },
  },
}

const GOAL_SCHEMA = {
  type: 'object',
  required: ['slotId','dispatchedVerbs','dispatchResults','agentText','success'],
  properties: {
    slotId:          { type: 'string', description: 'Slot ID created for this goal' },
    dispatchedVerbs: { type: 'array', items: { type: 'string' }, description: 'Verb names dispatched (e.g. SdBox, SdFillet)' },
    dispatchResults: {
      type: 'array',
      items: {
        type: 'object',
        required: ['verb','ok'],
        properties: {
          verb:          { type: 'string' },
          ok:            { type: 'boolean' },
          resultCreated: { type: 'string', description: 'UUID from result.created if dispatch succeeded' },
          error:         { type: 'string', description: 'Error message if ok=false' },
        },
      },
    },
    agentText: { type: 'string', description: 'Natural language summary of what was accomplished' },
    success:   { type: 'boolean', description: 'Whether the CAD goal was achieved' },
  },
}

const SCENE_SCHEMA = {
  type: 'object',
  required: ['count','objects'],
  properties: {
    count:   { type: 'integer' },
    objects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          uuid: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string' },
        },
      },
    },
  },
}

const VISUAL_SCHEMA = {
  type: 'object',
  required: ['hasObject','isBlank','matchesGoal','verdict'],
  properties: {
    hasObject:   { type: 'boolean' },
    isBlank:     { type: 'boolean' },
    matchesGoal: { type: 'boolean' },
    verdict:     { type: 'string' },
  },
}

// ===========================================================================
// Phase 1: Role Matrix (pure JS — no agents needed)
// ===========================================================================

phase('Role Matrix')
const roleResults = []
for (const g of GOALS) {
  const actual   = selectAgentRole(g.prompt)
  const expected = g.expectedRole !== undefined ? g.expectedRole : null
  const correct  = actual === expected
  roleResults.push({ goalId: g.id, expected, actual, correct })
  log(`[role] ${correct ? 'PASS' : 'FAIL'}  ${g.id}: expected=${expected} actual=${actual}`)
}
const roleCorrect = roleResults.filter(r => r.correct).length
log(`[role] ${roleCorrect}/${GOALS.length} correct`)

// ===========================================================================
// Phase 2: Isolation — combined per-slot agents (create + dispatch + list)
// ===========================================================================

phase('Isolation')
let isoResult = { pass: false, checks: [], error: null }
try {
  const isoA = await agent(
    `Using webcad MCP tools (mcp__webcad__*), execute ALL 3 steps in order:\n` +
    `1. Call mcp__webcad__slot_create with url="${WC_URL}?slot=cap-iso-A"\n` +
    `   The response contains a slotId field — note it.\n` +
    `2. Call mcp__webcad__dispatch with verb="SdBox", args={"width":1,"depth":1,"height":1}, slotId from step 1.\n` +
    `   The response has ok (boolean). If ok is true, note result.created (the UUID string).\n` +
    `3. Call mcp__webcad__list_scene_objects with the same slotId.\n` +
    `   The response has a count (integer) and an objects array. Note uuid from each object.\n` +
    `Return:\n` +
    `  slotId: the slotId string from step 1\n` +
    `  dispatchOk: true if dispatch response ok===true, false otherwise\n` +
    `  dispatchError: the error string from dispatch if dispatchOk is false, else empty string ""\n` +
    `  createdUuid: result.created from dispatch if dispatchOk is true, else empty string ""\n` +
    `  sceneObjectCount: the count integer from list_scene_objects (0 if error)\n` +
    `  sceneUuids: array of uuid strings from every object in list_scene_objects (empty array [] if none)`,
    { schema: ISO_SLOT_SCHEMA, model: HAIKU, phase: 'Isolation', label: 'iso:A' },
  )

  const isoB = await agent(
    `Using webcad MCP tools (mcp__webcad__*), execute ALL 3 steps in order:\n` +
    `1. Call mcp__webcad__slot_create with url="${WC_URL}?slot=cap-iso-B"\n` +
    `   The response contains a slotId field — note it.\n` +
    `2. Call mcp__webcad__dispatch with verb="SdSphere", args={"radius":0.5}, slotId from step 1.\n` +
    `   The response has ok (boolean). If ok is true, note result.created (the UUID string).\n` +
    `3. Call mcp__webcad__list_scene_objects with the same slotId.\n` +
    `   The response has a count (integer) and an objects array. Note uuid from each object.\n` +
    `Return:\n` +
    `  slotId: the slotId string from step 1\n` +
    `  dispatchOk: true if dispatch response ok===true, false otherwise\n` +
    `  dispatchError: the error string from dispatch if dispatchOk is false, else empty string ""\n` +
    `  createdUuid: result.created from dispatch if dispatchOk is true, else empty string ""\n` +
    `  sceneObjectCount: the count integer from list_scene_objects (0 if error)\n` +
    `  sceneUuids: array of uuid strings from every object in list_scene_objects (empty array [] if none)`,
    { schema: ISO_SLOT_SCHEMA, model: HAIKU, phase: 'Isolation', label: 'iso:B' },
  )

  const uuidsA = (isoA && isoA.sceneUuids) ? isoA.sceneUuids : []
  const uuidsB = (isoB && isoB.sceneUuids) ? isoB.sceneUuids : []

  const isoChecks = [
    {
      check: 'slotA dispatch ok',
      pass: !!(isoA && isoA.dispatchOk),
      actual: `err=${(isoA && isoA.dispatchError || '').slice(0,80)}`,
    },
    {
      check: 'slotB dispatch ok',
      pass: !!(isoB && isoB.dispatchOk),
      actual: `err=${(isoB && isoB.dispatchError || '').slice(0,80)}`,
    },
    {
      check: 'slotA scene non-empty',
      pass: !!(isoA && isoA.sceneObjectCount > 0),
      actual: `count=${isoA && isoA.sceneObjectCount}`,
    },
    {
      check: 'slotB scene non-empty',
      pass: !!(isoB && isoB.sceneObjectCount > 0),
      actual: `count=${isoB && isoB.sceneObjectCount}`,
    },
    {
      check: 'slotA createdUuid in slotA scene',
      pass: !!(isoA && isoA.createdUuid && uuidsA.includes(isoA.createdUuid)),
      actual: `uuid=${isoA && isoA.createdUuid ? isoA.createdUuid.slice(0,8) : 'none'} scene=[${uuidsA.map(u => u.slice(0,8)).join(',')}]`,
    },
    {
      check: 'slotB createdUuid in slotB scene',
      pass: !!(isoB && isoB.createdUuid && uuidsB.includes(isoB.createdUuid)),
      actual: `uuid=${isoB && isoB.createdUuid ? isoB.createdUuid.slice(0,8) : 'none'} scene=[${uuidsB.map(u => u.slice(0,8)).join(',')}]`,
    },
    {
      check: 'slotA UUID absent from slotB scene',
      pass: !(isoA && isoA.createdUuid) || !uuidsB.includes(isoA.createdUuid),
      actual: `uuidA=${isoA && isoA.createdUuid ? isoA.createdUuid.slice(0,8) : 'none'} presentInB=${!!(isoA && isoA.createdUuid && uuidsB.includes(isoA.createdUuid))}`,
    },
    {
      check: 'slotB UUID absent from slotA scene',
      pass: !(isoB && isoB.createdUuid) || !uuidsA.includes(isoB.createdUuid),
      actual: `uuidB=${isoB && isoB.createdUuid ? isoB.createdUuid.slice(0,8) : 'none'} presentInA=${!!(isoB && isoB.createdUuid && uuidsA.includes(isoB.createdUuid))}`,
    },
  ]

  for (const c of isoChecks) log(`[iso] ${c.pass ? 'PASS' : 'FAIL'}  ${c.check} | ${c.actual}`)
  isoResult = {
    pass: isoChecks.every(c => c.pass),
    checks: isoChecks,
    slotA: { id: isoA && isoA.slotId, dispatchOk: isoA && isoA.dispatchOk, createdUuid: isoA && isoA.createdUuid, sceneCount: isoA && isoA.sceneObjectCount },
    slotB: { id: isoB && isoB.slotId, dispatchOk: isoB && isoB.dispatchOk, createdUuid: isoB && isoB.createdUuid, sceneCount: isoB && isoB.sceneObjectCount },
  }

  if (isoA && isoA.slotId) await agent(`Call mcp__webcad__slot_close with slotId="${isoA.slotId}"`, { model: HAIKU, phase: 'Isolation' })
  if (isoB && isoB.slotId) await agent(`Call mcp__webcad__slot_close with slotId="${isoB.slotId}"`, { model: HAIKU, phase: 'Isolation' })
} catch (e) {
  log(`[iso] EXCEPTION: ${e.message}`)
  isoResult = { pass: false, checks: [], error: e.message }
}

// ===========================================================================
// Phase 3: Goals (sequential per Leo's spec)
// ===========================================================================

phase('Goals')
const goalRecords = []

for (const goal of GOALS) {
  log(`[goal] ${goal.id} (${goal.type}): "${goal.prompt.slice(0,60)}..."`)

  const goalAgent = await agent(
    `You are a WEB-CAD geometry agent. Complete this CAD task using webcad MCP tools (mcp__webcad__*):\n\n` +
    `${goal.prompt}\n\n` +
    `Steps:\n` +
    `1. Call mcp__webcad__slot_create with url="${WC_URL}?slot=cap-${goal.id}" to get a fresh workspace\n` +
    `2. Call mcp__webcad__list_verbs (optionally filter by category) to find the right verbs\n` +
    `3. For complex operations (boolean, fillet, sweep, etc.), call mcp__webcad__get_verb_schema to get required args\n` +
    `4. Call mcp__webcad__dispatch for each CAD operation — dispatch args use SI units (meters). Convert imperial dimensions from the goal to meters before dispatching.\n` +
    `5. After all dispatches, call mcp__webcad__list_scene_objects to verify what was created\n\n` +
    `Return: slotId (from step 1), dispatchedVerbs (array of verb names you called), ` +
    `dispatchResults (array of {verb, ok, resultCreated, error} for each dispatch), ` +
    `agentText (what you accomplished), success (bool).`,
    { schema: GOAL_SCHEMA, model: HAIKU, phase: 'Goals', label: `goal:${goal.id}` },
  )

  if (!goalAgent) {
    goalRecords.push({ goalId: goal.id, skipped: true, type: goal.type, prompt: goal.prompt })
    log(`[goal] ${goal.id} SKIP (agent returned null — budget or abort)`)
    continue
  }

  const slotId        = goalAgent.slotId || ''
  let dispatchedVerbs = goalAgent.dispatchedVerbs || []
  let dispatchResults = goalAgent.dispatchResults || []

  // Ground-truth scene read (harness queries independently)
  let sceneObjects = []
  if (slotId) {
    const sceneAgent = await agent(
      `Call mcp__webcad__list_scene_objects with slotId="${slotId}". Return count (integer) and objects (array of {uuid, name, type}).`,
      { schema: SCENE_SCHEMA, model: HAIKU, phase: 'Goals', label: `goal:${goal.id}:scene` },
    )
    sceneObjects = sceneAgent ? (sceneAgent.objects || []) : []
  }

  // Assertion pass 1
  let geo = assertGeometry(goal, sceneObjects, goalAgent.agentText, dispatchedVerbs)

  // Retry once on agent-decomposition failure (not arch-gap)
  if (!geo.pass && slotId && dispatchResults.length > 0) {
    const fc0 = classifyFailure(dispatchResults)
    if (fc0.class !== 'arch-gap') {
      log(`[goal] ${goal.id} retry...`)
      const retryAgent = await agent(
        `Previous attempt dispatched ${JSON.stringify(dispatchedVerbs)} to slotId="${slotId}" but geometry assertions failed.\n\n` +
        `Try again using the same slot:\n\n${goal.prompt}\n\n` +
        `Dispatch any missing or corrected operations. Convert imperial to SI meters for args. Return same JSON schema.`,
        { schema: GOAL_SCHEMA, model: HAIKU, phase: 'Goals', label: `goal:${goal.id}:retry` },
      )
      if (retryAgent) {
        const retryScene = await agent(
          `Call mcp__webcad__list_scene_objects with slotId="${slotId}". Return count and objects [{uuid,name,type}].`,
          { schema: SCENE_SCHEMA, model: HAIKU, phase: 'Goals', label: `goal:${goal.id}:retry-scene` },
        )
        const retryObjects = retryScene ? (retryScene.objects || []) : []
        const retryVerbs   = retryAgent.dispatchedVerbs || []
        const retryGeo     = assertGeometry(goal, retryObjects, retryAgent.agentText, retryVerbs)
        if (retryGeo.pass) {
          geo = retryGeo
          log(`[goal] ${goal.id} PASS (on retry)`)
        }
        dispatchedVerbs = [...dispatchedVerbs, ...retryVerbs]
        dispatchResults = [...dispatchResults, ...(retryAgent.dispatchResults || [])]
      }
    }
  }

  // Visual verdict for sampled goals (A1, G1)
  let visualVerdict = null
  if (goal.visualCheck && slotId) {
    const va = await agent(
      `Call mcp__webcad__get_viewport_image with slotId="${slotId}", width=800, height=450.\n` +
      `Look at the image. Is there a visible 3D object (non-blank viewport)?\n` +
      `Does it look consistent with the goal: "${goal.prompt.slice(0,120)}"\n` +
      `Return hasObject (bool), isBlank (bool), matchesGoal (bool), verdict (string).`,
      { schema: VISUAL_SCHEMA, model: HAIKU, phase: 'Goals', label: `goal:${goal.id}:visual` },
    )
    if (va) visualVerdict = va
  }

  // Close slot
  if (slotId) {
    await agent(`Call mcp__webcad__slot_close with slotId="${slotId}"`, { model: HAIKU, phase: 'Goals' })
  }

  const triage = geo.pass ? null : classifyFailure(dispatchResults)
  const ri     = roleResults.find(r => r.goalId === goal.id)

  goalRecords.push({
    goalId:           goal.id,
    type:             goal.type,
    prompt:           goal.prompt,
    slotId,
    dispatchedVerbs,
    dispatchResults,
    dispatchCount:    dispatchResults.length,
    dispatchOk:       dispatchResults.filter(d => d.ok).length,
    sceneObjectCount: geo.objectCount,
    geometryPass:     geo.pass,
    geometryChecks:   geo.checks,
    agentText:        goalAgent.agentText || '',
    triage,
    visualVerdict,
    roleExpected:     ri ? ri.expected : null,
    roleActual:       ri ? ri.actual   : null,
    roleCorrect:      ri ? ri.correct  : false,
  })

  const triageStr = triage ? ` → ${triage.class}` : ''
  log(`[goal] ${goal.id} ${geo.pass ? 'PASS' : 'FAIL'}  dispatches=${dispatchResults.length} objects=${geo.objectCount}${triageStr}`)
}

// ===========================================================================
// Summary
// ===========================================================================
const archGaps       = goalRecords.filter(r => r.triage && r.triage.class === 'arch-gap')
const agentVariances = goalRecords.filter(r => r.triage && r.triage.class === 'agent-decomposition')
const geoPassCount   = goalRecords.filter(r => r.geometryPass).length
const visualResults  = goalRecords.filter(r => r.visualVerdict)
const visualPass     = visualResults.filter(r => r.visualVerdict && r.visualVerdict.hasObject && !r.visualVerdict.isBlank).length

const summary = {
  run_ts:          0,
  goals_total:     GOALS.length,
  mechanism_pass:  goalRecords.filter(r => r.dispatchCount > 0 && r.dispatchOk === r.dispatchCount).length,
  geometry_pass:   geoPassCount,
  visual_pass:     `${visualPass}/${visualResults.length}`,
  isolation_pass:  isoResult.pass,
  role_accuracy:   `${roleCorrect}/${GOALS.length}`,
  role_misroutes:  roleResults.filter(r => !r.correct),
  arch_gaps:       archGaps.map(r => ({ goalId: r.goalId, detail: r.triage.detail })),
  agent_variances: agentVariances.map(r => ({ goalId: r.goalId, detail: r.triage ? r.triage.detail : '' })),
  model:           HAIKU,
  pages_url:       WC_URL,
}

log(`[harness] Done. geo=${geoPassCount}/${GOALS.length} iso=${isoResult.pass} role=${roleCorrect}/${GOALS.length}`)
if (archGaps.length > 0) log(`[harness] arch-gaps: ${archGaps.map(r => r.goalId).join(', ')}`)

return { goalRecords, summary, isoResult }
