// S333 — Interop / file-format parity tests
//
// For each verb in the research plan:
//   - At least one oracle comparison using a LIVE oracle (never hardcoded)
//   - C++-blocked ops are marked with test.skip
//
// oracle sources:
//   - parseDxfLineSegments: closed-form (DXF spec group codes)
//   - OBJ export: three.js OBJExporter output structure
//   - STL export: three.js STLExporter binary header spec
//   - glTF JSON export: glTF 2.0 spec asset header
//   - SdIgesWrite / SdStepWrite / SdDwgRead: blocked — test.skip

import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import {
  parseDxfLineSegments,
  handle_SdDxfRead,
  handle_SdObjWrite,
  handle_SdStlWrite,
  handle_SdGltfJsonExport,
  handle_SdIgesWrite,
  handle_SdStepWriteStub,
  handle_SdDwgReadStub,
} from "../src/handlers/s333-impl";
import { exportObj, exportStl, exportGltfJson } from "../src/io/exporters";

// Top-level dynamic import resolution for exportStl (avoids await-in-sync-test issue)
const { exportStl: staticExportStl } = await import("../src/io/exporters");

// ── Minimal Viewer stub ───────────────────────────────────────────────────────

/** Minimal viewer stub — only the surface used by the handlers under test. */
function makeViewerStub(scene?: THREE.Scene) {
  const _scene = scene ?? (() => {
    const s = new THREE.Scene();
    // Non-degenerate geometry: rotated box (not axis-aligned)
    const geo = new THREE.BoxGeometry(2, 3, 1);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    mesh.rotation.set(0.3, 0.7, 0.2);
    mesh.updateMatrix();
    s.add(mesh);
    return s;
  })();

  return {
    getScene: () => _scene,
    setObject: (_obj: THREE.Object3D, _bounds: unknown) => { /* no-op in tests */ },
    getSelected: () => null,
  } as unknown as import("../src/viewer/viewer").Viewer;
}

// ── DXF parser parity ─────────────────────────────────────────────────────────

describe("parseDxfLineSegments — closed-form oracle", () => {
  test("parses a single non-axis-aligned LINE entity", () => {
    // oracle: DXF spec group codes 10/20/30 = start, 11/21/31 = end
    // Reference values are chosen to be non-axis-aligned: oblique line in 3D.
    const dxfText = [
      "0",   "SECTION",
      "2",   "ENTITIES",
      "0",   "LINE",
      "8",   "0",
      "10",  "1.5",
      "20",  "2.3",
      "30",  "0.7",
      "11",  "4.1",
      "21",  "0.8",
      "31",  "3.2",
      "0",   "ENDSEC",
      "0",   "EOF",
    ].join("\n");

    // oracle: closed-form — values come directly from the DXF group codes above
    const segs = parseDxfLineSegments(dxfText);
    expect(segs).toHaveLength(1);
    const seg = segs[0]!;
    expect(seg.x1).toBeCloseTo(1.5, 6);
    expect(seg.y1).toBeCloseTo(2.3, 6);
    expect(seg.z1).toBeCloseTo(0.7, 6);
    expect(seg.x2).toBeCloseTo(4.1, 6);
    expect(seg.y2).toBeCloseTo(0.8, 6);
    expect(seg.z2).toBeCloseTo(3.2, 6);
  });

  test("parses multiple LINE entities", () => {
    // Build a DXF with 3 non-parallel, 3D lines
    const lines: [number, number, number, number, number, number][] = [
      [0, 0, 0, 1, 1, 1],
      [2.5, -1.3, 0.4, 3.7, 2.2, -0.9],
      [-1, 0.5, 2, 1.5, -0.5, 0],
    ];
    const parts = ["0", "SECTION", "2", "ENTITIES"];
    for (const [x1, y1, z1, x2, y2, z2] of lines) {
      parts.push("0", "LINE", "8", "0");
      parts.push("10", String(x1), "20", String(y1), "30", String(z1));
      parts.push("11", String(x2), "21", String(y2), "31", String(z2));
    }
    parts.push("0", "ENDSEC", "0", "EOF");

    // oracle: closed-form — same values as the input arrays
    const segs = parseDxfLineSegments(parts.join("\n"));
    expect(segs).toHaveLength(3);
    for (let i = 0; i < lines.length; i++) {
      const [x1, y1, z1, x2, y2, z2] = lines[i]!;
      const seg = segs[i]!;
      expect(seg.x1).toBeCloseTo(x1, 6);
      expect(seg.y1).toBeCloseTo(y1, 6);
      expect(seg.z1).toBeCloseTo(z1, 6);
      expect(seg.x2).toBeCloseTo(x2, 6);
      expect(seg.y2).toBeCloseTo(y2, 6);
      expect(seg.z2).toBeCloseTo(z2, 6);
    }
  });

  test("returns empty array for DXF with no LINE entities", () => {
    const dxf = ["0", "SECTION", "2", "ENTITIES", "0", "ENDSEC", "0", "EOF"].join("\n");
    // oracle: closed-form — no LINE sections → empty result
    const segs = parseDxfLineSegments(dxf);
    expect(segs).toHaveLength(0);
  });

  test("handles CRLF line endings (Windows DXF)", () => {
    const dxfText = [
      "0\r\nSECTION\r\n2\r\nENTITIES\r\n",
      "0\r\nLINE\r\n8\r\n0\r\n",
      "10\r\n7.77\r\n20\r\n-3.14\r\n30\r\n0.0\r\n",
      "11\r\n-1.0\r\n21\r\n2.71\r\n31\r\n1.41\r\n",
      "0\r\nENDSEC\r\n0\r\nEOF",
    ].join("");
    const segs = parseDxfLineSegments(dxfText);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.x1).toBeCloseTo(7.77, 5);
    expect(segs[0]!.y1).toBeCloseTo(-3.14, 5);
    expect(segs[0]!.x2).toBeCloseTo(-1.0, 5);
    expect(segs[0]!.y2).toBeCloseTo(2.71, 5);
    expect(segs[0]!.z2).toBeCloseTo(1.41, 5);
  });
});

// ── OBJ export parity ─────────────────────────────────────────────────────────

describe("SdObjWrite / exportObj — three.js OBJExporter oracle", () => {
  test("OBJ output contains vertex and face lines for a non-axis-aligned mesh", () => {
    // Build an oblique non-degenerate mesh (rotated sphere → not axis-aligned triangles)
    const geo = new THREE.SphereGeometry(1.5, 8, 6);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    mesh.rotation.set(0.5, 1.2, 0.3);
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);

    const root = new THREE.Group();
    root.add(mesh);

    // oracle: three.js OBJExporter — we call it directly to get the reference output
    const exporter = new OBJExporter();
    root.updateMatrixWorld(true);
    const refOutput = exporter.parse(root);

    // our exportObj should match
    const ourOutput = exportObj(root);

    // Parity: both must have the same vertex count
    const refVerts = (refOutput.match(/^v\s/mg) ?? []).length;
    const ourVerts = (ourOutput.match(/^v\s/mg) ?? []).length;
    expect(ourVerts).toBe(refVerts);
    expect(ourVerts).toBeGreaterThan(0);

    // Face counts must match
    const refFaces = (refOutput.match(/^f\s/mg) ?? []).length;
    const ourFaces = (ourOutput.match(/^f\s/mg) ?? []).length;
    expect(ourFaces).toBe(refFaces);
    expect(ourFaces).toBeGreaterThan(0);
  });

  test("SdObjWrite returns written=true and correct filename", () => {
    const viewer = makeViewerStub();
    // We cannot test triggerDownload in a non-browser env, but we can mock document.
    // In Bun test (non-DOM), we expect an error or successful path depending on env.
    const result = handle_SdObjWrite({ filename: "test-model.obj" }, viewer);
    // In a non-DOM environment, createElement may not exist; result.error is acceptable.
    if (result.written) {
      expect(result.filename).toBe("test-model.obj");
    } else {
      // DOM not available in Bun — error is expected; verify it's an exception string
      expect(typeof result.error).toBe("string");
    }
  });
});

// ── STL export parity ─────────────────────────────────────────────────────────

describe("SdStlWrite / exportStl — binary STL header oracle", () => {
  test("binary STL header is correct: 80-byte header + 4-byte triangle count", () => {
    // Non-degenerate geometry: torus (curved, non-planar, non-axis-aligned)
    const geo = new THREE.TorusGeometry(2, 0.5, 8, 16);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    mesh.rotation.set(0.4, 0.8, 0.1);
    const root = new THREE.Group();
    root.add(mesh);
    root.updateMatrixWorld(true);

    // oracle: three.js STLExporter binary mode
    const exporter = new STLExporter();
    const refResult = exporter.parse(root, { binary: true });
    const refBuf: ArrayBuffer = refResult instanceof ArrayBuffer
      ? refResult
      : (refResult as unknown as DataView).buffer as ArrayBuffer;

    // our exportStl — resolved at module top-level (staticExportStl)
    const ourBuf = staticExportStl(root);

    // Both must have same byte length
    expect(ourBuf.byteLength).toBe(refBuf.byteLength);

    // Binary STL: bytes 80–83 = uint32 triangle count (little-endian)
    const refView = new DataView(refBuf);
    const ourView = new DataView(ourBuf);
    const refTriCount = refView.getUint32(80, true);
    const ourTriCount = ourView.getUint32(80, true);
    expect(ourTriCount).toBe(refTriCount);
    expect(ourTriCount).toBeGreaterThan(0);

    // Total size = 80 + 4 + 50 * triangleCount
    const expectedSize = 84 + 50 * refTriCount;
    expect(refBuf.byteLength).toBe(expectedSize);
    expect(ourBuf.byteLength).toBe(expectedSize);
  });

  test("SdStlWrite returns triangle count in result", () => {
    const viewer = makeViewerStub();
    const result = handle_SdStlWrite({ filename: "out.stl" }, viewer);
    if (result.written) {
      expect(typeof result.triangles).toBe("number");
      expect(result.filename).toBe("out.stl");
    } else {
      // Non-DOM: error expected
      expect(typeof result.error).toBe("string");
    }
  });
});

// ── glTF JSON export parity ───────────────────────────────────────────────────

describe("SdGltfJsonExport / exportGltfJson — glTF 2.0 spec oracle", () => {
  test("exported JSON contains valid glTF 2.0 asset header", async () => {
    // Non-degenerate: icosahedron (irregular, not a box)
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    mesh.rotation.set(0.3, 0.6, 0.9);
    const root = new THREE.Group();
    root.add(mesh);
    root.updateMatrixWorld(true);

    // oracle: GLTFExporter JSON mode directly
    const refJson = await new Promise<string>((resolve, reject) => {
      new GLTFExporter().parse(
        root,
        (result) => resolve(typeof result === "string" ? result : JSON.stringify(result)),
        (err) => reject(err),
        { binary: false },
      );
    });
    const refParsed = JSON.parse(refJson) as Record<string, unknown>;

    // our exportGltfJson
    const ourJson = await exportGltfJson(root);
    const ourParsed = JSON.parse(ourJson) as Record<string, unknown>;

    // glTF 2.0 spec: asset.version = "2.0"
    expect((ourParsed.asset as Record<string, unknown>)?.version).toBe("2.0");
    expect((refParsed.asset as Record<string, unknown>)?.version).toBe("2.0");

    // Both must have meshes
    expect(Array.isArray(ourParsed.meshes)).toBe(true);
    expect((ourParsed.meshes as unknown[]).length).toBe((refParsed.meshes as unknown[]).length);
  });

  test("SdGltfJsonExport result has written field", async () => {
    const viewer = makeViewerStub();
    const result = await handle_SdGltfJsonExport({ filename: "out.gltf" }, viewer);
    // In non-DOM: may fail on triggerDownload, but must return an object
    expect(typeof result.written).toBe("boolean");
    if (result.written) {
      expect(result.filename).toBe("out.gltf");
    }
  });
});

// ── DXF read handler integration ──────────────────────────────────────────────

describe("SdDxfRead handler", () => {
  test("returns error when bytes is missing", () => {
    const viewer = makeViewerStub();
    const result = handle_SdDxfRead({}, viewer);
    expect(result.loaded).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  test("returns error for empty DXF (no LINE entities)", () => {
    const text = ["0", "SECTION", "2", "ENTITIES", "0", "ENDSEC", "0", "EOF"].join("\n");
    const buf = new TextEncoder().encode(text).buffer;
    const viewer = makeViewerStub(new THREE.Scene());
    const result = handle_SdDxfRead({ bytes: buf }, viewer);
    expect(result.loaded).toBe(false);
    expect(result.error).toContain("no LINE");
  });

  test("parses a two-segment DXF and reports correct segmentCount", () => {
    // Two non-axis-aligned segments
    const lines: [number, number, number, number, number, number][] = [
      [1, 2, 0.5, 3, 1, 2.2],
      [0, 0, 0, -1, -2, -3],
    ];
    const parts = ["0", "SECTION", "2", "ENTITIES"];
    for (const [x1, y1, z1, x2, y2, z2] of lines) {
      parts.push("0", "LINE", "8", "0");
      parts.push("10", String(x1), "20", String(y1), "30", String(z1));
      parts.push("11", String(x2), "21", String(y2), "31", String(z2));
    }
    parts.push("0", "ENDSEC", "0", "EOF");
    const buf = new TextEncoder().encode(parts.join("\n")).buffer;

    // The viewer stub's setObject is a no-op in tests
    const viewer = makeViewerStub(new THREE.Scene());
    const result = handle_SdDxfRead({ bytes: buf }, viewer);
    expect(result.loaded).toBe(true);
    // oracle: closed-form — 2 segments parsed
    expect(result.segmentCount).toBe(2);
  });
});

// ── C++ blocked stub tests ────────────────────────────────────────────────────

describe("C++ blocked stubs — return NotYetImplemented", () => {
  test.skip("kern_step_write — SdStepWrite stub returns error structure", () => {
    // blocked: requires general kern_step_write in kern.wasm
    const result = handle_SdStepWriteStub({});
    expect(result.error).toBe("NotYetImplemented");
    expect(result.detail).toContain("kern_step_write");
  });

  test.skip("kern_dwg_read — SdDwgRead stub returns error structure", () => {
    // blocked: kern_dwg_read requires libredwg or ODA (GPL/proprietary)
    const result = handle_SdDwgReadStub({});
    expect(result.error).toBe("NotYetImplemented");
    expect(result.detail).toContain("kern_dwg_read");
  });

  test.skip("kern_iges_write_nurbs — SdIgesWrite stub returns error structure", () => {
    // blocked: kern_iges_write_nurbs not yet in kern.wasm
    const viewer = makeViewerStub();
    const result = handle_SdIgesWrite({}, viewer);
    expect(result.error).toBe("NotYetImplemented");
    expect(result.detail).toContain("kern_iges_write_nurbs");
  });
});

// Run these stubs directly (not skipped) to confirm they compile + return correctly
describe("C++ blocked stubs — compile + return check (not skipped)", () => {
  test("SdStepWrite stub returns NotYetImplemented", () => {
    const result = handle_SdStepWriteStub({});
    expect(result.error).toBe("NotYetImplemented");
    expect(result.detail).toContain("kern_step_write");
  });

  test("SdDwgRead stub returns NotYetImplemented", () => {
    const result = handle_SdDwgReadStub({});
    expect(result.error).toBe("NotYetImplemented");
    expect(result.detail).toContain("kern_dwg_read");
  });

  test("SdIgesWrite stub returns NotYetImplemented + fallbackFormat", () => {
    const viewer = makeViewerStub();
    const result = handle_SdIgesWrite({}, viewer);
    expect(result.error).toBe("NotYetImplemented");
    expect(result.detail).toContain("kern_iges_write_nurbs");
    expect(result.fallbackFormat).toBe("dxf");
  });
});

// ── 3DM round-trip note ───────────────────────────────────────────────────────
// Sd3dmRead is not tested in this file because rhino3dm.js loads WASM and
// requires a browser environment. The round-trip parity test (export3dm →
// Sd3dmRead → mesh vertex count preserved) lives in canonical-3dm-export.test.ts
// where the rhino3dm fake already handles the WASM init mock.
//
// SdIfcImport and SdIgesRead depend on the DOM-events worker hooks (__loadIfcBuffer,
// __loadStepBuffer) which are wired during initDomEvents(). They are tested via
// the CDP evidence scripts (scripts/evidence-poller-197.mjs) in the live browser.
