import scriptcontext; scriptcontext.doc = __rhino_doc__
import Rhino, Rhino.Geometry as rg, Rhino.DocObjects as rdo
import System.Drawing as sd
import math

doc = __rhino_doc__

# Clear all objects and layers
for obj in list(doc.Objects):
    doc.Objects.Delete(obj, True)
for i in range(doc.Layers.Count - 1, 0, -1):
    try: doc.Layers.Purge(i, True)
    except: pass

# === DIMENSIONS ===
EW, ED = 11.0, 8.5
GFH, UFH = 2.8, 2.6
ST = 0.20
WT = 0.25   # exterior wall thickness
IT = 0.12   # interior wall thickness
OV = 0.55   # roof overhang
RH = 2.8    # ridge height above eave
T_ROOF = 0.18  # roof panel solid thickness

Z1 = GFH        # 2.8 eave of GF / bottom of inter-floor slab
Z2 = Z1 + ST    # 3.0 bottom of UF walls
Z3 = Z2 + UFH   # 5.6 eave level
ZRIDGE = Z3 + RH  # 8.4
ridge_x = EW / 2  # 5.5

SX = 5.3    # spine wall X (structural both floors)
FY = 3.4    # GF foyer back wall Y
STX = 3.7   # GF stair left wall X

DW = 0.90   # standard door width
DH = 2.10   # standard door height
DW_E = 0.95 # entry door width
DH_E = 2.15 # entry door height
DX = SX - 0.85  # entry door X start = 4.45

# === MATERIALS ===
def add_mat(name, diff, emiss, spec=(210,210,210), refl=0.06, shine=22):
    idx = doc.Materials.Add()
    m = doc.Materials[idx]
    m.Name = name
    m.DiffuseColor = sd.Color.FromArgb(*diff)
    m.EmissionColor = sd.Color.FromArgb(*emiss)
    m.SpecularColor = sd.Color.FromArgb(*spec)
    m.Reflectivity = refl; m.Shine = shine
    m.CommitChanges()
    return idx

M_WALL  = add_mat("M_WALL",   (225,215,198), (90,85,78),   (242,237,228), 0.04, 18)
M_IWALL = add_mat("M_IWALL",  (232,228,220), (93,91,87),   (245,243,238), 0.03, 12)
M_ROOF  = add_mat("M_ROOF",   (52,48,55),    (38,35,42),   (70,66,75),    0.10, 20)
M_GLASS = add_mat("M_GLASS",  (82,136,190),  (33,54,76),   (150,196,236), 0.55, 200)
M_FRAME = add_mat("M_FRAME",  (188,148,92),  (72,55,35),   (212,178,118), 0.05, 25)
M_FLOOR = add_mat("M_FLOOR",  (172,138,88),  (67,54,34),   (198,172,115), 0.08, 32)
M_DOOR  = add_mat("M_DOOR",   (92,62,32),    (35,23,12),   (130,96,58),   0.12, 38)
M_SITE  = add_mat("M_SITE",   (108,138,82),  (42,53,32),   (135,162,105), 0.02, 8)
M_STONE = add_mat("M_STONE",  (168,158,135), (65,61,52),   (192,183,160), 0.07, 28)
M_FASCIA= add_mat("M_FASCIA", (188,148,92),  (72,55,35),   (212,178,118), 0.05, 22)
M_STAIR = add_mat("M_STAIR",  (155,125,82),  (60,48,32),   (182,158,108), 0.08, 28)

# === LAYERS ===
def add_layer(name, mat_idx):
    idx = doc.Layers.Add(name, sd.Color.Black)
    doc.Layers[idx].RenderMaterialIndex = mat_idx
    return idx

L_EW    = add_layer("H_WALLS",    M_WALL)
L_IW    = add_layer("H_IWALL",    M_IWALL)
L_IW_GF = add_layer("H_IWALL_GF", M_IWALL)
L_IW_UF = add_layer("H_IWALL_UF", M_IWALL)
L_RF    = add_layer("H_ROOF",     M_ROOF)
L_GL    = add_layer("H_GLASS",    M_GLASS)
L_FR    = add_layer("H_FRAME",    M_FRAME)
L_FL    = add_layer("H_FLOOR",    M_FLOOR)
L_DR    = add_layer("H_DOOR",     M_DOOR)
L_DR_GF = add_layer("H_DOOR_GF",  M_DOOR)
L_DR_UF = add_layer("H_DOOR_UF",  M_DOOR)
L_ST    = add_layer("H_SITE",     M_SITE)
L_SN    = add_layer("H_STONE",    M_STONE)
L_FC    = add_layer("H_FASCIA",   M_FASCIA)
L_SR    = add_layer("H_STAIR",    M_STAIR)

# === BOX HELPER ===
def add_box(x0, y0, z0, w, d, h, layer_idx):
    if w <= 0.005 or d <= 0.005 or h <= 0.005: return
    p = rg.Point3d(x0, y0, z0)
    box = rg.Box(rg.Plane(p, rg.Vector3d.ZAxis),
                 rg.Interval(0, w), rg.Interval(0, d), rg.Interval(0, h))
    brep = rg.Brep.CreateFromBox(box)
    if not brep: return
    attr = rdo.ObjectAttributes()
    attr.LayerIndex = layer_idx
    attr.MaterialSource = rdo.ObjectMaterialSource.MaterialFromLayer
    doc.Objects.AddBrep(brep, attr)

# === DOOR WALL HELPERS ===
def xwall_door(x0, y0, z0, total_w, d, h, layer_idx, door_x, door_w=DW, door_h=DH, door_layer=None):
    """X-running wall (thin in Y) with door gap + leaf."""
    dl = door_layer if door_layer is not None else L_DR
    add_box(x0, y0, z0, door_x - x0, d, h, layer_idx)
    rx = door_x + door_w
    add_box(rx, y0, z0, (x0 + total_w) - rx, d, h, layer_idx)
    add_box(door_x, y0, z0 + door_h, door_w, d, h - door_h, layer_idx)
    add_box(door_x, y0 - door_w, z0, d, door_w, door_h, dl)

def ywall_door(x0, y0, z0, w, total_d, h, layer_idx, door_y, door_w=DW, door_h=DH, door_layer=None):
    """Y-running wall (thin in X) with door gap + leaf."""
    dl = door_layer if door_layer is not None else L_DR
    add_box(x0, y0, z0, w, door_y - y0, h, layer_idx)
    ry = door_y + door_w
    add_box(x0, ry, z0, w, (y0 + total_d) - ry, h, layer_idx)
    add_box(x0, door_y, z0 + door_h, w, door_w, h - door_h, layer_idx)
    add_box(x0 - door_w, door_y, z0, door_w, w, door_h, dl)

# ============================================================
# SITE + FOUNDATION
# ============================================================
add_box(-5, -5, -0.12, EW+10, ED+10, 0.12, L_ST)
add_box(-0.4, -4.0, 0, 1.2, 4.0, 0.07, L_SN)    # entry path
add_box(-0.2, -0.2, -0.28, EW+0.4, ED+0.4, 0.28, L_SN)  # foundation

# ============================================================
# GF EXTERIOR WALLS (with entry door opening)
# ============================================================
# Front wall: split at entry door DX=4.45, DW_E=0.95
add_box(0, 0, 0, DX, WT, GFH, L_EW)                        # left of door
add_box(DX + DW_E, 0, 0, EW - (DX + DW_E), WT, GFH, L_EW) # right of door
add_box(DX, 0, DH_E, DW_E, WT, GFH - DH_E, L_EW)          # header above door

add_box(0, ED-WT, 0, EW, WT, GFH, L_EW)        # rear
add_box(0, WT, 0, WT, ED-2*WT, GFH, L_EW)      # left
add_box(EW-WT, WT, 0, WT, ED-2*WT, GFH, L_EW)  # right

# ============================================================
# GF FLOOR SLAB
# ============================================================
add_box(0, 0, -ST, EW, ED, ST, L_FL)

# ============================================================
# GF INTERIOR WALLS WITH DOORS
# Rooms: Foyer(SW front), Hallway/Stair(centre), Living(SW rear),
#        Kitchen(NE front), Dining(NE rear), Powder room(W side)
# ============================================================

# 1. Spine X=5.3 — ONE door near front (Y=1.5) connecting foyer to kitchen area
add_box(SX, WT, 0, IT, 1.5-WT, GFH, L_IW_GF)            # Y=0.25..1.5
add_box(SX, 1.5, DH, IT, DW, GFH-DH, L_IW_GF)            # door header
add_box(SX-DW, 1.5, 0, DW, IT, DH, L_DR_GF)              # door leaf
add_box(SX, 1.5+DW, 0, IT, ED-WT-1.5-DW, GFH, L_IW_GF)  # Y=2.4..8.25

# 2. Foyer back wall Y=3.4, X=WT..SX — door at X=0.6..1.5
xwall_door(WT, FY, 0, SX-WT, IT, GFH, L_IW_GF, door_x=0.6, door_w=DW, door_h=DH, door_layer=L_DR_GF)

# 3. Kitchen cross wall Y=4.8, X=SX+IT..EW-WT — door at X=6.0..6.9
xwall_door(SX+IT, 4.8, 0, EW-WT-SX-IT, IT, GFH, L_IW_GF, door_x=6.0, door_w=DW, door_h=DH, door_layer=L_DR_GF)

# 4. Stair left wall X=STX=3.7, Y=FY+IT..ED-WT — door at Y=3.65..4.55
ywall_door(STX, FY+IT, 0, IT, ED-WT-FY-IT, GFH, L_IW_GF, door_y=FY+IT+0.15, door_w=DW, door_h=DH, door_layer=L_DR_GF)

# 5. Powder room back Y=5.3, X=WT..STX — door at X=0.4..1.15
xwall_door(WT, 5.3, 0, STX-WT, IT, GFH, L_IW_GF, door_x=0.4, door_w=0.75, door_h=DH, door_layer=L_DR_GF)

# ============================================================
# INTER-FLOOR SLAB
# ============================================================
add_box(0, 0, Z1, EW, ED, ST, L_FL)

# ============================================================
# UF EXTERIOR WALLS
# ============================================================
add_box(0, 0, Z2, EW, WT, UFH, L_EW)
add_box(0, ED-WT, Z2, EW, WT, UFH, L_EW)
add_box(0, WT, Z2, WT, ED-2*WT, UFH, L_EW)
add_box(EW-WT, WT, Z2, WT, ED-2*WT, UFH, L_EW)

# ============================================================
# UF INTERIOR WALLS WITH DOORS
# UF is genuinely different from GF:
#   West (X<5.3): Master (Y<4.2) + Bed2 (Y>4.2)
#   East center (X=5.3..7.5): Landing/Hall (Y<4.2) + Bed3 (Y>4.2)
#   East right (X=7.5..11): Bath (Y<4.2) + Bed3 continues (Y>4.2)
# Key walls absent from GF: Y=4.2 main divider, X=7.5 bath wall
# Key walls present on GF but not UF: X=3.7 stair, Y=3.4 foyer, Y=5.3 powder
# ============================================================
BATH_X = 7.5   # bath left wall X
DIV_Y = 4.2    # main east-west divider Y

# 1. Spine X=5.3, Y=WT..ED-WT — TWO doors (master access + bed3 access)
d1y = 1.0  # door 1 y-start
d2y = 5.5  # door 2 y-start
add_box(SX, WT, Z2, IT, d1y-WT, UFH, L_IW_UF)                     # Y=0.25..1.0
add_box(SX, d1y, Z2+DH, IT, DW, UFH-DH, L_IW_UF)                  # door1 header
add_box(SX-DW, d1y, Z2, DW, IT, DH, L_DR_UF)                       # door1 leaf (opens west into master)
add_box(SX, d1y+DW, Z2, IT, d2y-d1y-DW, UFH, L_IW_UF)             # Y=1.9..5.5
add_box(SX, d2y, Z2+DH, IT, DW, UFH-DH, L_IW_UF)                  # door2 header
add_box(SX-DW, d2y, Z2, DW, IT, DH, L_DR_UF)                       # door2 leaf (opens west into bed2)
add_box(SX, d2y+DW, Z2, IT, ED-WT-d2y-DW, UFH, L_IW_UF)           # Y=6.4..8.25

# 2. Main Y=4.2 divider (master/bed2 | landing+bath/bed3)
# 2a. West section X=WT..SX: master/bed2 — door at X=0.5..1.4
xwall_door(WT, DIV_Y, Z2, SX-WT, IT, UFH, L_IW_UF, door_x=0.5, door_w=DW, door_h=DH, door_layer=L_DR_UF)
# 2b. Centre section X=SX+IT..BATH_X: landing/bed3 — door at X=5.5..6.4
xwall_door(SX+IT, DIV_Y, Z2, BATH_X-SX-IT, IT, UFH, L_IW_UF, door_x=SX+IT+0.2, door_w=DW, door_h=DH, door_layer=L_DR_UF)
# 2c. Right section X=BATH_X+IT..EW-WT: bath back wall (no door — bath uses left wall door)
add_box(BATH_X+IT, DIV_Y, Z2, EW-WT-BATH_X-IT, IT, UFH, L_IW_UF)

# 3. Bath left wall X=7.5, Y=WT..DIV_Y — door near front
ywall_door(BATH_X, WT, Z2, IT, DIV_Y-WT, UFH, L_IW_UF, door_y=WT+0.2, door_w=DW, door_h=DH, door_layer=L_DR_UF)

# ============================================================
# GABLE WALLS (mesh triangles — same as iter1)
# ============================================================
def add_gable(y_val, layer_idx):
    pts = [rg.Point3d(0, y_val, Z3), rg.Point3d(EW, y_val, Z3),
           rg.Point3d(ridge_x, y_val, ZRIDGE)]
    mesh = rg.Mesh()
    for p in pts: mesh.Vertices.Add(p)
    mesh.Faces.AddFace(0, 1, 2)
    mesh.Normals.ComputeNormals()
    attr = rdo.ObjectAttributes()
    attr.LayerIndex = layer_idx
    attr.MaterialSource = rdo.ObjectMaterialSource.MaterialFromLayer
    doc.Objects.AddMesh(mesh, attr)

add_gable(0, L_EW)
add_gable(ED, L_EW)

# ============================================================
# SOLID ROOF PANELS (closed breps with T_ROOF thickness)
# ============================================================
def add_solid_roof(bot4, layer_idx):
    """Create a closed-solid roof panel from 4 bottom corner points."""
    b = bot4
    # Compute outward slope normal (must point upward, away from building interior)
    e1 = rg.Vector3d(b[1].X-b[0].X, b[1].Y-b[0].Y, b[1].Z-b[0].Z)
    e2 = rg.Vector3d(b[3].X-b[0].X, b[3].Y-b[0].Y, b[3].Z-b[0].Z)
    n = rg.Vector3d.CrossProduct(e1, e2)
    n.Unitize()
    if n.Z < 0: n = rg.Vector3d(-n.X, -n.Y, -n.Z)  # ensure upward

    # Offset corner points inward-upward to form top face
    t = [rg.Point3d(p.X + n.X*T_ROOF, p.Y + n.Y*T_ROOF, p.Z + n.Z*T_ROOF) for p in b]

    def qf(p0, p1, p2, p3):
        return rg.Brep.CreateFromCornerPoints(p0, p1, p2, p3, 0.001)

    # 6 faces: bottom (exterior), top (interior), 4 sides
    faces = [
        qf(b[3], b[2], b[1], b[0]),  # bottom (reversed = outward normal down-outward)
        qf(t[0], t[1], t[2], t[3]),  # top
        qf(b[0], b[1], t[1], t[0]),  # side 01
        qf(b[1], b[2], t[2], t[1]),  # side 12
        qf(b[2], b[3], t[3], t[2]),  # side 23
        qf(b[3], b[0], t[0], t[3]),  # side 30
    ]
    faces = [f for f in faces if f]
    result = rg.Brep.JoinBreps(faces, 0.01)
    if result and len(result) > 0:
        solid = result[0]
        attr = rdo.ObjectAttributes()
        attr.LayerIndex = layer_idx
        attr.MaterialSource = rdo.ObjectMaterialSource.MaterialFromLayer
        doc.Objects.AddBrep(solid, attr)
        return solid.IsSolid
    return False

pFL = rg.Point3d(-OV, -OV, Z3)
pRL = rg.Point3d(-OV, ED+OV, Z3)
pFR = rg.Point3d(EW+OV, -OV, Z3)
pRR = rg.Point3d(EW+OV, ED+OV, Z3)
pRF = rg.Point3d(ridge_x, -OV, ZRIDGE)
pRB = rg.Point3d(ridge_x, ED+OV, ZRIDGE)

l_solid = add_solid_roof([pFL, pRL, pRB, pRF], L_RF)
r_solid = add_solid_roof([pFR, pRR, pRB, pRF], L_RF)
print("Left roof IsSolid=%s  Right roof IsSolid=%s" % (l_solid, r_solid))

# ============================================================
# FASCIA BOARDS
# ============================================================
FH, FT = 0.18, 0.04
add_box(-OV, -OV-FT, Z3-FH, EW+2*OV, FT, FH, L_FC)
add_box(-OV, ED+OV, Z3-FH, EW+2*OV, FT, FH, L_FC)
add_box(-OV-FT, -OV, Z3-FH, FT, ED+2*OV, FH, L_FC)
add_box(EW+OV, -OV, Z3-FH, FT, ED+2*OV, FH, L_FC)

# ============================================================
# CHIMNEY (stone, rear-left)
# ============================================================
add_box(2.2, 1.6, Z1, 0.6, 0.6, ZRIDGE-Z1+0.35, L_SN)

# ============================================================
# STAIRCASE (14 treads, GF → UF)
# ============================================================
n_st = 14
st_rise = Z2 / n_st
st_run = 0.24
st_w = 1.1
st_x0 = STX - st_w - IT
st_y0 = FY + IT + 0.12
for i in range(n_st):
    add_box(st_x0, st_y0 + i*st_run, i*st_rise, st_w, st_run, st_rise+0.02, L_SR)

# ============================================================
# WINDOWS (same layout as iter1 — placed proud of exterior face)
# ============================================================
def win_front(x0, w, z0, h):
    add_box(x0, -0.02, z0, w, 0.06, h, L_GL)
    fw = 0.07
    add_box(x0-fw, -0.03, z0-fw, fw, 0.08, h+2*fw, L_FR)
    add_box(x0+w,  -0.03, z0-fw, fw, 0.08, h+2*fw, L_FR)
    add_box(x0-fw, -0.03, z0-fw, w+2*fw, 0.08, fw, L_FR)
    add_box(x0-fw, -0.03, z0+h,  w+2*fw, 0.08, fw, L_FR)

def win_rear(x0, w, z0, h):
    add_box(x0, ED-0.04, z0, w, 0.06, h, L_GL)
    fw = 0.07
    add_box(x0-fw, ED-0.05, z0-fw, fw, 0.08, h+2*fw, L_FR)
    add_box(x0+w,  ED-0.05, z0-fw, fw, 0.08, h+2*fw, L_FR)
    add_box(x0-fw, ED-0.05, z0-fw, w+2*fw, 0.08, fw, L_FR)
    add_box(x0-fw, ED-0.05, z0+h,  w+2*fw, 0.08, fw, L_FR)

def win_left(y0, d, z0, h):
    add_box(-0.02, y0, z0, 0.06, d, h, L_GL)
    fw = 0.07
    add_box(-0.03, y0-fw, z0-fw, 0.08, fw, h+2*fw, L_FR)
    add_box(-0.03, y0+d,  z0-fw, 0.08, fw, h+2*fw, L_FR)
    add_box(-0.03, y0-fw, z0-fw, 0.08, d+2*fw, fw, L_FR)
    add_box(-0.03, y0-fw, z0+h,  0.08, d+2*fw, fw, L_FR)

def win_right(y0, d, z0, h):
    add_box(EW-0.04, y0, z0, 0.06, d, h, L_GL)
    fw = 0.07
    add_box(EW-0.05, y0-fw, z0-fw, 0.08, fw, h+2*fw, L_FR)
    add_box(EW-0.05, y0+d,  z0-fw, 0.08, fw, h+2*fw, L_FR)
    add_box(EW-0.05, y0-fw, z0-fw, 0.08, d+2*fw, fw, L_FR)
    add_box(EW-0.05, y0-fw, z0+h,  0.08, d+2*fw, fw, L_FR)

# GF windows
win_front(0.7, 2.4, 0.85, 1.5)
win_front(6.2, 3.5, 0.85, 1.5)
win_rear(0.7, 2.0, 0.85, 1.4)
win_rear(5.8, 4.2, 0.85, 1.4)
win_left(1.0, 1.5, 0.85, 1.4)
win_right(1.0, 1.5, 0.85, 1.4)
win_right(5.5, 1.5, 0.85, 1.4)

# UF windows
WSH = Z2 + 0.7
win_front(0.6, 2.6, WSH, 1.3)
win_front(5.7, 1.8, WSH, 1.3)
win_front(8.0, 1.8, WSH, 1.3)  # bath window added
win_rear(0.6, 2.6, WSH, 1.3)
win_rear(5.7, 3.8, WSH, 1.3)
win_left(1.0, 1.5, WSH, 1.2)
win_left(5.2, 1.5, WSH, 1.2)
win_right(1.0, 1.5, WSH, 1.2)
win_right(5.0, 1.5, WSH, 1.2)

# ============================================================
# ENTRY DOOR (panel + timber frame, proud of front wall)
# ============================================================
add_box(DX, -0.02, 0, DW_E, 0.06, DH_E, L_DR)
fw = 0.08
add_box(DX-fw, -0.03, -0.05, fw, 0.08, DH_E+0.1, L_FR)
add_box(DX+DW_E, -0.03, -0.05, fw, 0.08, DH_E+0.1, L_FR)
add_box(DX-fw, -0.03, DH_E, DW_E+2*fw, 0.08, 0.1, L_FR)

doc.Views.Redraw()

# ============================================================
# SOLID AUDIT
# ============================================================
objs = list(doc.Objects)
n_closed = 0; n_open = 0; n_mesh = 0; open_layers = {}
for o in objs:
    g = o.Geometry
    if isinstance(g, rg.Brep):
        if g.IsSolid:
            n_closed += 1
        else:
            n_open += 1
            ly = doc.Layers[o.Attributes.LayerIndex].Name
            open_layers[ly] = open_layers.get(ly, 0) + 1
    elif isinstance(g, rg.Mesh):
        n_mesh += 1

print("BUILD DONE: %d objects" % len(objs))
print("AUDIT — CLOSED: %d  OPEN: %d  MESH: %d" % (n_closed, n_open, n_mesh))
if open_layers:
    for ly, cnt in open_layers.items():
        print("  OPEN on %s: %d objects" % (ly, cnt))
else:
    print("  No open breps.")
print("Layers: %d" % doc.Layers.Count)
