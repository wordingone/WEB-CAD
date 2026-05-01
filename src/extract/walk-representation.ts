/**
 * IFC representation walker — extracts parametric construction recipe
 * from one IFC element's IfcProductDefinitionShape.
 *
 * Returns a normalized {kind, profile, depth, placement} structure
 * that maps cleanly to a replicad fluent chain.
 *
 * Spike B target. Currently handles:
 *   - IfcExtrudedAreaSolid + IfcRectangleProfileDef
 *   - IfcExtrudedAreaSolid + IfcCircleProfileDef
 *   - IfcExtrudedAreaSolid + IfcArbitraryClosedProfileDef + IfcPolyline
 *
 * Returns null for representations the spike cannot translate (e.g.
 * IfcFacetedBrep, IfcTessellation — lossy mesh fallbacks).
 */

export type ExtractedRepresentation =
  | {
      kind: "extruded_rectangle";
      width: number;
      height: number;
      depth: number;
      placement: PlacementChain;
    }
  | {
      kind: "extruded_circle";
      radius: number;
      depth: number;
      placement: PlacementChain;
    }
  | {
      kind: "extruded_polyline";
      points: [number, number][];
      depth: number;
      placement: PlacementChain;
    };

export type PlacementChain = {
  translation: [number, number, number];
  rotation: { axis: [number, number, number]; angle: number } | null;
};

const ZERO_PLACEMENT: PlacementChain = {
  translation: [0, 0, 0],
  rotation: null,
};

/**
 * Walk the Representation tree of an IFC element to find its
 * primary 3D shape representation. Picks the first
 * IfcShapeRepresentation whose RepresentationIdentifier is "Body" or
 * "Facetation"; falls back to the first available.
 */
export function walkRepresentation(
  element: any
): ExtractedRepresentation | null {
  const repr = element.Representation;
  if (!repr) return null;

  const shapes = repr.Representations ?? [];
  let body =
    shapes.find(
      (s: any) =>
        s.RepresentationIdentifier?.value === "Body" ||
        s.RepresentationIdentifier?.value === "Facetation"
    ) ?? shapes[0];

  if (!body) return null;

  const item = body.Items?.[0];
  if (!item) return null;

  return extractItem(item, element.ObjectPlacement);
}

/**
 * Extract a single representation item. Recurses through Boolean
 * clipping results down to the underlying extruded solid.
 *
 * IfcBooleanClippingResult / IfcBooleanResult are common in real-world
 * walls (extrusion clipped by a half-space to slope the top against a
 * roof). For Spike B we unwrap to the base extrusion and drop the clip
 * — lossy but the NL description ("a 2.8m wall") still matches the
 * unclipped solid. Tier-2 will emit `.cut(plane)` for the clipping.
 */
function extractItem(item: any, objectPlacement: any): ExtractedRepresentation | null {
  if (!item) return null;
  const typeName = (item.constructor?.name || item.type || "") as string;

  if (typeName.includes("ExtrudedAreaSolid") || typeName === "IFCEXTRUDEDAREASOLID") {
    return extractExtruded(item, objectPlacement);
  }

  // Recurse through Boolean ops to the base solid.
  if (typeName.includes("BooleanClippingResult") ||
      typeName.includes("BooleanResult") ||
      typeName === "IFCBOOLEANCLIPPINGRESULT" ||
      typeName === "IFCBOOLEANRESULT") {
    const base = item.FirstOperand;
    if (base) return extractItem(base, objectPlacement);
  }

  return null;
}

function extractExtruded(
  item: any,
  objectPlacement: any
): ExtractedRepresentation | null {
  const profile = item.SweptArea;
  const depth = item.Depth?.value ?? item.Depth;
  if (!profile || depth == null) return null;

  const placement = composePlacement(objectPlacement);

  const profileType =
    profile.constructor?.name ?? profile.type ?? "";

  if (profileType.includes("RectangleProfileDef")) {
    return {
      kind: "extruded_rectangle",
      width: profile.XDim?.value ?? profile.XDim,
      height: profile.YDim?.value ?? profile.YDim,
      depth,
      placement,
    };
  }

  if (profileType.includes("CircleProfileDef")) {
    return {
      kind: "extruded_circle",
      radius: profile.Radius?.value ?? profile.Radius,
      depth,
      placement,
    };
  }

  if (profileType.includes("ArbitraryClosedProfileDef")) {
    const outerCurve = profile.OuterCurve;
    const curveType = outerCurve?.constructor?.name ?? outerCurve?.type ?? "";
    let points: [number, number][] | null = null;

    if (curveType.includes("Polyline") && !curveType.includes("Indexed")) {
      // IfcPolyline: Points is an array of IfcCartesianPoint
      points = (outerCurve.Points ?? []).map((p: any) => {
        const coords = p.Coordinates ?? [];
        return [coords[0]?.value ?? coords[0], coords[1]?.value ?? coords[1]] as [number, number];
      });
    } else if (curveType.includes("IndexedPolyCurve") || curveType === "IFCINDEXEDPOLYCURVE") {
      // IfcIndexedPolyCurve: Points is an IfcCartesianPointList2D with
      // CoordList = [[x,y], [x,y], ...]; Segments references point indices
      // (1-based). For axis-aligned rectangle profiles we just need the
      // ordered point list — the segments are line segments by default.
      const ptList = outerCurve.Points;
      const coords = ptList?.CoordList ?? [];
      points = coords.map((pair: any) => {
        const x = pair?.[0]?.value ?? pair?.[0];
        const y = pair?.[1]?.value ?? pair?.[1];
        return [x, y] as [number, number];
      });
    }

    if (points && points.length > 0) {

      // Collapse axis-aligned closed rectangles to extruded_rectangle.
      // IFC4 commonly uses polyline+ArbitraryClosedProfile even for plain
      // rectangular wall/slab footprints — recognize the shape and emit
      // the simpler primitive so emit-sequence can use drawRectangle.
      const rect = collapseToAxisAlignedRect(points);
      if (rect) {
        return {
          kind: "extruded_rectangle",
          width: rect.width,
          height: rect.height,
          depth,
          placement,
        };
      }

      return {
        kind: "extruded_polyline",
        points,
        depth,
        placement,
      };
    }
  }

  return null;
}

/**
 * If the polyline is a closed axis-aligned rectangle (4 unique corners +
 * optional closing duplicate), return its width/height. Otherwise null.
 *
 * Closed rectangles in IFC arrive as 5-point polylines (last == first) or
 * 4-point implicit-close. Both forms accepted.
 */
function collapseToAxisAlignedRect(
  pts: [number, number][]
): { width: number; height: number } | null {
  if (!pts || pts.length < 4) return null;
  // Trim trailing duplicate of first point if present.
  const last = pts[pts.length - 1];
  const first = pts[0];
  const ring = (last[0] === first[0] && last[1] === first[1]) ? pts.slice(0, -1) : pts;
  if (ring.length !== 4) return null;
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const xUniq = new Set(xs);
  const yUniq = new Set(ys);
  if (xUniq.size !== 2 || yUniq.size !== 2) return null;
  const xArr = [...xUniq].sort((a, b) => a - b);
  const yArr = [...yUniq].sort((a, b) => a - b);
  return {
    width: xArr[1] - xArr[0],
    height: yArr[1] - yArr[0],
  };
}

/**
 * Compose the IfcLocalPlacement chain. Walks parent placements
 * (IfcLocalPlacement.PlacementRelTo) up to the IfcSite root and
 * accumulates transforms.
 *
 * Stub for now — Spike B will validate this against real Schependomlaan
 * placements where the chain depth is 3-5.
 */
function composePlacement(placement: any): PlacementChain {
  if (!placement) return ZERO_PLACEMENT;

  const local = placement.RelativePlacement;
  if (!local) return ZERO_PLACEMENT;

  const loc = local.Location;
  const tx = loc?.Coordinates?.[0]?.value ?? loc?.Coordinates?.[0] ?? 0;
  const ty = loc?.Coordinates?.[1]?.value ?? loc?.Coordinates?.[1] ?? 0;
  const tz = loc?.Coordinates?.[2]?.value ?? loc?.Coordinates?.[2] ?? 0;

  // TODO Spike B: walk PlacementRelTo and compose.
  return {
    translation: [tx, ty, tz],
    rotation: null,
  };
}
