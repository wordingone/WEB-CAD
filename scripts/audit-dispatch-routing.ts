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
const STYLE_CSS = join(REPO_ROOT, "web/src/style.css");

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

// R4 — viewport cropping. silly-baking-yeti.md T2. Jun 2026-05-04: "the
// applications bottom part of the ui is cut off." Statusbar gets clipped on
// short windows (Macbook Air, devtools open, 13" laptop) which makes the
// dock divider grip and bottom status cells unreachable.
//
// R4a — style.css must use min-height: 100dvh, not height: 100vh
// R4b — index.html --dock-h must clamp to viewport (not literal 260px)
// R4c — style.css must have a max-height media query for short viewports
// R4d — workbench.ts dock-drag clamp ceiling must reference innerHeight
function checkCropping(): Violation[] {
  const violations: Violation[] = [];
  const css = readLines(STYLE_CSS);
  const html = readLines(INDEX_HTML);
  const wb = readLines(WORKBENCH_TS);

  if (css.length === 0) {
    violations.push({ file: "web/src/style.css", line: 0, rule: "R4a", detail: "style.css not found" });
  } else {
    // R4a: top-level "height: 100vh" on .app or body breaks short windows.
    for (let i = 0; i < css.length; i++) {
      if (/^\s*height:\s*100vh\s*;/.test(css[i])) {
        violations.push({
          file: "web/src/style.css",
          line: i + 1,
          rule: "R4a",
          detail: "uses height: 100vh; should be min-height: 100dvh (100dvh accounts for browser chrome; min-height lets content extend on short viewports)",
        });
      }
    }
    // R4c: must have a max-height media query for sub-700px viewports.
    const sawShortMedia = css.some((l) => /@media\s*\(\s*max-height\s*:/.test(l));
    if (!sawShortMedia) {
      violations.push({
        file: "web/src/style.css",
        line: 0,
        rule: "R4c",
        detail: "no @media (max-height: ...) block — short viewports (<700px) need .modebar/.ribbon compaction per silly-baking-yeti T2",
      });
    }
  }

  // R4b: index.html --dock-h must NOT be a hard pixel literal.
  for (let i = 0; i < html.length; i++) {
    const m = html[i].match(/--dock-h:\s*(\d+)px\s*;/);
    if (m) {
      violations.push({
        file: "web/index.html",
        line: i + 1,
        rule: "R4b",
        detail: `--dock-h is hardcoded to ${m[1]}px; should be min(340px, 35vh) so it caps at 35% of viewport on short windows`,
      });
    }
  }

  // R4d: drag-clamp must reference innerHeight (or window.innerHeight) so
  // the user can't drag the dock past viewport ceiling. Find the dock-drag
  // mousemove block (the one that reads "startY - e.clientY" + writes
  // --dock-h) and require innerHeight within ±10 lines.
  if (wb.length > 0) {
    let mousemoveIdx = -1;
    for (let i = 0; i < wb.length; i++) {
      if (/--dock-h/.test(wb[i]) && /setProperty/.test(wb[i])) {
        mousemoveIdx = i;
        break;
      }
    }
    if (mousemoveIdx !== -1) {
      const start = Math.max(0, mousemoveIdx - 10);
      const end = Math.min(wb.length, mousemoveIdx + 5);
      const block = wb.slice(start, end).join("\n");
      const sawInnerHeight = /innerHeight/.test(block);
      if (!sawInnerHeight) {
        violations.push({
          file: "web/src/workbench.ts",
          line: mousemoveIdx + 1,
          rule: "R4d",
          detail: "dock-drag clamp does not reference window.innerHeight; user can drag dock past viewport ceiling. Bound the upper Math.min to Math.min(560, window.innerHeight * 0.5)",
        });
      }
    }
  }

  return violations;
}

function main(): void {
  const violations: Violation[] = [
    ...checkRibbonIcons(),
    ...checkThemeToggleLocation(),
    ...checkPaletteDispatch(),
    ...checkViewerSelection(),
    ...checkCropping(),
  ];

  if (violations.length === 0) {
    console.log("0 dispatch-routing violations");
    process.exit(0);
  }

  for (const v of violations) {
    const loc = v.line > 0 ? `${v.file}:${v.line}` : v.file;
    console.log(`${loc} [${v.rule}] ${v.detail}`);
  }
  console.error(`\n${violations.length} violation${violations.length === 1 ? "" : "s"} — see silly-baking-yeti.md T1/T2/T3/T4/T7 for fix path`);
  process.exit(1);
}

main();
