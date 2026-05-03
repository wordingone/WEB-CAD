// Three.js viewer for replicad meshes.
//
// Receives a flat-array mesh from the worker, builds a BufferGeometry,
// and frames the camera on the result. OrbitControls let the user
// orbit / pan / zoom. Grid + axes for spatial reference.
//
// T3 (selection) additions:
//   - Per-mesh helper graph: vertex sprites + edge tubes for raycast hits
//   - 7-topology raycaster: vertex / edge / face / mesh / brep / compound
//   - Selection-filter gating + Ctrl+Shift drill-down for sub-objects
//   - Selection outline material for the active selection

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  getSelected,
  setSelected,
  clearSelected,
  topologyAllowed,
  type Selection,
  type Topology,
} from "./selection-state";

export type MeshIn = {
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
};

export type Bounds = {
  min: [number, number, number];
  max: [number, number, number];
};

// Build a thin invisible cylinder along a line segment. Used as a raycast
// proxy for edges — Three.js LineSegments are unreliable to pick at typical
// architectural-zoom levels (the threshold is in screen-pixels, not world
// units, and tunes poorly across zoom).
function makeEdgeTube(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  radius: number,
  material: THREE.Material,
): THREE.Mesh {
  const start = new THREE.Vector3(ax, ay, az);
  const end = new THREE.Vector3(bx, by, bz);
  const dir = new THREE.Vector3().subVectors(end, start);
  const length = dir.length();
  if (length === 0) {
    // Degenerate segment — return a tiny no-op mesh that won't intersect.
    const g = new THREE.BufferGeometry();
    return new THREE.Mesh(g, material);
  }
  const geom = new THREE.CylinderGeometry(radius, radius, length, 6, 1, true);
  // CylinderGeometry's axis is +Y; align it with `dir`.
  geom.translate(0, length / 2, 0);
  const mid = start;
  const mesh = new THREE.Mesh(geom, material);
  mesh.position.copy(mid);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.clone().normalize(),
  );
  return mesh;
}

// Helper graph attached to each picking-eligible mesh. Built once on mesh
// load (or per-source-object on file load). Re-used for raycaster picking
// without per-frame cost.
type SelectionHelper = {
  // Owning Mesh that the helpers were derived from.
  owner: THREE.Mesh;
  // The "kind" of the owner — drives whether ctrl+shift drilldown returns a
  // brep face vs a mesh face. brep: replicad-emitted (has provenance).
  ownerKind: "brep" | "compound" | "mesh";
  // Vertex sprite group — THREE.Points where each point is one mesh corner.
  // Hidden by default; rendered only while Points filter is on AND the
  // viewport is in select mode.
  vertices: THREE.Points;
  // Per-edge tube colliders, invisible. These are the actual raycast targets
  // for edges (LineSegments are not reliably hittable at typical zooms).
  // Each tube's userData carries its segmentIndex.
  edgeTubes: THREE.Group;
  // Visible edge overlay (the existing EdgesGeometry → LineSegments).
  edgeLines: THREE.LineSegments;
};

export class Viewer {
  private canvas: HTMLCanvasElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  public controls: OrbitControls;
  private currentMesh: THREE.Mesh | null = null;
  private currentEdges: THREE.LineSegments | null = null;
  private currentObject: THREE.Object3D | null = null;
  private grid: THREE.GridHelper;
  private axes: THREE.AxesHelper;
  private axisLabels: THREE.Sprite[] = [];
  private currentBounds: Bounds | null = null;

  // Selection raycaster + helper graphs. Built lazily from setMesh / setObject.
  private raycaster: THREE.Raycaster;
  private helpers: SelectionHelper[] = [];
  private selectionOutline: THREE.LineSegments | null = null;
  private selectionVertexMarker: THREE.Points | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    // Transparent clear — bundle's .viewport-area::before (vellum paper)
    // shows through. See styles.css line 288-293 (#171/#172/#173).
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    // No scene.background — let CSS paper layer through.

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
    // Grid colors tuned for the bundle's vellum paper background — major
    // lines at ink-soft, subdivisions at hairline-strong. (#173)
    this.grid = new THREE.GridHelper(20, 20, 0x6f6f78, 0xc8c2b4);
    this.grid.rotation.x = Math.PI / 2; // grid in XY plane (replicad uses Z-up).
    this.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(2);
    this.scene.add(this.axes);
    this.createAxisLabels();

    this.raycaster = new THREE.Raycaster();
    // Larger threshold for Points (vertex sprites) so corner picks are
    // forgiving at architectural-scale zoom levels.
    if (this.raycaster.params.Points) this.raycaster.params.Points.threshold = 0.15;
    if (this.raycaster.params.Line) this.raycaster.params.Line.threshold = 0.05;

    this.handleResize();
    window.addEventListener("resize", () => this.handleResize());

    // Click handler — wires viewport picks to selection state. Pre-empts
    // OrbitControls only when a real hit occurs; rotate/pan continues to work
    // through empty space.
    this.canvas.addEventListener("pointerdown", this.onPointerDown);

    this.animate();
  }

  // ---------- Selection (T3) ----------

  // Cursor-relative NDC for raycasting.
  private toNdc(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;
    return new THREE.Vector2(x, y);
  }

  private onPointerDown = (ev: PointerEvent): void => {
    // Left button only. Right/middle remain orbit/pan.
    if (ev.button !== 0) return;
    // Skip when a TransformControls gizmo is being interacted with — the
    // gizmo eats the event upstream via its own listeners.
    if ((this.controls as any).__suspended) return;
    const drilldown = ev.ctrlKey && ev.shiftKey;
    const ndc = this.toNdc(ev.clientX, ev.clientY);
    this.raycaster.setFromCamera(ndc, this.camera);
    const sel = this.pick(drilldown);
    if (sel) {
      setSelected(sel);
      this.applySelectionVisual(sel);
    } else {
      // Empty-space click — clear selection.
      clearSelected();
      this.applySelectionVisual(null);
    }
  };

  // Programmatic pick for tests + Ctrl+Shift behavior. Returns the topmost
  // selection that respects current filter state.
  pick(drilldown: boolean): Selection | null {
    // 1) Try vertex sprites first (closest to the camera in screen space).
    if (topologyAllowed("vertex")) {
      for (const h of this.helpers) {
        const intersects = this.raycaster.intersectObject(h.vertices, false);
        if (intersects.length > 0) {
          const hit = intersects[0];
          return {
            topology: "vertex",
            uuid: h.vertices.uuid,
            object: h.vertices,
            parent: h.owner,
            parentUuid: h.owner.uuid,
            vertexIndex: hit.index ?? 0,
            transformTarget: h.owner,
          };
        }
      }
    }

    // 2) Edge tubes.
    if (topologyAllowed("edge")) {
      for (const h of this.helpers) {
        const intersects = this.raycaster.intersectObjects(h.edgeTubes.children, false);
        if (intersects.length > 0) {
          const hit = intersects[0];
          const tube = hit.object as THREE.Mesh;
          const segIdx = (tube.userData?.segmentIndex as number) ?? 0;
          return {
            topology: "edge",
            uuid: tube.uuid,
            object: tube,
            parent: h.owner,
            parentUuid: h.owner.uuid,
            edgeIndex: segIdx,
            transformTarget: h.owner,
          };
        }
      }
    }

    // 3) Face / mesh / brep / compound — raycast against the owning meshes.
    const meshes = this.helpers.map((h) => h.owner);
    if (meshes.length === 0) return null;
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    const hit = hits[0];
    const helper = this.helpers.find((h) => h.owner === hit.object);
    if (!helper) return null;
    const owner = helper.owner;

    // Drilldown: ctrl+shift on a brep/compound returns the face sub-object.
    if (drilldown && (helper.ownerKind === "brep" || helper.ownerKind === "compound")) {
      if (topologyAllowed("face")) {
        return {
          topology: "face",
          uuid: owner.uuid,
          object: owner,
          parent: owner,
          parentUuid: owner.uuid,
          faceIndex: hit.faceIndex ?? 0,
          transformTarget: owner,
        };
      }
    }

    // Default: top-level brep / compound / mesh hit.
    let topology: Topology;
    if (helper.ownerKind === "brep") topology = "brep";
    else if (helper.ownerKind === "compound") topology = "compound";
    else topology = "mesh";

    if (!topologyAllowed(topology)) {
      // Filter for this topology is OFF — fall through to whatever sub-object
      // type is allowed. Per spec: a clicked brep with Polysurfaces=OFF should
      // hit the underlying face if Surfaces is on.
      if (topologyAllowed("face")) {
        return {
          topology: "face",
          uuid: owner.uuid,
          object: owner,
          parent: owner,
          parentUuid: owner.uuid,
          faceIndex: hit.faceIndex ?? 0,
          transformTarget: owner,
        };
      }
      if (topologyAllowed("mesh")) {
        return {
          topology: "mesh",
          uuid: owner.uuid,
          object: owner,
          transformTarget: owner,
        };
      }
      return null;
    }

    return {
      topology,
      uuid: owner.uuid,
      object: owner,
      transformTarget: owner,
    };
  }

  // Test/programmatic hook: simulate a click at canvas-space (px) coords.
  // Returns the resulting Selection (or null).
  pickAtCanvasCoord(x: number, y: number, opts?: { drilldown?: boolean }): Selection | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      (x / Math.max(1, rect.width)) * 2 - 1,
      -(y / Math.max(1, rect.height)) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const sel = this.pick(opts?.drilldown ?? false);
    if (sel) setSelected(sel);
    else clearSelected();
    this.applySelectionVisual(sel);
    return sel;
  }

  // Test hook: cast a world-space ray (origin + direction) directly. Bypasses
  // the camera projection, so tests don't have to find a canvas pixel that
  // happens to project onto a corner.
  pickRay(origin: THREE.Vector3, direction: THREE.Vector3, opts?: { drilldown?: boolean }): Selection | null {
    this.raycaster.set(origin, direction.clone().normalize());
    const sel = this.pick(opts?.drilldown ?? false);
    if (sel) setSelected(sel);
    else clearSelected();
    this.applySelectionVisual(sel);
    return sel;
  }

  getScene(): THREE.Scene { return this.scene; }
  getCamera(): THREE.Camera { return this.camera; }
  getCanvas(): HTMLCanvasElement { return this.canvas; }
  getHelpers(): SelectionHelper[] { return this.helpers; }
  getCurrentBounds(): Bounds | null { return this.currentBounds; }

  // Build helper graph for a single Mesh — vertex sprites + edge tubes.
  // Re-used for both setMesh (worker output) and walking setObject children.
  private buildHelpersForMesh(
    mesh: THREE.Mesh,
    kind: "brep" | "compound" | "mesh",
    diag: number,
  ): SelectionHelper {
    const g = mesh.geometry as THREE.BufferGeometry;
    const pos = g.attributes.position?.array as Float32Array | undefined;

    // 1) Vertex sprites — sample unique corner positions. We compute the
    // EdgesGeometry endpoints as the corner set (deduped) so a 1m box has
    // 8 vertex sprites, not the hundreds of mesh-tessellation vertices.
    const edgesGeom = new THREE.EdgesGeometry(g, 25);
    const edgePos = edgesGeom.attributes.position?.array as Float32Array | undefined;

    const vertexMap = new Map<string, [number, number, number]>();
    const segments: Array<[number, number, number, number, number, number]> = [];
    if (edgePos) {
      const round = (v: number) => Math.round(v * 1e4) / 1e4;
      for (let i = 0; i < edgePos.length; i += 6) {
        const ax = edgePos[i + 0], ay = edgePos[i + 1], az = edgePos[i + 2];
        const bx = edgePos[i + 3], by = edgePos[i + 4], bz = edgePos[i + 5];
        const ka = `${round(ax)},${round(ay)},${round(az)}`;
        const kb = `${round(bx)},${round(by)},${round(bz)}`;
        if (!vertexMap.has(ka)) vertexMap.set(ka, [ax, ay, az]);
        if (!vertexMap.has(kb)) vertexMap.set(kb, [bx, by, bz]);
        segments.push([ax, ay, az, bx, by, bz]);
      }
    } else if (pos) {
      // No edges info; fall back to the position array.
      for (let i = 0; i < pos.length; i += 3) {
        const k = `${pos[i]},${pos[i + 1]},${pos[i + 2]}`;
        if (!vertexMap.has(k)) vertexMap.set(k, [pos[i], pos[i + 1], pos[i + 2]]);
      }
    }

    const vertexPositions = new Float32Array(vertexMap.size * 3);
    let vi = 0;
    for (const [, p] of vertexMap) {
      vertexPositions[vi++] = p[0];
      vertexPositions[vi++] = p[1];
      vertexPositions[vi++] = p[2];
    }
    const vGeom = new THREE.BufferGeometry();
    vGeom.setAttribute("position", new THREE.BufferAttribute(vertexPositions, 3));

    // Sprite-style points texture so the markers read as discs, not pixels.
    const vMat = new THREE.PointsMaterial({
      color: 0xff8a5b,
      size: Math.max(0.03, diag * 0.012),
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.0, // hidden by default; revealed when filter is on + select mode
      depthTest: true,
      depthWrite: false,
    });
    const vertices = new THREE.Points(vGeom, vMat);
    vertices.userData.helperFor = mesh.uuid;
    this.scene.add(vertices);

    // 2) Edge tubes — invisible cylinders along each segment for reliable
    // raycasting. Cap count to avoid huge meshes for IFC scenes; degrade to
    // line-only for >2000 segments.
    const edgeTubes = new THREE.Group();
    edgeTubes.visible = false;
    const tubeRadius = Math.max(0.01, diag * 0.004);
    const tubeMat = new THREE.MeshBasicMaterial({ visible: false, transparent: true, opacity: 0 });
    const maxSegments = 2000;
    const tubeCount = Math.min(segments.length, maxSegments);
    for (let i = 0; i < tubeCount; i++) {
      const [ax, ay, az, bx, by, bz] = segments[i];
      const tube = makeEdgeTube(ax, ay, az, bx, by, bz, tubeRadius, tubeMat);
      tube.userData.segmentIndex = i;
      tube.userData.helperFor = mesh.uuid;
      edgeTubes.add(tube);
    }
    this.scene.add(edgeTubes);

    // 3) Visible edge overlay — same EdgesGeometry, LineSegments. Already
    // present in setMesh's existing path; for setObject we add it here.
    let edgeLines: THREE.LineSegments;
    const existing = this.currentEdges;
    if (existing && kind === "brep") {
      edgeLines = existing;
    } else {
      const edgeMat = new THREE.LineBasicMaterial({
        color: 0x0e0e10,
        linewidth: 1,
        opacity: 0.55,
        transparent: true,
      });
      edgeLines = new THREE.LineSegments(edgesGeom, edgeMat);
      this.scene.add(edgeLines);
    }

    return { owner: mesh, ownerKind: kind, vertices, edgeTubes, edgeLines };
  }

  private clearHelpers(): void {
    for (const h of this.helpers) {
      this.scene.remove(h.vertices);
      h.vertices.geometry.dispose();
      (h.vertices.material as THREE.Material).dispose();
      this.scene.remove(h.edgeTubes);
      h.edgeTubes.traverse((c) => {
        const m = c as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose();
        }
      });
      // edgeLines is owned by clearScene for the brep path; setObject path
      // adds its own and we remove it here.
      if (h.edgeLines !== this.currentEdges) {
        this.scene.remove(h.edgeLines);
        h.edgeLines.geometry.dispose();
        (h.edgeLines.material as THREE.Material).dispose();
      }
    }
    this.helpers = [];
    if (this.selectionOutline) {
      this.scene.remove(this.selectionOutline);
      this.selectionOutline.geometry.dispose();
      (this.selectionOutline.material as THREE.Material).dispose();
      this.selectionOutline = null;
    }
    if (this.selectionVertexMarker) {
      this.scene.remove(this.selectionVertexMarker);
      this.selectionVertexMarker.geometry.dispose();
      (this.selectionVertexMarker.material as THREE.Material).dispose();
      this.selectionVertexMarker = null;
    }
    clearSelected();
  }

  // Show/hide vertex sprites based on filter state. Called by main.ts when
  // the Points filter toggles. (Edge tubes stay invisible — they're raycast
  // proxies only.)
  setVertexHelpersVisible(on: boolean): void {
    for (const h of this.helpers) {
      const m = h.vertices.material as THREE.PointsMaterial;
      m.opacity = on ? 0.9 : 0;
      m.needsUpdate = true;
    }
  }

  private applySelectionVisual(sel: Selection | null): void {
    if (this.selectionOutline) {
      this.scene.remove(this.selectionOutline);
      this.selectionOutline.geometry.dispose();
      (this.selectionOutline.material as THREE.Material).dispose();
      this.selectionOutline = null;
    }
    if (this.selectionVertexMarker) {
      this.scene.remove(this.selectionVertexMarker);
      this.selectionVertexMarker.geometry.dispose();
      (this.selectionVertexMarker.material as THREE.Material).dispose();
      this.selectionVertexMarker = null;
    }
    if (!sel) return;

    if (sel.topology === "vertex" && sel.parent) {
      // Highlight the picked corner with a single point.
      const pts = sel.object as THREE.Points;
      const idx = sel.vertexIndex ?? 0;
      const arr = pts.geometry.attributes.position.array as Float32Array;
      const px = arr[idx * 3 + 0], py = arr[idx * 3 + 1], pz = arr[idx * 3 + 2];
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([px, py, pz]), 3));
      const mat = new THREE.PointsMaterial({
        color: 0xffae42,
        size: (pts.material as THREE.PointsMaterial).size * 1.6,
        sizeAttenuation: true,
        depthTest: false,
        depthWrite: false,
      });
      this.selectionVertexMarker = new THREE.Points(g, mat);
      this.selectionVertexMarker.renderOrder = 1000;
      this.scene.add(this.selectionVertexMarker);
      return;
    }

    // For mesh / brep / face / edge: an EdgesGeometry overlay rendered on top.
    const target = sel.parent ?? sel.object;
    if ((target as THREE.Mesh).isMesh) {
      const mesh = target as THREE.Mesh;
      const g = new THREE.EdgesGeometry(mesh.geometry, 25);
      const mat = new THREE.LineBasicMaterial({
        color: 0xffae42,
        linewidth: 2,
        depthTest: false,
        transparent: true,
        opacity: 0.95,
      });
      const ls = new THREE.LineSegments(g, mat);
      ls.position.copy(mesh.position);
      ls.quaternion.copy(mesh.quaternion);
      ls.scale.copy(mesh.scale);
      ls.renderOrder = 999;
      this.selectionOutline = ls;
      this.scene.add(ls);
    }
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
    // Drop helpers (vertex sprites + edge tubes + selection outline) first
    // so we don't try to dereference disposed geometry from the helper graph.
    this.clearHelpers();
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

  // Walk a Group / Mesh tree and remove a single mesh from the scene + the
  // helper map. Used by the Delete handler. Returns true if a mesh was
  // dropped. Doesn't update IFC entities — the caller does that side.
  removeObject(obj: THREE.Object3D): boolean {
    let dropped = false;
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        // Drop helper for this mesh.
        const idx = this.helpers.findIndex((h) => h.owner === mesh);
        if (idx >= 0) {
          const h = this.helpers[idx];
          this.scene.remove(h.vertices);
          h.vertices.geometry.dispose();
          (h.vertices.material as THREE.Material).dispose();
          this.scene.remove(h.edgeTubes);
          h.edgeTubes.traverse((c) => {
            const m = c as THREE.Mesh;
            if (m.isMesh) m.geometry?.dispose();
          });
          // Always remove edgeLines — ghost wireframe stays if skipped.
          // If edgeLines IS currentEdges, clear that reference too so
          // the next setMesh/setObject doesn't reuse a dead reference.
          this.scene.remove(h.edgeLines);
          h.edgeLines.geometry.dispose();
          (h.edgeLines.material as THREE.Material).dispose();
          if (h.edgeLines === this.currentEdges) this.currentEdges = null;
          this.helpers.splice(idx, 1);
        }
        mesh.geometry?.dispose();
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) (mat as THREE.Material).dispose();
        dropped = true;
      }
    });
    if (obj.parent) obj.parent.remove(obj);
    else this.scene.remove(obj);

    if (this.currentMesh === obj) this.currentMesh = null;
    if (this.currentObject === obj) this.currentObject = null;

    // Reset selection visual.
    this.applySelectionVisual(null);
    clearSelected();
    return dropped;
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
    m.userData.kind = "brep"; // worker output is replicad/OCC → brep
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

    // Helper graph for picking — vertex sprites + edge tubes.
    const dx = bounds.max[0] - bounds.min[0];
    const dy = bounds.max[1] - bounds.min[1];
    const dz = bounds.max[2] - bounds.min[2];
    const diag = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const helper = this.buildHelpersForMesh(m, "brep", diag);
    this.helpers.push(helper);

    this.fitCamera(bounds);
  }

  // Generalized entry-point for loaded files (THREE.Group / THREE.Mesh).
  setObject(object: THREE.Object3D, bounds: Bounds): void {
    this.clearScene();
    this.scene.add(object);
    this.currentObject = object;

    // Walk the tree and build helper graphs for every mesh found. IFC scenes
    // can have many meshes; cap the helper-building workload by only going
    // through meshes with reasonable triangle counts.
    const dx = bounds.max[0] - bounds.min[0];
    const dy = bounds.max[1] - bounds.min[1];
    const dz = bounds.max[2] - bounds.min[2];
    const diag = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));
    let helperCount = 0;
    const HELPER_BUDGET = 50; // cap to avoid 1000-mesh IFC files exploding
    object.traverse((child) => {
      if (helperCount >= HELPER_BUDGET) return;
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const k: "brep" | "compound" | "mesh" =
        (mesh.userData?.kind as any) || "mesh";
      try {
        const helper = this.buildHelpersForMesh(mesh, k, diag);
        this.helpers.push(helper);
        helperCount++;
      } catch (e) {
        // Helper-build failures shouldn't break loading; skip the mesh.
        console.warn("[viewer] helper build failed:", e);
      }
    });

    this.fitCamera(bounds);
  }

  // Add a single mesh to the existing scene without clearing — used by
  // create-mode to incrementally build geometry. Builds helper graph too.
  addMesh(mesh: THREE.Mesh, kind: "brep" | "compound" | "mesh" = "brep"): void {
    mesh.userData.kind = kind;
    this.scene.add(mesh);
    if (!this.currentObject) {
      // First create-mode object: promote it to currentObject so getActiveObject
      // returns it (and the export pipeline finds it).
      const wrapper = new THREE.Group();
      wrapper.name = "create-mode-root";
      this.scene.remove(mesh);
      wrapper.add(mesh);
      this.scene.add(wrapper);
      this.currentObject = wrapper;
    } else if ((this.currentObject as THREE.Group).isGroup || this.currentObject.children) {
      this.scene.remove(mesh);
      this.currentObject.add(mesh);
    }
    // Use scene bounds for diag — close enough for new meshes since fitCamera
    // hasn't been called yet on this mesh.
    const b = this.currentBounds ?? { min: [-5, -5, -5] as [number, number, number], max: [5, 5, 5] as [number, number, number] };
    const dx = b.max[0] - b.min[0];
    const dy = b.max[1] - b.min[1];
    const dz = b.max[2] - b.min[2];
    const diag = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const helper = this.buildHelpersForMesh(mesh, kind, diag);
    this.helpers.push(helper);
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
    this.currentBounds = bounds;
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cy = (bounds.min[1] + bounds.max[1]) / 2;
    const cz = (bounds.min[2] + bounds.max[2]) / 2;
    const dx = bounds.max[0] - bounds.min[0];
    const dy = bounds.max[1] - bounds.min[1];
    const dz = bounds.max[2] - bounds.min[2];
    const diag = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));

    // Pull back along a higher-tilt architectural-ish direction. Z=1.5 lifts
    // the camera enough that walls/slabs read as 3D rather than as a squashed
    // top-down silhouette. Framing fudge factor 1.15 fills most of the frame
    // with the object — fov 45 + aspect ~2.5 means dist=diag gives roughly a
    // tight fit; 1.15 leaves a small breathing margin without burying the
    // model under whitespace + grid.
    const dist = diag * 1.15;
    const dir = new THREE.Vector3(1, 1, 1.5).normalize();
    this.camera.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
    this.controls.target.set(cx, cy, cz);
    this.camera.updateProjectionMatrix();
    this.controls.update();

    // Re-scale grid so it always brackets the object — but not so far that the
    // grid dominates the viewport for large scenes (a 60m building with a 120m
    // grid + 1.7-distance camera makes the building look tiny). 1.3x leaves a
    // visible context margin without overpowering the model.
    const gridSize = Math.max(20, Math.ceil(Math.max(dx, dy) * 1.3));
    if ((this.grid as any).__lastSize !== gridSize) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid = new THREE.GridHelper(gridSize, gridSize, 0x444444, 0x2c2c34);
      this.grid.rotation.x = Math.PI / 2;
      (this.grid as any).__lastSize = gridSize;
      this.scene.add(this.grid);
    }

    // Re-scale axis triad + labels to match scene size.
    const triadLen = Math.max(2, Math.min(dx, dy, dz) * 0.5);
    this.scene.remove(this.axes);
    this.axes.dispose();
    this.axes = new THREE.AxesHelper(triadLen);
    this.scene.add(this.axes);
    this.createAxisLabels(triadLen);
  }

  // Sprite-based axis tip labels (X red, Y green, Z blue) — three.js AxesHelper
  // is unlabeled by default, leaving users guessing which colored line is which.
  private createAxisLabels(length = 2): void {
    for (const s of this.axisLabels) {
      this.scene.remove(s);
      s.material.map?.dispose();
      s.material.dispose();
    }
    this.axisLabels = [];
    const make = (text: string, color: string, pos: [number, number, number]): THREE.Sprite => {
      const c = document.createElement("canvas");
      c.width = 96; c.height = 96;
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, 96, 96);
      ctx.fillStyle = color;
      ctx.font = "700 64px 'Inter', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 48, 50);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true });
      const sprite = new THREE.Sprite(mat);
      sprite.position.set(pos[0], pos[1], pos[2]);
      const s = Math.max(0.4, length * 0.18);
      sprite.scale.set(s, s, 1);
      sprite.renderOrder = 999;
      return sprite;
    };
    const tip = length * 1.12;
    this.axisLabels = [
      make("X", "#ff5c5c", [tip, 0, 0]),
      make("Y", "#7ad36a", [0, tip, 0]),
      make("Z", "#5b8def", [0, 0, tip]),
    ];
    for (const s of this.axisLabels) this.scene.add(s);
  }

  // Frame the camera on a single child object (subset of full scene). Does not
  // touch the grid or axis-triad scaling — those still follow the full scene.
  // Used by the scene panel's "zoom to mesh" interaction.
  frameObjectOnly(obj: THREE.Object3D): void {
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty() || !isFinite(box.min.x) || !isFinite(box.max.x)) return;
    const cx = (box.min.x + box.max.x) / 2;
    const cy = (box.min.y + box.max.y) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    const dx = box.max.x - box.min.x;
    const dy = box.max.y - box.min.y;
    const dz = box.max.z - box.min.z;
    const diag = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const dist = diag * 1.7;
    const dir = new THREE.Vector3(1, 1, 1.5).normalize();
    this.camera.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
    this.controls.target.set(cx, cy, cz);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  // Snap camera to a named view, framed on current scene bounds.
  // Names match AutoCAD/Revit/Blender conventions in Z-up world.
  setView(name: "top" | "bottom" | "front" | "back" | "left" | "right" | "iso" | "extents"): void {
    const b = this.currentBounds ?? { min: [-5, -5, -5] as [number, number, number], max: [5, 5, 5] as [number, number, number] };
    const cx = (b.min[0] + b.max[0]) / 2;
    const cy = (b.min[1] + b.max[1]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    const dx = b.max[0] - b.min[0];
    const dy = b.max[1] - b.min[1];
    const dz = b.max[2] - b.min[2];
    const diag = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const dist = diag * 1.7;
    let dir: THREE.Vector3;
    switch (name) {
      case "top":     dir = new THREE.Vector3(0, 0, 1); break;
      case "bottom":  dir = new THREE.Vector3(0, 0, -1); break;
      case "front":   dir = new THREE.Vector3(0, -1, 0); break;
      case "back":    dir = new THREE.Vector3(0, 1, 0); break;
      case "right":   dir = new THREE.Vector3(1, 0, 0); break;
      case "left":    dir = new THREE.Vector3(-1, 0, 0); break;
      case "iso":     dir = new THREE.Vector3(1, 1, 1).normalize(); break;
      case "extents": dir = new THREE.Vector3(1, 1, 1.5).normalize(); break;
    }
    this.camera.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
    this.controls.target.set(cx, cy, cz);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }
}
