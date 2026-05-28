import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { dispatchSync, unregisterHandler } from "../src/commands/dispatch";
import { registerAnnotationHandlers } from "../src/handlers/annotations";

function makeAnnotationViewer() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  camera.position.set(4, 4, 4);
  camera.lookAt(0, 0, 0);
  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
  };
  const added: THREE.Object3D[] = [];
  return {
    scene,
    added,
    viewer: {
      getScene: () => scene,
      getCanvas: () => canvas,
      getActiveCamera: () => camera,
      addMesh: (obj: THREE.Object3D, kind?: string) => {
        if (kind) obj.userData.kind = kind;
        scene.add(obj);
        added.push(obj);
        return obj;
      },
    },
  };
}

beforeEach(() => {
  for (const name of ["SdAlignedDim", "SdAngularDim", "SdAreaDim", "SdVolumeDim", "SdLabel", "SdTransientMeasure"]) {
    unregisterHandler(name);
  }
  document.body.innerHTML = "";
});

describe("annotation and measurement palette command parity", () => {
  test("op-tool completion routes visible annotation tools through their Sd handlers", () => {
    const source = readFileSync(new URL("../src/viewer/op-tool.ts", import.meta.url), "utf8");

    expect(source).toContain('dispatchSync("SdAlignedDim"');
    expect(source).toContain('dispatchSync("SdAngularDim"');
    expect(source).toContain('dispatchSync("SdAreaDim"');
    expect(source).toContain('dispatchSync("SdVolumeDim"');
    expect(source).toContain('dispatchSync("SdLabel"');
    expect(source).toContain('dispatchSync("SdTransientMeasure"');
  });

  test("Sd annotation handlers create user-visible measurement geometry or labels", () => {
    const { scene, added, viewer } = makeAnnotationViewer();
    const solid = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4), new THREE.MeshBasicMaterial());
    scene.add(solid);
    registerAnnotationHandlers(viewer as never);

    expect(dispatchSync("SdAlignedDim", { a: [0, 0, 0], b: [3, 4, 0] }).ok).toBe(true);
    expect(dispatchSync("SdAngularDim", { vertex: [0, 0, 0], ray1: [1, 0, 0], ray2: [0, 1, 0] }).ok).toBe(true);
    expect(dispatchSync("SdAreaDim", { points: [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]] }).ok).toBe(true);
    expect(dispatchSync("SdVolumeDim", { id: solid.uuid }).ok).toBe(true);
    expect(dispatchSync("SdLabel", { text: "A", position: [0, 0, 0] }).ok).toBe(true);
    expect(dispatchSync("SdTransientMeasure", { a: [0, 0, 0], b: [1, 0, 0] }).ok).toBe(true);

    expect(added.length).toBeGreaterThanOrEqual(4);
    expect(document.body.textContent).toContain("A");
    expect(document.body.textContent).toContain("Area:");
    expect(document.body.textContent).toContain("Vol:");
  });
});
