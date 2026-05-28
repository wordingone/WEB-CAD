// IFC4 STEP-21 emitter — pure-build half of the IFC pipeline.
//
// Split out from ifc.ts so the buildIfc path is importable in non-browser
// environments (Bun self-harness, Node tests). Only the round-trip half in
// ifc.ts pulls in web-ifc + the `?url` WASM import that's Vite-specific.

import type { NurbsSurface as KernelNurbsSurface } from "../nurbs/nurbs-kernel.js";

export type IfcMesh = {
  vertices: Float32Array; // flat [x,y,z, ...]
  indices: Uint32Array;   // flat triangle indices into vertices
};

// 22-char IfcGloballyUniqueId (IFC4 spec): base64 with custom alphabet.
const IFC_GUID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

function ifcGuid(): string {
  // 128-bit random → 22 6-bit base64 chars (132 bits, top 4 padded with 0).
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 22; i++) {
    out = IFC_GUID_ALPHABET[Number(bits & 63n)] + out;
    bits >>= 6n;
  }
  return out;
}

const M_TO_FT = 1 / 0.3048; // 3.28084...

function stepFloat(n: number): string {
  // STEP requires explicit decimal point, no leading +.
  if (!isFinite(n)) return "0.";
  if (Number.isInteger(n)) return n.toFixed(1);
  return n.toString();
}

// Emit IFCUNITASSIGNMENT lines; returns the ref. When imperial, emits
// IFCCONVERSIONBASEDUNIT chains for foot/sq-ft/cu-ft. Scene geometry coords
// must be pre-scaled by M_TO_FT by the caller when imperial is true.
function emitUnits(lines: string[], next: () => string, imperial: boolean): string {
  const angUnit = next();
  lines.push(`${angUnit}=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);`);
  if (imperial) {
    const siLen = next();
    lines.push(`${siLen}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
    const mwuLen = next();
    lines.push(`${mwuLen}=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),${siLen});`);
    const lenUnit = next();
    lines.push(`${lenUnit}=IFCCONVERSIONBASEDUNIT(*,.LENGTHUNIT.,'FOOT',${mwuLen});`);
    const siArea = next();
    lines.push(`${siArea}=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);`);
    const mwuArea = next();
    lines.push(`${mwuArea}=IFCMEASUREWITHUNIT(IFCAREAMEASURE(0.09290304),${siArea});`);
    const areaUnit = next();
    lines.push(`${areaUnit}=IFCCONVERSIONBASEDUNIT(*,.AREAUNIT.,'SQUARE FOOT',${mwuArea});`);
    const siVol = next();
    lines.push(`${siVol}=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);`);
    const mwuVol = next();
    lines.push(`${mwuVol}=IFCMEASUREWITHUNIT(IFCVOLUMEMEASURE(0.028316846),${siVol});`);
    const volUnit = next();
    lines.push(`${volUnit}=IFCCONVERSIONBASEDUNIT(*,.VOLUMEUNIT.,'CUBIC FOOT',${mwuVol});`);
    const ua = next();
    lines.push(`${ua}=IFCUNITASSIGNMENT((${lenUnit},${angUnit},${areaUnit},${volUnit}));`);
    return ua;
  } else {
    const lenUnit = next();
    lines.push(`${lenUnit}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
    const areaUnit = next();
    lines.push(`${areaUnit}=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);`);
    const volUnit = next();
    lines.push(`${volUnit}=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);`);
    const ua = next();
    lines.push(`${ua}=IFCUNITASSIGNMENT((${lenUnit},${angUnit},${areaUnit},${volUnit}));`);
    return ua;
  }
}

function stepString(s: string): string {
  return `'${s.replace(/'/g, "\\'")}'`;
}

export type IfcSceneElement = {
  mesh: IfcMesh;
  creator: string;  // e.g. "IfcWall", "IfcSlab", "IfcColumn"
  label?: string;
  levelId?: string;                        // #243: storey assignment — matches IfcLevel.levelId
  dispatchArgs?: Record<string, unknown>;  // #244: numeric/string args → IfcPropertySet
  // §WEB-CAD#30 G9: when present, emit IfcAdvancedBrep instead of IfcFacetedBrep.
  nurbsSurface?: KernelNurbsSurface;
  nurbsSurfaces?: KernelNurbsSurface[];
};

// Caller passes one entry per level (from levelStore). buildIfcScene emits one
// IFCBUILDINGSTOREY per entry and groups elements accordingly (#243).
export type IfcLevel = { levelId: string; name: string; elevation: number };

// IFC4 entity name + trailing args after productShape for each creator.
// Entities not in this map fall back to IFCBUILDINGELEMENTPROXY.
const IFC4_ENTITY: Record<string, { name: string; tail: string }> = {
  IfcWall:    { name: "IFCWALL",                tail: ",$,.NOTDEFINED." },
  IfcSlab:    { name: "IFCSLAB",                tail: ",$,.NOTDEFINED." },
  IfcColumn:  { name: "IFCCOLUMN",              tail: ",$,.NOTDEFINED." },
  IfcBeam:    { name: "IFCBEAM",                tail: ",$,.NOTDEFINED." },
  IfcDoor:    { name: "IFCDOOR",                tail: ",$,.NOTDEFINED.,.NOTDEFINED.,$" },
  IfcWindow:  { name: "IFCWINDOW",              tail: ",$,.NOTDEFINED.,.NOTDEFINED.,$" },
  IfcRoof:    { name: "IFCROOF",                tail: ",$,.NOTDEFINED." },
  IfcStair:   { name: "IFCSTAIR",               tail: ",$,.NOTDEFINED." },
  IfcRamp:    { name: "IFCRAMP",                tail: ",$,.NOTDEFINED." },
  IfcRailing: { name: "IFCRAILING",             tail: ",$,.NOTDEFINED." },
  IfcSpace:   { name: "IFCSPACE",               tail: ",$,.SPACE.,$" },
};

// Returns the shared header + hierarchy (project/site/building) lines and refs.
// Storey(s) are emitted by the caller (one or many) under `building`.
function buildIfcHeader(lines: string[], next: () => string, imperial = false): {
  ownerHistory: string; ctx: string; localPlacement: string; axis3: string; building: string;
} {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "");

  lines.push("ISO-10303-21;");
  lines.push("HEADER;");
  lines.push(`FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');`);
  lines.push(`FILE_NAME(${stepString("web-cad-export.ifc")},${stepString(ts)},(${stepString("WEB-CAD")}),(${stepString("WEB-CAD")}),${stepString("web-ifc-emitter/0.1")},${stepString("WEB-CAD/0.1")},'');`);
  lines.push("FILE_SCHEMA(('IFC4'));");
  lines.push("ENDSEC;");
  lines.push("DATA;");

  const person = next();
  lines.push(`${person}=IFCPERSON($,$,${stepString("WEB-CAD")},$,$,$,$,$);`);
  const org = next();
  lines.push(`${org}=IFCORGANIZATION($,${stepString("WEB-CAD")},$,$,$);`);
  const personAndOrg = next();
  lines.push(`${personAndOrg}=IFCPERSONANDORGANIZATION(${person},${org},$);`);
  const app = next();
  lines.push(`${app}=IFCAPPLICATION(${org},${stepString("0.1")},${stepString("WEB-CAD web demo")},${stepString("web-cad-web")});`);
  const ownerHistory = next();
  const epoch = Math.floor(Date.now() / 1000);
  lines.push(`${ownerHistory}=IFCOWNERHISTORY(${personAndOrg},${app},$,.ADDED.,${epoch},${personAndOrg},${app},${epoch});`);

  const dirZ = next();
  lines.push(`${dirZ}=IFCDIRECTION((0.,0.,1.));`);
  const dirX = next();
  lines.push(`${dirX}=IFCDIRECTION((1.,0.,0.));`);
  const originPt = next();
  lines.push(`${originPt}=IFCCARTESIANPOINT((0.,0.,0.));`);
  const axis3 = next();
  lines.push(`${axis3}=IFCAXIS2PLACEMENT3D(${originPt},${dirZ},${dirX});`);
  const ctx = next();
  lines.push(`${ctx}=IFCGEOMETRICREPRESENTATIONCONTEXT($,${stepString("Model")},3,1.0E-5,${axis3},$);`);

  const unitAssignment = emitUnits(lines, next, imperial);

  const project = next();
  lines.push(`${project}=IFCPROJECT(${stepString(ifcGuid())},${ownerHistory},${stepString("GemmaCad Demo Project")},$,$,$,$,(${ctx}),${unitAssignment});`);

  const localPlacement = next();
  lines.push(`${localPlacement}=IFCLOCALPLACEMENT($,${axis3});`);

  const site = next();
  lines.push(`${site}=IFCSITE(${stepString(ifcGuid())},${ownerHistory},${stepString("Default Site")},$,$,${localPlacement},$,$,.ELEMENT.,$,$,$,$,$);`);
  const building = next();
  lines.push(`${building}=IFCBUILDING(${stepString(ifcGuid())},${ownerHistory},${stepString("Default Building")},$,$,${localPlacement},$,$,.ELEMENT.,$,$,$);`);

  const projAggSite = next();
  lines.push(`${projAggSite}=IFCRELAGGREGATES(${stepString(ifcGuid())},${ownerHistory},$,$,${project},(${site}));`);
  const siteAggBld = next();
  lines.push(`${siteAggBld}=IFCRELAGGREGATES(${stepString(ifcGuid())},${ownerHistory},$,$,${site},(${building}));`);

  return { ownerHistory, ctx, localPlacement, axis3, building };
}

// Emit IFCPROPERTYSET + IFCRELDEFINESBYPROPERTIES for numeric/string dispatchArgs (#244).
function emitElementPropertySet(
  el: IfcSceneElement,
  entityRef: string,
  ownerHistory: string,
  lines: string[],
  next: () => string,
): void {
  if (!el.dispatchArgs) return;
  const propRefs: string[] = [];
  for (const [key, val] of Object.entries(el.dispatchArgs)) {
    if (typeof val !== "number" && typeof val !== "string") continue;
    const propRef = next();
    const valStr = typeof val === "number"
      ? `IFCREAL(${stepFloat(val)})`
      : `IFCLABEL(${stepString(String(val))})`;
    lines.push(`${propRef}=IFCPROPERTYSINGLEVALUE(${stepString(key)},$,${valStr},$);`);
    propRefs.push(propRef);
  }
  if (propRefs.length === 0) return;
  const pset = next();
  lines.push(`${pset}=IFCPROPERTYSET(${stepString(ifcGuid())},${ownerHistory},${stepString("Pset_GemmaCadParams")},$,(${propRefs.join(",")}));`);
  const relDef = next();
  lines.push(`${relDef}=IFCRELDEFINESBYPROPERTIES(${stepString(ifcGuid())},${ownerHistory},$,$,(${entityRef}),${pset});`);
}

// Emit brep geometry for one mesh, return the IFCFACETEDBREP ref.
// scale is applied to every coordinate (1.0 for metric; M_TO_FT for imperial).
function emitMeshBrep(mesh: IfcMesh, lines: string[], next: () => string, scale = 1.0): string {
  const vertexIds: string[] = [];
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    const x = mesh.vertices[i] * scale, y = mesh.vertices[i + 1] * scale, z = mesh.vertices[i + 2] * scale;
    const pt = next();
    lines.push(`${pt}=IFCCARTESIANPOINT((${stepFloat(x)},${stepFloat(y)},${stepFloat(z)}));`);
    vertexIds.push(pt);
  }
  const faceIds: string[] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = vertexIds[mesh.indices[i]];
    const b = vertexIds[mesh.indices[i + 1]];
    const c = vertexIds[mesh.indices[i + 2]];
    const loop = next(); lines.push(`${loop}=IFCPOLYLOOP((${a},${b},${c}));`);
    const bound = next(); lines.push(`${bound}=IFCFACEOUTERBOUND(${loop},.T.);`);
    const face = next(); lines.push(`${face}=IFCFACE((${bound}));`);
    faceIds.push(face);
  }
  const shell = next(); lines.push(`${shell}=IFCCLOSEDSHELL((${faceIds.join(",")}));`);
  const brep = next(); lines.push(`${brep}=IFCFACETEDBREP(${shell});`);
  return brep;
}

// §WEB-CAD#30 G9: NURBS → IFC4 IfcAdvancedBrep emitter.
//
// Converts a flat knot vector (OpenNURBS / kernel convention) to the (distinct
// knot values, multiplicities) pair that IFC4 IfcBSplineSurface uses.
function flatKnotsToIfc(flat: number[]): { knots: number[]; mults: number[] } {
  const knots: number[] = [];
  const mults: number[] = [];
  for (const k of flat) {
    if (knots.length === 0 || k !== knots[knots.length - 1]) {
      knots.push(k);
      mults.push(1);
    } else {
      mults[mults.length - 1]++;
    }
  }
  return { knots, mults };
}

/**
 * Emit IfcRationalBSplineSurfaceWithKnots (or non-rational variant) + the
 * wrapping IfcAdvancedFace + IfcClosedShell + IfcAdvancedBrep.
 *
 * Returns the IFCADVANCEDBREP entity ref. The caller inserts it wherever
 * IFCFACETEDBREP would normally go in the product shape.
 *
 * Limitation (G9 scope): emits a single-face open brep — valid for IFC
 * shell-based surface models. Production-grade closed-brep (all 6 box faces)
 * is a follow-up.
 */
export function emitNurbsAdvancedBrep(
  surface: KernelNurbsSurface,
  lines: string[],
  next: () => string,
  scale = 1.0,
): string {
  const { degreeU, degreeV, controlPoints, weights, countU, countV, knotsU, knotsV } = surface;
  const isRational = weights.some((w) => Math.abs(w - 1.0) > 1e-10);

  // Emit control points: nU rows × nV cols.
  const cpRefs: string[][] = [];
  for (let i = 0; i < countU; i++) {
    const row: string[] = [];
    for (let j = 0; j < countV; j++) {
      const p = controlPoints[i * countV + j];
      const ref = next();
      lines.push(`${ref}=IFCCARTESIANPOINT((${stepFloat(p[0] * scale)},${stepFloat(p[1] * scale)},${stepFloat(p[2] * scale)}));`);
      row.push(ref);
    }
    cpRefs.push(row);
  }

  // 2D control-point list: ((row0),(row1),...).
  const cpList = `(${cpRefs.map((row) => `(${row.join(",")})`).join(",")})`;

  // Knot vectors → distinct + multiplicities.
  const ku = flatKnotsToIfc(knotsU);
  const kv = flatKnotsToIfc(knotsV);
  const multsU = `(${ku.mults.join(",")})`;
  const multsV = `(${kv.mults.join(",")})`;
  const knotsUStr = `(${ku.knots.map(stepFloat).join(",")})`;
  const knotsVStr = `(${kv.knots.map(stepFloat).join(",")})`;

  const surfRef = next();
  if (isRational) {
    // Weights: 2D array matching control-point layout.
    const wRows: string[] = [];
    for (let i = 0; i < countU; i++) {
      wRows.push(`(${Array.from({ length: countV }, (_, j) => stepFloat(weights[i * countV + j])).join(",")})`);
    }
    const wList = `(${wRows.join(",")})`;
    lines.push(
      `${surfRef}=IFCRATIONALBSPLINESURFACEWITHKNOTS(${degreeU},${degreeV},${cpList},.UNSPECIFIED.,.F.,.F.,.F.,${multsU},${multsV},${knotsUStr},${knotsVStr},.UNSPECIFIED.,${wList});`,
    );
  } else {
    lines.push(
      `${surfRef}=IFCBSPLINESURFACEWITHKNOTS(${degreeU},${degreeV},${cpList},.UNSPECIFIED.,.F.,.F.,.F.,${multsU},${multsV},${knotsUStr},${knotsVStr},.UNSPECIFIED.);`,
    );
  }

  // Wrap in IfcAdvancedFace (no boundary loop in this scaffold — G9 scope).
  const faceRef = next();
  lines.push(`${faceRef}=IFCADVANCEDFACE((),$,.T.);`);

  const shellRef = next();
  lines.push(`${shellRef}=IFCOPENSHELL((${faceRef}));`);

  const brepRef = next();
  lines.push(`${brepRef}=IFCSHELLBASEDSURFACEMODEL((${shellRef}));`);

  return brepRef;
}

// Sentinel key for elements with no matching levelId.
const FALLBACK_LEVEL_ID = "__default__";

export function buildIfcScene(elements: IfcSceneElement[], levels?: IfcLevel[], opts?: { imperial?: boolean }): Uint8Array {
  const lines: string[] = [];
  let id = 0;
  const next = () => `#${++id}`;
  const imperial = opts?.imperial ?? false;
  const coordScale = imperial ? M_TO_FT : 1.0;

  const { ownerHistory, ctx, localPlacement, axis3, building } = buildIfcHeader(lines, next, imperial);

  // ── Storey setup (#243) ──────────────────────────────────────────────────
  type StoreyBucket = { ref: string; entityRefs: string[] };
  const storeyMap = new Map<string, StoreyBucket>();

  if (levels && levels.length > 0) {
    const storeyRefs: string[] = [];
    for (const lev of levels) {
      const storeyRef = next();
      lines.push(`${storeyRef}=IFCBUILDINGSTOREY(${stepString(ifcGuid())},${ownerHistory},${stepString(lev.name)},$,$,${localPlacement},$,$,.ELEMENT.,${stepFloat(lev.elevation * coordScale)});`);
      storeyMap.set(lev.levelId, { ref: storeyRef, entityRefs: [] });
      storeyRefs.push(storeyRef);
    }
    // Unassigned storey for elements with no matching levelId.
    const unassigned = next();
    lines.push(`${unassigned}=IFCBUILDINGSTOREY(${stepString(ifcGuid())},${ownerHistory},${stepString("Unassigned")},$,$,${localPlacement},$,$,.ELEMENT.,0.);`);
    storeyMap.set(FALLBACK_LEVEL_ID, { ref: unassigned, entityRefs: [] });
    storeyRefs.push(unassigned);
    const bldAgg = next();
    lines.push(`${bldAgg}=IFCRELAGGREGATES(${stepString(ifcGuid())},${ownerHistory},$,$,${building},(${storeyRefs.join(",")}));`);
  } else {
    // Single default storey — backward-compatible path.
    const storey = next();
    lines.push(`${storey}=IFCBUILDINGSTOREY(${stepString(ifcGuid())},${ownerHistory},${stepString("Default Storey")},$,$,${localPlacement},$,$,.ELEMENT.,0.);`);
    storeyMap.set(FALLBACK_LEVEL_ID, { ref: storey, entityRefs: [] });
    const bldAgg = next();
    lines.push(`${bldAgg}=IFCRELAGGREGATES(${stepString(ifcGuid())},${ownerHistory},$,$,${building},(${storey}));`);
  }

  // ── Element geometry + property sets ────────────────────────────────────
  for (const el of elements) {
    const spec = IFC4_ENTITY[el.creator] ?? { name: "IFCBUILDINGELEMENTPROXY", tail: ",$,.NOTDEFINED." };
    const label = el.label ?? el.creator;

    const nurbsSurfaces = el.nurbsSurfaces && el.nurbsSurfaces.length > 0
      ? el.nurbsSurfaces
      : el.nurbsSurface ? [el.nurbsSurface] : [];
    // §WEB-CAD#30 G9: prefer NURBS path when canonical geometry carries convertible surfaces.
    const bodyItems = nurbsSurfaces.length > 0
      ? nurbsSurfaces.map((surface) => emitNurbsAdvancedBrep(surface, lines, next, coordScale))
      : [emitMeshBrep(el.mesh, lines, next, coordScale)];
    const repType = nurbsSurfaces.length > 0 ? "SurfaceModel" : "Brep";
    const shapeRep = next();
    lines.push(`${shapeRep}=IFCSHAPEREPRESENTATION(${ctx},${stepString("Body")},${stepString(repType)},(${bodyItems.join(",")}));`);
    const productShape = next();
    lines.push(`${productShape}=IFCPRODUCTDEFINITIONSHAPE($,$,(${shapeRep}));`);
    const elPlacement = next();
    lines.push(`${elPlacement}=IFCLOCALPLACEMENT(${localPlacement},${axis3});`);

    const entityRef = next();
    lines.push(`${entityRef}=${spec.name}(${stepString(ifcGuid())},${ownerHistory},${stepString(label)},$,$,${elPlacement},${productShape}${spec.tail});`);

    // #244: property set for dispatch args (numeric/string only).
    emitElementPropertySet(el, entityRef, ownerHistory, lines, next);

    // #243: route element into its storey bucket.
    const bucket = storeyMap.get(el.levelId ?? FALLBACK_LEVEL_ID)
      ?? storeyMap.get(FALLBACK_LEVEL_ID)!;
    bucket.entityRefs.push(entityRef);
  }

  // ── IFCRELCONTAINEDINSPATIALSTRUCTURE per storey ──────────────────────────
  for (const { ref, entityRefs } of storeyMap.values()) {
    if (entityRefs.length === 0) continue;
    const containedIn = next();
    lines.push(`${containedIn}=IFCRELCONTAINEDINSPATIALSTRUCTURE(${stepString(ifcGuid())},${ownerHistory},$,$,(${entityRefs.join(",")}),${ref});`);
  }

  lines.push("ENDSEC;");
  lines.push("END-ISO-10303-21;");
  return new TextEncoder().encode(lines.join("\n"));
}

export function buildIfc(mesh: IfcMesh, label: string = "GemmaCad Element", opts?: { imperial?: boolean }): Uint8Array {
  const lines: string[] = [];
  let id = 0;
  const next = () => `#${++id}`;
  const imperial = opts?.imperial ?? false;
  const coordScale = imperial ? M_TO_FT : 1.0;

  const refs = {
    project: "",
    site: "",
    building: "",
    storey: "",
    proxy: "",
  };

  // Header
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "");
  lines.push("ISO-10303-21;");
  lines.push("HEADER;");
  lines.push(`FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');`);
  lines.push(`FILE_NAME(${stepString("web-cad-export.ifc")},${stepString(ts)},(${stepString("WEB-CAD")}),(${stepString("WEB-CAD")}),${stepString("web-ifc-emitter/0.1")},${stepString("WEB-CAD/0.1")},'');`);
  lines.push("FILE_SCHEMA(('IFC4'));");
  lines.push("ENDSEC;");
  lines.push("DATA;");

  // Owner-history skeleton (IfcOwnerHistory needs IfcPersonAndOrganization,
  // IfcApplication, IfcPerson, IfcOrganization).
  const person = next();
  lines.push(`${person}=IFCPERSON($,$,${stepString("WEB-CAD")},$,$,$,$,$);`);
  const org = next();
  lines.push(`${org}=IFCORGANIZATION($,${stepString("WEB-CAD")},$,$,$);`);
  const personAndOrg = next();
  lines.push(`${personAndOrg}=IFCPERSONANDORGANIZATION(${person},${org},$);`);
  const app = next();
  lines.push(`${app}=IFCAPPLICATION(${org},${stepString("0.1")},${stepString("WEB-CAD web demo")},${stepString("web-cad-web")});`);
  const ownerHistory = next();
  const epoch = Math.floor(Date.now() / 1000);
  lines.push(`${ownerHistory}=IFCOWNERHISTORY(${personAndOrg},${app},$,.ADDED.,${epoch},${personAndOrg},${app},${epoch});`);

  // Geometric context.
  const dirZ = next();
  lines.push(`${dirZ}=IFCDIRECTION((0.,0.,1.));`);
  const dirX = next();
  lines.push(`${dirX}=IFCDIRECTION((1.,0.,0.));`);
  const originPt = next();
  lines.push(`${originPt}=IFCCARTESIANPOINT((0.,0.,0.));`);
  const axis3 = next();
  lines.push(`${axis3}=IFCAXIS2PLACEMENT3D(${originPt},${dirZ},${dirX});`);
  const ctx = next();
  lines.push(`${ctx}=IFCGEOMETRICREPRESENTATIONCONTEXT($,${stepString("Model")},3,1.0E-5,${axis3},$);`);

  // Units: metric (metre) or imperial (foot via IFCCONVERSIONBASEDUNIT).
  const unitAssignment = emitUnits(lines, next, imperial);

  // Project.
  refs.project = next();
  lines.push(`${refs.project}=IFCPROJECT(${stepString(ifcGuid())},${ownerHistory},${stepString("GemmaCad Demo Project")},$,$,$,$,(${ctx}),${unitAssignment});`);

  // Local placement chain (project → site → building → storey).
  const localPlacement = next();
  lines.push(`${localPlacement}=IFCLOCALPLACEMENT($,${axis3});`);

  refs.site = next();
  lines.push(`${refs.site}=IFCSITE(${stepString(ifcGuid())},${ownerHistory},${stepString("Default Site")},$,$,${localPlacement},$,$,.ELEMENT.,$,$,$,$,$);`);

  refs.building = next();
  lines.push(`${refs.building}=IFCBUILDING(${stepString(ifcGuid())},${ownerHistory},${stepString("Default Building")},$,$,${localPlacement},$,$,.ELEMENT.,$,$,$);`);

  refs.storey = next();
  lines.push(`${refs.storey}=IFCBUILDINGSTOREY(${stepString(ifcGuid())},${ownerHistory},${stepString("Default Storey")},$,$,${localPlacement},$,$,.ELEMENT.,0.);`);

  // Aggregation hierarchy.
  const projAggSite = next();
  lines.push(`${projAggSite}=IFCRELAGGREGATES(${stepString(ifcGuid())},${ownerHistory},$,$,${refs.project},(${refs.site}));`);
  const siteAggBld = next();
  lines.push(`${siteAggBld}=IFCRELAGGREGATES(${stepString(ifcGuid())},${ownerHistory},$,$,${refs.site},(${refs.building}));`);
  const bldAggStorey = next();
  lines.push(`${bldAggStorey}=IFCRELAGGREGATES(${stepString(ifcGuid())},${ownerHistory},$,$,${refs.building},(${refs.storey}));`);

  // Mesh → IFC. Build IfcCartesianPoint per vertex, IfcPolyLoop per triangle,
  // IfcFaceOuterBound per loop, IfcFace per triangle, IfcClosedShell wrapping
  // them, IfcFacetedBrep wrapping the shell.
  const vertexIds: string[] = [];
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    const x = mesh.vertices[i] * coordScale, y = mesh.vertices[i + 1] * coordScale, z = mesh.vertices[i + 2] * coordScale;
    const ptId = next();
    lines.push(`${ptId}=IFCCARTESIANPOINT((${stepFloat(x)},${stepFloat(y)},${stepFloat(z)}));`);
    vertexIds.push(ptId);
  }

  const faceIds: string[] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = vertexIds[mesh.indices[i]];
    const b = vertexIds[mesh.indices[i + 1]];
    const c = vertexIds[mesh.indices[i + 2]];
    const loop = next();
    lines.push(`${loop}=IFCPOLYLOOP((${a},${b},${c}));`);
    const bound = next();
    lines.push(`${bound}=IFCFACEOUTERBOUND(${loop},.T.);`);
    const face = next();
    lines.push(`${face}=IFCFACE((${bound}));`);
    faceIds.push(face);
  }

  const shell = next();
  lines.push(`${shell}=IFCCLOSEDSHELL((${faceIds.join(",")}));`);
  const brep = next();
  lines.push(`${brep}=IFCFACETEDBREP(${shell});`);

  // Shape representation + element placement.
  const shapeRep = next();
  lines.push(`${shapeRep}=IFCSHAPEREPRESENTATION(${ctx},${stepString("Body")},${stepString("Brep")},(${brep}));`);
  const productShape = next();
  lines.push(`${productShape}=IFCPRODUCTDEFINITIONSHAPE($,$,(${shapeRep}));`);
  const elementPlacement = next();
  lines.push(`${elementPlacement}=IFCLOCALPLACEMENT(${localPlacement},${axis3});`);

  refs.proxy = next();
  lines.push(`${refs.proxy}=IFCBUILDINGELEMENTPROXY(${stepString(ifcGuid())},${ownerHistory},${stepString(label)},$,$,${elementPlacement},${productShape},$,.NOTDEFINED.);`);

  // Contained-in-spatial-structure (storey → proxy).
  const containedIn = next();
  lines.push(`${containedIn}=IFCRELCONTAINEDINSPATIALSTRUCTURE(${stepString(ifcGuid())},${ownerHistory},$,$,(${refs.proxy}),${refs.storey});`);

  lines.push("ENDSEC;");
  lines.push("END-ISO-10303-21;");

  return new TextEncoder().encode(lines.join("\n"));
}
