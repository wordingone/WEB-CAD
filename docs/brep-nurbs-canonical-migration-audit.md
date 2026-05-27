# BRep/NURBS Canonical Migration Audit

Status: stage 0 audit artifact. This file is intentionally documentation-only.

Goal: turn WEB-CAD from a mesh-first application with mislabeled or partial BRep/NURBS scaffolding into a true CAD system where BRep/NURBS geometry is the canonical source of truth for creation, editing, save/load, import/export, viewport selection, clipping, reference geometry, and agent introspection, while preserving the exact user-facing intent and behavior of the existing application features that currently work through mesh representations.

## Non-Negotiable Constraints

- Do not replace working mesh-era behavior until equivalent BRep/NURBS-backed behavior is proven.
- Do not treat `userData.kind = "brep"` on a `THREE.Mesh` as proof of true BRep geometry.
- Keep display meshes as tessellation/cache objects, not source geometry.
- Preserve command names, palette IDs, visual behavior, shortcut behavior, current file/import/export affordances, snapping, clipping, selection, layout sheets, scene panel behavior, and agent-visible semantics unless there is an explicit product decision to change them.
- Every migration stage must be reversible as one commit or one PR.
- Final completion requires tests plus live deployed GitHub Pages verification in the shared Chromium browser after deployment/refresh.

## Current Runtime Shape

Entrypoint and boot:

- `web/src/main.ts` creates `Viewer`, `ScenePanel`, exposes debug globals, registers handlers, initializes DOM/file/export events, builds shell/workbench/modes/Cmd-K/export drawer, and wires layer/level/drawing-layer subscriptions.
- `web/src/register-handlers.ts` registers core commands and then delegates to handler modules.
- `web/src/dom-events.ts` owns worker setup, prompt/file load, sample load, drag/drop, export, IndexedDB autosave/restore, and several element inspectors.

Command and UI surfaces:

- Shell menubar: File/Edit/Help in `web/src/shell/shell.ts`.
- Modebar: MODEL, LAYOUT, RESEARCH in `web/src/shell/shell.ts` and `web/src/shell/modes.ts`.
- Workbench layout: palette, center viewport/dock, right sidebar in `web/src/shell/workbench.ts`.
- Main model palette: select/transform, sketch, solid/surface, BRep-labeled tools, architectural tools, component/opening tools, clipping, dimensions in `web/src/shell/workbench-panels.ts`.
- Layout palette: layout navigation, 2D drafting, text/leaders, dimensions, hatch/wipeout/block/image in `web/src/shell/workbench-panels.ts`.
- Cmd-K command palette: generate/model/view/file commands in `web/src/ui/cmdk.ts`.
- Dock tabs: CREATE, SKILLS, HISTORY in `web/src/shell/workbench-legacy-chat-input.ts`.
- Sidebar tabs: SCENE, INSPECT, LAYERS, LEVELS, BLOCKS, RESEARCH in `web/src/shell/workbench-sidebar.ts`.
- Export drawer: `web/src/io/export-drawer.ts`.

Geometry and interaction surfaces:

- Viewer public class and serialization: `web/src/viewer/viewer.ts`.
- Scene insertion/clearing/raycast helpers: `web/src/viewer/viewer-scene.ts`.
- Selection state and filters: `web/src/viewer/selection-state.ts`.
- Selection operations: `web/src/viewer/selection-ops.ts`.
- Gumball and transform input: `web/src/viewer/viewer-gizmo-input.ts`, `web/src/viewer/transforms.ts`.
- Operation tools for extrude/boolean/fillet/surface/BRep-labeled flows: `web/src/viewer/op-tool.ts`.
- Mesh extrusion helper: `web/src/viewer/op-tool-extrude-mesh.ts`.
- Snap state and snap vertices: `web/src/viewer/snap-state.ts`.
- CPlane: `web/src/viewer/cplane.ts`, `web/src/viewer/cplane-gizmo.ts`, `web/src/handlers/cplane.ts`.
- Section box and clipping planes: `web/src/register-handlers.ts`, `web/src/viewer/section-handles.ts`, `web/src/viewer/clip-plane-handles.ts`, `web/src/geometry/clipping-planes.ts`.
- Render modes and layout vector extraction: `web/src/viewer/render-modes.ts`, `web/src/viewer/viewer-rendering.ts`, `web/src/shell/layout.ts`, `web/src/shell/layout-export.ts`.

## Current Feature Map To Preserve

Modeling and architectural creation:

- Structural: wall, wall-polyline, wall-curve, wall-pick, slab, column, beam/member, stair, stair-polyline, stair-curve, roof, space, foundation, ceiling, curtain wall, plate, skylight, ramp, railing, reference line.
- Openings: door, window, opening, door/window variants, host-wall placement, void behavior.
- Sketch/reference geometry: point, line, rectangle, polyline, polygon, arc, circle, ellipse, spline, curve.
- Surface/solid operations: extrude, loft, sweep, revolve, plane, surface, boolean/union/difference/intersection, fillet.
- BRep-labeled operations: explode, join, rebuild, contour.
- Datum/reference systems: levels, grids, datums, drawing layers, building layers, CPlane, reference lines.
- Clipping: section box, horizontal clip plane, section-mode clip plane, linked layout sheet creation for clip planes.
- Annotation and measurement: aligned, angular, area, volume, label, transient measure.
- Transform and selection: select, window select, lasso select, boundary select, move, rotate, scale 3D/1D/2D, copy, array, align/distribute.
- View controls: top/bottom/front/back/left/right/iso/perspective, split modes, render modes, drafting style, zoom extents/selected/isolate.
- Layout: sheets, panels/viewports, plan/RCP/elevation/section presets, layout vector export, CAD block insertion, layout-only drafting tools.
- Agent-facing: command dispatch, command sessions, scene context, scene KG, goal handlers, prompt/console mode, skill invocation.
- File/export: prompt demos, sample files, local file imports, drag/drop, IFC/STEP/IGES/BREP/OBJ/STL/GLB/GLTF loading, IFC/OBJ/STL/GLB/GLTF/USDZ/3DM/SVG/DXF/DWG-fallback/PDF export, deprecated project save/open, IDB autosave/restore.

## Mesh-First Fault Lines

These are not necessarily bugs in current user behavior; they are migration hazards.

- `web/src/viewer/viewer.ts` serializes scene objects as transforms plus `BufferGeometry` arrays in `exportScene()` and restores them as `THREE.Mesh`/`THREE.Group` in `importScene()`.
- `web/src/io/loader.ts` converts IFC/STEP/IGES/BREP imports to Three.js object trees rather than canonical CAD source entities.
- `web/src/io/exporters.ts` exports OBJ/STL/GLB/GLTF/USDZ/3DM/SVG/DXF/PDF from live Three.js objects. The 3DM path writes Rhino mesh objects, not Rhino BRep/NURBS.
- `web/src/dom-events.ts` `sceneElementsForExport()` gathers world-space mesh vertices/indices for IFC export; `IfcSceneElement.nurbsSurface` exists but is not generally populated from canonical source geometry.
- `web/src/handlers/nurbs.ts` is named NURBS but creates `THREE.SphereGeometry`, `CylinderGeometry`, `ConeGeometry`, `ExtrudeGeometry`, or structural mesh boxes.
- `web/src/handlers/structural.ts` and `web/src/tools/structural.ts` mostly generate `THREE.Mesh` or `THREE.Group` output and then tag it as `kind = "brep"`.
- `web/src/register-handlers.ts` BRep ops (`SdExplode`, `SdJoin`, `SdRebuild`, `SdContour`) operate on `THREE.Mesh`/`BufferGeometry`, with `SdRebuild` returning a deferred note rather than rebuilding a NURBS surface.
- `web/src/viewer/op-tool.ts` BRep-labeled interactive tools are mostly mesh/group operations or display-line generation.
- `web/src/viewer/op-tool-extrude-mesh.ts` explicitly extrudes selected profiles into mesh results.
- Selection and snapping frequently depend on `Object3D`, `Mesh`, `BufferGeometry`, `userData.creator`, and `userData.kind`.

Reproducible scan:

- Run `bun run audit:brep-canonical` to print an informational count/sample report for mesh construction, BRep tags, `viewer.addMesh(..., "brep")`, NURBS `userData` sidecars, BufferGeometry serialization, mesh export paths, and existing BRep/NURBS footholds.
- The initial scan on this branch reported 277 Three.js mesh/group/buffer-geometry construction lines, 41 BRep runtime tags, 44 `viewer.addMesh(..., "brep")` calls, 8 NURBS sidecars on `userData`, 61 BufferGeometry serialization/deserialization matches, 29 mesh-export traversal matches, and 468 existing BRep/NURBS foothold matches.
- The scan is intentionally informational, not a pass/fail gate. Counts should fall or be reclassified as source-backed display caches over the migration.

## Existing BRep/NURBS Footholds

These are useful, but they are not yet a canonical document/runtime model.

- `web/src/nurbs/nurbs-brep.ts`: BRep type model and topology-oriented tests.
- `web/src/nurbs/nurbs-curves.ts`: NURBS/curve primitives.
- `web/src/nurbs/nurbs-surfaces.ts`: NURBS/surface primitives.
- `web/src/nurbs/nurbs-surface-algorithms.ts`: revolve, sweep, loft surface helpers.
- `web/src/nurbs/brep-extrude.ts`: extrusion kernel.
- `web/src/nurbs/brep-boolean.ts`: backend registry and partial/toy/planar boolean paths.
- `web/src/nurbs/ssi.ts`: surface/surface intersection support.
- `web/src/ifc/ifc-build.ts`: `IfcSceneElement.nurbsSurface` and `emitNurbsAdvancedBrep()` can emit IFC AdvancedBRep for a kernel NURBS surface.
- Some structural/sketch paths stash `userData.nurbsSurface`; this is metadata attached to display mesh objects, not a source-of-truth CAD object.

## Required Target Architecture

Introduce a canonical CAD document layer before changing individual tools.

Minimum target concepts:

- `CadDocument`: stores canonical objects, layers, levels, reference geometry, tolerances, app metadata, provenance, and command/history references.
- `CadObject`: stable object identity, semantic type, transform, layer/level IDs, source geometry reference, display cache reference.
- `BrepSource`: shells, faces, loops, edges, vertices, surface/curve references, trims, tolerances, and topology IDs.
- `NurbsSource`: curves/surfaces/control points/knots/weights/domains, with evaluators and tessellators.
- `DisplayMeshCache`: Three.js mesh/line objects derived from canonical source geometry, with back-pointers to source object/topology IDs.
- `WcadFormat`: native save/load format that persists source geometry and app state without flattening to viewport mesh buffers.

Likely new modules:

- `web/src/cad/cad-document.ts`
- `web/src/cad/cad-object.ts`
- `web/src/cad/display-cache.ts`
- `web/src/cad/wcad-format.ts`
- `web/src/viewer/brep-adapter.ts`
- `web/src/io/wcad-read.ts`
- `web/src/io/wcad-write.ts`

## Staged Migration Plan

Stage 0: audit and characterization map.

- Documentation only.
- Add no runtime behavior.
- Enumerate current UI/command/import/export/selection/clipping behavior.
- Identify tests that lock current behavior and gaps that need characterization tests.

Stage 1: characterization tests.

- Add tests for existing behavior before changing geometry internals.
- Lock wall/slab/column/roof/stair/door/window, sketch tools, clipping/section box, selection/gumball, save/open/autosave, layout export, import/export, and agent scene context.
- Include tests proving current mesh-labeled BRep behavior so future commits can intentionally replace it without accidental regressions.

Stage 2: canonical document spine.

- Add `CadDocument`/`CadObject`/`DisplayMeshCache` without changing existing handlers.
- Add adapter functions from legacy `THREE.Object3D` into display cache wrappers.
- Keep current scene graph as rendering output.

Stage 3: native save/load format.

- Add `.wcad.json` read/write for `CadDocument`.
- Keep `.gemarch` only as legacy/deprecated import if retained at all.
- Do not remove IDB autosave until the native document save/restore path covers the same user behavior.

Stage 4: first vertical slice.

- Convert one simple command, preferably `SdBox` or a minimal wall variant, to create canonical source geometry plus display tessellation.
- Preserve visual output, command result shape, selection, transform, snap, export fallback, undo, and scene panel behavior.
- Add tests comparing old and new behavior at the user-facing level.

Stage 5: selection, snapping, and clipping source IDs.

- Make selection hits return object/topology IDs backed by source geometry.
- Keep display mesh raycasting for picking, but map hits back to canonical source.
- Make clipping and sectioning operate from source when possible while preserving current visual clip behavior.

Stage 6: import/export source-first.

- STEP/BREP/3DM imports should retain source geometry where possible.
- IFC imports should preserve analytic/native source geometry where present and record mesh/faceted provenance where not.
- Exports should prefer canonical BRep/NURBS source, then fall back to tessellation only when the target format is mesh-only or source geometry is unavailable.

Stage 7: agent introspection.

- Scene context and scene KG should expose source geometry IDs, exact topology, coordinates, surfaces, trims, and semantic metadata.
- Display mesh statistics should be marked as tessellation/cache data, not source truth.

Stage 8: broad command migration.

- Convert structural, opening, sketch, surface, transform, boolean, rebuild/join/explode/contour, reference, and annotation families incrementally.
- Each family must preserve existing visible behavior and command contracts.

Stage 9: deployed verification.

- Merge/deploy only after tests pass.
- Refresh the live GitHub Pages tab in the shared Chromium browser.
- Verify representative workflows visually and programmatically through CDP.
- If a feature is broken, revert the specific commit/PR and retry with a narrower stage.

## Initial Characterization Test Matrix

Must-have before invasive runtime changes:

- `bun test web/test/dispatch.test.ts web/test/command-session.test.ts`
- `bun test web/test/selection.test.ts web/test/transforms.test.ts web/test/boolean-handlers.test.ts`
- `bun test web/test/wall-fzk-invariant.test.ts web/test/slab-fzk-invariant.test.ts web/test/roof-fzk-invariant.test.ts`
- `bun test web/test/door-window-stair-fzk-invariant.test.ts web/test/window-void-multilevel.test.ts web/test/door-void-alignment.test.ts`
- `bun test web/test/clipping-plane-auto-sheet.test.ts web/test/layout.test.ts web/test/layout-vector-export.test.ts`
- `bun test web/test/export-lineweights.test.ts web/test/export-fills-not-wireframe.test.ts web/test/export-no-titleblock.test.ts`
- `bun test web/test/scene-kg.test.ts web/test/agent-harness.test.ts web/test/agent-nurbs-fewshot.test.ts`
- `bun test web/test/nurbs-brep.test.ts web/test/nurbs-surfaces.test.ts web/test/nurbs-surface-algorithms.test.ts`
- `bun test web/test/brep-validity.test.ts web/test/brep-extrude.test.ts web/test/brep-boolean.test.ts web/test/brep-boolean-nurbs.test.ts`
- `bun test web/test/brep-explode.test.ts web/test/brep-join.test.ts web/test/brep-rebuild.test.ts web/test/brep-contour.test.ts`
- `bun test web/test/ifc-build.test.ts web/test/ifc-nurbs-emit.test.ts web/test/ifc-nurbs-parse.test.ts`

Additional tests to add before source-geometry migration:

- Project save/open round-trip characterization for current deprecated project path.
- Display mesh cache back-pointer tests once introduced.
- Native `.wcad.json` round-trip tests.
- Selection hit maps display mesh hits to source topology IDs.
- Clipping plane/section box preserves current visual semantics while recording source clipping intent.
- Export chooses source BRep/NURBS when present and mesh fallback only when necessary.
- Agent scene context distinguishes source geometry from tessellation.

## Revert Policy

- Stage 0 commit: documentation only; safe to revert without runtime effect.
- Stage 1 commits: tests only; failing tests should expose current assumptions, not change product behavior.
- Stage 2+ commits: one subsystem per commit/PR.
- Any commit that breaks a preserved user-facing behavior must be reverted or narrowed before continuing.
- No large cross-cutting replacement should merge without a passing targeted test set and a live browser check.

## Completion Evidence Required

The final goal is not complete until all of the following are true:

- BRep/NURBS source geometry is canonical for creation, editing, save/load, import/export, viewport selection, clipping/reference geometry, and agent introspection.
- Meshes are display/export tessellation caches, not source truth, except for explicitly mesh-native imports/exports.
- Existing user-facing behavior remains intact or has explicitly approved product changes.
- Native save/load preserves canonical source geometry and app state.
- Export paths prove source-first behavior for CAD formats.
- Agent/CDP introspection can report exact source topology/geometry, not only rendered vertices.
- Test suite and targeted migration gates pass.
- Live deployed GitHub Pages page in the shared Chromium browser is refreshed and verified.
