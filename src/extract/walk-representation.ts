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

  // IfcExtrudedAreaSolid is the most common — the spike-A path.
  if (item.constructor?.name === "IfcExtrudedAreaSolid" || item.type === "IFCEXTRUDEDAREASOLID") {
    return extractExtruded(item, element.ObjectPlacement);
  }

  // Add more cases as they surface in Spike B mining.
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
    if (
      outerCurve?.constructor?.name === "IfcPolyline" ||
      outerCurve?.type === "IFCPOLYLINE"
    ) {
      const points = (outerCurve.Points ?? []).map((p: any) => {
        const coords = p.Coordinates ?? [];
        return [coords[0]?.value ?? coords[0], coords[1]?.value ?? coords[1]] as [number, number];
      });
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
