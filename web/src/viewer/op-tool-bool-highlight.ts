// op-tool-bool-highlight.ts — material highlight/restore helpers for boolean object selection.
// Pure functions; no dependency on op-tool.ts module state.

import * as THREE from "three";

// Clones a mesh's material before setting emissive highlight so shared materials
// (e.g. IFC walls sharing one MeshStandardMaterial) are not globally tinted.
export function applyBoolHighlight(obj: THREE.Object3D, hex: number): void {
  // Line objects (curves, polylines, circles as sketches) use LineBasicMaterial.color
  if (obj instanceof THREE.Line) {
    const lm = obj.material as THREE.LineBasicMaterial;
    obj.userData._savedLineColor = lm.color.getHex();
    lm.color.setHex(hex);
    return;
  }
  // For Groups (e.g. wall with void cuts), apply highlight to first Mesh child.
  if (obj instanceof THREE.Group) {
    obj.traverse((child) => {
      if (child instanceof THREE.Mesh && !(child.userData._boolHighlightDone as boolean)) {
        child.userData._boolHighlightDone = true;
        applyBoolHighlight(child, hex);
      }
    });
    obj.userData._boolGroupHighlighted = true;
    return;
  }
  const m = obj as THREE.Mesh;
  const mats = Array.isArray(m.material) ? m.material : (m.material ? [m.material] : []);
  const idx = mats.findIndex((mt) => !!(mt as THREE.MeshStandardMaterial).emissive);
  if (idx < 0) return;
  const orig = mats[idx] as THREE.MeshStandardMaterial;
  const cloned = orig.clone();
  cloned.emissive.setHex(hex);
  cloned.emissiveIntensity = 2.5;
  if (Array.isArray(m.material)) {
    const next = [...m.material]; next[idx] = cloned; m.material = next;
  } else {
    m.material = cloned;
  }
  m.userData._savedEmissive = orig.emissive.getHex();
  m.userData._savedMaterial = orig;
  delete m.userData._boolHighlightDone;
}

export function restoreBoolHighlight(obj: THREE.Object3D): void {
  // Restore Line objects
  if (obj instanceof THREE.Line) {
    if (obj.userData._savedLineColor !== undefined) {
      (obj.material as THREE.LineBasicMaterial).color.setHex(obj.userData._savedLineColor as number);
      delete obj.userData._savedLineColor;
    }
    return;
  }
  // Restore Group children
  if (obj instanceof THREE.Group) {
    if (obj.userData._boolGroupHighlighted) {
      obj.traverse((child) => {
        if (child instanceof THREE.Mesh) restoreBoolHighlight(child);
      });
      delete obj.userData._boolGroupHighlighted;
    }
    return;
  }
  const m = obj as THREE.Mesh;
  if (m.userData._savedEmissive === undefined) return;
  const orig = m.userData._savedMaterial as THREE.Material | undefined;
  if (orig) {
    if (Array.isArray(m.material)) {
      m.material = m.material.map((mt) =>
        (mt as THREE.MeshStandardMaterial).emissiveIntensity === 1 &&
        (mt as THREE.MeshStandardMaterial).emissive ? orig : mt,
      );
    } else {
      m.material = orig;
    }
    delete m.userData._savedMaterial;
  } else {
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const std = mats.find((mt): mt is THREE.MeshStandardMaterial => !!(mt as THREE.MeshStandardMaterial).emissive);
    if (std) std.emissive.setHex(m.userData._savedEmissive as number);
  }
  delete m.userData._savedEmissive;
}
