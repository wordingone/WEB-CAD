import type { Object3D } from "three";
import type {
  CanonicalGeometry,
  CanonicalGeometryId,
  CanonicalGeometryStore,
} from "./canonical-geometry";

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
