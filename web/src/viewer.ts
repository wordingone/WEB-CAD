// Three.js viewer for replicad meshes.
//
// Receives a flat-array mesh from the worker, builds a BufferGeometry,
// and frames the camera on the result. OrbitControls let the user
// orbit / pan / zoom. Grid + axes for spatial reference.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export type MeshIn = {
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
};

export type Bounds = {
  min: [number, number, number];
  max: [number, number, number];
};

export class Viewer {
  private canvas: HTMLCanvasElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private currentMesh: THREE.Mesh | null = null;
  private currentEdges: THREE.LineSegments | null = null;
  private currentObject: THREE.Object3D | null = null;
  private grid: THREE.GridHelper;
  private axes: THREE.AxesHelper;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x1a1a1f, 1);
    this.renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a1f);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    this.camera.position.set(8, 8, 8);
    this.camera.up.set(0, 0, 1); // Z-up to match replicad / IFC convention.

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;

    // Lights — keyfill + rim for shape readability without shadows.
    const ambient = new THREE.AmbientLight(0xffffff, 0.45);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(10, 10, 12);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x99ccff, 0.35);
    fill.position.set(-8, -6, 4);
    this.scene.add(fill);

    // Reference grid + axes. 20m × 20m grid, 1m subdivisions; matches the
    // architectural-scale demo prompts (3-15m primitives).
    this.grid = new THREE.GridHelper(20, 20, 0x444444, 0x2c2c34);
    this.grid.rotation.x = Math.PI / 2; // grid in XY plane (replicad uses Z-up).
    this.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(2);
    this.scene.add(this.axes);

    this.handleResize();
    window.addEventListener("resize", () => this.handleResize());

    this.animate();
  }

  private handleResize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private clearScene(): void {
    if (this.currentMesh) {
      this.scene.remove(this.currentMesh);
      this.currentMesh.geometry.dispose();
      (this.currentMesh.material as THREE.Material).dispose();
      this.currentMesh = null;
    }
    if (this.currentEdges) {
      this.scene.remove(this.currentEdges);
      this.currentEdges.geometry.dispose();
      (this.currentEdges.material as THREE.Material).dispose();
      this.currentEdges = null;
    }
    if (this.currentObject) {
      this.scene.remove(this.currentObject);
      this.currentObject.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          const mat = mesh.material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else if (mat) (mat as THREE.Material).dispose();
        }
      });
      this.currentObject = null;
    }
  }

  setMesh(mesh: MeshIn, bounds: Bounds): void {
    this.clearScene();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));

    const material = new THREE.MeshStandardMaterial({
      color: 0x7ad3a3,
      roughness: 0.55,
      metalness: 0.05,
      flatShading: false,
    });
    const m = new THREE.Mesh(geometry, material);
    this.scene.add(m);
    this.currentMesh = m;

    // Edge overlay for CAD readability.
    const edges = new THREE.EdgesGeometry(geometry, 25);
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x0e0e10,
      linewidth: 1,
      opacity: 0.6,
      transparent: true,
    });
    const edgeLines = new THREE.LineSegments(edges, edgeMat);
    this.scene.add(edgeLines);
    this.currentEdges = edgeLines;

    this.fitCamera(bounds);
  }

  // Generalized entry-point for loaded files (THREE.Group / THREE.Mesh).
  setObject(object: THREE.Object3D, bounds: Bounds): void {
    this.clearScene();
    this.scene.add(object);
    this.currentObject = object;
    this.fitCamera(bounds);
  }

  // Returns the active scene root (mesh OR object), suitable to feed three.js
  // exporters (OBJ / glTF / GLB / USDZ). Returns null if nothing is loaded.
  getActiveObject(): THREE.Object3D | null {
    if (this.currentMesh) return this.currentMesh;
    if (this.currentObject) return this.currentObject;
    return null;
  }

  // Get the active mesh data — used by the IFC export path so a loaded file
  // can be re-emitted as IFC4. Walks the live object graph, since either
  // setMesh (from worker) or setObject (from file) might be active.
  getActiveMeshData(): { vertices: Float32Array; indices: Uint32Array } | null {
    if (this.currentMesh) {
      const g = this.currentMesh.geometry;
      const pos = g.attributes.position?.array as Float32Array | undefined;
      const idx = g.index?.array;
      if (!pos || !idx) return null;
      return { vertices: new Float32Array(pos), indices: new Uint32Array(idx) };
    }
    if (this.currentObject) {
      // Walk meshes and concatenate. Apply each mesh's world transform so the
      // re-emitted IFC carries already-positioned geometry (since IFC pipeline
      // here only writes one IfcBuildingElementProxy with raw triangles).
      const verts: number[] = [];
      const idx: number[] = [];
      const tmp = new THREE.Vector3();
      const matWorld = new THREE.Matrix4();
      this.currentObject.updateMatrixWorld(true);
      this.currentObject.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const g = mesh.geometry as THREE.BufferGeometry;
        const pos = g.attributes.position?.array as Float32Array | undefined;
        if (!pos) return;
        matWorld.copy(mesh.matrixWorld);
        const baseIndex = verts.length / 3;
        for (let i = 0; i < pos.length; i += 3) {
          tmp.set(pos[i], pos[i + 1], pos[i + 2]);
          tmp.applyMatrix4(matWorld);
          verts.push(tmp.x, tmp.y, tmp.z);
        }
        const indexAttr = g.index;
        if (indexAttr) {
          const a = indexAttr.array;
          for (let i = 0; i < a.length; i++) idx.push(a[i] + baseIndex);
        } else {
          // Non-indexed: treat consecutive triples as triangles.
          const triCount = (pos.length / 3) | 0;
          for (let i = 0; i < triCount; i++) idx.push(baseIndex + i);
        }
      });
      if (verts.length === 0) return null;
      return {
        vertices: new Float32Array(verts),
        indices: new Uint32Array(idx),
      };
    }
    return null;
  }

  private fitCamera(bounds: Bounds): void {
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cy = (bounds.min[1] + bounds.max[1]) / 2;
    const cz = (bounds.min[2] + bounds.max[2]) / 2;
    const dx = bounds.max[0] - bounds.min[0];
    const dy = bounds.max[1] - bounds.min[1];
    const dz = bounds.max[2] - bounds.min[2];
    const diag = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));

    // Pull back along a higher-tilt architectural-ish direction. Z=1.5 lifts
    // the camera enough that walls/slabs read as 3D rather than as a squashed
    // top-down silhouette. Framing fudge factor 1.7 keeps the grid visible
    // around tall objects.
    const dist = diag * 1.7;
    const dir = new THREE.Vector3(1, 1, 1.5).normalize();
    this.camera.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
    this.controls.target.set(cx, cy, cz);
    this.camera.updateProjectionMatrix();
    this.controls.update();

    // Re-scale grid so it always brackets the object.
    const gridSize = Math.max(20, Math.ceil(Math.max(dx, dy) * 2));
    if ((this.grid as any).__lastSize !== gridSize) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid = new THREE.GridHelper(gridSize, gridSize, 0x444444, 0x2c2c34);
      this.grid.rotation.x = Math.PI / 2;
      (this.grid as any).__lastSize = gridSize;
      this.scene.add(this.grid);
    }
  }
}
