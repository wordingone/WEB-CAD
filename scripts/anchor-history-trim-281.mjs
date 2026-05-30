/**
 * anchor-history-trim-281.mjs
 *
 * Verifies fix for #281 (d3d12-oom from KV-cache accumulation in active sessions).
 *
 * Protocol:
 *   - NO soft-reload between turns — exercises the real failure path
 *   - Sends N=8 NL turns in succession
 *   - After each turn: asserts no d3d12-oom / GPU-memory-exhausted error in console
 *   - Final assertion: all 8 turns produced non-empty assistant replies
 *
 * Pass = 8 turns complete, zero d3d12-oom, zero GPU-memory-exhausted
 * Fail = any OOM error detected, or any turn times out
 */

import WebSocket from "ws";

const CDP_HOST = "localhost:9222";
const PAGE_URL_PATTERN = /wordingone\.github\.io\/WEB-CAD/;
const TIMEOUT_MS = 15 * 60 * 1000; // 15 min total

// ── CDP helpers ──────────────────────────────────────────────────────────────

async function getTargetId() {
  const res = await fetch(`http://${CDP_HOST}/json`);
  const tabs = await res.json();
  const tab = tabs.find((t) => PAGE_URL_PATTERN.test(t.url));
  if (!tab) throw new Error(`No tab matching ${PAGE_URL_PATTERN}. Open tabs:\n${tabs.map((t) => t.url).join("\n")}`);
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
    timeout: 30_000,
  });
  if (result.exceptionDetails) {
    throw new Error(`Runtime exception: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result?.value;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(ws, expr, timeoutMs = 60_000, pollMs = 1_500, label = expr) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await evaluate(ws, expr).catch(() => null);
    if (val) return val;
    await sleep(pollMs);
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

// ── Console OOM capture ──────────────────────────────────────────────────────

const oomErrors = [];
function listenForOom(ws) {
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = msg.params.args?.map((a) => a.value ?? a.description ?? "").join(" ") ?? "";
      if (/d3d12|device lost|GPU memory exhausted|webgpu.*oom|oom.*webgpu/i.test(text)) {
        oomErrors.push(text);
      }
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const err = msg.params?.exceptionDetails?.exception;
      const text = err?.description ?? err?.value ?? JSON.stringify(err);
      if (/d3d12|device lost|GPU memory exhausted/i.test(text)) {
        oomErrors.push(`[uncaught] ${text}`);
      }
    }
  });
}

// ── NL chat helpers ──────────────────────────────────────────────────────────

async function chatMsgCount(ws) {
  return evaluate(ws, `document.querySelectorAll('.chat-msg-assistant').length`);
}

async function lastAssistantText(ws) {
  return evaluate(ws, `
    (() => {
      const msgs = document.querySelectorAll('.chat-msg-assistant');
      if (!msgs.length) return "";
      return msgs[msgs.length - 1]?.textContent?.trim() ?? "";
    })()
  `);
}

async function waitForNewMsg(ws, countBefore, timeoutMs = 4 * 60_000) {
  const deadline = Date.now() + timeoutMs;

  // Phase 1: wait for assistant count to increase
  let appeared = false;
  while (Date.now() < deadline) {
    const n = await chatMsgCount(ws).catch(() => countBefore);
    if (n > countBefore) { appeared = true; break; }
    await sleep(1_500);
  }
  if (!appeared) throw new Error("Timeout: assistant message count never increased");

  // Phase 2: wait for ARC ready + button not disabled (streaming done)
  await waitFor(
    ws,
    `(window.__arc?.state === 'ready' || window.__arc?.state === 'failed') && !document.querySelector('.chat-send-btn')?.disabled`,
    deadline - Date.now(),
    1_000,
    "ARC ready + send button enabled",
  );
  await sleep(500); // settle

  return lastAssistantText(ws);
}

async function sendChat(ws, text) {
  // Type into chat input
  await evaluate(ws, `
    (() => {
      const inp = document.querySelector('.chat-input');
      if (!inp) throw new Error('no .chat-input');
      inp.value = ${JSON.stringify(text)};
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(200);
  // Click send
  await evaluate(ws, `document.querySelector('.chat-send-btn')?.click()`);
}

// ── Verify ARC ready + button enabled ────────────────────────────────────────

async function waitArcReady(ws, timeoutMs = 5 * 60_000) {
  return waitFor(
    ws,
    `window.__arc?.state === 'ready' && window.__arc?.chatInputEnabled === true && !document.querySelector('.chat-send-btn')?.disabled`,
    timeoutMs,
    2_000,
    "ARC ready + chatInputEnabled + button enabled",
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const log = (...a) => console.log(new Date().toISOString(), ...a);
  const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };
  const pass = (msg) => { console.log("PASS:", msg); };

  const id = await getTargetId();
  log("target:", id);

  const ws = await connect(id);
  await send(ws, "Runtime.enable");
  listenForOom(ws);

  // ── Step 1: verify ARC is ready WITHOUT any reload ───────────────────────
  log("[1] Waiting for ARC ready (no reload)…");
  await waitArcReady(ws, 5 * 60_000);
  log("[1] ARC ready");

  // ── Step 2: set scene — one box for context ──────────────────────────────
  log("[2] Setting up scene (one box)…");
  await evaluate(ws, `window.__dispatchSync("SdClearScene", {})`);
  await sleep(300);
  await evaluate(ws, `window.__dispatchSync("SdBox", { width: 2, height: 1, depth: 1 })`);
  await sleep(300);
  log("[2] Scene ready");

  // ── Steps 3–10: 8 NL turns WITHOUT soft-reload ──────────────────────────
  const turns = [
    "how many objects are in the scene?",
    "what kind of object is it?",
    "what are the scene's dimensions?",
    "is the box visible?",
    "what's the width of the box?",
    "what's the height of the box?",
    "what's the depth of the box?",
    "describe the scene in one sentence",
  ];

  const replies = [];
  for (let i = 0; i < turns.length; i++) {
    const q = turns[i];
    log(`[${i + 3}] Turn ${i + 1}/8: "${q}"`);

    // Check for OOM before each turn
    if (oomErrors.length > 0) {
      fail(`OOM detected before turn ${i + 1}: ${oomErrors[0]}`);
    }

    // Wait for send button available
    await waitArcReady(ws, 60_000);

    const countBefore = await chatMsgCount(ws);
    await sendChat(ws, q);
    const reply = await waitForNewMsg(ws, countBefore, 4 * 60_000);

    log(`[${i + 3}] Reply: "${reply.slice(0, 120)}"`);

    if (!reply || reply.length < 1) {
      fail(`Turn ${i + 1} produced empty reply`);
    }

    // Check OOM after each turn
    if (oomErrors.length > 0) {
      fail(`OOM detected after turn ${i + 1}: ${oomErrors[0]}`);
    }

    replies.push({ turn: i + 1, q, reply });
    await sleep(500);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const oomAfter = oomErrors.length;
  log("=== RESULTS ===");
  for (const { turn, q, reply } of replies) {
    pass(`Turn ${turn}: "${q.slice(0, 40)}" → "${reply.slice(0, 80)}"`);
  }
  if (oomAfter > 0) {
    fail(`${oomAfter} OOM error(s) detected:\n${oomErrors.join("\n")}`);
  }

  pass(`All 8 turns completed, zero d3d12-oom (OOM count: ${oomAfter})`);
  ws.close();
  process.exit(0);
}

run().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
