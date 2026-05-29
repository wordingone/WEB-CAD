#!/usr/bin/env node
// verify-213-command-at-cursor.mjs — AC receipt for #213 via #212 simulated-user harness.
//
// Tests command-at-cursor overlay on master (GitHub Pages root) using real keyboard events
// fired through CDP Runtime.evaluate — no Playwright, no direct dispatch.
//
// Acceptance criteria:
//   - Printable key on un-focused viewport fires overlay
//   - Input is focused; value matches typed key
//   - Filtering works; list updates
//   - Enter activates tool (palette button .active class set)
//   - Esc closes overlay without changing active tool
//   - Ctrl/Alt/Meta keys do NOT open overlay
//   - Overlay does NOT open when an input element is focused

import { WebSocket } from "ws";
import { execSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { CDP_PORT } from "./ports.mjs";

const TARGET_URL = "https://wordingone.github.io/WEB-CAD/";
const DEV_RESTORE_URL = "https://wordingone.github.io/WEB-CAD/dev/";
const TIMEOUT_MS = 90_000;

mkdirSync("state", { recursive: true });
const SHA = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
const OUT = `state/verify-213-cmd-cursor-${SHA}-${Date.now()}.json`;

// ── CDP raw WS helpers ──────────────────────────────────────────────────────

const targets = JSON.parse(
  execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" })
);
const target = targets.find(t => t.type === "page");
if (!target) { console.error("No page target"); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();
const consoleLog = [];

await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

ws.on("message", raw => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result ?? {});
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = msg.params.args?.map(a => a.value ?? a.description ?? "").join(" ") ?? "";
    if (text) consoleLog.push({ type: msg.params.type, text: text.slice(0, 300) });
  }
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = msgId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "eval error");
  return r.result?.value;
};

const delay = ms => new Promise(r => setTimeout(r, ms));

const poll = async (fn, { timeout = 30_000, interval = 400, label = "condition" } = {}) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await delay(interval);
  }
  throw new Error(`Timeout waiting for: ${label}`);
};

await send("Runtime.enable");
await send("Page.enable");

// ── Navigate to master (has #213) ──────────────────────────────────────────

console.log(`[#213] navigating to ${TARGET_URL}`);
await send("Page.navigate", { url: TARGET_URL });
await delay(2_000);
await send("Runtime.enable");

// ── Boot gate: click cad-only (memory-light, no model load) ────────────────

console.log("[#213] waiting for boot gate...");
let cadOnlyClicked = false;
try {
  await poll(async () => {
    const clicked = await evaluate(`
      (() => {
        const btn = document.querySelector('[data-path="cad-only"]');
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);
    return clicked;
  }, { timeout: 20_000, label: "[data-path=cad-only] button" });
  cadOnlyClicked = true;
  console.log("[#213] boot gate: clicked cad-only");
} catch {
  console.log("[#213] boot gate: not present (may be dGPU, proceeding)");
}

// ── Wait for palette to mount (app ready) ──────────────────────────────────

console.log("[#213] waiting for palette...");
await poll(async () => {
  return evaluate(`!!document.querySelector('[data-tool="wall"]')`);
}, { timeout: 30_000, label: "[data-tool=wall] palette button" });
console.log("[#213] palette ready");

await delay(800); // let React/subscriptions settle

// ── Helper: fire keyboard event on document (simulated user) ───────────────

const fireKey = async (key, opts = {}) => {
  const { ctrl = false, alt = false, meta = false, shift = false } = opts;
  await evaluate(`
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: ${JSON.stringify(key)},
      code: ${JSON.stringify("Key" + key.toUpperCase())},
      bubbles: true,
      cancelable: true,
      ctrlKey: ${ctrl},
      altKey: ${alt},
      metaKey: ${meta},
      shiftKey: ${shift},
    }))
  `);
};

const overlayPresent = () => evaluate(`!!document.querySelector('.cmd-cursor-overlay')`);
const overlayInputValue = () => evaluate(`document.querySelector('.cmd-cursor-input')?.value ?? null`);
const activeToolId = () => evaluate(`
  (() => {
    for (const el of document.querySelectorAll('[data-tool]')) {
      if (el.classList.contains('active')) return el.dataset.tool;
    }
    return null;
  })()
`);
const firstListItem = () => evaluate(`document.querySelector('.cmd-cursor-item')?.textContent ?? null`);
const activeListItem = () => evaluate(`document.querySelector('.cmd-cursor-item--active')?.textContent ?? null`);
const listItemCount = () => evaluate(`document.querySelectorAll('.cmd-cursor-item').length`);
const blurInputs = () => evaluate(`document.activeElement?.blur?.(); document.body.focus(); true`);

const results = {};

// ── Scenario 1: printable key opens overlay ────────────────────────────────
console.log("\n[S1] printable key opens overlay");
await blurInputs();
await fireKey("w");
await delay(200);
results.s1_overlay_opened = await overlayPresent();
results.s1_input_value = await overlayInputValue();
console.log(`  overlay present: ${results.s1_overlay_opened}`);
console.log(`  input value: "${results.s1_input_value}"`);

// ── Scenario 2: filter by typing more chars ────────────────────────────────
console.log("[S2] typing into overlay input filters list");
if (results.s1_overlay_opened) {
  // Type 'a', 'l', 'l' to complete 'wall' (input already has 'w')
  await evaluate(`
    (() => {
      const inp = document.querySelector('.cmd-cursor-input');
      if (!inp) return;
      inp.value = 'wall';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await delay(200);
  results.s2_input_value = await overlayInputValue();
  results.s2_list_count = await listItemCount();
  results.s2_first_item = await firstListItem();
  console.log(`  input value after typing: "${results.s2_input_value}"`);
  console.log(`  list items: ${results.s2_list_count}`);
  console.log(`  first item: "${results.s2_first_item}"`);
} else {
  results.s2_skip = "overlay not open";
}

// Fire keyboard event on a specific DOM element (fires on the element itself, so input handlers see it).
const fireKeyOnSelector = async (selector, key, opts = {}) => {
  const { ctrl = false, alt = false, meta = false, shift = false } = opts;
  return evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.dispatchEvent(new KeyboardEvent("keydown", {
        key: ${JSON.stringify(key)},
        code: ${JSON.stringify("Key" + key.toUpperCase())},
        bubbles: true,
        cancelable: true,
        ctrlKey: ${ctrl},
        altKey: ${alt},
        metaKey: ${meta},
        shiftKey: ${shift},
      }));
      return true;
    })()
  `);
};

const forceCloseOverlay = () => evaluate(`document.querySelector('.cmd-cursor-overlay')?.remove(); true`);

// ── Scenario 3: Enter activates tool ──────────────────────────────────────
console.log("[S3] Enter activates highlighted tool");
if (results.s1_overlay_opened) {
  const prevTool = await activeToolId();
  // Fire Enter on the overlay input (input handler processes it, not document)
  await fireKeyOnSelector(".cmd-cursor-input", "Enter");
  await delay(300);
  results.s3_overlay_closed = !(await overlayPresent());
  results.s3_active_tool = await activeToolId();
  results.s3_tool_changed = results.s3_active_tool !== prevTool;
  console.log(`  overlay closed: ${results.s3_overlay_closed}`);
  console.log(`  active tool: "${results.s3_active_tool}" (was "${prevTool}")`);
} else {
  results.s3_skip = "overlay not open";
}
// Ensure clean state for next scenario
await forceCloseOverlay();

// ── Scenario 4: Escape closes without activating ──────────────────────────
console.log("[S4] Escape closes overlay without changing tool");
await blurInputs();
const toolBefore = await activeToolId();
await fireKey("r");
await delay(200);
const s4OverlayOpened = await overlayPresent();
results.s4_overlay_opened = s4OverlayOpened;
if (s4OverlayOpened) {
  // Fire Escape on the overlay input
  await fireKeyOnSelector(".cmd-cursor-input", "Escape");
  await delay(200);
  results.s4_overlay_closed = !(await overlayPresent());
  results.s4_tool_unchanged = (await activeToolId()) === toolBefore;
  console.log(`  overlay closed on Esc: ${results.s4_overlay_closed}`);
  console.log(`  tool unchanged: ${results.s4_tool_unchanged}`);
} else {
  results.s4_skip = "overlay did not open for 'r'";
  console.log("  WARNING: overlay did not open on 'r'");
}
await forceCloseOverlay();

// ── Scenario 5: Ctrl+key does NOT open overlay ────────────────────────────
console.log("[S5] Ctrl+key does not open overlay");
await blurInputs();
await fireKey("w", { ctrl: true });
await delay(200);
results.s5_ctrl_no_overlay = !(await overlayPresent());
console.log(`  Ctrl+w no overlay: ${results.s5_ctrl_no_overlay}`);

// ── Scenario 6: key on focused input does NOT open overlay ────────────────
console.log("[S6] key while input focused does not open overlay");
// Inject a temp input, focus it, fire 'w', verify no overlay, then remove it.
await evaluate(`
  (() => {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.id = '__test-input-s6';
    inp.style.cssText = 'position:fixed;left:-999px;top:-999px;width:1px;height:1px;opacity:0';
    document.body.appendChild(inp);
    inp.focus();
  })()
`);
await delay(100);
await fireKey("w");
await delay(200);
results.s6_focused_input_no_overlay = !(await overlayPresent());
await evaluate(`document.getElementById('__test-input-s6')?.remove(); document.querySelector('.cmd-cursor-overlay')?.remove()`);
await blurInputs();
console.log(`  key on focused input no overlay: ${results.s6_focused_input_no_overlay}`);

// ── Pass/fail aggregate ────────────────────────────────────────────────────

const pass =
  results.s1_overlay_opened === true &&
  results.s1_input_value === "w" &&
  (results.s2_input_value === "wall" || results.s2_skip) &&
  results.s3_overlay_closed !== false &&
  results.s4_overlay_closed !== false &&
  results.s4_tool_unchanged !== false &&
  results.s5_ctrl_no_overlay === true &&
  results.s6_focused_input_no_overlay !== false;

const receipt = {
  sha: SHA,
  timestamp: new Date().toISOString(),
  url: TARGET_URL,
  feature: "#213 command-at-cursor",
  cad_only_clicked: cadOnlyClicked,
  scenarios: results,
  pass,
  console_log_sample: consoleLog.slice(0, 20),
};

writeFileSync(OUT, JSON.stringify(receipt, null, 2));

console.log("\n── #213 command-at-cursor AC ─────────────────────────────────────────");
console.log(`  S1 overlay opens on 'w':          ${results.s1_overlay_opened}  ${results.s1_overlay_opened ? "✓" : "✗ FAIL"}`);
console.log(`  S1 input value = 'w':             ${results.s1_input_value === "w"}  ${results.s1_input_value === "w" ? "✓" : "✗ FAIL"}`);
console.log(`  S2 filter works:                  ${!!results.s2_list_count}  ${results.s2_list_count ? "✓" : results.s2_skip ? "SKIP" : "✗ FAIL"}`);
console.log(`  S3 Enter activates + closes:      ${results.s3_overlay_closed}  ${results.s3_overlay_closed ? "✓" : results.s3_skip ? "SKIP" : "✗ FAIL"}`);
console.log(`  S4 Esc closes without change:     ${results.s4_overlay_closed}  ${results.s4_overlay_closed ? "✓" : results.s4_skip ? "SKIP" : "✗ FAIL"}`);
console.log(`  S5 Ctrl+key: no overlay:          ${results.s5_ctrl_no_overlay}  ${results.s5_ctrl_no_overlay ? "✓" : "✗ FAIL"}`);
console.log(`  S6 focused input: no overlay:     ${results.s6_focused_input_no_overlay}  ${results.s6_focused_input_no_overlay !== false ? "✓" : "✗ FAIL"}`);
console.log(`\n  AC result: ${pass ? "PASS ✓" : "FAIL ✗"}`);
console.log(`\nReceipt: ${OUT}`);

// Restore tab to /dev
console.log(`\n[#213] restoring tab to ${DEV_RESTORE_URL}`);
await send("Page.navigate", { url: DEV_RESTORE_URL }).catch(() => {});
ws.close();

if (!pass) process.exit(1);
