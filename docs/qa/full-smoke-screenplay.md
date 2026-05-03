# gemma-architect — Full smoke screenplay

A beat-by-beat manual walkthrough of every user-facing surface. Read top to
bottom; do exactly what each beat says; answer Pass/Fail on every Verify.
A single Fail is a defect — file it as a bug with the beat number cited.

Multi-purpose artifact:
- **QA pass document** — Eli walks through this top-to-bottom before any
  pre-demo gate.
- **Demo video script** — Section 1 (critical path) is the judges-facing
  flow. Record the screen as you walk through it.
- **Per-surface spec** — every beat specifies what a surface MUST do.
  Treat it as the contract for what each click means.
- **Onboarding reference** — anyone new walks through this to learn what
  the app does.

## Format

Each beat is three lines:

```
### Beat <N>: <one-line title>
1. **Do:** <exact action — click selector / type text / press key>
2. **See:** <expected DOM + visual outcome>
3. **Verify:** <YES/NO pass condition; if NO, file bug citing this beat>
```

Sections are dependency-ordered. If Beat N requires Beat N-1's state, the
Setup is implicit — don't skip beats.

## Conventions

- **Selector** form: `.tool-btn[data-tool="line"]` (CSS), `#scene-panel`
  (id), or `text "Layout"` (DOM-text match).
- **Coords**: `(x, y)` are CSS pixels relative to the named element's
  bounding rect, NOT the viewport. `vp.center` = viewport center.
- **Theme states**: `theme=blueprint` (night, dark) or `theme=vellum`
  (day, light). Toggle via menubar pill.
- **Selection topology**: vertex / edge / curve / face / mesh / brep /
  group — 7 levels, picked per filter + Ctrl+Shift modifier.
- **Reference screenshot**: where present, at
  `docs/qa/refs/beat-<N>-<slug>.png`. Pixel-diff tolerance is 5% on
  color-normalized grayscale (browser font-rendering jitter is fine,
  layout regressions are not).

## Walkthrough environment

- Vite dev server: `bun run web:dev` from repo root → http://localhost:5173/
  (or 5179 if earlier ports busy)
- Browser: Chromium-based, 1920×1080 default viewport, normal zoom
- Pre-walkthrough: clear localStorage so app-state persistence doesn't
  carry mode/theme between runs

## Coverage map

| § | Section | Beats | Status |
|---|---|---|---|
| 1 | Critical path / demo flow | 50 | DRAFT (this commit) |
| 2 | Menubar — File / Edit / View / Mode / Window / Help | 42 | DRAFT (this commit) |
| 3 | Modebar — MODEL / LAYOUT / RESEARCH transitions | 18 | DRAFT (this commit) |
| 4 | Theme — BLUEPRINT ↔ VELLUM (every surface flips) | 22 | DRAFT (this commit) |
| 5 | Ribbon — 24 tool buttons + tab switcher | 50 | TODO |
| 6 | Left palette — collapsed/expanded, every entry | 24 | TODO |
| 7 | Right sidebar — SCENE tree / INSPECT / ASSETS / Selection Filters | 40 | TODO |
| 8 | Snap dock — Grid / Ortho / End / Mid / Center / Int / Track | 16 | TODO |
| 9 | Dock — PROMPT / CONSOLE / NODES / PARAMETERS / HISTORY tabs | 30 | TODO |
| 10 | Cmd+K palette — every command, hotkey, history | 28 | TODO |
| 11 | Viewport — pan / zoom / orbit / view switcher | 18 | TODO |
| 12 | Selection — 7-topology × 8 filter combos × Ctrl+Shift | 36 | TODO |
| 13 | Transforms — G/R/S gizmos × commit semantics | 18 | TODO |
| 14 | Create-mode — Box / Line / Rect / Circle / Wall / Slab / etc. | 50 | DRAFT (this commit, defect-surfaces only) |
| 15 | Boolean & edge ops — Union / Cut / Fillet / Chamfer | 16 | TODO |
| 16 | Layout mode (paper-space) — sheet / panels / scale / export | 28 | TODO |
| 17 | Research mode — corpus / search / cite / export | 14 | TODO |
| 18 | Export drawer — 12 formats × IFC4 round-trip integrity | 26 | TODO |
| 19 | Console-tab DSL — every keyword, alias, error path | 30 | TODO |
| 20 | Gemma 4 E2B agent — prompt → tool calls → KG → IFC | 40 | TODO |
| 21 | Skills — auto-load, keyword match, replicate-from-video | 16 | TODO |
| 22 | NURBS kernel — IFC IfcAdvancedBrep import + round-trip | 12 | TODO |
| 23 | Persistence — save/load/recover, sidecar kg.json | 10 | TODO |
| 24 | Edge cases — empty scene / huge IFC / malformed input | 16 | TODO |
| 25 | **Terminal reconstruction-parity gate (Schultz Residence, 549 architectural elements, 100% IFC parity)** | ~550 | DRAFT (verifier ships diff-ifc.ts; structure + protocol locked) |

Total target: ~1450 beats. The terminal §25 alone is ~550 beats — one
beat per architectural element placement plus the verification protocol.
**§25 is the only gate that proves the web app is a CAD tool.** Sections
1-24 verify surfaces work in isolation; §25 verifies they integrate into
a real architectural workflow. If §25 fails, the bridge is not judges-
tier regardless of how many other beats pass.

═══════════════════════════════════════════════════════════════════════════

## §1 — Critical path / demo flow

The judges' walk-through. Single linear path from cold-load to the agent
producing geometry. If §1 fails any beat, the demo fails — fix before
recording the video.

### Beat 1: Cold load — initial paint

1. **Do:** Navigate browser to http://localhost:5173/ with empty cache
   and empty localStorage.
2. **See:** Page title is "gemma·architect — drafting workbench". Layout:
   menubar (top), modebar (top, below), ribbon (top, below modebar), left
   palette, viewport (center, dark), right sidebar, dock (bottom),
   statusbar (very bottom).
3. **Verify:** All seven UI regions are visible. No JavaScript errors in
   console (one favicon 404 is acceptable).

### Beat 2: Initial theme + mode

1. **Do:** Look at top-right of menubar.
2. **See:** Pill-shaped toggle reading "◑ BLUEPRINT" (filled) or "○ VELLUM"
   (hollow). Default is BLUEPRINT (night theme) per app-state init.
3. **Verify:** Theme attribute on `<body>` is `data-theme="blueprint"`.
   Background is dark (oklch L < 0.30).

### Beat 3: Statusbar shows correct fields

1. **Do:** Look at the bottom statusbar.
2. **See:** Five cells, left-to-right: "Tool: select", "Sel: 0", units (mm),
   coords (X Y Z = 0 0 0), zoom (1×). Bottom of statusbar is fully visible
   at any viewport height ≥ 700px.
3. **Verify:** All 5 cells present. Statusbar is NOT cropped — its bottom
   edge is at or above `window.innerHeight`.

### Beat 4: BLUEPRINT/VELLUM toggle works

1. **Do:** Click the BLUEPRINT/VELLUM pill in menubar-right.
2. **See:** Theme flips to VELLUM (light, paper-cream background, dark
   ink). Pill shows "○ VELLUM".
3. **Verify:** `<body data-theme="vellum">`. Every UI region — menubar,
   ribbon, palette, sidebar, dock, viewport, statusbar — uses the day
   theme. NO element retains the night-theme background. **Specifically
   verify the right sidebar respects the theme** (regression caught
   2026-05-03).

### Beat 5: Toggle back to BLUEPRINT

1. **Do:** Click the pill again.
2. **See:** Theme flips back to BLUEPRINT.
3. **Verify:** Theme attribute back to `blueprint`. All regions match.

### Beat 6: Schultz Residence sample loads

1. **Do:** Open File menu → click "Open sample…" → select "Schultz
   Residence". File is 22.9 MB — wait for parse + render (~30s).
2. **See:** Viewport populates with the full 11-storey building. Walls
   render as solid surfaces. Multiple slabs visible. **549 architectural
   elements** (105 walls = 4 IfcWall + 101 IfcWallStandardCase, 17 doors,
   25 windows, 12 slabs, 12 stairs = 10 IfcStair + 2 IfcStairFlight, 25
   columns, 83 beams, 253 railings, 3 roofs, 11 storeys, 3 spaces). File
   is in IMPERIAL UNITS (FOOT, scale 0.3048 → meters).
3. **Verify:** Right sidebar SCENE tab shows scene tree organized by
   storey: Project → Site → Building → 11 Storeys → elements per storey.
   Element count matches §25.0 inventory table. **NOTE:** the synthetic
   "14-element Schultz" in `demo-prompts.ts` is a separate thing — that
   one is the AI-generation demo, not the IFC sample loaded here.

### Beat 7: Orbit the viewport

1. **Do:** Middle-click + drag inside viewport, ~30° around vertical axis.
2. **See:** Camera orbits smoothly. No frame drops. No element disappears
   or jumps to origin.
3. **Verify:** All 14 elements remain coherent in space — walls connect,
   slab is below, doors are within wall thickness.

### Beat 8: Zoom in on a wall

1. **Do:** Mouse-wheel forward over one external wall.
2. **See:** Camera dollies in. Wall fills more of the viewport. Edge
   helpers (T3 wireframe overlay) become visible at zoom > 2×.
3. **Verify:** No z-fighting between solid surface and edge helpers. No
   inverted normals (shading should be consistent across the wall).

### Beat 9: Click-select a wall

1. **Do:** Left-click on the front of any external wall.
2. **See:** Wall highlights (selection color, e.g. cyan outline + filled
   tint). Right sidebar INSPECT tab populates with element name, type
   (IfcWall), dimensions, GUID. Statusbar "Sel: 1".
3. **Verify:** Only ONE wall highlighted (raycast hit the closest face,
   not "all walls"). INSPECT shows the right wall's GUID.

### Beat 10: Pressing G triggers translate gizmo

1. **Do:** With wall still selected, press `G`.
2. **See:** Three.js TransformControls gizmo appears at the wall's
   centroid: red X-axis, green Y-axis, blue Z-axis arrows.
3. **Verify:** Gizmo is in TRANSLATE mode (arrows + plane handles, not
   ring/box handles). Hovering an axis highlights it.

### Beat 11: Translate gizmo moves the wall

1. **Do:** Click + drag the green Y-axis arrow ~+5 units.
2. **See:** Wall translates in real-time along Y. Other walls stay put.
3. **Verify:** Statusbar coords update with wall's new Y. Releasing the
   mouse commits the transform; pressing Ctrl+Z reverts it (history).

### Beat 12: Pressing R switches to rotate gizmo

1. **Do:** Press `R`.
2. **See:** Gizmo morphs to ROTATE mode — three colored rings (X red, Y
   green, Z blue) instead of arrows.
3. **Verify:** Gizmo MODE actually changed. **Beat catches T4 R/S
   regression (2026-05-03).** If the gizmo is still showing arrows, R is
   not wired.

### Beat 13: Rotate the wall

1. **Do:** Click + drag the blue Z-ring 45°.
2. **See:** Wall rotates in real-time about Z.
3. **Verify:** Rotation commits on release. Ctrl+Z reverts.

### Beat 14: Pressing S switches to scale gizmo

1. **Do:** Press `S`.
2. **See:** Gizmo morphs to SCALE mode — three colored cubes on axes +
   center cube for uniform.
3. **Verify:** Gizmo MODE actually changed.

### Beat 15: Delete and verify NO ghost wireframe

1. **Do:** Click the wall to ensure selection. Press `Del`.
2. **See:** Wall removed. SCENE tree updates (1 fewer wall). Statusbar
   "Sel: 0".
3. **Verify:** **NO wireframe edges remain at the deleted wall's location.
   No vertex sprites either.** This catches 2026-05-03 ghost-wireframe
   regression. If you see floating edge geometry where the wall was, FAIL.

### Beat 16: Undo restores wall + helpers

1. **Do:** Press `Ctrl+Z`.
2. **See:** Wall returns. Edge helpers + vertex sprites restored too (T3
   filter state should re-apply).
3. **Verify:** All helpers (visible per current Selection Filters) match
   pre-delete state.

### Beat 17: Open command palette

1. **Do:** Press `Ctrl+K` (or `Cmd+K` on Mac).
2. **See:** Cmd+K palette modal opens, focused on input. Default list
   shows recent + frequent + all commands.
3. **Verify:** Input has focus (typing immediately filters). Esc closes
   the modal.

### Beat 18: Cmd+K filters as you type

1. **Do:** Type "wall".
2. **See:** Visible commands filter to wall-related (Wall tool, Wall
   thickness query, Insert wall, etc.).
3. **Verify:** Top-ranked match is the Wall tool. Up/Down arrow keys
   change selection. Enter activates.

### Beat 19: Cmd+K Wall command activates the tool

1. **Do:** With Wall highlighted, press Enter.
2. **See:** Modal closes. Wall tool becomes active (statusbar "Tool: wall").
   Cursor changes to crosshair over viewport.
3. **Verify:** Statusbar prompts "Click first point" or equivalent guidance.
   The wall tool button in the ribbon shows `.active` class.

### Beat 20: Wall click-to-place — first point

1. **Do:** Click in the viewport at an empty location (e.g. (vp.center.x
   - 100, vp.center.y)).
2. **See:** A red vertex marker appears at the clicked point. Statusbar
   prompt updates to "Click second point" (or "End point of wall").
3. **Verify:** **The vertex marker is VISIBLE at the click location.** A
   rubber-band line preview follows the cursor from this point. **Catches
   2026-05-03 click-to-place regression** (Issue 8 from mail #6554).

### Beat 21: Wall click-to-place — second point

1. **Do:** Click at (vp.center.x + 100, vp.center.y).
2. **See:** A wall solid materializes between the two points. Default
   thickness (0.2m) and height (3m) applied.
3. **Verify:** Wall has volume (not just a line). SCENE tree adds 1 wall.
   Statusbar resets prompt for next wall placement.

### Beat 22: Esc cancels mid-tool

1. **Do:** Click first point of another wall. Then press `Esc`.
2. **See:** Tool cancels. No partial wall created. Vertex marker removed.
   Cursor returns to default. Statusbar "Tool: select".
3. **Verify:** No phantom geometry. Tool button no longer `.active`.

### Beat 23: Snap-to-grid actually snaps

1. **Do:** Activate Snap-to-grid in the snap-dock (toggle ON if not
   already). Click Wall tool. Click anywhere in the viewport NOT on a
   grid intersection.
2. **See:** Click point snaps to the nearest grid intersection.
3. **Verify:** **Vertex marker lands ON a grid intersection, not where
   the cursor was.** The placed point's coordinates are integer multiples
   of grid spacing. **Catches 2026-05-03 snap-to-grid regression** (Issue 9).

### Beat 24: Open console tab

1. **Do:** In the dock at bottom, click the CONSOLE tab.
2. **See:** Console tab activates. Existing log lines visible. Input
   field with caret prompt at the bottom.
3. **Verify:** Input is focusable. Placeholder shows DSL examples.

### Beat 25: Console DSL — wall command

1. **Do:** Click console input. Type:
   `wall (0 0) (5 0) height=3 thickness=0.2`. Press Enter.
2. **See:** Console echoes the command line. Compiles. Console shows
   "compiled · 1 solid → kernel". After kernel runs (≤2s), a 5m wall
   appears in the viewport.
3. **Verify:** Wall is visible in the viewport. Up-arrow recalls the
   command into input.

### Beat 26: Switch to LAYOUT mode

1. **Do:** Click `#02 LAYOUT` in modebar.
2. **See:** Workbench transitions to paper-space view. A sheet (default
   A1 landscape) fills the work area. Title block at bottom. Default
   panels (4) showing top / front / right / axonometric viewport renders
   at chosen scale.
3. **Verify:** **Sheet is a clean white paper, NOT diagonal hatching.**
   **Catches 2026-05-03 layout-mode regression** (Issue 2). Each panel
   shows actual scene geometry (the wall from beat 25), not a hatched
   placeholder. Scale dropdown per panel. Title block fields editable.

### Beat 27: LAYOUT export to PDF

1. **Do:** Click Export → PDF in the layout toolbar.
2. **See:** Browser triggers a `.pdf` download. File ~50-200 KB.
3. **Verify:** Open the PDF. Sheet dimensions match A1 landscape (594mm
   × 841mm). All four panels render. Title block populated. Scale bars
   correct.

### Beat 28: Switch to RESEARCH mode

1. **Do:** Click `#03 RESEARCH` in modebar.
2. **See:** Three-column layout. Left: corpus list with search input.
   Center: doc viewer placeholder. Right: findings panel + filter pills
   (LOCAL / WEB / CITE) + export pill.
3. **Verify:** Corpus list shows ≥5 markdown docs (wall-thickness,
   ifc4-schema-basics, gable-roof, daylight-calc, building-codes-101).
   Search input is focusable.

### Beat 29: RESEARCH search ranks correctly

1. **Do:** Type "wall thickness conventions" in search. Press Enter.
2. **See:** Findings panel populates with ≥3 ranked results. Top result
   is `wall-thickness.md`.
3. **Verify:** Snippet around the matched query shown with `<mark>`-tag
   highlighting on query terms. Click the result → doc viewer renders the
   markdown with same highlights.

### Beat 30: RESEARCH cite a result

1. **Do:** In findings, click "cite" on the wall-thickness result.
2. **See:** Citation triple `{source: "wall-thickness.md", line: <N>,
   claim: "<snippet>"}` appended to a session log. Findings count
   increments (e.g. "1 cited").
3. **Verify:** Click the export pill. JSON file downloads with the
   citation array.

### Beat 31: Switch back to MODEL mode

1. **Do:** Click `#01 MODEL` in modebar.
2. **See:** Workbench returns to 3D viewport with the scene preserved
   (Schultz Residence + the wall added in beat 25).
3. **Verify:** All elements still present. Camera position retained.

### Beat 32: Open prompt tab

1. **Do:** Click PROMPT tab in dock (or it may be the default).
2. **See:** Prompt input field, generate button, dropdown of demo prompts.
3. **Verify:** Demo dropdown lists 4+ prompts (4-walled room, courtyard
   house, gable roof, etc.).

### Beat 33: Run the agent on a prompt

1. **Do:** Type or select "draw a 6×4m room with a doorway south". Click
   Generate. (Local LoRA serve_lora.py must be running on its port —
   verify infra prerequisite separately.)
2. **See:** Spinner shows "Inferring…" → tool-call deltas stream in →
   geometry materializes in the viewport: 4 walls forming a 6×4m
   rectangle, doorway opening on the south wall.
3. **Verify:** SCENE tree shows 4 new walls + 1 door. INSPECT a wall →
   correct dimensions. KG inspector (devtools `window.__sceneKg.snapshot()`)
   shows `hosts(southWall, door)` triple.

### Beat 34: Agent — second prompt builds on state

1. **Do:** With the room from beat 33 still in the scene, prompt:
   "add a window opposite the door".
2. **See:** Agent infers north wall (opposite south door), inserts a
   window. Tool calls dispatch through the same dispatch table.
3. **Verify:** New window on the north wall. KG `hosts(northWall, window)`
   triple added. The agent saw the previous state via KG snapshot.

### Beat 35: Export the agent-built scene to IFC4

1. **Do:** File → Export → IFC4. Or Ctrl+E.
2. **See:** Export drawer opens. IFC4 selected by default. Click Export.
   `.ifc` file downloads.
3. **Verify:** Open the .ifc in a text editor (it's STEP-syntax). Find
   IfcWall × 4, IfcDoor × 1, IfcWindow × 1, IfcRelVoidsElement × 2 (door
   + window openings), IfcRelFillsElement × 2 (door + window fillings),
   IfcRelContainedInSpatialStructure × 1 (the IfcSpace containing them).

### Beat 36: Round-trip IFC import

1. **Do:** File → New (clear scene). Then File → Open → select the .ifc
   from beat 35.
2. **See:** Same scene rebuilds — 4 walls, door, window, all relations
   intact.
3. **Verify:** KG snapshot matches pre-export. No element lost. No
   relation drift.

### Beat 37: Demo video pre-flight

1. **Do:** Walk beats 1–36 once start-to-finish without rebooting the app.
2. **See:** Total duration ≤ 8 minutes. No JS errors. No frame drops > 100ms.
3. **Verify:** This is the demo. If any beat fails or stalls, the demo
   isn't ready. File the failing beat as a P0 bug.

### Beat 38: Switch theme during demo (visual story beat)

1. **Do:** Toggle BLUEPRINT/VELLUM during the agent-build sequence (around
   beat 34).
2. **See:** Entire UI flips theme without losing scene state, agent
   progress, or KG.
3. **Verify:** Smooth visual transition. No flash of unstyled content.
   Useful storytelling moment for the video.

### Beat 39: Quad-split viewport (when #180 lands)

1. **Do:** Click the quad-split toggle in ribbon-right (or modebar
   per-#180).
2. **See:** Viewport splits into 4 panes — top / front / right / persp.
3. **Verify:** All four panes show the same scene from different camera
   angles. Selection in one pane reflects in all others. Per-pane view
   switcher dropdown works.

### Beat 40: Single-pane back

1. **Do:** Toggle quad-split off.
2. **See:** Returns to single perspective viewport.
3. **Verify:** Camera state preserved.

### Beat 41: Cmd+K — viewport command

1. **Do:** Open Cmd+K. Type "fit" → select "Fit to selection" or "Fit to
   scene". Enter.
2. **See:** Camera frames the target.
3. **Verify:** Element fully in view, ~5% margin around bounds.

### Beat 42: Cmd+K — export command

1. **Do:** Open Cmd+K. Type "export glb" → select. Enter.
2. **See:** GLB export starts. File downloads.
3. **Verify:** Open the .glb in a viewer (e.g. drag into Blender or
   gltf.report). Geometry intact. Materials preserved (if scene has any).

### Beat 43: History ribbon — undo chain

1. **Do:** Open HISTORY tab in dock.
2. **See:** List of operations: each create/translate/rotate/scale/delete
   beat above shows as one entry, in order.
3. **Verify:** Click an entry → app state reverts to that point. Click
   "redo" forward.

### Beat 44: Persistence — refresh page

1. **Do:** With scene populated, hit F5 to refresh.
2. **See:** Page reloads. After load completes, scene is restored from
   localStorage (or auto-save).
3. **Verify:** All elements present. Theme preserved. Active mode
   preserved.

### Beat 45: Empty scene

1. **Do:** File → New. Confirm "discard unsaved changes".
2. **See:** Viewport empties. SCENE tree shows 0 elements. Statusbar
   "Sel: 0".
3. **Verify:** No ghost geometry. KG snapshot is empty (`window.__sceneKg.snapshot().totalTriples === 0`).

### Beat 46: Drag-drop file import

1. **Do:** Drag an IFC file from the OS file manager onto the viewport.
2. **See:** File loads. Geometry appears.
3. **Verify:** Same fidelity as File→Open. No console errors.

### Beat 47: Multi-format import

1. **Do:** Repeat beat 46 with .glb, .obj, .stl, .step.
2. **See:** Each loads via its format-specific path (worker for IFC/STEP,
   main thread for GLB/OBJ/STL).
3. **Verify:** All 5 formats produce visible geometry. SCENE tree
   populates correctly per format's metadata.

### Beat 48: Selection Filters always accessible

1. **Do:** Switch through SCENE / INSPECT / ASSETS tabs in right sidebar.
2. **See:** **Selection Filters panel remains visible at the bottom of
   the right container regardless of which tab is active.** Eight
   checkboxes: Points / Curves / Surfaces / Polysurfaces / Meshes /
   Annotations / Lights / Blocks.
3. **Verify:** **Catches 2026-05-03 sidebar-shape regression** (Issue 5
   from mail #6554). Filters are NOT inside any single tab; they live in
   the persistent bottom area of the right container.

### Beat 49: Right sidebar — no horizontal crop

1. **Do:** With sidebar at default width, look at the right edge of every
   panel (SCENE tree rows, INSPECT property labels, Selection Filters
   checkboxes).
2. **See:** Every text label and every checkbox is fully visible. No
   horizontal scroll, no `…` truncation.
3. **Verify:** **Catches 2026-05-03 sidebar-crop regression** (Issue 3).

### Beat 50: Final polish — close demo

1. **Do:** Toggle BLUEPRINT/VELLUM one last time. Open Help → About.
2. **See:** About dialog shows app version, last build, link to docs.
3. **Verify:** Dialog dismissable with Esc or X button. App returns to
   clean state for restart.

═══════════════════════════════════════════════════════════════════════════

## §2 — Menubar dropdowns

42 beats covering File / Edit / View / Mode / Window / Help. Each menubar
item must invoke a real dispatch action — no empty `() => {}` bodies, no
TODO labels visible to the user.

### Beat 51: File menu opens

1. **Do:** Click "File" in the menubar.
2. **See:** Dropdown opens below "File". Items listed: New / Open… /
   Open sample… / Save / Save As… / Import… / Export… / Recent / Exit.
3. **Verify:** All items have hover-highlight. Hotkey legends shown on the
   right (Ctrl+N, Ctrl+O, Ctrl+S, etc.).

### Beat 52: File → New

1. **Do:** Click "New" (or press Ctrl+N).
2. **See:** If unsaved changes, confirm dialog. Then scene clears.
3. **Verify:** Dispatch executes `scene.new`. KG cleared. SCENE tree empty.
   Title bar reflects "Untitled".

### Beat 53: File → Open

1. **Do:** Click "Open…" (or Ctrl+O).
2. **See:** Native file picker opens, filtered to supported formats.
3. **Verify:** Cancelling the picker returns to scene unchanged. Selecting
   a file loads it via the appropriate format path.

### Beat 54: File → Open sample (Schultz)

1. **Do:** Click "Open sample…" → choose Schultz Residence.
2. **See:** Schultz scene loads as in beat 6.
3. **Verify:** All 14+ elements render. KG populated.

### Beat 55: File → Save

1. **Do:** Click "Save" (or Ctrl+S).
2. **See:** If untitled, prompts for filename. Otherwise saves to last path.
3. **Verify:** No "stub" toast. File written. Title bar drops the dirty
   indicator (`*`).

### Beat 56: File → Save As

1. **Do:** Click "Save As…" (or Ctrl+Shift+S).
2. **See:** File picker for new path.
3. **Verify:** New file written. Existing file unchanged.

### Beat 57: File → Import

1. **Do:** Click "Import…".
2. **See:** Picker filtered to all supported import formats (IFC, STEP,
   GLB, GLTF, OBJ, STL).
3. **Verify:** Imported geometry merges into current scene (does NOT
   replace; that's File → Open).

### Beat 58: File → Export

1. **Do:** Click "Export…" (or Ctrl+E).
2. **See:** Export drawer opens. 12 format options (IFC4, STEP, GLB, GLTF,
   OBJ, STL, USDZ, PLY, COLLADA, X3D, 3MF, plus the layout-mode-specific
   PDF/SVG/AI/DWG when applicable).
3. **Verify:** Each format radio works. Click Export → file downloads.

### Beat 59: File → Recent

1. **Do:** Click "Recent" (submenu).
2. **See:** Up to 8 most-recently-opened files listed by short name +
   path tooltip.
3. **Verify:** Click a recent → opens that file. If file moved/missing,
   shows error toast, removes from list.

### Beat 60: File → Exit

1. **Do:** Click "Exit" (or browsers: this may be a no-op or close-window).
2. **See:** If unsaved changes, confirm dialog.
3. **Verify:** Confirming closes the tab/window.

### Beat 61: Edit menu opens

1. **Do:** Click "Edit" in menubar.
2. **See:** Dropdown: Undo / Redo / Cut / Copy / Paste / Delete /
   Duplicate / Select all / Invert selection / Preferences.
3. **Verify:** Hotkey legends visible.

### Beat 62: Edit → Undo

1. **Do:** Click "Undo" (or Ctrl+Z).
2. **See:** Last operation reverts.
3. **Verify:** History stack pops one. SCENE tree updates.

### Beat 63: Edit → Redo

1. **Do:** Click "Redo" (or Ctrl+Y / Ctrl+Shift+Z).
2. **See:** Reverted op re-applied.
3. **Verify:** History stack advances.

### Beat 64: Edit → Cut / Copy / Paste

1. **Do:** Select element. Click Cut. Click Paste.
2. **See:** Element cut to clipboard. Paste produces an identical element
   at clipboard origin or last-clicked location.
3. **Verify:** UUIDs of pasted elements differ from originals. KG triples
   for pasted elements added.

### Beat 65: Edit → Delete

1. **Do:** Select. Click Delete (or press Del).
2. **See:** Element removed. **No ghost wireframe.**
3. **Verify:** Same outcome as beat 15.

### Beat 66: Edit → Duplicate

1. **Do:** Select. Click Duplicate (or Ctrl+D).
2. **See:** Copy placed adjacent to original (offset by ~1m on X, or
   per-tool convention).
3. **Verify:** New UUID. SCENE tree adds a row.

### Beat 67: Edit → Select all

1. **Do:** Click Select all (or Ctrl+A).
2. **See:** All scene elements highlighted. Statusbar "Sel: N" where
   N = scene element count.
3. **Verify:** Filter respects: if Lights filter is OFF, lights not
   selected.

### Beat 68: Edit → Invert selection

1. **Do:** With some elements selected, click Invert.
2. **See:** Selection flips — previously unselected become selected, and
   vice versa.
3. **Verify:** Statusbar count updates correctly.

### Beat 69: Edit → Preferences

1. **Do:** Click Preferences.
2. **See:** Modal with sections: Units / Theme / Hotkeys / Snap defaults
   / Agent (E2B endpoint, model selection) / Performance.
3. **Verify:** Changes apply on Save. Cancel discards. Modal dismissable
   with Esc.

### Beat 70: View menu opens

1. **Do:** Click "View".
2. **See:** Dropdown: Top / Front / Right / Back / Left / Bottom /
   Perspective / Axonometric / Fit / Frame selection / Show grid / Show
   axes / Show stats / Toggle theme.
3. **Verify:** Each item activates its action.

### Beat 71: View → Top

1. **Do:** Click "Top".
2. **See:** Camera switches to orthographic top.
3. **Verify:** Floor visible from above. Walls render as thin rectangles.
   Grid orientation correct.

### Beat 72-76: View → Front / Right / Back / Left / Bottom

(Five beats, identical structure to beat 71. Each switches camera to the
respective orthographic view. Verify orientation, floor visibility,
grid alignment.)

### Beat 77: View → Perspective

1. **Do:** Click "Perspective".
2. **See:** Camera returns to perspective projection.
3. **Verify:** Walls render with perspective foreshortening.

### Beat 78: View → Axonometric

1. **Do:** Click "Axonometric".
2. **See:** Camera switches to a 35° iso-style projection (parallel,
   no foreshortening).
3. **Verify:** All three primary axes visible at consistent angles.

### Beat 79: View → Fit / Frame selection

(Two beats. Fit frames whole scene; Frame selection frames just selected.
Both should leave ~5% padding around the bounds.)

### Beat 80: View → Show grid / axes / stats

(Three beats. Each toggles the respective overlay. Verify grid shows/hides
the dark drafting grid; axes show/hides the gnomon at origin; stats shows
the FPS counter.)

### Beat 81: View → Toggle theme

1. **Do:** Click "Toggle theme · BLUEPRINT" (label changes per current
   theme).
2. **See:** Theme flips. Same as menubar pill.
3. **Verify:** Menu label updates next time it's opened.

### Beat 82: Mode menu opens

1. **Do:** Click "Mode".
2. **See:** Dropdown: Model / Layout / Research / Set custom mode…
3. **Verify:** Active mode has check mark.

### Beat 83: Mode → Layout

(Same as beat 26 via modebar. Verify identical outcome.)

### Beat 84: Mode → Research

(Same as beat 28 via modebar.)

### Beat 85: Mode → Model

(Returns to MODEL.)

### Beat 86: Window menu opens

1. **Do:** Click "Window".
2. **See:** Dropdown: Single / Quad / H-split / V-split / Reset / Reload
   aliases / Reload skills / Devtools.
3. **Verify:** Active layout has check mark.

### Beat 87-90: Window → Single / Quad / H-split / V-split

(Four beats. Each switches viewport layout. Verify scene state preserved
across layout switches.)

### Beat 91: Window → Reset

1. **Do:** Click Reset.
2. **See:** Viewport returns to single + perspective camera.
3. **Verify:** Camera at default position.

### Beat 92: Window → Reload aliases

1. **Do:** Click Reload aliases.
2. **See:** Toast: "aliases reloaded · N user overrides loaded" (or "no
   user file" if none).
3. **Verify:** Re-loads `~/.gemma-architect/aliases.json` into runtime
   alias map. Subsequent dispatch calls respect it.

### Beat 93: Help menu opens

1. **Do:** Click "Help".
2. **See:** About / Docs / Hotkey reference / Report bug / Open dev
   console.
3. **Verify:** All items dispatch real actions.

═══════════════════════════════════════════════════════════════════════════

## §14 — Create-mode tools (DRAFT — defect surfaces only)

50 beats target. This commit drafts only the surfaces flagged in mail
#6554 (Issues 8 + 9): Box, Line, with point-input + snap behavior. Other
tools (Rect / Circle / Polygon / Polyline / Arc / Spline / Wall / Slab /
Column / Stair / Door / Window / Extrude / Revolve / Sweep) follow the
same shape — author in subsequent ticks.

### Beat 401: Box tool — activate

1. **Do:** Click `.tool-btn[data-tool="box"]` in ribbon (or hotkey or
   Cmd+K).
2. **See:** Tool button gets `.active`. Cursor changes to crosshair.
   Statusbar prompt: "Click first corner of box base".
3. **Verify:** Tool actually activates. Other create tools deactivate.

### Beat 402: Box — first corner click

1. **Do:** Click in viewport at any 2D-ish location (e.g. top view first
   for clarity).
2. **See:** Vertex marker appears at click point. Statusbar prompt:
   "Click second corner of box base". Rubber-band rectangle preview
   follows the cursor showing the in-progress base.
3. **Verify:** **Vertex marker IS visible at click location.** Rubber-
   band rectangle renders as a dashed outline. **Catches Issue 8.**

### Beat 403: Box — second corner with snap

1. **Do:** With Snap-to-grid ON, hover over a non-grid location, then
   click.
2. **See:** Rubber-band rectangle snaps to grid intersections during
   hover. Click commits the corner to the nearest grid intersection.
3. **Verify:** **Committed corner is on a grid intersection, NOT where
   the cursor was.** Vertex marker stays. Rubber-band now shows base
   rectangle filled, with a vertical preview line for height. Statusbar
   prompt: "Drag up to set height".

### Beat 404: Box — height drag

1. **Do:** Drag the cursor upward (in screen space; corresponds to +Z in
   the active view).
2. **See:** A 3D box preview rises from the base. Both vertex markers
   from beats 402 and 403 remain visible.
3. **Verify:** Preview is a wireframe box (or translucent solid). Drag
   distance maps linearly to box height.

### Beat 405: Box — commit on click

1. **Do:** Click to commit the height.
2. **See:** Box materializes as a solid mesh in the scene. Vertex markers
   removed (or persist as creation history if T3 keeps them).
3. **Verify:** SCENE tree adds 1 box. KG triple `rdf:type → IfcBox` (or
   the spatial-dictionary canonical name). Tool returns to "ready for next
   click first corner" or returns to select per UX choice.

### Beat 406: Box — Esc cancel mid-flow

1. **Do:** Click first corner. Then press Esc.
2. **See:** Vertex marker removed. Rubber-band cleared. Tool stays active
   waiting for first corner again (or returns to select per choice).
3. **Verify:** No partial geometry.

### Beat 407: Box — undo after commit

1. **Do:** After beat 405's commit, press Ctrl+Z.
2. **See:** Box removed. Vertex markers from creation flow do NOT
   reappear (they're history, not state).
3. **Verify:** SCENE tree drops 1 box. KG triple removed.

### Beat 408: Line tool — activate

1. **Do:** Click `.tool-btn[data-tool="line"]` (or hotkey).
2. **See:** Tool active. Cursor crosshair. Statusbar: "Click first point
   of line".
3. **Verify:** Same as beat 401 for Box.

### Beat 409: Line — first point with snap

1. **Do:** Snap-to-grid ON. Click at a non-grid location.
2. **See:** Vertex marker at the snapped (grid-intersection) location.
   Rubber-band line preview follows cursor from this point.
3. **Verify:** **Marker on grid intersection, not cursor location.**
   **Catches Issue 9 (snap regression).**

### Beat 410: Line — second point

1. **Do:** Click second point.
2. **See:** Line geometry committed between the two points. Polyline
   continuation: cursor still active for next segment, with rubber-band
   from second point.
3. **Verify:** Line is visible 1D geometry (curve, not surface).

### Beat 411: Line — Enter to finish

1. **Do:** Press Enter (or Esc to cancel mid-polyline).
2. **See:** Polyline closes. Tool stays active for next polyline OR
   returns to select.
3. **Verify:** Final polyline has the right vertex count + segment count.

### Beat 412: Line — endpoint snap

1. **Do:** With Snap → Endpoint ON, draw a line. Then start a second
   line; hover the cursor near the first line's endpoint.
2. **See:** Cursor snaps to the existing endpoint (sticky highlight).
3. **Verify:** New line shares the endpoint exactly (KG vertex graph).

### Beats 413-450 (TODO)

Cover the remaining 13 create tools (Rect / Circle / Polygon / Polyline /
Arc / Spline / Wall / Slab / Column / Stair / Door / Window / Extrude /
Revolve / Sweep / Loft / Shell). Each follows the Box/Line shape: activate
→ click points → preview → commit. Stair gets extra beats for riser/
tread parameters. Door + Window get extra beats for "click on a wall
to host" semantics + KG `hosts` triple verification.

═══════════════════════════════════════════════════════════════════════════

## §3 — Modebar transitions (MODEL / LAYOUT / RESEARCH)

18 beats. Modebar is the three-button strip below the menubar with `01
MODEL`, `02 LAYOUT`, `03 RESEARCH`. Drives `setState("viewMode", key)`
which the workbench subscribes to. Each mode replaces the centre column;
sidebar and dock persist.

### Beat 100: Initial mode is MODEL

1. **Do:** Cold-load the page (Beat 1 prerequisite).
2. **See:** `01 MODEL` tab has `.active` class (highlighted). `02 LAYOUT`
   and `03 RESEARCH` are dim. Workbench shows the three drafting viewports
   + perspective (post-T1 quad-split).
3. **Verify:** `getState("viewMode") === "model"`. `document.querySelector(".mode-tab[data-mode=\"model\"]")` carries `aria-selected="true"`.

### Beat 101: Switch to LAYOUT

1. **Do:** Click `02 LAYOUT` tab.
2. **See:** Centre column rebuilds — drafting viewports replaced by paper-
   space layout (A4 sheet placeholder by default with one panel previewing
   the perspective view from MODEL). Modebar's `.active` class moves from
   MODEL → LAYOUT. Statusbar mode cell updates to `LAYOUT`.
3. **Verify:** `getState("viewMode") === "layout"`. No console errors. Issue
   2 fix is intact: panel renders the real scene projection, not diagonal-
   hatching placeholder, when MODEL has content.

### Beat 102: Switch to RESEARCH

1. **Do:** Click `03 RESEARCH` tab.
2. **See:** Centre column rebuilds again — layout sheet replaced by
   research view (corpus search input + LOCAL/WEB/CITE pill filters +
   results pane). Sidebar persists with INSPECT / SCENE / ASSETS tabs
   intact. Snap dock persists (filters still active even though they
   don't apply to research).
3. **Verify:** `getState("viewMode") === "research"`. Search input has
   focus or is at least focusable. Demo corpus loaded (T16) — type
   "wall" and at least one fixture document ranks.

### Beat 103: Return to MODEL

1. **Do:** Click `01 MODEL` tab.
2. **See:** Centre column rebuilds back to drafting viewports. Any
   selection that existed before leaving MODEL is restored. Active tool
   is restored.
3. **Verify:** `getState("viewMode") === "model"`. If a wall was
   selected before Beat 101, it's selected again now (selection-state
   persists across mode switches). Active tool from before is restored
   (e.g. "wall" if user had wall tool armed).

### Beat 104: Selection survives MODEL → LAYOUT → MODEL

1. **Do:** In MODEL, click a wall to select. Switch to LAYOUT. Switch
   back to MODEL.
2. **See:** Wall is still selected (highlight + edge helpers visible).
   INSPECT tab still shows the wall's metadata (post-#148 fix).
   Statusbar `Sel: 1`.
3. **Verify:** `getSelected()` returns the same uuid both before and
   after the round-trip. Mode-switch is non-destructive to scene state.

### Beat 105: Active tool survives mode round-trip

1. **Do:** In MODEL, activate Wall tool. Round-trip through LAYOUT
   and RESEARCH.
2. **See:** On return to MODEL, Wall tool is still active (`.tool-btn[data-tool="wall"].active`). Statusbar `Tool: Wall`.
3. **Verify:** `getState("activeTool") === "wall"` post-roundtrip.

### Beat 106: Mode hotkeys (1 / 2 / 3)

1. **Do:** Press `1` → `2` → `3` → `1` keystrokes when no input is focused.
2. **See:** Modebar cycles MODEL → LAYOUT → RESEARCH → MODEL. Each step
   updates statusbar mode cell.
3. **Verify:** `getState("viewMode")` matches the visible mode after
   each press. **If hotkeys are not yet wired, file as #166 follow-up.**

### Beat 107: Mode hotkey suppressed in input field

1. **Do:** Open Cmd+K palette, type `1` in the search input.
2. **See:** Character `1` appears in the input. Mode does NOT change.
3. **Verify:** `getState("viewMode")` unchanged. Hotkey handler must
   short-circuit when `document.activeElement` is an input/textarea.

### Beat 108: BLUEPRINT/VELLUM toggle persists across modes

1. **Do:** Set theme to VELLUM (parchment) via menubar pill toggle.
   Switch MODEL → LAYOUT → RESEARCH.
2. **See:** Each mode's UI is in VELLUM theme (parchment background,
   warm ink). No regressions to dark BLUEPRINT chrome inside any mode.
   Issue 4 fix is intact: SCENE tab remains theme-aware in every mode.
3. **Verify:** `<body>` has the VELLUM theme class active in all three
   modes. No element has hardcoded BLUEPRINT colour leaking through.

### Beat 109: Empty MODEL → LAYOUT shows hatched-empty placeholder

1. **Do:** Start fresh (no scene content). Click LAYOUT.
2. **See:** Layout panels show diagonal-hatching placeholder ("empty
   model" indicator), NOT a stub-rectangle.
3. **Verify:** Issue 2 fix is intact for the empty case. Hatching is
   present only when there are no scene objects to project.

### Beat 110: Modebar tab order

1. **Do:** Inspect the modebar DOM.
2. **See:** Three tabs in order MODEL / LAYOUT / RESEARCH, each with
   numeric prefix `01` / `02` / `03`. Icons match: extrude / rect /
   sparkle.
3. **Verify:** DOM order matches the spec; numeric prefixes present
   (numbers from `MODES[].num` in shell.ts:99-102).

### Beat 111: Modebar Aria

1. **Do:** Inspect the modebar `role` and `aria-selected` attributes.
2. **See:** Modebar parent has `role="tablist"`. Each `.mode-tab` has
   `role="tab"`. Active tab has `aria-selected="true"`, others
   `aria-selected="false"`.
3. **Verify:** Screen-reader walking the modebar gets the correct mode
   announcement. Tab order via Tab key is left-to-right.

### Beat 112: Mode-switch fires command for skill loader

1. **Do:** Open browser devtools console. Switch MODEL → RESEARCH.
2. **See:** A `gemma:command` event fires with `detail.id` containing
   "research" (the skill loader uses this to inject the
   `research-from-prompt` skill into the agent context).
3. **Verify:** Window event listener captures the event. Used by T11
   skill auto-load.

### Beat 113: Layout panel content reflects MODEL view

1. **Do:** In MODEL, frame the perspective viewport on the Schultz
   roof. Switch to LAYOUT.
2. **See:** Layout's perspective panel shows the same Schultz roof
   framing (or close to it; layout panels project from the MODEL
   cameras per T15). Adjust panel viewport selector to switch to TOP
   → panel shows the top-orthographic projection.
3. **Verify:** Per-panel viewport-picker (top/front/right/perspective)
   works post-T15. Panel content updates within ~200ms of selector
   change.

### Beat 114: Research mode citation tracker

1. **Do:** In RESEARCH, search "wall thickness". Click "cite" on a
   result.
2. **See:** Citation tracker session-log appends one entry. INSPECT
   tab (when on MODEL) is unaffected.
3. **Verify:** Citation log has `{source, line, claim}` per T16 spec.

### Beat 115: RESEARCH mode is keyboard-accessible

1. **Do:** Tab into the research search input. Type "stair". Press
   Enter.
2. **See:** Search executes. Top result highlighted.
3. **Verify:** No mouse needed. Enter activates. Esc clears.

### Beat 116: LAYOUT mode export → PDF

1. **Do:** In LAYOUT, click EXPORT → PDF.
2. **See:** Browser download `<scene>.pdf`. File opens in any PDF
   viewer; sheet dimensions match the selected paper size.
3. **Verify:** Output passes T15 layout test (jsPDF MediaBox matches
   the paper size in pixels at 96dpi).

### Beat 117: RESEARCH mode export → markdown bibliography

1. **Do:** In RESEARCH after at least one citation, click EXPORT →
   `<session>.bib.md`.
2. **See:** Markdown file with bibliography entries (one per cited
   source).
3. **Verify:** Each entry has source title, source path, claim text.

═══════════════════════════════════════════════════════════════════════════

## §4 — Theme audit (BLUEPRINT ↔ VELLUM, every surface)

22 beats. Theme switch flips dark `night=true` BLUEPRINT chrome to
warm `night=false` VELLUM. Persisted in `localStorage[gemma-architect.theme]`
(`"night"` or `"day"`). Three entry points must agree: menubar pill,
View > Toggle theme menu item, Cmd+K "Toggle theme" command. Issue 4
fix verified: scene-panel theme-aware in sidebar embed.

### Beat 118: Cold-load default

1. **Do:** Clear `localStorage["gemma-architect.theme"]`. Reload.
2. **See:** Page paints in BLUEPRINT (dark, night=true). Menubar pill
   says `○ VELLUM` (off-state, indicates click switches to VELLUM).
3. **Verify:** `getState("night") === true`. Pill text matches.
   `<body>` carries no `.day-mode` class (or whatever the BLUEPRINT
   default state is; verify against style.css).

### Beat 119: Pill toggle BLUEPRINT → VELLUM

1. **Do:** Click `#theme-toggle-pill` in menubar-right.
2. **See:** Whole UI flips to VELLUM (warm beige paper backdrop,
   graphite ink). Pill label flips to `◑ BLUEPRINT` (now indicates
   click returns to BLUEPRINT). Statusbar, sidebar, ribbon, dock,
   modebar, viewports — all flipped within one frame.
3. **Verify:** `getState("night") === false`. `localStorage["gemma-architect.theme"]
   === "day"`. CSS `--paper-base` resolves to a light oklch value
   (~0.965). No element has hardcoded dark colour leaking through.
   Issue 4 fix intact: scene-panel uses `var(--glass-bg)`, not
   hardcoded `rgba(13, 14, 18, 0.78)`.

### Beat 120: Pill toggle VELLUM → BLUEPRINT

1. **Do:** Click pill again.
2. **See:** UI flips back to BLUEPRINT. Pill label `○ VELLUM`.
3. **Verify:** `localStorage["gemma-architect.theme"] === "night"`.
   Round-trip is lossless — no UI element is "stuck" in the wrong theme.

### Beat 121: Menubar entry toggle

1. **Do:** Open View menu. Click "Toggle theme" row.
2. **See:** Theme flips. Menu closes. Same effect as pill.
3. **Verify:** Same `getState` + localStorage as pill path.

### Beat 122: View menu label is dynamic

1. **Do:** Open View menu in BLUEPRINT.
2. **See:** Toggle row label is `Daylight · vellum` (suggesting the
   action: switch to vellum).
3. **Verify:** `shell.ts:256` dynamicLabel logic — label text reflects
   the OPPOSITE of current state. After toggling to VELLUM, the label
   becomes `Night · blueprint`.

### Beat 123: Cmd+K toggle command

1. **Do:** Cmd+K → type `theme` → Enter on "Toggle theme" command.
2. **See:** Theme flips. Same effect as pill / menu.
3. **Verify:** `palette.ts:86` keyword match works for `theme` /
   `dark` / `light` / `vellum` / `blueprint`. localStorage updated
   via the palette path (`palette.ts:127`).

### Beat 124: Reload persists VELLUM

1. **Do:** Set theme to VELLUM. Hard-reload (Ctrl+F5).
2. **See:** Page paints directly in VELLUM (no BLUEPRINT flash).
3. **Verify:** Hydration in `app-state.ts:85` reads localStorage on
   first paint. No flash of unstyled / wrong-themed content (FOUC).

### Beat 125: Reload persists BLUEPRINT

1. **Do:** Set theme to BLUEPRINT. Hard-reload.
2. **See:** Page paints in BLUEPRINT.
3. **Verify:** Same hydration path; symmetric.

### Beat 126: localStorage manual override

1. **Do:** With page open, in devtools run
   `localStorage.setItem("gemma-architect.theme", "day")`. Reload.
2. **See:** Page paints in VELLUM after reload.
3. **Verify:** External writes to localStorage are honoured at next
   hydration.

### Beat 127: Private mode tolerance

1. **Do:** Open the app in a private/incognito window. Toggle theme.
   Reload.
2. **See:** Theme flips on toggle but does NOT persist across reload
   (private mode blocks localStorage). No console error.
3. **Verify:** `app-state.ts:78` swallows the localStorage `setItem`
   error in `try/catch`. No "Storage failed" red banner.

### Beat 128: Menubar surface in both themes

1. **Do:** Inspect `.menubar` background + text colour in each theme.
2. **See:** BLUEPRINT: dark glass with light text. VELLUM: warm paper
   with graphite text. Hover state in both is readable.
3. **Verify:** Contrast ratio ≥ 4.5:1 for body text in each theme
   (WCAG AA). Pill label readable in both.

### Beat 129: Modebar surface

1. **Do:** Inspect `.modebar` and each `.mode-tab` background +
   numeric prefix text in each theme.
2. **See:** Active tab visually distinct from inactive tabs in both
   themes. Numeric prefix (01/02/03) readable.
3. **Verify:** No theme-only colour leak (e.g. inactive tab going
   invisible against VELLUM background).

### Beat 130: Ribbon + tool buttons

1. **Do:** Inspect `.ribbon` row and each `.tool-btn` icon (per Issue 1
   fix — square 28×28 with stroke colour). Toggle theme.
2. **See:** Tool icons re-stroke in the theme's accent colour. Active
   tool's `.active` state visually distinct in both themes.
3. **Verify:** SVG icons use `currentColor` or theme-aware fill — no
   hardcoded `#fff` / `#000` strokes. Issue 1 fix intact: padding/
   icon visibility doesn't regress in either theme.

### Beat 131: Sidebar surfaces (every tab)

1. **Do:** Open SCENE / INSPECT / ASSETS in BLUEPRINT, then VELLUM.
2. **See:** Every tab body surface flips: SCENE tree backdrop, INSPECT
   metadata table, ASSETS thumbnails. Selection-filter checkboxes
   readable in both. Issue 4 fix intact: `#scene-panel` uses
   `var(--glass-bg)` post-fix, no hardcoded dark.
3. **Verify:** No tab carries the previous theme's chrome through the
   transition (no half-themed mid-state).

### Beat 132: Snap dock surface

1. **Do:** Toggle theme with snap dock visible.
2. **See:** Snap dock surface, GRID / ORTHO / END / MID / CEN / INT /
   TRACK pill backgrounds, label text — all flipped.
3. **Verify:** Active pill state distinguishable in both themes.

### Beat 133: Dock surface — every tab

1. **Do:** With each dock tab active in turn (PROMPT / CONSOLE /
   NODES / PARAMETERS / HISTORY), toggle theme.
2. **See:** Tab-strip background, active tab indicator, tab body
   content, input field placeholders — all flipped.
3. **Verify:** Console-tab DSL output / PROMPT input styling /
   PARAMETERS field labels are all theme-aware.

### Beat 134: Statusbar surface

1. **Do:** Toggle theme.
2. **See:** Status cells (Mode / Tool / Sel / Coord / Zoom)
   backgrounds + text colour swap. Statusbar separator lines visible
   in both themes.
3. **Verify:** Critical info readable in both themes (no low-contrast
   regression).

### Beat 135: Viewport background flips

1. **Do:** Toggle theme.
2. **See:** Viewport area background swaps to vellum-paper texture
   (VELLUM) or dark glass (BLUEPRINT). Grid lines re-tint to match
   (`viewer.ts:144` grid-color tuning).
3. **Verify:** Geometry remains visible in both themes. Selection
   highlights use the accent colour, not a theme-leaking base.

### Beat 136: Viewport rendering — geometry contrast

1. **Do:** Load Schultz_Residence.ifc, toggle to VELLUM.
2. **See:** Wall / slab / door / window meshes still visible against
   the parchment backdrop. No mesh becomes the same colour as the
   background.
3. **Verify:** Material defaults provide enough contrast in both
   themes. T3 edge helpers (wireframe overlay) re-tint correctly.

### Beat 137: Theme survives mode round-trip

1. **Do:** VELLUM in MODEL → switch to LAYOUT → switch to RESEARCH →
   back to MODEL.
2. **See:** Theme stays VELLUM across all four states.
3. **Verify:** Cross-ref §3 Beat 108 — same assertion, included here
   for §4 completeness (theme orthogonal to mode).

### Beat 138: Toggle inside an input field is suppressed

1. **Do:** Open Cmd+K palette. Type `t` (just the letter, NOT the full
   `theme` command).
2. **See:** Letter `t` is captured by the input. Theme does NOT flip.
3. **Verify:** No accidental hotkey hits. If a future hotkey for
   theme-toggle is added (e.g. `Ctrl+T`), it must short-circuit when
   `document.activeElement` is an input/textarea. **If hotkey is not
   yet wired, file as #166 follow-up.**

### Beat 139: Pill aria + keyboard

1. **Do:** Tab through menubar-right until pill receives focus. Press
   Space.
2. **See:** Theme flips. Focus ring visible on pill in both themes.
3. **Verify:** `<button id="theme-toggle-pill">` is focusable. Space/
   Enter activates. ARIA label or visible label communicates the
   action ("Toggle theme") to screen readers.

═══════════════════════════════════════════════════════════════════════════

## §5 — Every ribbon tool (50 beats)

The ribbon hosts **24 tools** across 5 groups + **6 tabs** (MODEL/DRAFT/
ANALYZE/RENDER/ANNOTATE/SUBMIT) + **2 right-side actions** (⌘K palette,
EXPORT). Source: `web/src/shell.ts` `TOOL_GROUPS` (lines 45-80) +
`RIBBON_TABS` (line 104) + `buildRibbon` (lines 483-560).

Each `<button class="tool-btn">` carries `data-tool=<id>` and on click
calls `setState("activeTool", tool.id)`. The active tool drives the
viewport sketcher pipeline in `web/src/create-mode.ts`.

Pipeline status per `create-mode.ts:11-15` comment:
- **Fully wired** (8): line, rect, circle, wall, slab, column, door, window
- **Stubbed** (logs to console, no geometry): polyline, polygon, arc, spline,
  stair, extrude, revolve
- **Routed via dispatch.ts** (not click-to-place): boolean (case at :160)
- **Status TBD until smoke** (verify in build): fillet, chamfer, ruler, compass

Cross-refs:
- §3 beats 100-117 covered modebar transitions; ribbon tools live inside
  the model-mode workbench. §5 stays inside model mode unless a beat
  explicitly switches.
- §6 (left palette) is the SAME tool surface in a different DOM container
  (`.palette-btn`). Beats below explicitly verify ribbon-vs-palette
  state synchrony.
- §7 (right sidebar) covers SCENE entries that should appear after each
  click-to-place beat below.

### Beats 140-143: TRANSFORM group (4 tools)

#### Beat 140: TRANSFORM > Select activates
1. **Do:** Click TRANSFORM > Select button (first tool in ribbon).
2. **See:** Select button gains `.active` styling. Cursor in viewport is
   default arrow. Statusbar Tool cell reads "Select".
3. **Verify:** `getState("activeTool") === "select"`. Button DOM has
   `.active` class. `data-tool="select"` is present.

#### Beat 141: TRANSFORM > Move + selection → translate gizmo
1. **Do:** Click any wall in the scene (selects it). Click TRANSFORM > Move.
2. **See:** Three.js TransformControls appear on selected wall — three
   colored arrows (R=X, G=Y, B=Z) at the wall's center.
3. **Verify:** `getState("activeTool") === "move"`. `viewer.transformControls
   .getMode() === "translate"` AND `viewer.transformControls.object` is
   the selected wall mesh.

#### Beat 142: TRANSFORM > Rotate → rotate gizmo
1. **Do:** With wall still selected, click TRANSFORM > Rotate.
2. **See:** TransformControls switch from arrows to three rotation circles
   (R=X-axis ring, G=Y-axis, B=Z-axis).
3. **Verify:** `viewer.transformControls.getMode() === "rotate"`. Statusbar
   Tool reads "Rotate".

#### Beat 143: TRANSFORM > Scale → scale gizmo
1. **Do:** With wall still selected, click TRANSFORM > Scale.
2. **See:** TransformControls switch to three scale handles (R/G/B cube
   handles on each axis tip).
3. **Verify:** `viewer.transformControls.getMode() === "scale"`. Statusbar
   Tool reads "Scale".

### Beats 144-149: SKETCH 2D fully-wired (3 tools, 2 beats each)

#### Beat 144: SKETCH 2D > Line click-to-place
1. **Do:** Click SKETCH 2D > Line. Click viewport at world (-2, -2). Click
   at world (2, 2).
2. **See:** First click drops a small marker at (-2, -2). Cursor draws a
   rubber-band preview line to the cursor position. Second click commits
   the line; markers clear; activeTool reverts to Select.
3. **Verify:** `getCreateSequence()` last entry contains `makeLine` or
   `drawLine` token (per `create-mode.ts:buildLine`). SCENE tab shows a
   new "line" entry.

#### Beat 145: SKETCH 2D > Line preview cancellation (ESC)
1. **Do:** Click SKETCH 2D > Line. Single-click viewport at (0, 0). Press ESC.
2. **See:** First-click marker disappears. Rubber-band preview disappears.
   activeTool stays "line" (or reverts to "select" — verify which).
3. **Verify:** `_pending` array in create-mode is cleared (no double-click
   geometry on next click triggers nothing). No new entry in
   `getCreateSequence()`.

#### Beat 146: SKETCH 2D > Rectangle click-to-place
1. **Do:** Click SKETCH 2D > Rectangle. Click world (-1, -1). Click world (1, 1).
2. **See:** Marker at first click. Rubber-band rectangle expands with cursor.
   Second click commits — 2×2m rectangle solid (height=2.8m default per
   `DEFAULT_RECT_HEIGHT`).
3. **Verify:** `getCreateSequence()` last entry: `drawRectangle(2, 2)
   .sketchOnPlane("XY").extrude(2.8).translate([0, 0, 0])`.

#### Beat 147: SKETCH 2D > Circle click-to-place
1. **Do:** Click SKETCH 2D > Circle. Click world (0, 0) (center). Click
   world (1.5, 0) (radius point).
2. **See:** Marker at center. Rubber-band circle expands as cursor moves
   away. Second click commits — 1.5m radius circle solid.
3. **Verify:** `getCreateSequence()` last entry contains `drawCircle(1.5)`
   or equivalent. Mesh radius matches per `THREE.CircleGeometry` test.

#### Beat 148: SKETCH 2D > Circle radius math
1. **Do:** Click Circle. Click (3, 0). Click (3, 4).
2. **See:** 4m-radius circle (Pythagorean: dx=0, dy=4 → r=4).
3. **Verify:** `getCreateSequence()` last entry has `drawCircle(4)` (the
   radial distance, not the absolute coords).

#### Beat 149: SKETCH 2D > Rect snap-to-grid
1. **Do:** Snap dock (right side) → Grid: ON, size 0.5. Click Rectangle.
   Click near (0.13, 0.27) — NOT exactly on grid.
2. **See:** Marker snaps to (0, 0.5) (nearest 0.5m intersection). Subsequent
   click also snaps.
3. **Verify:** First entry in `_pending` has snapped coords (per
   `snap-state.ts:snapPoint` from #194 Issue-9 fix).

### Beats 150-153: SKETCH 2D stubbed (4 tools, 1 beat each)

These tools activate (set `activeTool`) but click-to-place logs to console
without emitting geometry. Each beat MUST file a gap issue if the build
hasn't wired the kernel call.

#### Beat 150: SKETCH 2D > Polygon (stubbed click pipeline)
1. **Do:** Open DevTools console. Click SKETCH 2D > Polygon. Click viewport
   at (0, 0).
2. **See:** activeTool changes to "polygon". Statusbar reads "Polygon".
   Console emits a stub log. No geometry persists.
3. **Verify:** `getState("activeTool") === "polygon"`. `getCreateSequence()`
   length unchanged.
4. **Gap (file if hit):** "polygon click-to-place not wired — only console
   stub" with `create-mode.ts:Lxxx` citation. Reference issue #166 (command
   + hotkey system) as parent.

#### Beat 151: SKETCH 2D > Polyline (stubbed click pipeline)
1. **Do:** Click SKETCH 2D > Polyline. Click (0,0), (1,0), (1,1), (0,1),
   double-click to close.
2. **See:** activeTool="polyline". Console stub log per click. No geometry.
   Note: dispatch.ts:174 has a "polyline" case — verify whether that
   handler runs from click events or only DSL.
3. **Verify:** `getState("activeTool") === "polyline"`. Sequence unchanged.
4. **Gap (file if hit):** Discrepancy between dispatch.ts:174 polyline
   handler and create-mode.ts polyline-stub.

#### Beat 152: SKETCH 2D > Arc (stubbed)
1. **Do:** Click SKETCH 2D > Arc. Click 3 points (start, mid, end).
2. **See:** activeTool="arc". Console stub. No arc geometry.
3. **Gap (file if hit):** Arc click-to-place stubbed — file with arc-3-point
   construction note for the kernel handler.

#### Beat 153: SKETCH 2D > Spline (stubbed)
1. **Do:** Click SKETCH 2D > Spline. Click 4 points.
2. **See:** activeTool="spline". Console stub. No spline geometry.
3. **Gap (file if hit):** Spline click-to-place stubbed — file with
   degree-3 / catmull-rom default note.

### Beats 154-160: SOLID group (5 tools)

#### Beat 154: SOLID > Extrude (stubbed click; works via DSL)
1. **Do:** Click any 2D rectangle (selects). Click SOLID > Extrude.
2. **See:** activeTool="extrude". No height-prompt UI appears. (The DSL
   path `extrude(rect, 2)` in CONSOLE tab does work — that's the wired
   surface; click is stubbed.)
3. **Verify:** `getState("activeTool") === "extrude"`. Console stub.
4. **Gap:** Extrude click pipeline needs height-input UX (modal or
   numeric drag). File with reference to dispatch.ts extrude handler.

#### Beat 155: SOLID > Extrude via console DSL
1. **Do:** Open CONSOLE tab in dock. Type `rect(2, 2, 0)` Enter. Type
   `extrude(0, 3)` Enter (extrude index-0 result by 3m).
2. **See:** Console echoes both commands. After extrude: prismatic 2×2×3 box.
3. **Verify:** `getCreateSequence().length` increased by 2.

#### Beat 156: SOLID > Revolve (stubbed click)
1. **Do:** Click SOLID > Revolve.
2. **See:** activeTool="revolve". Console stub.
3. **Gap:** Revolve needs axis-line + profile pick. File.

#### Beat 157: SOLID > Fillet (verify in build)
1. **Do:** Select an edge of any solid. Click SOLID > Fillet.
2. **See:** Either (a) radius-prompt appears + edge fillets on commit, or
   (b) no UI — stub.
3. **Verify (a):** Mesh edge geometry replaced by radius arc.
   **Verify (b):** Console stub log; file gap.

#### Beat 158: SOLID > Chamfer (verify in build)
1. **Do:** Select an edge. Click SOLID > Chamfer.
2. **See:** As Beat 157 but flat 45° cut instead of arc.
3. **Verify:** Mirror Beat 157. File gap if stubbed.

#### Beat 159: SOLID > Boolean (routed via dispatch.ts:160)
1. **Do:** Select two intersecting solids (Ctrl+click second). Click
   SOLID > Boolean.
2. **See:** activeTool="boolean". Either (a) modal asks Union/Difference/
   Intersect, or (b) stub log.
3. **Verify (a):** Selecting Union → single fused mesh. Difference → first
   minus second. Intersect → only overlap.
4. **Cross-ref:** §15 "boolean + edge ops" covers full coverage; this
   beat is the activation smoke.

#### Beat 160: SOLID > Boolean via console DSL fallback
1. **Do:** CONSOLE: `union(0, 1)` (combine first two scene objects).
2. **See:** Two meshes replaced by single fused mesh. SCENE tab shows
   one entry where there were two.
3. **Verify:** `getCreateSequence()` last entry has `union` or `fuse` token.

### Beats 161-167: ARCH group (6 tools, 5 wired + stair stubbed)

#### Beat 161: ARCH > Wall click-to-place (canonical 2-click pipeline)
1. **Do:** Click ARCH > Wall. Click world (-3, 0). Click world (3, 0).
2. **See:** First click drops marker. Cursor extrudes a wall preview from
   marker → cursor. Second click commits — 6m wall, 0.2m thick, 3m tall
   (defaults from `create-mode.ts:23-24`), oriented along +X.
3. **Verify:** `getCreateSequence()` last entry contains `makeBox(6, 0.2, 3)
   .rotate(0, [0, 0, 0], [0, 0, 1]).translate([0, 0, 0])` per
   `buildWall()`. SCENE tab adds "wall" entry.

#### Beat 162: ARCH > Wall rotation
1. **Do:** Click Wall. Click (0, 0). Click (0, 5) — 90° rotated wall.
2. **See:** 5m wall placed along +Y axis.
3. **Verify:** `getCreateSequence()` last entry has `.rotate(90, [0, 0, 0],
   [0, 0, 1])`. Mesh `rotation.z` is π/2.

#### Beat 163: ARCH > Slab click-to-place (rect-style)
1. **Do:** Click ARCH > Slab. Click corner-1 (-2, -2). Click corner-2 (2, 2).
2. **See:** 4×4m slab (height 0.2m default per `DEFAULT_SLAB_THICKNESS`)
   placed at z=0 floor.
3. **Verify:** `getCreateSequence()` last entry has `makeBox(4, 4, 0.2)
   .translate([0, 0, ...])`. Slab mesh sits flush at z ∈ [-0.1, 0.1] (or
   [0, 0.2] depending on thickness anchor convention).

#### Beat 164: ARCH > Column click-to-place
1. **Do:** Click ARCH > Column. Click world (0, 0).
2. **See:** Single click commits — 4m-tall column (per
   `DEFAULT_COLUMN_HEIGHT`) at (0, 0).
3. **Verify:** `getCreateSequence()` last entry has column geometry with
   z-range [0, 4].

#### Beat 165: ARCH > Stair (stubbed)
1. **Do:** Click ARCH > Stair. Click two points.
2. **See:** activeTool="stair". Console stub. No stair geometry.
3. **Gap:** File "stair click-to-place not wired" with riser/tread default
   spec (e.g., 0.18m riser × 0.28m tread, riser/tread ≤ 7.75"/10" per
   §25 Schultz inventory's stair-name "7.75 max riser 10_LR").

#### Beat 166: ARCH > Door click-to-place (single-click on host wall)
1. **Do:** Place a wall first (Beat 161). Click ARCH > Door. Click on the
   wall surface near its midpoint.
2. **See:** Door opening (0.9m wide × 2.1m tall per `DEFAULT_DOOR_W/H`)
   appears in the wall, hosted at click location. KG triple
   `hosts(wall_id, door_id)` added.
3. **Verify:** `getCreateSequence()` last entry adds door geometry.
   `queryKG({p: "hosts"})` returns at least one wall→door triple.

#### Beat 167: ARCH > Window click-to-place
1. **Do:** Wall exists. Click ARCH > Window. Click on wall.
2. **See:** Window opening (1.2m × 1.4m, sill height 1.0m per
   `DEFAULT_WINDOW_W/H/SILL`) at click location.
3. **Verify:** `getCreateSequence()` last entry adds window geometry.
   KG `hosts(wall, window)` added. Sill anchors at z=1.0.

### Beats 168-169: MEASURE group (2 tools, status TBD)

#### Beat 168: MEASURE > Ruler (verify in build)
1. **Do:** Click MEASURE > Ruler. Click world (0, 0). Click world (3, 4).
2. **See:** Either (a) distance label "5.0 m" appears between markers, or
   (b) console stub.
3. **Verify (a):** Annotation persists; SCENE > ANNOTATIONS shows "ruler"
   entry. Pythagorean: √(9+16) = 5. **Verify (b):** Stub log; file gap.

#### Beat 169: MEASURE > Compass (verify in build)
1. **Do:** Click MEASURE > Compass. Click center. Click circumference.
2. **See:** Either (a) construction circle drawn (non-solid, dashed annotation
   style), or (b) stub.
3. **Verify:** Mirror 168.

### Beats 170-175: Ribbon tabs (6 tabs, 1 beat each)

The ribbon-tabs strip lives ABOVE ribbon-tools (`shell.ts:486-504`). Each
tab is a `<div class="ribbon-tab">` with `data-tab` and `aria-selected`.

#### Beat 170: MODEL tab default + active class
1. **Do:** Page load. Inspect ribbon-tabs strip.
2. **See:** "MODEL" tab has `.active` class. Other 5 tabs are inactive.
3. **Verify:** `document.querySelector('.ribbon-tab.active').dataset.tab
   === "MODEL"`. `aria-selected="true"` only on MODEL.

#### Beat 171: DRAFT tab click
1. **Do:** Click "DRAFT" tab.
2. **See:** Active class moves from MODEL to DRAFT. ribbon-tools area
   updates (or stays — verify whether tools change per tab).
3. **Verify:** `document.querySelector('.ribbon-tab.active').dataset.tab
   === "DRAFT"`. `aria-selected` flipped.
4. **Gap (potentially):** If the tools area is identical across all 6 tabs,
   that's a UX gap — file "ribbon tabs do not change tool surface; tab
   strip is decorative". Mirrors app.jsx's per-tab tool customization.

#### Beat 172: ANALYZE tab
1. **Do:** Click "ANALYZE".
2. **See/Verify:** Mirror Beat 171. File same gap if tool surface unchanged.

#### Beat 173: RENDER tab
1. **Do:** Click "RENDER".
2. **See/Verify:** Mirror.

#### Beat 174: ANNOTATE tab
1. **Do:** Click "ANNOTATE".
2. **See/Verify:** Mirror.

#### Beat 175: SUBMIT tab
1. **Do:** Click "SUBMIT".
2. **See/Verify:** Mirror. Gap-file if SUBMIT does not surface any
   submission UX (export-to-judges, repo push, etc.) — that's a
   hackathon-relevant feature.

### Beats 176-177: Ribbon-right (2 actions)

#### Beat 176: ⌘K palette button opens cmdk
1. **Do:** Click `#ribbon-palette-btn` (icon "command" + "⌘K" label).
2. **See:** Cmd+K palette overlay opens. Input focused.
3. **Verify:** `openCmdK()` invoked. `.cmdk-overlay` DOM has `display !==
   "none"` (or `[data-open="true"]`).

#### Beat 177: EXPORT button opens export drawer
1. **Do:** Click `#ribbon-export-btn` (icon "export" + "EXPORT" label).
2. **See:** Export drawer opens (right-side slide-in panel per
   `export-drawer.ts`).
3. **Verify:** `openExportDrawer()` invoked. Drawer DOM is mounted +
   visible.

### Beats 178-189: Cross-cuts (12 beats)

#### Beat 178: tool-btn icons render as SVG (not text labels)
1. **Do:** Inspect any `.tool-btn` in DOM.
2. **See:** Inner HTML is `<svg>...</svg>` from `iconSVG(tool.icon, 16)`.
   No text content (text fallback would indicate `iconSVG()` returned
   empty).
3. **Verify:** `el.querySelector('svg') !== null`. `el.textContent.trim()
   === ""`. (T7 acceptance criterion in plan.)

#### Beat 179: tool-btn 28×28 square (T7 size)
1. **Do:** Inspect bounding box of any `.tool-btn`.
2. **See:** Width and height both 28px (or close — CSS rounding).
3. **Verify:** `el.getBoundingClientRect()` width === height === 28
   (±1px for sub-pixel rounding).

#### Beat 180: tool-btn tooltip on hover
1. **Do:** Hover any `.tool-btn` (e.g. Wall) for >800ms.
2. **See:** Native browser tooltip shows the tool's `label` (e.g. "Wall").
3. **Verify:** `el.title === "Wall"` (set in `shell.ts:521`).

#### Beat 181: tool-group label visible
1. **Do:** Inspect any `.tool-group` in DOM.
2. **See:** Inside the group's container, a `<span class="tool-group-label">`
   shows the group name ("TRANSFORM", "SKETCH 2D", "SOLID", "ARCH",
   "MEASURE").
3. **Verify:** `groupEl.querySelector('.tool-group-label').textContent ===
   group.label` for each of the 5 groups.

#### Beat 182: dataset.tool round-trip
1. **Do:** Inspect every `.tool-btn[data-tool]`.
2. **See:** 24 buttons, each with a unique `data-tool` matching one entry
   in `TOOL_GROUPS[].tools[].id`.
3. **Verify:** `[...document.querySelectorAll('.tool-btn[data-tool]')]
   .map(b => b.dataset.tool)` returns exactly the 24 ids in TOOL_GROUPS
   order.

#### Beat 183: activeTool persistence across reload
1. **Do:** Click ARCH > Door. Reload page (F5 or Ctrl+R).
2. **See:** After reload, Door button has `.active` class; statusbar Tool
   reads "Door".
3. **Verify:** `getState("activeTool") === "door"` post-reload. localStorage
   has key `app-state.activeTool` with value "door" (per
   `app-state.ts:hydrateFromStorage`).
4. **Gap (file if missing):** If activeTool does NOT persist, that's an
   app-state hydration gap. File against `app-state.ts`.

#### Beat 184: ribbon vs left-palette tool sync
1. **Do:** Click ARCH > Wall on RIBBON. Inspect the LEFT palette.
2. **See:** Both surfaces show Wall as active. (Same `activeTool` state
   key drives both.)
3. **Verify:** `.tool-btn[data-tool="wall"].active` exists in `.ribbon-tools`
   AND `.palette-btn[data-tool="wall"].active` exists in left-palette.
4. **Cross-ref:** §6 will exhaustively cover the left-palette surface;
   this beat verifies the synchrony point.

#### Beat 185: clicking same tool twice does not de-activate
1. **Do:** Click ARCH > Wall (activates). Click ARCH > Wall again.
2. **See:** Wall stays active. activeTool stays "wall".
3. **Verify:** `getState("activeTool") === "wall"` after both clicks.
   No "select" fallback.

#### Beat 186: ribbon-tools horizontal scroll at narrow viewport
1. **Do:** Resize window to ≤900px wide.
2. **See:** ribbon-tools area becomes horizontally scrollable. All 24
   tool buttons remain accessible (scroll right reveals MEASURE group).
3. **Verify:** `.ribbon-tools` `scrollWidth > clientWidth`. No tool button
   is `display:none` due to narrow viewport.

#### Beat 187: Tool button focus ring visibility (a11y)
1. **Do:** Tab from menubar through ribbon-tabs to tool-btn.
2. **See:** Focus ring visible on whichever button receives focus.
   Outline does NOT collapse to 0.
3. **Verify:** `getComputedStyle(focusedBtn, ':focus-visible').outline`
   is non-empty AND non-`none`.

#### Beat 188: ribbon-tabs role="tablist" ARIA
1. **Do:** Inspect `.ribbon-tabs` in accessibility tree.
2. **See:** Container has `role="tablist"`. Each child has `role="tab"`.
3. **Verify:** `document.querySelector('.ribbon-tabs').getAttribute('role')
   === "tablist"`. Each `.ribbon-tab` has `role === "tab"`.

#### Beat 189: dispatch.ts canonical-name parity check
1. **Do:** For each tool id in `TOOL_GROUPS`, verify a corresponding
   handler exists in `dispatch.ts` (per T6 plan acceptance).
2. **See/Verify:** Run `bun web/test/dispatch.test.ts` (per plan T6
   verification row). For every entry in `spatial-dictionary.yaml`:
   `dispatch(canonical_name, valid_args)` returns `{ok: true}`. With
   invalid args: `{ok: false, error: "ArgValidationError"}`.
3. **Gap (file if hit):** Any tool id in `TOOL_GROUPS` that lacks a
   dispatch handler entry. Cross-ref to spatial-dictionary.yaml.

═══════════════════════════════════════════════════════════════════════════

## §6 — Left palette (24 beats)

The left palette (`.palette` rail in workbench) is the always-visible tool
surface — Rhino-style "Tools" panel. Source: `web/src/workbench.ts`
`PALETTE_SECTIONS` (lines 51-75) + `buildPalette` (lines 111-131).

**4 sections, 15 tools** (a SUBSET of the ribbon's 24):
- TRANSFORM (4): select, move, rotate, scale
- SKETCH 2D (4): line, rect, circle, polyline — *no polygon/arc/spline*
- SOLID (3): extrude, boolean, fillet — *no revolve/chamfer*
- ARCH (4): wall, slab, column, stair — *no door/window*
- *MEASURE absent* (no ruler/compass)

**9 tools are ribbon-only** — that's a UX gap. The palette is the
primary always-visible surface; forcing users to dive into ribbon tabs
for door/window/arc/ruler is friction. Beat 210 below files as #166
follow-up.

Each `.palette-btn` carries `data-tool=<id>` and on click calls
`setState("activeTool", tool.id)` — same state key as ribbon. The
`.active` class on EVERY `[data-tool]` element (palette + ribbon)
is driven by `syncToolActiveClass` in `app-state.ts` — no local toggle.

Cross-refs:
- §5 beat 184 already verified ribbon→palette sync (clicking ribbon
  Wall sets palette Wall active). §6 beat 206 verifies the inverse.
- Snap dock is also rendered by workbench but lives in §8 (16 beats).
- Sidebar is rendered alongside palette; covered fully in §7.

### Beats 190-193: TRANSFORM section (4 tools)

#### Beat 190: Palette > Select (default + click)
1. **Do:** Page load. Inspect `.palette` for active button. Then click
   any other tool, then click Select again.
2. **See:** On load, Select has `.active` class (default `activeTool === "select"`).
   Switching away then back restores `.active`.
3. **Verify:** `document.querySelector('.palette-btn[data-tool="select"].active')`
   exists on load. `getState("activeTool") === "select"`.

#### Beat 191: Palette > Move
1. **Do:** Click `.palette-btn[data-tool="move"]`.
2. **See:** Active class moves from Select to Move. Statusbar Tool="Move".
   Ribbon TRANSFORM > Move ALSO gains `.active` (sync).
3. **Verify:** `getState("activeTool") === "move"`. BOTH `.palette-btn
   [data-tool="move"].active` AND `.tool-btn[data-tool="move"].active`
   exist in DOM.

#### Beat 192: Palette > Rotate
1. **Do:** Click palette Rotate.
2. **See:** Active class moves to Rotate; Statusbar Tool="Rotate"; ribbon
   sync. If a mesh is selected, transform gizmo switches to rotate mode.
3. **Verify:** `getState("activeTool") === "rotate"`. Sync as Beat 191.

#### Beat 193: Palette > Scale
1. **Do:** Click palette Scale.
2. **See:** Active class moves to Scale; ribbon sync; gizmo switches.
3. **Verify:** Mirror Beat 192 with scale.

### Beats 194-197: SKETCH 2D section (4 tools — note polygon/arc/spline absent)

#### Beat 194: Palette > Line click pipeline
1. **Do:** Click palette Line. Click viewport at world (-1, 0). Click (1, 0).
2. **See:** Sketcher activates (marker + rubber band). Second click commits
   2m line. Same pipeline as ribbon-driven Line (§5 beat 144).
3. **Verify:** `getCreateSequence()` last entry contains `makeLine` /
   `drawLine`. Pipeline-source-agnostic — palette and ribbon converge
   on the same `create-mode.ts` handlers.

#### Beat 195: Palette > Rectangle click pipeline
1. **Do:** Click palette Rect. Click (-1, -1) and (1, 1).
2. **See:** 2×2m rect placed (default 2.8m extruded height).
3. **Verify:** Mirror §5 beat 146.

#### Beat 196: Palette > Circle click pipeline
1. **Do:** Click palette Circle. Click center (0, 0). Click radial (2, 0).
2. **See:** 2m-radius circle solid placed.
3. **Verify:** Mirror §5 beat 147.

#### Beat 197: Palette > Polyline (stubbed click — same gap as §5 beat 151)
1. **Do:** Click palette Polyline. Click 4 points.
2. **See:** activeTool="polyline", console stub log per click, no geometry.
3. **Verify:** `getState("activeTool") === "polyline"`. Sequence unchanged.
4. **Cross-ref:** Same gap-issue as §5 beat 151 — single create-mode.ts
   stub serves both surfaces.

### Beats 198-200: SOLID section (3 tools — note revolve/chamfer absent)

#### Beat 198: Palette > Extrude (stubbed click; DSL works)
1. **Do:** Click palette Extrude.
2. **See:** activeTool="extrude". No height-prompt UI. Same stub as §5
   beat 154. The CONSOLE-tab DSL `extrude(0, 3)` is the working path.
3. **Verify:** `getState("activeTool") === "extrude"`.

#### Beat 199: Palette > Boolean (dispatch.ts:160 routed)
1. **Do:** Select two intersecting solids. Click palette Boolean.
2. **See:** Either modal (Union/Difference/Intersect) or stub log —
   verify in build, mirror §5 beat 159.
3. **Verify:** `getState("activeTool") === "boolean"`. Dispatch routing
   active.

#### Beat 200: Palette > Fillet (verify in build)
1. **Do:** Select an edge. Click palette Fillet.
2. **See:** Mirror §5 beat 157.
3. **Verify:** Mirror.

### Beats 201-204: ARCH section (4 tools — note door/window absent)

#### Beat 201: Palette > Wall click pipeline
1. **Do:** Click palette Wall. Click (-3, 0) and (3, 0).
2. **See:** 6m wall placed (height 3m, thickness 0.2m). Same pipeline as
   §5 beat 161.
3. **Verify:** `getCreateSequence()` last entry has `makeBox(6, 0.2, 3)
   .rotate(0, ...)`.

#### Beat 202: Palette > Slab click pipeline
1. **Do:** Click palette Slab. Click corners (-2, -2) and (2, 2).
2. **See:** 4×4m slab at floor level.
3. **Verify:** Mirror §5 beat 163.

#### Beat 203: Palette > Column click pipeline
1. **Do:** Click palette Column. Click (0, 0).
2. **See:** 4m column at origin.
3. **Verify:** Mirror §5 beat 164.

#### Beat 204: Palette > Stair (stubbed)
1. **Do:** Click palette Stair. Click two points.
2. **See:** activeTool="stair", console stub. Same gap as §5 beat 165.
3. **Verify:** Sequence unchanged.

### Beats 205-213: Cross-cuts (9 beats)

#### Beat 205: Palette section dividers visible
1. **Do:** Inspect `.palette` DOM.
2. **See:** Four `.palette-section` containers, each holding 3-4
   `.palette-btn` children. Visual gap between sections (CSS spacing).
3. **Verify:** `document.querySelectorAll('.palette-section').length === 4`.
   Cumulative button count: `.palette-btn` total === 15.

#### Beat 206: Palette ← Ribbon sync (inverse of §5 beat 184)
1. **Do:** Click palette ARCH > Wall. Inspect ribbon ARCH group.
2. **See:** Ribbon's Wall button gains `.active` simultaneously.
3. **Verify:** Both `.palette-btn[data-tool="wall"].active` AND
   `.tool-btn[data-tool="wall"].active` present in DOM. (sync via
   `syncToolActiveClass` per `app-state.ts`.)

#### Beat 207: Palette icon size 18×18 (vs ribbon's 16×16)
1. **Do:** Inspect any `.palette-btn` SVG.
2. **See:** Inner SVG has `width="18" height="18"` per `iconSVG(tool.icon,
   18)` at workbench.ts:117.
3. **Verify:** SVG attributes width===18 AND height===18. Confirms palette
   uses larger icons than ribbon (16) — intentional per design.

#### Beat 208: Palette tooltip + corner element render
1. **Do:** Inspect a `.palette-btn` inner HTML.
2. **See:** Three children: `<svg>` icon, `<span class="palette-tooltip">`
   with the label text, and `<span class="corner">` (decorative corner
   indicator per workbench.ts:117-118).
3. **Verify:** `.palette-tooltip` text matches tool's `label`.
   `.corner` exists.

#### Beat 209: Palette tooltip on hover
1. **Do:** Hover a `.palette-btn` for >300ms.
2. **See:** `.palette-tooltip` becomes visible (CSS-driven, likely
   `opacity` or `display` on `:hover`). Native `title` also fires after
   ~800ms.
3. **Verify:** `.palette-tooltip` computed style transitions on hover.

#### Beat 210: GAP — 9 ribbon-only tools missing from palette
1. **Do:** Inspect `[...document.querySelectorAll('.palette-btn')]
   .map(b => b.dataset.tool)`. Compare against `[...document
   .querySelectorAll('.tool-btn')].map(b => b.dataset.tool)`.
2. **See:** Palette has 15 ids; ribbon has 24. Set-difference yields
   9 ribbon-only ids: `polygon`, `arc`, `spline`, `revolve`, `chamfer`,
   `door`, `window`, `ruler`, `compass`.
3. **Verify:** Set diff is exactly those 9.
4. **Gap (file):** "Left palette missing 9 tools that exist in ribbon —
   forces users into ribbon tabs for door/window/arc/ruler. Most-impacted
   §25 reconstruction surface needs door + window in palette."
   Cross-ref to issue #166 (command + hotkey system) as parent.

#### Beat 211: data-tool round-trip (15 unique ids in palette)
1. **Do:** Read all `.palette-btn[data-tool]`.
2. **See:** 15 unique strings.
3. **Verify:** `new Set([...document.querySelectorAll('.palette-btn')]
   .map(b => b.dataset.tool)).size === 15` AND set equals
   `{select, move, rotate, scale, line, rect, circle, polyline, extrude,
   boolean, fillet, wall, slab, column, stair}`.

#### Beat 212: ESC during palette-driven sketch cancels properly
1. **Do:** Click palette Wall. Click (0, 0) (first point). Press ESC.
2. **See:** Marker disappears; rubber band disappears; activeTool reverts
   per create-mode behavior. Pipeline-state matches §5 beat 145 (line
   ESC cancel) — same handler.
3. **Verify:** `_pending` array (in create-mode module scope) is cleared.
   Subsequent click does not commit a 1-point wall.

#### Beat 213: Palette + ribbon de-sync stress test
1. **Do:** Rapid alternate clicks: palette Wall → ribbon Door → palette
   Slab → ribbon Window. (Ribbon Door/Window are ribbon-only per
   Beat 210; these clicks should still work, but PALETTE cannot show
   them as active.)
2. **See:** When activeTool is ribbon-only (door/window), palette has
   NO `.active` button. Statusbar reflects current tool. Ribbon button
   has `.active`.
3. **Verify:** After clicking ribbon Door: `getState("activeTool") ===
   "door"`. `.tool-btn[data-tool="door"].active` exists. NO `.palette-btn
   .active` exists (palette has no door entry — sync'd correctly to
   "no match" rather than stale-active).
4. **Gap (file if hit):** If palette retains stale `.active` after
   switching to a ribbon-only tool, that's a `syncToolActiveClass`
   bug — file with cite to `app-state.ts`.

═══════════════════════════════════════════════════════════════════════════

## §7 — Right sidebar (40 beats)

The right sidebar is the always-visible inspector + asset pane. Source:
`web/src/workbench.ts` `buildSidebar` (lines 249-293) + helpers in
the same file + `web/src/scene-panel.ts` `buildSelectionFiltersPanel`
(lines 256-285).

**Structure (top to bottom):**
1. `.sb-tabs` — strip with 3 tabs: SCENE / INSPECT / ASSETS
2. `.sb-body` — single-pane container; only the active tab's pane is
   appended here at any time
3. `.selection-filters` — 8-checkbox filter panel (Issue 5 always-visible
   fix landed at `3385f9d`)
4. `.snap-dock` — covered separately in §8

**Default tab:** SCENE (per `activate("scene")` at workbench.ts:292).

**Cross-refs:**
- §6 beat 213 noted ribbon-only tools that palette can't sync; INSPECT
  populates from `selectedId` state — beats 226-235 verify the binding.
- §8 covers Snap dock (`buildSnapDock()` at workbench.ts:133-163).
- §12 covers selection filter behavior (raycast pick filtering).
  §7 here verifies surface presence + a11y only.

### Beats 214-217: Sidebar shell (4 beats)

#### Beat 214: Three sb-tabs render
1. **Do:** Inspect `.sb-tabs` strip at top of sidebar.
2. **See:** Three tab elements with text "SCENE", "INSPECT", "ASSETS"
   (per `SIDEBAR_TABS` at workbench.ts:87-91).
3. **Verify:** `document.querySelectorAll('.sb-tabs .sb-tab').length === 3`.
   Tabs in DOM order match SIDEBAR_TABS order.

#### Beat 215: SCENE is default-active on load
1. **Do:** Page load. Inspect `.sb-tabs`.
2. **See:** SCENE tab has `.active` class. INSPECT and ASSETS do not.
   `.sb-body` contains a `.scene-tab` body.
3. **Verify:** `document.querySelector('.sb-tab.active').dataset.tab
   === "scene"`. `.sb-body > .scene-tab` exists.

#### Beat 216: Tab switch swaps body content
1. **Do:** Click INSPECT tab.
2. **See:** Active class moves SCENE → INSPECT. `.sb-body` content
   swaps from `.scene-tab` to `.props` (per `buildInspectTab`).
3. **Verify:** `.sb-tab.active` is INSPECT. `.sb-body.firstElementChild
   .className.includes("props")`. SCENE pane is no longer in DOM (per
   `body.innerHTML = ""` at workbench.ts:282).

#### Beat 217: Tab a11y minimal — focusable + click target
1. **Do:** Tab through page until SCENE/INSPECT/ASSETS receive focus.
2. **See:** Focus ring visible. Enter/Space activates the tab.
3. **Verify:** `tabIndex >= 0` on `.sb-tab` elements. (If the bundle
   omits `role="tab"` / `aria-selected`, file as a11y gap — currently
   there's no role/aria attribute set per workbench.ts:271.)

### Beats 218-225: SCENE tab (8 beats)

#### Beat 218: SCENE empty-state hint
1. **Do:** Page load with NO scene loaded (or click "New" to clear).
2. **See:** SCENE pane shows hint text "No scene loaded — drop an
   IFC/GLB or pick a sample." (per workbench.ts:172).
3. **Verify:** `.scene-tab .empty-hint` visible AND its textContent
   matches that string. No `.scene-panel-embed` present.

#### Beat 219: SCENE populated after sample load
1. **Do:** ASSETS tab → click Schultz Resid. → wait for load.
2. **See:** SCENE pane updates: scene-panel embedded with `.scene-panel-embed`
   class. List of placed elements appears.
3. **Verify:** `.scene-tab > .scene-panel-embed` exists. List has at
   least one entry.

#### Beat 220: SCENE storey grouping (Issue 5 collapsible sections)
1. **Do:** Schultz loaded. Inspect SCENE list.
2. **See:** Entries grouped by storey (Basement / 1st Floor / 2nd Floor /
   3rd Floor / Roof / etc., per Schultz's 11 named storeys + Unassigned).
   Each storey heading is collapsible (chevron toggle).
3. **Verify:** Issue 5 fix landed at `3385f9d`. Click a storey heading;
   that storey's children hide/show. Expanded/collapsed state persists
   per session.

#### Beat 221: SCENE click selects mesh in viewport
1. **Do:** Click any SCENE entry (e.g. a wall in 1st Floor).
2. **See:** That mesh highlights in viewport (selection outline / color
   pop). Statusbar Sel cell updates with element id.
3. **Verify:** `getState("selectedId")` matches the clicked entry's
   element id. Viewer's selection outline mesh exists with the right
   target.

#### Beat 222: SCENE element count matches scene
1. **Do:** Schultz loaded. Count visible entries in SCENE (across all
   expanded storeys).
2. **See:** Count matches Schultz's reconstruction inventory: **549
   architectural elements** (4 IfcWall + 101 IfcWallStandardCase + 12
   IfcSlab + 17 IfcDoor + 25 IfcWindow + 10 IfcStair + 2 IfcStairFlight
   + 25 IfcColumn + 83 IfcBeam + 253 IfcRailing + 3 IfcRoof + 3 IfcSpace
   + 11 IfcBuildingStorey).
3. **Verify:** Reading `docs/qa/schultz-reconstruction-tables/README.md`
   gives the same totals; SCENE list count must equal that within
   ±0 (placed elements only — exclude Storey containers if SCENE shows
   contained-only). Allowed delta: 549 vs 538 (placed-only) is OK iff
   SCENE excludes IfcBuildingStorey containers — verify which.

#### Beat 223: SCENE selection sync — viewport pick highlights SCENE entry
1. **Do:** Click any wall in viewport (not in SCENE list).
2. **See:** Corresponding SCENE entry gains `.selected` styling (color /
   bg). Storey containing it auto-expands if collapsed.
3. **Verify:** `.scene-panel .scene-row.selected` exists. Its element id
   matches `getState("selectedId")`.

#### Beat 224: SCENE Del key removes entry + mesh + KG triple
1. **Do:** Click any wall (selection visible). Press Del.
2. **See:** Mesh disappears from viewport. SCENE entry removed. Statusbar
   Sel reverts to "—".
3. **Verify:** `getCreateSequence()` length decreased by 1. KG triples
   for that element are gone (`queryKG({s: <uuid>})` returns empty).
   `.scene-panel .scene-row[data-id="<uuid>"]` is gone.

#### Beat 225: SCENE persistence across reload
1. **Do:** Place a wall via click pipeline. Reload page.
2. **See:** Wall persists (if persistence #155 / #176 wired) OR scene
   is empty per session-only behavior.
3. **Verify:** Either `getCreateSequence().length === 1` post-reload
   (persistent) OR === 0 (session-only). File gap if neither and
   behavior is unclear/inconsistent.

### Beats 226-235: INSPECT tab (10 beats)

#### Beat 226: INSPECT empty-state — "no selection" subtitle
1. **Do:** No selection. Open INSPECT tab.
2. **See:** Header reads title="—" subtitle="no selection" (per
   workbench.ts:184-185).
3. **Verify:** `.props-title` text === "—". `.props-subtitle` text ===
   "no selection".

#### Beat 227: INSPECT IDENTITY section structure
1. **Do:** Inspect INSPECT pane DOM.
2. **See:** Three sub-sections: IDENTITY, TRANSFORM, STATUS (per
   workbench.ts:188-213). IDENTITY has 3 rows: Name, GUID, Layer (all "—"
   stub values).
3. **Verify:** `.prop-section-title` x3 with text matching ["IDENTITY",
   "TRANSFORM", "STATUS"]. IDENTITY has 3 `.prop-row` children.

#### Beat 228: INSPECT TRANSFORM section structure
1. **Do:** Same DOM inspect.
2. **See:** TRANSFORM has two `.prop-vec3` rows (Position + Rotation),
   each with three `.axis` spans labeled X/Y/Z. Initial values:
   Position 0.000/0.000/0.000, Rotation 0°/0°/0°.
3. **Verify:** `.prop-vec3` x2. Each has 3 `.axis[data-axis]` children
   matching X / Y / Z.

#### Beat 229: INSPECT STATUS message
1. **Do:** Same DOM inspect.
2. **See:** STATUS section reads "Mode: live · object inspector populates
   after #176 wires geometry → IFC4 round-trip" (per workbench.ts:211).
3. **Verify:** `.prop-section:nth-child(...)` STATUS row text matches.
   This message acknowledges the stub status.

#### Beat 230: INSPECT populates on selection (RESOLVED at e382d93 first pass)
1. **Do:** Click any wall. Open INSPECT tab.
2. **See:** Header `props-title` updates from "—" to the wall's
   `obj.name` (or first 8 chars of uuid if name empty). Subtitle
   updates from "no selection" to the topology level (e.g. "mesh"
   or "brep"). GUID `[data-field="guid"]` shows first 16 chars of
   uuid + "…". Position xyz shows world coords to 3 decimals.
3. **Verify:** Subscription wired at `workbench.ts:234`
   (`subscribe(updateInspect)`). Initial call at `:235`. Branch
   handling at `:214-231` (null clears all `.v` and `.axis` to "—";
   non-null populates title/subtitle/guid/position).
4. **History:** Was a static-HTML stub before e382d93; first pass
   wires title + subtitle + GUID + Position. Beats 231-234 below
   track the remaining fields (Rotation/Layer/BOUNDS/storey/IFC-class/
   multi-select).

#### Beat 231: BOUNDS section wired (RESOLVED at 4d5573f) — per-element value pending
1. **Do:** Load Schultz. Click anywhere on the merged mesh. INSPECT.
2. **See:** BOUNDS section visible (per workbench.ts:210-218 added by
   4d5573f). dX/dY/dZ axes show the WHOLE-FILE bounding box (~30m+
   for Schultz) computed via `THREE.Box3().setFromObject(obj)` +
   `box.getSize()` (workbench.ts:251-260).
3. **Verify:** `.prop-section-title` includes "BOUNDS". `.axis
   [data-axis="dX"]` populated with finite number when selection has
   a valid bbox; "—" otherwise (isFinite check at workbench.ts:253).
4. **Pending (next sub-issue):** Per-element bounds — `setFromObject`
   on the merged-IFC root returns the whole-file bbox, NOT the picked
   wall's. Resolves when IFC loader emits a Group of per-element meshes
   instead of one merged mesh; raycast hit then returns the specific
   element. Beat 235's wall-316472 bounds (dx=1.151/dy=0.594/dz=0.046)
   only smokes after that refactor.

#### Beat 232: Storey row wired (RESOLVED at 4d5573f) — value placeholder
1. **Do:** Click any wall. INSPECT.
2. **See:** IDENTITY > Storey row present (per workbench.ts:192 added
   by 4d5573f). Value is "—" placeholder because storey-per-element
   needs per-element-mesh + `userData.storeyName` plumbing.
3. **Verify:** `.prop-row [data-field="storey"]` exists. Placeholder
   set explicitly at workbench.ts:241 with comment acknowledging the
   defer.
4. **Pending (next sub-issue):** Once per-element meshes land with
   `userData.storeyName`, `updateInspect()` reads it directly. Then
   wall 316472 → "1st Floor" per Schultz reconstruction tables.

#### Beat 233: Type row wired (4d5573f); IFC entity class still pending
1. **Do:** Click any wall. INSPECT.
2. **See:** IDENTITY > Type row present (per workbench.ts:190 added
   by 4d5573f), populated from `sel.topology` (e.g. "mesh" or "brep").
3. **Verify:** `.prop-row [data-field="type"]` populated with topology
   string at workbench.ts:236.
4. **Distinction:** "Type" here is THREE.js topology level
   (Mesh/Group/Object3D), NOT IFC entity class. The IFC class
   (e.g. "IfcWallStandardCase") still requires per-element meshes
   with `userData.ifcClass` from hierarchy[].
5. **Pending:** Add a separate "IFC Class" row OR repurpose "Type" to
   show IFC class when available, falling back to topology otherwise.
   Decision can wait until per-element-mesh refactor lands.

#### Beat 234: Multi-select header (deferred-per-design at 4d5573f)
1. **Do:** Click wall A. Ctrl+click wall B. INSPECT.
2. **See:** Currently shows wall B's data only (last selected wins).
   `selection-state.ts` only models single-selection.
3. **Verify:** Header text reflects only one item.
4. **Deferred (separate task):** selection-state extension to support
   multi-select is its own deliverable; INSPECT's "(N items)" header
   waits on that. Not blocking §25 reconstruction (Schultz is built
   element-by-element, single-select per beat).

#### Beat 235: INSPECT full reconstruction-parity smoke (terminal beat)
1. **Do:** ASSETS → Schultz Resid. → click anywhere on the merged
   IFC mesh (current single-merged-mesh build).
2. **See (current build, post-4d5573f):** Title = "Schultz_Residence.ifc"
   (filename, per loader.ts:209-210). Type = "mesh". GUID = first 16
   chars of three.js uuid. Position = (0,0,0) or whole-mesh world
   transform. BOUNDS = whole-Schultz bbox (~30m × 30m × 8m or so).
   Storey = "—" placeholder.
3. **See (terminal target — requires per-element-mesh refactor):**
   Click wall id 316472 in viewport → Title="Basic Wall:2x4
   stud:431027", Type="IfcWallStandardCase", Storey="1st Floor",
   Position x=-0.283/y=-1.150/z=0.039, BOUNDS dx=1.151/dy=0.594/
   dz=0.046 — all matching `docs/qa/schultz-reconstruction-tables/
   storey-05-1st-floor.md` row 316472.
4. **Verify:** Each prop-row's `.v` matches the reconstruction-tables
   entry for that element id. Bidirectional smoke: select element id
   316472 → INSPECT shows x=-0.283, y=-1.150, z=0.039, dx=1.151,
   dy=0.594, dz=0.046, storey="1st Floor". File a beat-failure if
   numeric Position differs from table by > 0.001m.
5. **Architecture gate (RESOLVED at b451932):** Per-element mesh
   refactor landed. worker.ts now emits `elementRanges` (expressID +
   vertex/index offsets per IFC element) on `LoadIfcSuccess`;
   `loader.ts:buildIfcMesh` materialises a `THREE.Group` of
   per-element `THREE.Mesh` instances, slicing vertex/normal/color
   buffers per range, remapping indices to element-local space, and
   attaching `userData.{expressID, ifcClass, guid, storeyName,
   storeyElevation}` from the hierarchy[] lookup. Mesh `name` set
   from `hierarchy.name`. `workbench.ts:updateInspect` reads
   `userData.ifcClass / .guid / .storeyName` when present (real data
   for IFC) and falls back to topology/uuid otherwise. Position
   uses `Box3.getCenter` (correct for world-space-baked IFC vertices,
   which is how web-ifc emits them).
6. **Live smoke verification:** Jun runs the click in the web app —
   load Schultz, click wall id 316472 in viewport (or via SCENE
   tree), confirm INSPECT shows the table-derived values within
   1mm tolerance. Failures here surface as element-pairing or
   coordinate-frame bugs in `loader.ts` slicing logic, NOT
   architectural gaps. File against b451932 if mismatch.

### Beats 236-247: ASSETS tab (12 beats)

#### Beat 236: ASSETS search input renders
1. **Do:** Click ASSETS tab. Inspect top of pane.
2. **See:** Search row with magnifying-glass icon + input with
   placeholder "search samples, primitives, blocks..." (per
   workbench.ts:220).
3. **Verify:** `.assets-search input[placeholder*="search samples"]`
   exists.

#### Beat 237: ASSETS "SAMPLE FILES" section divider
1. **Do:** Same DOM inspect.
2. **See:** Centered "SAMPLE FILES" label flanked by hairlines (per
   workbench.ts:225).
3. **Verify:** Section label text === "SAMPLE FILES" (case-sensitive).

#### Beat 238: ASSETS — 8 sample cards render
1. **Do:** Same DOM inspect.
2. **See:** 8 `.asset-card` entries: Schultz Resid., FZK-Haus,
   Institute v2, Bonsai openings, Wall+Window, Sweep · simple,
   Triangle (OBJ), Triangle (STL) — per `SAMPLE_ASSETS` at
   workbench.ts:93-102.
3. **Verify:** `document.querySelectorAll('.asset-grid .asset-card')
   .length === 8`. Each has unique `data-sample` attr.

#### Beat 239: ASSETS — Schultz card click loads sample
1. **Do:** Click `.asset-card[data-sample="schultz-residence"]`.
2. **See:** Card gains `.selected` class. `#sample-select` dropdown's
   value updates to "schultz-residence". Sample loader fires `change`
   event. Loading indicator appears; eventually scene populates.
3. **Verify:** `.asset-card.selected` is the Schultz card. After load:
   `getCreateSequence().length > 0`.

#### Beat 240: ASSETS — single-select behavior (.selected exclusivity)
1. **Do:** Click Schultz card. Then click FZK-Haus card.
2. **See:** Schultz loses `.selected`; FZK-Haus gains it (per
   workbench.ts:239 — querySelectorAll removal pattern).
3. **Verify:** Exactly one `.asset-card.selected` exists at any time.

#### Beat 241: ASSETS — change event dispatch path
1. **Do:** Spy on `#sample-select` change event. Click any asset card.
2. **See:** `change` event fires on `#sample-select` with the card's
   `data-sample` value (per workbench.ts:264-266 — `sel.dispatchEvent`).
3. **Verify:** Spy called once per click with correct value.

#### Beat 242: ASSETS — card has thumb + meta children
1. **Do:** Inspect any `.asset-card`.
2. **See:** Two children: `.asset-thumb` (visual placeholder) +
   `.asset-meta` (with `.name` and `.sub` lines).
3. **Verify:** Both children exist on every card.

#### Beat 243: ASSETS — name + sub fields populated
1. **Do:** Inspect Schultz card.
2. **See:** name="Schultz Resid." sub="IFC · 2.4 MB" (per
   workbench.ts:94).
3. **Verify:** Card name + sub text matches.

#### Beat 244: GAP — Schultz file size LIES
1. **Do:** `ls -la web/public/samples/Schultz_Residence.ifc` (or any
   equivalent).
2. **See:** Real file size is **22.9 MB** per docs/qa/full-smoke-screenplay.md
   §25.0 ground truth. Asset card claims "IFC · 2.4 MB" — off by ~10×.
3. **Verify:** Compare card text vs `fs.statSync` size.
4. **Gap (file):** workbench.ts:94 SAMPLE_ASSETS schultz `sub` field is
   stale/wrong. Either originally referenced a smaller subset or never
   updated when #155 landed the real file. Fix to "IFC · 22.9 MB" with
   a CI guard that diffs claimed-size vs actual-size at build time.

#### Beat 245: ASSETS — search input filters cards (verify in build)
1. **Do:** Type "schultz" in `.assets-search input`.
2. **See:** Either (a) only Schultz card visible (filter wired), or
   (b) all 8 cards still visible (filter inert).
3. **Verify (a):** 7 cards have `display:none` or are removed from DOM.
   **Verify (b):** All 8 cards still visible — search is decorative.
4. **Gap (file if b):** "ASSETS search input is inert; no `input` event
   listener wired to filter `.asset-grid` children."

#### Beat 246: ASSETS — scroll on overflow
1. **Do:** With 8 cards rendered, narrow the sidebar viewport so cards
   stack vertically and exceed the pane height.
2. **See:** ASSETS pane scrolls vertically. Last card (Triangle STL)
   reachable via scroll.
3. **Verify:** `.tab-body.assets` `scrollHeight > clientHeight`. All 8
   cards still hit-testable after scrolling.

#### Beat 247: ASSETS — drop external IFC/GLB/OBJ/STL on viewport
1. **Do:** Drag-drop an external IFC file (e.g. another Schultz copy
   or `web/public/samples/wall-with-opening.ifc` from disk) onto the
   viewport canvas.
2. **See:** Loader picks up the file; scene replaces; SCENE tab
   updates. ASSETS card selection clears (no card matches dropped
   file).
3. **Verify:** Viewport reads the file via `loader.ts` import path.
   `getCreateSequence()` repopulates.
4. **Cross-ref:** §18 covers every export format (and #149 multi-format
   import is closed). This beat is the import smoke.

### Beats 248-253: Selection filters panel (6 beats — at sidebar bottom)

#### Beat 248: Filters panel always-visible (Issue 5 fix)
1. **Do:** Switch between SCENE / INSPECT / ASSETS tabs.
2. **See:** `.selection-filters` panel stays visible at sidebar bottom
   on every tab switch (per workbench.ts:286-290 — appended once,
   independent of tab body).
3. **Verify:** `.selection-filters` parentNode is `host` (sidebar root),
   NOT `.sb-body`. After tab switch, panel still in DOM.

#### Beat 249: 8 filter checkboxes render with correct labels
1. **Do:** Inspect `.selection-filters` panel.
2. **See:** 8 `.sf-row` children with checkboxes labeled: Points,
   Curves, Surfaces, Polysurfaces, Meshes, Annotations, Lights, Blocks
   (per scene-panel.ts:245-254). Layout: 2-column grid.
3. **Verify:** `[...querySelectorAll('input[data-filter]')].map(i =>
   i.dataset.filter)` returns exactly those 8 keys in order.

#### Beat 250: Default filter state (Lights off by default per Rhino)
1. **Do:** Page load. Inspect filter checkboxes.
2. **See:** Per `selection-state.ts` defaults — verify in build.
   Rhino convention: all on except Lights.
3. **Verify:** Each checkbox's `checked` matches `getFilters()[key]`.
   File gap if defaults differ from Rhino convention without rationale.

#### Beat 251: Filter toggle persists across reload
1. **Do:** Uncheck "Surfaces". Reload page.
2. **See:** Surfaces checkbox stays unchecked.
3. **Verify:** localStorage entry for selection-filters preserves the
   change. Default Rhino conventions are the new baseline overlaid by
   user prefs.
4. **Gap (file if missing):** "Selection filters do not persist across
   reload — user must re-toggle every session."

#### Beat 252: Footer hint visible
1. **Do:** Inspect filters panel footer.
2. **See:** Text "Ctrl+Shift+click to drill into sub-objects" (per
   scene-panel.ts:274).
3. **Verify:** Footer text matches. Cross-ref to §12 sub-object beats.

#### Beat 253: Sidebar Issue 3 — scrollbar gutter does not crop right edge
1. **Do:** Populate sidebar with full Schultz scene (overflowing SCENE
   list). Inspect right edge.
2. **See:** Scrollbar inside `.sb-body` does NOT eat sidebar's right
   border / inner padding (Issue 3 fix at `4f2526b`).
3. **Verify:** `.sb-body` style `overflow-y:auto; overflow-x:hidden`
   present (workbench.ts:254). Sidebar inner content not clipped at
   right edge by scrollbar gutter.

═══════════════════════════════════════════════════════════════════════════

## §8 — Snap dock (16 beats)

The snap dock lives at the bottom of the right sidebar (below the
selection-filters panel). Source: `web/src/workbench.ts` `buildSnapDock`
(lines 135-165) + `web/src/snap-state.ts` (full module, 26 lines).

**Surface inventory:**
- "SNAP / CONSTRAIN" section title + 4 buttons: SNAP, ORTHO, GRID, POLAR
  (defaults: SNAP / ORTHO / GRID on; POLAR off)
- "OBJECT SNAP" section title + 4 buttons: END, MID, CEN, PERP
  (defaults: END / MID / PERP on; CEN off)
- 3 readout rows: step "0.10 m" / angle "15°" / cplane "XY · z=0"

**Wiring depth (per source-of-truth grep):**
- `snap-state.ts` only exports `gridOn` + `step` state (2 of 8 buttons + 1
  of 3 readouts have real state behind them)
- Only **GRID** button has a state-binding click handler (`setGridOn`
  at workbench.ts:161)
- **Other 7 buttons** (SNAP, ORTHO, POLAR, END, MID, CEN, PERP) are
  visual-toggle-only — `.on` class flips but no consumer reads them
- step readout hardcoded "0.10 m" — does NOT reflect `setStep()`
- angle readout hardcoded "15°" — POLAR isn't wired anyway
- cplane readout hardcoded "XY · z=0" — no cplane-rotate UI exists
- `snapPoint()` at snap-state.ts:19-25 is the only consumer; called
  from `create-mode.ts` during click-to-place

**Cross-refs:**
- §6 beat 213 covered ribbon-vs-palette sync; snap dock has no parallel
  surface elsewhere — this is its only home.
- §11 (viewport interactions) tests snap behavior at click time; §8
  here tests the dock surface only.
- #194 Issue 9 fix at `ba52a12` shipped the snap-state.ts module +
  wired `snapPoint()` into `create-mode.ts`. Earlier the dock was
  pure decoration.

### Beats 254-269: Surface + behavior + gaps

#### Beat 254: Snap dock structure (3 sub-sections + 11 elements)
1. **Do:** Inspect `.snap-dock` at sidebar bottom.
2. **See:** Two "SNAP / CONSTRAIN" + "OBJECT SNAP" titles. Two `.snap-grid`
   children (4 buttons each). Three `.snap-row` readouts (step / angle /
   cplane).
3. **Verify:** `document.querySelectorAll('.snap-dock .snap-btn').length
   === 8`. `.snap-row` count === 3. Two `.snap-dock-title` headers.

#### Beat 255: SNAP/CONSTRAIN defaults — SNAP/ORTHO/GRID on, POLAR off
1. **Do:** Page load. Inspect first `.snap-grid`.
2. **See:** SNAP, ORTHO, GRID buttons have `.on` class. POLAR does not.
3. **Verify:** Per workbench.ts:139-144 — first grid hardcodes the
   `.on` class on SNAP/ORTHO/GRID. POLAR plain.

#### Beat 256: OBJECT SNAP defaults — END/MID/PERP on, CEN off
1. **Do:** Inspect second `.snap-grid`.
2. **See:** END, MID, PERP have `.on` class. CEN does not.
3. **Verify:** Per workbench.ts:146-151 — END/MID/PERP `.on`, CEN plain.

#### Beat 257: 3 readout rows render with hardcoded values
1. **Do:** Inspect `.snap-row` elements.
2. **See:** Three rows: step="0.10 m", angle="15°", cplane="XY · z=0"
   (per workbench.ts:152-154).
3. **Verify:** `document.querySelectorAll('.snap-row .v')[0].textContent
   === "0.10 m"`. `[1] === "15°"`. `[2] === "XY · z=0"`.

#### Beat 258: Click toggles .on class on every button (visual)
1. **Do:** For each of 8 buttons, click and inspect `.on`.
2. **See:** Every button toggles `.on` class on click (per
   workbench.ts:157-160 — `classList.toggle("on")` for ALL `.snap-btn`).
3. **Verify:** All 8 buttons respond to click visually.

#### Beat 259: GRID toggle wires to snap-state setGridOn (the only real binding)
1. **Do:** Click GRID button OFF (removes `.on`). Open DevTools console.
   Inspect `getGridOn()` import from `snap-state.ts`.
2. **See:** `getGridOn()` returns false. `_state.gridOn` flipped per
   `setGridOn(false)` at workbench.ts:161 (the handler ONLY fires on
   buttons whose textContent === "GRID").
3. **Verify:** `(await import('./snap-state.ts')).getGridOn() === false`
   in console (or equivalent eval path). Click GRID again → true.

#### Beat 260: GRID off → snapPoint rounds to 1mm only
1. **Do:** GRID off. In create-mode click pipeline (e.g. Wall tool),
   click viewport at world (0.12345, 0.67890).
2. **See:** First-click marker snaps to (0.123, 0.679) — rounds to
   1mm to remove float noise per `snap-state.ts:24`.
3. **Verify:** `getCreateSequence()` last entry contains coords
   matching .toFixed(3) precision, NOT `step`-multiples (since GRID
   off).

#### Beat 261: GRID on → snapPoint rounds to step (default 0.10m)
1. **Do:** GRID on. Click Wall. Click world (0.12345, 0.67890).
2. **See:** Marker snaps to (0.10, 0.70) — quantised to step=0.10m
   per `snap-state.ts:21-22`.
3. **Verify:** `getCreateSequence()` last entry has coords on 0.10m
   grid intersections.

#### Beat 262: SNAP master toggle — decorative (GAP)
1. **Do:** Click SNAP off. Run create-mode click on a non-grid point.
2. **See:** Marker still snaps if GRID is on. SNAP off has NO effect
   on snapPoint behavior.
3. **Verify:** Grep `snap-state.ts` and `create-mode.ts` for any
   reference to "SNAP" master state — none exists.
4. **Gap (file):** SNAP master toggle is decorative. Per Rhino
   convention SNAP off should disable ALL snap-related quantisation.
   File against `snap-state.ts` to add `getSnapEnabled()` + wire
   `snapPoint()` to short-circuit.

#### Beat 263: ORTHO toggle — decorative (GAP)
1. **Do:** Click ORTHO on. Click Line; click (0,0); move cursor to
   (5, 0.3) — slight Y drift.
2. **See:** Rubber-band line follows cursor freely. ORTHO does NOT
   constrain to axis-aligned.
3. **Verify:** No ORTHO logic in `create-mode.ts` rubber-band update.
4. **Gap (file):** ORTHO toggle decorative. Should constrain
   second-click point to nearest axis-aligned (X or Y) from first
   point. File for `create-mode.ts` integration.

#### Beat 264: POLAR toggle — decorative (GAP)
1. **Do:** Click POLAR on. Click Line; click (0,0); move cursor at
   ~22° from origin.
2. **See:** Cursor follows freely. POLAR does NOT snap to 15°
   increments (per the angle readout).
3. **Verify:** No POLAR logic in `create-mode.ts`.
4. **Gap (file):** POLAR toggle decorative. Should snap second-click
   angle to nearest multiple of `angle` readout (15° default). File.

#### Beat 265: OBJECT SNAP — END/MID/CEN/PERP all decorative (GAP)
1. **Do:** Click END off (or any of the 4). Click Line near a wall
   endpoint; cursor near vertex.
2. **See:** No magnetic snap-to-vertex. Cursor stays at raw position.
3. **Verify:** No object-snap raycast/proximity logic in
   `create-mode.ts` or `viewer.ts`.
4. **Gap (file):** All 4 object-snap toggles are decorative. Should
   raycast cursor proximity against scene-mesh vertices (END),
   midpoints (MID), centers (CEN), perpendicular projections (PERP).
   File as 4 sub-tasks under #166.

#### Beat 266: step readout hardcoded — does NOT reflect setStep()
1. **Do:** In DevTools console: `(await import('./snap-state.ts'))
   .setStep(0.50)`. Inspect step readout in snap dock.
2. **See:** Readout still says "0.10 m". Hardcoded HTML innerHTML at
   workbench.ts:152.
3. **Verify:** No subscription. setStep() updates internal state but
   not the readout.
4. **Gap (file):** step readout must subscribe to snap-state changes
   AND offer click-to-edit (numeric input). Without this, users
   can't change grid step without DSL.

#### Beat 267: angle + cplane readouts also hardcoded
1. **Do:** Inspect snap-state.ts module.
2. **See:** No `angle` or `cplane` exported state. Both readouts are
   pure cosmetic strings at workbench.ts:153-154.
3. **Verify:** Grep `snap-state.ts` for "angle" / "cplane" — zero
   matches.
4. **Gap (file):** Add angle (for POLAR) + cplane (for sketch-plane
   selection) state and reactive readouts.

#### Beat 268: GRID state does NOT persist across reload (GAP)
1. **Do:** GRID off. Reload page.
2. **See:** GRID button reverts to `.on` (default). `getGridOn()`
   returns true.
3. **Verify:** `snap-state.ts:9` — `_state` is module-scope; no
   localStorage hydrate/persist hooks. Default `gridOn: true` always
   wins after reload.
4. **Gap (file):** Add localStorage persistence for snap-state (gridOn,
   step, and future toggles when wired). User pref should survive
   sessions.

#### Beat 269: Snap dock keyboard nav (a11y)
1. **Do:** Tab from selection-filters panel into snap dock.
2. **See:** Each `.snap-btn` should receive focus. Enter/Space
   activates (toggles `.on`). Currently `.snap-btn` is a plain `<div>`
   per `el("div", "snap-btn ...")` — NOT a button element.
3. **Verify:** `document.querySelectorAll('.snap-dock .snap-btn')[0]
   .tagName === "DIV"`. Default `tabIndex` is -1 — NOT focusable.
4. **Gap (file):** Snap dock buttons are `<div>` not `<button>` — fails
   keyboard nav and screen-reader semantics. Should be `<button>` with
   appropriate ARIA (or `role="switch"` + `aria-checked`).

═══════════════════════════════════════════════════════════════════════════

## §9-§24 — TODO (subsequent ticks)

Sections 9 (dock tabs, 30 beats), 10 (Cmd+K full coverage, 28 beats),
11 (viewport interactions, 18 beats), 12 (selection 7-topology ×
filters × Ctrl+Shift, 36 beats), 13 (transforms, 18 beats), 15
(boolean + edge ops, 16 beats), 16 (layout mode full, 28 beats),
17 (research full, 14 beats), 18 (every export format, 26 beats),
19 (console DSL every keyword, 30 beats), 20 (Gemma 4 E2B agent —
full loop with KG state assertions per turn, 40 beats),
21 (skills, 16 beats), 22 (NURBS, 12 beats), 23 (persistence,
10 beats), 24 (edge cases, 16 beats).

Authoring cadence: ~18-50 beats per tick depending on section size.
~4-6 ticks remaining to full coverage.

═══════════════════════════════════════════════════════════════════════════

## §25 — Terminal reconstruction-parity gate (Schultz Residence)

This is the screenplay's TERMINAL section. Everything before this point
verifies surfaces exist and behave correctly in isolation. This section
is the only beat that proves **the web app is a CAD tool, not a chrome
mockup**: an architect (or Eli sitting in their seat) reconstructs our
highest-complexity reference asset from an empty scene using only the
web app's tools, and the result reaches **100% structural parity** with
the original IFC.

If §25 fails, the bridge is not judges-tier regardless of how many beats
in §1-§24 pass. This gate has been demanded multiple times prior; this
section is the artifact.

### §25.0 Reference asset

**`web/public/samples/Schultz_Residence.ifc`** — 22.9 MB, IFC2x3, Revit
2014 export, real architect-authored building. CC BY-ND 4.0 / Opening
Design.

Element inventory (from `grep -c "^#[0-9]*= IFCXXX("` on the file):

| IFC entity | Count | Note |
|---|---|---|
| IfcBuildingStorey | 11 | Basement → Roof |
| IfcWall | 4 | Generic walls (rare in Schultz) |
| IfcWallStandardCase | 101 | Layered walls — bulk of the structure |
| IfcDoor | 17 | |
| IfcWindow | 25 | |
| IfcSlab | 12 | Floor / roof slabs (one per storey approx) |
| IfcStair | 10 | |
| IfcStairFlight | 2 | |
| IfcColumn | 25 | |
| IfcBeam | 83 | |
| IfcRailing | 253 | Stairs + balconies — bulk count |
| IfcRoof | 3 | |
| IfcFurnishingElement | 112 | OUT OF SCOPE for parity (furniture, not architecture) |
| IfcBuildingElementProxy | 146 | OUT OF SCOPE (catch-all; review case-by-case) |
| IfcSpace | 3 | Rooms + zones |

**In-scope architectural total: 549 elements** (everything above except
furnishings + proxies; verified by `bun scripts/qa/diff-ifc.ts <ref> <ref>`
which reports `ref=549` after counting the 13 architectural classes
above). 100% parity = reconstructing all 549 with matching position,
dimensions, host relationships, and storey assignment.

**File length unit: FOOT** (scale 0.3048 → meters). Schultz_Residence.ifc
is a Revit 2014 export in imperial units — `IfcSIUnit` declares
`UnitType=LENGTHUNIT, Name=FOOT`. Eli reconstructing via the web app
must enter values in meters (the canonical kernel unit) and let the IFC
exporter convert on the way out, OR keep dimensions in feet to match
the file natively. `diff-ifc.ts` normalises both files to meters before
comparing, so a Schultz-in-feet ↔ recon-in-meters diff is unit-correct
as long as each file's own SIUnit declaration is set right.

NOTE: The "Schultz Residence demo" in `web/src/demo-prompts.ts` is a
14-element synthetic placeholder, NOT this asset. The terminal gate
loads the REAL `.ifc`, not the demo prompt. **File this as a separate
issue** — the demo and the parity gate share a name but reconstruct
different things; rename one to avoid confusion.

### §25.1 Verification protocol

Before authoring beats, fix HOW we verify parity. Three layers, all
required to PASS:

**Layer 1 — Structural diff (lossless) — `scripts/qa/diff-ifc.ts` SHIPS**

```
bun scripts/qa/diff-ifc.ts \
  --reference web/public/samples/Schultz_Residence.ifc \
  --reconstruction <eli-export>.ifc \
  --tolerance-mm 1
```

Three sub-layers verified by the script (auto-detects per-file length unit
via `IfcSIUnit`, normalises positions to meters before comparing):

- **1a — entity counts** by class: 13 architectural classes, must match
  exactly per §25.0 inventory.
- **1b — position pairing** within `--tolerance-mm` (default 1mm),
  greedy nearest-neighbour scoped to each class. Every reference element
  must pair with a reconstructed counterpart inside tolerance.
- **1c — relation cardinality** for the 7 IfcRel* classes
  (IfcRelAggregates, IfcRelVoidsElement, IfcRelFillsElement,
  IfcRelContainedInSpatialStructure, IfcRelConnectsElements,
  IfcRelSpaceBoundary, IfcRelAssignsToGroup) — counts must match.

Self-test (identity case, verified 2026-05-03 against the real Schultz
file, exit 0):

```
$ bun scripts/qa/diff-ifc.ts \
    web/public/samples/Schultz_Residence.ifc \
    web/public/samples/Schultz_Residence.ifc
…
PASS  diff-ifc: zero structural delta across all three layers
      (ref=549, recon=549 elements)
```

Rotation-tolerance (`--tolerance-deg`) and dimension-tolerance gates
are layer-1 follow-up enhancements (track separately; not blocking
v0 of the gate).

**Layer 2 — Voxel IoU (lossy-tolerant)**

```
bun scripts/qa/voxel-iou.ts \
  --reference web/public/samples/Schultz_Residence.ifc \
  --reconstruction <eli-export>.ifc \
  --voxel-size-mm 50
```

Pass condition: `volumeIntersection / volumeUnion ≥ 0.99` (geometric IoU
≥ 99%). Lossless layer 1 catches structural-schema gaps; layer 2 catches
geometric-fidelity gaps that the schema-diff would miss (e.g. correct
entity count but wrong wall thickness).

**Layer 3 — Visual side-by-side (judges' eye)**

Render reference + reconstruction in adjacent viewports (use bridge's
quad-split when #180 lands, or two browser windows side-by-side). Walk
all 11 storeys top-to-bottom in each, using View menu's storey selector.

Pass condition: zero visible deltas at 1:50 scale on any storey. No
missing rooms, no displaced walls, no missing openings.

**Authoring helpers (write before walking the section)**

The reconstruction needs Eli to know each element's parameters. Hand-
typing 549 elements from raw .ifc inspection is 8+ hours of error-prone
work. Three scripts must exist before walking §25:

1. `scripts/qa/extract-schultz-parameters.ts` — parses the reference IFC
   and dumps per-element parameter tables in markdown. Output:
   `docs/qa/schultz-reconstruction-tables/<storey>.md`. Each table has
   columns: `id | type | startX | startY | startZ | endX | endY | endZ
   | thickness | height | host_id | material`. Eli copies values into
   the web app as he reconstructs.
2. `scripts/qa/diff-ifc.ts` — Layer 1 structural diff. **Shipped 2026-05-03.**
   Self-test passes (identity case = exit 0 with `ref=549, recon=549`);
   contrast case (Schultz vs FZK-Haus) = exit 1 with 13 count deltas +
   529 unmatched + 6 relation deltas. Real Schultz length-unit
   correctly detected as FOOT.
3. `scripts/qa/voxel-iou.ts` — Layer 2 geometric IoU. **TODO** — pending
   tessellation pipeline (web-ifc → vertex/triangle arrays → voxelize
   on a uniform grid → set-intersection/union per-voxel).

These scripts are Leo's authoring lane (gate-shape definition). #195
tracks the remaining two (`extract-schultz-parameters.ts` +
`voxel-iou.ts`); they unblock §25 walkthrough.

### §25.2 Two-viewport setup

### Beat 901: Open Schultz reference in pane A

1. **Do:** Open quad-split (or two browser windows). In pane A, File →
   Open → web/public/samples/Schultz_Residence.ifc. Wait for parse +
   render (~30s for 22.9 MB; status bar progresses).
2. **See:** Pane A shows the full Schultz Residence — 11 storeys
   visible from south-west axonometric.
3. **Verify:** SCENE tree in pane A shows the full hierarchy: Project →
   Site → Building → 11 Storeys → elements per storey. Element count
   matches §25.0 table.

### Beat 902: Empty scene in pane B

1. **Do:** In pane B (or second browser window), File → New (empty
   scene). Set units to mm via Edit → Preferences. Set grid spacing to
   100mm.
2. **See:** Pane B is empty. Grid visible. Origin gnomon visible.
3. **Verify:** SCENE tree empty. KG snapshot empty.

### Beat 903: Side-by-side baseline screenshot

1. **Do:** Take a screenshot of the side-by-side state.
2. **See:** Reference (left) vs empty (right).
3. **Verify:** Save as `docs/qa/walkthrough-logs/<date>/schultz-step-000-baseline.png`.

### §25.3 Phase A — Site + Project setup

### Beat 904: Create IfcProject + IfcSite + IfcBuilding

1. **Do:** In pane B, use the SCENE tree's "+ Add" → choose Project.
   Name it identically to reference: read pane A's project name from
   INSPECT, type into pane B.
2. **See:** Project/Site/Building hierarchy created in pane B's SCENE
   tree.
3. **Verify:** All three appear with matching names. KG triples for
   `aggregatedBy(site, project)` and `aggregatedBy(building, site)`.

### Beat 905: Create 11 storeys

1. **Do:** From the parameter table at
   `docs/qa/schultz-reconstruction-tables/storeys.md`, create each
   IfcBuildingStorey at its reference elevation. Tool: Stair? No —
   storey is a level marker, NOT geometry. Use SCENE tree → + Add →
   IfcBuildingStorey or the Levels palette equivalent. (If the web app
   has no level-creation surface, file this as defect 11.)
2. **See:** 11 storeys appear in the SCENE tree, each with elevation
   marker visible in the viewport (a horizontal grid line at the
   storey's Z).
3. **Verify:** Pane B SCENE tree storey list matches pane A's. Each
   elevation matches reference (within 1mm tolerance per layer-1 spec).

### §25.4 Phase B — Storey-by-storey wall reconstruction

For each of the 11 storeys, walk the per-storey wall list. Beat
template (multiplied across all 105 walls):

### Beat 906-1010: Walls, storey-by-storey

For each wall in `docs/qa/schultz-reconstruction-tables/<storey>.md`:

1. **Do:** Click the Wall tool in ribbon. Set thickness from the
   parameter table. Set height from the parameter table. Set storey
   assignment via SCENE tree (drag wall under correct storey, or
   pre-select storey before drawing). Click first point at
   `(startX, startY)` — use console-tab DSL `wall (x1 y1) (x2 y2)
   height=H thickness=T` if click-to-place is too slow for batch
   placement. Verify snap-to-grid is OFF for this beat (positions are
   sub-grid millimeter precision).
2. **See:** Wall solid materializes between the two points at the
   correct storey elevation, with the correct thickness + height.
3. **Verify:** SCENE tree shows the new wall under the correct storey.
   Wall's INSPECT panel matches the reference parameters within 1mm.
   Layer 1 structural diff at end of section will verify this exactly.

(One beat = one wall. 105 wall beats. Author the per-storey tables FIRST
so each beat is a 30-second placement, not a parameter-hunting exercise.)

### §25.5 Phase C — Doors + windows

### Beat 1011-1052: Doors and windows

For each opening in `docs/qa/schultz-reconstruction-tables/openings.md`:

1. **Do:** Select the host wall (per the table's `host_id`). Click Door
   or Window tool. Click on the wall at the opening's offset along the
   wall's length. Set width + height per the table.
2. **See:** Opening cuts through the wall (IfcRelVoidsElement). Door
   or window panel fills the opening (IfcRelFillsElement).
3. **Verify:** KG `hosts(wall, door)` triple added. Wall geometry now
   shows the void. Layer 1 diff will verify both relations.

### §25.6 Phase D — Slabs + roof + spaces

### Beats 1053-1067: 12 slabs + 3 roofs + 3 spaces

(15 beats. Slab tool draws the 2D outline + extrudes by thickness; roof
tool similar but with pitch parameters; space is a non-physical zone
defined by bounding walls.)

### §25.7 Phase E — Stairs + columns + beams

### Beats 1068-1085: 10 stairs

Per stair: pick start/end levels + tread/riser parameters from the
parameter table. The stair tool generates the geometry; Eli verifies it
matches reference visually.

### Beats 1086-1110: 25 columns

Per column: 2D position + height + profile (rectangular / circular).

### Beats 1111-1193: 83 beams

Per beam: start/end (which columns it spans, or which walls it sits
on) + cross-section.

### §25.8 Phase F — Railings (253 instances)

Most railings are stair railings + balcony railings. The railing tool
should be: pick host (stair flight or balcony slab edge) → set rail
height + baluster pattern → generate.

### Beats 1194-1446: 253 railings

If the web app's railing tool produces aggregate geometry (one IfcRailing
per stair, not one per baluster), this count drops dramatically. The
table will resolve this. If true count is closer to 30 instances, that's
the working number.

### §25.9 Phase G — Final verification

### Beat 1447: Layer 3 visual side-by-side at every storey

1. **Do:** In both panes, View → Top, then storey selector to Storey 0
   (Basement). Compare panes. Repeat for each storey 0 through 10.
2. **See:** Identical floor plans at each storey.
3. **Verify:** Zero visible deltas at 1:50. If any storey has a missing
   wall, displaced opening, or wrong slab, file the specific element +
   beat number where it was placed.

### Beat 1448: Export reconstruction to IFC4

1. **Do:** In pane B, File → Export → IFC4 → save as
   `<eli>-schultz-reconstruction.ifc`.
2. **See:** Export completes. File size in the same order of magnitude
   as reference (10-30 MB; differences may be due to header metadata
   / GUID strings, not geometry).
3. **Verify:** File parses without errors via `bun scripts/qa/diff-ifc.ts`.

### Beat 1449: Layer 1 — structural diff

1. **Do:** Run `bun scripts/qa/diff-ifc.ts --reference Schultz_Residence.ifc
   --reconstruction <eli>-schultz-reconstruction.ifc --tolerance-mm 1`.
2. **See:** Script output (real shape, verified against the reference vs
   itself):
   ```
   --- Layer 1a: entity counts ---
     class                    ref   recon   delta
     ...zero in the delta column, all 13 classes...
   --- Layer 1b: position pairing (1mm tolerance) ---
     matched=549  unmatched=0
   --- Layer 1c: relation counts ---
     ...zero in the delta column, all 7 IfcRel* classes...
   PASS  diff-ifc: zero structural delta across all three layers
         (ref=549, recon=549 elements)
   ```
3. **Verify:** Exit code 0. Stdout ends with `PASS  diff-ifc: zero
   structural delta across all three layers`.

### Beat 1450: Layer 2 — voxel IoU

1. **Do:** Run `bun scripts/qa/voxel-iou.ts --reference Schultz_Residence.ifc
   --reconstruction <eli>-schultz-reconstruction.ifc --voxel-size-mm 50`.
2. **See:** Script output:
   ```
   voxel-iou: intersection=N1 mm³, union=N2 mm³, IoU=0.997 — PASS (≥0.99)
   ```
3. **Verify:** Exit code 0. IoU ≥ 0.99.

### Beat 1451: Final attestation

1. **Do:** Save the walkthrough log + both diff outputs + the side-by-
   side screenshots at every storey to
   `docs/qa/walkthrough-logs/<date>/schultz-parity-bundle.zip`.
2. **See:** Bundle contents: walkthrough.md (PASS/FAIL per beat),
   diff-ifc.txt (full diff dump), voxel-iou.txt (IoU stats), 11 ×
   storey-screenshots (top view, both panes side-by-side).
3. **Verify:** All three layers PASS. **§25 closed; the web app is a
   CAD tool.**

### §25.10 Failure modes — what to do when §25 fails

A failure here is more meaningful than any §1-§24 failure because it
exercises the integration of every surface. Failures cluster:

- **Tool gap** — the reference contains an element type the web app
  has no tool for (e.g. curved walls, complex roof slopes, draped
  curtain walls). File: "Tool missing for IfcXxx — required for §25
  parity". Until fixed, this section CANNOT pass.
- **Precision gap** — placement requires sub-grid precision (snap to
  millimeters) but the snap modes only support grid increments. File:
  "Snap dock missing fine-grained mode — required for parity at 1mm
  tolerance".
- **IFC export gap** — reconstruction looks right in viewport but the
  exported IFC fails layer 1 diff. File: "IFC4 exporter loses <Xxx>".
  This is the most common failure path; T9 (predicates + IFC sidecar)
  must be tight.
- **Performance gap** — the web app slows / crashes / drops frames at
  N=200 elements before the full 549 are placed. File: "Performance
  ceiling at <N> elements — Schultz parity blocked".

A first-attempt at §25 that fails on tool/precision/export gaps is
EXPECTED — those failures inform the issue queue. A second attempt
should pass if the queued issues close. A third attempt that still
fails means the architecture isn't right yet and we re-plan from the
constraint map.

### §25.11 Stretch goal — agent-driven reconstruction

After §25 closes manually (Eli walks all 1450 beats), repeat §25 with
the Gemma 4 E2B agent driving the dispatch table from a
natural-language prompt: "reconstruct the Schultz Residence from the
reference IFC by reading element parameters one by one and emitting
tool calls." The agent reads pane A's SCENE tree via the KG snapshot,
emits tool-call sequences, the web app executes them.

Pass condition: agent-built reconstruction reaches all three verification
layers ≥99% as well as Eli's manual reconstruction. This proves the
agent loop is real, not a demo.

This stretch goal is the hackathon submission video's closing shot.

═══════════════════════════════════════════════════════════════════════════

## Walkthrough log template

When Eli walks the screenplay, log results in this format. One row per
walked beat. PASS / FAIL only — narration goes in the Notes column.

```markdown
| Beat | Result | Notes |
|---|---|---|
| 1 | PASS | — |
| 2 | PASS | — |
| 3 | FAIL | statusbar bottom at y=720, viewport at y=900 → cropped 180px |
| ... | ... | ... |
```

Save the log at `docs/qa/walkthrough-logs/<YYYY-MM-DD-walker>.md`. After
each walk, file every FAIL as a new bug citing the beat number.

═══════════════════════════════════════════════════════════════════════════

## Cross-references

- `mail #6554` — initial 10 UI defects from Jun's 2026-05-03 walkthrough
- `mail #6555` — merge decision + revised starting order
- `web/src/spatial-dictionary.yaml` — canonical names per tool
- `web/src/dispatch.ts` — verb resolution + handler registry
- `web/src/scene-kg.ts` — KG snapshot + queryKG
- `B:/Downloads/gemma-architect-handoff.zip` — pixel-parity reference
