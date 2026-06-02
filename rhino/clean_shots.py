import scriptcontext; scriptcontext.doc = __rhino_doc__
import rhinoscriptsyntax as rs, Rhino, Rhino.Display as rdisp, Rhino.Geometry as rg
import System.Drawing as sd, System.Drawing.Imaging as sdi, System.IO as sio
import Grasshopper, System, time

doc = __rhino_doc__
gh_doc = Grasshopper.Instances.ActiveCanvas.Document
PY_GUID  = "39cbe066-c316-492f-9e64-2dba30d19de6"
SNF_GUID = "de338fe3-cfd6-4137-b8c1-ddd6c21bb53b"

py_comp = gh_doc.FindObject(System.Guid(PY_GUID), True)
s_nf    = gh_doc.FindObject(System.Guid(SNF_GUID), True)

dm_render = rdisp.DisplayModeDescription.FindByName("Rendered")

sun = doc.Lights.Sun
sun.Enabled = True
sun.ManualControlOn = True
sun.Altitude = 45.0
sun.Azimuth = 210.0
sun.SkylightOn = True
doc.GroundPlane.Enabled = True

def solve_and_wait(nf_val):
    s_nf.Slider.Value = System.Convert.ToDecimal(nf_val)
    gh_doc.NewSolution(False)
    deadline = time.time() + 5.0
    while time.time() < deadline:
        phase = int(py_comp.Phase)
        if phase == 2 or phase == 3:
            break
        time.sleep(0.05)
    count = py_comp.Params.Output[1].VolatileDataCount
    print("  NF=%d: phase=%d, geoms=%d" % (nf_val, int(py_comp.Phase), count))
    return count

def shoot_elev(path, label):
    vw = next((v for v in doc.Views if v.MainViewport.Name == "Right"), None)
    if vw is None: vw = list(doc.Views)[0]
    doc.Views.ActiveView = vw
    vp = vw.MainViewport
    vp.ChangeToPerspectiveProjection(True, 35.0)
    if dm_render: vp.DisplayMode = dm_render
    rs.ZoomExtents(all=False)
    bmp = vw.CaptureToBitmap(sd.Size(1800, 1200))
    nb = 0
    if bmp:
        bmp.Save(path, sdi.ImageFormat.Jpeg); bmp.Dispose()
        nb = sio.FileInfo(path).Length
    print("  [%s] %d bytes %s" % (label, nb, "OK" if nb>20000 else "BLANK"))
    return nb

print("=== F=2 CLEAN ===")
solve_and_wait(2)
time.sleep(0.3)
nb2 = shoot_elev("B:/M/avir/eli/state/verify-f2.jpg", "F2")

print("=== F=3 CLEAN ===")
solve_and_wait(3)
time.sleep(0.3)
nb3 = shoot_elev("B:/M/avir/eli/state/verify-f3.jpg", "F3")

print("=== F=1 CLEAN ===")
solve_and_wait(1)
time.sleep(0.3)
shoot_elev("B:/M/avir/eli/state/verify-f1.jpg", "F1")

solve_and_wait(2)
print("F2 vs F3 delta: %d -> %d" % (nb2, nb3))
print("DONE")
