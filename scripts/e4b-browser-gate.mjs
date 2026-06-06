#!/usr/bin/env bun
/**
 * E4B browser gate — CDP test for Leo's #19 item (c).
 * Navigates to deployed Pages e4b-llm-test.html, clicks "Run browser gate",
 * waits for __e4bResult, reports peak WASM heap + engine output verbatim.
 *
 * Runtime: bun (built-in WebSocket, no ws dep needed)
 * Usage:   bun scripts/e4b-browser-gate.mjs
 */

const PAGES_URL  = 'https://wordingone.github.io/WEB-CAD/e4b-llm-test.html';
const CDP_HOST   = 'localhost:9222';
const TIMEOUT_MS = 30 * 60 * 1000;  // 30 min: 4.4 GB download + engine init

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

  console.log(`\nNavigating to ${PAGES_URL} ...`);
  await send('Page.navigate', { url: PAGES_URL });

  const loaded = await Promise.race([
    new Promise(res => {
      const iv = setInterval(() => {
        if (events.some(e => e.method === 'Page.loadEventFired')) { clearInterval(iv); res('loaded'); }
      }, 200);
    }),
    sleep(30_000).then(() => 'timeout'),
  ]);
  if (loaded === 'timeout') console.warn('Load timeout — continuing anyway');
  await sleep(1500);

  console.log('Clicking "Run browser gate"...');
  await send('Runtime.evaluate', { expression: `document.getElementById('run').click(); 'ok'` });

  console.log(`\nPolling for window.__e4bResult (up to ${TIMEOUT_MS / 60000}min)...\n`);
  const t0 = Date.now();
  let result = null;
  let lastLog = '';

  while (Date.now() - t0 < TIMEOUT_MS) {
    await sleep(5000);

    const logR = await send('Runtime.evaluate', {
      expression: `document.getElementById('log')?.innerText ?? ''`,
      returnByValue: true,
    });
    const logText = logR?.result?.value ?? '';
    if (logText !== lastLog) {
      const diff = logText.slice(lastLog.length).trim();
      if (diff) process.stdout.write('\n  ' + diff.split('\n').slice(-4).join(' | '));
      lastLog = logText;
    }

    const r = await send('Runtime.evaluate', {
      expression: `JSON.stringify(window.__e4bResult)`,
      returnByValue: true,
    });
    const raw = r?.result?.value;
    if (raw && raw !== 'null') { result = JSON.parse(raw); break; }
  }

  // Capture final heap reading from page
  const heapR = await send('Runtime.evaluate', {
    expression: `document.getElementById('heap-info')?.innerText ?? ''`,
    returnByValue: true,
  });
  const heapText = heapR?.result?.value ?? '';

  ws.close();

  console.log('\n\n=== window.__e4bResult ===');
  console.log(JSON.stringify(result, null, 2));
  console.log('\n=== heap display ===');
  console.log(heapText);

  if (!result) {
    console.log('\nRESULT: TIMEOUT — no __e4bResult after ' + TIMEOUT_MS / 60000 + 'min');
    process.exit(1);
  }

  console.log('\n=== GATE SUMMARY ===');
  console.log(`Peak WASM heap:   ${result.peakHeapMB?.toFixed(1) ?? 'unknown'} MB`);
  if (result.steps?.generate?.output) {
    console.log(`Engine output:    ${result.steps.generate.output.slice(0, 200)}`);
  }
  if (result.ok) {
    console.log('RESULT: PASS — E4B loads and generates in browser');
    process.exit(0);
  } else {
    console.log('RESULT: FAIL —', result.error);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
