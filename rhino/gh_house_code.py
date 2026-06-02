import Rhino.Geometry as rg, math

EW  = float(width)   if width   is not None else 11.0
ED  = float(depth)   if depth   is not None else 8.5
GFH = float(flr_h)   if flr_h   is not None else 2.8
NF  = max(1, int(round(float(nfl)))) if nfl is not None else 2
RP  = float(roof_p)  if roof_p  is not None else 0.45

WT = 0.25
TH = GFH * NF
geoms = []

# --- EXTERIOR WALLS (hollow box) ---
outer_box = rg.Box(rg.BoundingBox(rg.Point3d(0, 0, 0), rg.Point3d(EW, ED, TH)))
inner_box  = rg.Box(rg.BoundingBox(rg.Point3d(WT, WT, -0.05), rg.Point3d(EW-WT, ED-WT, TH+0.05)))
walls = rg.Brep.CreateBooleanDifference([outer_box.ToBrep()], [inner_box.ToBrep()], 0.01)
if walls:
    geoms.extend(walls)
else:
    geoms.append(outer_box.ToBrep())

# --- FLOOR SLAB ---
floor_box = rg.Box(rg.BoundingBox(rg.Point3d(-0.05, -0.05, -0.20), rg.Point3d(EW+0.05, ED+0.05, 0.0)))
geoms.append(floor_box.ToBrep())

# --- HIP ROOF (closed solid: 4 slope panels + eave floor) ---
span = min(EW, ED)
ridge_h = span * RP
rz = TH

if EW >= ED:
    hx = ED / 2.0
    e0 = rg.Point3d(0,       0,    rz)
    e1 = rg.Point3d(EW,      0,    rz)
    e2 = rg.Point3d(EW,      ED,   rz)
    e3 = rg.Point3d(0,       ED,   rz)
    r0 = rg.Point3d(hx,      ED/2, rz + ridge_h)
    r1 = rg.Point3d(EW - hx, ED/2, rz + ridge_h)
    # (p0, p1, p2, p3) — p2==p3 signals a triangle
    roof_faces = [
        (e0, e1, r1, r0),   # front trapezoid
        (e2, e3, r0, r1),   # back trapezoid
        (e3, e0, r0, r0),   # left triangle
        (e1, e2, r1, r1),   # right triangle
    ]
else:
    hy = EW / 2.0
    e0 = rg.Point3d(0,  0,  rz)
    e1 = rg.Point3d(EW, 0,  rz)
    e2 = rg.Point3d(EW, ED, rz)
    e3 = rg.Point3d(0,  ED, rz)
    r0 = rg.Point3d(EW/2, hy,      rz + ridge_h)
    r1 = rg.Point3d(EW/2, ED - hy, rz + ridge_h)
    roof_faces = [
        (e0, e1, r0, r0),   # front triangle
        (e2, e3, r1, r1),   # back triangle
        (e3, e0, r1, r0),   # left trapezoid
        (e1, e2, r0, r1),   # right trapezoid
    ]

roof_breps = []

# Eave floor face (bottom of roof solid, at Z=TH)
eave_pl = rg.Plane(rg.Point3d(0, 0, TH), rg.Vector3d.ZAxis)
eave_rect = rg.Rectangle3d(eave_pl, rg.Interval(0, EW), rg.Interval(0, ED))
eave_faces = rg.Brep.CreatePlanarBreps([eave_rect.ToNurbsCurve()], 0.01)
if eave_faces:
    roof_breps.append(eave_faces[0])

# 4 slope panels — ensure normals point outward (positive Z component)
for (p0, p1, p2, p3) in roof_faces:
    is_tri = (p2 == p3)
    if is_tri:
        srf = rg.NurbsSurface.CreateFromCorners(p0, p1, p2)
    else:
        srf = rg.NurbsSurface.CreateFromCorners(p0, p1, p2, p3)
    if srf is None:
        continue
    # Check normal direction at surface mid-point; flip if Z < 0
    u_mid = (srf.Domain(0).Min + srf.Domain(0).Max) / 2
    v_mid = (srf.Domain(1).Min + srf.Domain(1).Max) / 2
    n = srf.NormalAt(u_mid, v_mid)
    if n.Z < 0:
        srf.Reverse(1, True)
    b = srf.ToBrep()
    if b:
        roof_breps.append(b)

# Join into closed solid; fall back to individual panels on failure
if roof_breps:
    joined = rg.Brep.JoinBreps(roof_breps, 0.1)
    if joined and any(b.IsSolid for b in joined):
        geoms.extend(joined)
    else:
        # Fallback: add individual panels (eave face + slopes)
        geoms.extend(roof_breps)

a = geoms
