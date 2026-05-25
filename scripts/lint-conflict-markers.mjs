#!/usr/bin/env node
// lint-conflict-markers.mjs — guard against unresolved git merge conflict markers.
// Scans tracked source files for <<<<<<<, ======= (conflict-form), and >>>>>>> markers.
// Exit 0 = clean; exit 1 = violations found.
//
// Inline bypass: add `// lint-conflict-markers:ok reason` on the same line (test fixtures only).
// Run: node scripts/lint-conflict-markers.mjs

import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname, relative } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Extensions to scan — binary / lock / generated files excluded
const SCAN_EXTENSIONS = new Set([
  ".ts", ".mjs", ".js", ".cjs",
  ".html", ".css",
  ".json", ".yaml", ".yml",
  ".md",
]);

// Directories to skip entirely
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".turbo",
]);

// Conflict marker regex — matches git's exact 7-char sequences
// <<<<<<< always followed by a space + branch/HEAD label on the same line
// >>>>>>> always followed by a space + commit hash/label on the same line
// ======= on its own line (possibly with trailing whitespace)
const CONFLICT_PATTERNS = [
  { re: /^<{7} /m,  label: "conflict-start  (<<<<<<<)" },
  { re: /^={7}\s*$/m, label: "conflict-sep    (=======)" },
  { re: /^>{7} /m,  label: "conflict-end    (>>>>>>>)" },
];

function collectFiles(dir, results = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      collectFiles(full, results);
    } else if (SCAN_EXTENSIONS.has(extname(entry))) {
      results.push(full);
    }
  }
  return results;
}

const files = collectFiles(ROOT);
let violations = 0;

for (const file of files) {
  let content;
  try { content = readFileSync(file, "utf8"); } catch { continue; }

  for (const { re, label } of CONFLICT_PATTERNS) {
    // Only flag if the matching line does NOT have the bypass comment
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (re.test(line) && !line.includes("lint-conflict-markers:ok")) {
        const rel = relative(ROOT, file);
        console.error(`CONFLICT  ${rel}:${i + 1}  [${label}]  ${line.trimEnd()}`);
        violations++;
      }
    }
  }
}

if (violations > 0) {
  console.error(`\nlint-conflict-markers: FAIL — ${violations} unresolved conflict marker(s) found.`);
  console.error(`Fix: resolve the conflicts, or add // lint-conflict-markers:ok reason for intentional test fixtures.`);
  process.exit(1);
} else {
  console.log(`lint:conflict-markers OK — no unresolved conflict markers in ${files.length} files`);
}
