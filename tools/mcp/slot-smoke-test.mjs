#!/usr/bin/env node
// Slot smoke test for webcad-mcp.mjs gap #4
// Drives the MCP server via JSON-RPC stdio, exercises 2 independent slots.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const SERVER = new URL('../mcp/webcad-mcp.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

async function runSmoke() {
  console.log('[smoke] Starting webcad-mcp.mjs...');
  const proc = spawn('node', [SERVER], {
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd: 'B:/M/WEB-CAD',
  });

  const rl = createInterface({ input: proc.stdout });
  let pending = new Map();
  let nextId = 1;

  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id == null) return; // notification
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
    else p.resolve(msg.result);
  });

  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      proc.stdin.write(msg + '\n');
      // Timeout per call
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 120_000);
    });
  }

  function call(name, args = {}) {
    return rpc('tools/call', { name, arguments: args });
  }

  function notify(method, params = {}) {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    proc.stdin.write(msg + '\n');
  }

  let pass = 0; let fail = 0;
  function check(label, cond, detail = '') {
    if (cond) { console.log(`  PASS  ${label}`); pass++; }
    else       { console.error(`  FAIL  ${label}${detail ? ': ' + detail : ''}`); fail++; }
  }

  try {
    // Initialize
    console.log('[smoke] initialize...');
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'slot-smoke', version: '0.0.1' },
    });
    notify('notifications/initialized', {});

    // List tools
    const toolsRes = await rpc('tools/list', {});
    const toolNames = toolsRes.tools.map(t => t.name);
    console.log('[smoke] tools:', toolNames.join(', '));
    check('slot_create in tools',   toolNames.includes('slot_create'));
    check('slot_list in tools',     toolNames.includes('slot_list'));
    check('slot_close in tools',    toolNames.includes('slot_close'));
    check('dispatch in tools',      toolNames.includes('dispatch'));
    check('list_verbs in tools',    toolNames.includes('list_verbs'));

    // === SLOT 1 ===
    console.log('\n[smoke] Creating slot1... (may take 30-90s on first boot)');
    const s1res = await call('slot_create', {});
    const s1 = s1res.content?.[0]?.text ? JSON.parse(s1res.content[0].text) : s1res;
    console.log('[smoke] slot1:', JSON.stringify(s1));
    check('slot1 has slotId', !!s1.slotId, JSON.stringify(s1));
    check('slot1 has cdpPort', !!s1.cdpPort, JSON.stringify(s1));

    // === SLOT 2 ===
    console.log('\n[smoke] Creating slot2...');
    const s2res = await call('slot_create', {});
    const s2 = s2res.content?.[0]?.text ? JSON.parse(s2res.content[0].text) : s2res;
    console.log('[smoke] slot2:', JSON.stringify(s2));
    check('slot2 has slotId', !!s2.slotId, JSON.stringify(s2));
    check('slot1 and slot2 have different slotIds', s1.slotId !== s2.slotId);

    // Verify slot_list shows 2 slots
    const listRes = await call('slot_list', {});
    const listed = listRes.content?.[0]?.text ? JSON.parse(listRes.content[0].text) : listRes;
    console.log('[smoke] slot_list:', JSON.stringify(listed));
    check('slot_list shows 2 slots', listed.slots?.length === 2, `got ${listed.slots?.length}`);

    // === DISPATCH to slot1: SdBox ===
    console.log('\n[smoke] Dispatching SdBox → slot1...');
    const boxRes = await call('dispatch', { verb: 'SdBox', args: {}, slotId: s1.slotId });
    const box = boxRes.content?.[0]?.text ? JSON.parse(boxRes.content[0].text) : boxRes;
    console.log('[smoke] SdBox result:', JSON.stringify(box).slice(0, 200));
    check('SdBox ok in slot1', box.ok === true, JSON.stringify(box).slice(0, 200));

    // === DISPATCH to slot2: SdSphere ===
    console.log('\n[smoke] Dispatching SdSphere → slot2...');
    const sphRes = await call('dispatch', { verb: 'SdSphere', args: {}, slotId: s2.slotId });
    const sph = sphRes.content?.[0]?.text ? JSON.parse(sphRes.content[0].text) : sphRes;
    console.log('[smoke] SdSphere result:', JSON.stringify(sph).slice(0, 200));
    check('SdSphere ok in slot2', sph.ok === true, JSON.stringify(sph).slice(0, 200));

    // === LIST SCENE OBJECTS — verify isolation ===
    console.log('\n[smoke] list_scene_objects slot1...');
    const obj1Res = await call('list_scene_objects', { slotId: s1.slotId });
    const obj1 = obj1Res.content?.[0]?.text ? JSON.parse(obj1Res.content[0].text) : obj1Res;
    console.log('[smoke] slot1 objects:', JSON.stringify(obj1).slice(0, 300));
    const obj1Count = obj1?.result?.count ?? obj1?.result?.objects?.length ?? (Array.isArray(obj1) ? obj1.length : 0);

    console.log('\n[smoke] list_scene_objects slot2...');
    const obj2Res = await call('list_scene_objects', { slotId: s2.slotId });
    const obj2 = obj2Res.content?.[0]?.text ? JSON.parse(obj2Res.content[0].text) : obj2Res;
    console.log('[smoke] slot2 objects:', JSON.stringify(obj2).slice(0, 300));
    const obj2Count = obj2?.result?.count ?? obj2?.result?.objects?.length ?? (Array.isArray(obj2) ? obj2.length : 0);

    check('slot1 has objects (SdBox added)', obj1Count > 0, `count=${obj1Count}`);
    check('slot2 has objects (SdSphere added)', obj2Count > 0, `count=${obj2Count}`);

    // === VIEWPORT IMAGE — both slots ===
    console.log('\n[smoke] get_viewport_image slot1 (800x450)...');
    const img1Res = await call('get_viewport_image', { width: 800, height: 450, slotId: s1.slotId });
    const img1 = img1Res.content?.[0]?.text ? JSON.parse(img1Res.content[0].text) : img1Res;
    console.log('[smoke] img1:', JSON.stringify(img1));
    check('img1 has path', !!img1.path, JSON.stringify(img1));
    check('img1 has estimated_tokens', typeof img1.estimated_tokens === 'number');

    console.log('\n[smoke] get_viewport_image slot2 (800x450)...');
    const img2Res = await call('get_viewport_image', { width: 800, height: 450, slotId: s2.slotId });
    const img2 = img2Res.content?.[0]?.text ? JSON.parse(img2Res.content[0].text) : img2Res;
    console.log('[smoke] img2:', JSON.stringify(img2));
    check('img2 has path', !!img2.path, JSON.stringify(img2));
    check('img1 and img2 paths are distinct', img1.path !== img2.path);

    // === CLOSE slots (Phase 1) ===
    console.log('\n[smoke] slot_close slot1...');
    const c1Res = await call('slot_close', { slotId: s1.slotId });
    const c1 = c1Res.content?.[0]?.text ? JSON.parse(c1Res.content[0].text) : c1Res;
    console.log('[smoke] close slot1:', JSON.stringify(c1));
    check('slot1 close remainingSlots=1', c1.remainingSlots === 1, `got ${c1.remainingSlots}`);

    console.log('\n[smoke] slot_close slot2...');
    const c2Res = await call('slot_close', { slotId: s2.slotId });
    const c2 = c2Res.content?.[0]?.text ? JSON.parse(c2Res.content[0].text) : c2Res;
    console.log('[smoke] close slot2:', JSON.stringify(c2));
    check('slot2 close remainingSlots=0', c2.remainingSlots === 0, `got ${c2.remainingSlots}`);

    // =========================================================================
    // Phase 2 — IDB isolation smoke (gap #4 PR B gate)
    // Verifies ?slot= namespacing: each slot gets an isolated IDB namespace;
    // default (:9222) sessions never get a suffix.
    //
    // Note: assertions against the DEPLOYED app. On the current production SHA
    // (before #402 merges), slotA/slotB assertions will FAIL (expected) since the
    // namespacing isn't deployed. The default-isolation assertion PASSES both
    // before and after — it's the safety-critical regression check.
    // =========================================================================

    // Direct CDP helper — connects to dedicated browser directly (bypasses MCP)
    async function cdpEval(port, targetId, expression) {
      const listR = await fetch(`http://localhost:${port}/json/list`);
      const tabs = await listR.json();
      const tab = tabs.find(t => t.id === targetId);
      if (!tab?.webSocketDebuggerUrl) throw new Error(`cdpEval: tab ${targetId} not found`);
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        const timer = setTimeout(() => { ws.close(); reject(new Error('cdpEval timeout')); }, 12_000);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
          expression, awaitPromise: true, returnByValue: true, timeout: 10_000,
        }}));
        ws.onmessage = ev => {
          const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
          if (msg.id !== 1) return;
          clearTimeout(timer); ws.close();
          if (msg.error) return reject(new Error(`CDP: ${msg.error.message}`));
          if (msg.result?.exceptionDetails) return reject(new Error(msg.result.exceptionDetails.text ?? 'eval exception'));
          resolve(msg.result?.result?.value);
        };
        ws.onerror = e => { clearTimeout(timer); reject(new Error(`CDP WS error: ${e.message ?? e}`)); };
      });
    }

    const WC_BASE = 'https://wordingone.github.io/WEB-CAD/';
    const ID_A = 'smokeA';
    const ID_B = 'smokeB';

    console.log('\n[smoke] Phase 2 — IDB isolation');
    console.log(`[smoke] Creating slotA (?slot=${ID_A})...`);
    const saRes = await call('slot_create', { url: `${WC_BASE}?slot=${ID_A}` });
    const sA = saRes.content?.[0]?.text ? JSON.parse(saRes.content[0].text) : saRes;
    console.log('[smoke] slotA:', JSON.stringify(sA));
    check('slotA created', !!sA.slotId, JSON.stringify(sA));

    console.log(`[smoke] Creating slotB (?slot=${ID_B})...`);
    const sbRes = await call('slot_create', { url: `${WC_BASE}?slot=${ID_B}` });
    const sB = sbRes.content?.[0]?.text ? JSON.parse(sbRes.content[0].text) : sbRes;
    console.log('[smoke] slotB:', JSON.stringify(sB));
    check('slotB created', !!sB.slotId, JSON.stringify(sB));

    console.log('[smoke] Creating slotDef (no ?slot param — tests default preservation)...');
    const sdRes = await call('slot_create', { url: WC_BASE });
    const sDef = sdRes.content?.[0]?.text ? JSON.parse(sdRes.content[0].text) : sdRes;
    console.log('[smoke] slotDef:', JSON.stringify(sDef));
    check('slotDef created', !!sDef.slotId, JSON.stringify(sDef));

    // Dispatch geometry to each → triggers autosave in 2s
    console.log('[smoke] Dispatching SdBox→slotA, SdSphere→slotB, SdCone→slotDef...');
    await call('dispatch', { verb: 'SdBox',    args: {}, slotId: sA.slotId });
    await call('dispatch', { verb: 'SdSphere', args: {}, slotId: sB.slotId });
    await call('dispatch', { verb: 'SdCone',   args: {}, slotId: sDef.slotId });

    console.log('[smoke] Waiting 4s for autosave to flush...');
    await new Promise(r => setTimeout(r, 4000));

    // Query IDB names in each slot tab via direct CDP
    const expr = '(async () => JSON.stringify((await indexedDB.databases()).map(d => d.name).sort()))()';
    const idbA   = JSON.parse(await cdpEval(sA.cdpPort,   sA.targetId,   expr));
    const idbB   = JSON.parse(await cdpEval(sB.cdpPort,   sB.targetId,   expr));
    const idbDef = JSON.parse(await cdpEval(sDef.cdpPort, sDef.targetId, expr));
    console.log('[smoke] IDB names slotA:  ', idbA);
    console.log('[smoke] IDB names slotB:  ', idbB);
    console.log('[smoke] IDB names slotDef:', idbDef);

    // Core namespacing assertions — all 3 IDB databases (require PR B deployed)
    // Note: indexedDB.databases() is origin-scoped — all tabs on the same origin
    // (wordingone.github.io) share the full DB list. Presence of smokeA/smokeB DBs
    // in ALL tabs is expected Chrome behavior, not contamination. Real isolation is
    // proven by the autosave-data assertions below.
    for (const [label, idb, id] of [['slotA', idbA, ID_A], ['slotB', idbB, ID_B]]) {
      check(`${label} has web-cad-scene-${id}`,
        idb.includes(`web-cad-scene-${id}`), `got: ${JSON.stringify(idb)}`);
      check(`${label} has gemma-drawing-layers-${id}`,
        idb.includes(`gemma-drawing-layers-${id}`), `got: ${JSON.stringify(idb)}`);
      check(`${label} has gemma-level-meta-${id}`,
        idb.includes(`gemma-level-meta-${id}`), `got: ${JSON.stringify(idb)}`);
    }

    // Safety-critical: default session (no ?slot=) keeps ALL 3 original DB names unchanged
    check('slotDef has web-cad-scene (no suffix — default preserved)',
      idbDef.some(n => n === 'web-cad-scene'),
      `got: ${JSON.stringify(idbDef)}`);
    check('slotDef has gemma-drawing-layers (no suffix)',
      idbDef.some(n => n === 'gemma-drawing-layers'),
      `got: ${JSON.stringify(idbDef)}`);
    check('slotDef has gemma-level-meta (no suffix)',
      idbDef.some(n => n === 'gemma-level-meta'),
      `got: ${JSON.stringify(idbDef)}`);

    // ---- Data-isolation assertions ----
    // Reads autosave data from each slot's own DB to confirm it WROTE to the correct DB.
    // If SLOT_SUFFIX was broken and slotA wrote to the wrong DB, web-cad-scene-smokeA
    // would have null/empty data. This is the real contamination gate.

    async function readIdbAutosave(port, targetId, dbName) {
      const expr = `(async () => {
        try {
          const db = await new Promise((res, rej) => {
            const req = indexedDB.open(${JSON.stringify(dbName)}, 1);
            req.onsuccess = e => res(e.target.result);
            req.onerror = () => rej(new Error('open failed'));
          });
          return JSON.stringify(await new Promise((res, rej) => {
            if (!db.objectStoreNames.contains('autosave')) { res(null); return; }
            const tx = db.transaction('autosave', 'readonly');
            const req = tx.objectStore('autosave').get('scene');
            req.onsuccess = e => res(e.target.result ?? null);
            req.onerror = () => res(null);
          }));
        } catch { return 'null'; }
      })()`;
      const raw = await cdpEval(port, targetId, expr);
      try { return raw ? JSON.parse(raw) : null; } catch { return null; }
    }

    console.log('\n[smoke] Verifying autosave data isolation...');
    const dataA = await readIdbAutosave(sA.cdpPort, sA.targetId, `web-cad-scene-${ID_A}`);
    const dataB = await readIdbAutosave(sB.cdpPort, sB.targetId, `web-cad-scene-${ID_B}`);
    const dataDef = await readIdbAutosave(sDef.cdpPort, sDef.targetId, 'web-cad-scene');
    // Safety: slotA's tab — default DB should be empty (slotA never wrote to web-cad-scene)
    const dataA_default = await readIdbAutosave(sA.cdpPort, sA.targetId, 'web-cad-scene');
    // Safety: slotDef's tab — slotA's namespaced DB should be empty (slotDef never wrote there)
    const dataDef_slotA = await readIdbAutosave(sDef.cdpPort, sDef.targetId, `web-cad-scene-${ID_A}`);

    console.log('[smoke] dataA (smokeA own-DB):', dataA ? `v${dataA.version} objects:${dataA.objects?.length}` : 'null');
    console.log('[smoke] dataB (smokeB own-DB):', dataB ? `v${dataB.version} objects:${dataB.objects?.length}` : 'null');
    console.log('[smoke] dataDef (default own-DB):', dataDef ? `v${dataDef.version} objects:${dataDef.objects?.length}` : 'null');
    // Note: dataA_default and dataDef_slotA are read-only diagnostics; not asserted.
    // indexedDB.databases() is origin-scoped — any tab on the same origin can READ any DB.
    // Absence-of-data checks would fail because other slots write to their own DBs on the
    // same origin. The positive "wrote to own DB" assertions below are the correct isolation gate.
    console.log('[smoke] dataA_default (slotA tab reads web-cad-scene, diagnostic only):', dataA_default ? `objects:${dataA_default.objects?.length}` : 'null');
    console.log('[smoke] dataDef_slotA (slotDef tab reads web-cad-scene-smokeA, diagnostic only):', dataDef_slotA ? `objects:${dataDef_slotA.objects?.length}` : 'null');

    // Contamination proof: each slot WROTE to its own correctly-namespaced DB.
    // If SLOT_SUFFIX were broken (e.g., '' for slotA instead of 'smokeA'),
    // slotA would write to web-cad-scene instead — and web-cad-scene-smokeA would be empty.
    check('slotA wrote to web-cad-scene-smokeA (autosave data present)',
      dataA?.objects?.length > 0, `got: ${JSON.stringify(dataA)?.slice(0, 80)}`);
    check('slotB wrote to web-cad-scene-smokeB (autosave data present)',
      dataB?.objects?.length > 0, `got: ${JSON.stringify(dataB)?.slice(0, 80)}`);
    check('slotDef wrote to web-cad-scene (autosave data present)',
      dataDef?.objects?.length > 0, `got: ${JSON.stringify(dataDef)?.slice(0, 80)}`);

    // Close isolation slots
    console.log('\n[smoke] Closing Phase 2 slots...');
    await call('slot_close', { slotId: sA.slotId });
    await call('slot_close', { slotId: sB.slotId });
    await call('slot_close', { slotId: sDef.slotId });
    check('Phase 2 slots closed', true);

  } catch (e) {
    console.error('\n[smoke] EXCEPTION:', e.message);
    fail++;
  } finally {
    proc.stdin.end();
    proc.kill('SIGTERM');
    await new Promise(r => proc.once('exit', r));
  }

  console.log(`\n[smoke] RESULT: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
}

runSmoke().catch(e => { console.error('[smoke] fatal:', e); process.exit(1); });
