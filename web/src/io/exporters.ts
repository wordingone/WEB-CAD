// Multi-format exporters for the WEB-CAD viewer.
//
// All exporters take the live THREE.Object3D currently in the viewer plus
// a label / id and return either a Blob (for binary) or a string (for text).
// The caller (main.ts) wires up the download.
//
// Covered here:
//   - OBJ          three OBJExporter
//   - glTF / GLB   three GLTFExporter
//   - USDZ         three USDZExporter
//   - STL          three STLExporter (binary)
//   - 3DM          rhino3dm.js mesh round-trip
//   - SVG          custom top-view projection of EdgesGeometry
//   - DXF          hand-rolled minimal AC1009 DXF, AcDbLine entities only
//   - PDF          hand-rolled PDF 1.4, vector lines
// Handled externally:
//   - IFC          existing buildIfc pipeline (handled in main.ts)
//   - STEP         OCCT-only, replicad source required

import * as THREE from "three";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { USDZExporter } from "three/examples/jsm/exporters/USDZExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import type { CanonicalGeometry } from "../geometry/canonical-geometry.js";
import { canonicalGeometryToIfcNurbs, surfaceToIfcNurbs } from "../ifc/canonical-ifc.js";
import { tessellate as tessellateCurve } from "../nurbs/nurbs-curves.js";
import type { Surface } from "../nurbs/nurbs-surfaces.js";
import type { NurbsSurface as KernelNurbsSurface } from "../nurbs/nurbs-kernel.js";

// --- OBJ ---

export function exportObj(object: THREE.Object3D): string {
  const exporter = new OBJExporter();
  return exporter.parse(object);
}

// --- glTF (JSON) ---

export async function exportGltfJson(object: THREE.Object3D): Promise<string> {
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      object,
      (result) => {
        if (result instanceof ArrayBuffer) {
          // Shouldn't happen with binary:false, but guard.
          resolve(new TextDecoder().decode(result));
        } else {
          resolve(JSON.stringify(result, null, 2));
        }
      },
      (err) => reject(err),
      { binary: false },
    );
  });
}

// --- GLB (binary) ---

export async function exportGlb(object: THREE.Object3D): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      object,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(result);
        else reject(new Error("GLTFExporter returned JSON despite binary=true"));
      },
      (err) => reject(err),
      { binary: true },
    );
  });
}

// --- USDZ ---

export async function exportUsdz(object: THREE.Object3D): Promise<Uint8Array> {
  const exporter = new USDZExporter() as unknown as {
    parse?: (scene: THREE.Object3D, options?: object) => Promise<Uint8Array>;
    parseAsync?: (scene: THREE.Object3D, options?: object) => Promise<Uint8Array>;
  };
  // three 0.162 exposes async parse(); newer versions renamed to parseAsync.
  const fn = exporter.parse ?? exporter.parseAsync;
  if (!fn) throw new Error("USDZExporter has no parse method");
  return fn.call(exporter, object);
}

// --- STL (binary) ---

export function exportStl(object: THREE.Object3D): ArrayBuffer {
  const exporter = new STLExporter();
  const result = exporter.parse(object, { binary: true });
  if (result instanceof ArrayBuffer) return result;
  // STLExporter binary mode always returns DataView in some three versions.
  if (result && typeof (result as unknown as DataView).buffer !== "undefined") {
    return (result as unknown as DataView).buffer as ArrayBuffer;
  }
  // ASCII fallback: encode to bytes
  return new TextEncoder().encode(result as unknown as string).buffer as ArrayBuffer;
}

// --- 3DM (Rhino) ---

export type Export3dmOptions = {
  getCanonicalGeometryForObject?: (obj: THREE.Object3D) => CanonicalGeometry | undefined;
};

export type CanonicalExportOptions = {
  getCanonicalGeometryForObject?: (obj: THREE.Object3D) => CanonicalGeometry | undefined;
};

type Segment3 = [number, number, number, number, number, number];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function addKernelNurbsSurfaceToRhinoFile(rh: any, file: any, surface: KernelNurbsSurface): void {
  const { degreeU, degreeV, countU, countV, controlPoints, weights, knotsU, knotsV } = surface;
  const isRational = weights.some((w) => w !== 1);
  const ns = rh.NurbsSurface.create(3, isRational, degreeU + 1, degreeV + 1, countU, countV);
  if (!ns) throw new Error("addKernelNurbsSurfaceToRhinoFile: NurbsSurface.create returned null");

  const pts = ns.points();
  for (let i = 0; i < countU; i++) {
    for (let j = 0; j < countV; j++) {
      const idx = i * countV + j;
      const p = controlPoints[idx];
      const w = weights[idx] ?? 1;
      if (!p) continue;
      pts.set(i, j, isRational ? [p[0] * w, p[1] * w, p[2] * w, w] : [p[0], p[1], p[2]]);
    }
  }

  const ku = ns.knotsU();
  const kv = ns.knotsV();
  const truncU = knotsU.slice(1, knotsU.length - 1);
  const truncV = knotsV.slice(1, knotsV.length - 1);
  if (truncU.length !== ku.count) {
    ns.delete?.();
    throw new Error(`addKernelNurbsSurfaceToRhinoFile: U-knot length mismatch ${truncU.length} vs ${ku.count}`);
  }
  if (truncV.length !== kv.count) {
    ns.delete?.();
    throw new Error(`addKernelNurbsSurfaceToRhinoFile: V-knot length mismatch ${truncV.length} vs ${kv.count}`);
  }
  for (let i = 0; i < truncU.length; i++) ku.set(i, truncU[i]);
  for (let i = 0; i < truncV.length; i++) kv.set(i, truncV[i]);

  file.objects().addSurface(ns);
  ns.delete?.();
}

function canonicalOrSidecarNurbsFor3dm(
  mesh: THREE.Mesh,
  options: Export3dmOptions,
): KernelNurbsSurface | null {
  const canonical = options.getCanonicalGeometryForObject?.(mesh);
  const fromCanonical = canonicalGeometryToIfcNurbs(canonical, mesh.matrixWorld);
  if (fromCanonical) return fromCanonical;
  const sidecarSurface = mesh.userData.nurbsSurface as Surface | undefined;
  return sidecarSurface ? surfaceToIfcNurbs(sidecarSurface, mesh.matrixWorld) : null;
}

// Hot-loads rhino3dm.js (WASM) on first call. Traverses the scene, writes
// canonical/runtime NURBS surfaces where available, and falls back to meshes.
export async function export3dm(object: THREE.Object3D, options: Export3dmOptions = {}): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rhino3dmInit = ((await import("rhino3dm")) as any).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rh: any = await rhino3dmInit();

  const file = new rh.File3dm();
  const tmpA = new THREE.Vector3();

  object.updateMatrixWorld(true);
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const nurbsSurface = canonicalOrSidecarNurbsFor3dm(mesh, options);
    if (nurbsSurface) {
      addKernelNurbsSurfaceToRhinoFile(rh, file, nurbsSurface);
      return;
    }

    const geom = mesh.geometry as THREE.BufferGeometry;
    const posAttr = geom.attributes.position;
    if (!posAttr) return;

    const pos = posAttr.array as Float32Array;
    const idx = geom.index?.array as Uint32Array | Uint16Array | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rhinoMesh: any = new rh.Mesh();
    const verts = rhinoMesh.vertices();
    const faces = rhinoMesh.faces();

    // Add world-space vertices.
    const baseCount = verts.count;
    for (let i = 0; i < pos.length; i += 3) {
      tmpA.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(mesh.matrixWorld);
      verts.add(tmpA.x, tmpA.y, tmpA.z);
    }

    // Add faces.
    if (idx) {
      for (let i = 0; i + 2 < idx.length; i += 3) {
        faces.addFace(baseCount + idx[i], baseCount + idx[i + 1], baseCount + idx[i + 2]);
      }
    } else {
      const count = pos.length / 3;
      for (let i = 0; i + 2 < count; i += 3) {
        faces.addFace(baseCount + i, baseCount + i + 1, baseCount + i + 2);
      }
    }

    rhinoMesh.compact();
    file.objects().add(rhinoMesh);
    rhinoMesh.delete();
  });

  const bytes: Uint8Array = file.toByteArray();
  file.delete();
  return bytes;
}

function collectWorldLineSegments(object: THREE.Object3D, options: CanonicalExportOptions = {}): Segment3[] {
  const segments: Segment3[] = [];
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const matWorld = new THREE.Matrix4();

  object.updateMatrixWorld(true);
  object.traverse((child) => {
    const canonical = options.getCanonicalGeometryForObject?.(child);
    if (canonical?.kind === "curve") {
      const pts = tessellateCurve(canonical.curve, 64);
      for (let i = 1; i < pts.length; i++) {
        tmpA.set(pts[i - 1].x, pts[i - 1].y, pts[i - 1].z).applyMatrix4(child.matrixWorld);
        tmpB.set(pts[i].x, pts[i].y, pts[i].z).applyMatrix4(child.matrixWorld);
        segments.push([tmpA.x, tmpA.y, tmpA.z, tmpB.x, tmpB.y, tmpB.z]);
      }
      return;
    }

    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry;
    if (!geom.attributes.position) return;
    matWorld.copy(mesh.matrixWorld);
    const edges = new THREE.EdgesGeometry(geom, 25);
    const pos = edges.attributes.position.array as Float32Array;
    for (let i = 0; i < pos.length; i += 6) {
      tmpA.set(pos[i + 0], pos[i + 1], pos[i + 2]).applyMatrix4(matWorld);
      tmpB.set(pos[i + 3], pos[i + 4], pos[i + 5]).applyMatrix4(matWorld);
      segments.push([tmpA.x, tmpA.y, tmpA.z, tmpB.x, tmpB.y, tmpB.z]);
    }
    edges.dispose();
  });

  return segments;
}

// --- SVG (top-view edge projection) ---

// Walks the scene graph and accumulates world-space line segments from
// EdgesGeometry built per-mesh. Then projects (x, y) to 2D — viewer is Z-up
// so XY is the architectural plan view. Outputs an SVG document scaled to
// fit a 800x600 viewport with a thin uniform stroke.
export function exportSvg(object: THREE.Object3D, options: CanonicalExportOptions = {}): string {
  const segments = collectWorldLineSegments(object, options)
    .map((s): [number, number, number, number] => [s[0], -s[1], s[3], -s[4]]);

  if (segments.length === 0) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><text x="20" y="40" font-family="monospace" font-size="14" fill="#666">no geometry</text></svg>\n`;
  }

  // Compute bounds of segments.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segments) {
    if (s[0] < minX) minX = s[0]; if (s[0] > maxX) maxX = s[0];
    if (s[2] < minX) minX = s[2]; if (s[2] > maxX) maxX = s[2];
    if (s[1] < minY) minY = s[1]; if (s[1] > maxY) maxY = s[1];
    if (s[3] < minY) minY = s[3]; if (s[3] > maxY) maxY = s[3];
  }
  const W = 800, H = 600, PAD = 20;
  const dx = maxX - minX || 1;
  const dy = maxY - minY || 1;
  const scale = Math.min((W - 2 * PAD) / dx, (H - 2 * PAD) / dy);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const ox = W / 2 - cx * scale;
  const oy = H / 2 - cy * scale;

  const lines = segments
    .map((s) => {
      const x1 = (s[0] * scale + ox).toFixed(2);
      const y1 = (s[1] * scale + oy).toFixed(2);
      const x2 = (s[2] * scale + ox).toFixed(2);
      const y2 = (s[3] * scale + oy).toFixed(2);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
    })
    .join("\n  ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#ffffff" />
  <g stroke="#0e0e10" stroke-width="0.6" fill="none" stroke-linecap="round" stroke-linejoin="round">
  ${lines}
  </g>
</svg>
`;
}

// --- DXF (AcDbLine — AutoCAD-compatible) ---

// Hand-rolled minimal AC1009 (R12) DXF emitter. AC1009 reads natively in
// every Autodesk product since DOS, plus FreeCAD / LibreCAD / QCAD. Group-
// code pairs follow the standard format: code on its own line, value next.
export function exportDxf(object: THREE.Object3D, options: CanonicalExportOptions = {}): string {
  const segments = collectWorldLineSegments(object, options);

  const lines: string[] = [];
  // Header
  lines.push("0", "SECTION", "2", "HEADER");
  lines.push("9", "$ACADVER", "1", "AC1009");
  lines.push("0", "ENDSEC");
  // Tables (minimal: one layer)
  lines.push("0", "SECTION", "2", "TABLES");
  lines.push("0", "TABLE", "2", "LAYER", "70", String(1));
  lines.push("0", "LAYER", "2", "0", "70", "0", "62", "7", "6", "CONTINUOUS");
  lines.push("0", "ENDTAB");
  lines.push("0", "ENDSEC");
  // Entities
  lines.push("0", "SECTION", "2", "ENTITIES");
  for (const s of segments) {
    lines.push("0", "LINE", "8", "0");
    lines.push("10", s[0].toFixed(6));
    lines.push("20", s[1].toFixed(6));
    lines.push("30", s[2].toFixed(6));
    lines.push("11", s[3].toFixed(6));
    lines.push("21", s[4].toFixed(6));
    lines.push("31", s[5].toFixed(6));
  }
  lines.push("0", "ENDSEC");
  lines.push("0", "EOF");
  return lines.join("\n") + "\n";
}

// --- PDF (top-view orthographic, vector lines) ---

// Minimal hand-rolled PDF 1.4 with one page containing the same line set as
// the SVG export. No external dep — adding pdf-lib is overkill for line art.
export function exportPdf(object: THREE.Object3D, options: CanonicalExportOptions = {}): Uint8Array {
  const segments = collectWorldLineSegments(object, options)
    .map((s): [number, number, number, number] => [s[0], s[1], s[3], s[4]]);

  // Bounds.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segments) {
    if (s[0] < minX) minX = s[0]; if (s[0] > maxX) maxX = s[0];
    if (s[2] < minX) minX = s[2]; if (s[2] > maxX) maxX = s[2];
    if (s[1] < minY) minY = s[1]; if (s[1] > maxY) maxY = s[1];
    if (s[3] < minY) minY = s[3]; if (s[3] > maxY) maxY = s[3];
  }
  if (!isFinite(minX)) {
    minX = 0; minY = 0; maxX = 100; maxY = 100;
  }
  // US Letter portrait: 612 x 792 pt.
  const W = 612, H = 792, PAD = 36;
  const dx = (maxX - minX) || 1;
  const dy = (maxY - minY) || 1;
  const scale = Math.min((W - 2 * PAD) / dx, (H - 2 * PAD) / dy);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const ox = W / 2 - cx * scale;
  const oy = H / 2 - cy * scale;

  // Build content stream: thin black lines.
  let content = "0.6 w\n0 0 0 RG\n";
  for (const s of segments) {
    const x1 = (s[0] * scale + ox).toFixed(2);
    const y1 = (s[1] * scale + oy).toFixed(2);
    const x2 = (s[2] * scale + ox).toFixed(2);
    const y2 = (s[3] * scale + oy).toFixed(2);
    content += `${x1} ${y1} m ${x2} ${y2} l S\n`;
  }
  if (segments.length === 0) {
    content += "BT /F1 14 Tf 36 740 Td (no geometry) Tj ET\n";
  }

  // Assemble PDF objects.
  const enc = new TextEncoder();
  const objects: string[] = [];
  // 1: catalog. 2: pages. 3: page. 4: contents. 5: font (helvetica).
  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objects.push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  objects.push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`,
  );
  objects.push(
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
  );
  objects.push(
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  );

  let body = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const off of offsets) {
    body += `${off.toString().padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return enc.encode(body);
}
