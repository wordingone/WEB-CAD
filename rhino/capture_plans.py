import scriptcontext; scriptcontext.doc = __rhino_doc__
import rhinoscriptsyntax as rs
import Rhino, Rhino.Display as rdisp, Rhino.Geometry as rg
import System.Drawing as sd, System.Drawing.Imaging as sdi, System.IO as sio
import hashlib

doc = __rhino_doc__
cx, cy = 5.5, 4.25

def purge_clips():
    removed = 0
    for obj in list(doc.Objects):
        if isinstance(obj.Geometry, rg.ClippingPlaneSurface):
            doc.Objects.Delete(obj.Id, True); removed += 1
    return removed

def set_layer_visible(name, visible):
    for i in range(doc.Layers.Count):
        if doc.Layers[i].Name == name:
            doc.Layers[i].IsVisible = visible
            return True
    return False

def all_layers_on():
    for i in range(doc.Layers.Count):
        doc.Layers[i].IsVisible = True

n = purge_clips()
print("Clips purged: %d" % n)

dm_wf = rdisp.DisplayModeDescription.FindByName("Wireframe")
top_view = next((v for v in doc.Views if v.MainViewport.Name == "Top"), None)
if not top_view:
    print("ERROR: No Top viewport")
    raise SystemExit

def shoot_plan(label, out_path, clip_z, hide_layers):
    purge_clips()
    all_layers_on()
    for ly in hide_layers:
        set_layer_visible(ly, False)

    doc.Views.ActiveView = top_view
    tvp = top_view.MainViewport
    tvp.ChangeToParallelProjection(True)
    tvp.SetCameraDirection(rg.Vector3d(0, 0, -1), True)
    tvp.CameraUp = rg.Vector3d(0, 1, 0)
    if dm_wf: tvp.DisplayMode = dm_wf

    # ZE: H_WALLS (Z=0-5.6) still visible, so camera lands at Z~10
    rs.ZoomExtents(all=False)
    cam = tvp.CameraLocation
    print("  %s ZE cam: (%.2f, %.2f, %.2f)" % (label, cam.X, cam.Y, cam.Z))

    # Capture BEFORE clip to verify ZE render is valid
    bmp0 = top_view.CaptureToBitmap(sd.Size(1600, 1600))
    pre_bytes = 0
    if bmp0:
        pre_path = out_path.replace(".jpg", "-pre.jpg")
        bmp0.Save(pre_path, sdi.ImageFormat.Jpeg); bmp0.Dispose()
        pre_bytes = sio.FileInfo(pre_path).Length
    print("  %s pre-clip: %d bytes %s" % (label, pre_bytes, "OK" if pre_bytes > 20000 else "BLANK"))

    # Add horizontal section clip at clip_z, normal DOWN = (0,0,-1)
    # Objects ABOVE clip_z are hidden; only Z < clip_z visible in render
    plane = rg.Plane(rg.Point3d(cx, cy, clip_z), rg.Vector3d(0, 0, -1))
    clip_id = doc.Objects.AddClippingPlane(plane, 60, 60, top_view.MainViewport.Id)
    rs.HideObject(clip_id)
    print("  %s clip added at Z=%.1f (normal DOWN = clips above)" % (label, clip_z))

    # Second ZE: ZE uses layer bbox (H_WALLS visible), camera stays at Z~10
    # The clip affects RENDER only, not ZE calculation.
    # DO NOT call ZoomExtents again — capture the buffer from the FIRST ZE.
    # (Second ZE would invalidate the buffer with a new camera position)
    bmp = top_view.CaptureToBitmap(sd.Size(1600, 1600))
    nb = 0
    if bmp:
        bmp.Save(out_path, sdi.ImageFormat.Jpeg); bmp.Dispose()
        nb = sio.FileInfo(out_path).Length
    print("  %s post-clip: %d bytes %s" % (label, nb, "OK" if nb > 20000 else "BLANK"))

    purge_clips()
    all_layers_on()
    return nb

print("--- GF PLAN (clip at Z=1.2, hides door headers at Z=2.1-2.8) ---")
gf_bytes = shoot_plan(
    "GF",
    "B:/M/avir/eli/state/house-gf-plan.jpg",
    clip_z=1.2,
    hide_layers=["H_IWALL_UF", "H_DOOR_UF", "H_STAIR", "H_SITE", "H_STONE", "H_FASCIA"]
)

print("\n--- UF PLAN (clip at Z=4.2, hides UF door headers at Z=5.1-5.6) ---")
uf_bytes = shoot_plan(
    "UF",
    "B:/M/avir/eli/state/house-uf-plan.jpg",
    clip_z=4.2,
    hide_layers=["H_IWALL_GF", "H_DOOR_GF", "H_DOOR", "H_STAIR", "H_SITE", "H_STONE", "H_FASCIA"]
)

gf_hash = hashlib.sha256(open("B:/M/avir/eli/state/house-gf-plan.jpg","rb").read()).hexdigest()
uf_hash = hashlib.sha256(open("B:/M/avir/eli/state/house-uf-plan.jpg","rb").read()).hexdigest()
print("\n--- HASH CHECK ---")
print("GF: %s  (%d bytes)" % (gf_hash[:16], gf_bytes))
print("UF: %s  (%d bytes)" % (uf_hash[:16], uf_bytes))
print("GF!=UF: %s" % ("PASS" if gf_hash != uf_hash else "FAIL"))
print("DONE")
