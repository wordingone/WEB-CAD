# Grasshopper → WEB-CAD Skills Tab: Absorption Design

**Target issue:** #334 (S14 — Grasshopper parametric layer)  
**Related:** #320 (P0 Rhino/Grasshopper parity umbrella)

## The Structural Parallel

| Grasshopper | WEB-CAD Skills Tab |
|---|---|
| Component (node) | `CanvasNode` (`kind: "skill" \| "script"`) |
| Wire | `CanvasEdge` |
| Group / Cluster | `CanvasGroup` + `CanvasCluster` |
| Number Slider | Param-input node with range |
| Panel (data viewer) | Output inspector |
| Definition (.gh file) | `CanvasCluster` (saved subgraph JSON) |
| Run / Solve | "Run" toolbar button → `solve_graph` |
| Canvas layout | `CanvasNode.{x, y}` pixel positions |

GH's node-definition model maps cleanly onto WEB-CAD's skill canvas. The delta:
- GH components have typed I/O (BRep, Curve, Number, etc.); WEB-CAD nodes have `SkillStep.{verb, args}`
- GH resolves data trees; WEB-CAD resolves spatial API dispatch sequences

## Absorption Layers

### Layer 1 — RhinoMCP-Backed Script Node (immediate)

Add a new `CanvasNode` kind: `"rhino-script"`. A rhino-script node contains a snippet of Python/C# that runs via `run_python` / `run_csharp`. The agent or user can place it on the WEB-CAD skill canvas, connect it to input params, and run it to produce geometry that gets imported back via `open_doc`.

Node schema extension (additive, non-breaking):
```ts
// In CanvasNode:
kind?: "skill" | "script" | "rhino-script"  // new: "rhino-script"
rhinoScript?: {
  language: "python" | "csharp";
  source: string;           // code; __rhino_doc__ available
  inputParams: string[];    // names bound from upstream node outputs
  outputPath?: string;      // .3dm path for round-trip import
}
```

Dispatch verb: `SdRhinoScript` (new, #334) — serializes to `run_python`/`run_csharp` via RhinoMCP.

### Layer 2 — GH Definition Node (phase 2, post-live-connection)

A `CanvasNode` kind `"grasshopper-def"` wraps a Grasshopper definition:
- Backed by `g1_apply_graph` or a `.gh` file path
- Input sliders map to node input ports
- Output geometry (BRep / Mesh) round-trips to WEB-CAD via .3dm + `open_doc`

```ts
kind?: "skill" | "script" | "rhino-script" | "grasshopper-def"
grasshopperDef?: {
  ghPath?: string;         // .gh file path, OR
  inlineGraph?: {          // or inline g1_apply_graph spec
    sliders: SliderSpec[];
    components: ComponentSpec[];
    wires: WireSpec[];
  };
  inputPorts: Array<{ name: string; min: number; max: number; default: number }>;
  outputMeshPath?: string; // temp path for exported mesh/brep
}
```

### Layer 3 — Skill Canvas → GH Authoring (future)

WEB-CAD's skill canvas CAN author GH definitions: map `CanvasNode` → `ComponentSpec`, `CanvasEdge` → wire, then call `g1_apply_graph`. This makes GH definitions a first-class output of the WEB-CAD Skills tab, not just an input.

## Skills Tab UI Changes for #334

1. **"+ Rhino Script" node** in the canvas palette (Layer 1, immediate once live connection is up)
2. **"+ GH Definition" node** in the palette (Layer 2)
3. **Run button behavior**: if a `rhino-script` node is in the graph, pre-flight checks `rhino` MCP server alive before running
4. **Output preview**: after `run_python` returns, auto-call `get_viewport_image` and show thumbnail in node chrome
5. **Import button** on rhino-script node output port: calls `open_doc` on the output .3dm, merges geometry into WEB-CAD scene

## Kai-Plan Targets (S1–S14) — RhinoMCP Bolster Map

RhinoMCP's `run_python` / `run_command` can produce authoritative Rhino geometry for each S-series target to use as:
- **Reference oracle**: compare WEB-CAD kernel output vs Rhino's for the same operation
- **Visual ground truth**: `get_viewport_image` captures Rhino's rendering for regression comparison
- **Geometry extraction**: `save_doc` → parse .3dm for exact NURBS knot vectors, control points, topology

| Kai issue | Target | RhinoMCP bolster |
|---|---|---|
| S1 / #321 | Curve creation | `run_command "_Line 0,0 10,0"` → verify curve endpoints |
| S2 / #322 | Curve operations (fillet, offset) | `run_python` → offset curve → compare vs kern output |
| S3 / #323 | Surface primitives | `run_command "_Plane"` → extract control points via `run_python` |
| S4 / #324 | Extrude / loft / sweep | `run_command "_Extrude"` → `save_doc` → parse BRep faces |
| S5 / #325 | Surface trim/split | `run_python` → compare trimmed surface vs kern |
| S6 / #326 | Brep booleans | `run_command "_BooleanUnion"` → compare result topology |
| S7 / #327 | Fillet edge / chamfer | `run_command "_FilletEdge"` → verify seam count (#357 parity) |
| S8 / #328 | Intersection matrix | `run_python CurveIntersection` → compare SSI |
| S9 / #329 | Mesh kernel | `run_command "_Mesh"` → compare mesh face count / normals |
| S10 / #330 | Transform & deform | `run_python rs.Orient` → compare transforms |
| S11 / #331 | Measurement | `run_python rs.SurfaceArea` → compare vs kern mass props |
| S12 / #332 | SubD | `run_command "_SubD"` → compare SubD→Brep conversion |
| S13 / #333 | File format interop | `open_doc` .3dm/.step/.obj → round-trip comparison |
| S14 / #334 | Grasshopper layer | `g1_apply_graph` → extract output geometry → ingest to WEB-CAD |

## Auto-Bootstrap Plan (Leo's req #4)

Goal: zero recurring user steps after the one-time Rhino 8.29 update.

Option A — Rhino startup command:
```
# In Rhino > Options > General > Command-line on start:
! _MCPStart 10500
```
Documents: one-time, survives restarts.

Option B — CU non-interfering launch:
Use `ni:launch` + `ni:wait-for-app` to launch Rhino, then `ni:type-uia` to send `MCPStart⏎` to the Rhino command bar. No cursor theft. Requires the app-lock layer (CU-2, now merged). **This is viable after 8.29 update.**

Recommended: Option B — the CU layer handles it programmatically. The user's one-time step is only the Rhino 8.29 update.
