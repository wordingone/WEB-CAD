import type { Brep } from "../nurbs/nurbs-brep";
import type { Curve } from "../nurbs/nurbs-curves";
import type { Point3 } from "../nurbs/nurbs-primitives";
import type { Surface } from "../nurbs/nurbs-surfaces";

export const CANONICAL_GEOMETRY_USERDATA_KEY = "canonicalGeometryId";
export const CANONICAL_GEOMETRY_SCHEMA_VERSION = 1;

export type CanonicalGeometryId = string;

export type CanonicalGeometrySource =
  | "command"
  | "import"
  | "edit"
  | "conversion";

export type CanonicalDisplayMeshCache = {
  revision: number;
  generatedAt: number;
  vertexCount?: number;
  triangleCount?: number;
  derivation: "tessellated-brep" | "tessellated-surface" | "tessellated-curve" | "reference-marker";
};

export type CanonicalGeometryBase = {
  id: CanonicalGeometryId;
  schemaVersion: typeof CANONICAL_GEOMETRY_SCHEMA_VERSION;
  units: "m";
  label?: string;
  source: CanonicalGeometrySource;
  createdBy?: string;
  displayMesh?: CanonicalDisplayMeshCache;
  metadata?: Record<string, unknown>;
};

export type CanonicalBrepGeometry = CanonicalGeometryBase & {
  kind: "brep";
  brep: Brep;
};

export type CanonicalSurfaceGeometry = CanonicalGeometryBase & {
  kind: "surface";
  surface: Surface;
};

export type CanonicalCurveGeometry = CanonicalGeometryBase & {
  kind: "curve";
  curve: Curve;
};

export type CanonicalPointGeometry = CanonicalGeometryBase & {
  kind: "point";
  point: Point3;
};

export type CanonicalGeometry =
  | CanonicalBrepGeometry
  | CanonicalSurfaceGeometry
  | CanonicalCurveGeometry
  | CanonicalPointGeometry;

export type CanonicalGeometryDraft =
  | Omit<CanonicalBrepGeometry, "id" | "schemaVersion" | "units">
  | Omit<CanonicalSurfaceGeometry, "id" | "schemaVersion" | "units">
  | Omit<CanonicalCurveGeometry, "id" | "schemaVersion" | "units">
  | Omit<CanonicalPointGeometry, "id" | "schemaVersion" | "units">;

export type CanonicalGeometryLinkable = {
  userData: Record<string, unknown>;
};

export type CanonicalGeometryStore = ReturnType<typeof createCanonicalGeometryStore>;

let _nextCanonicalGeometryId = 1;

export function createCanonicalGeometryId(prefix = "cg"): CanonicalGeometryId {
  const n = _nextCanonicalGeometryId++;
  return `${prefix}_${n.toString(36).padStart(4, "0")}`;
}

function reserveCanonicalGeometryId(id: CanonicalGeometryId): void {
  const match = /^cg_([0-9a-z]+)$/i.exec(id);
  if (!match) return;
  const n = Number.parseInt(match[1], 36);
  if (Number.isFinite(n) && n >= _nextCanonicalGeometryId) {
    _nextCanonicalGeometryId = n + 1;
  }
}

export function isCanonicalGeometry(value: unknown): value is CanonicalGeometry {
  if (!value || typeof value !== "object") return false;
  const rec = value as Partial<CanonicalGeometry>;
  return (
    rec.schemaVersion === CANONICAL_GEOMETRY_SCHEMA_VERSION
    && rec.units === "m"
    && typeof rec.id === "string"
    && (rec.kind === "brep" || rec.kind === "surface" || rec.kind === "curve" || rec.kind === "point")
  );
}

export function createCanonicalGeometryStore(initial: CanonicalGeometry[] = []) {
  const records = new Map<CanonicalGeometryId, CanonicalGeometry>();

  function assertKnown(id: CanonicalGeometryId): void {
    if (!records.has(id)) throw new Error(`Unknown canonical geometry id: ${id}`);
  }

  const store = {
    create(draft: CanonicalGeometryDraft, id = createCanonicalGeometryId()): CanonicalGeometry {
      const record = {
        ...draft,
        id,
        schemaVersion: CANONICAL_GEOMETRY_SCHEMA_VERSION,
        units: "m" as const,
      } as CanonicalGeometry;
      reserveCanonicalGeometryId(id);
      records.set(id, record);
      return record;
    },

    upsert(record: CanonicalGeometry): CanonicalGeometry {
      if (!isCanonicalGeometry(record)) throw new Error("Invalid canonical geometry record");
      reserveCanonicalGeometryId(record.id);
      records.set(record.id, record);
      return record;
    },

    get(id: CanonicalGeometryId): CanonicalGeometry | undefined {
      return records.get(id);
    },

    require(id: CanonicalGeometryId): CanonicalGeometry {
      const record = records.get(id);
      if (!record) throw new Error(`Unknown canonical geometry id: ${id}`);
      return record;
    },

    has(id: CanonicalGeometryId): boolean {
      return records.has(id);
    },

    delete(id: CanonicalGeometryId): boolean {
      return records.delete(id);
    },

    clear(): void {
      records.clear();
    },

    list(): CanonicalGeometry[] {
      return [...records.values()];
    },

    exportRecords(): CanonicalGeometry[] {
      return store.list();
    },

    importRecords(nextRecords: unknown[]): number {
      let count = 0;
      for (const record of nextRecords) {
        if (!isCanonicalGeometry(record)) continue;
        reserveCanonicalGeometryId(record.id);
        records.set(record.id, record);
        count++;
      }
      return count;
    },

    linkObject(obj: CanonicalGeometryLinkable, id: CanonicalGeometryId): void {
      assertKnown(id);
      obj.userData[CANONICAL_GEOMETRY_USERDATA_KEY] = id;
    },

    unlinkObject(obj: CanonicalGeometryLinkable): void {
      delete obj.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
    },

    getLinkedId(obj: CanonicalGeometryLinkable): CanonicalGeometryId | undefined {
      const id = obj.userData[CANONICAL_GEOMETRY_USERDATA_KEY];
      return typeof id === "string" ? id : undefined;
    },

    resolveObject(obj: CanonicalGeometryLinkable): CanonicalGeometry | undefined {
      const id = store.getLinkedId(obj);
      return id ? records.get(id) : undefined;
    },
  };

  for (const record of initial) store.upsert(record);
  return store;
}
