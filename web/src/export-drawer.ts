// Export drawer (#178) — bundle port. Slides in from the right with
// 12 formats grouped by BIM / 3D-MESH / 2D-DRAWING. Each .ed-fmt button
// proxies to the legacy .exp-btn[data-fmt="X"] click handler so existing
// IFC/GLB/OBJ/STL/STEP export pipelines keep working.

import { iconSVG } from "./icons";

type Fmt = { ext: string; sub: string; fmt: string };

const SECTIONS: { num: string; title: string; items: Fmt[] }[] = [
  {
    num: "01",
    title: "BIM · ARCHITECTURAL",
    items: [
      { ext: "IFC",  sub: "STEP-21 · SPF",  fmt: "ifc" },
      { ext: "STEP", sub: "OCCT B-rep",     fmt: "step" },
      { ext: "DWG",  sub: "AutoCAD 2018",   fmt: "dwg" }, // not implemented yet
    ],
  },
  {
    num: "02",
    title: "3D · MESH",
    items: [
      { ext: "OBJ",  sub: "wavefront",      fmt: "obj" },
      { ext: "STL",  sub: "stereolith.",    fmt: "stl" },
      { ext: "GLB",  sub: "binary glTF",    fmt: "glb" },
      { ext: "glTF", sub: "JSON glTF",      fmt: "gltf" },
      { ext: "USDZ", sub: "AR · iOS",       fmt: "usdz" },
      { ext: "FBX",  sub: "FilmBox",        fmt: "fbx" }, // not implemented yet
    ],
  },
  {
    num: "03",
    title: "2D · DRAWING",
    items: [
      { ext: "SVG",  sub: "vector",         fmt: "svg" },
      { ext: "DXF",  sub: "vector · CAD",   fmt: "dxf" },
      { ext: "PDF",  sub: "A1 sheet",       fmt: "pdf" },
    ],
  },
];

let drawerEl: HTMLDivElement | null = null;

function getMeshStats() {
  // Read from statusbar (already populated by viewer/scene-panel).
  const verts = (document.querySelector("#sb-verts .v") as HTMLElement | null)?.textContent || "—";
  const faces = (document.querySelector("#sb-faces .v") as HTMLElement | null)?.textContent || "—";
  const sel   = (document.querySelector("#sb-sel .v") as HTMLElement | null)?.textContent || "—";
  return { verts, faces, sel };
}

function build(): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "export-drawer";

  const { verts, faces } = getMeshStats();

  let html = `
    <div class="ed-header">
      <div class="ed-header-l">
        <span class="ed-eyebrow">FILE · EXPORT</span>
        <span class="ed-title">Untitled.001</span>
      </div>
      <button class="ed-close" type="button" title="Close (esc)">${iconSVG("x", 11)}</button>
    </div>
    <div class="ed-meta">
      <div><span class="k">verts</span><span class="v">${verts}</span></div>
      <div><span class="k">faces</span><span class="v">${faces}</span></div>
      <div><span class="k">precision</span><span class="v">0.001 m</span></div>
      <div><span class="k">units</span><span class="v">METRIC · m</span></div>
    </div>
    <div class="ed-body">
  `;
  for (const s of SECTIONS) {
    html += `<div class="ed-section">
      <div class="ed-section-title"><span class="num">${s.num}</span>${s.title}</div>
      <div class="ed-grid">`;
    for (const it of s.items) {
      html += `<button class="ed-fmt" type="button" data-fmt="${it.fmt}">
        <span class="ext">${it.ext}</span><span class="sub">${it.sub}</span>
      </button>`;
    }
    html += `</div></div>`;
  }
  html += `</div>
    <div class="ed-footer">
      <span class="ed-foot-meta">round-trip verified · web-ifc 0.0.61</span>
      <button class="btn btn-accent btn-sm" id="ed-download-all" type="button">
        ${iconSVG("export", 11)} DOWNLOAD ALL
      </button>
    </div>
  `;
  root.innerHTML = html;

  // Wire close
  root.querySelector(".ed-close")?.addEventListener("click", close);

  // Wire each format button to the legacy .exp-btn[data-fmt=...]
  root.querySelectorAll<HTMLButtonElement>(".ed-fmt").forEach((edFmt) => {
    const fmt = edFmt.dataset.fmt!;
    const legacy = document.querySelector<HTMLButtonElement>(`.exp-btn[data-fmt="${fmt}"]`);
    if (!legacy) {
      // Format not yet wired; mark visually disabled.
      edFmt.classList.add("disabled");
      edFmt.disabled = true;
      edFmt.title = "Not yet implemented";
    } else {
      // Mirror disabled state at open-time.
      edFmt.disabled = legacy.disabled;
      edFmt.addEventListener("click", () => {
        if (legacy.disabled) return;
        legacy.click();
      });
    }
  });

  // DOWNLOAD ALL — for now just a stub.
  root.querySelector("#ed-download-all")?.addEventListener("click", () => {
    const enabled = SECTIONS.flatMap((s) => s.items).filter((it) => {
      const b = document.querySelector<HTMLButtonElement>(`.exp-btn[data-fmt="${it.fmt}"]`);
      return b && !b.disabled;
    });
    alert(`Bulk download — would export ${enabled.length} formats: ${enabled.map((f) => f.ext).join(", ")}`);
  });

  return root;
}

function open() {
  if (drawerEl) {
    // Refresh meta + format-disabled state
    drawerEl.remove();
  }
  drawerEl = build();
  document.body.appendChild(drawerEl);
  // Trigger CSS transition by adding .open after insertion.
  requestAnimationFrame(() => drawerEl?.classList.add("open"));

  // Esc to close.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      close();
      window.removeEventListener("keydown", onKey);
    }
  };
  window.addEventListener("keydown", onKey);
}

function close() {
  if (!drawerEl) return;
  drawerEl.classList.remove("open");
  // Wait for CSS transition before removing.
  setTimeout(() => {
    drawerEl?.remove();
    drawerEl = null;
  }, 300);
}

export function initExportDrawer() {
  // Wire ribbon EXPORT button (#ribbon-export-btn).
  const exportBtn = document.getElementById("ribbon-export-btn");
  if (exportBtn) {
    exportBtn.addEventListener("click", (e) => {
      e.preventDefault();
      open();
    });
  }
}

export function openExportDrawer() { open(); }
export function closeExportDrawer() { close(); }
