"""
Design Agent Loop — prompt → GH parametric house → rendered capture
Step 1: keyword-based parameter mapping (proves the loop works end-to-end)
"""
import scriptcontext; scriptcontext.doc = __rhino_doc__
import rhinoscriptsyntax as rs, Rhino, Rhino.Display as rdisp, Rhino.Geometry as rg
import System.Drawing as sd, System.Drawing.Imaging as sdi, System.IO as sio
import Grasshopper, System, re

doc = __rhino_doc__
gh_doc = Grasshopper.Instances.ActiveCanvas.Document

# --- GH component GUIDs from apply_graph result ---
SLIDER_GUIDS = {
    "width":  "7e18570e-6629-4585-bed2-c9dbdfc8e800",
    "depth":  "2c1fc4c5-8613-4e4a-85cb-1dcf758b1b75",
    "flr_h":  "e13bed93-2250-4ce9-9de0-f73a279c5022",
    "nfl":    "de338fe3-cfd6-4137-b8c1-ddd6c21bb53b",
    "roof_p": "22f8ac11-c095-4c03-8762-02556b6a59ab",
}
PY_GUID = "39cbe066-c316-492f-9e64-2dba30d19de6"

SLIDER_RANGES = {
    "width":  (6.0,  16.0),
    "depth":  (5.0,  12.0),
    "flr_h":  (2.2,  4.0),
    "nfl":    (1,    4),
    "roof_p": (0.1,  0.8),
}

DEFAULTS = {"width": 11.0, "depth": 8.5, "flr_h": 2.8, "nfl": 2, "roof_p": 0.45}


def parse_prompt(prompt):
    """Map natural-language description → slider parameter dict."""
    p = prompt.lower()
    params = dict(DEFAULTS)  # start from defaults

    # --- FOOTPRINT ---
    if re.search(r'\bwide\b|\bbroad\b|\blarge footprint\b', p):
        params["width"] = 15.0
        params["depth"] = 10.0
    elif re.search(r'\bnarrow\b', p):
        # narrow = tall-and-thin (small X, deeper Y relative to width)
        params["width"] = 7.0
        params["depth"] = 11.0
    elif re.search(r'\bcompact\b|\bsmall\b|\btiny\b', p):
        # compact = small overall footprint
        params["width"] = 8.0
        params["depth"] = 6.5
    elif re.search(r'\blong\b|\bdeep\b', p):
        params["depth"] = 11.0
    elif re.search(r'\bmedium\b|\bmid-?size\b', p):
        params["width"] = 12.0

    # --- FLOORS / STORIES ---
    m = re.search(r'(\d)[- ]?stor(?:y|ies|ey)', p)
    if m:
        params["nfl"] = max(1, min(4, int(m.group(1))))
    elif re.search(r'\bone.?stor\w*\b|\bsingle.?stor\w*\b|\bbungalow\b|\branch\b|\bcottage\b', p):
        params["nfl"] = 1
    elif re.search(r'\btwo.?stor\w*\b', p):
        params["nfl"] = 2
    elif re.search(r'\bthree.?stor\w*\b', p):
        params["nfl"] = 3
    elif re.search(r'\bfour.?stor\w*\b', p):
        params["nfl"] = 4

    # --- CEILING / FLOOR HEIGHT ---
    if re.search(r'\bhigh ceilings?\b|\btall ceilings?\b|\bloft\b|\bvaulted\b', p):
        params["flr_h"] = 3.5
    elif re.search(r'\bcontemporary\b|\bmodern\b|\bminimalist\b', p):
        params["flr_h"] = 3.2  # slightly taller modern proportions
    elif re.search(r'\bcozy\b|\bcottage\b|\blow ceiling\b', p):
        params["flr_h"] = 2.4

    # --- ROOF ---
    if re.search(r'\bflat roof\b|\bflat-?roof\b', p):
        params["roof_p"] = 0.10  # minimum slider (near-flat hip)
    elif re.search(r'\bshallow roof\b|\bshallow.?pitch\b|\bflat.?ish\b|\blow.?pitch\b', p):
        params["roof_p"] = 0.15
    elif re.search(r'\bmodern\b|\bcontemporary\b|\bminimalist\b', p) and 'steep' not in p:
        params["roof_p"] = 0.18
    elif re.search(r'\bsteep\b|\bpitched\b|\bgabled\b|\btraditional\b', p):
        params["roof_p"] = 0.65
    elif re.search(r'\bcottage\b|\bcountry\b|\bfarmhouse\b', p):
        params["roof_p"] = 0.55

    return params


def describe_params(params):
    """Generate a human-readable description of what was built."""
    nfl = int(round(params["nfl"]))
    total_h = params["flr_h"] * nfl
    ridge_span = min(params["width"], params["depth"])
    ridge_h = ridge_span * params["roof_p"]
    ridge_desc = "shallow" if params["roof_p"] < 0.25 else ("steep" if params["roof_p"] > 0.5 else "medium")
    return (
        f"{params['width']:.1f}m × {params['depth']:.1f}m footprint | "
        f"{nfl} floor{'s' if nfl>1 else ''} × {params['flr_h']:.1f}m = {total_h:.1f}m wall height | "
        f"{ridge_desc} hip roof (pitch {params['roof_p']:.2f}, ridge +{ridge_h:.2f}m)"
    )


def apply_params(params):
    """Push param values into GH sliders and re-solve."""
    for key, val in params.items():
        guid = SLIDER_GUIDS.get(key)
        if not guid:
            continue
        slider = gh_doc.FindObject(System.Guid(guid), True)
        if slider is None:
            print(f"  WARN: slider '{key}' not found ({guid})")
            continue
        lo, hi = SLIDER_RANGES[key]
        clamped = max(lo, min(hi, val))
        slider.Slider.Value = System.Convert.ToDecimal(clamped)
    gh_doc.NewSolution(False)
    # Poll for solve completion
    import time as _t
    py_comp = gh_doc.FindObject(System.Guid(PY_GUID), True)
    if py_comp:
        deadline = _t.time() + 6.0
        while _t.time() < deadline:
            phase = int(py_comp.Phase)
            if phase == 2 or phase == 3:
                break
            _t.sleep(0.05)
        lvl = py_comp.RuntimeMessageLevel
        if str(lvl) == "Error":
            msgs = list(py_comp.RuntimeMessages(Grasshopper.Kernel.GH_RuntimeMessageLevel.Error))
            return False, msgs
        count = py_comp.Params.Output[1].VolatileDataCount
        return True, count
    return True, 0


def shoot_rendered(path, label):
    """Bake GH geometry, capture rendered elevation, then delete baked objects."""
    import Rhino.DocObjects as rdo
    import System.Drawing as sd2

    # --- Poll GH solve completion (phase 2 or 3 = computed) ---
    import time as _time
    py_comp = gh_doc.FindObject(System.Guid(PY_GUID), True)
    if py_comp:
        deadline = _time.time() + 5.0
        while _time.time() < deadline:
            phase = int(py_comp.Phase)
            if phase == 2 or phase == 3:
                break
            _time.sleep(0.05)

    # --- Bake GH geometry into Rhino doc ---
    baked_ids = []
    if py_comp:
        out_param = py_comp.Params.Output[1]  # param 'a'
        wall_color = sd2.Color.FromArgb(220, 210, 195)
        roof_color = sd2.Color.FromArgb(180, 170, 160)
        # Materialize the .NET IEnumerable into a Python list before indexing
        all_goos = list(out_param.VolatileData.AllData(True))
        for goo in all_goos:
            if goo is None:
                continue
            brep = None
            try:
                brep = goo.Value
            except Exception:
                try:
                    brep = goo.get_Value()
                except Exception:
                    pass
            if not isinstance(brep, rg.Brep):
                continue
            attrs = doc.CreateDefaultAttributes()
            attrs.ColorSource = rdo.ObjectColorSource.ColorFromObject
            try:
                bb = brep.GetBoundingBox(True)
                attrs.ObjectColor = roof_color if bb.Min.Z > 0.5 else wall_color
            except Exception:
                attrs.ObjectColor = wall_color
            oid = doc.Objects.AddBrep(brep, attrs)
            if oid != System.Guid.Empty:
                baked_ids.append(oid)
    print("  [%s] baked %d objects" % (label, len(baked_ids)))

    # --- Configure view: 3/4 perspective for readable proportions ---
    dm_render = rdisp.DisplayModeDescription.FindByName("Rendered")
    vw = next((v for v in doc.Views if v.MainViewport.Name == "Perspective"), None)
    if vw is None:
        vw = list(doc.Views)[0]
    doc.Views.ActiveView = vw
    vp = vw.MainViewport
    vp.ChangeToPerspectiveProjection(True, 35.0)
    if dm_render:
        vp.DisplayMode = dm_render
    sun = doc.Lights.Sun
    sun.Enabled = True
    sun.ManualControlOn = True
    sun.Altitude = 40.0
    sun.Azimuth = 200.0
    sun.SkylightOn = True
    doc.GroundPlane.Enabled = True
    # Set 3/4 angle camera — front-right, slightly elevated
    # Estimate center from typical building bounds
    cx, cy, cz = 7.5, 5.0, 5.0
    try:
        bb_all = rg.BoundingBox.Empty
        for goo in (list(py_comp.Params.Output[1].VolatileData.AllData(True)) if py_comp else []):
            try:
                bb_all.Union(goo.Value.GetBoundingBox(True))
            except Exception:
                pass
        if bb_all.IsValid:
            cx = (bb_all.Min.X + bb_all.Max.X) / 2
            cy = (bb_all.Min.Y + bb_all.Max.Y) / 2
            cz = (bb_all.Min.Z + bb_all.Max.Z) / 2
    except Exception:
        pass
    offset = max(15.0, (bb_all.Max.X - bb_all.Min.X) if bb_all.IsValid else 15.0)
    vp.SetCameraLocation(rg.Point3d(cx + offset * 1.5, cy - offset * 1.2, cz + offset * 0.6), True)
    vp.SetCameraTarget(rg.Point3d(cx, cy, cz), True)

    # --- Capture ---
    bmp = vw.CaptureToBitmap(sd.Size(1800, 1200))
    nb = 0
    if bmp:
        bmp.Save(path, sdi.ImageFormat.Jpeg)
        bmp.Dispose()
        nb = sio.FileInfo(path).Length
        nb_label = "OK" if nb > 20000 else "BLANK"
        print("  [%s] %s: %d bytes %s" % (label, path.split("/")[-1], nb, nb_label))

    # --- Delete baked objects ---
    for oid in baked_ids:
        doc.Objects.Delete(oid, True)

    return nb


def run_design_agent(prompt, out_prefix):
    """Full design-agent loop: prompt → params → GH → capture."""
    print(f"\n{'='*60}")
    print(f"PROMPT: {prompt}")
    print('='*60)

    params = parse_prompt(prompt)
    print(f"PARAMS: {params}")

    ok, result = apply_params(params)
    if not ok:
        print(f"GH ERROR: {result}")
        return None
    print(f"GH SOLVED: {result} geometry items")
    print(f"DESCRIPTION: {describe_params(params)}")

    import time as _t
    _t.sleep(0.3)  # brief settle after NewSolution

    elev_path = f"B:/M/avir/eli/state/{out_prefix}-elev.jpg"
    nb = shoot_rendered(elev_path, out_prefix)

    return {"params": params, "desc": describe_params(params), "img": elev_path, "bytes": nb}


# ============================================================
# DEMO RUN — the NVIDIA-demo equivalent prompt
# ============================================================
TEST_PROMPTS = [
    ("wide 3-story contemporary house with shallow roof",   "agent-demo1"),
    ("compact single-story cottage with steep pitched roof", "agent-demo2"),
    ("narrow modern house with high ceilings and flat roof", "agent-demo3"),
]

results = []
for prompt, prefix in TEST_PROMPTS:
    r = run_design_agent(prompt, prefix)
    if r:
        results.append((prompt, r))

print("\n" + "="*60)
print("DESIGN AGENT RESULTS SUMMARY")
print("="*60)
for prompt, r in results:
    print(f"\nPrompt: '{prompt}'")
    print(f"  Built: {r['desc']}")
    print(f"  Image: {r['img'].split('/')[-1]} ({r['bytes']} bytes)")

print("\nDONE")
