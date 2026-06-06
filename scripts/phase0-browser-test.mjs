#!/usr/bin/env bun
/**
 * Phase 0 browser load test via raw CDP (no playwright dep, Bun built-in WS).
 * Navigates to deployed Pages test page, clicks "Run test", waits for result.
 */

const PAGES_URL = 'https://wordingone.github.io/WEB-CAD/phase0-llm-test.html';
const CDP_HOST  = 'localhost:9222';
const TIMEOUT_MS = 150_000;   // WASM cold load + CPU inference

async function cdpGet(path) {
  const r = await fetch(`http://${CDP_HOST}${path}`);
  return r.json();
}

async function main() {
  const tabs = await cdpGet('/json/list');
  let tab = tabs.find(t => t.url?.includes('wordingone.github.io'));
  if (!tab) tab = tabs.find(t => t.type === 'page' && !t.url?.startsWith('devtools://'));
  if (!tab) throw new Error('No usable tab. Tabs: ' + JSON.stringify(tabs.map(t => t.url)));
  console.log(`Tab: ${tab.id}  (${tab.url})`);

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 1;
  const pending = new Map();
  const events  = [];

  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = msgId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  await send('Runtime.enable');
  await send('Page.enable');

  console.log(`Navigating to ${PAGES_URL} ...`);
  await send('Page.navigate', { url: PAGES_URL });

  // Wait for loadEventFired
  const loaded = await Promise.race([
    new Promise(res => {
      const iv = setInterval(() => {
        if (events.some(e => e.method === 'Page.loadEventFired')) { clearInterval(iv); res('loaded'); }
      }, 200);
    }),
    sleep(20_000).then(() => 'timeout'),
  ]);
  if (loaded === 'timeout') console.warn('Load timeout — continuing anyway');
  await sleep(1000);

  console.log('Clicking "Run test"...');
  await send('Runtime.evaluate', { expression: `document.getElementById('run').click(); 'ok'` });

  console.log(`Polling for window.__phase0Result (up to ${TIMEOUT_MS/1000}s)...`);
  const t0 = Date.now();
  let result = null;
  let lastLog = '';

  while (Date.now() - t0 < TIMEOUT_MS) {
    await sleep(3000);

    // Read current log for progress
    const logR = await send('Runtime.evaluate', {
      expression: `document.getElementById('log')?.innerText ?? ''`,
      returnByValue: true,
    });
    const logText = logR?.result?.value ?? '';
    if (logText !== lastLog) {
      const diff = logText.slice(lastLog.length).trim();
      if (diff) process.stdout.write('\n  ' + diff.split('\n').slice(-3).join(' | '));
      lastLog = logText;
    }

    // Check for result
    const r = await send('Runtime.evaluate', {
      expression: `JSON.stringify(window.__phase0Result)`,
      returnByValue: true,
    });
    const raw = r?.result?.value;
    if (raw && raw !== 'null') { result = JSON.parse(raw); break; }
  }

  ws.close();

  console.log('\n\n--- window.__phase0Result ---');
  console.log(JSON.stringify(result, null, 2));

  if (!result) { console.log('TIMEOUT'); process.exit(1); }
  if (result.ok) { console.log('\nPASS: loads AND generates'); process.exit(0); }
  else { console.log('\nFAIL:', result.error); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
