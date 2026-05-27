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
  for (const name of ["SdBox", "SdSphere", "SdCylinder", "SdCone", "SdExtrude"]) {
    unregisterHandler(name);
  }
});

describe("BRep canonical migration characterization", () => {
  test("SdSphere currently creates a mesh-backed object labeled as brep", () => {
    const { viewer, lastObject } = makeViewer();
    registerNurbsHandlers(viewer);

    const result = dispatchSync("SdSphere", { radius: 2 });
    expect(result.ok).toBe(true);

    const obj = lastObject();
    expect(obj).toBeInstanceOf(THREE.Mesh);
    const mesh = obj as THREE.Mesh;
    expect(mesh.geometry).toBeInstanceOf(THREE.BufferGeometry);
    expect(mesh.userData.kind).toBe("brep");
    expect(mesh.userData.creator).toBe("sphere");
    expect(mesh.userData.nurbsSurface).toBeUndefined();
    expect(mesh.userData.canonicalGeometryId).toBeUndefined();
  });

  test("SdBox currently creates a display mesh with a partial NURBS sidecar", () => {
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
    expect(canonical.kind).toBe("surface");
    expect(canonical.createdBy).toBe("SdBox");
    if (canonical.kind !== "surface") throw new Error("expected canonical surface");
    expect(canonical.surface).toBe(mesh.userData.nurbsSurface);
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
    expect(viewer).toContain("geometry?: { position: number[]; normal?: number[]; index?: number[] }");
    expect(viewer).toContain("const geo = mesh.geometry as THREE.BufferGeometry");
    expect(viewer).toContain("const geo = new THREE.BufferGeometry()");
    expect(viewer).toContain("_deserializeSceneObj");
  });

  test("IFC export currently gathers mesh vertices and indices from the scene", () => {
    const domEvents = source("dom-events.ts");

    expect(domEvents).toContain("function sceneElementsForExport(): IfcSceneElement[]");
    expect(domEvents).toContain("const g = mesh.geometry as THREE.BufferGeometry");
    expect(domEvents).toContain("const pos = g.attributes.position?.array as Float32Array | undefined");
    expect(domEvents).toContain("mesh: { vertices: new Float32Array(verts), indices: new Uint32Array(idx) }");
  });

  test("3DM export currently writes Rhino mesh objects, not BRep/NURBS objects", () => {
    const exporters = source("io/exporters.ts");

    expect(exporters).toContain("export async function export3dm(object: THREE.Object3D): Promise<Uint8Array>");
    expect(exporters).toContain("object.traverse((child) =>");
    expect(exporters).toContain("const geom = mesh.geometry as THREE.BufferGeometry");
    expect(exporters).toContain("const rhinoMesh: any = new rh.Mesh()");
    expect(exporters).toContain("file.objects().add(rhinoMesh)");
  });
});
