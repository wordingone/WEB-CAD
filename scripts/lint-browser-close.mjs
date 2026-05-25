#!/usr/bin/env bun
// lint-browser-close.mjs — guard against unsafe browser/tab close calls in test scripts.
// Rule (WEB-CAD#1, 2026-05-25): test scripts must NOT close pre-existing user browser tabs.
// Scripts that connect to :9222 must leave the browser in exactly the state they found it.
// Exit 0 = clean; exit 1 = violations found.
//
// A close call is SAFE if it closes a tab/browser the script itself created or launched.
// A close call is UNSAFE if it could close a pre-existing user tab.
//
// Inline bypass: add `// lint-browser-close:ok reason` comment on the same line.
// File bypass: add file path + reason to FILE_ALLOWLIST below (for legacy scripts).

import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Patterns that indicate a browser/tab close operation
const CLOSE_PATTERNS = [
  /Target\.closeTarget/,
  /Browser\.close\b/,
  /browser\.close\s*\(/,
  /page\.close\s*\(/,
  /context\.close\s*\(/,
];

// File-level allowlist for legacy scripts with legitimate close patterns.
// Each entry: { file, reason }. Must be explicit and auditable.
const FILE_ALLOWLIST = [
  // Playwright scripts that LAUNCH their own browser (not the shared :9222 browser).
  // They do not connect to :9222 and close only browsers they launched.
  { file: "scripts/fresh-device-e2e-proof.mjs",  reason: "Playwright-launched browser (chromium.launch), not shared :9222" },
  { file: "scripts/verify-skill-fastpath.ts",     reason: "Playwright-launched browser (chromium.launch), not shared :9222" },
  // Isolated-mode guard: browser.close() only reachable when --isolated flag passed.
  { file: "scripts/gemma-verify-cdp.ts",          reason: "isolated-mode only: closes playwright browser launched with --isolated flag" },
  // Closes only a tab it opened (new target created at start, targetId is local to script)
  { file: "scripts/verify-fastpath-5183.mjs",     reason: "closes targetId created by this script via Target.createTarget at start" },
  // Deprecated sweep utility — closes stale non-canonical tabs, not the main user tab
  { file: "scripts/shared-browser-sweep.mjs",     reason: "sweeps stale non-canonical tabs only; main user tab is excluded by URL filter" },
];

// Lines that are always safe regardless of file (no-op patches, safety guards, comments)
const LINE_ALLOWLIST = [
  /^\s*\/\//,                              // comment-only line
  /NEVER close/,                           // explaining the rule
  /refusing to close user tab/,            // safety guard message
  /browser\.close\s*=\s*async\s*\(\)/,    // no-op patch: browser.close = async () => {}
  /lint-browser-close:ok/,                // inline bypass comment
  /userTabIds\.has\(/,                    // user-tab protection check
  /if\s*\(userTabIds/,                    // guard block
];

// Files to scan
function collectFiles(dir, exts = [".mjs", ".ts", ".js"]) {
  const results = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory() && name !== "node_modules" && name !== ".git") {
      results.push(...collectFiles(full, exts));
    } else if (stat.isFile() && exts.includes(extname(name))) {
      results.push(full);
    }
  }
  return results;
}

const SCRIPTS_DIR = join(ROOT, "scripts");
const scanFiles = collectFiles(SCRIPTS_DIR);
const allowlistedFiles = new Set(FILE_ALLOWLIST.map(e => e.file));

let violations = 0;

for (const filePath of scanFiles) {
  const rel = filePath.replace(ROOT + "\\", "").replace(ROOT + "/", "").replace(/\\/g, "/");

  // File-level allowlist
  if (allowlistedFiles.has(rel)) continue;

  const lines = readFileSync(filePath, "utf-8").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hasCloseCall = CLOSE_PATTERNS.some(p => p.test(line));
    if (!hasCloseCall) continue;
    const isSafe = LINE_ALLOWLIST.some(p => p.test(line));
    if (isSafe) continue;

    // Check adjacent lines for safety guard context
    const prev = lines[i - 1] ?? "";
    const prevSafe = LINE_ALLOWLIST.some(p => p.test(prev));
    if (prevSafe) continue;

    console.error(`VIOLATION ${rel}:${i + 1}: unsafe browser/tab close: ${line.trim().slice(0, 120)}`);
    violations++;
  }
}

if (violations > 0) {
  console.error(`\nlint:no-browser-close FAIL — ${violations} violation(s). See WEB-CAD#1.`);
  console.error("Fix: add // lint-browser-close:ok reason on the same line, or add file to FILE_ALLOWLIST with justification.");
  process.exit(1);
} else {
  console.log(`lint:no-browser-close OK — no unsafe browser-close violations in scripts/`);
  process.exit(0);
}
