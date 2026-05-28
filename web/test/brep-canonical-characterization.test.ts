import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { dispatchSync, unregisterHandler } from "../src/commands/dispatch";
import {
  CANONICAL_GEOMETRY_USERDATA_KEY,
  createCanonicalGeometryStore,
  type CanonicalGeometryStore,
} from "../src/geometry/canonical-geometry";
import { registerBrepOpHandlers } from "../src/handlers/brep-ops";
import { registerNurbsHandlers } from "../src/handlers/nurbs";
import { registerOpeningHandlers } from "../src/handlers/openings";
import { registerStructuralHandlers } from "../src/handlers/structural";
import { linkOpToolExtrudeCanonical } from "../src/viewer/op-tool-canonical";
import { domain as curveDomain } from "../src/nurbs/nurbs-curves";
import { pointAtUV } from "../src/nurbs/nurbs-surfaces";
import { WORLD_XY } from "../src/viewer/cplane";
import type { Viewer } from "../src/viewer/viewer";

function source(path: string): string {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
}

function makeViewer(): {
  viewer: Viewer;
  scene: THREE.Scene;
  store: CanonicalGeometryStore;
  lastObject: () => THREE.Object3D | null;
} {
  const scene = new THREE.Scene();
  const store = createCanonicalGeometryStore();
  let last: THREE.Object3D | null = null;
  const viewer = {
    activeView: "top",
    activeCPlane: WORLD_XY,
    getCanonicalGeometryStore() {
      return store;
    },
    addMesh(obj: THREE.Object3D, kind?: string) {
      if (kind) obj.userData.kind = kind;
      last = obj;
      scene.add(obj);
    },
    getScene() {
      return scene;
    },
    forEachSceneChild(cb: (obj: THREE.Object3D) => void) {
      for (const child of scene.children) cb(child);
    },
  } as unknown as Viewer;
  return { viewer, scene, store, lastObject: () => last };
}

beforeEach(() => {
  for (const name of [
    "SdBox", "SdSphere", "SdCylinder", "SdCone", "SdExtrude",
    "SdWall", "SdSlab", "SdColumn", "SdBeam", "SdSpace",
    "SdFoundation", "SdCeiling", "SdSkylight", "SdRailing",
    "SdMember", "SdPlate", "SdRamp", "SdCurtainWall",
    "SdStair", "SdRoof",
    "SdDoor", "SdWindow", "SdOpening",
    "SdJoin", "SdExplode",
  ]) {
    unregisterHandler(name);
  }
});

describe("BRep canonical migration characterization", () => {
  test("analytic primitive commands keep display meshes while linking canonical revolution surfaces", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerNurbsHandlers(viewer);

    for (const [verb, args, creator] of [
      ["SdSphere", { radius: 2 }, "sphere"],
      ["SdCylinder", { radius: 0.75, height: 3 }, "cylinder"],
      ["SdCone", { radius: 0.75, height: 3 }, "cone"],
    ] as const) {
      const result = dispatchSync(verb, args);
      expect(result.ok).toBe(true);

      const obj = lastObject();
      expect(obj).toBeInstanceOf(THREE.Mesh);
      const mesh = obj as THREE.Mesh;
      expect(mesh.geometry).toBeInstanceOf(THREE.BufferGeometry);
      expect(mesh.userData.kind).toBe("brep");
      expect(mesh.userData.creator).toBe(creator);
      expect(mesh.userData.nurbsSurface).toBeDefined();
      expect(mesh.userData.nurbsSurface.kind).toBe("rev");
      expect(mesh.userData.nurbsKind).toBe("surface");
      const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
      expect(typeof canonicalId).toBe("string");
      const canonical = store.require(canonicalId as string);
      expect(canonical.kind).toBe("surface");
      expect(canonical.createdBy).toBe(verb);
      if (canonical.kind !== "surface") throw new Error("expected canonical surface");
      expect(canonical.surface).toBe(mesh.userData.nurbsSurface);

      const surface = canonical.surface;
      if (surface.kind !== "rev") throw new Error("expected revolution surface");
      const profileDomain = curveDomain(surface.profile);
      if (verb === "SdSphere") {
        const p = pointAtUV(surface, profileDomain.max / 2, Math.PI / 2);
        expect(p.x).toBeCloseTo(0, 6);
        expect(p.y).toBeCloseTo(args.radius, 6);
        expect(p.z).toBeCloseTo(0, 6);
      } else if (verb === "SdCylinder") {
        const p0 = pointAtUV(surface, profileDomain.min, 0);
        const p1 = pointAtUV(surface, profileDomain.max, Math.PI / 2);
        expect(p0.x).toBeCloseTo(args.radius, 6);
        expect(p0.z).toBeCloseTo(-args.height / 2, 6);
        expect(p1.y).toBeCloseTo(args.radius, 6);
        expect(p1.z).toBeCloseTo(args.height / 2, 6);
      } else {
        const apex = pointAtUV(surface, profileDomain.max, Math.PI);
        expect(apex.x).toBeCloseTo(0, 6);
        expect(apex.y).toBeCloseTo(0, 6);
        expect(apex.z).toBeCloseTo(args.height / 2, 6);
      }
    }
  });

  test("SdBox keeps its display mesh while linking a canonical extruded BRep", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerNurbsHandlers(viewer);

    const result = dispatchSync("SdBox", { width: 2, depth: 3, height: 4 });
    expect(result.ok).toBe(true);

    const obj = lastObject();
    expect(obj).toBeInstanceOf(THREE.Mesh);
    const mesh = obj as THREE.Mesh;
    expect(mesh.geometry).toBeInstanceOf(THREE.BufferGeometry);
    expect(mesh.userData.kind).toBe("brep");
    expect(mesh.userData.creator).toBe("box");
    expect(mesh.userData.nurbsSurface).toBeDefined();
    expect(mesh.userData.nurbsKind).toBe("surface");
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.kind).toBe("brep");
    expect(canonical.createdBy).toBe("SdBox");
    if (canonical.kind !== "brep") throw new Error("expected canonical brep");
    expect(canonical.brep.shells).toHaveLength(1);
    expect(canonical.brep.shells[0].faces).toHaveLength(6);
    expect(canonical.brep.shells[0].isClosed).toBe(true);
  });

  test("SdExtrude links profile extrusion output to a canonical BRep", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerNurbsHandlers(viewer);

    const result = dispatchSync("SdExtrude", {
      profile: [[0, 0], [2, 0], [2, 1], [0, 1]],
      distance: 3,
    });
    expect(result.ok).toBe(true);

    const obj = lastObject();
    expect(obj).toBeInstanceOf(THREE.Mesh);
    const mesh = obj as THREE.Mesh;
    expect(mesh.geometry).toBeInstanceOf(THREE.BufferGeometry);
    expect(mesh.userData.kind).toBe("brep");
    expect(mesh.userData.creator).toBe("extrude");
    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.kind).toBe("brep");
    expect(canonical.createdBy).toBe("SdExtrude");
    if (canonical.kind !== "brep") throw new Error("expected canonical brep");
    expect(canonical.brep.shells).toHaveLength(1);
    expect(canonical.brep.shells[0].faces).toHaveLength(6);
    expect(canonical.brep.shells[0].isClosed).toBe(true);
  });

  test("simple structural commands keep sidecars while linking canonical extruded BReps", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerStructuralHandlers(viewer);

    for (const [verb, args] of [
      ["SdWall", { length: 4, height: 3 }],
      ["SdSlab", { width: 4, depth: 3, thickness: 0.2 }],
      ["SdColumn", { position: [1, 2, 0], height: 4 }],
    ] as const) {
      const result = dispatchSync(verb, args);
      expect(result.ok).toBe(true);
      const obj = lastObject();
      expect(obj).toBeInstanceOf(THREE.Mesh);
      expect(obj?.userData.nurbsSurface).toBeDefined();
      const canonicalId = obj?.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
      expect(typeof canonicalId).toBe("string");
      const canonical = store.require(canonicalId as string);
      expect(canonical.kind).toBe("brep");
      expect(canonical.createdBy).toBe(verb);
      if (canonical.kind !== "brep") throw new Error("expected canonical brep");
      expect(canonical.brep.shells).toHaveLength(1);
      expect(canonical.brep.shells[0].faces).toHaveLength(6);
      expect(canonical.brep.shells[0].isClosed).toBe(true);
    }
  });

  test("additional box-like structural commands link canonical extruded BReps", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerStructuralHandlers(viewer);

    for (const [verb, args] of [
      ["SdBeam", { start: [0, 0], end: [4, 0] }],
      ["SdSpace", { width: 4, depth: 3 }],
      ["SdFoundation", { width: 4, depth: 3 }],
      ["SdCeiling", { width: 4, depth: 3 }],
      ["SdSkylight", { width: 1.2, depth: 0.8 }],
      ["SdRailing", { start: [0, 0], end: [3, 0] }],
      ["SdMember", { length: 2, profile: [[0, 0], [1, 0], [1, 0.5], [0, 0.5]] }],
      ["SdPlate", { thickness: 0.1, profile: [[0, 0], [1, 0], [1, 1], [0, 1]] }],
    ] as const) {
      const result = dispatchSync(verb, args);
      expect(result.ok).toBe(true);
      const obj = lastObject();
      expect(obj).toBeInstanceOf(THREE.Mesh);
      const canonicalId = obj?.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
      expect(typeof canonicalId).toBe("string");
      const canonical = store.require(canonicalId as string);
      expect(canonical.kind).toBe("brep");
      expect(canonical.createdBy).toBe(verb);
      if (canonical.kind !== "brep") throw new Error("expected canonical brep");
      expect(canonical.brep.shells).toHaveLength(1);
      expect(canonical.brep.shells[0].faces).toHaveLength(6);
      expect(canonical.brep.shells[0].isClosed).toBe(true);
    }
  });

  test("SdRamp links its existing display solid to a canonical extruded BRep", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerStructuralHandlers(viewer);

    const result = dispatchSync("SdRamp", { start: [0, 0], end: [6, 0] });

    expect(result.ok).toBe(true);
    const obj = lastObject();
    expect(obj).toBeInstanceOf(THREE.Mesh);
    expect(obj?.userData.kind).toBe("brep");
    expect(obj?.userData.creator).toBe("ramp");
    const canonicalId = obj?.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.kind).toBe("brep");
    expect(canonical.createdBy).toBe("SdRamp");
    if (canonical.kind !== "brep") throw new Error("expected canonical brep");
    expect(canonical.metadata).toMatchObject({ creator: "ramp", levelId: "level/0" });
    expect(canonical.brep.shells).toHaveLength(1);
    expect(canonical.brep.shells[0].faces).toHaveLength(6);
    expect(canonical.brep.shells[0].isClosed).toBe(true);
    const zValues = canonical.brep.shells[0].vertices.map((vertex) => vertex.point.z).sort((a, b) => a - b);
    expect(zValues[0]).toBeCloseTo(0.175);
    expect(zValues[zValues.length - 1]).toBeCloseTo(0.325);
  });

  test("SdCurtainWall links visible group and join shell to one canonical envelope BRep", () => {
    const { viewer, scene, store } = makeViewer();
    registerStructuralHandlers(viewer);

    const result = dispatchSync("SdCurtainWall", { start: [0, 0], end: [6, 0] });

    expect(result.ok).toBe(true);
    const group = scene.children.find((obj) => obj.userData.creator === "curtainwall" && obj instanceof THREE.Group);
    expect(group).toBeInstanceOf(THREE.Group);
    const shell = scene.children.find((obj) => obj.userData.creator === "curtainwall" && obj.userData.isJoinShell);
    expect(shell).toBeInstanceOf(THREE.Mesh);
    expect(shell?.visible).toBe(false);

    const groupRecord = group ? store.resolveObject(group) : undefined;
    const shellRecord = shell ? store.resolveObject(shell) : undefined;
    expect(groupRecord?.kind).toBe("brep");
    expect(shellRecord).toBe(groupRecord);
    if (groupRecord?.kind !== "brep") throw new Error("expected canonical brep");
    expect(groupRecord.createdBy).toBe("SdCurtainWall");
    expect(groupRecord.metadata).toMatchObject({ creator: "curtainwall", levelId: "level/0" });
    expect(groupRecord.brep.shells).toHaveLength(1);
    expect(groupRecord.brep.shells[0].faces).toHaveLength(6);
    expect(groupRecord.brep.shells[0].isClosed).toBe(true);
  });

  test("compound structural commands link displayed subcomponents to canonical BReps", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerStructuralHandlers(viewer);

    for (const [verb, args, createdBy] of [
      ["SdStair", { start: [0, 0], end: [4, 3] }, "SdStairComponent"],
      ["SdRoof", { footprint: [[-2, -1.5], [2, 1.5]], roofType: "pitched" }, "SdRoofComponent"],
    ] as const) {
      const result = dispatchSync(verb, args);
      expect(result.ok).toBe(true);
      const obj = lastObject();
      expect(obj).toBeInstanceOf(THREE.Group);

      const linkedRecords = new Set<string>();
      obj?.traverse((child) => {
        const canonical = store.resolveObject(child);
        if (!canonical) return;
        expect(canonical.kind).toBe("brep");
        if (canonical.kind !== "brep") throw new Error(`expected canonical brep for ${verb} subcomponent`);
        expect(canonical.createdBy).toBe(createdBy);
        expect(canonical.metadata).toMatchObject({ derivation: "planarized-display-mesh" });
        expect(canonical.brep.shells[0].faces.length).toBeGreaterThan(0);
        linkedRecords.add(canonical.id);
      });
      expect(linkedRecords.size).toBeGreaterThan(0);
    }
  });

  test("opening commands link display objects to canonical BRep envelopes", () => {
    const { viewer, store, lastObject } = makeViewer();
    registerOpeningHandlers(viewer);

    for (const [verb, args] of [
      ["SdDoor", { position: [0, 0], doorType: "interior" }],
      ["SdWindow", { position: [2, 0], windowType: "eg" }],
      ["SdOpening", { position: [4, 0] }],
    ] as const) {
      const result = dispatchSync(verb, args);
      expect(result.ok).toBe(true);
      const obj = lastObject();
      expect(obj).toBeInstanceOf(THREE.Object3D);
      const canonicalId = obj?.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
      expect(typeof canonicalId).toBe("string");
      const canonical = store.require(canonicalId as string);
      expect(canonical.kind).toBe("brep");
      expect(canonical.createdBy).toBe(verb);
      if (canonical.kind !== "brep") throw new Error("expected canonical brep");
      expect(canonical.brep.shells).toHaveLength(1);
      expect(canonical.brep.shells[0].faces).toHaveLength(6);
      expect(canonical.brep.shells[0].isClosed).toBe(true);
    }
  });

  test("join and explode preserve canonical BRep edit results", () => {
    const { viewer, scene, store, lastObject } = makeViewer();
    registerNurbsHandlers(viewer);
    registerBrepOpHandlers(viewer);

    expect(dispatchSync("SdBox", { width: 1, depth: 1, height: 1 }).ok).toBe(true);
    const first = lastObject();
    expect(first).toBeInstanceOf(THREE.Mesh);
    expect(dispatchSync("SdBox", { width: 1, depth: 1, height: 1 }).ok).toBe(true);
    const second = lastObject();
    expect(second).toBeInstanceOf(THREE.Mesh);
    second?.position.set(2, 0, 0);
    second?.updateMatrixWorld(true);

    const joinResult = dispatchSync("SdJoin", { targets: [first?.uuid, second?.uuid] });
    expect(joinResult.ok).toBe(true);
    if (!joinResult.ok) throw new Error("expected join to succeed");
    const joined = scene.getObjectByProperty("uuid", (joinResult.result as { created: string }).created);
    expect(joined).toBeInstanceOf(THREE.Mesh);
    const joinedCanonicalId = joined?.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof joinedCanonicalId).toBe("string");
    const joinedCanonical = store.require(joinedCanonicalId as string);
    expect(joinedCanonical.kind).toBe("brep");
    expect(joinedCanonical.createdBy).toBe("SdJoin");
    if (joinedCanonical.kind !== "brep") throw new Error("expected joined canonical brep");
    expect(joinedCanonical.brep.shells).toHaveLength(2);

    const explodeResult = dispatchSync("SdExplode", { target: joined?.uuid });
    expect(explodeResult.ok).toBe(true);
    if (!explodeResult.ok) throw new Error("expected explode to succeed");
    const explodedIds = (explodeResult.result as { exploded: string[] }).exploded;
    expect(explodedIds.length).toBeGreaterThan(0);
    const exploded = scene.getObjectByProperty("uuid", explodedIds[0]);
    expect(exploded).toBeInstanceOf(THREE.Mesh);
    const explodedCanonicalId = exploded?.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof explodedCanonicalId).toBe("string");
    const explodedCanonical = store.require(explodedCanonicalId as string);
    expect(explodedCanonical.kind).toBe("brep");
    expect(explodedCanonical.createdBy).toBe("SdExplode");
    if (explodedCanonical.kind !== "brep") throw new Error("expected exploded canonical brep");
    expect(explodedCanonical.brep.shells).toHaveLength(1);
    expect(explodedCanonical.brep.shells[0].faces).toHaveLength(1);
    expect(explodedCanonical.brep.shells[0].isClosed).toBe(false);
  });

  test("op-tool extrude meshes can link to canonical BReps from retained footprints", () => {
    const { viewer, store } = makeViewer();
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(2, 1, 3).translate(1, 0.5, 1.5),
      new THREE.MeshStandardMaterial(),
    );
    mesh.userData.kind = "brep";
    mesh.userData.creator = "extrude";
    mesh.userData.footprintPts = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 0, y: 1 },
    ];

    expect(linkOpToolExtrudeCanonical(viewer, mesh, 3)).toBe(true);

    const canonicalId = mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    expect(typeof canonicalId).toBe("string");
    const canonical = store.require(canonicalId as string);
    expect(canonical.kind).toBe("brep");
    expect(canonical.createdBy).toBe("SdExtrude");
    if (canonical.kind !== "brep") throw new Error("expected canonical brep");
    expect(canonical.brep.shells).toHaveLength(1);
    expect(canonical.brep.shells[0].faces).toHaveLength(6);
    expect(canonical.brep.shells[0].isClosed).toBe(true);
  });

  test("project save/open uses canonical WEB-CAD project snapshots with legacy import compatibility", () => {
    const shell = source("shell/shell.ts");

    expect(shell).toContain('PROJECT_FILE_EXTENSION = ".webcad"');
    expect(shell).toContain('PROJECT_FILE_FORMAT = "web-cad.canonical-project"');
    expect(shell).toContain("version: PROJECT_FILE_VERSION");
    expect(shell).toContain("canonicalGeometry: w.__viewer?.exportCanonicalGeometry?.() ?? []");
    expect(shell).toContain("__viewer?.exportScene?.()");
    expect(shell).toContain("w.__viewer?.importCanonicalGeometry?.(parsed.canonicalGeometry)");
    expect(shell).toContain("__viewer?.importScene?.(parsed.objects)");
    expect(shell).toContain('PROJECT_FILE_ACCEPT = ".webcad,.json,.gemarch"');
    expect(shell).toContain("picker.accept = PROJECT_FILE_ACCEPT");
    expect(shell).toContain("saveProjectFile");
  });

  test("viewer scene persistence uses canonical display source with mesh fallback serialization", () => {
    const viewer = source("viewer/viewer.ts");

    expect(viewer).toContain("exportScene(): SerializedSceneObj[]");
    expect(viewer).toContain("exportCanonicalGeometry(): CanonicalGeometry[]");
    expect(viewer).toContain("importCanonicalGeometry(records: unknown[]): number");
    expect(viewer).toContain("inspectCanonicalGeometry(): CanonicalGeometrySnapshot");
    expect(viewer).toContain("geometry?: { position: number[]; normal?: number[]; index?: number[] }");
    expect(viewer).toContain('displaySource?: "canonical" | "serialized-geometry"');
    expect(viewer).toContain('s.displaySource = "canonical"');
    expect(viewer).toContain("geometryFromCanonical(canonical)");
    expect(viewer).toContain("const geo = mesh.geometry as THREE.BufferGeometry");
    expect(viewer).toContain("const geo = new THREE.BufferGeometry()");
    expect(viewer).toContain("_deserializeSceneObj");
  });

  test("IFC export resolves canonical NURBS surfaces across scene hierarchies while retaining mesh fallback", () => {
    const domEvents = source("dom-events.ts");

    expect(domEvents).toContain("function sceneElementsForExport(): IfcSceneElement[]");
    expect(domEvents).toContain("canonicalSurfaces.push(...canonicalGeometryToIfcNurbsSurfaces(viewer.getCanonicalGeometryForObject(child), child.matrixWorld))");
    expect(domEvents).toContain("const g = mesh.geometry as THREE.BufferGeometry");
    expect(domEvents).toContain("const pos = g.attributes.position?.array as Float32Array | undefined");
    expect(domEvents).toContain("mesh: { vertices: new Float32Array(verts), indices: new Uint32Array(idx) }");
  });

  test("3DM export prefers canonical NURBS surfaces while retaining mesh fallback", () => {
    const exporters = source("io/exporters.ts");

    expect(exporters).toContain("export async function export3dm(object: THREE.Object3D, options: Export3dmOptions = {}): Promise<Uint8Array>");
    expect(exporters).toContain("canonicalGeometryToIfcNurbsSurfaces(canonical, mesh.matrixWorld)");
    expect(exporters).toContain("surfaceToIfcNurbs(sidecarSurface, mesh.matrixWorld)");
    expect(exporters).toContain("file.objects().addSurface(ns)");
    expect(exporters).toContain("object.traverse((child) =>");
    expect(exporters).toContain("const geom = mesh.geometry as THREE.BufferGeometry");
    expect(exporters).toContain("const rhinoMesh: any = new rh.Mesh()");
    expect(exporters).toContain("file.objects().add(rhinoMesh)");
  });

  test("live OBJ and STL export dispatch passes the canonical geometry resolver", () => {
    const domEvents = source("dom-events.ts");

    expect(domEvents).toContain("const buf = exportStl(stlSrc, {");
    expect(domEvents).toContain("const text = exportObj(obj, {");
    expect(domEvents).toContain("getCanonicalGeometryForObject: (target) => viewer.getCanonicalGeometryForObject(target)");
  });

  test("imported mesh objects are linked into canonical BRep records at scene entry", () => {
    const viewerScene = source("viewer/viewer-scene.ts");

    expect(viewerScene).toContain("linkPlanarizedMeshImportBrep(v.getCanonicalGeometryStore(), m, \"mesh-import\"");
    expect(viewerScene).toContain("linkPlanarizedMeshImportBrep(v.getCanonicalGeometryStore(), mesh, String(mesh.userData.creator)");
  });

  test("op-tool UI boolean path routes through canonical command handlers", () => {
    const opTool = source("viewer/op-tool.ts");

    expect(opTool).toContain('op === "union" ? "SdBooleanUnion"');
    expect(opTool).toContain(': op === "difference" ? "SdBooleanDifference"');
    expect(opTool).toContain(': "SdBooleanIntersection"');
    expect(opTool).toContain("const result = dispatchSync(verb, args)");
    expect(opTool).toContain("linkOpToolExtrudeCanonical(viewer, mesh, h2)");
    expect(opTool).toContain("linkOpToolExtrudeCanonical(viewer, extruded, 3.0)");
  });
});
