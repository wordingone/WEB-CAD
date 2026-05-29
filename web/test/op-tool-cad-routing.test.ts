import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("CAD/BRep op-tool command parity", () => {
  test("visible CAD/BRep op-tool completions route through agent-facing Sd handlers", () => {
    const source = readFileSync(new URL("../src/viewer/op-tool.ts", import.meta.url), "utf8");

    for (const command of ["SdExtrude", "SdLoft", "SdSweep", "SdRevolve", "SdPlane", "SdSurface", "SdExplode", "SdJoin", "SdRebuild", "SdContour"]) {
      expect(source, command).toContain(`dispatchSync("${command}"`);
    }
  });

  test("extrude completion no longer commits through private mesh construction", () => {
    const source = readFileSync(new URL("../src/viewer/op-tool.ts", import.meta.url), "utf8");
    const start = source.indexOf('if (phase.kind === "extrude_height")');
    const end = source.indexOf('if (phase.kind === "loft_curve1")');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const extrudeCommit = source.slice(start, end);

    expect(extrudeCommit).toContain('dispatchSync("SdExtrude"');
    expect(extrudeCommit).not.toContain("opBuildExtrudeMesh");
    expect(extrudeCommit).not.toContain("linkOpToolExtrudeCanonical");
    expect(extrudeCommit).not.toContain("viewer.addMesh");
  });

  test("BRep palette completions no longer mutate scene locally instead of dispatching Sd ops", () => {
    const source = readFileSync(new URL("../src/viewer/op-tool.ts", import.meta.url), "utf8");
    const start = source.indexOf('if (phase.kind === "brep_explode_pick")');
    const end = source.indexOf('if (phase.kind === "bool_a")');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const brepCommit = source.slice(start, end);

    for (const command of ["SdExplode", "SdJoin", "SdRebuild", "SdContour"]) {
      expect(brepCommit, command).toContain(`dispatchSync("${command}"`);
    }
    expect(brepCommit).not.toContain("scene.remove");
    expect(brepCommit).not.toContain("scene.add");
    expect(brepCommit).not.toContain("new THREE.Group");
    expect(brepCommit).not.toContain("new THREE.Line");
    expect(brepCommit).not.toContain("pushAction");
    expect(brepCommit).not.toContain("pushReplaceAction");
  });

  test("fillet palette completions route all 3D mesh edit paths through SdFillet", () => {
    const source = readFileSync(new URL("../src/viewer/op-tool.ts", import.meta.url), "utf8");
    const start = source.indexOf('if (phase.kind === "fillet_radius")');
    const end = source.indexOf('if (phase.kind === "label_text")', start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const filletCommit = source.slice(start, end);

    expect(filletCommit).toContain('dispatchSync("SdFillet"');
    expect(filletCommit).toContain("edgeFrom");
    expect(filletCommit).not.toContain("filletMesh(");
    expect(filletCommit).not.toContain("chamferEdge(");
    expect(filletCommit).not.toContain("linkPlanarizedMeshEditBrep");
    expect(filletCommit).not.toContain("viewer.addMesh");
    expect(filletCommit).not.toContain("pushReplaceAction");
  });

  test("along-curve array completion routes through one agent-facing SdArrayAlongCurve command", () => {
    const source = readFileSync(new URL("../src/viewer/op-tool.ts", import.meta.url), "utf8");
    const start = source.indexOf('if (phase.kind === "array_curve_count")');
    const end = source.indexOf('if (phase.kind === "array_polar_count")', start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const arrayCurveCommit = source.slice(start, end);

    expect(arrayCurveCommit).toContain('dispatchSync("SdArrayAlongCurve"');
    expect(arrayCurveCommit).toContain("path:");
    expect(arrayCurveCommit).not.toContain('dispatchSync("SdCopy"');
    expect(arrayCurveCommit).not.toContain("new THREE.Box3");
    expect(arrayCurveCommit).not.toContain("_sampleAlongCurve");
  });

  test("selection subtool completions route through agent-facing Sd handlers", () => {
    const toolsSource = readFileSync(new URL("../src/tools/index.ts", import.meta.url), "utf8");
    const pointerUpStart = toolsSource.indexOf('vpBody.addEventListener("pointerup"');
    const pointerUpEnd = toolsSource.indexOf('window.addEventListener("keydown"', pointerUpStart + 1);
    expect(pointerUpStart).toBeGreaterThanOrEqual(0);
    expect(pointerUpEnd).toBeGreaterThan(pointerUpStart);
    const pointerUpCommit = toolsSource.slice(pointerUpStart, pointerUpEnd);

    expect(pointerUpCommit).toContain('dispatchSync("SdSelectWindow"');
    expect(pointerUpCommit).toContain('dispatchSync("SdSelectLasso"');
    expect(pointerUpCommit).not.toContain("runRectSel(");
    expect(pointerUpCommit).not.toContain("runPolySel(");

    const opToolSource = readFileSync(new URL("../src/viewer/op-tool.ts", import.meta.url), "utf8");
    const boundaryPick = opToolSource.slice(
      opToolSource.indexOf('if (phase.kind === "sel_boundary_pick")'),
      opToolSource.indexOf('if (phase.kind === "sel_boundary_draw")'),
    );
    const boundaryDrawStart = opToolSource.indexOf('if (phase.kind === "sel_boundary_draw" && phase.points.length >= 3)');
    const boundaryDrawEnd = opToolSource.indexOf('if (phase.kind === "dim_area"', boundaryDrawStart + 1);
    expect(boundaryDrawStart).toBeGreaterThanOrEqual(0);
    expect(boundaryDrawEnd).toBeGreaterThan(boundaryDrawStart);
    const boundaryDraw = opToolSource.slice(boundaryDrawStart, boundaryDrawEnd);

    expect(boundaryPick).toContain('dispatchSync("SdSelectBoundary"');
    expect(boundaryDraw).toContain('dispatchSync("SdSelectBoundary"');
    expect(boundaryPick).not.toContain("_hooks.runPolySel");
    expect(boundaryDraw).not.toContain("_hooks.runPolySel");
  });
});
