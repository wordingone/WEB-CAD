// curtain-wall-join-isolation.test.ts
// Regression for #146: curtain wall joinShells must NOT form CSG groups with each other.
// When two curtain walls are placed adjacent/overlapping, their invisible proxy joinShells
// previously triggered the join-groups CSG pipeline, producing a solid dark display mesh
// that blocked the visible mullion groups. Fix: isJoinShell guard in _isJoinable.

import { describe, test, expect } from "bun:test";
import * as THREE from "three";
import { onElementCommitted } from "../src/tools/join-groups";
import { buildCurtainWall, buildWall } from "../src/tools/structural";

function makeScene(): THREE.Scene {
  return new THREE.Scene();
}

// Returns the joinShell mesh from a curtain wall group.
function getJoinShell(group: THREE.Group): THREE.Mesh | undefined {
  return group.userData.joinableShell as THREE.Mesh | undefined;
}

// Count display meshes (isJoinDisplay) in the scene.
function countDisplayMeshes(scene: THREE.Scene): number {
  let n = 0;
  scene.traverse((obj) => {
    if (obj.userData?.isJoinDisplay) n++;
  });
  return n;
}

describe("curtain wall join isolation (#146)", () => {
  test("two overlapping curtain wall joinShells do not trigger CSG union", () => {
    const scene = makeScene();

    // Place two curtain walls at the same position (maximum overlap).
    const { mesh: groupA } = buildCurtainWall({ x: 0, y: 0 }, { x: 3, y: 0 });
    const { mesh: groupB } = buildCurtainWall({ x: 0, y: 0 }, { x: 3, y: 0 });

    const shellA = getJoinShell(groupA)!;
    const shellB = getJoinShell(groupB)!;
    expect(shellA).toBeDefined();
    expect(shellB).toBeDefined();

    scene.add(groupA);
    scene.add(shellA);
    onElementCommitted(shellA, scene);

    scene.add(groupB);
    scene.add(shellB);
    onElementCommitted(shellB, scene);

    // No CSG display mesh should have been added — joinShells are not joinable targets.
    expect(countDisplayMeshes(scene)).toBe(0);

    // Both joinShells stay invisible (their original state from buildCurtainWall).
    expect(shellA.visible).toBe(false);
    expect(shellB.visible).toBe(false);
  });

  test("curtain wall joinShell adjacent to normal-wall does not corrupt rendering", () => {
    const scene = makeScene();

    const { mesh: wall } = buildWall({ x: 0, y: 0 }, { x: 5, y: 0 });
    scene.add(wall);

    // Curtain wall endpoint at wall endpoint (5,0) → adjacent placement.
    const { mesh: group } = buildCurtainWall({ x: 5, y: 0 }, { x: 5, y: 3 });
    const shell = getJoinShell(group)!;
    scene.add(group);
    scene.add(shell);
    onElementCommitted(shell, scene);

    expect(countDisplayMeshes(scene)).toBe(0);
    expect(shell.visible).toBe(false);
    // Curtain wall children (mullions, glass) remain visible.
    let hasVisibleChild = false;
    group.traverse((obj) => { if (obj !== group && (obj as THREE.Mesh).visible !== false) hasVisibleChild = true; });
    expect(hasVisibleChild).toBe(true);
  });
});
