#!/usr/bin/env node
// agent-capability-harness.mjs — agentic-capability validation for WEB-CAD MCP (#414)
//
// Spawns a Haiku agent per goal (via Anthropic API), proxies webcad MCP tool calls,
// judges geometry output at 3 layers, and triages failures into arch-gap vs agent-variance.
//
// Usage:  node tools/mcp/agent-capability-harness.mjs
// Env:    ANTHROPIC_API_KEY (required)
//         WEBCAD_PAGES_URL  (optional, default: https://wordingone.github.io/WEB-CAD/)

import { spawn }    from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir       = dirname(fileURLToPath(import.meta.url));
const SERVER      = join(__dir, 'webcad-mcp.mjs');
const CORPUS_PATH = join(__dir, 'agent-capability-corpus.json');
const OUTPUT_DIR  = join(__dir, '../../state/cap-harness');
const WC_URL      = process.env.WEBCAD_PAGES_URL ?? 'https://wordingone.github.io/WEB-CAD/';
const HAIKU       = 'claude-haiku-4-5-20251001';
const API_KEY     = process.env.ANTHROPIC_API_KEY;

// ---------------------------------------------------------------------------
// MCP JSON-RPC bridge (same pattern as slot-smoke-test.mjs)
// ---------------------------------------------------------------------------

function spawnMcp() {
  const proc = spawn('node', [SERVER], {
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd: join(__dir, '../..'),
  });
  const rl = createInterface({ input: proc.stdout });
  const pending = new Map();
  let nextId = 1;

  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id == null) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`RPC ${msg.error.code}: ${msg.error.message}`));
    else p.resolve(msg.result);
  });

  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    // 360s: covers 90s waitForShim + Haiku API latency per turn
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }
    }, 360_000);
  });

  const notify = (method, params = {}) =>
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

  const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
  const stop = () => { proc.stdin.end(); proc.kill('SIGTERM'); return new Promise(r => proc.once('exit', r)); };

  return { rpc, call, notify, stop };
}

// Unwrap MCP content envelope: { content: [{ type: 'text', text: '...' }] } → parsed value
function unwrap(res) {
  if (res?.content?.[0]?.text) {
    try { return JSON.parse(res.content[0].text); } catch { return res.content[0].text; }
  }
  return res;
}

// ---------------------------------------------------------------------------
// Anthropic API (native fetch — no SDK dependency)
// ---------------------------------------------------------------------------

async function anthropicCall(messages, tools, systemPrompt) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000); // 90s per API call
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: HAIKU,
        max_tokens: 4096,
        system: systemPrompt,
        tools,
        messages,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Anthropic API ${resp.status}: ${body.slice(0, 300)}`);
    }
    return resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// Visual check: send PNG screenshot to Haiku for a non-blank / geometry-present verdict
async function visualCheck(imagePath, goalPrompt) {
  if (!imagePath) return { pass: false, detail: 'no image path' };
  let b64;
  try { b64 = readFileSync(imagePath).toString('base64'); } catch (e) {
    return { pass: false, detail: `could not read image: ${e.message}` };
  }
  const resp = await anthropicCall(
    [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
        { type: 'text', text: `WEB-CAD viewport after: "${goalPrompt}". Is the viewport non-blank with visible 3D geometry? Answer YES or NO, then one sentence.` },
      ],
    }],
    [],
    'You are a visual quality assessor for a CAD application. Be concise and accurate.',
  );
  const text = resp.content?.find(b => b.type === 'text')?.text ?? '';
  const pass = text.trimStart().toUpperCase().startsWith('YES');
  return { pass, detail: text.slice(0, 200), imagePath };
}

// ---------------------------------------------------------------------------
// Webcad tool definitions for Anthropic API (harness manages slots — no slot_create/slot_close)
// ---------------------------------------------------------------------------

function buildHaikuTools(slotId) {
  return [
    {
      name: 'dispatch',
      description: `Execute a WEB-CAD geometry verb in your assigned slot. Returns {ok, result?, error?}. Your slotId is "${slotId}" — always include it.`,
      input_schema: {
        type: 'object',
        properties: {
          verb:   { type: 'string', description: 'Canonical verb name (e.g. SdBox, SdWall, SdSphere). Use list_verbs to discover names.' },
          args:   { type: 'object', description: 'Verb arguments per get_verb_schema.' },
          slotId: { type: 'string', description: `Your session slot. Always pass "${slotId}".` },
        },
        required: ['verb', 'slotId'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_verbs',
      description: 'List available geometry verbs (323 total, 21 categories). Filter by category to reduce noise.',
      input_schema: {
        type: 'object',
        properties: { category: { type: 'string', description: 'Category filter (e.g. "architectural", "sketch", "solid").' } },
        additionalProperties: false,
      },
    },
    {
      name: 'get_verb_schema',
      description: 'Get the full parameter schema for a verb before dispatching.',
      input_schema: {
        type: 'object',
        properties: { verb: { type: 'string' } },
        required: ['verb'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_scene_objects',
      description: `List all objects in your WEB-CAD scene (UUIDs, names, types). Always pass slotId="${slotId}".`,
      input_schema: {
        type: 'object',
        properties: { slotId: { type: 'string' } },
        additionalProperties: false,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Role classifier (mirrors agent-roles.ts — kept in sync with gap #5 PR 3)
// ---------------------------------------------------------------------------

const ROLE_KEYWORDS = {
  architectural: ['wall', 'door', 'window', 'slab', 'column', 'beam', 'stair', 'ramp', 'railing', 'curtain wall', 'opening', 'void', 'ifc', 'room'],
  geometry:      ['sphere', 'cylinder', 'box', 'cube', 'cone', 'torus', 'nurbs', 'extrude', 'revolve', 'boolean', 'union', 'subtract', 'intersect', 'chamfer', 'fillet', 'sweep', 'loft', 'brep'],
  analysis:      ['measure', 'count', 'area', 'volume', 'distance', 'perimeter', 'how many', 'list all', 'get all', 'report', 'inspect', 'query', 'properties', 'find all', 'what is', 'how far'],
};

function selectAgentRole(prompt) {
  const lower = prompt.toLowerCase();
  const scores = { architectural: 0, geometry: 0, analysis: 0 };
  for (const [role, kws] of Object.entries(ROLE_KEYWORDS)) {
    for (const kw of kws) if (lower.includes(kw)) scores[role]++;
  }
  const nonZero = Object.entries(scores).filter(([, s]) => s > 0);
  return nonZero.length === 1 ? nonZero[0][0] : undefined;
}

// ---------------------------------------------------------------------------
// Geometry assertions
// ---------------------------------------------------------------------------

function assertGeometry(goal, sceneResult, agentFinalText, dispatchSequence) {
  const result  = sceneResult?.result ?? sceneResult ?? {};
  const objects = result.objects ?? (Array.isArray(sceneResult) ? sceneResult : []);
  const count   = typeof result.count === 'number' ? result.count : objects.length;
  const a       = goal.assertions ?? {};
  const checks  = [];

  // Mis-specified goal — no assertions is a test bug, not a pass
  if (Object.keys(a).length === 0) {
    checks.push({ check: 'assertions_present', pass: false, actual: 'goal has no assertions — test mis-specified' });
  }

  if (a.minObjectCount !== undefined) {
    const pass = count >= a.minObjectCount;
    checks.push({ check: `minObjectCount(${a.minObjectCount})`, pass, actual: count });
  }

  if (a.anyObjectContains) {
    const allJson = JSON.stringify(objects).toLowerCase();
    const pass = a.anyObjectContains.some(s => allJson.includes(s.toLowerCase()));
    checks.push({ check: `anyObjectContains(${a.anyObjectContains.slice(0, 3).join('|')})`, pass, actual: allJson.slice(0, 200) });
  }

  if (a.agentTextContainsAny) {
    const lower = (agentFinalText ?? '').toLowerCase();
    const pass  = a.agentTextContainsAny.some(s => lower.includes(s.toLowerCase()));
    checks.push({ check: `agentTextContainsAny(${a.agentTextContainsAny.slice(0, 3).join('|')})`, pass, actual: lower.slice(0, 200) });
  }

  // Hard-op probe: verify the agent actually called the required verbs (boolean/fillet)
  if (a.dispatchMustInclude) {
    const dispatchedVerbs = (dispatchSequence ?? []).map(d => d.verb);
    for (const required of a.dispatchMustInclude) {
      const found = dispatchedVerbs.includes(required);
      checks.push({ check: `dispatchMustInclude(${required})`, pass: found, actual: `dispatched: [${dispatchedVerbs.join(', ')}]` });
    }
  }

  const pass = checks.length > 0 && checks.every(c => c.pass);
  return { pass, checks, objectCount: count };
}

// ---------------------------------------------------------------------------
// Failure classifier
// ---------------------------------------------------------------------------

function classifyFailure(dispatchSequence) {
  if (dispatchSequence.length === 0) {
    return { class: 'agent-decomposition', detail: 'No dispatch calls made — agent did not use tools' };
  }

  // Stub / NotYetImplemented errors → architecture gap candidate
  const stubEntries = dispatchSequence.filter(d => {
    const err = (d.error ?? '').toLowerCase();
    return d.status === 'error' && (
      err.includes('notimplemented') || err.includes('not yet implemented') ||
      err.includes('not implemented') || err.includes('stub') || err.includes('todo')
    );
  });
  if (stubEntries.length > 0) {
    return {
      class: 'arch-gap',
      detail: `Stub/unimplemented: ${stubEntries.map(d => d.verb).join(', ')}`,
      verbs: stubEntries.map(d => ({ verb: d.verb, error: (d.error ?? '').slice(0, 120) })),
      note: 'Cross-reference with #400 audit',
    };
  }

  // All dispatches errored (non-stub)
  const allErrored = dispatchSequence.every(d => d.status === 'error');
  if (allErrored) {
    const firstErr = (dispatchSequence[0]?.error ?? 'unknown').slice(0, 200);
    return { class: 'arch-gap', detail: `All dispatches errored: ${firstErr}` };
  }

  // Some dispatches ok but geometry assertion failed
  return { class: 'agent-decomposition', detail: 'Dispatches made but geometry assertions failed — Haiku produced wrong verb sequence or args' };
}

// ---------------------------------------------------------------------------
// Haiku agent goal runner (harness manages slot lifecycle)
// ---------------------------------------------------------------------------

async function runGoalWithAgent(goal, mcp, attempt) {
  const startMs = Date.now();
  const GOAL_TIMEOUT_MS = 300_000; // 300s; cold boot of each slot tab ≤ 90s
  const goalDeadline = startMs + GOAL_TIMEOUT_MS;

  const dispatchSequence = [];
  let sceneResult     = null;
  let agentFinalText  = '';
  let agentTurns      = 0;
  let timedOut        = false;
  let screenshotPath  = null;

  // Harness owns the slot — Haiku only dispatches geometry
  console.log(`  [goal ${goal.id}/attempt ${attempt}] slot_create...`);
  const slotRaw  = await mcp.call('slot_create', { url: `${WC_URL}?slot=cap-${goal.id}-${attempt}` });
  const slot     = unwrap(slotRaw);
  const slotId   = slot.slotId;
  if (!slotId) throw new Error(`slot_create failed: ${JSON.stringify(slot)}`);
  console.log(`  [goal ${goal.id}/attempt ${attempt}] slot ready: ${slotId}`);

  const tools = buildHaikuTools(slotId);
  const systemPrompt = `You are a WEB-CAD geometry agent.

A WEB-CAD session has been prepared for you. Your slotId is: "${slotId}"

Always include slotId: "${slotId}" in every dispatch and list_scene_objects call.

Workflow:
1. Use list_verbs (with a category filter) to discover the right verbs for your task.
2. Use get_verb_schema to check required parameters before dispatching.
3. Use dispatch to create each geometry element, passing slotId: "${slotId}".
4. Use list_scene_objects (slotId: "${slotId}") to verify what was created.
5. Respond with a summary of what was created, including counts and key dimensions.

Use imperial units (feet, inches) for all dimensions.
Complete the entire goal, then respond with your summary.`;

  let messages = [{ role: 'user', content: goal.prompt }];

  try {
    while (true) {
      if (Date.now() > goalDeadline) { timedOut = true; break; }

      const resp = await anthropicCall(messages, tools, systemPrompt);
      agentTurns++;

      agentFinalText = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

      if (resp.stop_reason === 'end_turn') break;
      if (resp.stop_reason !== 'tool_use') break;

      // Execute tool calls and feed results back
      const toolResults = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        if (Date.now() > goalDeadline) { timedOut = true; break; }

        let toolResult = null;
        let toolError  = null;
        try {
          const res  = await mcp.call(block.name, block.input ?? {});
          toolResult = unwrap(res);

          if (block.name === 'dispatch') {
            dispatchSequence.push({
              verb:         block.input?.verb ?? '(unknown)',
              args:         block.input?.args ?? {},
              status:       toolResult?.ok ? 'ok' : 'error',
              error:        toolResult?.error ?? null,
              result_shape: toolResult?.result ? Object.keys(toolResult.result) : [],
            });
          }
          if (block.name === 'list_scene_objects') {
            sceneResult = toolResult;
          }
        } catch (e) {
          toolError = e.message;
          if (block.name === 'dispatch') {
            dispatchSequence.push({
              verb: block.input?.verb ?? '(unknown)',
              args: block.input?.args ?? {},
              status: 'error',
              error: `MCP call failed: ${e.message}`,
              result_shape: [],
            });
          }
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: toolError ? `Error: ${toolError}` : JSON.stringify(toolResult),
        });
      }
      if (timedOut) break;

      messages.push({ role: 'assistant', content: resp.content });
      messages.push({ role: 'user',      content: toolResults });
    }

    // Final scene state if agent didn't call list_scene_objects
    if (!sceneResult) {
      try {
        sceneResult = unwrap(await mcp.call('list_scene_objects', { slotId }));
      } catch {}
    }

    // Viewport screenshot for sampled visual check goals
    if (goal.visualCheck) {
      try {
        const imgResult = unwrap(await mcp.call('get_viewport_image', { width: 800, height: 450, slotId }));
        screenshotPath  = imgResult?.path ?? null;
      } catch {}
    }

  } finally {
    try { await mcp.call('slot_close', { slotId }); } catch {}
  }

  const geo = assertGeometry(goal, sceneResult, agentFinalText, dispatchSequence);

  return {
    goalId:          goal.id,
    attempt,
    slotId,
    agentTurns,
    dispatchCount:   dispatchSequence.length,
    dispatchOk:      dispatchSequence.filter(d => d.status === 'ok').length,
    dispatchSequence,
    sceneObjectCount: geo.objectCount,
    geometryPass:    geo.pass,
    geometryChecks:  geo.checks,
    agentFinalText,
    screenshotPath,
    timed_out:       timedOut,
    cold_boot:       true,
    durationMs:      Date.now() - startMs,
  };
}

// ---------------------------------------------------------------------------
// Sequential slot isolation test (mirrors #404 Phase-2 shape)
// ---------------------------------------------------------------------------

async function runIsolationTest(mcp) {
  console.log('\n[iso] Sequential slot isolation test');

  // Step 1: Create slot A, dispatch SdBox with real args, hard-assert UUID
  console.log('[iso] Creating slot A...');
  const sA    = unwrap(await mcp.call('slot_create', { url: `${WC_URL}?slot=cap-iso-A` }));
  // Explicit args (not {}): SdBox params are SI — 1m x 1m x 1m is the default but we pass explicitly
  const boxR  = unwrap(await mcp.call('dispatch', { verb: 'SdBox', args: { width: 1, depth: 1, height: 1 }, slotId: sA.slotId }));
  // result.created is the canonical UUID field for solid primitives (confirmed: nurbs.ts L378)
  const uuidA = boxR?.result?.created ?? null;
  if (!uuidA) {
    throw new Error(`SdBox dispatch did not return result.created — isolation test is broken. dispatch result: ${JSON.stringify(boxR)}`);
  }
  console.log(`[iso] Slot A: SdBox → uuid=${uuidA.slice(0, 8)}`);

  // Step 2: Create slot B, dispatch SdSphere with real args, hard-assert UUID
  console.log('[iso] Creating slot B...');
  const sB    = unwrap(await mcp.call('slot_create', { url: `${WC_URL}?slot=cap-iso-B` }));
  const sphR  = unwrap(await mcp.call('dispatch', { verb: 'SdSphere', args: { radius: 0.5 }, slotId: sB.slotId }));
  // result.created confirmed: nurbs.ts L393
  const uuidB = sphR?.result?.created ?? null;
  if (!uuidB) {
    throw new Error(`SdSphere dispatch did not return result.created — isolation test is broken. dispatch result: ${JSON.stringify(sphR)}`);
  }
  console.log(`[iso] Slot B: SdSphere → uuid=${uuidB.slice(0, 8)}`);

  // Step 3: Cross-read scene from each slot
  const obj1 = unwrap(await mcp.call('list_scene_objects', { slotId: sA.slotId }));
  const obj2 = unwrap(await mcp.call('list_scene_objects', { slotId: sB.slotId }));
  const objs1 = obj1?.result?.objects ?? [];
  const objs2 = obj2?.result?.objects ?? [];
  const hasUuid = (objs, uuid) => objs.some(o => o?.uuid === uuid);

  const checks = [
    { check: 'slotA has objects',                  pass: objs1.length > 0 },
    { check: 'slotB has objects',                  pass: objs2.length > 0 },
    { check: 'slotA contains SdBox UUID',          pass: hasUuid(objs1, uuidA) },
    { check: 'slotB contains SdSphere UUID',       pass: hasUuid(objs2, uuidB) },
    { check: 'slotA SdBox UUID NOT in slotB',      pass: !hasUuid(objs2, uuidA) },
    { check: 'slotB SdSphere UUID NOT in slotA',   pass: !hasUuid(objs1, uuidB) },
  ];

  for (const c of checks) {
    console.log(`[iso] ${c.pass ? 'PASS' : 'FAIL'}  ${c.check}`);
  }

  try { await mcp.call('slot_close', { slotId: sA.slotId }); } catch {}
  try { await mcp.call('slot_close', { slotId: sB.slotId }); } catch {}

  return { pass: checks.every(c => c.pass), checks };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!API_KEY) {
    console.error('[harness] ANTHROPIC_API_KEY not set. Export it before running.');
    process.exit(1);
  }

  const { goals } = JSON.parse(readFileSync(CORPUS_PATH, 'utf-8'));
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const ts          = Date.now();
  const jsonlPath   = join(OUTPUT_DIR, `cap-run-${ts}.jsonl`);
  const summaryPath = join(OUTPUT_DIR, `cap-summary-${ts}.json`);

  console.log('[harness] WEB-CAD agentic capability harness (#414)');
  console.log(`[harness] ${goals.length} goals | model: ${HAIKU} | pages: ${WC_URL}`);
  console.log(`[harness] Output: ${jsonlPath}`);

  const mcp = spawnMcp();

  // Initialize MCP server
  await mcp.rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cap-harness', version: '0.1.0' },
  });
  mcp.notify('notifications/initialized', {});

  // --- Role coverage matrix (classifier only — no network) ---
  console.log('\n[role] Role coverage matrix:');
  const roleResults = goals.map(goal => {
    const actual  = selectAgentRole(goal.prompt) ?? null;
    const expected = goal.expectedRole ?? null;
    const correct  = actual === expected;
    console.log(`[role] ${correct ? 'PASS' : 'FAIL'}  ${goal.id}: expected=${expected} actual=${actual}`);
    return { goalId: goal.id, expected, actual, correct };
  });
  const roleAccuracy  = roleResults.filter(r => r.correct).length;
  const roleMisroutes = roleResults.filter(r => !r.correct);

  // --- Sequential isolation test ---
  console.log('\n[iso] Starting...');
  let isoResult = { pass: false, checks: [], error: null };
  try {
    isoResult = await runIsolationTest(mcp);
  } catch (e) {
    console.error('[iso] EXCEPTION:', e.message);
    isoResult.error = e.message;
  }

  // --- Per-goal runs ---
  const goalRecords    = [];
  const archGaps       = [];
  const agentVariances = [];
  let mechPass = 0;
  let geoPass  = 0;

  for (const goal of goals) {
    console.log(`\n[goal] ${goal.id} (${goal.type}): "${goal.prompt.slice(0, 60)}..."`);

    // Attempt 1
    let record;
    try {
      record = await runGoalWithAgent(goal, mcp, 1);
    } catch (e) {
      console.error(`  [goal ${goal.id}] EXCEPTION (attempt 1):`, e.message);
      record = {
        goalId: goal.id, attempt: 1, slotId: null, agentTurns: 0,
        dispatchCount: 0, dispatchOk: 0, dispatchSequence: [],
        sceneObjectCount: 0, geometryPass: false, geometryChecks: [],
        agentFinalText: '', screenshotPath: null,
        timed_out: false, cold_boot: true, durationMs: 0, error: e.message,
      };
    }

    // Mechanism pass: at least 1 dispatch and all dispatches ok
    if (record.dispatchCount > 0 && record.dispatchOk === record.dispatchCount) mechPass++;

    // Geometry pass / retry-on-failure
    if (record.geometryPass) {
      geoPass++;
    } else if (!record.timed_out) {
      console.log(`  [goal ${goal.id}] geometry FAIL (attempt 1) — retrying...`);
      let retry;
      try {
        retry = await runGoalWithAgent(goal, mcp, 2);
      } catch (e) {
        retry = { ...record, attempt: 2, error: e.message, geometryPass: false };
      }
      record.retry = retry;

      if (retry.geometryPass) {
        geoPass++;
        record.retryVerdict = 'agent-variance';
        agentVariances.push({ goalId: goal.id, detail: 'Passed on retry — stochastic agent decomposition' });
        console.log(`  [goal ${goal.id}] PASS on retry → agent-variance`);
      } else {
        // Deterministic failure — classify
        const combinedSeq = [...record.dispatchSequence, ...(retry.dispatchSequence ?? [])];
        const fc = classifyFailure(combinedSeq);
        record.retryVerdict   = 'deterministic';
        record.failureClass   = fc;
        if (fc.class === 'arch-gap') {
          archGaps.push({ goalId: goal.id, ...fc });
          console.log(`  [goal ${goal.id}] FAIL (deterministic) → arch-gap: ${fc.detail}`);
        } else {
          agentVariances.push({ goalId: goal.id, detail: fc.detail });
          console.log(`  [goal ${goal.id}] FAIL (deterministic) → agent-decomposition: ${fc.detail}`);
        }
      }
    }

    // Visual check (sampled: A1 and G1 only)
    if (goal.visualCheck && record.screenshotPath) {
      console.log(`  [goal ${goal.id}] visual check: ${record.screenshotPath}`);
      try {
        record.visualVerdict = await visualCheck(record.screenshotPath, goal.prompt);
        console.log(`  [goal ${goal.id}] visual: ${record.visualVerdict.pass ? 'PASS' : 'FAIL'} — ${record.visualVerdict.detail.slice(0, 80)}`);
      } catch (e) {
        record.visualVerdict = { pass: false, detail: `visual check error: ${e.message}` };
      }
    }

    // Attach role info
    const ri = roleResults.find(r => r.goalId === goal.id);
    record.roleExpected = ri?.expected ?? null;
    record.roleActual   = ri?.actual   ?? null;
    record.roleCorrect  = ri?.correct  ?? false;

    console.log(`  [goal ${goal.id}] dispatches=${record.dispatchCount} ok=${record.dispatchOk} geo=${record.geometryPass} turns=${record.agentTurns} ${record.timed_out ? 'TIMEOUT' : ''} (${Math.round(record.durationMs / 1000)}s)`);

    goalRecords.push(record);
    // Flush JSONL after each goal
    writeFileSync(jsonlPath, goalRecords.map(r => JSON.stringify(r)).join('\n') + '\n');
  }

  // --- Summary ---
  const visualResults = goalRecords.filter(r => r.visualVerdict);
  const visualPass    = visualResults.filter(r => r.visualVerdict?.pass).length;

  const summary = {
    run_ts:          ts,
    goals_total:     goals.length,
    mechanism_pass:  mechPass,
    geometry_pass:   geoPass,
    visual_pass:     `${visualPass}/${visualResults.length}`,
    isolation_pass:  isoResult.pass,
    role_accuracy:   `${roleAccuracy}/${goals.length}`,
    role_misroutes:  roleMisroutes,
    arch_gaps:       archGaps,
    agent_variances: agentVariances,
    model:           HAIKU,
    pages_url:       WC_URL,
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log('\n=== RESULT ===');
  console.log(`mechanism   : ${mechPass}/${goals.length}`);
  console.log(`geometry    : ${geoPass}/${goals.length}`);
  console.log(`visual      : ${visualPass}/${visualResults.length}`);
  console.log(`isolation   : ${isoResult.pass ? 'PASS' : 'FAIL'}`);
  console.log(`role acc.   : ${roleAccuracy}/${goals.length}`);
  console.log(`arch-gaps   : ${archGaps.length}${archGaps.length ? ' — ' + archGaps.map(g => g.goalId).join(', ') : ''}`);
  console.log(`agent-var.  : ${agentVariances.length}`);
  if (roleMisroutes.length > 0) {
    console.log('\nRole mis-routes:');
    for (const r of roleMisroutes) console.log(`  ${r.goalId}: expected=${r.expected} actual=${r.actual}`);
  }
  if (archGaps.length > 0) {
    console.log('\nArch-gap candidates (cross-reference with #400):');
    for (const g of archGaps) console.log(`  ${g.goalId}: ${g.detail}`);
  }
  console.log(`\nJSONL  : ${jsonlPath}`);
  console.log(`Summary: ${summaryPath}`);

  await mcp.stop();
  // Exit 1 only if geometry coverage is below 50% (expected on first run against stubs)
  process.exit(geoPass < Math.floor(goals.length / 2) ? 1 : 0);
}

main().catch(e => { console.error('[harness] fatal:', e); process.exit(1); });
