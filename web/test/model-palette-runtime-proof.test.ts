import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MODEL_PALETTE_CAUSAL_SPECS } from "../src/shell/model-palette-causal-map";

type ProofCase = {
  file: string;
  tokens: string[];
};

const GEOMETRY_OUTCOMES = new Set([
  "canonical-curve",
  "canonical-point",
  "canonical-surface",
  "canonical-brep",
  "canonical-brep-edit",
  "canonical-brep-derived-curves",
  "canonical-reference",
  "canonical-annotation-curve",
  "dom-annotation",
]);

const PROOF_BY_COMMAND: Record<string, ProofCase> = {
  SdLine: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdLine\"", "expectedCurveKind: \"nurbs\""] },
  SdRectangle: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdRectangle\"", "expectedCurveKind: \"polyline\""] },
  SdCircle: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdCircle\"", "expectedCurveKind: \"arc\""] },
  SdPolygon: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdPolygon\"", "expectedCurveKind: \"polyline\""] },
  SdArc: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdArc\"", "expectedCurveKind: \"arc\""] },
  SdPolyline: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdPolyline\"", "expectedCurveKind: \"polyline\""] },
  SdCurve: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdCurve\"", "expectedCurveKind: \"nurbs\""] },
  SdSpline: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdSpline\"", "expectedCurveKind: \"nurbs\""] },
  SdPoint: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdPoint\"", "expectedKind: \"point\""] },

  SdExtrude: { file: "brep-canonical-characterization.test.ts", tokens: ["SdExtrude links profile extrusion output to a canonical BRep", "expected canonical brep"] },
  SdLoft: { file: "surface-nurbs-userdata.test.ts", tokens: ["SdLoft", "expected canonical surface"] },
  SdSweep: { file: "surface-nurbs-userdata.test.ts", tokens: ["SdSweep", "expected canonical surface"] },
  SdRevolve: { file: "surface-nurbs-userdata.test.ts", tokens: ["SdRevolve", "expected canonical brep"] },
  SdPlane: { file: "surface-nurbs-userdata.test.ts", tokens: ["SdPlane", "expected canonical surface"] },
  SdSurface: { file: "surface-nurbs-userdata.test.ts", tokens: ["SdSurface", "expected canonical brep"] },
  SdBoolean: { file: "transforms.test.ts", tokens: ["SdBoolean", "canonical BRep"] },
  SdBooleanUnion: { file: "transforms.test.ts", tokens: ["SdBooleanUnion", "canonical BRep result"] },
  SdBooleanDifference: { file: "transforms.test.ts", tokens: ["SdBooleanDifference", "refuses mesh-derived fallback"] },
  SdBooleanIntersection: { file: "brep-boolean.test.ts", tokens: ["SdBooleanIntersection", "schema"] },
  SdFillet: { file: "transforms.test.ts", tokens: ["SdFillet", "canonical BRep record"] },
  SdExplode: { file: "brep-canonical-characterization.test.ts", tokens: ["SdExplode", "expected exploded canonical brep"] },
  SdJoin: { file: "brep-canonical-characterization.test.ts", tokens: ["SdJoin", "expected joined canonical brep"] },
  SdRebuild: { file: "brep-canonical-characterization.test.ts", tokens: ["SdRebuild", "replaces a canonical BRep"] },
  SdContour: { file: "brep-canonical-characterization.test.ts", tokens: ["SdContour", "expected contour canonical curve"] },

  SdWall: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdWall\"", "canonical BRep"] },
  SdCurveWall: { file: "transforms.test.ts", tokens: ["SdCurveWall", "canonical NURBS BRep faces"] },
  SdSlab: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdSlab\"", "canonical BReps"] },
  SdColumn: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdColumn\"", "canonical BReps"] },
  SdBeam: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdBeam\"", "canonical BReps"] },
  SdRoof: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: /^SdRoof/", "canonical BReps"] },
  SdSpace: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdSpace\"", "canonical BReps"] },
  SdFoundation: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdFoundation\"", "canonical BReps"] },
  SdCeiling: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdCeiling\"", "canonical BReps"] },
  SdStair: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: /^SdStair/", "canonical BReps"] },
  SdDoor: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdDoor\"", "canonical BRep envelopes"] },
  SdWindow: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdWindow\"", "canonical BRep envelopes"] },
  SdRamp: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdRamp\"", "canonical BRep"] },
  SdRailing: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdRailing\"", "canonical BRep"] },
  SdCurtainWall: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdCurtainWall\"", "canonical BRep"] },
  SdSkylight: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdSkylight\"", "canonical BRep"] },
  SdOpening: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdOpening\"", "canonical BRep envelopes"] },

  SdRefGrid: { file: "canonical-datum-geometry.test.ts", tokens: ["SdRefGrid", "canonical reference curve"] },
  SdLevel: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdLevel\"", "canonical surface"] },
  SdDatum: { file: "transforms.test.ts", tokens: ["expectedCreatedBy: \"SdDatum\"", "canonical curves"] },

  SdAlignedDim: { file: "annotation-tool-routing.test.ts", tokens: ["SdAlignedDim", "canonical curve"] },
  SdAngularDim: { file: "annotation-tool-routing.test.ts", tokens: ["SdAngularDim", "canonical curve"] },
  SdAreaDim: { file: "annotation-tool-routing.test.ts", tokens: ["SdAreaDim", "canonical curve"] },
  SdVolumeDim: { file: "annotation-tool-routing.test.ts", tokens: ["SdVolumeDim", "canonical curve"] },
  SdLabel: { file: "annotation-tool-routing.test.ts", tokens: ["SdLabel", "ok"] },
  SdTransientMeasure: { file: "annotation-tool-routing.test.ts", tokens: ["SdTransientMeasure", "canonical curve"] },
};

function source(file: string): string {
  return readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
}

describe("MODEL palette runtime proof index", () => {
  test("every geometry-producing palette command has a concrete runtime proof file", () => {
    const commands = [...new Set(Object.values(MODEL_PALETTE_CAUSAL_SPECS)
      .filter((spec) => GEOMETRY_OUTCOMES.has(spec.canonicalOutcome))
      .map((spec) => spec.command))].sort();

    expect(Object.keys(PROOF_BY_COMMAND).sort()).toEqual(commands);

    for (const [command, proof] of Object.entries(PROOF_BY_COMMAND)) {
      const body = source(proof.file);
      expect(body, `${command} proof file ${proof.file}`).toContain(command);
      for (const token of proof.tokens) {
        expect(body, `${command} proof token ${token}`).toContain(token);
      }
    }
  });
});
