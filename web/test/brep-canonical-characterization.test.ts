import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { dispatchSync, unregisterHandler } from "../src/commands/dispatch";
import {
  CANONICAL_GEOMETRY_USERDATA_KEY,
  createCanonicalGeometryStore,
  type CanonicalGeometryStore,
} from "../src/geometry/canonical-geometry";
import { registerNurbsHandlers } from "../src/handlers/nurbs";
import { registerStructuralHandlers } from "../src/handlers/structural";
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
  } as unknown as Viewer;
  return { viewer, scene, store, lastObject: () => last };
}

beforeEach(() => {
  for (const name of ["SdBox", "SdSphere", "SdCylinder", "SdCone", "SdExtrude", "SdWall", "SdSlab", "SdColumn"]) {
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

  test("structural commands with NURBS sidecars link canonical surface records", () => {
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
      expect(canonical.kind).toBe("surface");
      expect(canonical.createdBy).toBe(verb);
      if (canonical.kind !== "surface") throw new Error("expected canonical surface");
      expect(canonical.surface).toBe(obj?.userData.nurbsSurface);
    }
  });

  test("project save/open is currently the deprecated gemarch scene snapshot path", () => {
    const shell = source("shell/shell.ts");

    expect(shell).toContain("version: 1");
    expect(shell).toContain("canonicalGeometry: w.__viewer?.exportCanonicalGeometry?.() ?? []");
    expect(shell).toContain("__viewer?.exportScene?.()");
    expect(shell).toContain("w.__viewer?.importCanonicalGeometry?.(parsed.canonicalGeometry)");
    expect(shell).toContain("__viewer?.importScene?.(parsed.objects)");
    expect(shell).toContain('picker.accept = ".gemarch,.json"');
    expect(shell).toContain('name.endsWith(".gemarch")');
  });

  test("viewer scene persistence currently serializes BufferGeometry payloads", () => {
    const viewer = source("viewer/viewer.ts");

    expect(viewer).toContain("exportScene(): SerializedSceneObj[]");
    expect(viewer).toContain("exportCanonicalGeometry(): CanonicalGeometry[]");
    expect(viewer).toContain("importCanonicalGeometry(records: unknown[]): number");
    expect(viewer).toContain("inspectCanonicalGeometry(): CanonicalGeometrySnapshot");
    expect(viewer).toContain("geometry?: { position: number[]; normal?: number[]; index?: number[] }");
    expect(viewer).toContain("const geo = mesh.geometry as THREE.BufferGeometry");
    expect(viewer).toContain("const geo = new THREE.BufferGeometry()");
    expect(viewer).toContain("_deserializeSceneObj");
  });

  test("IFC export currently gathers mesh vertices and indices from the scene", () => {
    const domEvents = source("dom-events.ts");

    expect(domEvents).toContain("function sceneElementsForExport(): IfcSceneElement[]");
    expect(domEvents).toContain("canonicalGeometryToIfcNurbs(viewer.getCanonicalGeometryForObject(obj), obj.matrixWorld)");
    expect(domEvents).toContain("const g = mesh.geometry as THREE.BufferGeometry");
    expect(domEvents).toContain("const pos = g.attributes.position?.array as Float32Array | undefined");
    expect(domEvents).toContain("mesh: { vertices: new Float32Array(verts), indices: new Uint32Array(idx) }");
  });

  test("3DM export prefers canonical NURBS surfaces while retaining mesh fallback", () => {
    const exporters = source("io/exporters.ts");

    expect(exporters).toContain("export async function export3dm(object: THREE.Object3D, options: Export3dmOptions = {}): Promise<Uint8Array>");
    expect(exporters).toContain("canonicalGeometryToIfcNurbs(canonical, mesh.matrixWorld)");
    expect(exporters).toContain("surfaceToIfcNurbs(sidecarSurface, mesh.matrixWorld)");
    expect(exporters).toContain("file.objects().addSurface(ns)");
    expect(exporters).toContain("object.traverse((child) =>");
    expect(exporters).toContain("const geom = mesh.geometry as THREE.BufferGeometry");
    expect(exporters).toContain("const rhinoMesh: any = new rh.Mesh()");
    expect(exporters).toContain("file.objects().add(rhinoMesh)");
  });
});
