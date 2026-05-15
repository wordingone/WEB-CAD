// cplane-gizmo.ts — CPlane visualization overlay (#361).
//
// Shows a grid + red xAxis + green yAxis at the active construction plane.
// Auto-shows on SdSetCPlane (non-XY planes); auto-hides on reset to world XY.
// User can toggle visibility independently via SdToggleCPlaneGizmo.

import * as THREE from "three";
import type { CPlane } from "./cplane.js";

const HALF = 5;
const DIVS = 10;
const UP = new THREE.Vector3(0, 0, 1);

export class CPlaneGizmo {
  readonly group: THREE.Group;
  private _visible = false;

  constructor() {
    this.group = new THREE.Group();
    this.group.userData.noSnap = true;
    this.group.visible = false;

    const grid = new THREE.GridHelper(HALF * 2, DIVS, 0x888888, 0xcccccc);
    grid.userData.noSnap = true;
    this.group.add(grid);

    const xGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(HALF, 0, 0),
    ]);
    const xLine = new THREE.Line(
      xGeo,
      new THREE.LineBasicMaterial({ color: 0xee2233, depthTest: false }),
    );
    xLine.renderOrder = 50;
    xLine.userData.noSnap = true;
    this.group.add(xLine);

    const yGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, HALF),
    ]);
    const yLine = new THREE.Line(
      yGeo,
      new THREE.LineBasicMaterial({ color: 0x22cc44, depthTest: false }),
    );
    yLine.renderOrder = 50;
    yLine.userData.noSnap = true;
    this.group.add(yLine);
  }

  update(cplane: CPlane): void {
    // Orient: local X = cplane.xAxis (red), local Y = cplane.normal (grid up), local Z = cplane.yAxis (green)
    const m = new THREE.Matrix4().makeBasis(cplane.xAxis, cplane.normal, cplane.yAxis);
    this.group.setRotationFromMatrix(m);
    this.group.position.copy(cplane.origin);

    // Auto-show for non-XY planes; XY would overlap the floor grid
    const isXY = cplane.normal.dot(UP) > 0.999;
    this._visible = !isXY;
    this.group.visible = this._visible;
  }

  toggle(): void {
    this._visible = !this._visible;
    this.group.visible = this._visible;
  }
}
