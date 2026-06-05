"""
qm_autoclose_loop.py — #18 Autonomous-close increment (QM, geometry target)

Loop: read per-component delta -> agent computes param adjustment -> re-solve -> re-capture -> re-gate.
Repeat until per-component PASS (ALL components < TOL_PCT simultaneously) or MAX_ITER.

Convergence rule (Leo mail #13056): PASS = all components below threshold AT ONCE.
Not aggregate delta decreasing. Whack-a-mole (one comp cut, another inflated) = NOT a PASS.

Honest non-convergence: "BUDGET_EXHAUSTED -- best delta per component: ..." (never a false PASS).

Session written to: exports/house_quinta_monroy/qm_autoclose_session.json (schema_v1 compliant).
Per-iteration reports: exports/house_quinta_monroy/qm_autoclose_iter{N}.json
"""
import json, base64, requests, os, time, datetime, uuid

MCP       = "http://127.0.0.1:10500/"
SPEC_PATH = "B:/M/WEB-CAD/rhino/exports/house_quinta_monroy/target_spec.json"
SIDE_SPEC = "B:/M/WEB-CAD/rhino/exports/house_quinta_monroy/side_spec.json"
OUT_DIR   = "B:/M/WEB-CAD/rhino/exports/house_quinta_monroy"

spec      = json.loads(open(SPEC_PATH).read())
side_spec = json.loads(open(SIDE_SPEC).read())

TARGETS = {
    "W":       spec["unit_width_mm"]             / 1000.0,   # 6.000
    "D":       spec["unit_depth_mm"]             / 1000.0,   # 6.048
    "H_WALL":  spec["H_WALL_mm"]                 / 1000.0,   # 7.280
    "PARAPET": spec["parapet_height_mm"]          / 1000.0,   # 0.180
    "H_TOTAL": spec["H_TOTAL_mm"]                / 1000.0,   # 7.460
    "F2_Z":    spec["floor_levels_exact_mm"][1]  / 1000.0,   # 2.340
    "F3_Z":    spec["floor_levels_exact_mm"][2]  / 1000.0,   # 4.680
}

# Initial params -- ~17% off target to ensure >= 2 non-trivial iterations with decreasing delta
INITIAL_PARAMS = {
    "W":       5.0,    # target 6.000  -16.7%
    "D":       5.0,    # target 6.048  -17.3%
    "H_WALL":  6.0,    # target 7.280  -17.6%
    "PARAPET": 0.25,   # target 0.180  +38.9%  (H_TOTAL = 6.25  -16.2%)
    "F2_Z":    1.9,    # target 2.340  -18.8%
    "F3_Z":    3.8,    # target 4.680  -18.8%
}

TOL_PCT  = 5.0
MAX_ITER = 6


def run_rhino(script_text, timeout=90):
    enc     = base64.b64encode(script_text.encode("utf-8")).decode()
    wrapper = "import base64 as _b64; exec(_b64.b64decode('{}').decode('utf-8'))".format(enc)
    r = requests.post(MCP, json={
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "run_python", "arguments": {"script": wrapper}},
    }, timeout=timeout)
    d    = r.json()
    text = d["result"]["content"][0]["text"]
    res  = json.loads(text)
    if res.get("error"):
        raise RuntimeError("run_python error: " + str(res["error"]))
    return res.get("stdout", "").strip()


# ---- Inner script body (no format-substitution; preamble injects all variables) ----
# dcheck is defined at module level (before any conditionals) so it is always in scope.
# gate4_infra_fail is set but never used as a halt -- all delta components are collected.
_INNER_BODY = r"""
import json, time, os
import Rhino, Rhino.Geometry as rg, Rhino.Display as rd
import System, System.Drawing as sd, System.IO

doc = __rhino_doc__
EDGE_THRESH = 220
BAND_DETECT_THRESH = 230

report = {"iteration": ITER, "params": {"W": W, "D": D, "H_WALL": H_WALL,
    "PARAPET": PARAPET, "H_TOTAL": H_TOTAL, "F2_Z": F2_Z, "F3_Z": F3_Z},
    "overall": "RUNNING"}


def px_brightness(bmp, c, r):
    if 0 <= c < bmp.Width and 0 <= r < bmp.Height:
        p = bmp.GetPixel(c, r)
        return (int(p.R) + int(p.G) + int(p.B)) / 3.0
    return 255.0


# dcheck defined before all conditionals -- always in scope for both GATE 4a and 4b
def dcheck(name, meas, cert, tol):
    if meas is None:
        return {"status": "NOT_DETECTED", "measured": None}
    dp = abs(meas - cert) / cert * 100.0
    return {"measured": round(meas, 4), "certified": cert,
            "delta_pct": round(dp, 3), "tol_pct": tol,
            "status": "PASS" if dp <= tol else "FAIL"}


def validate_capture(img_path):
    if not os.path.exists(img_path):
        return False, "no file"
    if os.path.getsize(img_path) < 200000:
        return False, "too small"
    try:
        bmp = sd.Bitmap(img_path)
        W_i, H_i = bmp.Width, bmp.Height
        mid_c = W_i // 2
        hit = None
        for r in range(H_i // 2):
            if px_brightness(bmp, mid_c, r) < EDGE_THRESH:
                hit = r
                break
        bmp.Dispose()
        if hit is None:
            return False, "no edges"
        return True, "ok"
    except Exception as e:
        return False, str(e)


def setup_vp(names, cam_loc, cam_dir, cam_up, bb):
    vw = None
    for v in doc.Views:
        if v.ActiveViewport.Name.lower() in names:
            vw = v
            break
    if not vw:
        vw = doc.Views.ActiveView
    doc.Views.ActiveView = vw
    vp = vw.ActiveViewport
    wire = rd.DisplayModeDescription.FindByName("Wireframe")
    if wire:
        vp.DisplayMode = wire
    vp.ChangeToParallelProjection(True)
    vp.SetCameraLocation(cam_loc, False)
    vp.SetCameraDirection(cam_dir, False)
    vp.CameraUp = cam_up
    vp.ZoomBoundingBox(bb)
    doc.Views.Redraw()
    for _ in range(100):
        Rhino.RhinoApp.Wait()
    time.sleep(3)
    for _ in range(100):
        Rhino.RhinoApp.Wait()
    # Read back the actual frustum after ZoomBoundingBox — gives exact scale independent of bb source
    gf = vp.GetFrustum()   # (ok, left, right, bottom, top, near, far)
    frust_w = gf[2] - gf[1]   # right - left in view-space meters
    return vw, frust_w


def capture_vp(path):
    cmd = '-_ViewCaptureToFile "{}" _Enter'.format(path)
    ok = Rhino.RhinoApp.RunScript(cmd, True)
    if ok and os.path.exists(path):
        return True, "ok"
    return False, "RunScript failed"


# --- BUILD scene from preamble params ---
doc.Objects.Clear()
doc.Views.Redraw()
for _ in range(20):
    Rhino.RhinoApp.Wait()
time.sleep(1)


def add_box(x0, y0, z0, x1, y1, z1):
    doc.Objects.AddBrep(rg.Box(rg.Plane.WorldXY,
        rg.Interval(x0, x1), rg.Interval(y0, y1), rg.Interval(z0, z1)).ToBrep())


def add_srf(cx, z0, w_s, h_s, y=-0.005):
    poly = rg.Polyline()
    for pt in [(cx - w_s/2, y, z0), (cx + w_s/2, y, z0),
               (cx + w_s/2, y, z0 + h_s), (cx - w_s/2, y, z0 + h_s),
               (cx - w_s/2, y, z0)]:
        poly.Add(rg.Point3d(*pt))
    breps = rg.Brep.CreatePlanarBreps([poly.ToNurbsCurve()], 0.001)
    if breps:
        for b in breps:
            doc.Objects.AddBrep(b)


def add_slab(z):
    poly = rg.Polyline()
    for pt in [(0, -0.10, z), (W, -0.10, z), (W, D, z), (0, D, z), (0, -0.10, z)]:
        poly.Add(rg.Point3d(*pt))
    breps = rg.Brep.CreatePlanarBreps([poly.ToNurbsCurve()], 0.001)
    if breps:
        for b in breps:
            doc.Objects.AddBrep(b)


add_box(0, 0, 0, W, D, H_WALL)
add_box(0, 0, H_WALL, W, D, H_TOTAL)
add_slab(F2_Z)
add_slab(F3_Z)
add_srf(1.5, 0, 0.90, 2.10)
add_srf(4.5, 0.60, 0.66, 1.40)
add_srf(3.0, F2_Z + 0.60, 0.66, 1.40)
add_srf(3.0, F3_Z + 0.60, 0.66, 1.40)
doc.Views.Redraw()
for _ in range(20):
    Rhino.RhinoApp.Wait()
time.sleep(1)

# --- GATE 0: units + object count ---
units = str(doc.ModelUnitSystem)
obj_count = len(list(doc.Objects))
if units != EXPECTED_UNITS:
    report["gate0"] = {"status": "FAIL", "reason": "units=" + units}
    report["overall"] = "FAIL"
    System.IO.File.WriteAllText(REPORT_PATH, json.dumps(report, indent=2))
    raise SystemExit(1)
if obj_count != EXPECTED_OBJ_COUNT:
    report["gate0"] = {"status": "FAIL", "reason": "obj_count=" + str(obj_count)}
    report["overall"] = "FAIL"
    System.IO.File.WriteAllText(REPORT_PATH, json.dumps(report, indent=2))
    raise SystemExit(1)
report["gate0"] = {"status": "PASS", "units": units, "obj_count": obj_count}
print("GATE 0: PASS  units={} objs={}".format(units, obj_count))

# --- GATE 2: degenerate geometry check ---
degenerate = []
for obj in doc.Objects:
    ob = obj.Geometry.GetBoundingBox(True)
    if not ob.IsValid:
        degenerate.append("inv")
        continue
    thin = sum(1 for d in [ob.Max.X - ob.Min.X, ob.Max.Y - ob.Min.Y, ob.Max.Z - ob.Min.Z]
               if d < 0.001)
    if thin >= 2:
        degenerate.append("degen")
if degenerate:
    report["gate2"] = {"status": "FAIL", "reason": str(len(degenerate)) + " degenerate"}
    report["overall"] = "FAIL"
    System.IO.File.WriteAllText(REPORT_PATH, json.dumps(report, indent=2))
    raise SystemExit(1)
report["gate2"] = {"status": "PASS"}
print("GATE 2: PASS")

# --- GATE 3: captures ---
bb_top = rg.BoundingBox(rg.Point3d(-0.5, -0.5, -1.0),
                         rg.Point3d(W + 0.5, D + 0.5, H_TOTAL + 1.0))
_, _ = setup_vp(["top"], rg.Point3d(W/2, D/2, 20.0),
                rg.Vector3d(0, 0, -1), rg.Vector3d(0, 1, 0), bb_top)
ok, r = capture_vp(PLAN_PATH)
if not ok:
    report["gate3"] = {"status": "FAIL", "reason": "plan: " + r}
    report["overall"] = "FAIL"
    System.IO.File.WriteAllText(REPORT_PATH, json.dumps(report, indent=2))
    raise SystemExit(1)
ok, r = validate_capture(PLAN_PATH)
if not ok:
    report["gate3"] = {"status": "FAIL", "reason": "plan_invalid: " + r}
    report["overall"] = "FAIL"
    System.IO.File.WriteAllText(REPORT_PATH, json.dumps(report, indent=2))
    raise SystemExit(1)

# Fixed bounding box — does NOT use W, H_TOTAL params; ZoomBoundingBox gives fixed scale.
# GetFrustum reads back actual scale after zoom → scale_cal never touches building dimensions.
_BB_FRONT = rg.BoundingBox(rg.Point3d(-0.5, -0.5, -1.0), rg.Point3d(8.5, 0.5, 10.0))
_, _frust_w_f = setup_vp(["front", "bottom"], rg.Point3d(W/2, -20.0, H_TOTAL/2),
                          rg.Vector3d(0, 1, 0), rg.Vector3d(0, 0, 1), _BB_FRONT)
ok, r = capture_vp(FRONT_PATH)
if not ok:
    report["gate3"] = {"status": "FAIL", "reason": "front: " + r}
    report["overall"] = "FAIL"
    System.IO.File.WriteAllText(REPORT_PATH, json.dumps(report, indent=2))
    raise SystemExit(1)
ok, r = validate_capture(FRONT_PATH)
if not ok:
    report["gate3"] = {"status": "FAIL", "reason": "front_invalid: " + r}
    report["overall"] = "FAIL"
    System.IO.File.WriteAllText(REPORT_PATH, json.dumps(report, indent=2))
    raise SystemExit(1)

# Fixed bounding box for side view — does NOT use D or H_TOTAL params
_BB_SIDE = rg.BoundingBox(rg.Point3d(-0.5, -0.5, -1.0), rg.Point3d(0.5, 8.5, 10.0))
_, _frust_w_s = setup_vp(["right"], rg.Point3d(W + 20.0, D/2, H_TOTAL/2),
                          rg.Vector3d(-1, 0, 0), rg.Vector3d(0, 0, 1), _BB_SIDE)
ok, r = capture_vp(SIDE_PATH)
if not ok:
    report["gate3"] = {"status": "FAIL", "reason": "side: " + r}
    report["overall"] = "FAIL"
    System.IO.File.WriteAllText(REPORT_PATH, json.dumps(report, indent=2))
    raise SystemExit(1)
ok, r = validate_capture(SIDE_PATH)
if not ok:
    report["gate3"] = {"status": "FAIL", "reason": "side_invalid: " + r}
    report["overall"] = "FAIL"
    System.IO.File.WriteAllText(REPORT_PATH, json.dumps(report, indent=2))
    raise SystemExit(1)

report["gate3"] = {"status": "PASS"}
print("GATE 3: PASS  3 captures written")

# --- GATE 4a: front delta (NON-HALTING -- collect all components regardless of failure) ---
front_delta = {}
gate4_infra_fail = None

bmp = sd.Bitmap(FRONT_PATH)
IMG_W, IMG_H = bmp.Width, bmp.Height
mid_row = IMG_H // 2

left_col = None
right_col = None
for c in range(0, IMG_W // 2):
    if px_brightness(bmp, c, mid_row) < EDGE_THRESH:
        left_col = c
        break
for c in range(IMG_W - 1, IMG_W // 2, -1):
    if px_brightness(bmp, c, mid_row) < EDGE_THRESH:
        right_col = c
        break
if left_col is None:
    for c in range(0, IMG_W):
        if px_brightness(bmp, c, mid_row) < EDGE_THRESH:
            left_col = c
            break
if right_col is None:
    for c in range(IMG_W - 1, -1, -1):
        if px_brightness(bmp, c, mid_row) < EDGE_THRESH:
            right_col = c
            break

scale_cal = None
top_row   = None
if left_col is None or right_col is None:
    gate4_infra_fail = "front W-edges not found"
    front_delta["W_m"]      = dcheck("W_m",      None, CERT_W,    TOL_PCT_DWG)
    front_delta["H_TOTAL_m"]= dcheck("H_TOTAL_m",None, CERT_HTOT, TOL_PCT_DWG)
    front_delta["F2_Z_m"]   = dcheck("F2_Z_m",   None, CERT_F2,   TOL_PCT_BAND)
    front_delta["F3_Z_m"]   = dcheck("F3_Z_m",   None, CERT_F3,   TOL_PCT_BAND)
else:
    W_px     = right_col - left_col
    scale_cal = IMG_W / _frust_w_f   # px/m — from fixed-bb frustum; never touches building dims
    mid_col  = (left_col + right_col) // 2
    top_row  = None
    bot_row  = None
    for r in range(0, IMG_H // 2):
        if px_brightness(bmp, mid_col, r) < EDGE_THRESH:
            top_row = r
            break
    for r in range(IMG_H - 1, IMG_H // 2, -1):
        if px_brightness(bmp, mid_col, r) < EDGE_THRESH:
            bot_row = r
            break
    if top_row is None or bot_row is None:
        gate4_infra_fail = "front H-edges not found"
        front_delta["W_m"]      = dcheck("W_m",      None, CERT_W,    TOL_PCT_DWG)
        front_delta["H_TOTAL_m"]= dcheck("H_TOTAL_m",None, CERT_HTOT, TOL_PCT_DWG)
        front_delta["F2_Z_m"]   = dcheck("F2_Z_m",   None, CERT_F2,   TOL_PCT_BAND)
        front_delta["F3_Z_m"]   = dcheck("F3_Z_m",   None, CERT_F3,   TOL_PCT_BAND)
    else:
        H_px         = bot_row - top_row
        H_TOTAL_meas = H_px / scale_cal
        W_meas       = W_px / scale_cal
        front_delta["W_m"]       = dcheck("W_m",       W_meas,       CERT_W,    TOL_PCT_DWG)
        front_delta["H_TOTAL_m"] = dcheck("H_TOTAL_m", H_TOTAL_meas, CERT_HTOT, TOL_PCT_DWG)
        BAND_WIN = max(int(scale_cal * 0.12) + 5, 10)
        def find_dark(col, pred, win):
            best_r = pred
            best_b = 255.0
            for r in range(max(0, pred - win), min(IMG_H, pred + win + 1)):
                b = px_brightness(bmp, col, r)
                if b < best_b:
                    best_b = b
                    best_r = r
            return best_r, best_b
        def z_to_row(z):
            return int(round(top_row + (H_TOTAL - z) * scale_cal))
        f2r, f2b = find_dark(mid_col, z_to_row(F2_Z), BAND_WIN)
        f3r, f3b = find_dark(mid_col, z_to_row(F3_Z), BAND_WIN)
        f2d = f2b < BAND_DETECT_THRESH
        f3d = f3b < BAND_DETECT_THRESH
        f2_meas = H_TOTAL - (f2r - top_row) / scale_cal if f2d else None
        f3_meas = H_TOTAL - (f3r - top_row) / scale_cal if f3d else None
        front_delta["F2_Z_m"] = dcheck("F2_Z_m", f2_meas, CERT_F2, TOL_PCT_BAND)
        front_delta["F3_Z_m"] = dcheck("F3_Z_m", f3_meas, CERT_F3, TOL_PCT_BAND)
        print("GATE 4a: W={:.4f} H={:.4f} F2_det={} F3_det={}".format(
            W_meas, H_TOTAL_meas, f2d, f3d))

bmp.Dispose()

# --- GATE 4b: side delta (NON-HALTING) ---
side_delta = {}
side_spec_data = json.loads(open(SIDE_SPEC_PATH).read())
D_cert    = side_spec_data["exact_dims"]["visible_width_mm"] / 1000.0
H_CERT_S  = side_spec_data["exact_dims"]["H_TOTAL_mm"] / 1000.0

bmp_s = sd.Bitmap(SIDE_PATH)
IMG_SW, IMG_SH = bmp_s.Width, bmp_s.Height
mid_row_s = IMG_SH // 2
lc_s = None
rc_s = None
for c in range(0, IMG_SW // 2):
    if px_brightness(bmp_s, c, mid_row_s) < EDGE_THRESH:
        lc_s = c
        break
for c in range(IMG_SW - 1, IMG_SW // 2, -1):
    if px_brightness(bmp_s, c, mid_row_s) < EDGE_THRESH:
        rc_s = c
        break
if lc_s is None:
    for c in range(0, IMG_SW):
        if px_brightness(bmp_s, c, mid_row_s) < EDGE_THRESH:
            lc_s = c
            break
if rc_s is None:
    for c in range(IMG_SW - 1, -1, -1):
        if px_brightness(bmp_s, c, mid_row_s) < EDGE_THRESH:
            rc_s = c
            break

if lc_s is None or rc_s is None:
    gate4_infra_fail = gate4_infra_fail or "side D-edges not found"
    side_delta["D_m"]        = dcheck("D_m",        None, D_cert,   TOL_PCT_DWG)
    side_delta["H_TOTAL_m_s"]= dcheck("H_TOTAL_m_s",None, H_CERT_S, TOL_PCT_DWG)
else:
    D_px_s  = rc_s - lc_s
    scale_s = IMG_SW / _frust_w_s   # px/m — from fixed-bb frustum; never touches D param
    mc_s    = (lc_s + rc_s) // 2
    tr_s    = None
    br_s    = None
    for r in range(0, IMG_SH // 2):
        if px_brightness(bmp_s, mc_s, r) < EDGE_THRESH:
            tr_s = r
            break
    for r in range(IMG_SH - 1, IMG_SH // 2, -1):
        if px_brightness(bmp_s, mc_s, r) < EDGE_THRESH:
            br_s = r
            break
    if tr_s is None or br_s is None:
        gate4_infra_fail = gate4_infra_fail or "side H-edges not found"
        side_delta["D_m"]        = dcheck("D_m",        None, D_cert,   TOL_PCT_DWG)
        side_delta["H_TOTAL_m_s"]= dcheck("H_TOTAL_m_s",None, H_CERT_S, TOL_PCT_DWG)
    else:
        H_side_meas = (br_s - tr_s) / scale_s
        D_meas      = D_px_s / scale_s
        side_delta["D_m"]         = dcheck("D_m",         D_meas,      D_cert,   TOL_PCT_DWG)
        side_delta["H_TOTAL_m_s"] = dcheck("H_TOTAL_m_s", H_side_meas, H_CERT_S, TOL_PCT_DWG)
        print("GATE 4b: D={:.4f} H_s={:.4f}".format(D_meas, H_side_meas))

bmp_s.Dispose()

# --- Per-component PASS: ALL must pass simultaneously (no aggregate) ---
all_deltas = {}
all_deltas.update(front_delta)
all_deltas.update(side_delta)
components_pass = {}
for comp in ["W_m", "H_TOTAL_m", "F2_Z_m", "F3_Z_m", "D_m", "H_TOTAL_m_s"]:
    d = all_deltas.get(comp, {})
    components_pass[comp] = (d.get("status") == "PASS")

all_pass = (not gate4_infra_fail) and all(components_pass.values())

report["gate4"] = {
    "status": "PASS" if all_pass else "FAIL",
    "infra_fail": gate4_infra_fail,
    "components_pass": components_pass,
    "front": front_delta,
    "side": side_delta,
}
report["overall"] = "PASS" if all_pass else "FAIL"
System.IO.File.WriteAllText(REPORT_PATH, json.dumps(report, indent=2))
print("GATE 4 overall: {}  comp_pass: {}".format(
    "PASS" if all_pass else "FAIL",
    {k: ("P" if v else "F") for k, v in components_pass.items()}))
print("Report: {}".format(REPORT_PATH))
"""


def build_inner_script(params, iteration):
    """Preamble injects all variable values; _INNER_BODY uses them by name."""
    H_TOTAL = params["H_WALL"] + params["PARAPET"]
    report_path = "{}/qm_autoclose_iter{}.json".format(OUT_DIR, iteration)
    plan_path   = "{}/qm_autoclose_iter{}_plan.jpg".format(OUT_DIR, iteration)
    front_path  = "{}/qm_autoclose_iter{}_front.jpg".format(OUT_DIR, iteration)
    side_path   = "{}/qm_autoclose_iter{}_side.jpg".format(OUT_DIR, iteration)

    preamble_lines = [
        "ITER = {}".format(iteration),
        "W = {}".format(params["W"]),
        "D = {}".format(params["D"]),
        "H_WALL = {}".format(params["H_WALL"]),
        "PARAPET = {}".format(params["PARAPET"]),
        "H_TOTAL = {}".format(round(H_TOTAL, 8)),
        "F2_Z = {}".format(params["F2_Z"]),
        "F3_Z = {}".format(params["F3_Z"]),
        'REPORT_PATH = "{}"'.format(report_path),
        'PLAN_PATH = "{}"'.format(plan_path),
        'FRONT_PATH = "{}"'.format(front_path),
        'SIDE_PATH = "{}"'.format(side_path),
        'SIDE_SPEC_PATH = "{}"'.format(SIDE_SPEC),
        "CERT_W = {}".format(TARGETS["W"]),
        "CERT_HTOT = {}".format(TARGETS["H_TOTAL"]),
        "CERT_F2 = {}".format(TARGETS["F2_Z"]),
        "CERT_F3 = {}".format(TARGETS["F3_Z"]),
        "TOL_PCT_DWG = 2.0",
        "TOL_PCT_BAND = 5.0",
        "EXPECTED_OBJ_COUNT = 8",
        'EXPECTED_UNITS = "Meters"',
    ]
    return "\n".join(preamble_lines) + "\n" + _INNER_BODY


def compute_revision(params, deltas, targets):
    """
    Proportional correction from per-component delta.
    new_param = old_param * (target / measured) for W, D, F2_Z, F3_Z.
    H_TOTAL error distributed proportionally between H_WALL and PARAPET.
    NOT_DETECTED: partial step (0.4 * gap toward target).
    """
    new_params = dict(params)

    def _fix_direct(key, delta_key, target_key=None):
        tgt = targets[target_key or key]
        d = deltas.get(delta_key, {})
        if d.get("measured") is not None and d.get("status") != "PASS":
            new_params[key] = params[key] * (tgt / d["measured"])
        elif d.get("status") == "NOT_DETECTED":
            new_params[key] = params[key] + 0.4 * (tgt - params[key])

    _fix_direct("W",    "W_m")
    _fix_direct("D",    "D_m")
    _fix_direct("F2_Z", "F2_Z_m")
    _fix_direct("F3_Z", "F3_Z_m")

    # H_TOTAL error -> distribute proportionally to H_WALL / PARAPET ratio
    ht_d = deltas.get("H_TOTAL_m", {})
    if ht_d.get("measured") is not None and ht_d.get("status") != "PASS":
        h_error = targets["H_TOTAL"] - ht_d["measured"]
        h_sum   = params["H_WALL"] + params["PARAPET"]
        new_params["H_WALL"]  = params["H_WALL"]  + h_error * (params["H_WALL"]  / h_sum)
        new_params["PARAPET"] = params["PARAPET"] + h_error * (params["PARAPET"] / h_sum)
    elif ht_d.get("status") == "NOT_DETECTED":
        new_params["H_WALL"]  = params["H_WALL"]  + 0.4 * (targets["H_WALL"]  - params["H_WALL"])
        new_params["PARAPET"] = params["PARAPET"] + 0.4 * (targets["PARAPET"] - params["PARAPET"])

    param_delta = {k: round(new_params[k] - params[k], 6) for k in params}
    return new_params, param_delta


def best_delta_summary(trajectory):
    comps = ["W_m", "H_TOTAL_m", "F2_Z_m", "F3_Z_m", "D_m", "H_TOTAL_m_s"]
    best = {}
    for c in comps:
        vals = [t.get("deltas", {}).get(c, {}).get("delta_pct")
                for t in trajectory
                if isinstance(t.get("deltas", {}).get(c), dict)
                and t["deltas"][c].get("delta_pct") is not None]
        best[c] = round(min(vals), 3) if vals else None
    return best


# =================================================================
# MAIN LOOP
# =================================================================
print("\n=== QM AUTONOMOUS-CLOSE LOOP ===")
print("Targets: {}".format({k: round(v, 4) for k, v in TARGETS.items()}))
print("Initial: {}".format(INITIAL_PARAMS))
print("TOL={}%  MAX_ITER={}".format(TOL_PCT, MAX_ITER))

session_id    = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%S") + "_" + str(uuid.uuid4())[:6]
session_start = datetime.datetime.utcnow().isoformat() + "Z"
trajectory    = []
events        = []
params        = dict(INITIAL_PARAMS)
seq           = 1
converged     = False

for iteration in range(1, MAX_ITER + 1):
    ts_iter = datetime.datetime.utcnow().isoformat() + "Z"
    print("\n--- ITERATION {}/{} ---".format(iteration, MAX_ITER))
    print("  params: {}".format({k: round(v, 4) for k, v in params.items()}))

    script = build_inner_script(params, iteration)

    events.append({
        "seq": seq, "ts": ts_iter,
        "intent": "build QM geometry (iter {}); capture plan/front/side; gate 4 non-halting delta-check".format(iteration),
        "tool": "run_python",
        "args": {"iteration": iteration, "params": {k: round(v, 5) for k, v in params.items()}},
    })
    seq += 1

    stdout = run_rhino(script, timeout=120)
    print(stdout)

    report_path = "{}/qm_autoclose_iter{}.json".format(OUT_DIR, iteration)
    if not os.path.exists(report_path):
        events[-1]["result_summary"] = "FAIL -- no report written (inner script exited before gate 4)"
        print("  ERROR: report not written")
        break

    report = json.loads(open(report_path).read())
    events[-1]["result_summary"] = "overall={}".format(report.get("overall"))

    gate4      = report.get("gate4", {})
    deltas     = {}
    deltas.update(gate4.get("front", {}))
    deltas.update(gate4.get("side", {}))

    components_pass = gate4.get("components_pass", {})
    all_pass        = report.get("overall") == "PASS"

    delta_summary = {
        k: ("{:.2f}%".format(v.get("delta_pct", 99))
            if isinstance(v, dict) and v.get("delta_pct") is not None
            else v.get("status", "?"))
        for k, v in deltas.items()
    }
    print("  deltas: {}".format(delta_summary))

    traj_entry = {
        "iteration": iteration,
        "params": {k: round(v, 5) for k, v in params.items()},
        "deltas": deltas,
        "components_pass": components_pass,
        "all_pass": all_pass,
    }
    trajectory.append(traj_entry)

    if all_pass:
        print("  ALL COMPONENTS PASS -- converged at iteration {}".format(iteration))
        converged = True
        break

    if iteration < MAX_ITER:
        new_params, param_delta = compute_revision(params, deltas, TARGETS)
        traj_entry["param_delta"]        = param_delta
        traj_entry["revision_formula"]   = (
            "proportional: new_p = old_p * (target / measured); "
            "H_TOTAL error split H_WALL:PARAPET by ratio"
        )
        traj_entry["revision_driven_by"] = [
            k for k, v in deltas.items()
            if isinstance(v, dict) and v.get("status") == "FAIL"
        ]
        print("  REVISION param_delta: {}".format({k: round(v, 4) for k, v in param_delta.items()}))

        events.append({
            "seq": seq, "ts": datetime.datetime.utcnow().isoformat() + "Z",
            "intent": "compute param adjustment from per-component delta; proportional correction for all FAIL components",
            "tool": "agent_revision",
            "args": {
                "param_delta": param_delta,
                "revision_driven_by": traj_entry["revision_driven_by"],
                "new_params": {k: round(v, 5) for k, v in new_params.items()},
            },
            "result_summary": "revision computed; new_params committed for next iteration",
        })
        seq += 1
        params = new_params
    else:
        print("  BUDGET EXHAUSTED at iteration {}".format(MAX_ITER))

session_end = datetime.datetime.utcnow().isoformat() + "Z"

best = best_delta_summary(trajectory)
verdict = (
    "PASS -- converged at iteration {}/{}".format(len(trajectory), MAX_ITER)
    if converged else
    "BUDGET_EXHAUSTED -- best delta per component: {}".format(
        {k: ("{}%".format(v) if v is not None else "not_detected") for k, v in best.items()})
)

session = {
    "schema_version": "1",
    "session_id": session_id,
    "session_start": session_start,
    "session_end": session_end,
    "prompt": "#18 autonomous-close: QM geometry target, frozen spec 2026-06-03",
    "design_intent": (
        "Drive QM model params to frozen target_spec via autonomous iterative correction. "
        "No human step between iterations. Each revision agent-computed from per-component delta. "
        "Convergence = ALL components below TOL simultaneously (not aggregate)."
    ),
    "events": events,
    "target_spec_path": SPEC_PATH,
    "initial_params": INITIAL_PARAMS,
    "targets": {k: round(v, 5) for k, v in TARGETS.items()},
    "tol_pct": TOL_PCT,
    "max_iter": MAX_ITER,
    "n_iterations": len(trajectory),
    "converged": converged,
    "verdict": verdict,
    "best_delta_per_component": best,
    "trajectory": trajectory,
}

SESSION_PATH = "{}/qm_autoclose_session.json".format(OUT_DIR)
with open(SESSION_PATH, "w") as f:
    json.dump(session, f, indent=2)

print("\n" + "=" * 60)
print("QM AUTONOMOUS-CLOSE: {}".format(verdict))
print("=" * 60)
print("  iterations:   {}".format(len(trajectory)))
print("  converged:    {}".format(converged))
if not converged:
    print("  best delta:   {}".format(best))
print("  session:      {}".format(SESSION_PATH))
