#!/usr/bin/env node
// nav-to-master.mjs — navigate shared browser to master Pages deployment.
// Run before verify scripts that don't self-navigate.
import { WebSocket } from "ws";
import { execSync } from "child_process";
import { CDP_PORT } from "./ports.mjs";

const MASTER_URL = "https://wordingone.github.io/WEB-CAD/";
const targets = JSON.parse(execSync(`curl -s http://localhost:${CDP_PORT}/json`, { encoding: "utf8" }));
const target = targets.find(t => t.type === "page");
if (!target) { console.error("No page target"); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
ws.on("message", raw => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg.result ?? {});
  }
});
const send = (method, params = {}) => new Promise(resolve => {
  const mid = id++;
  pending.set(mid, { resolve });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const delay = ms => new Promise(r => setTimeout(r, ms));

console.log(`navigating to ${MASTER_URL} ...`);
await send("Page.enable");
await send("Page.navigate", { url: MASTER_URL });
await delay(3_000);
const currentUrl = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
console.log(`now at: ${currentUrl.result?.value}`);
ws.close();
