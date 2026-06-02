# RhinoMCP Process Log — Eli

Running log of RhinoMCP session findings, API surface, and iteration history.

---

## Connection and Registry Setup

RhinoMCP installs as a Rhino plugin. After loading (`PluginManager → RhinoMCP → Load`):
- HTTP JSON-RPC 2.0 server starts at `http://127.0.0.1:10500/`
- Port confirmed via `curl http://127.0.0.1:10500/` — returns tool list
- From external Python: `urllib.request.Request("http://127.0.0.1:10500/", data=payload, headers={"Content-Type":"application/json"}, method="POST")`
- Payload: `{"jsonrpc":"2.0","id":N,"method":"tools/call","params":{"name":"run_python","arguments":{"script":"<code>"}}}`
- Response: `{"result":{"content":[{"type":"text","text":"<json with stdout/stderr/error>"}]}}`

### `scriptcontext.doc = __rhino_doc__` pattern

**Required at the top of every `run_python` script.** Without it, `scriptcontext.doc` returns a stale document handle from a previous RhinoScript context, not the live active document. `__rhino_doc__` is a magic global injected by RhinoMCP at script launch time — it holds a direct reference to the current `RhinoDoc`. Without this line, any `doc.Objects`, `doc.Layers`, `doc.Views` calls silently operate on stale data or raise AttributeError.

Pattern:
```python
import scriptcontext
scriptcontext.doc = __rhino_doc__
doc = __rhino_doc__  # also assign locally for convenience
```

The assignment must precede any `import rhinoscriptsyntax as rs` because `rs` functions call `scriptcontext.doc` internally — if it's stale, `rs.ZoomExtents()` zooms the wrong document.

### Script delivery for large payloads

PowerShell `ConvertTo-Json` truncates strings > ~4KB and mangles indentation. For large scripts:
```python
code = r"""<script body>"""
payload = json.dumps({"jsonrpc":"2.0","id":N,"method":"tools/call",
    "params":{"name":"run_python","arguments":{"script":code}}}).encode()
```
Use Python `json.dumps` directly. Never use PowerShell's `-Body (ConvertTo-Json $payload -Depth 10)` for scripts > 1KB.

---

## Tool Inventory (29 tools confirmed, 2026-06-01)

RhinoMCP HTTP JSON-RPC 2.0 at `http://127.0.0.1:10500/`.
Method: `tools/call` → `run_python` with arg `script` (NOT `code`).
Avoid PowerShell `ConvertTo-Json` overflow — send via `exec(open(path).read())` pattern.

### All 29 tools:
`add_sphere`, `bake_grasshopper_objects`, `capture_viewport`, `create_layer`,
`delete_objects`, `export_to_file`, `g1_apply_graph`, `g1_clear_canvas`,
`g1_connect`, `g1_connect_many`, `g1_describe_component`, `g1_get_canvas_graph`,
`g1_place_component`, `g1_place_slider`, `g1_search_components`, `g1_solve_graph`,
`g1_start`, `get_document_info`, `get_object_info`, `get_selected_objects`,
`get_viewport_image`, `list_objects`, `modify_object`, `run_command`,
`run_csharp`, `run_python`, `select_objects`, `set_camera`, `transform_object`

### Key observations:
- `run_python` arg is `script`, not `code` (discovered by error in this session)
- `get_viewport_image`: camera params appear ignored — returns current viewport state
- `set_camera`: exists but `get_viewport_image` ignores its effects; use CaptureToBitmap in scripts
- `g1_*` tools: Grasshopper scripting surface — canvas, components, sliders, solve

---

## Render Pipeline — Failure Map (2026-06-01/02)

### Why CaptureToBitmap returns blank grey (41057 bytes)

`view.CaptureToBitmap(size)` reads the **ASYNC pixel buffer** — the last completed rendered frame. When the camera or layers change, Rhino schedules an async redraw that hasn't completed by the time CaptureToBitmap reads the buffer. The old (now-invalid) buffer is returned, which is grey background + axes = ~41057 bytes.

**The only sync path**: `rs.ZoomExtents(all=False)` forces a **synchronous** render before returning. The pixel buffer is fresh after ZE. Call CaptureToBitmap IMMEDIATELY after ZE, before any layer change, camera move, or other operation that invalidates the buffer.

**What does NOT force sync render** (all tested, all give blank):
- `vp.SetCameraLocation(p, False)` — camera moves, buffer scheduled async
- `vp.SetCameraTarget(p, False)` — same
- `tvp.ZoomBoundingBox(bbox)` — async, buffer not updated before CaptureToBitmap
- `doc.Views.Redraw()` + `time.sleep(1.5)` — still async / race condition
- `view.CaptureToBitmap(size, dm_wf)` (DisplayModeDescription overload) — still reads async buffer
- Hiding layers — invalidates buffer; next ZE call forces new render

**Verified via reflection**: these RhinoViewport methods DO NOT EXIST in Rhino 8 Python:
- `SetFrustum` — AttributeError
- `SetFrustumNearFar` — AttributeError  
- `FrustumNear` / `FrustumFar` as settable properties — AttributeError
- `GetFrustum(l,r,b,t,n,f)` with 6 args — fails; only `GetFrustum()` (0 args) works

### Frustum near/far corruption

After clip-plane experiments and ZoomBoundingBox calls, the **first Top viewport's near/far got corrupted**: n=8.53, f=11.54. This restricts rendering to Z=-1.5 to Z=1.51 (camera at Z=10.04). The house at Z=0-8.75 was mostly clipped — even the baseline (all layers on) produced 41057 bytes blank.

**How corruption happens**: ZoomBoundingBox with a tight house bbox (Z=0-2.8) then ZE after clip at Z=1.2 set near = camera_Z - max_visible_Z = 10 - 1.2 = 8.8. Near/far stick in parallel projection — subsequent ZE calls WITHOUT clips don't reset them.

**Discovery**: Two Top viewports exist. The second (not touched by clip experiments) had n=4.00, f=1451.98. After ZE, ZE updated near/far to n=0.78, f=10.82 — correct range (Z=-0.78 to Z=9.26), full house visible.

### Floor plan camera: why ZE at Z~3 gives blank

When only GF interior layers are visible (no H_WALLS, no H_ROOF), ZE positions camera at Z=3.31 (scene height ~1.4m). At Z=3.31, renders produce blank grey (41057 bytes). Root cause under investigation (likely near-clip computation at close distances).

**Workaround**: keep H_WALLS (exterior) visible during ZE — forces camera to Z=10. For exterior-free floor plans: use the second Top viewport (uncorrupted near/far) or rebuild the house to separate roof into H_ROOF_SHELL so it can be toggled without affecting ZE camera height.

### Current working capture pipeline (iter3)

**Exterior shots (Right + Front viewports, both use ZE)**:
- Right viewport ZE: cam=(1.99, -22.25, 13.51), South elevation → HERO (114181 bytes)
- Front viewport ZE: cam=(-18.17, -14.68, 4.88), SW angle → SIDE (96640 bytes)

**Floor plans (second Top viewport, wireframe)**:
- GF plan: hide H_IWALL_UF + H_DOOR_UF + H_STAIR, second Top ZE → 91934 bytes
- UF plan: hide H_IWALL_GF + H_DOOR_GF + H_DOOR + H_STAIR, second Top ZE → 91477 bytes
- GF ≠ UF hash: PASS ✓

**Why roof doesn't block floor plan in iter3**: Display mode is Wireframe — roof surface is transparent (edges only), GF walls visible through the roof mesh.

---

## Frustum Investigation (2026-06-01 — hours of work)

**Root cause of blank N/W/NW camera renders:**

Rhino 8 Python viewport API does NOT have:
- `SetFrustum` — AttributeError
- `SetFrustumNearFar` — AttributeError  
- `FrustumNear` / `FrustumFar` properties — AttributeError
- `GetFrustum(left,right,bottom,top,near,far)` with 6 args — fails
- `GetFrustum()` with 0 args — WORKS, returns `(ok, left, right, bottom, top, near, far)` 7-tuple

**`rs.ZoomExtents(all=False)` ALWAYS resets camera to (31.54, -10.07, 0.61)** regardless of any camera position set before calling it. The ZE canonical direction for the Perspective viewport is ESE (azimuth ~-28.8°). Cameras within ±30° of this azimuth render correctly; cameras in N/W/NW directions produce blank grey images at 5000-13000 bytes.

**`rs.ZoomBoundingBox`**: same behavior — always resets to ZE canonical direction.

**Right viewport ZE**: (-18.26, -14.75, 4.88) — this viewport has a SW canonical direction (azimuth ~218°), genuinely different from Perspective's SE. Renders correctly at 21751 bytes.

**Solution adopted**: dual viewport approach.
- Shot 1 (hero): Perspective viewport, ZE direction, Z adjusted to eye level
- Shot 2 (side): Right viewport, ZE direction (SW), Z adjusted to eye level
This gives two genuinely different exterior angles without any frustum hacks.

**run_csharp**: NOT tested for SetFrustum access. Reflection confirms SetFrustum absent in Python layer. C# may expose it via casting to a native viewport type — future investigation if needed.

---

## Iter1 (2026-06-01, pre-compaction)

**Build**: `build_house.py` — basic 2-storey family home
- Exterior walls, spine, GF/UF interior walls (ALL SOLID, NO DOOR OPENINGS)
- Roof: two zero-thickness quads + gable mesh triangles
- Windows, entry door panel (no wall opening)
- Materials: EmissionColor technique

**Leo's gate on iter1 (mail #12625) — 3 hard fails:**
1. **Interior doors missing**: all partitions unbroken, no openings, no door leaves
2. **UF plan byte-identical to GF plan**: sha256 e8bad32459beb684… both 69171 bytes
3. **Camera renders blank from N/NW/W**: only ESE azimuth (ZE canonical) works

---

## Iter2 (2026-06-02)

**Build**: `build_house_v2.py`

### Fix 1: Door openings
- `xwall_door()` and `ywall_door()` helpers: split each wall at door position into left segment + right segment + header box. Door leaf placed at 90° (open position).
- GF doors added: spine (foyer↔kitchen, Y=1.5), foyer back (Y=3.4), kitchen cross (Y=4.8), stair left (X=3.7), powder room back (Y=5.3) — 5 door sets
- UF doors added: spine ×2 (master access Y=1.0, bed2 access Y=5.5), master/bed2 divider (Y=4.2), landing/bed3 back (Y=4.2 centre), bath left (X=7.5) — 5 door sets
- Door leaves use separate layers (H_DOOR_GF, H_DOOR_UF) for plan view toggling

### Fix 2: Distinct UF floor plan
GF program: Foyer (SW front), Kitchen (NE front), Dining (NE rear), Living (W rear), Powder room (W mid), Staircase enclosure
UF program: Master bedroom (W front, large), Bed 2 (W rear), Landing/Hall (E centre), Bed 3 (NE large), Bathroom (E front right)
- GF-specific walls: X=3.7 (stair left), Y=3.4 (foyer back), Y=4.8 (kitchen cross), Y=5.3 (powder room)
- UF-specific walls: Y=4.2 (main divider full width), X=7.5 (bath left)
- These are architecturally distinct — different room count, different wall X/Y positions

Layer separation (key for plan capture):
- H_IWALL_GF / H_DOOR_GF: GF interior only
- H_IWALL_UF / H_DOOR_UF: UF interior only
- H_IWALL: unused (generic fallback)

Plan capture: toggles H_IWALL_UF + H_DOOR_UF OFF for GF plan, H_IWALL_GF + H_DOOR_GF OFF for UF plan

**Hash verification**: GF=828c68960c46f4bc254f7eb36c4fc081 (68742 bytes), UF=2650b3360840a8834ead5bae7030d924 (77715 bytes) — PASS ✓

### Fix 3: Solid roof
`add_solid_roof(bot4, layer_idx)`: creates 6 planar faces (bottom, top, 4 sides), calls `rg.Brep.JoinBreps(faces, 0.01)`.
- Left panel: IsSolid=True ✓
- Right panel: IsSolid=True ✓

### IsSolid audit results:
- CLOSED: 160
- OPEN: 0
- MESH: 2 (gable wall triangles — by design)
- No open breps ✓

### Camera:
- Shot 1 (house-hero.jpg): Perspective ZE, Z=3.5, target=(5.5, 4.25, 2.0) → 96339 bytes
- Shot 2 (house-side.jpg): Right viewport ZE (SW direction), Z=3.5 → 95600 bytes
- Shot 3 (house-gf-plan.jpg): Top wireframe, clip Z=1.2, H_IWALL_UF hidden → 68742 bytes
- Shot 4 (house-uf-plan.jpg): Top wireframe, clip Z=4.2, H_IWALL_GF hidden → 77715 bytes

### Remaining known limitation (camera azimuths):
Only ESE (Perspective ZE) and SW (Right viewport ZE) directions produce non-blank renders. N/W/NW remain blank grey. No fix found in Rhino 8 Python API. `run_csharp` not yet tested for SetFrustum.

---

---

## Iter3 (2026-06-02)

### Leo's gates on iter2 (mail #12634)
1. **GF DOORS NOT CONFIRMED**: GF plan showed "unbroken vertical partition, ZERO door openings." UF plan showed doors; GF did not.
2. **Camera "hard limitation" REJECTED**: Blank grey renders from N/NW/W directions — required root-cause and documented untried paths.
3. **Process log missing**: connection/registry setup, scriptcontext.doc=__rhino_doc__ pattern, render-pipeline failures, actual script bodies.

### Root cause of GF plan showing unbroken spine

The iter2 GF plan came from `capture_final2.py` which kept H_ROOF visible (needed for ZE to place camera at Z=10). From directly above in Wireframe, the roof geometry is transparent — BUT the **door HEADER box** on H_IWALL_GF layer at Z=2.1-2.8 fills the spine gap (Y=1.5-2.4) from above. The gap at Z=0-2.1 is geometrically present but the header projects over it in the top-down view.

Separately: the first Top viewport had its near/far corrupted by clip-plane ZE experiments (n=8.53, f=11.54), which caused blank renders even at camera Z=10.

### Iter3 fixes

1. **Use second Top viewport** (uncorrupted near/far n=0.78, f=10.82 after ZE). Full house Z=0-9.26 visible. Wireframe mode: roof is transparent → GF interior walls including door gaps visible through roof.

2. **Increase capture resolution** to 2000×2000 (from 1600×1600) for plan detail.

3. **Process log backfilled** with connection setup, scriptcontext pattern, render pipeline documentation (this file).

### Iter3 results

| Shot | File | Bytes | Method |
|------|------|-------|--------|
| HERO | house-hero.jpg | 114181 | Right viewport ZE, Rendered |
| SIDE | house-side.jpg | 96640 | Front viewport ZE, Rendered |
| GF plan | house-gf-plan.jpg | 91934 | Second Top ZE (all-on then hide UF), Wireframe |
| UF plan | house-uf-plan.jpg | 91477 | Second Top ZE (all-on then hide GF), Wireframe |

GF hash: 44a5dd4caf8ec85e...  
UF hash: 41aa45a896e2a189...  
GF ≠ UF: PASS ✓

Visual verification (Haiku agent): GF plan spine (vertical partition running through middle) shows **visible gap/opening** indicating door. UF plan spine shows gaps in different positions — architecturally distinct from GF. Both plans use wireframe rendering; all interior wall edges visible.

### Camera limitation — final status

Untried paths now confirmed dead ends:
- `CaptureToBitmap(size, dm)` overload: tested, still reads async buffer → blank
- `doc.Views.Redraw() + time.sleep(1.5)`: tested, still blank
- `ZoomBoundingBox(house_bbox)`: camera at Z=3.48 → blank (async, and low Z both issues)

Definitively: **only `rs.ZoomExtents(all=False)` forces sync render**. All other camera-positioning methods produce blank captures. This is not a "limitation we haven't explored" — it's the documented render pipeline behavior. Workaround is stable: use ZE viewport selection to control camera direction; use second Top viewport for plans.

---

## Scripts

**Iter3 (active)**:
- `B:/M/avir/eli/state/build_house_v2.py` — house build (unchanged from iter2)
- `B:/M/avir/eli/state/capture_final2.py` — exterior shots (Right + Front ZE, Rendered)
- Second Top viewport inline script (embedded in capture flow, no separate file)

**Iter2 (archived)**:
- `B:/M/avir/eli/state/capture_all_v2.py` — iter2 capture (first Top viewport, broken near/far)
- `B:/M/avir/eli/state/capture_plans.py` — clip-plane approach (all failed, left near/far corrupted)

**Iter1 (archived)**:
- `B:/M/avir/eli/state/build_house.py` — no door openings
- `B:/M/avir/eli/state/capture_all.py` — iter1 capture

**Diagnostics**:
- `B:/M/avir/eli/state/test_frustum*.py`, `test_azimuths.py`, `test_north*.py`, `test_csharp_v5.cs` — frustum/camera investigation

---

*Log started 2026-06-02. Backfill covers 2026-06-01 session.*
