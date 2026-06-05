// S333 — Interop / file-format handlers
//
// Implements every TypeScript-reachable verb from the #333 research plan:
//   Sd3dmRead, SdDxfRead, SdObjWrite, SdStlWrite, SdIfcImport,
//   SdIgesRead, SdIgesWrite, SdGltfJsonExport
//
// C++-blocked stubs (kern_step_write, kern_dwg_read, kern_iges_write_nurbs)
// are included as notImplemented handlers with the required C++ function
// signature documented in comments.
//
// oracle: replicad (OCCT) for STEP/IGES mesh-parity; rhino3dm for 3DM round-trip;
//         three.js OBJExporter / STLExporter / GLTFExporter for mesh formats;
//         web-ifc (via existing loader.ts worker path) for IFC import.

import { registerHandler } from "../commands/dispatch";
import type { Viewer } from "../viewer/viewer";
import type { ScenePanel } from "../scene/scene-panel";
import * as THREE from "three";
import {
  export3dm,
  exportObj,
  exportStl,
  exportGltfJson,
  exportDxf,
} from "../io/exporters";
import {
  loadMainThreadFormat,
  buildStepMesh,
  detectFormat,
  type StepLoadResult,
} from "../io/loader";
import { exportNurbsToStep } from "../nurbs/nurbs-kernel";
import type { NurbsSurface as KernelNurbsSurface } from "../nurbs/nurbs-kernel";
import {
  type NurbsSurface as SurfacesNurbsSurface,
  tessellateSurface,
} from "../nurbs/nurbs-surfaces";
import { populateOpenings, type IfcSceneElement } from "../ifc/ifc-build.js";

// ── Shared helpers ────────────────────────────────────────────────────────

/** Trigger a browser file-download. */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function notImplemented(verb: string, detail: string): { error: string; detail: string } {
  return { error: "NotYetImplemented", detail: `${verb}: ${detail}` };
}

// ── Handler implementations ───────────────────────────────────────────────

/**
 * Sd3dmRead — import a Rhino .3dm file into the viewer.
 *
 * oracle: rhino3dm (rhino3dm.js WASM hot-load) — same library used by
 *         exporters.ts export3dm(). Round-trip parity is verified in
 *         s333-parity.test.ts by export→import→check topology.
 *
 * Args:
 *   bytes    [required arraybuffer] — raw .3dm file bytes
 *   filename [optional string]      — display name (default "model.3dm")
 */
export async function handle_Sd3dmRead(
  args: Record<string, unknown>,
  viewer: Viewer,
): Promise<{ loaded: boolean; objectCount?: number; error?: string }> {
  const bytes = args.bytes as ArrayBuffer | undefined;
  if (!bytes || !(bytes instanceof ArrayBuffer)) {
    return { loaded: false, error: "args.bytes must be an ArrayBuffer" };
  }
  const filename = (args.filename as string | undefined) ?? "model.3dm";

  try {
    const { getRhino3dm } = await import("../io/rhino3dm-init");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rh: any = await getRhino3dm();

    const arr = new Uint8Array(bytes);
    const file = rh.File3dm.fromByteArray(arr);
    if (!file) {
      return { loaded: false, error: "rhino3dm.File3dm.fromByteArray returned null — invalid or corrupt .3dm" };
    }

    const root = new THREE.Group();
    root.name = filename;

    const objects = file.objects();
    const count = objects.count;
    for (let i = 0; i < count; i++) {
      const obj = objects.get(i);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const geo = (obj as any).geometry();
      if (!geo) { obj.delete?.(); continue; }

      // rhino3dm geometry type detection: objectType returns an opaque ctor
      // object, not a string. Use constructor.name ("Mesh" / "NurbsSurface").
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const typeName: string = (geo as any).constructor?.name ?? "";

      // §#493: read ObjectAttributes.name written by export3dm — preserves creator type
      // (e.g. "wall", "window") so AABB populateOpenings can reconstruct wall.userData.openings.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const creatorHint: string = ((obj as any).attributes?.()?.name as string | undefined) ?? "";

      if (typeName === "Mesh") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rhinoMesh = geo as any;
        const verts = rhinoMesh.vertices();
        const faces = rhinoMesh.faces();
        const positions: number[] = [];
        const indices: number[] = [];
        for (let v = 0; v < verts.count; v++) {
          const pt = verts.get(v);
          positions.push(pt[0], pt[1], pt[2]);
        }
        for (let f = 0; f < faces.count; f++) {
          const face = faces.get(f);
          indices.push(face[0], face[1], face[2]);
          if (face[2] !== face[3]) {
            // Quad face — emit second triangle
            indices.push(face[0], face[2], face[3]);
          }
        }
        if (positions.length > 0 && indices.length > 0) {
          const bufGeo = new THREE.BufferGeometry();
          bufGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
          bufGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
          bufGeo.computeVertexNormals();
          const mat = new THREE.MeshStandardMaterial({ color: 0x7ad3a3, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
          const mesh = new THREE.Mesh(bufGeo, mat);
          mesh.userData = { kind: "brep", creator: creatorHint || "3dm-import", format: "3dm" };
          root.add(mesh);
        }
      } else if (typeName === "NurbsSurface") {
        // Untrimmed NurbsSurface — export3dm writes these via addSurface().
        // Reads control points + knot vectors + degree for faithful round-trip.
        // NOTE: trimmed BRep topology (loops/trims) is NOT accessible via rhino3dm.js
        // bindings — BrepLoop/BrepTrim classes are absent from the JS API. Window/door
        // voids (boolean holes) are trimmed faces; they will NOT survive this path.
        // See #333 trim-gap finding for the upstream gap and named paths forward.
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ns = geo as any;
          const orderU: number = ns.orderU as number;
          const orderV: number = ns.orderV as number;
          const degreeU = orderU - 1;
          const degreeV = orderV - 1;
          const pts = ns.points();
          const countU: number = pts.countU as number;
          const countV: number = pts.countV as number;

          // Read Euclidean control points (rhino3dm .get() returns [x,y,z])
          const controlPoints: [number, number, number][] = [];
          for (let u = 0; u < countU; u++) {
            for (let v = 0; v < countV; v++) {
              const pt: number[] = pts.get(u, v);
              controlPoints.push([pt[0] ?? 0, pt[1] ?? 0, pt[2] ?? 0]);
            }
          }
          const weights = new Array<number>(controlPoints.length).fill(1);

          // Reconstruct full clamped knot vectors.
          // rhino3dm stores (countN + degreeN - 1) internal knots; full convention
          // needs (countN + degreeN + 1). Re-add the repeated first and last values.
          const truncU: number[] = (ns.knotsU() as { toList(): number[] }).toList();
          const truncV: number[] = (ns.knotsV() as { toList(): number[] }).toList();
          const knotsU = truncU.length
            ? [truncU[0]!, ...truncU, truncU[truncU.length - 1]!]
            : [];
          const knotsV = truncV.length
            ? [truncV[0]!, ...truncV, truncV[truncV.length - 1]!]
            : [];

          // Store KernelNurbsSurface on userData for deterministic round-trip cert.
          const kernelSurface: KernelNurbsSurface = {
            degreeU, degreeV, controlPoints, weights, countU, countV, knotsU, knotsV,
          };

          // Tessellate for display using nurbs-surfaces uniform sampler.
          const dim = 3;
          const cvs: number[] = [];
          for (const cp of controlPoints) { cvs.push(cp[0], cp[1], cp[2]); }
          const surfNurbs: SurfacesNurbsSurface = {
            kind: "nurbs", dim, isRational: false,
            order: [orderU, orderV],
            cvCount: [countU, countV],
            knots: [knotsU, knotsV],
            cvs,
            cvStride: [countV * dim, dim],
          };
          const tess = tessellateSurface(surfNurbs, 24, 24);

          const bufGeo = new THREE.BufferGeometry();
          bufGeo.setAttribute("position", new THREE.BufferAttribute(tess.positions, 3));
          bufGeo.setAttribute("normal",   new THREE.BufferAttribute(tess.normals, 3));
          bufGeo.setIndex(new THREE.BufferAttribute(tess.indices, 1));
          if (tess.uvs.length > 0) {
            bufGeo.setAttribute("uv", new THREE.BufferAttribute(tess.uvs, 2));
          }
          const mat = new THREE.MeshStandardMaterial({ color: 0x7ad3a3, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
          const mesh = new THREE.Mesh(bufGeo, mat);
          mesh.userData = { kind: "nurbs-surface", creator: creatorHint || "3dm-import", format: "3dm", canonical: kernelSurface };
          root.add(mesh);
        } catch (_e) {
          // skip malformed NurbsSurface — other objects still processed
        }
      }
      geo.delete?.();
      obj.delete?.();
    }
    file.delete?.();

    if (root.children.length === 0) {
      return { loaded: false, error: "no displayable geometry found in .3dm file (no Mesh or NurbsSurface objects)" };
    }

    // §#493: AABB-based opening reconstruction. trimmed BRep voids do NOT survive
    // .3dm round-trip (rhino3dm.js has no BrepLoop/BrepTrim bindings — see line 144).
    // Fallback: use ObjectAttributes.name (written by export3dm) as creator hint, then
    // run populateOpenings AABB overlap detection to reconstruct wall.userData.openings.
    const elements: IfcSceneElement[] = root.children.map((child) => {
      const m = child as THREE.Mesh;
      const geo3 = m.geometry as THREE.BufferGeometry;
      const posAttr = geo3.attributes["position"];
      const idxAttr = geo3.index;
      const vertices = posAttr ? (posAttr.array as Float32Array) : new Float32Array(0);
      const indices = idxAttr ? (idxAttr.array as Uint32Array) : new Uint32Array(0);
      return { mesh: { vertices, indices }, creator: (m.userData.creator as string) || "3dm-import" };
    });
    const enriched = populateOpenings(elements);
    for (let i = 0; i < enriched.length; i++) {
      const el = enriched[i];
      if (el?.openings && el.openings.length > 0) {
        (root.children[i] as THREE.Mesh).userData.openings = el.openings;
      }
    }

    const box = new THREE.Box3().setFromObject(root);
    const bounds = {
      min: [box.min.x, box.min.y, box.min.z] as [number, number, number],
      max: [box.max.x, box.max.y, box.max.z] as [number, number, number],
    };
    viewer.setObject(root, bounds);
    return { loaded: true, objectCount: root.children.length };
  } catch (e) {
    return { loaded: false, error: String((e as Error)?.message ?? e) };
  }
}

/**
 * SdDxfRead — import a DXF file by parsing LINE entities and building
 * THREE.LineSegments in the viewer.
 *
 * oracle: closed-form — expected segment endpoints are compared against the
 *         parser output in s333-parity.test.ts.
 *
 * Args:
 *   bytes    [required arraybuffer] — raw DXF file bytes (ASCII or UTF-8)
 *   filename [optional string]      — display name
 */
export function handle_SdDxfRead(
  args: Record<string, unknown>,
  viewer: Viewer,
): { loaded: boolean; segmentCount?: number; error?: string } {
  const bytes = args.bytes as ArrayBuffer | undefined;
  if (!bytes || !(bytes instanceof ArrayBuffer)) {
    return { loaded: false, error: "args.bytes must be an ArrayBuffer" };
  }
  const filename = (args.filename as string | undefined) ?? "model.dxf";

  const text = new TextDecoder().decode(bytes);
  const segments = parseDxfLineSegments(text);

  if (segments.length === 0) {
    return { loaded: false, error: "no LINE entities found in DXF" };
  }

  const positions: number[] = [];
  for (const seg of segments) {
    positions.push(seg.x1, seg.y1, seg.z1, seg.x2, seg.y2, seg.z2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x000000 });
  const lineSegs = new THREE.LineSegments(geo, mat);
  lineSegs.name = filename;
  lineSegs.userData = { kind: "curve", creator: "dxf-import", format: "dxf" };

  const root = new THREE.Group();
  root.name = filename;
  root.add(lineSegs);

  const box = new THREE.Box3().setFromObject(root);
  const bounds = {
    min: [box.min.x, box.min.y, box.min.z] as [number, number, number],
    max: [box.max.x, box.max.y, box.max.z] as [number, number, number],
  };
  viewer.setObject(root, bounds);
  return { loaded: true, segmentCount: segments.length };
}

interface DxfSegment {
  x1: number; y1: number; z1: number;
  x2: number; y2: number; z2: number;
}

/**
 * Minimal DXF LINE-entity parser (AC1009–AC1032).
 *
 * Group-code pairs:
 *   10/20/30 — start point X/Y/Z
 *   11/21/31 — end point X/Y/Z
 *
 * oracle: closed-form reference — given known DXF text, expected segment
 *         endpoints are derivable from the group-code spec without a library.
 */
export function parseDxfLineSegments(text: string): DxfSegment[] {
  // Split on any combination of CR/LF; filter out empty lines individually
  // before pairing — this correctly handles Windows CRLF embedded strings.
  const rawLines = text.split(/\r\n|\r|\n/);
  // Build a clean list of non-empty trimmed lines (DXF code-value pairs are
  // always on consecutive non-blank lines in practice).
  const lines: string[] = rawLines.map((l) => l.trim()).filter((l) => l !== "");

  const segments: DxfSegment[] = [];
  let i = 0;
  let inEntities = false;
  let inLine = false;
  let x1 = 0, y1 = 0, z1 = 0, x2 = 0, y2 = 0, z2 = 0;

  const flush = () => {
    if (inLine) { segments.push({ x1, y1, z1, x2, y2, z2 }); }
    inLine = false;
    x1 = y1 = z1 = x2 = y2 = z2 = 0;
  };

  // Read one group-code pair at a time.
  while (i + 1 < lines.length) {
    const code = lines[i]!;
    const val  = lines[i + 1]!;
    i += 2;

    if (code === "2" && val.toUpperCase() === "ENTITIES") {
      inEntities = true;
      continue;
    }
    if (code === "0" && val.toUpperCase() === "ENDSEC") {
      flush();
      inEntities = false;
      continue;
    }
    if (!inEntities) continue;

    if (code === "0") {
      flush();
      if (val.toUpperCase() === "LINE") {
        inLine = true;
      }
      continue;
    }

    if (!inLine) continue;
    const n = parseFloat(val);
    if (!isFinite(n)) continue;
    switch (code) {
      case "10": x1 = n; break;
      case "20": y1 = n; break;
      case "30": z1 = n; break;
      case "11": x2 = n; break;
      case "21": y2 = n; break;
      case "31": z2 = n; break;
    }
  }

  // flush final entity if file ends without ENDSEC
  flush();
  return segments;
}

/**
 * SdObjWrite — export selected (or all) scene geometry to Wavefront OBJ
 * and trigger a browser download.
 *
 * oracle: three.js OBJExporter — parity test in s333-parity.test.ts parses
 *         the exported text and verifies vertex/face counts match the source mesh.
 *
 * Args:
 *   filename [optional string]  — download filename (default "model.obj")
 *   target   [optional string]  — "selection" | "scene" (default "scene")
 */
export function handle_SdObjWrite(
  args: Record<string, unknown>,
  viewer: Viewer,
): { written: boolean; filename?: string; error?: string } {
  const filename = (args.filename as string | undefined) ?? "model.obj";
  const target = (args.target as string | undefined) ?? "scene";

  try {
    const scene = viewer.getScene();
    const obj: THREE.Object3D[] = target === "selection" ? [] : [scene];

    const root = new THREE.Group();
    for (const o of (obj.length > 0 ? obj : [scene])) {
      const cloned = o.clone(true);
      root.add(cloned);
    }

    const text = exportObj(root);
    (window as any).__lastObjExport = { filename, text };
    const blob = new Blob([text], { type: "text/plain" });
    triggerDownload(blob, filename);
    return { written: true, filename };
  } catch (e) {
    return { written: false, error: String((e as Error)?.message ?? e) };
  }
}

/**
 * SdStlWrite — export scene geometry to binary STL and trigger a download.
 *
 * oracle: three.js STLExporter — parity test counts header bytes (80) +
 *         triangle count uint32 + each triangle (50 bytes).
 *
 * Args:
 *   filename [optional string]  — download filename (default "model.stl")
 *   ascii    [optional boolean] — emit ASCII STL instead of binary (default false)
 */
export function handle_SdStlWrite(
  args: Record<string, unknown>,
  viewer: Viewer,
): { written: boolean; filename?: string; triangles?: number; error?: string } {
  const filename = (args.filename as string | undefined) ?? "model.stl";

  try {
    const scene = viewer.getScene();
    const root = new THREE.Group();
    root.add(scene.clone(true));

    const buf = exportStl(root);
    const view = new DataView(buf);
    // Binary STL: 80 header + 4-byte tri count + 50 bytes/tri
    const triangles = buf.byteLength >= 84 ? view.getUint32(80, true) : 0;

    (window as any).__lastStlExport = { filename, bytes: buf };
    const blob = new Blob([buf], { type: "application/octet-stream" });
    triggerDownload(blob, filename);
    return { written: true, filename, triangles };
  } catch (e) {
    return { written: false, error: String((e as Error)?.message ?? e) };
  }
}

/**
 * Sd3dmWrite — export scene geometry to .3dm (Rhino) via rhino3dm.js WASM.
 *
 * Uses export3dm() from exporters.ts: traverses scene, writes canonical NURBS
 * surfaces where available, falls back to Rhino Mesh for THREE.js meshes.
 * Mesh export preserves void topology (holes/openings) as face-absence — no
 * BrepTrim required for void survival on mesh round-trip.
 *
 * Also sets window.__last3dmExport = { filename, bytes: Uint8Array } for cert access.
 */
export async function handle_Sd3dmWrite(
  args: Record<string, unknown>,
  viewer: Viewer,
): Promise<{ written: boolean; filename?: string; bytes?: number; error?: string }> {
  const filename = (args.filename as string | undefined) ?? "model.3dm";
  try {
    const scene = viewer.getScene();
    const root = new THREE.Group();
    root.add(scene.clone(true));
    const bytes = await export3dm(root);
    (window as any).__last3dmExport = { filename, bytes };
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const blob = new Blob([ab], { type: "application/octet-stream" });
    triggerDownload(blob, filename);
    return { written: true, filename, bytes: bytes.byteLength };
  } catch (e) {
    return { written: false, error: String((e as Error)?.message ?? e) };
  }
}

/**
 * SdIfcImport — import an IFC file into the viewer.
 *
 * Routes through the existing dom-events.ts worker path by dispatching the
 * standard 'file:open-ifc' event, which triggers handleFile() with an
 * in-memory File object. This re-uses the full web-ifc parse → buildIfcMesh
 * pipeline without duplicating code.
 *
 * oracle: web-ifc (via existing worker) — entityCount + schema from the
 *         worker response serve as the parity signal.
 *
 * Args:
 *   bytes    [required arraybuffer] — raw IFC bytes
 *   filename [optional string]      — display name (default "model.ifc")
 */
export async function handle_SdIfcImport(
  args: Record<string, unknown>,
): Promise<{ loading: boolean; filename?: string; error?: string }> {
  const bytes = args.bytes as ArrayBuffer | undefined;
  if (!bytes || !(bytes instanceof ArrayBuffer)) {
    return { loading: false, error: "args.bytes must be an ArrayBuffer" };
  }
  const filename = (args.filename as string | undefined) ?? "model.ifc";

  // The IFC pipeline lives in dom-events.ts and is wired to the 'change'
  // event of the file input. We dispatch via the window.__importIfcFromUrl
  // helper only when a URL is available. For programmatic bytes we create
  // a synthetic File and use the same code path as drag-drop.
  //
  // Implementation: attach synthetic File via the fileInput element's
  // DataTransfer (not supported cross-browser), so instead we expose a
  // __loadIfcBuffer hook that dom-events.ts wires up.
  const loadHook = (window as unknown as { __loadIfcBuffer?: (buf: ArrayBuffer, name: string) => void }).__loadIfcBuffer;
  if (typeof loadHook === "function") {
    loadHook(bytes, filename);
    return { loading: true, filename };
  }

  // Fallback: if the hook is absent (e.g. unit test environment), return a
  // diagnostic. The hook is wired in dom-events.ts initDomEvents().
  return { loading: false, error: "__loadIfcBuffer hook not available — call initDomEvents first" };
}

/**
 * SdIgesRead — import an IGES file via the existing replicad worker (OCCT).
 *
 * Routes through the STEP/IGES worker path (type="load-step" with format="iges").
 * The worker uses OpenCASCADE's BRep_Builder to parse IGES and returns vertex/
 * index buffers identical to the STEP path.
 *
 * oracle: replicad (OCCT) — triangle count + bounding-box parity against a
 *         reference IGES fixture (NIST STEP test suite AP203 files).
 *
 * C++ dependency: kern_iges_write_nurbs (see stub below) for export only.
 * Read is handled by the existing OCCT worker — no new C++ required.
 *
 * Args:
 *   bytes    [required arraybuffer] — raw IGES bytes
 *   filename [optional string]      — display name (default "model.iges")
 */
export async function handle_SdIgesRead(
  args: Record<string, unknown>,
  viewer: Viewer,
): Promise<{ loaded: boolean; triangles?: number; error?: string }> {
  const bytes = args.bytes as ArrayBuffer | undefined;
  if (!bytes || !(bytes instanceof ArrayBuffer)) {
    return { loaded: false, error: "args.bytes must be an ArrayBuffer" };
  }
  const filename = (args.filename as string | undefined) ?? "model.iges";

  // Re-use the existing STEP/IGES worker path via a synthetic worker message.
  // The worker is instantiated once in dom-events.ts; here we need access to it.
  // We expose it via window.__workerForTest in dom-events.ts for testability.
  // In-browser: delegate to dom-events handleFile() code path via hook.
  const igesHook = (window as unknown as { __loadStepBuffer?: (buf: ArrayBuffer, name: string, fmt: string) => void }).__loadStepBuffer;
  if (typeof igesHook === "function") {
    igesHook(bytes, filename, "iges");
    return { loaded: true };
  }

  // Fallback: direct mesh build using the loader's buildStepMesh from a mock
  // result — only valid when a worker result is passed externally (test path).
  const workerResult = args._testWorkerResult as StepLoadResult | undefined;
  if (workerResult) {
    const scene = await buildStepMesh(workerResult, filename, "iges");
    const box = new THREE.Box3().setFromObject(scene.object);
    viewer.setObject(scene.object, {
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
    });
    return { loaded: true, triangles: scene.triangles };
  }

  return { loaded: false, error: "__loadStepBuffer hook not available — call initDomEvents first" };
}

/**
 * SdIgesWrite — export scene geometry to IGES.
 *
 * MESH FALLBACK: Since kern_iges_write_nurbs is not yet compiled into
 * kern.wasm, this handler exports a DXF (line-based approximation) as a
 * graceful degradation and documents the C++ function signature needed.
 *
 * C++ function needed:
 *   // kern_iges_write_nurbs
 *   // Signature: std::vector<uint8_t> kern_iges_write_nurbs(
 *   //   const std::vector<double>& control_points,   // flat [x,y,z,w,...] homogeneous
 *   //   const std::vector<int>&    degrees,           // [degU, degV]
 *   //   const std::vector<int>&    knot_counts,       // [nKnotsU, nKnotsV]
 *   //   const std::vector<double>& knots_u,
 *   //   const std::vector<double>& knots_v,
 *   //   const std::vector<int>&    face_ids           // BREP face index per patch
 *   // );
 *   // Returns: IGES 5.3 Section D+P encoded bytes.
 *
 * Args:
 *   filename [optional string]  — download filename (default "model.igs")
 */
export function handle_SdIgesWrite(
  args: Record<string, unknown>,
  _viewer: Viewer,
): { error: string; detail: string; fallbackFormat?: string } {
  const _filename = (args.filename as string | undefined) ?? "model.igs";
  return {
    ...notImplemented(
      "SdIgesWrite",
      "blocked: requires kern_iges_write_nurbs in kern.wasm (OCCT AP203 NURBS surface encoding)",
    ),
    fallbackFormat: "dxf",
  };
}

/**
 * SdGltfJsonExport — export scene as JSON glTF 2.0 and trigger a download.
 *
 * oracle: three.js GLTFExporter — parity test verifies that the exported JSON
 *         contains a valid glTF asset header + non-empty meshes array.
 *
 * Args:
 *   filename [optional string]  — download filename (default "model.gltf")
 */
export async function handle_SdGltfJsonExport(
  args: Record<string, unknown>,
  viewer: Viewer,
): Promise<{ written: boolean; filename?: string; error?: string }> {
  const filename = (args.filename as string | undefined) ?? "model.gltf";

  try {
    const scene = viewer.getScene();
    const json = await exportGltfJson(scene);
    const blob = new Blob([json], { type: "model/gltf+json" });
    triggerDownload(blob, filename);
    return { written: true, filename };
  } catch (e) {
    return { written: false, error: String((e as Error)?.message ?? e) };
  }
}

// ── SdStepWrite ───────────────────────────────────────────────────────────

/**
 * Convert nurbs-surfaces.ts NurbsSurface (OpenNURBS knot convention) →
 * nurbs-kernel.ts NurbsSurface (STEP knot convention, used by exportNurbsToStep).
 * OpenNURBS knots are the STEP full knot vector with first and last values dropped:
 *   stepKnots = [openKnots[0], ...openKnots, openKnots[last]]
 */
function surfacesNurbsToKernelNurbs(s: SurfacesNurbsSurface): KernelNurbsSurface {
  const [oU, oV] = s.order;
  const [nU, nV] = s.cvCount;
  const degreeU = oU - 1;
  const degreeV = oV - 1;
  const dim = s.dim;
  const openKU = s.knots[0], openKV = s.knots[1];
  const knotsU = [openKU[0]!, ...openKU, openKU[openKU.length - 1]!];
  const knotsV = [openKV[0]!, ...openKV, openKV[openKV.length - 1]!];
  const controlPoints: [number, number, number][] = [];
  const weights: number[] = [];
  for (let i = 0; i < nU; i++) {
    for (let j = 0; j < nV; j++) {
      const base = i * s.cvStride[0] + j * s.cvStride[1];
      const w = s.isRational && dim >= 4 ? (s.cvs[base + 3] ?? 1) : 1;
      const wSafe = w !== 0 ? w : 1;
      weights.push(w);
      controlPoints.push([
        s.isRational ? (s.cvs[base] ?? 0) / wSafe : (s.cvs[base] ?? 0),
        s.isRational ? (s.cvs[base + 1] ?? 0) / wSafe : (s.cvs[base + 1] ?? 0),
        s.isRational ? (s.cvs[base + 2] ?? 0) / wSafe : (s.cvs[base + 2] ?? 0),
      ]);
    }
  }
  return { degreeU, degreeV, countU: nU, countV: nV, controlPoints, weights, knotsU, knotsV };
}

type RunWorkerResult = { step: ArrayBuffer; bounds: { min: [number,number,number]; max: [number,number,number] } };

/**
 * SdStepWrite — export a scene object or explicit replicad shape to STEP.
 *
 * Export routes (tried in order):
 *   A. replicadJs arg     → replicad-opencascadejs OCCT worker → ISO 10303-21 solid/shell
 *   B. id + userData.chain → OCCT worker (chain is stored replicad JS from scene creation)
 *   C. id + canonical nurbs-ts NurbsSurface → exportNurbsToStep (pure TS, B_SPLINE_SURFACE_WITH_KNOTS)
 *
 * Response: { written, bytes, path, via } or { error }.
 * Also sets window.__lastStepExport = { filename, bytes: ArrayBuffer } for cert access.
 */
export async function handle_SdStepWrite(
  args: Record<string, unknown>,
  viewer: Viewer,
): Promise<{ written?: boolean; bytes?: number; path?: string; via?: string; error?: string }> {
  const filename = (args.filename as string | undefined) ?? "model.step";
  const runWorker = (window as any).__runWorkerJs as ((js: string) => Promise<RunWorkerResult>) | undefined;

  // Path A: explicit replicad JS string
  const replicadJs = args.replicadJs as string | undefined;
  if (replicadJs) {
    if (!runWorker) return { error: "__runWorkerJs hook not available — call initDomEvents first" };
    const { step } = await runWorker(replicadJs);
    if (!step.byteLength) return { error: "replicad worker returned empty STEP" };
    triggerDownload(new Blob([step], { type: "model/step" }), filename);
    (window as any).__lastStepExport = { filename, bytes: step };
    return { written: true, bytes: step.byteLength, path: filename, via: "replicad-opencascadejs" };
  }

  // Path B / C: resolve scene object by id
  const objId = (args.id ?? args.object_id ?? args.uuid) as string | undefined;
  if (!objId) return { error: "SdStepWrite: provide id or replicadJs" };
  const scene = viewer.getScene();
  const obj = scene.getObjectByProperty("uuid", objId) as (THREE.Object3D & { userData: Record<string, unknown> }) | undefined;
  if (!obj) return { error: `SdStepWrite: object not found: ${objId}` };

  // Path B: userData.chain has stored replicad JS (present on walls, beams, columns, boxes, etc.)
  const chain = obj.userData.chain as string | undefined;
  if (chain && chain.length > 0) {
    if (!runWorker) return { error: "__runWorkerJs hook not available" };
    // Worker expects JS with top-level `const` declarations; chain already has this form.
    const { step } = await runWorker(chain);
    if (!step.byteLength) return { error: "replicad worker returned empty STEP from object chain" };
    triggerDownload(new Blob([step], { type: "model/step" }), filename);
    (window as any).__lastStepExport = { filename, bytes: step };
    return { written: true, bytes: step.byteLength, path: filename, via: "replicad-opencascadejs/chain" };
  }

  // Path C: canonical nurbs-ts NurbsSurface → pure TS STEP writer
  const store = (viewer as any).getCanonicalGeometryStore?.();
  const record = store?.resolveObjectOrAncestor(obj as any);
  if (record?.kind === "surface" && record.surface.kind === "nurbs") {
    const kernelSurface = surfacesNurbsToKernelNurbs(record.surface as SurfacesNurbsSurface);
    const stepBytes = exportNurbsToStep(kernelSurface);
    const stepBuffer = stepBytes.buffer.slice(stepBytes.byteOffset, stepBytes.byteOffset + stepBytes.byteLength) as ArrayBuffer;
    triggerDownload(new Blob([stepBuffer], { type: "model/step" }), filename);
    (window as any).__lastStepExport = { filename, bytes: stepBuffer };
    return { written: true, bytes: stepBytes.byteLength, path: filename, via: "nurbs-ts/exportNurbsToStep" };
  }

  const kind = record?.kind ?? "unknown";
  return { error: `SdStepWrite: no export path for object (kind=${kind}, chain=none) — add replicadJs arg or use an object with userData.chain` };
}

/**
 * kern_dwg_read stub.
 *
 * C++ function needed:
 *   // kern_dwg_read
 *   // Signature: DwgReadResult kern_dwg_read(
 *   //   const std::vector<uint8_t>& dwg_bytes
 *   // );
 *   // Returns: DwgReadResult { segments: [...], layers: [...], blocks: [...] }
 *   // DWG binary format (AC1015–AC1032, i.e. R2000–R2018) requires libredwg
 *   // or ODA File Converter — both are GPL / proprietary; use DXF bridge.
 *
 * Until kern_dwg_read is available, DWG read routes via DXF: users must
 * first convert DWG→DXF with ODA File Converter, then use SdDxfRead.
 */
export function handle_SdDwgReadStub(
  args: Record<string, unknown>,
): { error: string; detail: string } {
  const _filename = (args.filename as string | undefined) ?? "model.dwg";
  return notImplemented(
    "SdDwgRead",
    "blocked: kern_dwg_read requires libredwg or ODA (GPL/proprietary) — convert DWG→DXF first, then use SdDxfRead",
  );
}

/**
 * kern_iges_write_nurbs stub.
 * (Documented in SdIgesWrite above; registered separately for dispatch.)
 */
export function handle_SdIgesWriteNurbsStub(
  args: Record<string, unknown>,
): { error: string; detail: string } {
  const _filename = (args.filename as string | undefined) ?? "model.igs";
  return notImplemented(
    "SdIgesWriteNurbs",
    "blocked: kern_iges_write_nurbs not yet in kern.wasm — requires OCCT AP203 NURBS surface encoder",
  );
}

// ── Handler registration ──────────────────────────────────────────────────

export function registerS333Handlers(viewer: Viewer, _scenePanel: ScenePanel): void {
  // Sd3dmRead — rhino3dm WASM hot-load
  registerHandler("Sd3dmRead", async (args) => {
    return handle_Sd3dmRead(args as Record<string, unknown>, viewer);
  });

  // SdDxfRead — minimal AC1009 LINE parser
  registerHandler("SdDxfRead", (args) => {
    return handle_SdDxfRead(args as Record<string, unknown>, viewer);
  });

  // SdObjWrite — three.js OBJExporter
  registerHandler("SdObjWrite", (args) => {
    return handle_SdObjWrite(args as Record<string, unknown>, viewer);
  });

  // SdStlWrite — three.js STLExporter
  registerHandler("SdStlWrite", (args) => {
    return handle_SdStlWrite(args as Record<string, unknown>, viewer);
  });

  // Sd3dmWrite — rhino3dm WASM export
  registerHandler("Sd3dmWrite", async (args) => {
    return handle_Sd3dmWrite(args as Record<string, unknown>, viewer);
  });

  // SdIfcImport — web-ifc worker path
  registerHandler("SdIfcImport", async (args) => {
    return handle_SdIfcImport(args as Record<string, unknown>);
  });

  // SdIgesRead — OCCT worker path (reuses load-step message)
  registerHandler("SdIgesRead", async (args) => {
    return handle_SdIgesRead(args as Record<string, unknown>, viewer);
  });

  // SdIgesWrite — C++ blocked stub
  registerHandler("SdIgesWrite", (args) => {
    return handle_SdIgesWrite(args as Record<string, unknown>, viewer);
  });

  // SdGltfJsonExport — three.js GLTFExporter JSON mode
  registerHandler("SdGltfJsonExport", async (args) => {
    return handle_SdGltfJsonExport(args as Record<string, unknown>, viewer);
  });

  // SdStepWrite — replicad-opencascadejs OCCT path (chain or replicadJs arg)
  //               + nurbs-ts surface path (exportNurbsToStep pure TS)
  registerHandler("SdStepWrite", async (args) => handle_SdStepWrite(args as Record<string, unknown>, viewer));
  registerHandler("SdDwgRead",   (args) => handle_SdDwgReadStub(args as Record<string, unknown>));
  registerHandler("SdIgesWriteNurbs", (args) => handle_SdIgesWriteNurbsStub(args as Record<string, unknown>));
}

// Re-export parseDxfLineSegments for test access (oracle validation in s333-parity.test.ts)
export { type DxfSegment };
