#!/usr/bin/env bun
// audit-dispatch-routing.ts — verify UI elements route through dispatch and
// land where the bundle expects, not just "have a handler somewhere."
//
// audit-stubs.ts catches dead handlers (alert("not implemented"), TODOs).
// This audit catches the next class up: handlers that exist but route to
// the wrong sink (local setState instead of dispatch), or visual elements
// that render the wrong primitive (text instead of icon, statusbar instead
// of menubar). Both pass audit-stubs.ts; both break the bundle's contract.
//
// Why this exists: 2026-05-04 Jun caught 3 regressions in the live playwright
// window — ribbon shows TEXT not ICONS, BLUEPRINT/VELLUM toggle gone, palette
// buttons inert / no scene selection / no transform gizmo. All 3 trace to
// silly-baking-yeti.md plan tasks T1/T3/T4/T7 that were marked closed via
// #170 umbrella but never actually shipped to web/src. audit-stubs.ts
// reported "0 stubs, 0 dispatch gaps" the entire time.
//
// Exits 0 with stdout `0 dispatch-routing violations` on clean.
// Exits 1 with each violation on its own line.

import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SHELL_TS = join(REPO_ROOT, "web/src/shell.ts");
const WORKBENCH_TS = join(REPO_ROOT, "web/src/workbench.ts");
const VIEWER_TS = join(REPO_ROOT, "web/src/viewer.ts");
const INDEX_HTML = join(REPO_ROOT, "web/index.html");

type Violation = { file: string; line: number; rule: string; detail: string };

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/);
}

// R1 — ribbon-tool buttons must render an iconSVG, not raw text.
// Locate the ribbon render loop (toolsEl creation through its closing brace)
// and require iconSVG( to appear inside; flag direct textContent = tool
// assignments on tool-btn elements.
function checkRibbonIcons(): Violation[] {
  const lines = readLines(SHELL_TS);
  if (lines.length === 0) return [{ file: "web/src/shell.ts", line: 0, rule: "R1", detail: "shell.ts not found" }];

  let inRibbonLoop = false;
  let loopStart = -1;
  let loopEnd = -1;
  let braceDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inRibbonLoop && /\.ribbon-tools|toolsEl/.test(line) && /TOOL_GROUPS/.test(lines.slice(i, i + 10).join("\n"))) {
      // crude entry: the comment block above the loop mentions .ribbon-tools
      // and TOOL_GROUPS appears within ten lines.
      continue;
    }
    if (!inRibbonLoop && /for\s*\(\s*const\s+group\s+of\s+TOOL_GROUPS\s*\)/.test(line)) {
      inRibbonLoop = true;
      loopStart = i + 1;
      braceDepth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      continue;
    }
    if (inRibbonLoop) {
      braceDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (braceDepth <= 0) { loopEnd = i + 1; break; }
    }
  }
  if (loopStart === -1) {
    return [{ file: "web/src/shell.ts", line: 0, rule: "R1", detail: "ribbon-tool render loop (`for (const group of TOOL_GROUPS)`) not found — shell.ts shape changed" }];
  }

  const violations: Violation[] = [];
  let sawIconSVG = false;
  for (let i = loopStart; i <= loopEnd && i < lines.length; i++) {
    const line = lines[i];
    if (/iconSVG\s*\(/.test(line)) sawIconSVG = true;
    // Any direct textContent assignment of the loop variable to a tool-btn is a violation.
    if (/btn\.textContent\s*=\s*tool\b/.test(line)) {
      violations.push({
        file: "web/src/shell.ts",
        line: i + 1,
        rule: "R1",
        detail: "ribbon tool-btn renders raw text (`btn.textContent = tool`); should call iconSVG(tool.toLowerCase(), 16) and inject as innerHTML",
      });
    }
  }
  if (!sawIconSVG) {
    violations.push({
      file: "web/src/shell.ts",
      line: loopStart,
      rule: "R1",
      detail: `ribbon-tool render loop (lines ${loopStart}-${loopEnd}) does not call iconSVG() — buttons render text not icons`,
    });
  }
  return violations;
}

// R2 — theme-toggle (BLUEPRINT/VELLUM) belongs in menubar-right as pill,
// per app.jsx:354-370 and silly-baking-yeti.md T1. It is NOT allowed in the
// statusbar where it gets cropped at viewport heights below 700px.
function checkThemeToggleLocation(): Violation[] {
  const violations: Violation[] = [];
  const html = readLines(INDEX_HTML);
  if (html.length === 0) {
    return [{ file: "web/index.html", line: 0, rule: "R2", detail: "index.html not found" }];
  }

  // Find the statusbar block boundaries.
  let sbStart = -1;
  let sbEnd = -1;
  let depth = 0;
  for (let i = 0; i < html.length; i++) {
    const line = html[i];
    if (sbStart === -1 && /<div\s+class="statusbar"/.test(line)) {
      sbStart = i;
      depth = (line.match(/<div\b/g) || []).length - (line.match(/<\/div>/g) || []).length;
      continue;
    }
    if (sbStart !== -1) {
      depth += (line.match(/<div\b/g) || []).length - (line.match(/<\/div>/g) || []).length;
      if (depth <= 0) { sbEnd = i; break; }
    }
  }

  if (sbStart === -1) {
    violations.push({ file: "web/index.html", line: 0, rule: "R2", detail: "<div class=\"statusbar\"> not found in index.html" });
  } else {
    for (let i = sbStart; i <= sbEnd; i++) {
      if (/id="theme-toggle"/.test(html[i])) {
        violations.push({
          file: "web/index.html",
          line: i + 1,
          rule: "R2",
          detail: `theme-toggle button is inside the statusbar (lines ${sbStart + 1}-${sbEnd + 1}); silly-baking-yeti.md T1 requires it in menubar-right as BLUEPRINT/VELLUM pill`,
        });
      }
    }
  }

  // Positive: BLUEPRINT label must appear in shell.ts (the pill button is
  // built dynamically in shell.ts when it's in menubar-right).
  const shell = readLines(SHELL_TS);
  const sawBlueprint = shell.some((l) => /\bBLUEPRINT\b/.test(l));
  if (!sawBlueprint) {
    violations.push({
      file: "web/src/shell.ts",
      line: 0,
      rule: "R2",
      detail: "no BLUEPRINT label found in shell.ts — menubar-right pill (◑ BLUEPRINT / ○ VELLUM) not built",
    });
  }
  return violations;
}

// R3a — palette buttons must call dispatch(...) / dispatchSync(...), not
// directly setState("activeTool", ...). The single-dispatch-table contract
// is what makes UI surfaces, hotkeys, console, and agent tool-calls all
// route through the same handler set.
function checkPaletteDispatch(): Violation[] {
  const lines = readLines(WORKBENCH_TS);
  if (lines.length === 0) return [{ file: "web/src/workbench.ts", line: 0, rule: "R3a", detail: "workbench.ts not found" }];

  const violations: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/setState\s*\(\s*["']activeTool["']/.test(line)) {
      violations.push({
        file: "web/src/workbench.ts",
        line: i + 1,
        rule: "R3a",
        detail: "palette button click sets activeTool directly via setState; must route through dispatchSync(\"setActiveTool\", { toolId })",
      });
    }
  }
  return violations;
}

// R3b — viewer.ts must contain a Raycaster (selection picking).
// R3c — viewer.ts must contain TransformControls (translate/rotate/scale gizmo).
// Both are required by silly-baking-yeti.md T3/T4. Their absence is why
// "no objects in scene are selectable" and "gumbal not verifiable."
function checkViewerSelection(): Violation[] {
  const lines = readLines(VIEWER_TS);
  if (lines.length === 0) return [{ file: "web/src/viewer.ts", line: 0, rule: "R3b/c", detail: "viewer.ts not found" }];

  const violations: Violation[] = [];
  const sawRaycaster = lines.some((l) => /\bRaycaster\b/.test(l));
  const sawTransformControls = lines.some((l) => /\bTransformControls\b/.test(l));
  if (!sawRaycaster) {
    violations.push({
      file: "web/src/viewer.ts",
      line: 0,
      rule: "R3b",
      detail: "no Raycaster reference — selection picking not implemented (silly-baking-yeti.md T3)",
    });
  }
  if (!sawTransformControls) {
    violations.push({
      file: "web/src/viewer.ts",
      line: 0,
      rule: "R3c",
      detail: "no TransformControls reference — translate/rotate/scale gizmo not implemented (silly-baking-yeti.md T4)",
    });
  }
  return violations;
}

function main(): void {
  const violations: Violation[] = [
    ...checkRibbonIcons(),
    ...checkThemeToggleLocation(),
    ...checkPaletteDispatch(),
    ...checkViewerSelection(),
  ];

  if (violations.length === 0) {
    console.log("0 dispatch-routing violations");
    process.exit(0);
  }

  for (const v of violations) {
    const loc = v.line > 0 ? `${v.file}:${v.line}` : v.file;
    console.log(`${loc} [${v.rule}] ${v.detail}`);
  }
  console.error(`\n${violations.length} violation${violations.length === 1 ? "" : "s"} — see silly-baking-yeti.md T1/T3/T4/T7 for fix path`);
  process.exit(1);
}

main();
