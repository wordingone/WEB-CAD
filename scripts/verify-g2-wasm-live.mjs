// G2 live-browser verification: SdBooleanUnion → wasmBooleanBackend path
// Usage: node scripts/verify-g2-wasm-live.mjs [--url http://localhost:5847]
//
// Connects to CDP at :9222, cold-clears storage, navigates to the app,
// waits for wasmBooleanBackend (priority 20) to register, issues SdBox×2 +
// SdBooleanUnion, asserts displaySource="canonical-brep" + backendId="wasm-kern".
// Produces a run log + saves a screenshot to state/g2-verify/.

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __dir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dir, '..');
const outDir = join(rootDir, 'state', 'g2-verify');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const APP_URL = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'https://wordingone.github.io/WEB-CAD/';
const CDP_URL = 'http://localhost:9222';
const WASM_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

const log = (msg, ok = true) => console.log(`${ok ? '✓' : '✗'} ${msg}`);
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

// ── CDP helpers ──────────────────────────────────────────────────────────────

async function cdpTarget() {
  const res = await fetch(`${CDP_URL}/json`);
  const tabs = await res.json();
  const tab = tabs.find(t => t.type === 'page') ?? tabs[0];
  if (!tab) fail('No CDP target found — start the shared browser');
  return tab;
}

class CDP {
  #ws; #id = 0; #pending = new Map(); #events = new Map();
  constructor(ws) { this.#ws = ws; }

  static async connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.once('open', () => resolve(new CDP(ws)));
      ws.once('error', reject);
    });
  }

  _listen() {
    this.#ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== undefined) {
        this.#pending.get(msg.id)?.(msg);
        this.#pending.delete(msg.id);
      } else if (msg.method) {
        this.#events.get(msg.method)?.forEach(cb => cb(msg.params));
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.#id;
      this.#pending.set(id, (msg) => msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result));
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event, cb) {
    if (!this.#events.has(event)) this.#events.set(event, []);
    this.#events.get(event).push(cb);
  }

  eval(expr) {
    return this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: false,
    }).then(r => {
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + (r.exceptionDetails.exception?.description ?? ''));
      return r.result.value;
    });
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    return new Promise((resolve) => {
      this.on('Page.loadEventFired', () => resolve());
    });
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const runLog = [];
const ts = () => new Date().toISOString();

function record(step, data) {
  const entry = { ts: ts(), step, ...data };
  runLog.push(entry);
  return entry;
}

async function main() {
  console.log(`\n=== G2 WASM Boolean Live-Browser Verification ===`);
  console.log(`App: ${APP_URL}`);
  console.log(`CDP: ${CDP_URL}\n`);

  // ── Connect to CDP ──
  const tab = await cdpTarget();
  console.log(`Target: ${tab.title} (${tab.id})`);
  const cdp = await CDP.connect(tab.webSocketDebuggerUrl);
  cdp._listen();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // ── Cold-cache clear (Cache + IndexedDB + SW + cookies) ──
  console.log('\nClearing storage (cold-cache)...');
  const origin = new URL(APP_URL).origin;
  try {
    await cdp.send('Storage.clearDataForOrigin', {
      origin,
      storageTypes: 'all',
    });
    record('cold-cache', { origin, cleared: true, cold_cache: true });
    log(`Storage cleared for ${origin} (Cache + IndexedDB + SW + cookies)`);
  } catch (e) {
    record('cold-cache', { error: e.message });
    log(`Storage clear skipped: ${e.message}`, false);
  }

  // ── Navigate ──
  console.log(`\nNavigating to ${APP_URL}...`);
  await cdp.navigate(APP_URL);
  record('navigate', { url: APP_URL });
  log(`Page loaded`);

  // ── Wait for WASM backend ──
  console.log('\nWaiting for wasmBooleanBackend to register...');
  const wasmStart = Date.now();
  let backendId = null;
  while (Date.now() - wasmStart < WASM_TIMEOUT_MS) {
    try {
      backendId = await cdp.eval('typeof __booleanBackendId === "function" ? __booleanBackendId() : null');
    } catch { /* not ready yet */ }
    if (backendId === 'wasm-kern') break;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  const wasmElapsedMs = Date.now() - wasmStart;

  record('wasm-load', { backendId, elapsedMs: wasmElapsedMs });

  if (backendId !== 'wasm-kern') {
    const fallback = backendId ?? 'none';
    record('wasm-load-fail', { fallback });
    // Still continue — NurbsBooleanBackend also goes through resolveBackend, just at lower priority
    log(`wasmBooleanBackend NOT registered after ${wasmElapsedMs}ms — active backend: ${fallback}`, false);
    console.log('  (Continuing with available backend — will still test BREP path)');
  } else {
    log(`wasmBooleanBackend registered in ${wasmElapsedMs}ms`);
  }

  // ── Create two boxes (canonical BREPs) ──
  console.log('\nCreating two boxes...');

  // Box A: centered at [0,0,0.5] — 1×1×1
  const boxAResp = await cdp.eval(`JSON.stringify(__dispatchSync("SdBox", { width: 1, depth: 1, height: 1, center: [0,0,0.5] }))`);
  const boxA = JSON.parse(boxAResp);
  record('SdBox-A', boxA);
  const boxAResult = boxA.result ?? boxA;
  if (boxAResult.error) fail(`SdBox A failed: ${boxAResult.error}`);
  const uuidA = boxAResult.created ?? boxAResult.object_id;
  if (!uuidA || typeof uuidA !== 'string') fail(`SdBox A: could not extract UUID, got: ${JSON.stringify(boxAResult)}`);
  log(`Box A created: ${uuidA}`);

  // Box B: centered at [0.5,0.5,0.5] — partial overlap
  const boxBResp = await cdp.eval(`JSON.stringify(__dispatchSync("SdBox", { width: 1, depth: 1, height: 1, center: [0.5,0.5,0.5] }))`);
  const boxB = JSON.parse(boxBResp);
  record('SdBox-B', boxB);
  const boxBResult = boxB.result ?? boxB;
  if (boxBResult.error) fail(`SdBox B failed: ${boxBResult.error}`);
  const uuidB = boxBResult.created ?? boxBResult.object_id;
  if (!uuidB || typeof uuidB !== 'string') fail(`SdBox B: could not extract UUID, got: ${JSON.stringify(boxBResult)}`);
  log(`Box B created: ${uuidB}`);

  // ── SdBooleanUnion ──
  console.log('\nIssuing SdBooleanUnion...');
  const boolResp = await cdp.eval(`JSON.stringify(__dispatchSync("SdBooleanUnion", { a: "${uuidA}", b: "${uuidB}" }))`);
  const boolRaw = JSON.parse(boolResp);
  const boolResult = boolRaw.result ?? boolRaw;
  record('SdBooleanUnion', boolRaw);
  log(`SdBooleanUnion response: ${JSON.stringify(boolResult)}`);

  // ── Assert ──
  const displaySource = boolResult.displaySource;
  const routedBrep = displaySource === 'canonical-brep';
  const routedWasm = backendId === 'wasm-kern';

  record('assertions', { displaySource, backendId, routedBrep, routedWasm });

  console.log('\n--- Assertions ---');
  if (routedBrep) {
    log(`displaySource = "canonical-brep" ✔ (BREP path taken, not CSG fallback)`);
  } else {
    log(`displaySource = "${displaySource}" — BREP path NOT taken`, false);
  }
  if (routedWasm) {
    log(`backendId = "wasm-kern" ✔ (wasmBooleanBackend was active)`);
  } else {
    log(`backendId = "${backendId}" — wasmBooleanBackend not confirmed`, false);
  }

  // ── Screenshot ──
  console.log('\nCapturing screenshot...');
  const { data: imgBase64 } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
  const imgPath = join(outDir, 'g2-union-result.jpg');
  writeFileSync(imgPath, Buffer.from(imgBase64, 'base64'));
  record('screenshot', { path: imgPath });
  log(`Screenshot saved: ${imgPath}`);

  // ── Write run log ──
  const logPath = join(outDir, 'g2-run.jsonl');
  writeFileSync(logPath, runLog.map(e => JSON.stringify(e)).join('\n') + '\n');
  log(`Run log: ${logPath}`);

  // ── Summary ──
  const PASS = routedBrep && routedWasm;
  const overall = PASS ? 'PASS ✓' : 'PARTIAL (see assertions)';
  console.log(`\n=== G2 Overall: ${overall} ===`);
  console.log(`  Backend in use:    ${backendId ?? 'none'}`);
  console.log(`  BREP path taken:   ${routedBrep}`);
  console.log(`  WASM confirmed:    ${routedWasm}`);
  console.log(`  displaySource:     ${displaySource ?? 'none'}`);
  if (boolResult.error) console.log(`  Boolean error:     ${boolResult.error}`);
  console.log();

  record('summary', { overall: PASS ? 'PASS' : 'PARTIAL', backendId, routedBrep, routedWasm });
  writeFileSync(logPath, runLog.map(e => JSON.stringify(e)).join('\n') + '\n');

  if (!PASS) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
