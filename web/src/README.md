# web/src — Developer Reference

WEB-CAD frontend. Vite + TypeScript, Three.js viewer, WebWorker IFC parser.
Co-location complete: each feature area owns both its `.ts` and `.css` files.

---

## Entry points

| File | Role |
|---|---|
| `main.ts` | Wires all domain modules. Owns dispatch-handler registration and DOM event routing. ~2600 lines. |
| `worker.ts` | Heavy parsing (IFC/STEP/replicad) off main thread. `WorkerIn` / `WorkerOut` message contracts. |
| `app-state.ts` | Singleton + pub/sub: `activeTool`, `activeTab`, `viewMode`, `layout`, `night`, `selectedId`. |
| `history.ts` | Undo/redo: `pushAction`, `pushTransformAction`, `pushBatchAction`, `captureTransform`. |
| `style.css` | CSS manifest — `@import` chain only, no inline rules. Order: tokens → shell → viewer → dock → responsive → skills → overlays → legacy. |
| `webgpu.d.ts` | Ambient WebGPU type declarations; patched subset used by the viewer render path. |
| `trademark-denylist.json` | Brand-name blocklist consulted by the agent before emitting text. Not imported by TS — data only. |

---

## Directory map

```
web/src/
├── agent/          model interaction, function-call extraction, skill dispatch
├── chat/           chat panel UI, NL dispatch routing, session summary
├── commands/       SDK dispatch table, DSL evaluator, command session runtime
│   └── spatial-api.yaml   ← SDK contract (schema-first; never bypass)
├── geometry/       pure geometric state — no DOM, no Three.js
├── ifc/            IFC4 document build, NURBS→IFC, type aliases
├── io/             loaders, exporters, sample index, Bonsai client, video recorder
├── nurbs/          B-spline kernel, curve/surface algorithms, primitives
├── research/       corpus loader, BM25 indexer, markdown utilities
├── scene/          scene knowledge graph + inspector panel
├── shell/          app chrome: menubar, ribbon, workbench, modes, layout (CSS co-located)
├── skills/         skill store, skill canvas, skill modal (CSS co-located)
├── ui/             command palette, icon registry, phone slider
├── viewer/         Three.js viewport: render loop, create-mode, snap, selection, gumball (CSS co-located)
└── styles/         global CSS: tokens, dock, responsive, overlays, legacy
```

---

## Domain notes

### agent/
`agent-harness.ts` parses `<tool_call>{...}</tool_call>` envelopes from Gemma 4 (failure class C1 —
regex must match this exact envelope; system prompt must instruct the model to use it).
`skills-loader.ts` handles dynamic skill loading; inline import type is `import("../agent/skills-loader").Skill[]`.
`ai-generate.ts` — free-form generation path. `image-to-ifc-agent.ts` — multimodal IFC inference.
`two-d-to-three-d.ts` — sketch-to-solid pipeline. `viewport-capture.ts` — screenshot helper for agent context.
`telemetry.ts` — fire-and-forget event logging. `demo-prompts.ts` — bundled starter prompts.
No model-facing strings outside this directory.

### chat/
`chat-panel.ts` owns the NL agent loop (`runIteration`, `runDesignLoop`).
`chat-dispatch-routing.ts` routes agent replies into dispatch.
`chat-dispatch-summary.ts` summarises what was dispatched per turn.
DOM target for NL input: `.chat-input` / `.chat-send-btn`.
DSL console target (`#console-input`) lives in `commands/`, not here — different handler, different model path (failure class C3).

### commands/
`spatial-api.yaml` is the single source of truth for the SDK. Every verb, every argument, required/optional flags all live here.
`dispatch.ts` — `registerHandler`, `dispatchSync`, `installDefaultHandlers`.
`command-session.ts` — tracks in-flight sessions; `clearCommandSession`, `getActiveCommandSession`.
`dsl-eval.ts` — compiles DSL strings to dispatch calls.
`dictionary.ts` — maps verb names to schema entries.
`dimension-guardrails.ts` — clamps/warns on physically implausible argument values.
**Schema-validator and handler signature must agree** (failure class C2). When changing a handler in `main.ts`
or a schema entry in `spatial-api.yaml`, grep the other file for the verb and confirm required/optional alignment.
Run `bun scripts/audit-dispatch-routing.ts` (covered by `bun run verify`).

### geometry/
Pure data modules — no DOM, no Three.js. Fully testable in Node.
`datums.ts` — datum planes. `drafting.ts` — snap-aware geometry helpers. `grids.ts` / `levels.ts` / `layers.ts` — reactive stores.
`ref-lines.ts` — construction line state. `predicates.ts` — geometric classification helpers.
`getLayerForCreator(creator)` and `layerStore` used by handlers in `main.ts` to auto-assign newly created objects.

### ifc/
`ifc-build.ts` — builds IFC4 document from scene graph. `ifc-nurbs.ts` — NURBS→IFC curve representation.
`ifc-types.ts` — TypeScript type aliases over `web-ifc` enums. `ifc.ts` — round-trip helpers and scene-element converters.
Heavy IFC parsing goes through `worker.ts`; these modules run on main thread for export-time document build.

### io/
`loader.ts` — format detection, `loadMainThreadFormat` (GLB/GLTF/OBJ/STL on main thread),
`WORKER_FORMATS` / `MAIN_THREAD_FORMATS` / `ALL_FORMATS` / `isSupported`.
`exporters.ts` — OBJ, GLTF-JSON, GLB, USDZ, SVG, DXF, PDF.
`sample-files.ts` — `SAMPLES` array (bundled fixture IFCs; synthetic, not architect-curated).
`bonsai-client.ts` — Bonsai BIM cloud adapter. `export-drawer.ts` — UI drawer wrapping exporters.
`video-recorder.ts` — frame capture for animation export.
Keep parsing/loading concerns isolated from UI.

### nurbs/
In-house B-spline library implementing Cox-de Boor evaluation for arc, ellipse, spline, and curve palette tools. Repo license is CC BY 4.0 (see `nurbs-kernel.LICENSE.md`).
`nurbs-kernel.ts` — math core (knot vectors, basis functions, de Boor).
`nurbs-curves.ts` / `nurbs-surfaces.ts` — higher-level ops (`tessellate`, `tessellateSurface`, `pointAt`, `domain`).
`nurbs-primitives.ts` — constructors: `Point3`, `Plane`, `Arc`.
`nurbs-curve-algorithms.ts` — offset, arc-to-NURBS (`nurbsCurveFromArc`).
`nurbs-surface-algorithms.ts` — revolve (`surfaceOfRevolution`), sweep, loft.
No DOM dependency; fully testable in Node.

### research/
`research-corpus-loader.ts` — imports `.md` files via Vite `?raw`.
**Data dir is `web/research-corpus/` at the `web/` level** — from `web/src/research/` the correct relative path
is `../../research-corpus/<file>.md?raw`, NOT `../research-corpus/`. Migration scripts that only track
`.ts`/`.js` extensions will miss `?raw` paths — update manually if this directory moves again.
`research-index.ts` — BM25-style scorer + `CorpusEntry` type.
`research-md.ts` — markdown → HTML utilities for the RESEARCH panel.

### scene/
`scene-kg.ts` — knowledge graph over active scene: spatial relationships, element metadata, adjacency.
`scene-panel.ts` — inspector UI reading the KG; exposes scene tree and element properties.
Depends on Three.js scene traversal for graph construction; no viewer interaction logic.

### shell/
App chrome. Each `.ts` has a co-located `.css`.
`shell.ts` — top menubar, ribbon tab wiring, statusbar cells.
`workbench.ts` — workbench layout switcher (`buildWorkbench`).
`modes.ts` — MODEL / LAYOUT / RESEARCH mode transitions (`buildModes`, `activateMode`).
`layout.ts` — viewport split engine (`LayoutMode`: `single`, `hsplit`, `vsplit`, `quad`).
Ribbon is fixed-height; tool groups inside it must not expand it (regression: #548/#549).

### skills/
`skill-store.ts` — indexes available skills by name/tag.
`skill-canvas.ts` — canvas overlay for skill-drawn graphics.
`skill-modal.ts` — modal dialog for structured skill input.
CSS in `skills.css` (co-located).

### ui/
`cmdk.ts` — command palette (⌘K / `initCmdK`). `icons.ts` — SVG icon registry.
`phone-slider.ts` — mobile-specific slider widget.
Keep these thin; route behavior through domain modules.

### viewer/
`viewer.ts` — Three.js scene, camera, render loop, `getActiveMeshData`.
`create-mode.ts` — click-to-place tool flows. Every builder must:
  1. Set `mesh.position.set(cx, cy, 0)` at centroid (C6).
  2. Set `userData.kind` to semantic verb suffix — `"rectangle"`, `"wall"`, etc., never `"brep"` (C5).
  3. Set `userData.controlPoints = [...]` for line/polyline/spline/curve (C4).
  4. Call `dispatchSync("setActiveTool", { toolId: "select" })` after completion (C7).
`snap-state.ts` — snapping engine (`snapPoint`, `setStep`, `getStep`).
`selection-state.ts` — multi-select state (`addToMultiSelected`, `clearMultiSelected`, `getFilters`).
`cplane.ts` — construction plane math (`resolveCPlane`, `WORLD_XY`, `WORLD_XZ`, `WORLD_YZ`).
`section-handles.ts` / `sub-object-handles.ts` — gumball sub-handle overlays.
`render-modes.ts` — render quality presets. `transforms.ts` — coordinate frame utilities.
CSS in `viewport.css` (co-located).

---

## Cross-cutting conventions

**Dispatch.** All scene mutations go through `dispatchSync(verb, args)`. Never mutate
`__viewer.scene` or `__app-state` directly from test/script code — those are inspection-only globals.
Schema in `commands/spatial-api.yaml` defines every verb. Handler signatures in `main.ts` must match
schema required/optional flags. `bun run verify` catches mismatches via `audit-dispatch-routing`.

**userData contract** (every created mesh):
```
userData.kind          — semantic verb suffix ("rectangle", "wall", "line" — never "brep" / "mesh")
userData.controlPoints — [{x,y,z}] for curve-like types; required for gumball sub-object handles
userData.creator       — string tag for scene KG classification
```

**Worker boundary.** Heavy parsing (IFC, STEP, replicad) goes through `worker.ts`.
`WorkerIn` / `WorkerOut` are the typed message contracts. Main thread must not import `replicad` directly.

**CSS entry.** `style.css` is the sole entry point for Vite CSS bundling. `@import` order:
`tokens.css` → `shell.css` → `menubar.css` → `modes.css` → `ribbon.css` → `workbench.css` →
`viewport.css` → `dock.css` → `responsive.css` → `skills.css` → `overlays.css` → `legacy.css`.
Never `@import` inside a `.ts` file; never add inline `<style>` tags.

**TypeScript suppressions.** `@ts-ignore` on an external API call is typically a runtime failure mask (C8).
Verify the suppressed code path in browser DevTools before committing.

**Audit gate stack** (run via `bun run verify`):
`tsc --noEmit` + `web:typecheck` + `audit:stubs` + `audit:parity` + `audit:dispatch` + `audit:vite-spawn` + `audit:brace` + `bun test web/`.

**Failure class index:** `.claude/rules/failure-classes.md` — C1 (envelope drift) through C15 (image dispatch drop).
