#!/usr/bin/env node
// shared-browser-watch.mjs — periodic sweep driver.
//
// Runs shared-browser-sweep.mjs immediately, then every INTERVAL_MS.
// Spawned by `bun run shared-browser:start` alongside the Chromium process.
//
// Usage: node scripts/shared-browser-watch.mjs [--interval-ms=600000]

import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SWEEP = join(ROOT, "scripts", "shared-browser-sweep.mjs");
const INTERVAL_MS = Number(
  process.argv.find((a) => a.startsWith("--interval-ms="))?.split("=")[1] ?? 600_000,
);

// Forward --canonical-url= args from this watcher's argv down to each sweep invocation.
const FORWARD_ARGS = process.argv.slice(2).filter((a) => a.startsWith("--canonical-url="));

function runSweep() {
  const child = spawn(process.execPath, [SWEEP, ...FORWARD_ARGS], { stdio: "inherit" });
  child.on("error", (e) => console.error(`sweep spawn error: ${e.message}`));
}

runSweep();
setInterval(runSweep, INTERVAL_MS);
console.log(`shared-browser-watch: sweep every ${INTERVAL_MS / 1000}s`);
