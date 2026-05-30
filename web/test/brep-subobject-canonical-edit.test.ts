import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { createCanonicalGeometryStore } from "../src/geometry/canonical-geometry";
import type { Brep } from "../src/nurbs/nurbs-brep";
import { deformBrepSubObject } from "../src/viewer/sub-object-handles";

function squareFaceBrep(): Brep {
  return {
    shells: [{
      faces: [{
        surface: {
          kind: "plane",
          plane: {
            origin: { x: 0, y: 0, z: 0 },
            xAxis: { x: 1, y: 0, z: 0 },
            yAxis: { x: 0, y: 1, z: 0 },
            normal: { x: 0, y: 0, z: 1 },
          },
          uDomain: { min: 0, max: 1 },
          vDomain: { min: 0, max: 1 },
          uExtent: { min: 0, max: 1 },
          vExtent: { min: 0, max: 1 },
        },
        outerLoop: {
          curves: [{
            kind: "polyline",
            points: [
              { x: 0, y: 0, z: 0 },
              { x: 1, y: 0, z: 0 },
              { x: 1, y: 1, z: 0 },
              { x: 0, y: 1, z: 0 },
              { x: 0, y: 0, z: 0 },
            ],
            parameters: [0, 1, 2, 3, 4],
          }],
          orientation: true,
        },
        innerLoops: [],
        orientation: true,
        tolerance: 1e-6,
      }],
      edges: [{
        curve: {
          kind: "line",
          from: { x: 0, y: 0, z: 0 },
          to: { x: 1, y: 0, z: 0 },
          domain: { min: 0, max: 1 },
        },
        faceIndex1: 0,
        faceIndex2: null,
        tolerance: 1e-6,
      }],
      vertices: [{
        point: { x: 0, y: 0, z: 0 },
        edgeIndices: [0],
        tolerance: 1e-6,
      }],
      isClosed: false,
    }],
  };
}

function twoShellBrep(): Brep {
  const first = squareFaceBrep().shells[0];
  const second = squareFaceBrep().shells[0];
  return {
    shells: [
      first,
      {
        ...second,
        faces: second.faces.map((face) => {
          expect(face.surface.kind).toBe("plane");
          if (face.surface.kind !== "plane") return face;
          return {
            ...face,
            surface: {
              ...face.surface,
              plane: { ...face.surface.plane, origin: { x: 10, y: 0, z: 0 } },
            },
          };
        }),
        edges: second.edges.map((edge) => edge.curve.kind === "line"
          ? {
            ...edge,
            curve: {
              ...edge.curve,
              from: { ...edge.curve.from, x: edge.curve.from.x + 10 },
              to: { ...edge.curve.to, x: edge.curve.to.x + 10 },
            },
          }
          : edge),
        vertices: second.vertices.map((vertex) => ({
          ...vertex,
          point: { ...vertex.point, x: vertex.point.x + 10 },
        })),
      },
    ],
  };
}

describe("BRep subobject canonical editing", () => {
  test("face gumball deformation writes the canonical BRep, not only display mesh metadata", () => {
    const store = createCanonicalGeometryStore();
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    mesh.geometry.setAttribute("position", new THREE.Float32BufferAttribute([
      0, 0, 0,
      1, 0, 0,
      1, 1, 0,
      0, 1, 0,
    ], 3));
    const record = store.create({
      kind: "brep",
      brep: squareFaceBrep(),
      source: "command",
      createdBy: "test",
      displayMesh: { revision: 1, generatedAt: 1, vertexCount: 4, triangleCount: 2, derivation: "tessellated-brep" },
    });
    store.linkObject(mesh, record.id);

    const snapshot = (mesh.geometry.getAttribute("position").array as Float32Array).slice();
    deformBrepSubObject(mesh, [0, 1, 2, 3], new THREE.Vector3(0, 0, 2), snapshot, store, {
      topology: "face",
      faceIndex: 0,
    });

    const edited = store.require(record.id);
    expect(edited.kind).toBe("brep");
    if (edited.kind !== "brep") return;
    expect(edited.source).toBe("edit");
    expect(edited.metadata?.editedBy).toBe("deformBrepSubObject");
    expect(edited.displayMesh?.revision).toBe(2);
    const face = edited.brep.shells[0].faces[0];
    expect(face.surface.kind).toBe("plane");
    if (face.surface.kind !== "plane") return;
    expect(face.surface.plane.origin.z).toBe(2);
    expect(edited.brep.shells[0].edges[0].curve.kind).toBe("line");
    const edge = edited.brep.shells[0].edges[0].curve;
    if (edge.kind !== "line") return;
    expect(edge.from.z).toBe(2);
    expect(edge.to.z).toBe(2);
    expect(edited.brep.shells[0].vertices[0].point.z).toBe(2);
  });

  test("face deformation uses display-global face indices across BRep shells", () => {
    const store = createCanonicalGeometryStore();
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    mesh.geometry.setAttribute("position", new THREE.Float32BufferAttribute([
      10, 0, 0,
      11, 0, 0,
      11, 1, 0,
      10, 1, 0,
    ], 3));
    const record = store.create({
      kind: "brep",
      brep: twoShellBrep(),
      source: "command",
      createdBy: "test",
      displayMesh: { revision: 1, generatedAt: 1, vertexCount: 4, triangleCount: 2, derivation: "tessellated-brep" },
    });
    store.linkObject(mesh, record.id);

    const snapshot = (mesh.geometry.getAttribute("position").array as Float32Array).slice();
    deformBrepSubObject(mesh, [0, 1, 2, 3], new THREE.Vector3(0, 0, 3), snapshot, store, {
      topology: "face",
      faceIndex: 1,
    });

    const edited = store.require(record.id);
    expect(edited.kind).toBe("brep");
    if (edited.kind !== "brep") return;
    const firstFace = edited.brep.shells[0].faces[0];
    const secondFace = edited.brep.shells[1].faces[0];
    expect(firstFace.surface.kind).toBe("plane");
    expect(secondFace.surface.kind).toBe("plane");
    if (firstFace.surface.kind !== "plane" || secondFace.surface.kind !== "plane") return;
    expect(firstFace.surface.plane.origin.z).toBe(0);
    expect(secondFace.surface.plane.origin.z).toBe(3);
    expect(edited.brep.shells[0].edges[0].curve.kind).toBe("line");
    expect(edited.brep.shells[1].edges[0].curve.kind).toBe("line");
    const firstEdge = edited.brep.shells[0].edges[0].curve;
    const secondEdge = edited.brep.shells[1].edges[0].curve;
    if (firstEdge.kind !== "line" || secondEdge.kind !== "line") return;
    expect(firstEdge.from.z).toBe(0);
    expect(secondEdge.from.z).toBe(3);
  });
});
