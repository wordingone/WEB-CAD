import { registerHandler } from "../commands/dispatch";
import { Viewer } from "../viewer/viewer";
import * as THREE from "three";
import { formatLength, formatArea, formatVolume, unitLabel } from "../units";
import { opAddLabel } from "../viewer/op-tool";
import { linkCanonicalCurve } from "./canonical-surface";
import type { Point3 } from "../nurbs/nurbs-primitives";
import { tessellate, type PolylineCurve } from "../nurbs/nurbs-curves";
import { buildAlignedDim, buildAngularDim, buildVolumeDimBox } from "../viewer/dimension-style";

function point3(v: THREE.Vector3): Point3 {
  return { x: v.x, y: v.y, z: v.z };
}

function polylineCurve(points: THREE.Vector3[]): PolylineCurve {
  const curvePoints = points.map(point3);
  const parameters = [0];
  for (let i = 1; i < curvePoints.length; i++) {
    const a = curvePoints[i - 1];
    const b = curvePoints[i];
    parameters.push(parameters[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  return { kind: "polyline", points: curvePoints, parameters };
}

function linkAnnotationCurve(
  viewer: Viewer,
  obj: THREE.Object3D,
  points: THREE.Vector3[],
  createdBy: string,
  metadata: Record<string, unknown>,
): void {
  obj.userData.creator = createdBy;
  linkCanonicalCurve(viewer, obj, polylineCurve(points), createdBy, {
    annotation: true,
    ...metadata,
  });
}

export function registerAnnotationHandlers(viewer: Viewer): void {
  registerHandler("SdAlignedDim", (args) => {
    const aArr = (args.a as number[] | undefined) ?? [0, 0, 0];
    const bArr = (args.b as number[] | undefined) ?? [1, 0, 0];
    const ptA = new THREE.Vector3(aArr[0] ?? 0, aArr[1] ?? 0, aArr[2] ?? 0);
    const ptB = new THREE.Vector3(bArr[0] ?? 0, bArr[1] ?? 0, bArr[2] ?? 0);
    const dist = ptA.distanceTo(ptB);
    const { group, dimLineMid } = buildAlignedDim(ptA, ptB);
    linkAnnotationCurve(viewer, group, [ptA, ptB], "SdAlignedDim", {
      measured: "length",
      distance: dist,
    });
    viewer.addMesh(group, "mesh");
    opAddLabel(formatLength(dist), dimLineMid, viewer);
    return { measured: "length", distance: parseFloat(dist.toFixed(4)), unit: unitLabel(), annotationUuid: group.uuid };
  });

  registerHandler("SdChainedDim", (args) => {
    const rawPts = (args.points as number[][] | undefined) ?? [];
    if (rawPts.length < 3) return { error: "SdChainedDim requires at least 3 points (2 segments)", segments: 0 };
    const withOverall = (args.withOverall as boolean | undefined) ?? true;
    const pts = rawPts.map((p) => new THREE.Vector3(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0));

    let totalDist = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const ptA = pts[i], ptB = pts[i + 1];
      const dist = ptA.distanceTo(ptB);
      totalDist += dist;
      const { group, dimLineMid } = buildAlignedDim(ptA, ptB);
      linkAnnotationCurve(viewer, group, [ptA, ptB], "SdChainedDim", {
        measured: "length",
        distance: dist,
        chainIndex: i,
      });
      viewer.addMesh(group, "mesh");
      opAddLabel(formatLength(dist), dimLineMid, viewer);
    }

    if (withOverall) {
      const ptFirst = pts[0], ptLast = pts[pts.length - 1];
      const { group: og, dimLineMid: om } = buildAlignedDim(ptFirst, ptLast, undefined, { offsetDist: 0.9 });
      linkAnnotationCurve(viewer, og, [ptFirst, ptLast], "SdChainedDim", {
        measured: "length",
        distance: totalDist,
        isOverall: true,
      });
      viewer.addMesh(og, "mesh");
      opAddLabel(`Total: ${formatLength(totalDist)}`, om, viewer);
    }

    return {
      segments: pts.length - 1,
      totalDist: parseFloat(totalDist.toFixed(4)),
      unit: unitLabel(),
    };
  });

  registerHandler("SdAngularDim", (args) => {
    const vArr  = (args.vertex as number[] | undefined) ?? [0, 0, 0];
    const r1Arr = (args.ray1   as number[] | undefined) ?? [1, 0, 0];
    const r2Arr = (args.ray2   as number[] | undefined) ?? [0, 1, 0];
    const vertex = new THREE.Vector3(vArr[0] ?? 0, vArr[1] ?? 0, vArr[2] ?? 0);
    const ray1 = new THREE.Vector3(r1Arr[0] ?? 0, r1Arr[1] ?? 0, r1Arr[2] ?? 0);
    const ray2 = new THREE.Vector3(r2Arr[0] ?? 0, r2Arr[1] ?? 0, r2Arr[2] ?? 0);
    const d1 = ray1.clone().sub(vertex).normalize();
    const d2 = ray2.clone().sub(vertex).normalize();
    const angleDeg = (Math.acos(Math.max(-1, Math.min(1, d1.dot(d2)))) * 180) / Math.PI;
    const { group, arcMid } = buildAngularDim(vertex, ray1, ray2);
    linkAnnotationCurve(viewer, group, [vertex, ray1, vertex, ray2], "SdAngularDim", {
      measured: "angle",
      angleDeg,
    });
    viewer.addMesh(group, "mesh");
    opAddLabel(`${angleDeg.toFixed(1)}°`, arcMid, viewer);
    return { measured: "angle", angleDeg: parseFloat(angleDeg.toFixed(2)), unit: "deg", annotationUuid: group.uuid };
  });

  registerHandler("SdAreaDim", (args) => {
    const rawPts = (args.points as number[][] | undefined) ?? [];
    if (rawPts.length < 3) return { error: "SdAreaDim requires at least 3 points", measured: null };
    let area = 0;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < rawPts.length; i++) {
      const j = (i + 1) % rawPts.length;
      area += (rawPts[i][0] ?? 0) * (rawPts[j][1] ?? 0) - (rawPts[j][0] ?? 0) * (rawPts[i][1] ?? 0);
      cx += rawPts[i][0] ?? 0; cy += rawPts[i][1] ?? 0; cz += rawPts[i][2] ?? 0;
    }
    area = Math.abs(area) / 2;
    const n = rawPts.length;
    const centroid = new THREE.Vector3(cx / n, cy / n, cz / n);
    const vec3Pts = rawPts.map((p) => new THREE.Vector3(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0));
    // Perimeter outline using aligned-dim color (no witness lines for area)
    const { group } = buildAlignedDim(vec3Pts[0], vec3Pts[0], undefined, { offsetDist: 0 });
    // Replace the group's children with a simple perimeter loop
    while (group.children.length) group.remove(group.children[0]);
    const perimPts = [...vec3Pts, vec3Pts[0]];
    const geo = new THREE.BufferGeometry().setFromPoints(perimPts);
    const mat = new THREE.LineBasicMaterial({ color: 0x1a56cc, depthTest: false });
    const loop = new THREE.Line(geo, mat);
    loop.renderOrder = 100;
    loop.userData.noSnap = true;
    group.add(loop);
    linkAnnotationCurve(viewer, group, perimPts, "SdAreaDim", {
      measured: "area",
      area,
      closed: true,
    });
    viewer.addMesh(group, "mesh");
    opAddLabel(`Area: ${formatArea(area)}`, centroid, viewer);
    const unitSuffix = unitLabel() === "ft" ? "ft2" : "m2";
    return { measured: "area", area: parseFloat(area.toFixed(4)), unit: unitSuffix, annotationUuid: group.uuid };
  });

  registerHandler("SdVolumeDim", (args) => {
    const id = args.id as string | undefined;
    if (!id) return { error: "SdVolumeDim requires id", measured: null };
    const obj = viewer.getScene().getObjectByProperty("uuid", id);
    if (!obj) return { error: `SdVolumeDim — object not found: ${id}`, measured: null };
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    box.getSize(size);
    const volume = size.x * size.y * size.z;
    const { group, boxCenter } = buildVolumeDimBox(box);
    linkAnnotationCurve(viewer, group, [box.min, box.max], "SdVolumeDim", {
      measured: "volume",
      target: id,
      volume,
    });
    viewer.addMesh(group, "mesh");
    opAddLabel(`Vol: ${formatVolume(volume)}`, boxCenter, viewer);
    const unitSuffix = unitLabel() === "ft" ? "ft3" : "m3";
    return { measured: "volume", volume: parseFloat(volume.toFixed(4)), unit: unitSuffix, annotationUuid: group.uuid };
  });

  registerHandler("SdLabel", (args) => {
    const text = (args.text as string | undefined) ?? "";
    if (!text) return { error: "SdLabel requires text" };
    const posArr = (args.position as number[] | undefined) ?? [0, 0, 0];
    const pt = new THREE.Vector3(posArr[0] ?? 0, posArr[1] ?? 0, posArr[2] ?? 0);
    opAddLabel(text, pt, viewer);
    return { placed: true, text };
  });

  registerHandler("SdTransientMeasure", (args) => {
    const aArr = (args.a as number[] | undefined) ?? [0, 0, 0];
    const bArr = (args.b as number[] | undefined) ?? [1, 0, 0];
    const ptA = new THREE.Vector3(aArr[0] ?? 0, aArr[1] ?? 0, aArr[2] ?? 0);
    const ptB = new THREE.Vector3(bArr[0] ?? 0, bArr[1] ?? 0, bArr[2] ?? 0);
    const dist = ptA.distanceTo(ptB);
    const { group, dimLineMid } = buildAlignedDim(ptA, ptB);
    linkAnnotationCurve(viewer, group, [ptA, ptB], "SdTransientMeasure", {
      measured: "length",
      distance: dist,
      transient: true,
    });
    viewer.getScene().add(group); // audit-undo-ok — transient measurement line, no undo entry intentional
    opAddLabel(formatLength(dist), dimLineMid, viewer);
    return { measured: "length", distance: parseFloat(dist.toFixed(4)), unit: unitLabel() };
  });

  registerHandler("SdEdgeLength", (args) => {
    const targetId = args.target as string | undefined;
    if (!targetId) return { error: "SdEdgeLength requires target" };
    const edgeIndex = args.edge as number | undefined;
    if (edgeIndex === undefined || edgeIndex === null) return { error: "SdEdgeLength requires edge index" };
    const shellIndex = (args.shell as number | undefined) ?? 0;

    const obj = viewer.getScene().getObjectByProperty("uuid", targetId);
    if (!obj) return { error: `SdEdgeLength — target not found: ${targetId}` };

    const store = viewer.getCanonicalGeometryStore();
    const canonical = store.resolveObjectOrAncestor(obj);
    if (!canonical || canonical.kind !== "brep") {
      return { error: "SdEdgeLength — target has no canonical BRep" };
    }

    const shell = canonical.brep.shells[shellIndex];
    if (!shell) return { error: `SdEdgeLength — shell ${shellIndex} not found` };
    const edge = shell.edges[edgeIndex];
    if (!edge) return { error: `SdEdgeLength — edge ${edgeIndex} not found in shell ${shellIndex}` };

    const pts3 = tessellate(edge.curve, 512);
    let length = 0;
    for (let i = 1; i < pts3.length; i++) {
      const a = pts3[i - 1]!, b = pts3[i]!;
      length += Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2);
    }

    const threePts = pts3.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    const mid = threePts[Math.floor(threePts.length / 2)]!;
    const group = new THREE.Group();
    linkAnnotationCurve(viewer, group, threePts, "SdEdgeLength", {
      measured: "edge-length",
      target: targetId,
      edge: edgeIndex,
      shell: shellIndex,
      length,
    });
    viewer.addMesh(group, "mesh");
    opAddLabel(formatLength(length), mid, viewer);
    return { measured: "edge-length", length: parseFloat(length.toFixed(6)), edge: edgeIndex, shell: shellIndex, unit: unitLabel(), object_id: group.uuid, canonical_id: group.userData["canonicalGeometryId"] };
  });
}
