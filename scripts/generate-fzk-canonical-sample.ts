import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as THREE from "three";
import * as WebIFC from "web-ifc";
import { createCanonicalGeometryStore, CANONICAL_GEOMETRY_USERDATA_KEY } from "../web/src/geometry/canonical-geometry";
import { meshToPlanarBrep } from "../web/src/handlers/mesh-planar-brep";

const IFC_PATH = "web/public/samples/AC20-FZK-Haus.ifc";
const OUT = "web/public/samples/AC20-FZK-Haus.webcad";

type SerializedObject = {
  uuid: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  displaySource: "canonical";
  userData: Record<string, unknown>;
};

function yUpToZUp(x: number, y: number, z: number): [number, number, number] {
  return [x, -z, y];
}

function meshTriangleCount(mesh: THREE.Mesh): number {
  const pos = mesh.geometry.getAttribute("position");
  return Math.floor((mesh.geometry.index?.count ?? pos.count) / 3);
}

const api = new WebIFC.IfcAPI();
api.SetWasmPath("node_modules/web-ifc/", true);
await api.Init();

const modelID = api.OpenModel(new Uint8Array(readFileSync(IFC_PATH)), { COORDINATE_TO_ORIGIN: true });
if (modelID < 0) throw new Error(`OpenModel failed for ${IFC_PATH}`);

const store = createCanonicalGeometryStore();
const objects: SerializedObject[] = [];
let totalTriangles = 0;
let skipped = 0;

try {
  const schema = api.GetModelSchema(modelID);
  const flatMeshes = api.LoadAllGeometry(modelID);

  for (let i = 0; i < flatMeshes.size(); i++) {
    const flatMesh = flatMeshes.get(i);
    const positions: number[] = [];
    const indices: number[] = [];

    for (let j = 0; j < flatMesh.geometries.size(); j++) {
      const placed = flatMesh.geometries.get(j);
      const geom = api.GetGeometry(modelID, placed.geometryExpressID);
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const m = placed.flatTransformation as unknown as Float32Array | number[];
      const baseIndex = positions.length / 3;
      for (let v = 0; v < verts.length; v += 6) {
        const x = verts[v + 0], y = verts[v + 1], z = verts[v + 2];
        const wx = m[0] * x + m[4] * y + m[8]  * z + m[12];
        const wy = m[1] * x + m[5] * y + m[9]  * z + m[13];
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        positions.push(...yUpToZUp(wx, wy, wz));
      }
      for (let k = 0; k < idx.length; k++) indices.push(idx[k] + baseIndex);
    }

    if (positions.length < 9 || indices.length < 3) {
      skipped++;
      continue;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    mesh.userData = {
      kind: "brep",
      creator: "ifc-to-planar-brep",
      expressID: flatMesh.expressID,
      sourceIfc: IFC_PATH,
    };
    const brep = meshToPlanarBrep(mesh);
    if (!brep) {
      skipped++;
      continue;
    }
    const triangles = meshTriangleCount(mesh);
    totalTriangles += triangles;
    const closedShells = brep.shells.filter((shell) => shell.isClosed).length;
    const nakedEdges = brep.shells.reduce((n, shell) => n + shell.edges.filter((edge) => edge.faceIndex2 === null).length, 0);
    const record = store.create({
      kind: "brep",
      brep,
      source: "conversion",
      createdBy: "ifc-mesh-to-planar-brep",
      displayMesh: {
        revision: 1,
        generatedAt: Date.now(),
        vertexCount: positions.length / 3,
        triangleCount: triangles,
        derivation: "tessellated-brep",
      },
      metadata: {
        conversion: "actual-ifc-web-ifc-mesh-to-planar-brep",
        sourceIfc: IFC_PATH,
        expressID: flatMesh.expressID,
        schema,
        losslessFrom: "web-ifc placed triangle mesh",
        facePolicy: "one planar trimmed BRep face per source triangle",
        closedShells,
        nakedEdges,
      },
    });
    mesh.userData[CANONICAL_GEOMETRY_USERDATA_KEY] = record.id;
    objects.push({
      uuid: mesh.uuid,
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      displaySource: "canonical",
      userData: { ...mesh.userData },
    });
  }

  const records = store.exportRecords();
  const payload = {
    format: "web-cad.canonical-project",
    version: 2,
    meta: {
      units: "metric",
      name: "KIT FZK-Haus actual IFC mesh to planar BRep",
      sourceIfc: IFC_PATH.replace(/^web\/public\//, ""),
      conversion: "actual-ifc-mesh-to-planar-brep",
      note: "Generated deterministically from the bundled FZK IFC via web-ifc placed meshes. Each source triangle becomes an exact planar trimmed BRep face; no hand-authored parametric substitution.",
      sourceElements: flatMeshes.size(),
      convertedObjects: objects.length,
      skippedObjects: skipped,
      totalTriangles,
    },
    canonicalGeometry: records,
    objects,
  };

  mkdirSync("web/public/samples", { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(payload)}\n`, "utf8");
  console.log(`${OUT}: ${records.length} records, ${objects.length} objects, ${totalTriangles} triangles, ${skipped} skipped`);
} finally {
  api.CloseModel(modelID);
}
