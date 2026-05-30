import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { buildSkillsTabBody, renderParameters } from "../src/shell/workbench-skill-graph";

describe("workbench skill graph parameters", () => {
  test("resolves selected scene objects by uuid without relying on getObjectByUuid", () => {
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    mesh.userData.creator = "SdBox";
    mesh.userData.dispatchVerb = "SdBox";
    mesh.userData.dispatchArgs = { width: 1, depth: 2, height: 3 };
    scene.add(mesh);

    (window as unknown as {
      __viewer?: { getScene(): THREE.Scene; removeObject(o: THREE.Object3D): boolean };
    }).__viewer = {
      getScene: () => scene,
      removeObject: (obj) => {
        scene.remove(obj);
        return true;
      },
    };

    const body = buildSkillsTabBody();
    document.body.appendChild(body);

    expect(() => renderParameters(mesh.uuid)).not.toThrow();
    expect(body.textContent).toContain("SdBox");
    expect(body.textContent).toContain("width");

    body.remove();
    delete (window as unknown as { __viewer?: unknown }).__viewer;
  });
});
