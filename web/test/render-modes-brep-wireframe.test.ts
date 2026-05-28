import { describe, expect, test } from "bun:test";
import * as THREE from "three";
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
});
