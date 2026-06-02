// agent-capability-harness.mjs — WEB-CAD agentic capability validation (#414)
//
// CC Workflow script. Must be invoked via the CC Workflow tool from a B:/M/WEB-CAD session
// where .mcp.json has loaded the `webcad` MCP server. No ANTHROPIC_API_KEY — uses CC OAuth.
//
// Invocation:
//   const corpus = JSON.parse(readFileSync('tools/mcp/agent-capability-corpus.json', 'utf-8'));
//   const result = await Workflow({
//     scriptPath: 'B:/M/WEB-CAD/tools/mcp/agent-capability-harness.mjs',
//     args: { goals: corpus.goals, pages_url: 'https://wordingone.github.io/WEB-CAD/', runTs: Date.now() }
//   });
//   // Write result.goalRecords (JSONL) and result.summary (JSON) to state/cap-harness/

export const meta = {
  name: 'agent-capability-414',
  description: 'WEB-CAD agentic capability validation — CC-OAuth Haiku driver (#414)',
  phases: [
    { title: 'Role Matrix', detail: 'static keyword scoring — no API calls' },
    { title: 'Isolation',   detail: 'sequential slot isolation — UUID cross-absence' },
    { title: 'Goals',       detail: 'Haiku agent per goal: discover schema, dispatch, verify' },
  ],
}

const GOALS   = (args && args.goals)     ? args.goals     : [];
const WC_URL  = (args && args.pages_url) ? args.pages_url : 'https://wordingone.github.io/WEB-CAD/';
const RUN_TS  = (args && args.runTs)     ? args.runTs     : 0;
const HAIKU   = 'haiku';

// ---------------------------------------------------------------------------
// Role classifier (mirrors agent-roles.ts keyword scoring — gap #5 PR 3)
// ---------------------------------------------------------------------------

const ROLE_KW = {
  architectural: ['wall','door','window','slab','column','beam','stair','ramp','railing',
                  'curtain wall','opening','void','ifc','room'],
  geometry:      ['sphere','cylinder','box','cube','cone','torus','nurbs','extrude','revolve',
                  'boolean','union','subtract','intersect','chamfer','fillet','sweep','loft','brep'],
  analysis:      ['measure','count','area','volume','distance','perimeter','how many','list all',
                  'get all','report','inspect','query','properties','find all','what is','how far'],
};

function selectAgentRole(prompt) {
  const lower = prompt.toLowerCase();
  const scores = { architectural: 0, geometry: 0, analysis: 0 };
  for (const [role, kws] of Object.entries(ROLE_KW))
    for (const kw of kws) if (lower.includes(kw)) scores[role]++;
  const nonZero = Object.entries(scores).filter(([, s]) => s > 0);
  return nonZero.length === 1 ? nonZero[0][0] : null;
}

// ---------------------------------------------------------------------------
// Geometry assertions (identical logic to prior version, adapted arg names)
// ---------------------------------------------------------------------------

function assertGeometry(goal, objects, agentText, dispatchedVerbs) {
  const a      = goal.assertions || {};
  const checks = [];
  if (Object.keys(a).length === 0) {
    checks.push({ check: 'assertions_present', pass: false, actual: 'goal has no assertions — test mis-specified' });
  }
  if (a.minObjectCount !== undefined) {
    const pass = (objects || []).length >= a.minObjectCount;
    checks.push({ check: `minObjectCount(${a.minObjectCount})`, pass, actual: (objects || []).length });
  }
  if (a.anyObjectContains) {
    const allJson = JSON.stringify(objects || []).toLowerCase();
    const pass = a.anyObjectContains.some(s => allJson.includes(s.toLowerCase()));
    checks.push({ check: `anyObjectContains(${a.anyObjectContains.slice(0,3).join('|')})`, pass, actual: allJson.slice(0,200) });
  }
  if (a.agentTextContainsAny) {
    const lower = (agentText || '').toLowerCase();
    const pass  = a.agentTextContainsAny.some(s => lower.includes(s.toLowerCase()));
    checks.push({ check: `agentTextContainsAny(${a.agentTextContainsAny.slice(0,3).join('|')})`, pass, actual: lower.slice(0,200) });
  }
  if (a.dispatchMustInclude) {
    for (const required of a.dispatchMustInclude) {
      const found = (dispatchedVerbs || []).includes(required);
      checks.push({ check: `dispatchMustInclude(${required})`, pass: found, actual: `dispatched:[${(dispatchedVerbs||[]).join(',')}]` });
    }
  }
  const pass = checks.length > 0 && checks.every(c => c.pass);
  return { pass, checks, objectCount: (objects || []).length };
}

// ---------------------------------------------------------------------------
// Failure classifier (adapted to dispatchResults schema: {verb, ok, error})
// ---------------------------------------------------------------------------

function classifyFailure(dispatchResults) {
  if (!dispatchResults || dispatchResults.length === 0)
    return { class: 'agent-decomposition', detail: 'No dispatch calls made — agent did not use tools' };
  const stubKws = ['notimplemented', 'not yet implemented', 'not implemented', 'stub', 'todo'];
  const stubEntries = dispatchResults.filter(d => {
    const err = (d.error || '').toLowerCase();
    return !d.ok && stubKws.some(k => err.includes(k));
  });
  if (stubEntries.length > 0)
    return { class: 'arch-gap', detail: `Stub/unimplemented: ${stubEntries.map(d => d.verb).join(', ')}`, note: 'Cross-reference with #400.' };
  if (dispatchResults.every(d => !d.ok))
    return { class: 'arch-gap', detail: `All dispatches errored: ${(dispatchResults[0]?.error||'').slice(0,200)}` };
  return { class: 'agent-decomposition', detail: 'Dispatches made but geometry assertions failed — wrong verb sequence or args' };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ISO_SCHEMA = {
  type: 'object',
  required: ['slotId', 'uuid'],
  properties: {
    slotId: { type: 'string', description: 'The slot ID returned by slot_create' },
    uuid:   { type: 'string', description: 'UUID from result.created in the dispatch response' },
  },
}

const SCENE_SCHEMA = {
  type: 'object',
  required: ['count', 'objects'],
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

const GOAL_SCHEMA = {
  type: 'object',
  required: ['slotId', 'dispatchedVerbs', 'dispatchResults', 'agentText', 'success'],
  properties: {
    slotId:          { type: 'string', description: 'Slot ID created for this goal' },
    dispatchedVerbs: { type: 'array', items: { type: 'string' }, description: 'Names of verbs dispatched (e.g. SdBox, SdFillet)' },
    dispatchResults: {
      type: 'array',
      items: {
        type: 'object',
        required: ['verb', 'ok'],
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

const VISUAL_SCHEMA = {
  type: 'object',
  required: ['hasObject', 'isBlank', 'matchesGoal', 'verdict'],
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
const roleResults = [];
for (const g of GOALS) {
  const actual   = selectAgentRole(g.prompt);
  const expected = g.expectedRole !== undefined ? g.expectedRole : null;
  const correct  = actual === expected;
  roleResults.push({ goalId: g.id, expected, actual, correct });
  log(`[role] ${correct ? 'PASS' : 'FAIL'}  ${g.id}: expected=${expected} actual=${actual}`);
}
const roleCorrect = roleResults.filter(r => r.correct).length;
log(`[role] ${roleCorrect}/${GOALS.length} correct`)

// ===========================================================================
// Phase 2: Isolation (sequential agents — mirrors #404 Phase-2 UUID pattern)
// ===========================================================================

phase('Isolation')
let isoResult = { pass: false, checks: [], error: null }
const isoSuffix = RUN_TS ? `-${RUN_TS}` : ''
try {
  // Step 1: Create slot A and dispatch SdBox with real args
  const isoA = await agent(
    `Using webcad MCP tools (available as mcp__webcad__*):\n` +
    `1. Call mcp__webcad__slot_create with url="${WC_URL}?slot=cap-iso-A${isoSuffix}"\n` +
    `2. Call mcp__webcad__dispatch with verb="SdBox", args={"width":1,"depth":1,"height":1}, and slotId from step 1\n` +
    `3. The dispatch response contains result.created — that is the UUID of the created object\n` +
    `Return slotId (string) and uuid (string from result.created). uuid must NOT be null.`,
    { schema: ISO_SCHEMA, model: HAIKU, phase: 'Isolation', label: 'iso:A-create' },
  )
  if (!isoA || !isoA.uuid) throw new Error(`SdBox returned no UUID — isolation test broken. result: ${JSON.stringify(isoA)}`)
  log(`[iso] Slot A uuid=${isoA.uuid.slice(0,8)}`)

  // Step 2: Create slot B and dispatch SdSphere with real args
  const isoB = await agent(
    `Using webcad MCP tools (available as mcp__webcad__*):\n` +
    `1. Call mcp__webcad__slot_create with url="${WC_URL}?slot=cap-iso-B${isoSuffix}"\n` +
    `2. Call mcp__webcad__dispatch with verb="SdSphere", args={"radius":0.5}, and slotId from step 1\n` +
    `3. The dispatch response contains result.created — that is the UUID of the created object\n` +
    `Return slotId (string) and uuid (string from result.created). uuid must NOT be null.`,
    { schema: ISO_SCHEMA, model: HAIKU, phase: 'Isolation', label: 'iso:B-create' },
  )
  if (!isoB || !isoB.uuid) throw new Error(`SdSphere returned no UUID — isolation test broken. result: ${JSON.stringify(isoB)}`)
  log(`[iso] Slot B uuid=${isoB.uuid.slice(0,8)}`)

  // Step 3: Cross-read scene from each slot
  const sceneA = await agent(
    `Call mcp__webcad__list_scene_objects with slotId="${isoA.slotId}". Return count (integer) and objects (array of {uuid, name, type}).`,
    { schema: SCENE_SCHEMA, model: HAIKU, phase: 'Isolation', label: 'iso:A-list' },
  )
  const sceneB = await agent(
    `Call mcp__webcad__list_scene_objects with slotId="${isoB.slotId}". Return count (integer) and objects (array of {uuid, name, type}).`,
    { schema: SCENE_SCHEMA, model: HAIKU, phase: 'Isolation', label: 'iso:B-list' },
  )

  const hasUuid = (objs, uuid) => (objs || []).some(o => o && o.uuid === uuid)
  const isoChecks = [
    { check: 'slotA has objects',             pass: (sceneA.objects || []).length > 0 },
    { check: 'slotB has objects',             pass: (sceneB.objects || []).length > 0 },
    { check: 'slotA contains SdBox UUID',     pass: hasUuid(sceneA.objects, isoA.uuid) },
    { check: 'slotB contains SdSphere UUID',  pass: hasUuid(sceneB.objects, isoB.uuid) },
    { check: 'SdBox UUID NOT in slotB',       pass: !hasUuid(sceneB.objects, isoA.uuid) },
    { check: 'SdSphere UUID NOT in slotA',    pass: !hasUuid(sceneA.objects, isoB.uuid) },
  ]
  for (const c of isoChecks) log(`[iso] ${c.pass ? 'PASS' : 'FAIL'}  ${c.check}`)
  isoResult = { pass: isoChecks.every(c => c.pass), checks: isoChecks }

  await agent(`Call mcp__webcad__slot_close with slotId="${isoA.slotId}"`, { model: HAIKU, phase: 'Isolation' })
  await agent(`Call mcp__webcad__slot_close with slotId="${isoB.slotId}"`, { model: HAIKU, phase: 'Isolation' })
} catch (e) {
  log(`[iso] EXCEPTION: ${e.message}`)
  isoResult = { pass: false, checks: [], error: e.message }
}

// ===========================================================================
// Phase 3: Goals (sequential per Leo's spec — mirrors #404 Phase-2 pattern)
// ===========================================================================

phase('Goals')
const goalRecords = []

for (const goal of GOALS) {
  log(`[goal] ${goal.id} (${goal.type}): "${goal.prompt.slice(0,60)}..."`)
  const slotSuffix = RUN_TS ? `-${RUN_TS}` : ''

  // One Haiku agent per goal — drives webcad MCP tools via CC OAuth
  const goalAgent = await agent(
    `You are a WEB-CAD geometry agent. Complete this CAD task using webcad MCP tools (mcp__webcad__*):\n\n` +
    `${goal.prompt}\n\n` +
    `Steps:\n` +
    `1. Call mcp__webcad__slot_create with url="${WC_URL}?slot=cap-${goal.id}${slotSuffix}" to get a fresh workspace\n` +
    `2. Call mcp__webcad__list_verbs (optionally filter by category) to find the right verbs\n` +
    `3. For complex operations (boolean, fillet, sweep, etc.), call mcp__webcad__get_verb_schema to get required args\n` +
    `4. Call mcp__webcad__dispatch for each CAD operation — dispatch args use SI units (meters). Convert imperial dimensions from the goal to meters before dispatching.\n` +
    `5. After all dispatches, call mcp__webcad__list_scene_objects to verify what was created\n\n` +
    `Return: slotId (from step 1), dispatchedVerbs (array of verb names you called), dispatchResults (array of {verb, ok, resultCreated, error} for each dispatch), agentText (what you accomplished), success (bool).`,
    { schema: GOAL_SCHEMA, model: HAIKU, phase: 'Goals', label: `goal:${goal.id}` },
  )

  if (!goalAgent) {
    goalRecords.push({ goalId: goal.id, skipped: true, type: goal.type, prompt: goal.prompt })
    log(`[goal] ${goal.id} SKIP (agent returned null — budget or abort)`)
    continue
  }

  const slotId         = goalAgent.slotId || ''
  let dispatchedVerbs  = goalAgent.dispatchedVerbs || []
  let dispatchResults  = goalAgent.dispatchResults || []

  // Ground-truth scene read (harness queries independently — not trusting agent's self-report)
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

  // Retry once on agent-decomposition failure (not arch-gap, only if agent made dispatches)
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

  const record = {
    goalId:          goal.id,
    type:            goal.type,
    prompt:          goal.prompt,
    slotId,
    dispatchedVerbs,
    dispatchResults,
    dispatchCount:   dispatchResults.length,
    dispatchOk:      dispatchResults.filter(d => d.ok).length,
    sceneObjectCount: geo.objectCount,
    geometryPass:    geo.pass,
    geometryChecks:  geo.checks,
    agentText:       goalAgent.agentText || '',
    triage,
    visualVerdict,
    roleExpected:    ri ? ri.expected : null,
    roleActual:      ri ? ri.actual   : null,
    roleCorrect:     ri ? ri.correct  : false,
  }
  goalRecords.push(record)

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
  run_ts:         RUN_TS,
  goals_total:    GOALS.length,
  mechanism_pass: goalRecords.filter(r => r.dispatchCount > 0 && r.dispatchOk === r.dispatchCount).length,
  geometry_pass:  geoPassCount,
  visual_pass:    `${visualPass}/${visualResults.length}`,
  isolation_pass: isoResult.pass,
  role_accuracy:  `${roleCorrect}/${GOALS.length}`,
  role_misroutes: roleResults.filter(r => !r.correct),
  arch_gaps:      archGaps.map(r => ({ goalId: r.goalId, detail: r.triage.detail })),
  agent_variances: agentVariances.map(r => ({ goalId: r.goalId, detail: r.triage ? r.triage.detail : '' })),
  model:          HAIKU,
  pages_url:      WC_URL,
}

log(`[harness] Done. geo=${geoPassCount}/${GOALS.length} iso=${isoResult.pass} role=${roleCorrect}/${GOALS.length}`)
if (archGaps.length > 0) log(`[harness] arch-gaps: ${archGaps.map(r => r.goalId).join(', ')}`)

return { goalRecords, summary, isoResult }
