// Scene-understanding panel.
//
// Shows the loaded scene's mesh tree with per-mesh visibility toggles and
// click-to-zoom. Walked once per load; re-renders on interaction only — no
// per-frame redraw. Intentionally agnostic to source format: whatever
// LoadedScene the loader hands back, we walk it as a THREE.Object3D graph.
//
// Visual: bundle's outliner aesthetic (#174). Sections grouped by IFC class
// (ARCHITECTURE / STRUCTURE / OPENINGS / CIRCULATION / MESHES) inferred
// from mesh names. Falls back to a single MESHES section when no class can
// be inferred.

import * as THREE from "three";
import type { Viewer } from "./viewer";
import { iconSVG } from "./icons";

type IfcClass = "ARCHITECTURE" | "STRUCTURE" | "OPENINGS" | "CIRCULATION" | "MESHES";
function classifyByName(name: string): IfcClass {
  const n = name.toLowerCase();
  if (/(wall|slab|floor|roof|covering|space)/.test(n)) return "ARCHITECTURE";
  if (/(column|beam|footing|pile|member|brace|truss)/.test(n)) return "STRUCTURE";
  if (/(door|window|opening|reveal)/.test(n)) return "OPENINGS";
  if (/(stair|ramp|railing|hand)/.test(n)) return "CIRCULATION";
  return "MESHES";
}

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
      <div class="sp-meta-row" style="padding:6px 10px; font-family:var(--mono); font-size:10px; color:var(--ink-faint); border-bottom:1px solid var(--hairline-soft);">
        no scene loaded — drop a file or pick a sample
      </div>
    `;
  }

  private render(summary: SceneSummary): void {
    const totalTris = this.nodes.reduce((s, n) => s + n.triangles, 0);
    const fmtStr = summary.format.toUpperCase();
    const filenameStr = summary.filename ? ` &middot; ${escapeHtml(summary.filename)}` : "";
    const entityStr = summary.entityCount != null
      ? ` &middot; ${summary.entityCount.toLocaleString()} entit${summary.entityCount === 1 ? "y" : "ies"}`
      : "";
    const schemaStr = summary.schema ? ` &middot; ${escapeHtml(summary.schema)}` : "";

    // Group nodes by inferred IFC class.
    const groups = new Map<IfcClass, MeshNode[]>();
    const ORDER: IfcClass[] = ["ARCHITECTURE", "STRUCTURE", "OPENINGS", "CIRCULATION", "MESHES"];
    for (const n of this.nodes) {
      const cls = classifyByName(n.name);
      if (!groups.has(cls)) groups.set(cls, []);
      groups.get(cls)!.push(n);
    }

    let outlinerHtml = `<div class="outliner">`;
    if (this.nodes.length === 0) {
      outlinerHtml += `<div style="padding:14px; color:var(--ink-faint); font-size:10px;">No meshes in this scene.</div>`;
    } else {
      for (const cls of ORDER) {
        const items = groups.get(cls);
        if (!items || items.length === 0) continue;
        outlinerHtml += `
          <div class="outliner-section" data-section="${cls}">
            <div class="outliner-section-header">
              ${iconSVG("chevron-down", 9)}
              ${cls}
              <span class="count">${items.length}</span>
            </div>`;
        for (const n of items) {
          const tris = n.triangles.toLocaleString();
          outlinerHtml += `
            <div class="outliner-row" data-id="${n.id}" style="--depth:${Math.min(n.depth, 2)}">
              <span class="twirl"></span>
              <span class="name" data-action="zoom" data-id="${n.id}" title="Click to zoom · ${tris} tri">${escapeHtml(n.name)}</span>
              <span class="swatch" style="background:${n.color}; border-color:${n.color};" aria-hidden="true"></span>
              <button class="vis-btn" data-action="toggle" data-id="${n.id}" title="Toggle visibility" type="button" aria-label="Toggle visibility for ${escapeHtml(n.name)}">${iconSVG("eye", 11)}</button>
              <button class="vis-btn" data-action="lock" data-id="${n.id}" title="Lock (stub)" type="button" aria-label="Lock ${escapeHtml(n.name)}">${iconSVG("lock", 11)}</button>
            </div>`;
        }
        outlinerHtml += `</div>`;
      }
    }
    outlinerHtml += `</div>`;

    const metaRow = `<div class="sp-meta-row" style="padding:6px 10px; font-family:var(--mono); font-size:10px; color:var(--ink-faint); border-bottom:1px solid var(--hairline-soft);">${fmtStr}${filenameStr}${entityStr}${schemaStr} &middot; ${this.nodes.length} mesh${this.nodes.length === 1 ? "" : "es"} &middot; ${totalTris.toLocaleString()} tri</div>`;
    this.root.innerHTML = metaRow + outlinerHtml;
    this.wireRowActions();
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
          const btn = e.currentTarget as HTMLElement;
          btn.classList.toggle("off", !node.mesh.visible);
          btn.style.opacity = node.mesh.visible ? "" : "0.3";
          // Dim the row label when hidden.
          const row = btn.closest<HTMLElement>(".outliner-row");
          if (row) {
            row.classList.toggle("hidden-mesh", !node.mesh.visible);
            row.style.opacity = node.mesh.visible ? "" : "0.5";
          }
        } else if (action === "zoom") {
          // Highlight the selected row.
          this.root.querySelectorAll(".outliner-row.selected").forEach((r) => r.classList.remove("selected"));
          const row = (e.currentTarget as HTMLElement).closest<HTMLElement>(".outliner-row");
          row?.classList.add("selected");
          this.viewer.frameObjectOnly(node.mesh);
        } else if (action === "lock") {
          // Stub — placeholder for future selection-lock functionality.
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
