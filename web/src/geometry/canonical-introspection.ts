import { Box3, Plane, Vector3, type Object3D } from "three";
import type {
  CanonicalGeometry,
  CanonicalGeometryId,
  CanonicalGeometryStore,
} from "./canonical-geometry";
import type { Selection, Topology } from "../viewer/selection-state";
import type { Brep } from "../nurbs/nurbs-brep";
import type { Curve } from "../nurbs/nurbs-curves";
import { domain as curveDomain } from "../nurbs/nurbs-curves";
import type { Point3 } from "../nurbs/nurbs-primitives";
import type { Surface } from "../nurbs/nurbs-surfaces";
import { domainU, domainV } from "../nurbs/nurbs-surfaces";

export type CanonicalExactGeometry =
  | { kind: "surface"; surface: Surface }
  | { kind: "curve"; curve: Curve }
  | { kind: "point"; point: Point3 }
  | { kind: "brep"; brep: Brep };

export type CanonicalGeometryRecordSummary = {
  canonicalGeometryId: CanonicalGeometryId;
  kind: CanonicalGeometry["kind"];
  exactGeometry: CanonicalExactGeometry;
  surfaceKind?: string;
  surfaceDomain?: {
    u: [number, number];
    v: [number, number];
  };
  curveKind?: string;
  curveDomain?: [number, number];
  point?: [number, number, number];
  brepTopology?: {
    shellCount: number;
    faceCount: number;
    edgeCount: number;
    vertexCount: number;
  };
};

export type CanonicalGeometryObjectLink = {
  objectUuid: string;
  objectName?: string;
  canonicalGeometryId: CanonicalGeometryId;
  creator?: string;
  runtimeKind?: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  worldMatrix: number[];
};

export type CanonicalGeometrySnapshot = {
  records: CanonicalGeometry[];
  objectLinks: CanonicalGeometryObjectLink[];
  linkedRecordIds: CanonicalGeometryId[];
  unlinkedRecordIds: CanonicalGeometryId[];
};

export type CanonicalSelectionSnapshot = {
  topology: Topology;
  pickedObjectUuid: string;
  ownerObjectUuid: string;
  canonicalGeometryId?: CanonicalGeometryId;
  recordSummary?: CanonicalGeometryRecordSummary;
  faceIndex?: number;
  edgeIndex?: number;
  vertexIndex?: number;
  ownerWorldMatrix: number[];
};

export type CanonicalClipPlaneInput = {
  label: string;
  source: "section-box" | "clipping-plane";
  plane: Plane;
};

export type CanonicalClipPlaneSnapshot = {
  label: string;
  source: CanonicalClipPlaneInput["source"];
  origin: [number, number, number];
  normal: [number, number, number];
  constant: number;
};

export type CanonicalClippedObjectLink = {
  objectUuid: string;
  canonicalGeometryId: CanonicalGeometryId;
  recordSummary?: CanonicalGeometryRecordSummary;
  planeLabel: string;
  relation: "intersecting" | "inside" | "outside";
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
  };
};

export type CanonicalClippingSnapshot = {
  planes: CanonicalClipPlaneSnapshot[];
  objectLinks: CanonicalClippedObjectLink[];
};

function summarizeCanonicalGeometry(record: CanonicalGeometry): CanonicalGeometryRecordSummary {
  if (record.kind === "surface") {
    const u = domainU(record.surface);
    const v = domainV(record.surface);
    return {
      canonicalGeometryId: record.id,
      kind: "surface",
      exactGeometry: { kind: "surface", surface: record.surface },
      surfaceKind: record.surface.kind,
      surfaceDomain: {
        u: [u.min, u.max],
        v: [v.min, v.max],
      },
    };
  }

  if (record.kind === "curve") {
    const d = curveDomain(record.curve);
    return {
      canonicalGeometryId: record.id,
      kind: "curve",
      exactGeometry: { kind: "curve", curve: record.curve },
      curveKind: record.curve.kind,
      curveDomain: [d.min, d.max],
    };
  }

  if (record.kind === "point") {
    return {
      canonicalGeometryId: record.id,
      kind: "point",
      exactGeometry: { kind: "point", point: record.point },
      point: [record.point.x, record.point.y, record.point.z],
    };
  }

  let faceCount = 0;
  let edgeCount = 0;
  let vertexCount = 0;
  for (const shell of record.brep.shells) {
    faceCount += shell.faces.length;
    edgeCount += shell.edges.length;
    vertexCount += shell.vertices.length;
  }
  return {
    canonicalGeometryId: record.id,
    kind: "brep",
    exactGeometry: { kind: "brep", brep: record.brep },
    brepTopology: {
      shellCount: record.brep.shells.length,
      faceCount,
      edgeCount,
      vertexCount,
    },
  };
}

function nearestLinkedObject(store: CanonicalGeometryStore, start: Object3D | null | undefined): Object3D | null {
  let obj: Object3D | null | undefined = start;
  while (obj) {
    if (store.getLinkedId(obj)) return obj;
    obj = obj.parent;
  }
  return null;
}

export function inspectCanonicalGeometry(
  store: CanonicalGeometryStore,
  roots: Object3D[],
): CanonicalGeometrySnapshot {
  const records = store.exportRecords();
  const objectLinks: CanonicalGeometryObjectLink[] = [];
  const linked = new Set<CanonicalGeometryId>();

  for (const root of roots) {
    root.traverse((obj) => {
      const canonicalGeometryId = store.getLinkedId(obj);
      if (!canonicalGeometryId) return;
      linked.add(canonicalGeometryId);
      objectLinks.push({
        objectUuid: obj.uuid,
        ...(obj.name ? { objectName: obj.name } : {}),
        canonicalGeometryId,
        ...(typeof obj.userData.creator === "string" ? { creator: obj.userData.creator } : {}),
        ...(typeof obj.userData.kind === "string" ? { runtimeKind: obj.userData.kind } : {}),
        position: obj.position.toArray() as [number, number, number],
        quaternion: [obj.quaternion.x, obj.quaternion.y, obj.quaternion.z, obj.quaternion.w],
        scale: obj.scale.toArray() as [number, number, number],
        worldMatrix: obj.matrixWorld.elements.slice(),
      });
    });
  }

  const linkedRecordIds = [...linked].sort();
  const unlinkedRecordIds = records
    .map((record) => record.id)
    .filter((id) => !linked.has(id))
    .sort();

  return { records, objectLinks, linkedRecordIds, unlinkedRecordIds };
}

export function inspectCanonicalSelection(
  store: CanonicalGeometryStore,
  selection: Selection | null,
): CanonicalSelectionSnapshot | null {
  if (!selection) return null;
  const owner = nearestLinkedObject(store, selection.parent)
    ?? nearestLinkedObject(store, selection.transformTarget)
    ?? nearestLinkedObject(store, selection.object)
    ?? selection.parent
    ?? selection.transformTarget;
  const record = store.resolveObject(owner);
  owner.updateMatrixWorld(true);
  return {
    topology: selection.topology,
    pickedObjectUuid: selection.object.uuid,
    ownerObjectUuid: owner.uuid,
    ...(record ? { canonicalGeometryId: record.id, recordSummary: summarizeCanonicalGeometry(record) } : {}),
    ...(selection.faceIndex !== undefined ? { faceIndex: selection.faceIndex } : {}),
    ...(selection.edgeIndex !== undefined ? { edgeIndex: selection.edgeIndex } : {}),
    ...(selection.vertexIndex !== undefined ? { vertexIndex: selection.vertexIndex } : {}),
    ownerWorldMatrix: owner.matrixWorld.elements.slice(),
  };
}

function planeOrigin(plane: Plane): [number, number, number] {
  const origin = plane.normal.clone().multiplyScalar(-plane.constant);
  const clean = (n: number) => Object.is(n, -0) ? 0 : n;
  return [clean(origin.x), clean(origin.y), clean(origin.z)];
}

function boxCorners(box: Box3): Vector3[] {
  const { min, max } = box;
  return [
    new Vector3(min.x, min.y, min.z),
    new Vector3(min.x, min.y, max.z),
    new Vector3(min.x, max.y, min.z),
    new Vector3(min.x, max.y, max.z),
    new Vector3(max.x, min.y, min.z),
    new Vector3(max.x, min.y, max.z),
    new Vector3(max.x, max.y, min.z),
    new Vector3(max.x, max.y, max.z),
  ];
}

function classifyBoxAgainstPlane(box: Box3, plane: Plane): CanonicalClippedObjectLink["relation"] {
  let minDistance = Infinity;
  let maxDistance = -Infinity;
  for (const corner of boxCorners(box)) {
    const d = plane.distanceToPoint(corner);
    minDistance = Math.min(minDistance, d);
    maxDistance = Math.max(maxDistance, d);
  }
  if (minDistance <= 0 && maxDistance >= 0) return "intersecting";
  return maxDistance < 0 ? "outside" : "inside";
}

export function inspectCanonicalClipping(
  store: CanonicalGeometryStore,
  roots: Object3D[],
  planes: CanonicalClipPlaneInput[],
): CanonicalClippingSnapshot {
  const objectLinks: CanonicalClippedObjectLink[] = [];
  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverse((obj) => {
      const canonicalGeometryId = store.getLinkedId(obj);
      if (!canonicalGeometryId) return;
      const record = store.get(canonicalGeometryId);
      const box = new Box3().setFromObject(obj);
      if (box.isEmpty()) return;
      for (const { label, plane } of planes) {
        const relation = classifyBoxAgainstPlane(box, plane);
        if (relation === "inside") continue;
        objectLinks.push({
          objectUuid: obj.uuid,
          canonicalGeometryId,
          ...(record ? { recordSummary: summarizeCanonicalGeometry(record) } : {}),
          planeLabel: label,
          relation,
          bounds: {
            min: box.min.toArray() as [number, number, number],
            max: box.max.toArray() as [number, number, number],
          },
        });
      }
    });
  }

  return {
    planes: planes.map(({ label, source, plane }) => ({
      label,
      source,
      origin: planeOrigin(plane),
      normal: plane.normal.toArray() as [number, number, number],
      constant: plane.constant,
    })),
    objectLinks,
  };
}
