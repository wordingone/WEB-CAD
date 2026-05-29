import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  CANONICAL_GEOMETRY_USERDATA_KEY,
  createCanonicalGeometryStore,
} from "../src/geometry/canonical-geometry";
import { initRenderModes, setRenderMode } from "../src/viewer/render-modes";

describe("BRep-aware wireframe render mode", () => {
  function splitQuadScene(): { scene: THREE.Scene; mesh: THREE.Mesh } {
    const scene = new THREE.Scene();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
      0, 0, 0,
      1, 0, 0,
      1, 1, 0,
      0, 1, 0,
    ]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    scene.add(mesh);
    return { scene, mesh };
  }

  function splitQuadSceneWithCanonicalBrep(): {
    scene: THREE.Scene;
    mesh: THREE.Mesh;
    store: ReturnType<typeof createCanonicalGeometryStore>;
  } {
    const scene = new THREE.Scene();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
      0, 0, 0,
      1, 0, 0,
      1, 1, 0,
      0, 0, 0,
      1, 1, 0,
      0, 1, 0,
    ]), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
      0, 0, -1,
      0, 0, -1,
      0, 0, -1,
    ]), 3));
    geometry.setIndex([0, 1, 2, 3, 4, 5]);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    scene.add(mesh);

    const store = createCanonicalGeometryStore();
    const record = store.create({
      kind: "brep",
      source: "conversion",
      createdBy: "test",
      brep: {
        shells: [{
          faces: [],
          vertices: [],
          isClosed: false,
          edges: [
            { curve: { kind: "line", from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 }, domain: { min: 0, max: 1 } }, faceIndex1: 0, faceIndex2: null, tolerance: 1e-6 },
            { curve: { kind: "line", from: { x: 1, y: 0, z: 0 }, to: { x: 1, y: 1, z: 0 }, domain: { min: 0, max: 1 } }, faceIndex1: 0, faceIndex2: null, tolerance: 1e-6 },
            { curve: { kind: "line", from: { x: 1, y: 1, z: 0 }, to: { x: 0, y: 1, z: 0 }, domain: { min: 0, max: 1 } }, faceIndex1: 0, faceIndex2: null, tolerance: 1e-6 },
            { curve: { kind: "line", from: { x: 0, y: 1, z: 0 }, to: { x: 0, y: 0, z: 0 }, domain: { min: 0, max: 1 } }, faceIndex1: 0, faceIndex2: null, tolerance: 1e-6 },
          ],
        }],
      },
    });
    mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY] = record.id;
    return { scene, mesh, store };
  }

  test("wireframe overlay suppresses internal coplanar render-triangle diagonals", () => {
    const { scene, mesh } = splitQuadScene();

    initRenderModes({ getScene: () => scene } as never);
    setRenderMode("wireframe");

    const overlay = mesh.children.find((child) => child.userData.__render_mode_overlay__) as THREE.LineSegments | undefined;
    expect(overlay).toBeDefined();
    const pos = overlay!.geometry.getAttribute("position") as THREE.BufferAttribute;
    expect(pos.count / 2).toBe(4);
    expect((mesh.material as unknown as THREE.MeshBasicMaterial).wireframe).toBe(false);
  });

  test("technical overlay suppresses internal coplanar render-triangle diagonals", () => {
    const { scene, mesh } = splitQuadScene();

    initRenderModes({ getScene: () => scene } as never);
    setRenderMode("technical");

    const overlays = mesh.children.filter((child) => child.userData.__drafting_overlay__ === "overlay") as THREE.LineSegments[];
    expect(overlays).toHaveLength(2);
    for (const overlay of overlays) {
      const pos = overlay.geometry.getAttribute("position") as THREE.BufferAttribute;
      expect(pos.count / 2).toBe(4);
    }
  });

  test("wireframe overlay uses canonical BRep topology before display mesh tessellation", () => {
    const { scene, mesh, store } = splitQuadSceneWithCanonicalBrep();

    initRenderModes({
      getScene: () => scene,
      getCanonicalGeometryStore: () => store,
    } as never);
    setRenderMode("wireframe");

    const overlay = mesh.children.find((child) => child.userData.__render_mode_overlay__) as THREE.LineSegments | undefined;
    expect(overlay).toBeDefined();
    const pos = overlay!.geometry.getAttribute("position") as THREE.BufferAttribute;
    expect(pos.count / 2).toBe(4);
  });

  test("technical overlay uses canonical BRep topology before display mesh tessellation", () => {
    const { scene, mesh, store } = splitQuadSceneWithCanonicalBrep();

    initRenderModes({
      getScene: () => scene,
      getCanonicalGeometryStore: () => store,
    } as never);
    setRenderMode("technical");

    const overlays = mesh.children.filter((child) => child.userData.__drafting_overlay__ === "overlay") as THREE.LineSegments[];
    expect(overlays).toHaveLength(2);
    for (const overlay of overlays) {
      const pos = overlay.geometry.getAttribute("position") as THREE.BufferAttribute;
      expect(pos.count / 2).toBe(4);
    }
  });
});
