// Scene-understanding panel.
//
// Shows the loaded scene's mesh tree with per-mesh visibility toggles and
// click-to-zoom. Walked once per load; re-renders on interaction only — no
// per-frame redraw. Intentionally agnostic to source format: whatever
// LoadedScene the loader hands back, we walk it as a THREE.Object3D graph.

import * as THREE from "three";
import type { Viewer } from "./viewer";

export type SceneSummary = {
  format: string;
  triangles: number;
  filename?: string;
  schema?: string;       // IFC schema id, e.g. "IFC4"
  entityCount?: number;  // IFC entity count from the loader summary
};

type MeshNode = {
  id: string;
  name: string;
  mesh: THREE.Mesh;
  triangles: number;
  color: string;
  depth: number;
};

export class ScenePanel {
  private root: HTMLElement;
  private viewer: Viewer;
  private nodes: MeshNode[] = [];
  private collapsed = false;

  constructor(root: HTMLElement, viewer: Viewer) {
    this.root = root;
    this.viewer = viewer;
    this.renderEmpty();
  }

  clear(): void {
    this.nodes = [];
    this.renderEmpty();
  }

  update(summary: SceneSummary): void {
    const obj = this.viewer.getActiveObject();
    if (!obj) {
      this.clear();
      return;
    }
    this.nodes = this.walkNodes(obj);
    this.render(summary);
  }

  toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.root.classList.toggle("collapsed", this.collapsed);
  }

  private walkNodes(root: THREE.Object3D): MeshNode[] {
    const out: MeshNode[] = [];
    let i = 0;
    root.traverse((child) => {
      const m = child as THREE.Mesh;
      if (!m.isMesh) return;
      const g = m.geometry as THREE.BufferGeometry | undefined;
      let tris = 0;
      if (g) {
        if (g.index) tris = Math.round(g.index.count / 3);
        else if (g.attributes.position) tris = Math.round(g.attributes.position.count / 3);
      }
      let color = "#7ad3a3";
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      const matCol = mat && (mat as THREE.MeshStandardMaterial).color;
      if (matCol) color = "#" + matCol.getHexString();
      i++;
      out.push({
        id: `m-${i}`,
        name: m.name || `Mesh ${i}`,
        mesh: m,
        triangles: tris,
        color,
        depth: this.depthOf(m, root),
      });
    });
    return out;
  }

  private depthOf(node: THREE.Object3D, root: THREE.Object3D): number {
    let d = 0;
    let cur: THREE.Object3D | null = node;
    while (cur && cur !== root) {
      d++;
      cur = cur.parent;
    }
    return Math.min(d, 4); // clamp visual indent so deep IFC graphs don't blow out
  }

  private renderEmpty(): void {
    this.root.innerHTML = `
      <div class="sp-header">
        <h3>Scene</h3>
        <button class="sp-collapse" type="button" aria-label="Collapse scene panel">&#9776;</button>
      </div>
      <div class="sp-empty">No scene loaded.</div>
    `;
    this.wireCollapse();
  }

  private render(summary: SceneSummary): void {
    const totalTris = this.nodes.reduce((s, n) => s + n.triangles, 0);
    const fmtStr = summary.format.toUpperCase();
    const filenameStr = summary.filename ? ` &middot; ${escapeHtml(summary.filename)}` : "";
    const entityStr = summary.entityCount != null
      ? ` &middot; ${summary.entityCount.toLocaleString()} entit${summary.entityCount === 1 ? "y" : "ies"}`
      : "";
    const schemaStr = summary.schema ? ` &middot; ${escapeHtml(summary.schema)}` : "";
    const meshLabel = `${this.nodes.length} mesh${this.nodes.length === 1 ? "" : "es"}`;
    const triLabel = `${totalTris.toLocaleString()} tri`;

    let listHtml = "";
    if (this.nodes.length === 0) {
      listHtml = `<div class="sp-empty">No meshes in this scene.</div>`;
    } else {
      listHtml = `<div class="sp-list">`;
      for (const n of this.nodes) {
        listHtml += `<div class="sp-row" data-id="${n.id}" style="--depth:${n.depth}">
          <button class="sp-vis" data-id="${n.id}" data-action="toggle" title="Toggle visibility" type="button" aria-label="Toggle visibility for ${escapeHtml(n.name)}">&#9679;</button>
          <span class="sp-swatch" style="background:${n.color}" aria-hidden="true"></span>
          <button class="sp-name" data-id="${n.id}" data-action="zoom" title="Click to zoom" type="button">${escapeHtml(n.name)}</button>
          <span class="sp-tris">${n.triangles.toLocaleString()}</span>
        </div>`;
      }
      listHtml += `</div>`;
    }

    this.root.innerHTML = `
      <div class="sp-header">
        <h3>Scene</h3>
        <button class="sp-collapse" type="button" aria-label="Collapse scene panel">&#9776;</button>
      </div>
      <div class="sp-meta">${fmtStr}${filenameStr}${entityStr}${schemaStr}</div>
      <div class="sp-meta sp-meta-2">${meshLabel} &middot; ${triLabel}</div>
      ${listHtml}
    `;
    this.wireCollapse();
    this.wireRowActions();
  }

  private wireCollapse(): void {
    const btn = this.root.querySelector<HTMLButtonElement>(".sp-collapse");
    if (!btn) return;
    btn.addEventListener("click", () => this.toggleCollapse());
  }

  private wireRowActions(): void {
    this.root.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = el.dataset.id;
        const action = el.dataset.action;
        const node = this.nodes.find((n) => n.id === id);
        if (!node) return;
        if (action === "toggle") {
          node.mesh.visible = !node.mesh.visible;
          (e.currentTarget as HTMLElement).classList.toggle("off", !node.mesh.visible);
          // Update row class so the name dims when hidden.
          const row = (e.currentTarget as HTMLElement).closest<HTMLElement>(".sp-row");
          if (row) row.classList.toggle("hidden-mesh", !node.mesh.visible);
        } else if (action === "zoom") {
          this.viewer.frameObjectOnly(node.mesh);
        }
      });
    });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
