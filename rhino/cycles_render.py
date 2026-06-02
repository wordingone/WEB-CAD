import scriptcontext
scriptcontext.doc = __rhino_doc__
import rhinoscriptsyntax as rs
import Rhino
import Rhino.Commands as rc
import Rhino.PlugIns as rpi
import Rhino.Geometry as rg
import System
import time

doc = __rhino_doc__

RHINO_RENDER_GUID = System.Guid("4f793ad6-60ce-4aaf-8a7e-6e36c752486c")

render_plugin = rpi.RenderPlugIn.Find(RHINO_RENDER_GUID)
print(f"Plugin: {render_plugin.Name}")

print("Starting Cycles render (Render(doc, RunMode.Scripted, False))...")
t0 = time.time()

try:
    result = render_plugin.Render(doc, rc.RunMode.Scripted, False)
    t1 = time.time()
    print(f"Result: {result}, time={t1-t0:.1f}s")
except Exception as e:
    print(f"Render err: {e}")
    # Try RunMode.Interactive
    try:
        result = render_plugin.Render(doc, rc.RunMode.Interactive, False)
        t1 = time.time()
        print(f"Result (Interactive): {result}, time={t1-t0:.1f}s")
    except Exception as e2:
        print(f"Render Interactive err: {e2}")

print("done")
