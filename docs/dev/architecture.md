# Architecture Overview — WEB-CAD

Post-refactor structure (as of master 2026-05-25). Three LOC-reduction PRs: viewer decomposition (#38, #69), main.ts split (#36, #71).

## Entry point

```
web/src/main.ts   (~170 LOC)
```

Orchestrates boot only. Creates the Viewer, wires store subscriptions (levelStore, layerStore, drawingLayerStore), exposes window debug handles, calls:

- `registerAllHandlers(viewer, scenePanel)` — all Sd* command registrations
- `initDomEvents(viewer, scenePanel)` — DOM wiring, worker, file I/O, export pipeline
- `initShellChrome / buildWorkbench / buildModes / initCmdK / initExportDrawer` — shell boot

## Module map

```
web/src/
├── main.ts                   Orchestrator
├── register-handlers.ts      Sd* handler registration (registerAllHandlers)
├── dom-events.ts             DOM events, worker, file load/export, SdExport, auto-save
│
├── commands/
│   ├── dispatch.ts           registerHandler / dispatchSync / installDefaultHandlers
│   ├── command-session.ts    Stateful command session (picker bridge)
│   ├── dsl.ts                DSL lexer/compiler
│   └── spatial-api.yaml      SDK contract (the schema-first source of truth)
│
├── agent/
│   ├── agent-harness.ts      Tool-call envelope parsing, model dispatch
│   ├── goal-handlers.ts      Create/update/get_goal handlers
│   └── demo-prompts.ts       Bundled demo prompts + parameter slider config
│
├── viewer/
│   ├── viewer.ts             Public Viewer class (~800 LOC)
│   ├── viewer-camera.ts      Camera, view presets, orbit controls
│   ├── viewer-gizmo-input.ts Input handling, pointer events, snap
│   ├── viewer-gizmos.ts      Gumball, sub-object handles, transform controls
│   ├── viewer-rendering.ts   Render loop, grid, axes, render modes
│   ├── viewer-scene.ts       Scene add/remove/clear wrappers
│   ├── create-mode.ts        Palette tool state machine
│   ├── selection-state.ts    Multi-select, filter, getSelected
│   ├── snap-state.ts         Snap point, step grid
│   ├── op-tool.ts            Operation tool (point-pick, coord input)
│   ├── transforms.ts         TransformControls, gizmo preview
│   ├── render-modes.ts       Shaded / wireframe / X-ray
│   ├── cplane.ts             Construction plane types + resolveCPlane
│   ├── cplane-gizmo.ts       CPlane gizmo overlay
│   ├── section-handles.ts    Section box drag handles
│   ├── clip-plane-handles.ts Clipping plane entity handles
│   └── wall-height-handle.ts Wall height drag handle
│
├── handlers/                 Per-domain handler modules (registered in register-handlers.ts)
│   ├── transforms.ts         Move, rotate, scale, mirror, array
│   ├── nurbs.ts              NURBS surface/curve handlers
│   ├── structural.ts         Wall, slab, column, beam, stair, roof, …
│   ├── openings.ts           Door, window, opening
│   ├── sketch.ts             Line, arc, circle, polyline, rectangle, …
│   ├── datum.ts              Level, reference line, grid
│   ├── cplane.ts             CPlane set/reset handlers
│   ├── annotations.ts        Dimension, label
│   └── skills.ts             SdInvokeSkill
│
├── geometry/
│   ├── layers.ts             Layer store (color, visibility)
│   ├── drawing-layers.ts     2D drawing layer store
│   ├── levels.ts             Level store (elevation planes)
│   ├── grids.ts              Reference grid store
│   ├── clipping-planes.ts    Clipping plane entity store
│   └── drafting.ts           Apply/remove drafting style (dashed)
│
├── ifc/
│   ├── ifc.ts                IFC4 STEP-21 builder + web-ifc round-trip
│   └── ifc-nurbs.ts          NURBS → IFC surface conversion (stub)
│
├── io/
│   ├── loader.ts             Format detection, main-thread loaders, worker loaders
│   ├── exporters.ts          OBJ, GLB, GLTF, STL, 3DM, USDZ, SVG, DXF, PDF
│   ├── scene-store.ts        IndexedDB auto-save / restore
│   ├── export-drawer.ts      Export UI drawer
│   └── sample-files.ts       Bundled sample IFC file index
│
├── shell/
│   ├── shell.ts              Ribbon, palette ribbon, mode switcher chrome
│   ├── workbench.ts          Workbench layout, palette tool buttons
│   ├── modes.ts              Model / Layout / Research mode switching
│   └── layout.ts             2D layout sheets, viewports, panel manager
│
├── scene/
│   └── scene-panel.ts        Scene hierarchy panel
│
├── tools/
│   ├── index.ts              initCreateMode, emitClickWorld
│   ├── structural.ts         Wall/slab/column/beam/stair/roof builders
│   ├── sketch.ts             Rect/circle/line/polyline/ramp/railing builders
│   ├── openings.ts           Door/window/opening builders
│   ├── dimensions.ts         Dimension constants (door/window sizes)
│   ├── wall-corners.ts       Wall corner auto-join
│   └── join-groups.ts        Slab void cutting, element commit
│
├── nurbs/
│   ├── nurbs-curves.ts       NURBS curve tessellation, point-at, domain
│   ├── nurbs-surfaces.ts     NURBS surface tessellation
│   ├── nurbs-primitives.ts   Point3, Plane, Arc primitives
│   ├── nurbs-curve-algorithms.ts  Arc → NURBS
│   └── nurbs-surface-algorithms.ts  Revolve, sweep, loft surfaces
│
├── chat/
│   └── chat-panel.ts         Chat UI, runIteration (NL agent)
│
├── research/                 Research tab components
├── skills/                   Skill store, starter library
├── ui/                       Cmd-K palette, tooltips
└── app-state.ts              Global key/value state (unitSystem, currentView, …)
```

## Dispatch flow

```
User input (palette click / chat / CDP command)
  → dispatchSync("SdWall", { ... })
  → commands/dispatch.ts resolveAlias()
  → handler registered with registerHandler("SdWall", fn)
  → fn(args, viewer) → scene mutation
  → registerPostDispatch callback → auto-save trigger
```

Schema contract: `spatial-api.yaml` defines each verb's parameters (required/optional, types, units, synonyms). Handler and schema must agree — see `audit:dispatch` and the C2 failure class.

## Failure classes (C1–C15)

The recurring bug catalog lives at `.claude/rules/failure-classes.md` (local) and is synced to `docs/internal/failure-classes.md`. Key classes for contributors:

| Class | Summary |
|---|---|
| C1 | Tool-call envelope drift (agent-harness regex vs system prompt) |
| C2 | Schema validator vs handler signature mismatch |
| C8 | `@ts-ignore` masking a runtime failure |
| C10 | Branch swap in a serving worktree |
| C13 | Codex bug regression on rebase |

See `docs/internal/failure-classes.md` for the full catalog.

## Undo architecture

Every mutating handler uses one of:

- `viewer.addMesh(mesh, kind)` — pushes an undo action automatically
- `viewer.removeObject(obj)` — pushes undo automatically
- `pushReplaceAction(created, removed, label)` — for multi-mesh operations
- `pushCustomAction(redo, undo)` — escape hatch (rare)

Raw `scene.add()` / `scene.remove()` are audited by `audit:undo`; any new use requires `// audit-undo-ok` with justification.
