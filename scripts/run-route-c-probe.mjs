#!/usr/bin/env node
// run-route-c-probe.mjs — navigate CDP browser to route-c probe, poll for __routeCResult.
// Reports timing + decode output for Leo's #72 MTP_DECODE_CONTRACT.md cert evidence.
// Run: node scripts/run-route-c-probe.mjs

import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as WebSocket from 'ws'; // fallback to raw WS

const PROBE_URL = 'https://wordingone.github.io/WEB-CAD/litert-route-c-probe.html';
const CDP_PORT = 9222;
const POLL_INTERVAL_MS = 30_000;
const MAX_WAIT_MS = 4 * 60 * 60 * 1000; // 4 hours (model dl + init on CPU)
const CERT_OUT = 'state/route-c-cert.json';

// ── CDP helpers ──────────────────────────────────────────────────────────────

function cdpGet(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: CDP_PORT, path }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

async function getPages() {
  return cdpGet('/json');
}

async function openNewTab(url) {
  // Chrome 120+ requires PUT for /json/new (CSRF protection). Try PUT, fall back to GET.
  const tryMethod = (method) => new Promise((resolve, reject) => {
    const opts = { host: 'localhost', port: CDP_PORT, path: `/json/new?${url}`, method };
    const req = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.end();
  });
  const r = await tryMethod('PUT').catch(() => null);
  if (r?.webSocketDebuggerUrl) return r;
  return tryMethod('GET').catch(() => null);
}

async function findProbeTab(beforeIds) {
  // Poll /json until a new page tab appears (Chrome can lag behind /json/new response)
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const all = await getPages();
    const fresh = all.find(p => p.type === 'page' && !beforeIds.has(p.id) && p.webSocketDebuggerUrl);
    if (fresh) return fresh;
    const probe = all.find(p => p.url && p.url.includes('litert-route-c-probe') && p.webSocketDebuggerUrl);
    if (probe) return probe;
  }
  return null;
}

class CdpSession {
  constructor(wsUrl) {
    this.ws = null;
    this.wsUrl = wsUrl;
    this.msgId = 1;
    this.pending = new Map();
    this.events = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      // Use native ws module or dynamic import
      const ws = new (require('ws'))(this.wsUrl);
      this.ws = ws;
      ws.on('open', resolve);
      ws.on('error', reject);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        } else if (msg.method) {
          this.events.push(msg);
        }
      });
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  drainEvents() {
    const e = [...this.events]; this.events = []; return e;
  }

  close() { if (this.ws) this.ws.close(); }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const t0global = Date.now();
console.log(`[probe] Starting route-c probe driver`);
console.log(`[probe] Target: ${PROBE_URL}`);

let ws;
try {
  ws = await import('ws');
  // Make ws available globally for CdpSession
  global.require = (m) => { if (m === 'ws') return ws.WebSocket || ws.default; throw new Error(`unknown: ${m}`); };
} catch (e) {
  console.error('[probe] ws module not found — install with: bun add ws');
  process.exit(1);
}

// Check CDP is available
let pages;
try {
  pages = await getPages();
} catch (e) {
  console.error(`[probe] CDP not available at :${CDP_PORT}: ${e.message}`);
  process.exit(1);
}
console.log(`[probe] CDP alive, ${pages.length} tabs`);

// Open probe tab
console.log(`[probe] Opening probe tab...`);
const beforeIds = new Set(pages.map(p => p.id));
let probeTab = await openNewTab(PROBE_URL);
if (!probeTab?.webSocketDebuggerUrl) {
  console.log(`[probe] /json/new didn't return wsUrl, scanning tab list...`);
  probeTab = await findProbeTab(beforeIds);
}
if (!probeTab?.webSocketDebuggerUrl) {
  // Last resort: reuse any existing page tab and navigate it
  probeTab = pages.find(p => p.type === 'page' && p.webSocketDebuggerUrl);
  if (probeTab) console.log(`[probe] Falling back to existing tab: ${probeTab.id}`);
}
if (!probeTab?.webSocketDebuggerUrl) {
  console.error('[probe] No tab with webSocketDebuggerUrl available'); process.exit(1);
}
console.log(`[probe] Using tab: ${probeTab.id} ws=${probeTab.webSocketDebuggerUrl.slice(0, 60)}...`);

const session = new CdpSession(probeTab.webSocketDebuggerUrl);
try {
  await session.connect();
} catch (e) {
  console.error(`[probe] WS connect failed: ${e.message}`);
  process.exit(1);
}

// Enable logging
await session.send('Runtime.enable');
await session.send('Log.enable');

// Enable Page domain for screenshots
await session.send('Page.enable');

// Navigate to probe
console.log(`[probe] Navigating to ${PROBE_URL}...`);
await session.send('Page.navigate', { url: PROBE_URL });
// Wait for initial render, then capture "before" screenshot
await new Promise(r => setTimeout(r, 4000));
try {
  const shot = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
  fs.mkdirSync('state', { recursive: true });
  fs.writeFileSync('state/route-c-before.jpg', Buffer.from(shot.data, 'base64'));
  console.log(`[probe] before.jpg saved`);
} catch (e) { console.log(`[probe] before screenshot failed: ${e.message}`); }
console.log(`[probe] Navigation dispatched. Polling every ${POLL_INTERVAL_MS/1000}s...`);

// Poll for __routeCResult
const startTs = Date.now();
let lastLogLine = '';
let done = false;

while (!done && (Date.now() - startTs) < MAX_WAIT_MS) {
  await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

  const elapsed = ((Date.now() - startTs) / 1000).toFixed(0);

  // Drain console events
  const events = session.drainEvents();
  for (const ev of events) {
    if (ev.method === 'Runtime.consoleAPICalled') {
      const text = ev.params.args?.map(a => a.value ?? a.description ?? '').join(' ') || '';
      if (text !== lastLogLine) {
        console.log(`[probe/${elapsed}s] ${text.slice(0, 200)}`);
        lastLogLine = text;
      }
    } else if (ev.method === 'Log.entryAdded') {
      const text = ev.params.entry?.text || '';
      console.log(`[probe/log/${elapsed}s] ${text.slice(0, 200)}`);
    } else if (ev.method === 'Runtime.exceptionThrown') {
      const err = ev.params.exceptionDetails;
      console.error(`[probe/ERR/${elapsed}s] ${err.text}: ${err.exception?.description || ''}`);
    }
  }

  // Check for result
  let resultJson;
  try {
    const r = await session.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__routeCResult || null)',
      returnByValue: true
    });
    resultJson = r.result?.value;
  } catch (e) {
    console.log(`[probe/${elapsed}s] evaluate error: ${e.message}`);
    continue;
  }

  if (resultJson && resultJson !== 'null') {
    let result;
    try { result = JSON.parse(resultJson); } catch { result = { raw: resultJson }; }
    if (result !== null && result.verdict) {
      console.log(`\n[probe] ✓ RESULT at ${elapsed}s:`);
      console.log(JSON.stringify(result, null, 2));

      // Capture full log from DOM
      let fullLog = '';
      try {
        const logR = await session.send('Runtime.evaluate', {
          expression: 'document.getElementById("log")?.innerText || ""',
          returnByValue: true
        });
        fullLog = logR.result?.value || '';
      } catch {}

      // Capture "after" screenshot
      try {
        const shot = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
        fs.writeFileSync('state/route-c-after.jpg', Buffer.from(shot.data, 'base64'));
        console.log(`[probe] after.jpg saved`);
      } catch (e) { console.log(`[probe] after screenshot failed: ${e.message}`); }

      // Write cert
      const cert = {
        ts: new Date().toISOString(),
        cold_cache: true,
        clear_protocol: 'fresh tab via CDP PUT /json/new, no prior OPFS cache',
        probe_url: PROBE_URL,
        elapsed_s: Number(elapsed),
        screenshots: { before: 'state/route-c-before.jpg', after: 'state/route-c-after.jpg' },
        result,
        log_tail: fullLog.slice(-3000),
      };

      fs.mkdirSync('state', { recursive: true });
      fs.writeFileSync(CERT_OUT, JSON.stringify(cert, null, 2));
      console.log(`\n[probe] Cert written to ${CERT_OUT}`);
      console.log(`[probe] verdict: ${result.verdict}`);
      if (result.textOutput) console.log(`[probe] textOutput: "${result.textOutput}"`);
      if (result.visionOutput) console.log(`[probe] visionOutput: "${result.visionOutput}"`);
      done = true;
    }
  } else {
    // Check for fatal error in page DOM
    try {
      const errR = await session.send('Runtime.evaluate', {
        expression: '(document.getElementById("log")?.innerText || "").includes("FATAL") ? document.getElementById("log").innerText.slice(-500) : null',
        returnByValue: true
      });
      if (errR.result?.value) {
        console.log(`[probe/${elapsed}s] PAGE FATAL:\n${errR.result.value}`);
        // Write error cert
        const cert = {
          ts: new Date().toISOString(),
          cold_cache: true,
          clear_protocol: 'fresh tab opened via CDP',
          probe_url: PROBE_URL,
          elapsed_s: Number(elapsed),
          result: { ok: false, verdict: 'FATAL', error: errR.result.value.slice(-300) },
        };
        fs.mkdirSync('state', { recursive: true });
        fs.writeFileSync(CERT_OUT, JSON.stringify(cert, null, 2));
        done = true;
      } else {
        // Still loading — print progress
        const progressR = await session.send('Runtime.evaluate', {
          expression: '(document.getElementById("log")?.innerText || "").split("\\n").filter(l=>l.trim()).slice(-2).join(" | ")',
          returnByValue: true
        });
        const progress = progressR.result?.value || '(no log yet)';
        console.log(`[probe/${elapsed}s] still loading... ${progress.slice(0, 120)}`);
      }
    } catch (e) {
      console.log(`[probe/${elapsed}s] poll error: ${e.message}`);
    }
  }
}

session.close();
if (!done) {
  console.log(`[probe] TIMEOUT after ${MAX_WAIT_MS/1000}s`);
  process.exit(1);
}
process.exit(0);
