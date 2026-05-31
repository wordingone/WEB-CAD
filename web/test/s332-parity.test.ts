/**
 * s332-parity.test.ts — Issue #332: S12 SubD oracle parity tests
 *
 * ALL tests are skipped. Every SubD operation is blocked on:
 *   1. kern/subd.cpp — Catmull-Clark evaluation + primitive constructors (not written)
 *   2. kern.wasm — SubD module not compiled
 *   3. web/src/nurbs/subd-mesh.ts — SubDMesh type (not created)
 *   4. web/src/nurbs/subd-tessellate.ts — Catmull-Clark tessellator (not created)
 *   5. web/src/viewer/subd-display.ts — Three.js display helper (not created)
 *
 * When kern/subd.cpp is written and compiled, remove the test.skip wrappers
 * and import the actual SubD modules. Oracle assertions use LIVE oracle calls —
 * no hardcoded expected values.
 *
 * Oracle strategy per op:
 *   SdSubDFromMesh      — Rhino3dm SubD.CreateFromMesh; vertex/face count parity
 *   SdSubDBox           — closed-form: 8 verts, 6 quads, AABB == input dims
 *   SdSubDSphere        — Rhino3dm SubD.CreateSphere; ToBrep bounding sphere radius ±0.5%
 *   SdSubDCylinder      — closed-form: lateral verts on circle; top/bottom at z=0,z=height
 *   SdSubDCone          — closed-form: apex at (cx,cy,cz+height), base ring at radius
 *   SdSubDPlane         — closed-form: (uDiv+1)*(vDiv+1) verts, uDiv*vDiv faces, all z=cz
 *   SdSubDTorus         — closed-form torus parametric formula; vertex positions
 *   SdSubDCreaseSet     — post-crease subdivision; edge midpoint stays on crease line
 *   SdSubDCreaseRemove  — crease weight resets to 0; edge reverts to smooth
 *   SdSubDToBrep        — brepIsSolid=true, nakedEdgeCount=0; points within 0.02 of limit surface
 *   SdSubDToNurbs       — verb-nurbs eval vs Catmull-Clark limit surface at UV grid
 *   SdSubDControlPointEdit — vertex[i].position === supplied position (exact)
 */

import { describe, expect, test } from "bun:test";

// ─────────────────────────────────────────────────────────────────────────────
// SdSubDFromMesh
// ─────────────────────────────────────────────────────────────────────────────

describe("SdSubDFromMesh — SubD from existing mesh", () => {
  test.skip(
    "blocked: requires kern_subd_from_mesh in kern.wasm — control net vertex count matches Rhino3dm SubD.CreateFromMesh for an 8-face cube mesh",
    () => {
      // When unblocked:
      // const cubeMeshJson = buildTestCubeMeshJson(); // 8 verts, 6 quads
      // const result = kern_subd_from_mesh(cubeMeshJson, 0.0);
      // const mesh = JSON.parse(result) as SubDMesh;
      // oracle: rhino3dm SubD.CreateFromMesh
      // const rhinoMesh = await rhino3dm.SubD.createFromMesh(cubeMesh);
      // expect(mesh.vertices.length).toBe(rhinoMesh.vertexCount);
      // expect(mesh.faces.length).toBe(rhinoMesh.faceCount);
    },
  );

  test.skip(
    "blocked: requires kern_subd_from_mesh — non-manifold mesh (non-axis-aligned, triangulated sphere icosphere) converts to SubD with correct topology",
    () => {
      // When unblocked:
      // const icosphereMeshJson = buildIcosphereMeshJson(radius=1.5, subdivisions=2);
      // const result = kern_subd_from_mesh(icosphereMeshJson, 0.0);
      // const mesh = JSON.parse(result) as SubDMesh;
      // oracle: rhino3dm SubD.CreateFromMesh
      // expect(mesh.kind).toBe("subd");
      // expect(mesh.faces.every(f => f.vertices.length === 3 || f.vertices.length === 4)).toBe(true);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// SdSubDBox
// ─────────────────────────────────────────────────────────────────────────────

describe("SdSubDBox — SubD box primitive", () => {
  test.skip(
    "blocked: requires kern_subd_box in kern.wasm — control net has exactly 8 vertices and 6 quad faces",
    () => {
      // When unblocked:
      // const result = kern_subd_box(2.0, 3.0, 1.5, 0, 0, 0);
      // const mesh = JSON.parse(result) as SubDMesh;
      // expect(mesh.vertices.length).toBe(8);
      // expect(mesh.faces.length).toBe(6);
      // expect(mesh.faces.every(f => f.vertices.length === 4)).toBe(true);
    },
  );

  test.skip(
    "blocked: requires kern_subd_box — AABB of control net matches input width/depth/height (non-unit, non-axis-aligned center)",
    () => {
      // When unblocked:
      // const w=3.7, d=1.2, h=2.8, cx=1.1, cy=-0.5, cz=0.3;
      // const result = kern_subd_box(w, d, h, cx, cy, cz);
      // const mesh = JSON.parse(result) as SubDMesh;
      // oracle: closed-form AABB
      // const positions = mesh.vertices.map(v => v.position);
      // const xs = positions.map(p => p[0]);
      // const ys = positions.map(p => p[1]);
      // const zs = positions.map(p => p[2]);
      // expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(w, 9);
      // expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(d, 9);
      // expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(h, 9);
      // expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(cx, 9);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// SdSubDSphere
// ─────────────────────────────────────────────────────────────────────────────

describe("SdSubDSphere — SubD sphere primitive", () => {
  test.skip(
    "blocked: requires kern_subd_sphere in kern.wasm — Rhino3dm SubD.CreateSphere vertex count parity for radius=2.5",
    () => {
      // When unblocked:
      // const result = kern_subd_sphere(2.5, 0, 0, 0);
      // const mesh = JSON.parse(result) as SubDMesh;
      // oracle: rhino3dm SubD.CreateSphere
      // const rhinoSubD = await rhino3dm.SubD.createSphere({ radius: 2.5 });
      // expect(mesh.vertices.length).toBe(rhinoSubD.vertexCount);
    },
  );

  test.skip(
    "blocked: requires kern_subd_sphere + kern_subd_to_brep — ToBrep bounding sphere radius within 0.5% of input radius",
    () => {
      // When unblocked:
      // const radius = 3.0;
      // const subdResult = kern_subd_sphere(radius, 0, 0, 0);
      // const brepResult = kern_subd_to_brep(subdResult, true, 1e-4);
      // const brep = JSON.parse(brepResult) as Brep;
      // oracle: bounding sphere of all tessellation points
      // const tess = tessellateBrepForTest(brep);
      // const measuredRadius = computeBoundingSphereRadius(tess.positions);
      // expect(measuredRadius).toBeCloseTo(radius, 1); // within 0.5%
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// SdSubDCylinder
// ─────────────────────────────────────────────────────────────────────────────

describe("SdSubDCylinder — SubD cylinder primitive", () => {
  test.skip(
    "blocked: requires kern_subd_cylinder in kern.wasm — lateral vertices lie on circle of given radius at z=0 and z=height",
    () => {
      // When unblocked:
      // const r=1.3, h=3.7, sides=8;
      // const result = kern_subd_cylinder(r, h, sides, 0.5, -0.3, 1.1);
      // const mesh = JSON.parse(result) as SubDMesh;
      // oracle: closed-form — each lateral vertex distance from axis == r, z in {cz, cz+h}
      // const lateralVerts = mesh.vertices.filter(v =>
      //   Math.abs(v.position[2] - 1.1) < 1e-4 || Math.abs(v.position[2] - (1.1 + h)) < 1e-4
      // );
      // for (const v of lateralVerts) {
      //   const distFromAxis = Math.sqrt((v.position[0]-0.5)**2 + (v.position[1]+0.3)**2);
      //   expect(distFromAxis).toBeCloseTo(r, 4);
      // }
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// SdSubDCone
// ─────────────────────────────────────────────────────────────────────────────

describe("SdSubDCone — SubD cone primitive", () => {
  test.skip(
    "blocked: requires kern_subd_cone in kern.wasm — apex vertex at (cx, cy, cz+height); base ring vertices at radius",
    () => {
      // When unblocked:
      // const r=0.8, h=2.2, sides=6, cx=1.0, cy=0.5, cz=-0.2;
      // const result = kern_subd_cone(r, h, sides, cx, cy, cz);
      // const mesh = JSON.parse(result) as SubDMesh;
      // oracle: closed-form apex position
      // const apex = mesh.vertices.reduce((best, v) =>
      //   v.position[2] > best.position[2] ? v : best
      // );
      // expect(apex.position[0]).toBeCloseTo(cx, 4);
      // expect(apex.position[1]).toBeCloseTo(cy, 4);
      // expect(apex.position[2]).toBeCloseTo(cz + h, 4);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// SdSubDPlane
// ─────────────────────────────────────────────────────────────────────────────

describe("SdSubDPlane — SubD plane primitive", () => {
  test.skip(
    "blocked: requires SubDMesh type + display layer — vertex count = (uDiv+1)*(vDiv+1), face count = uDiv*vDiv",
    () => {
      // When unblocked:
      // const w=4.0, d=3.0, uDiv=6, vDiv=4, cz=1.5;
      // const result = kern_subd_plane(w, d, uDiv, vDiv, 0, 0, cz);
      // const mesh = JSON.parse(result) as SubDMesh;
      // oracle: closed-form counts
      // expect(mesh.vertices.length).toBe((uDiv + 1) * (vDiv + 1));
      // expect(mesh.faces.length).toBe(uDiv * vDiv);
      // oracle: all vertices at z == cz
      // for (const v of mesh.vertices) {
      //   expect(v.position[2]).toBeCloseTo(cz, 9);
      // }
    },
  );

  test.skip(
    "blocked: all vertices are coplanar (flat Catmull-Clark preserves planarity after subdivision)",
    () => {
      // When unblocked:
      // const result = kern_subd_plane(2.0, 2.0, 4, 4, 0, 0, 0);
      // After 2 levels of subdivision, all z-coords remain 0
      // const subdivided = kern_subd_subdivide_global(result, 2);
      // const mesh = JSON.parse(subdivided) as SubDMesh;
      // for (const v of mesh.vertices) {
      //   expect(Math.abs(v.position[2])).toBeLessThan(1e-8);
      // }
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// SdSubDTorus
// ─────────────────────────────────────────────────────────────────────────────

describe("SdSubDTorus — SubD torus primitive", () => {
  test.skip(
    "blocked: requires kern_subd_torus in kern.wasm — vertex count = uSides*vSides; positions match torus parametric formula",
    () => {
      // When unblocked:
      // const R=2.0, r=0.5, uSides=10, vSides=8;
      // const result = kern_subd_torus(R, r, uSides, vSides, 0, 0, 0);
      // const mesh = JSON.parse(result) as SubDMesh;
      // oracle: closed-form torus
      // expect(mesh.vertices.length).toBe(uSides * vSides);
      // expect(mesh.faces.length).toBe(uSides * vSides);
      // Spot-check vertex[0] position:
      // const u=0, v=0;
      // const expectedX = (R + r * Math.cos(v)) * Math.cos(u); // = R + r
      // const expectedY = (R + r * Math.cos(v)) * Math.sin(u); // = 0
      // const expectedZ = r * Math.sin(v);                     // = 0
      // expect(mesh.vertices[0].position[0]).toBeCloseTo(expectedX, 4);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// SdSubDCreaseSet
// ─────────────────────────────────────────────────────────────────────────────

describe("SdSubDCreaseSet — set edge crease weights", () => {
  test.skip(
    "blocked: requires kern_subd_crease_set + Catmull-Clark evaluator — after crease weight=2 on a box edge, subdivided edge midpoint lies on original straight line",
    () => {
      // When unblocked:
      // const boxJson = kern_subd_box(2, 2, 2, 0, 0, 0);
      // const creased = kern_subd_crease_set(boxJson, [0], 2.0); // crease edge 0
      // const subdivided = kern_subd_subdivide_global(creased, 3);
      // oracle: the subdivided edge midpoint lies on the straight line between v0 and v1 of edge 0
      // const mesh = JSON.parse(subdivided) as SubDMesh;
      // const origMesh = JSON.parse(boxJson) as SubDMesh;
      // const edge0 = origMesh.edges[0];
      // const v0 = origMesh.vertices[edge0.v0].position;
      // const v1 = origMesh.vertices[edge0.v1].position;
      // Find nearest vertex in subdivided mesh to midpoint
      // const midpoint = [(v0[0]+v1[0])/2, (v0[1]+v1[1])/2, (v0[2]+v1[2])/2];
      // const nearest = findNearestVertex(mesh.vertices, midpoint);
      // expect(nearest.dist).toBeLessThan(1e-3); // on the crease line
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// SdSubDCreaseRemove
// ─────────────────────────────────────────────────────────────────────────────

describe("SdSubDCreaseRemove — remove edge crease weights", () => {
  test.skip(
    "blocked: requires SubDMesh type — after removing crease, edge weight resets to 0",
    () => {
      // When unblocked:
      // const boxJson = kern_subd_box(2, 2, 2, 0, 0, 0);
      // const creased = kern_subd_crease_set(boxJson, [0, 1, 2], 2.0);
      // const uncreased = kern_subd_crease_remove(creased, [0, 1, 2]);
      // const mesh = JSON.parse(uncreased) as SubDMesh;
      // expect(mesh.edges[0].creaseWeight ?? 0).toBe(0);
      // expect(mesh.edges[1].creaseWeight ?? 0).toBe(0);
      // expect(mesh.edges[2].creaseWeight ?? 0).toBe(0);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// SdSubDToBrep
// ─────────────────────────────────────────────────────────────────────────────

describe("SdSubDToBrep — SubD limit surface to BRep", () => {
  test.skip(
    "blocked: requires kern_subd_to_brep in kern.wasm — sphere SubD → BRep is solid, no naked edges",
    () => {
      // When unblocked:
      // const subdJson = kern_subd_sphere(1.5, 0, 0, 0);
      // const brepJson = kern_subd_to_brep(subdJson, true, 1e-4);
      // const brep = JSON.parse(brepJson) as Brep;
      // oracle: BRep validity
      // expect(brepIsSolid(brep)).toBe(true);
      // expect(brepNakedEdgeCount(brep)).toBe(0);
    },
  );

  test.skip(
    "blocked: requires kern_subd_to_brep — box SubD → BRep surface points within 0.02 of Catmull-Clark limit surface (non-axis-aligned box, rotated 30deg)",
    () => {
      // When unblocked:
      // Build rotated box control net via transform, then ToBrep
      // const brepJson = kern_subd_to_brep(rotatedBoxJson, true, 1e-4);
      // const brep = JSON.parse(brepJson) as Brep;
      // oracle: closed-form: all BRep surface sample points within 0.02 of limit surface
      // const samples = sampleBrepSurfaces(brep, 10, 10);
      // const limitSurface = evaluateCatmullClarkLimit(rotatedBoxMesh, 4 levels);
      // for (const pt of samples) {
      //   const nearest = limitSurface.nearestPoint(pt);
      //   expect(nearest.distance).toBeLessThan(0.02);
      // }
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// SdSubDToNurbs
// ─────────────────────────────────────────────────────────────────────────────

describe("SdSubDToNurbs — SubD limit surface to NURBS patches", () => {
  test.skip(
    "blocked: requires kern_subd_to_nurbs in kern.wasm — per-patch NURBS eval matches Catmull-Clark limit surface eval within tolerance",
    () => {
      // When unblocked:
      // const subdJson = kern_subd_plane(4.0, 3.0, 4, 3, 0, 0, 0); // 12-face quad grid
      // const nurbsJson = kern_subd_to_nurbs(subdJson, 3, 0.001);
      // const patches = JSON.parse(nurbsJson) as NurbsSurface[];
      // oracle: verb-nurbs surface eval vs Catmull-Clark limit surface
      // for (const patch of patches) {
      //   const p = pointAtUV(patch, 0.5, 0.5);
      //   const limit = evaluateCatmullClarkAtParametric(subdMesh, patch.id, 0.5, 0.5);
      //   const dist = Math.sqrt((p.x-limit.x)**2 + (p.y-limit.y)**2 + (p.z-limit.z)**2);
      //   expect(dist).toBeLessThan(0.001);
      // }
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// SdSubDControlPointEdit
// ─────────────────────────────────────────────────────────────────────────────

describe("SdSubDControlPointEdit — move SubD control vertex", () => {
  test.skip(
    "blocked: requires SubDMesh type in scene — vertex[i].position equals supplied position (exact) after edit",
    () => {
      // When unblocked:
      // Create a SubD plane, then move vertex 0 to a non-axis-aligned position
      // const subdJson = kern_subd_plane(2.0, 2.0, 2, 2, 0, 0, 0);
      // const newPos: [number, number, number] = [1.23, -0.77, 2.15];
      // const editedJson = kern_subd_control_point_edit(subdJson, 0, newPos);
      // const mesh = JSON.parse(editedJson) as SubDMesh;
      // oracle: exact position match
      // expect(mesh.vertices[0].position[0]).toBeCloseTo(newPos[0], 9);
      // expect(mesh.vertices[0].position[1]).toBeCloseTo(newPos[1], 9);
      // expect(mesh.vertices[0].position[2]).toBeCloseTo(newPos[2], 9);
    },
  );

  test.skip(
    "blocked: requires SubDMesh type — delta move: final position = original + delta (non-zero delta on non-apex vertex)",
    () => {
      // When unblocked:
      // const subdJson = kern_subd_box(1.0, 1.0, 1.0, 0, 0, 0);
      // const mesh0 = JSON.parse(subdJson) as SubDMesh;
      // const orig = mesh0.vertices[3].position;
      // const delta: [number, number, number] = [0.5, -0.3, 1.1];
      // const editedJson = kern_subd_control_point_edit_delta(subdJson, 3, delta);
      // const mesh1 = JSON.parse(editedJson) as SubDMesh;
      // expect(mesh1.vertices[3].position[0]).toBeCloseTo(orig[0] + delta[0], 9);
      // expect(mesh1.vertices[3].position[1]).toBeCloseTo(orig[1] + delta[1], 9);
      // expect(mesh1.vertices[3].position[2]).toBeCloseTo(orig[2] + delta[2], 9);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Stub handler integration — verify NotYetImplemented shape
// ─────────────────────────────────────────────────────────────────────────────

describe("S332 stub handlers — NotYetImplemented error shape", () => {
  test("handle_SdSubDFromMesh returns NotYetImplemented with correct op name", async () => {
    const { handle_SdSubDFromMesh } = await import("../src/handlers/s332-impl");
    // @ts-expect-error -- viewer not needed for stub
    const result = handle_SdSubDFromMesh({}, null);
    expect(result.error).toBe("NotYetImplemented");
    expect(result.op).toBe("SdSubDFromMesh");
    expect(typeof result.detail).toBe("string");
    expect(result.detail.length).toBeGreaterThan(10);
  });

  test("handle_SdSubDBox returns NotYetImplemented", async () => {
    const { handle_SdSubDBox } = await import("../src/handlers/s332-impl");
    // @ts-expect-error -- viewer not needed for stub
    const result = handle_SdSubDBox({}, null);
    expect(result.error).toBe("NotYetImplemented");
    expect(result.op).toBe("SdSubDBox");
  });

  test("handle_SdSubDSphere returns NotYetImplemented", async () => {
    const { handle_SdSubDSphere } = await import("../src/handlers/s332-impl");
    // @ts-expect-error -- viewer not needed for stub
    const result = handle_SdSubDSphere({}, null);
    expect(result.error).toBe("NotYetImplemented");
    expect(result.op).toBe("SdSubDSphere");
  });

  test("handle_SdSubDCylinder returns NotYetImplemented", async () => {
    const { handle_SdSubDCylinder } = await import("../src/handlers/s332-impl");
    // @ts-expect-error -- viewer not needed for stub
    const result = handle_SdSubDCylinder({}, null);
    expect(result.error).toBe("NotYetImplemented");
    expect(result.op).toBe("SdSubDCylinder");
  });

  test("handle_SdSubDCone returns NotYetImplemented", async () => {
    const { handle_SdSubDCone } = await import("../src/handlers/s332-impl");
    // @ts-expect-error -- viewer not needed for stub
    const result = handle_SdSubDCone({}, null);
    expect(result.error).toBe("NotYetImplemented");
    expect(result.op).toBe("SdSubDCone");
  });

  test("handle_SdSubDPlane returns NotYetImplemented", async () => {
    const { handle_SdSubDPlane } = await import("../src/handlers/s332-impl");
    // @ts-expect-error -- viewer not needed for stub
    const result = handle_SdSubDPlane({}, null);
    expect(result.error).toBe("NotYetImplemented");
    expect(result.op).toBe("SdSubDPlane");
  });

  test("handle_SdSubDTorus returns NotYetImplemented", async () => {
    const { handle_SdSubDTorus } = await import("../src/handlers/s332-impl");
    // @ts-expect-error -- viewer not needed for stub
    const result = handle_SdSubDTorus({}, null);
    expect(result.error).toBe("NotYetImplemented");
    expect(result.op).toBe("SdSubDTorus");
  });

  test("handle_SdSubDCreaseSet returns NotYetImplemented", async () => {
    const { handle_SdSubDCreaseSet } = await import("../src/handlers/s332-impl");
    // @ts-expect-error -- viewer not needed for stub
    const result = handle_SdSubDCreaseSet({}, null);
    expect(result.error).toBe("NotYetImplemented");
    expect(result.op).toBe("SdSubDCreaseSet");
  });

  test("handle_SdSubDCreaseRemove returns NotYetImplemented", async () => {
    const { handle_SdSubDCreaseRemove } = await import("../src/handlers/s332-impl");
    // @ts-expect-error -- viewer not needed for stub
    const result = handle_SdSubDCreaseRemove({}, null);
    expect(result.error).toBe("NotYetImplemented");
    expect(result.op).toBe("SdSubDCreaseRemove");
  });

  test("handle_SdSubDToBrep returns NotYetImplemented", async () => {
    const { handle_SdSubDToBrep } = await import("../src/handlers/s332-impl");
    // @ts-expect-error -- viewer not needed for stub
    const result = handle_SdSubDToBrep({}, null);
    expect(result.error).toBe("NotYetImplemented");
    expect(result.op).toBe("SdSubDToBrep");
  });

  test("handle_SdSubDToNurbs returns NotYetImplemented", async () => {
    const { handle_SdSubDToNurbs } = await import("../src/handlers/s332-impl");
    // @ts-expect-error -- viewer not needed for stub
    const result = handle_SdSubDToNurbs({}, null);
    expect(result.error).toBe("NotYetImplemented");
    expect(result.op).toBe("SdSubDToNurbs");
  });

  test("handle_SdSubDControlPointEdit returns NotYetImplemented", async () => {
    const { handle_SdSubDControlPointEdit } = await import("../src/handlers/s332-impl");
    // @ts-expect-error -- viewer not needed for stub
    const result = handle_SdSubDControlPointEdit({}, null);
    expect(result.error).toBe("NotYetImplemented");
    expect(result.op).toBe("SdSubDControlPointEdit");
  });
});
