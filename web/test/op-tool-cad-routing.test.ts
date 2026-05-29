import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("CAD/BRep op-tool command parity", () => {
  test("visible CAD/BRep op-tool completions route through agent-facing Sd handlers", () => {
    const source = readFileSync(new URL("../src/viewer/op-tool.ts", import.meta.url), "utf8");

    for (const command of ["SdExtrude", "SdLoft", "SdSweep", "SdRevolve", "SdPlane", "SdSurface", "SdExplode", "SdJoin", "SdRebuild", "SdContour"]) {
      expect(source, command).toContain(`dispatchSync("${command}"`);
    }
  });

  test("op-tool command completions unwrap dispatch envelopes and handler-level errors", () => {
    const source = readFileSync(new URL("../src/viewer/op-tool.ts", import.meta.url), "utf8");
    const helperStart = source.indexOf("function dispatchFailure");
    const helperEnd = source.indexOf("function extractLinePoints", helperStart + 1);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helper = source.slice(helperStart, helperEnd);
    expect(helper).toContain("if (!result.ok)");
    expect(helper).toContain('"error" in payload');

    const clickStart = source.indexOf("export function opHandleClick");
    const clickEnd = source.indexOf("export function opHandleEnter", clickStart + 1);
    const coordStart = source.indexOf("export function opHandleCoordSubmit");
    const coordEnd = source.indexOf("export function opStartTool", coordStart + 1);
    expect(clickStart).toBeGreaterThanOrEqual(0);
    expect(clickEnd).toBeGreaterThan(clickStart);
    expect(coordStart).toBeGreaterThanOrEqual(0);
    expect(coordEnd).toBeGreaterThan(coordStart);
    const completions = source.slice(clickStart, clickEnd) + source.slice(coordStart, coordEnd);

    expect(completions).not.toContain("as { error?: string }");
    expect(completions).not.toContain("result?.error");
    expect(completions).not.toContain("res?.error");
    for (const command of ["SdExtrude", "SdLoft", "SdSweep", "SdRevolve", "SdPlane", "SdSurface", "SdExplode", "SdJoin", "SdRebuild", "SdContour", "SdFillet"]) {
      const idx = completions.indexOf(`dispatchSync("${command}"`);
      expect(idx, command).toBeGreaterThanOrEqual(0);
      const local = completions.slice(idx, idx + 500);
      expect(local, command).toContain("dispatchFailure(");
    }
  });

  test("boolean intersection uses intersection semantics from palette to Sd command", () => {
    const source = readFileSync(new URL("../src/viewer/op-tool.ts", import.meta.url), "utf8");
    const boolStart = source.indexOf("function opExecBoolean");
    const boolEnd = source.indexOf("function opShowBoolChooser", boolStart + 1);
    const startHandlers = source.slice(
      source.indexOf('} else if (tool === "boolean")'),
      source.indexOf('} else if (tool === "brep-explode")'),
    );

    expect(boolStart).toBeGreaterThanOrEqual(0);
    expect(boolEnd).toBeGreaterThan(boolStart);
    const boolExec = source.slice(boolStart, boolEnd);

    expect(source).toContain('presetOp?: "union" | "difference" | "intersection"');
    expect(startHandlers).toContain('tool === "bool-intersect"');
    expect(startHandlers).toContain('presetOp: "intersection"');
    expect(boolExec).toContain(': "SdBooleanIntersection"');
    expect(boolExec).toContain('op === "intersection"');
    expect(boolExec).not.toContain('op === "split"');
    expect(boolExec).not.toContain('boolean-split');
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

  test("loft sweep and revolve palette completions preserve closed-solid BRep intent", () => {
    const source = readFileSync(new URL("../src/viewer/op-tool.ts", import.meta.url), "utf8");
    const loftStart = source.indexOf('if (phase.kind === "loft_curve2")');
    const loftEnd = source.indexOf('if (phase.kind === "sweep_rail")', loftStart + 1);
    const sweepStart = source.indexOf('if (phase.kind === "sweep_profile")');
    const sweepEnd = source.indexOf('if (phase.kind === "revolve_profile")', sweepStart + 1);
    const revolveStart = source.indexOf('if (phase.kind === "revolve_axis_b")');
    const revolveEnd = source.indexOf('if (phase.kind === "plane_pt1")', revolveStart + 1);
    expect(loftStart).toBeGreaterThanOrEqual(0);
    expect(loftEnd).toBeGreaterThan(loftStart);
    expect(sweepStart).toBeGreaterThanOrEqual(0);
    expect(sweepEnd).toBeGreaterThan(sweepStart);
    expect(revolveStart).toBeGreaterThanOrEqual(0);
    expect(revolveEnd).toBeGreaterThan(revolveStart);
    const loftCommit = source.slice(loftStart, loftEnd);
    const sweepCommit = source.slice(sweepStart, sweepEnd);
    const revolveCommit = source.slice(revolveStart, revolveEnd);

    expect(source).toContain("function extractLinePoints");
    expect(source).toContain("function pointsClosed");
    expect(loftCommit).toContain('dispatchSync("SdLoft"');
    expect(loftCommit).toContain("solid: pointsClosed(pts1) && pointsClosed(pts2)");
    expect(sweepCommit).toContain('dispatchSync("SdSweep"');
    expect(sweepCommit).toContain("solid: pointsClosed(profilePts)");
    expect(revolveCommit).toContain('dispatchSync("SdRevolve"');
    expect(revolveCommit).toContain("solid: true");
    expect(loftCommit).not.toContain("new THREE.Mesh");
    expect(sweepCommit).not.toContain("new THREE.Mesh");
    expect(revolveCommit).not.toContain("new THREE.Mesh");
  });

  test("boolean auto-extrudes closed sketch operands through SdExtrude instead of local mesh construction", () => {
    const source = readFileSync(new URL("../src/viewer/op-tool.ts", import.meta.url), "utf8");
    const helperStart = source.indexOf("function tryAutoExtrudeClosedSketchForBoolean");
    const helperEnd = source.indexOf("export function opHandleClick", helperStart + 1);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helper = source.slice(helperStart, helperEnd);
    const boolStart = source.indexOf('if (phase.kind === "bool_a")');
    const boolEnd = source.indexOf('if (phase.kind === "bool_op")', boolStart + 1);
    expect(boolStart).toBeGreaterThanOrEqual(0);
    expect(boolEnd).toBeGreaterThan(boolStart);
    const boolCommit = source.slice(boolStart, boolEnd);

    expect(helper).toContain('dispatchSync("SdExtrude"');
    expect(helper).toContain("object_id: profile.uuid");
    expect(helper).toContain("distance: 3.0");
    expect(helper).toContain("autoExtrudedForBoolean");
    expect(helper).not.toContain("opBuildExtrudeMesh");
    expect(helper).not.toContain("linkOpToolExtrudeCanonical");
    expect(boolCommit).toContain("tryAutoExtrudeClosedSketchForBoolean(viewer, objA)");
    expect(boolCommit).toContain("tryAutoExtrudeClosedSketchForBoolean(viewer, objB)");
    expect(boolCommit).not.toContain("linkOpToolExtrudeCanonical");
    expect(boolCommit).not.toContain("viewer.getScene().add(extruded)");
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
