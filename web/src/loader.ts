// Multi-format CAD/3D file loader for the gemma-architect viewer.
//
// Two paths:
//   - Light formats (GLB / GLTF / OBJ / STL) parse on the main thread via the
//     three.js JSM loaders. They return a THREE.Object3D (Group / Mesh) ready
//     to drop into the viewer.
//   - Heavy formats (IFC, STEP) parse in the replicad worker (worker.ts) so
//     the main thread stays responsive. The worker returns flat vertex / index
//     buffers that we wrap in a single THREE.Mesh on receipt.
//
// On success we always emit a normalized payload:
//   { object: THREE.Object3D, bounds: Bounds, summary: string }
// where `summary` is what the status bar should display.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import type { Bounds } from "./viewer";
import type { IfcHierarchyElement } from "./ifc-types";
export type { IfcHierarchyElement };

export type LoadedScene = {
  object: THREE.Object3D;
  bounds: Bounds;
  summary: string;
  triangles: number;
  format: string;
  hierarchy?: IfcHierarchyElement[];
};

export type LoaderProgress = (msg: string) => void;

export function detectFormat(filename: string): string {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

// Three.js loader fallback material — neutral so per-format colors still show.
const DEFAULT_MAT = (): THREE.Material =>
  new THREE.MeshStandardMaterial({
    color: 0x7ad3a3,
    roughness: 0.55,
    metalness: 0.05,
    flatShading: false,
    side: THREE.DoubleSide,
  });

function computeBoundsFromObject(obj: THREE.Object3D): Bounds {
  const box = new THREE.Box3().setFromObject(obj);
  // Box3 returns ±Infinity for empty objects; keep the viewer's fitCamera
  // safe by collapsing to a unit box centered at origin.
  if (!isFinite(box.min.x) || !isFinite(box.max.x)) {
    return { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
  }
  return {
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
  };
}

function countTriangles(obj: THREE.Object3D): number {
  let n = 0;
  obj.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const g = (child as THREE.Mesh).geometry as THREE.BufferGeometry;
      if (g.index) n += g.index.count / 3;
      else if (g.attributes.position) n += g.attributes.position.count / 3;
    }
  });
  return Math.round(n);
}

// Apply a Y-up → Z-up rotation. Many formats (glTF, OBJ default, web-ifc)
// emit Y-up; the viewer is configured Z-up. Rotating the wrapping object
// keeps each format consistent with the on-screen grid + axes.
function applyYupToZup(obj: THREE.Object3D): void {
  // Rx(+90deg): (x, y, z) → (x, -z, y)
  // Maps +Y (Y-up) to +Z (Z-up). The opposite sign Rx(-90) inverts to -Z;
  // verified empirically 2026-05-02 with the labeled axis triad — Schultz
  // Residence loaded upside down (up along -Z) when this used -π/2.
  obj.rotateX(Math.PI / 2);
}

// --- glTF / GLB ---

async function loadGltf(buffer: ArrayBuffer, format: string): Promise<LoadedScene> {
  const loader = new GLTFLoader();
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    loader.parse(
      buffer,
      "",
      (g) => resolve(g as unknown as { scene: THREE.Group }),
      (err: unknown) => reject(err),
    );
  });
  const root = new THREE.Group();
  root.add(gltf.scene);
  applyYupToZup(root);
  // Force a default material if any mesh lacks one (rare, but happens with
  // bare-vertex GLBs). Don't override existing PBR materials.
  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh && !(child as THREE.Mesh).material) {
      (child as THREE.Mesh).material = DEFAULT_MAT();
    }
  });
  const bounds = computeBoundsFromObject(root);
  const tris = countTriangles(root);
  return {
    object: root,
    bounds,
    triangles: tris,
    format,
    summary: `${format.toUpperCase()} · ${tris.toLocaleString()} triangles`,
  };
}

// --- OBJ ---

async function loadObj(buffer: ArrayBuffer): Promise<LoadedScene> {
  const text = new TextDecoder().decode(buffer);
  const loader = new OBJLoader();
  const group = loader.parse(text);
  // OBJLoader emits LineSegments for `l` records and Mesh for `f`. We only
  // re-color meshes; line segments keep their default color.
  group.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      (child as THREE.Mesh).material = DEFAULT_MAT();
      // Compute normals if the OBJ omitted them — common for hand-written files.
      const g = (child as THREE.Mesh).geometry as THREE.BufferGeometry;
      if (!g.attributes.normal) g.computeVertexNormals();
    }
  });
  const root = new THREE.Group();
  root.add(group);
  applyYupToZup(root);
  const bounds = computeBoundsFromObject(root);
  const tris = countTriangles(root);
  return {
    object: root,
    bounds,
    triangles: tris,
    format: "obj",
    summary: `OBJ · ${tris.toLocaleString()} triangles`,
  };
}

// --- STL ---

async function loadStl(buffer: ArrayBuffer): Promise<LoadedScene> {
  const loader = new STLLoader();
  const geometry = loader.parse(buffer);
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, DEFAULT_MAT());
  const root = new THREE.Group();
  root.add(mesh);
  // STL has no convention; many CAD tools export Z-up already, but viewer
  // is also Z-up so leave orientation as-is. If the model lands on its side
  // user can orbit.
  const bounds = computeBoundsFromObject(root);
  const tris = countTriangles(root);
  return {
    object: root,
    bounds,
    triangles: tris,
    format: "stl",
    summary: `STL · ${tris.toLocaleString()} triangles`,
  };
}

// --- IFC (worker-backed) ---

export type IfcLoadResult = {
  vertices: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
  colors: Float32Array | null; // per-vertex r,g,b (0..1) — optional
  bounds: Bounds;
  schema: string;
  entityCount: number;
  hierarchy: IfcHierarchyElement[];
};

export async function buildIfcMesh(
  result: IfcLoadResult,
  filename: string,
): Promise<LoadedScene> {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.vertices, 3));
  if (result.normals.length > 0) {
    geometry.setAttribute("normal", new THREE.BufferAttribute(result.normals, 3));
  } else {
    geometry.setIndex(new THREE.BufferAttribute(result.indices, 1));
    geometry.computeVertexNormals();
  }
  geometry.setIndex(new THREE.BufferAttribute(result.indices, 1));
  let material: THREE.Material;
  if (result.colors && result.colors.length === result.vertices.length) {
    geometry.setAttribute("color", new THREE.BufferAttribute(result.colors, 3));
    material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.6,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
  } else {
    material = DEFAULT_MAT();
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = filename;
  const root = new THREE.Group();
  root.name = filename;
  root.add(mesh);
  // IFC spec is Z-up, but web-ifc emits geometry rotated to Y-up to match
  // three.js's internal convention (empirical: Schultz Residence loaded with
  // building-up axis along world Y, observed 2026-05-02 with the labeled
  // axis triad). Rotate Y-up → Z-up so the building stands upright in the
  // Z-up viewer/grid.
  applyYupToZup(root);
  const tris = result.indices.length / 3;
  // Recompute bounds AFTER rotation — worker-side bounds were Y-up; the
  // viewer's fitCamera needs Z-up bounds to frame correctly.
  const boundsZup = computeBoundsFromObject(root);
  return {
    object: root,
    bounds: boundsZup,
    triangles: tris,
    format: "ifc",
    summary: `${filename} · ${result.entityCount.toLocaleString()} entities · ${tris.toLocaleString()} triangles · ${result.schema}`,
    hierarchy: result.hierarchy,
  };
}

// --- STEP / IGES / BREP (worker-backed) ---

export type StepLoadResult = {
  vertices: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
  bounds: Bounds;
};

export async function buildStepMesh(
  result: StepLoadResult,
  filename: string,
  format: string,
): Promise<LoadedScene> {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.vertices, 3));
  if (result.normals.length > 0) {
    geometry.setAttribute("normal", new THREE.BufferAttribute(result.normals, 3));
  }
  geometry.setIndex(new THREE.BufferAttribute(result.indices, 1));
  if (result.normals.length === 0) geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, DEFAULT_MAT());
  const root = new THREE.Group();
  root.add(mesh);
  // OCCT returns Z-up natively (CAD convention). No rotation needed.
  const tris = result.indices.length / 3;
  return {
    object: root,
    bounds: result.bounds,
    triangles: tris,
    format,
    summary: `${filename} · ${tris.toLocaleString()} triangles · ${format.toUpperCase()}`,
  };
}

// --- Format dispatcher (main-thread formats only) ---

export async function loadMainThreadFormat(
  buffer: ArrayBuffer,
  format: string,
): Promise<LoadedScene> {
  switch (format) {
    case "glb":
    case "gltf":
      return loadGltf(buffer, format);
    case "obj":
      return loadObj(buffer);
    case "stl":
      return loadStl(buffer);
    default:
      throw new Error(`unsupported format: ${format}`);
  }
}

export const WORKER_FORMATS = new Set(["ifc", "step", "stp", "iges", "igs", "brep"]);
export const MAIN_THREAD_FORMATS = new Set(["glb", "gltf", "obj", "stl"]);
export const ALL_FORMATS = new Set<string>([...WORKER_FORMATS, ...MAIN_THREAD_FORMATS]);

export function isSupported(format: string): boolean {
  return ALL_FORMATS.has(format);
}
