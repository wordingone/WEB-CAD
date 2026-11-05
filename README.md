# WEB-CAD

*Part of the research and design work collected at https://wordingone.github.io/.*

> **At a glance (read this first)**
>
> **What it is.** An experimental CAD workbench that runs in the browser: draw walls, slabs, columns and openings, inspect IFC metadata, import and export IFC4 and other 3D formats, and optionally type a prompt that an in-browser Gemma 4 model turns into geometry. It is a research prototype, not a replacement for Rhino, Revit or ArchiCAD. Its output is not checked for structure, code compliance or buildability (see the disclaimer below).
>
> **Status.** Experimental prototype; last code change June 2026, with a documentation-and-hygiene pass on 2026-11-04. Not tested beyond the author's own use. Built for the Gemma 4 Good Hackathon (Kaggle and Google DeepMind) as a fork of [gemma-architect](https://github.com/wordingone/gemma-architect) ([`docs/ORIGIN.md`](docs/ORIGIN.md)); whether it was submitted is not confirmed in this repo (the checklist in [`submission/README.md`](submission/README.md) is still unchecked).
>
> **Who wrote it.** I designed and directed this work; most of the code was written by AI coding agents under my review.
>
> **What the AI feature really does.** Prompts that resemble one of about 60 bundled examples are answered from a pre-built cache by fuzzy matching, with no model call (about 100 ms, "demo-stable" in the repo's own words); only prompts that miss the cache go to the model. Some demos are fixed scripted sequences. Source: [`docs/ai-pipeline.md`](docs/ai-pipeline.md). Where the sections below say the model "generates geometry" or "works well", read them with this in mind; I found no evaluation in the repo that supports "works well".
>
> **Key measured results** (each is a file you can open):
> - *In-browser model speed:* median decode of 2.13 tokens/s over 25 samples (interquartile range 2.07 to 2.19, min 1.96, max 2.23), all from one short prompt ("What's currently in the scene?"). Measured 2026-05-25 against the earlier gemma-architect deployment, not this repo's page, with the stock `gemma-4-E4B-it-ONNX` model. Source: [`docs/measurements/baseline-tps-2026-05-25.json`](docs/measurements/baseline-tps-2026-05-25.json), `stats.median`. Expect the AI panel to be slow.
> - *Geometry kernel check:* the experimental C++/WASM boolean kernel was compared with replicad/OpenCASCADE on 7 box-pair cases (volumes, 0.1% tolerance): 7/7 pass; a robustness fuzz of 60 operations had no crash or NaN: 60/60. Scope is box/box booleans only; the NURBS part of that run was skipped and is **not verified**; fillet, chamfer, loft and non-box geometry are not covered. Source: "Runtime parity" in [`docs/kern-parity-report.md`](docs/kern-parity-report.md). The report links a run log (`kern-parity-oracle-run-2026-11-04.log`) that is not committed in the repo, so the numbers rest on the report text alone; the oracle script is `scripts/kern-parity-oracle.mjs`.
> - *IFC export:* the IFC4 file is hand-written STEP-21 and the check is that web-ifc can re-open it (tests in `web/test/ifc-round-trip.test.ts`, `web/test/ifc-loadability.test.ts`). It has **not** been tested in Revit or ArchiCAD in any log I found, so "opens in Revit/ArchiCAD" is untested here.
> - *Test suite:* the commit message of `c672cb9` (2026-11-04) reports a full `bun test web/` run of 2,654 tests with 0 failures. I did not re-run it; this is the commit's own statement. The CI workflow then passed on `master` at commit `278c5ae` on 2026-11-04 ([run 41818305917](https://github.com/wordingone/WEB-CAD/actions/runs/41818305917)).
>
> **Try it.** Live page: https://wordingone.github.io/WEB-CAD/ (needs a recent Chrome or Edge with WebGPU for the AI panel; the first visit downloads the model weights, several GB). On 2026-11-05 the live page loaded in headless Chromium with the drawing toolbar (Wall, Slab, Column) and the EXPORT button present and no console error other than a missing favicon; drawing, export and the AI panel were not exercised in that check. A path that does not need the AI model: pick the Wall tool, click twice in the viewport, click the wall to see its IFC class, storey and GUID in the sidebar, then use Export and choose IFC4 (steps from [Quick start](#quick-start-browser) below).
>
> **Run locally.** Requires [Bun](https://bun.sh/) 1.1+ and a WebGPU browser for the AI panel.
> ```bash
> bun install
> bun run web:dev        # http://localhost:5847
> bun test web/
> ```
> Full setup: [`SETUP.md`](SETUP.md).
>
> **Licence, credits, privacy.** Source-available, not open source: [`LICENSE`](LICENSE) allows use but forbids modification and redistribution. Third-party components and their licences: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Production builds may send anonymous error reports; opt out with `?notelemetry=1` ([`docs/user/privacy.md`](docs/user/privacy.md)). Where this box and the sections below disagree, this box is more conservative and takes precedence.
>
> **Sources for this summary:** the repo files linked above at `master` commit `c672cb9`; the CI run and live-page check were added on 2026-11-05.

---

A free browser-based experimental CAD workbench: draw walls/slabs/levels, try an AI CREATE agent, inspect BIM-like metadata, import/export common 3D formats, and experiment with IFC—no install required.

**Live:** https://wordingone.github.io/WEB-CAD/ · **License:** [Source-Available](LICENSE)

> **Disclaimer:** WEB-CAD is an experimental tool for exploration and learning. It is **not** a substitute for professional design software, licensed architects, licensed engineers, or any licensed design professional. Output generated by this application (geometry, IFC files, drawings, exports) is **not** verified for structural safety, building code compliance, or constructability. **Do not use output from this application as construction documents or as a basis for construction without independent review by appropriately licensed professionals.** AI-generated content may contain errors. Always consult a licensed architect or engineer for any real-world building project.

---

## What it is

WEB-CAD is an experimental workbench — not a production replacement for Rhino, Revit, or ArchiCAD. It runs in the browser with no account, API key or install. It is not offline: the page and, on first use of the AI panel, the Gemma 4 ONNX weights (`onnx-community/gemma-4-E4B-it-ONNX`, several GB) are downloaded, and production builds may send anonymous error reports ([`docs/user/privacy.md`](docs/user/privacy.md)). The goal is to make basic parametric architectural modelling accessible from any device with a modern browser.

---

## Features

| Feature | Notes |
|---|---|
| **Draw** walls, slabs, columns, stairs, roofs, openings | DSL console or AI agent |
| **AI CREATE agent** | Type a prompt; it is answered from a ~60-row cache when it matches a bundled example, otherwise by the in-browser Gemma 4 model ([`docs/ai-pipeline.md`](docs/ai-pipeline.md)) |
| **Levels / storeys** | Named elevation planes; objects attach to levels |
| **NURBS geometry** | Revolve, sweep, loft — NURBS surfaces stored, IFC4 round-trip via `IfcBSplineSurfaceWithKnots` |
| **Boolean ops** | Union, difference, intersection on any two objects |
| **IFC import/export** | Load or save IFC4 files; round-trip via web-ifc; NURBS surfaces export as IFC4 B-spline entities |
| **3D format I/O** | Import: IFC, STEP, GLB/GLTF, OBJ, STL · Export: IFC4, GLB, GLTF, OBJ, STL, STEP, 3DM, USDZ, SVG, DXF, PDF |
| **BIM-like metadata** | Select any element; sidebar shows IFC class, storey, GUID, layer |
| **Scene panel** | Hierarchy, format info, element counts |
| **Cmd-K palette** | Search commands, demos, and tools |
| **Layout mode** | 2D drawing sheets with linked section/plan viewports |
| **Undo/redo** | Full history stack |
| **Session restore** | IndexedDB auto-save; scene survives a page refresh |

---

## Quick start (browser)

Open the live URL above. No account required.

1. **Draw** — pick a tool from the left palette (Wall, Slab, Column, …) and click in the viewport.
2. **AI agent** — open the chat panel, type a description ("add a gabled roof over the house"), press Enter. Prompts close to a bundled example come from the cache; others run on the in-browser model, which decoded at about 2 tokens/s in the one measurement described in the box above.
3. **Import** — drag any `.ifc`, `.glb`, `.step`, `.obj`, or `.stl` file onto the page.
4. **Export** — click **Export** in the toolbar and pick a format.

---

## MCP server (Claude Code)

The `webcad` MCP server lets Claude Code agents dispatch geometry verbs, inspect the scene, and capture viewport screenshots.

```bash
# Add to your .mcp.json:
{
  "mcpServers": {
    "webcad": {
      "type": "stdio",
      "command": "node",
      "args": ["tools/mcp/webcad-mcp.mjs"]
    }
  }
}
```

**Tools:** `dispatch` · `list_verbs` · `get_verb_schema` · `list_scene_objects` · `get_viewport_image` · `slot_create/list/close`

**Slash commands:** `/scene` (list scene objects) · `/snapshot` (capture viewport)

See [docs/webcad-agent.md](docs/webcad-agent.md) for behavior rules and [docs/sample-prompts.md](docs/sample-prompts.md) for example prompts.

---

## Quick start (dev)

```bash
git clone https://github.com/wordingone/WEB-CAD
cd WEB-CAD
bun install
bun run web:typecheck     # strict tsc, no emit
bun run web:dev           # http://localhost:5847 — hot reload
```

See [SETUP.md](SETUP.md) for the full environment guide and [CONTRIBUTING.md](CONTRIBUTING.md) for PR conventions.

---

## Supported formats

| Format | Import | Export |
|---|---|---|
| IFC4 | ✓ (web-ifc) | ✓ (hand-emitted STEP-21; tests check that web-ifc re-opens it; not tested in Revit or ArchiCAD) |
| STEP / IGES / BREP | ✓ (OpenCascade WASM) | ✓ (STEP, when geometry originated from OCCT) |
| GLB / GLTF | ✓ (three.js) | ✓ |
| OBJ | ✓ (three.js) | ✓ |
| STL | ✓ (three.js) | ✓ |
| 3DM (Rhino) | — | ✓ |
| USDZ | — | ✓ |
| SVG / DXF / PDF | — | ✓ (layout mode) |

---

## Known limitations

- **Experimental.** This is a research/prototyping tool. Geometry output is not structurally validated.
- **AI agent output is not evaluated.** No evaluation of the model's geometry was found in this repo. Prompts that match a bundled example are answered from a cache; other prompts depend on a stock, not fine-tuned, in-browser model and may fail or need refinement.
- **No collaboration.** Single-user, single-tab. No server-side persistence.
- **WebGPU required for AI.** Browsers without WebGPU fall back to CPU inference (slower). The geometry viewer works without WebGPU.
- **SharedArrayBuffer / multi-thread WASM** requires COOP+COEP headers. GitHub Pages serves single-thread; any COOP+COEP-capable host (Vercel, self-hosted nginx) gets multi-thread.
- **IFC schema coverage.** Import handles IFC2×3 and IFC4. Export targets IFC4; the tests check that the file re-opens via web-ifc's `IfcAPI.OpenModel`, which is a parse check, not a check in other BIM software.
- **English only.** The AI agent prompt corpus is English.

---

## Stack

- **AI:** Gemma 4 E4B-it (`onnx-community/gemma-4-E4B-it-ONNX`), in-browser via Transformers.js v4 + WebGPU; an experimental LiteRT backend is switched on with `?engine=litert` (`web/src/agent/agent-harness.ts`)
- **Spatial SDK:** `web/src/commands/spatial-api.yaml` — typed dispatch contract for all geometry verbs; handler modules under `web/src/handlers/`
- **NURBS kernel:** custom pure-JS NURBS curves + surfaces (`web/src/nurbs/`) — no WASM dep, fully testable in Bun
- **Parametric geometry:** [replicad](https://replicad.xyz/) 0.20 (LGPL-2.1) + OpenCascade WASM
- **IFC:** [web-ifc](https://github.com/ThatOpen/engine_web-ifc) 0.0.77 (MPL-2.0)
- **3D viewer:** three.js 0.162 (MIT) + OrbitControls
- **Build:** Vite 8 + TypeScript 5.3

---

## Directory layout

```
web/                    Browser app (Vite + TypeScript)
  src/
    main.ts             Orchestrator (~170 LOC)
    dom-events.ts       DOM wiring, worker, file I/O, export pipeline
    register-handlers.ts  Handler registration (all Sd* verbs)
    commands/           Dispatch, DSL, spatial-api.yaml SDK contract
    agent/              AI agent harness, goal system
    viewer/             3D viewport, tools, gizmos, selection
    handlers/           Per-domain handler modules (transforms, nurbs, structural, …)
    geometry/           Layers, levels, grids, clipping planes, drafting
    ifc/                IFC build + round-trip
    io/                 Loaders, exporters, scene store
    shell/              Workbench layout, palette, modes
    scene/              Scene panel
    tools/              Create-mode tools (wall, slab, roof, openings, sketch)
    nurbs/              NURBS kernel
scripts/                Bun scripts (audit, setup, CI helpers)
docs/
  user/                 End-user guides
  dev/                  Developer reference
  internal/             Internal design notes
submission/             Hackathon submission artifacts (historical)
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues are welcome. Note that the current [`LICENSE`](LICENSE) forbids modification and redistribution, which does not fit with accepting outside pull requests; until that is settled, please open an issue before writing code.

---

## License

[Source-Available](LICENSE) — see [`LICENSE`](LICENSE) for full terms.  
Stack licenses: replicad LGPL-2.1, web-ifc MPL-2.0, three.js MIT.
