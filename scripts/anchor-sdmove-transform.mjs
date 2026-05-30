/**
 * anchor-sdmove-transform.mjs
 *
 * 8-turn no-reload anchor for SdMove agent dispatch.
 * Leo directive: assert SCENE EFFECT (position delta > epsilon), not just dispatch fired.
 *
 * Pass = all 8 turns dispatch successfully (status:"success") AND scene position changes
 * Fail = any turn dispatches "error", echoes text without dispatch, or position unchanged
 */

import WebSocket from "ws";

const CDP_HOST = "localhost:9222";
const PAGE_URL_PATTERN = /wordingone\.github\.io\/WEB-CAD/;
const EPSILON = 0.01; // meters

const TURNS = [
  { q: "move the box 1 foot east",   verb: "SdMove", expectEffect: true },
  { q: "move it 2 feet north",       verb: "SdMove", expectEffect: true },
  { q: "move it 1 foot west",        verb: "SdMove", expectEffect: true },
  { q: "undo",                       verb: "SdUndo", expectEffect: true },
  { q: "move the box up 1 foot",     verb: "SdMove", expectEffect: true },
  { q: "move it back down 1 foot",   verb: "SdMove", expectEffect: true },
  { q: "move 3 feet south",          verb: "SdMove", expectEffect: true },
  { q: "undo the last move",         verb: "SdUndo", expectEffect: true },
];

async function getTargetId() {
  const res = await fetch(`http://${CDP_HOST}/json`);
  const tabs = await res.json();
  const tab = tabs.find((t) => PAGE_URL_PATTERN.test(t.url));
  if (!tab) throw new Error(`No tab matching ${PAGE_URL_PATTERN}`);
  return tab.id;
}

function connect(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${CDP_HOST}/devtools/page/${id}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

let _cmdId = 1;
function send(ws, method, params = {}) {
  const id = _cmdId++;
  return new Promise((resolve, reject) => {
    const handle = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === id) {
        ws.off("message", handle);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.on("message", handle);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression) {
  const result = await send(ws, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 60_000,
  });
  if (result.exceptionDetails) throw new Error(`Runtime exception: ${JSON.stringify(result.exceptionDetails)}`);
  return result.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(ws, expr, timeoutMs = 60_000, pollMs = 1_500, label = expr) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await evaluate(ws, expr).catch(() => null);
    if (val) return val;
    await sleep(pollMs);
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

async function waitArcReady(ws, timeoutMs = 5 * 60_000) {
  return waitFor(
    ws,
    `window.__arc?.state === 'ready' && window.__arc?.chatInputEnabled === true && !document.querySelector('.chat-send-btn')?.disabled`,
    timeoutMs, 2_000, "ARC ready",
  );
}

async function chatMsgCount(ws) {
  return evaluate(ws, `document.querySelectorAll('.chat-msg-assistant').length`);
}

async function sendChat(ws, text) {
  await evaluate(ws, `(() => {
    const inp = document.querySelector('.chat-input');
    if (!inp) throw new Error('no .chat-input');
    inp.value = ${JSON.stringify(text)};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(200);
  await evaluate(ws, `document.querySelector('.chat-send-btn')?.click()`);
}

async function waitForNewMsg(ws, countBefore, timeoutMs = 4 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = await chatMsgCount(ws).catch(() => countBefore);
    if (n > countBefore) break;
    await sleep(1_500);
  }
  await waitFor(
    ws,
    `(window.__arc?.state === 'ready' || window.__arc?.state === 'failed') && !document.querySelector('.chat-send-btn')?.disabled`,
    deadline - Date.now(), 1_000, "ARC ready after msg",
  );
  await sleep(500);
}

async function capturePosition(ws, uuid) {
  return evaluate(ws, `(() => {
    const obj = window.__viewer?.getScene?.()?.getObjectByProperty("uuid", ${JSON.stringify(uuid)});
    return obj ? [obj.position.x, obj.position.y, obj.position.z] : null;
  })()`);
}

function posDelta(a, b) {
  if (!a || !b) return null;
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

async function getLastLedgerEntry(ws, expectedVerb, ledgerSizeBefore) {
  const ledger = await evaluate(ws, `window.__dispatchLedger ?? []`);
  if (!Array.isArray(ledger) || ledger.length <= ledgerSizeBefore) return null;
  const entries = ledger.slice(ledgerSizeBefore);
  return entries.find((e) => e.verb === expectedVerb) ?? null;
}

async function getLedgerSize(ws) {
  const len = await evaluate(ws, `(window.__dispatchLedger ?? []).length`);
  return typeof len === "number" ? len : 0;
}

async function run() {
  const log = (...a) => console.log(new Date().toISOString(), ...a);
  const pass = (msg) => console.log("PASS:", msg);
  const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };

  const id = await getTargetId();
  log("target:", id);
  const ws = await connect(id);
  await send(ws, "Runtime.enable");

  log("[1] Soft-reload…");
  const currentUrl = await evaluate(ws, "location.href");
  await send(ws, "Page.navigate", { url: currentUrl });
  await waitFor(ws, "document.readyState === 'complete'", 30_000, 500);
  await waitArcReady(ws, 10 * 60_000);
  log("[1] ARC ready");

  log("[2] Setting scene (one box)…");
  await evaluate(ws, `window.__dispatchSync("SdClearScene", {})`);
  await sleep(300);
  const sdBoxJson = await evaluate(ws, `JSON.stringify(window.__dispatchSync("SdBox", { width: 2, height: 1, depth: 1 }))`);
  await sleep(300);
  const sdBoxResult = sdBoxJson ? JSON.parse(sdBoxJson) : null;
  const boxUuid = sdBoxResult?.result?.created ?? sdBoxResult?.result?.object_id ?? null;
  if (!boxUuid) fail(`SdBox dispatch failed or returned no UUID: ${sdBoxJson}`);
  log("[2] Box UUID:", boxUuid);

  await evaluate(ws, `window.__dispatchLedger = []`);

  const results = [];

  for (let i = 0; i < TURNS.length; i++) {
    const { q, verb, expectEffect } = TURNS[i];
    log(`[T${i + 1}] "${q}"`);

    await waitArcReady(ws, 60_000);
    const posBefore = await capturePosition(ws, boxUuid);
    const ledgerBefore = await getLedgerSize(ws);
    const countBefore = await chatMsgCount(ws);

    await sendChat(ws, q);
    await waitForNewMsg(ws, countBefore, 4 * 60_000);

    const posAfter = await capturePosition(ws, boxUuid);
    const delta = posDelta(posBefore, posAfter);

    const ledgerEntry = await getLastLedgerEntry(ws, verb, ledgerBefore);
    const domText = await evaluate(ws, `(() => {
      const msgs = document.querySelectorAll('.chat-msg-assistant');
      return msgs.length ? msgs[msgs.length-1]?.textContent?.trim() ?? "" : "";
    })()`);

    log(`[T${i + 1}] pos before: ${JSON.stringify(posBefore)}`);
    log(`[T${i + 1}] pos after:  ${JSON.stringify(posAfter)}`);
    log(`[T${i + 1}] delta: ${delta?.toFixed(4)}m`);
    log(`[T${i + 1}] ledger: ${JSON.stringify(ledgerEntry)}`);
    log(`[T${i + 1}] DOM: "${domText?.slice(0, 100)}"`);

    const dispatched = !!ledgerEntry;
    const dispatchOk = dispatched && ledgerEntry.status === "success";
    const effectOk = !expectEffect || (delta !== null && delta > EPSILON);

    if (!dispatched) {
      fail(`T${i + 1} "${q}": no ${verb} in ledger — model may have echoed text without dispatch`);
    }
    if (!dispatchOk) {
      fail(`T${i + 1} "${q}": ${verb} status="${ledgerEntry?.status}" (expected "success") — ${JSON.stringify(ledgerEntry)}`);
    }
    if (!effectOk) {
      fail(`T${i + 1} "${q}": position delta ${delta?.toFixed(4)}m <= epsilon ${EPSILON}m — no scene effect`);
    }

    pass(`T${i + 1}: "${q}" → delta=${delta?.toFixed(4)}m, ${verb} status:success`);
    results.push({ turn: i + 1, q, delta, status: ledgerEntry.status });
    await sleep(500);
  }

  log("=== RESULTS ===");
  for (const { turn, q, delta, status } of results) {
    pass(`Turn ${turn}: "${q.slice(0, 40)}" delta=${delta?.toFixed(4)}m status:${status}`);
  }
  pass(`All 8 SdMove turns passed with scene-effect assertions`);
  ws.close();
  process.exit(0);
}

run().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
