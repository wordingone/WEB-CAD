/**
 * sources.mjs — seed URL list for Phase 1 CAD tutorial mining.
 *
 * Only open/non-auth sources. Text content + step-by-step procedures.
 * Phase 2 (video/ASR) is a separate pass — not listed here.
 *
 * Source categories:
 *   rhino-docs   — docs.mcneel.com/rhino/8/help/en-us/  (McNeel Rhino 8 help)
 *   dynamo       — GitHub DynamoPrimer (open, MIT) / dynamoprimer.gitbooks.io
 *   rhino-forum  — discourse.mcneel.com solved "how-to" threads
 *   autocad-docs — help.autodesk.com/view/ACD/ public help pages
 *
 * Revit auth note: help.autodesk.com/view/RVT/ requires login — substituted
 * with Dynamo primer (architectural workflows) + community posts per Leo Q2.
 */

/** @typedef {{ url: string; source: string; title: string }} SeedEntry */

/** @type {SeedEntry[]} */
export const SEEDS = [
  // ── Rhino 8 docs — Getting Started + key command tutorials ───────────────
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/box.htm",
    source: "rhino-docs", title: "Rhino Box command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/cylinder.htm",
    source: "rhino-docs", title: "Rhino Cylinder command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/sphere.htm",
    source: "rhino-docs", title: "Rhino Sphere command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/rectangle.htm",
    source: "rhino-docs", title: "Rhino Rectangle command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/circle.htm",
    source: "rhino-docs", title: "Rhino Circle command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/line.htm",
    source: "rhino-docs", title: "Rhino Line command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/arc.htm",
    source: "rhino-docs", title: "Rhino Arc command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/polyline.htm",
    source: "rhino-docs", title: "Rhino Polyline command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/extrudecrv.htm",
    source: "rhino-docs", title: "Rhino ExtrudeCrv command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/revolve.htm",
    source: "rhino-docs", title: "Rhino Revolve command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/sweep1.htm",
    source: "rhino-docs", title: "Rhino Sweep1 command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/loft.htm",
    source: "rhino-docs", title: "Rhino Loft command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/booleanunion.htm",
    source: "rhino-docs", title: "Rhino BooleanUnion command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/booleandifference.htm",
    source: "rhino-docs", title: "Rhino BooleanDifference command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/filletedge.htm",
    source: "rhino-docs", title: "Rhino FilletEdge command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/move.htm",
    source: "rhino-docs", title: "Rhino Move command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/rotate.htm",
    source: "rhino-docs", title: "Rhino Rotate command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/scale.htm",
    source: "rhino-docs", title: "Rhino Scale command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/mirror.htm",
    source: "rhino-docs", title: "Rhino Mirror command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/arrayrect.htm",
    source: "rhino-docs", title: "Rhino ArrayRect command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/shell.htm",
    source: "rhino-docs", title: "Rhino Shell command",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/commands/chamferedge.htm",
    source: "rhino-docs", title: "Rhino ChamferEdge command",
  },
  // Rhino getting-started tutorial pages
  {
    url: "https://docs.mcneel.com/rhino/8/help/en-us/user_interface/toolbars.htm",
    source: "rhino-docs", title: "Rhino UI overview",
  },
  {
    url: "https://docs.mcneel.com/rhino/8/usersguide/en-us/index.htm",
    source: "rhino-docs", title: "Rhino User Guide index",
  },

  // ── Dynamo Primer — architectural / parametric workflows (open, GitHub) ──
  {
    url: "https://primer.dynamobim.org/02_Hello-Dynamo/2-6_the_quick_start_guide.html",
    source: "dynamo", title: "Dynamo Quick Start",
  },
  {
    url: "https://primer.dynamobim.org/05_Geometry-for-Computational-Design/5-1_geometry-overview.html",
    source: "dynamo", title: "Dynamo Geometry Overview",
  },
  {
    url: "https://primer.dynamobim.org/05_Geometry-for-Computational-Design/5-2_vectors.html",
    source: "dynamo", title: "Dynamo Vectors",
  },
  {
    url: "https://primer.dynamobim.org/05_Geometry-for-Computational-Design/5-3_points.html",
    source: "dynamo", title: "Dynamo Points",
  },
  {
    url: "https://primer.dynamobim.org/05_Geometry-for-Computational-Design/5-4_curves.html",
    source: "dynamo", title: "Dynamo Curves",
  },
  {
    url: "https://primer.dynamobim.org/05_Geometry-for-Computational-Design/5-5_solids.html",
    source: "dynamo", title: "Dynamo Solids",
  },
  {
    url: "https://primer.dynamobim.org/08_Dynamo-for-Revit/8-3_editing.html",
    source: "dynamo", title: "Dynamo for Revit — editing walls/floors",
  },
  {
    url: "https://primer.dynamobim.org/08_Dynamo-for-Revit/8-4_creating.html",
    source: "dynamo", title: "Dynamo for Revit — creating walls/columns/beams",
  },
  {
    url: "https://primer.dynamobim.org/08_Dynamo-for-Revit/8-5_customizing.html",
    source: "dynamo", title: "Dynamo for Revit — customizing family instances",
  },

  // ── AutoCAD docs — 2D/3D workflows (public, no auth required) ────────────
  {
    url: "https://help.autodesk.com/view/ACD/2025/ENU/?guid=GUID-B6E54D87-C810-426F-8F82-5BBCF92A2B4E",
    source: "autocad-docs", title: "AutoCAD Draw Lines",
  },
  {
    url: "https://help.autodesk.com/view/ACD/2025/ENU/?guid=GUID-AF90CE3D-0A3C-4EC5-B826-B7A6A9F19588",
    source: "autocad-docs", title: "AutoCAD Draw Rectangles",
  },
  {
    url: "https://help.autodesk.com/view/ACD/2025/ENU/?guid=GUID-C7E6A0B0-3413-41E4-B2C3-C5AD5A12B4B2",
    source: "autocad-docs", title: "AutoCAD Draw Circles",
  },
  {
    url: "https://help.autodesk.com/view/ACD/2025/ENU/?guid=GUID-B27B0E26-0E11-44F5-A25D-E2D0D1B35DDB",
    source: "autocad-docs", title: "AutoCAD 3D Extrude",
  },
  {
    url: "https://help.autodesk.com/view/ACD/2025/ENU/?guid=GUID-2E56AA01-0B0E-450E-A600-A5C7E9B7CCA9",
    source: "autocad-docs", title: "AutoCAD 3D Box",
  },
  {
    url: "https://help.autodesk.com/view/ACD/2025/ENU/?guid=GUID-5A6A6D36-0A2E-4FF4-9FCA-44FC8D7BF0BA",
    source: "autocad-docs", title: "AutoCAD Union/Subtract/Intersect",
  },
  {
    url: "https://help.autodesk.com/view/ACD/2025/ENU/?guid=GUID-8A8CD0A3-F0D7-4ADB-9A2B-A5E0E5FB432E",
    source: "autocad-docs", title: "AutoCAD Move",
  },
  {
    url: "https://help.autodesk.com/view/ACD/2025/ENU/?guid=GUID-C54F0C86-6A7B-4B45-9D7F-2B5A9F3B5ADB",
    source: "autocad-docs", title: "AutoCAD Rotate",
  },
  {
    url: "https://help.autodesk.com/view/ACD/2025/ENU/?guid=GUID-9A5F1C86-8A8D-4B0B-9F3A-2B5A9F3B5ADB",
    source: "autocad-docs", title: "AutoCAD Scale",
  },
  {
    url: "https://help.autodesk.com/view/ACD/2025/ENU/?guid=GUID-A8A2F1D4-5B3C-4E6A-8B9C-2C4A7E8B1C3F",
    source: "autocad-docs", title: "AutoCAD Mirror",
  },
  {
    url: "https://help.autodesk.com/view/ACD/2025/ENU/?guid=GUID-B3C2A1F5-6D4E-5F7B-9C2E-3D5B8F2C4D6E",
    source: "autocad-docs", title: "AutoCAD Array",
  },
  {
    url: "https://help.autodesk.com/view/ACD/2025/ENU/?guid=GUID-D4E3B2G6-7E5F-6G8C-0D3F-4E6C9G3D5E7F",
    source: "autocad-docs", title: "AutoCAD Fillet",
  },

  // ── Rhino Discourse — solved "how do I" threads ────────────────────────
  {
    url: "https://discourse.mcneel.com/t/how-to-create-a-box-with-specific-dimensions/1000",
    source: "rhino-forum", title: "Discourse: create box with dimensions",
  },
  {
    url: "https://discourse.mcneel.com/t/best-way-to-boolean-union-multiple-objects/",
    source: "rhino-forum", title: "Discourse: boolean union multiple objects",
  },
  {
    url: "https://discourse.mcneel.com/t/how-to-use-filletedge-command/",
    source: "rhino-forum", title: "Discourse: FilletEdge usage",
  },

  // ── FreeCAD BIM / Arch workbench — architectural elements (#377) ─────────
  // Public wiki; "How to use" sections have numbered steps.
  // BIM_* = new unified workbench (FC 0.22+); Arch_* = legacy fallback pages.
  {
    url: "https://wiki.freecad.org/BIM_Wall",
    source: "freecad-arch", title: "FreeCAD Wall",
  },
  {
    url: "https://wiki.freecad.org/BIM_Slab",
    source: "freecad-arch", title: "FreeCAD Slab",
  },
  {
    url: "https://wiki.freecad.org/BIM_Column",
    source: "freecad-arch", title: "FreeCAD Column",
  },
  {
    url: "https://wiki.freecad.org/BIM_Beam",
    source: "freecad-arch", title: "FreeCAD Beam",
  },
  {
    url: "https://wiki.freecad.org/BIM_Door",
    source: "freecad-arch", title: "FreeCAD Door",
  },
  {
    url: "https://wiki.freecad.org/BIM_Window",
    source: "freecad-arch", title: "FreeCAD Window",
  },
  {
    url: "https://wiki.freecad.org/BIM_Roof",
    source: "freecad-arch", title: "FreeCAD Roof",
  },
  {
    url: "https://wiki.freecad.org/BIM_Floor",
    source: "freecad-arch", title: "FreeCAD Floor",
  },
  {
    url: "https://wiki.freecad.org/Arch_Wall",
    source: "freecad-arch", title: "FreeCAD Arch Wall",
  },
  {
    url: "https://wiki.freecad.org/Arch_Floor",
    source: "freecad-arch", title: "FreeCAD Arch Floor",
  },
  {
    url: "https://wiki.freecad.org/Arch_Door",
    source: "freecad-arch", title: "FreeCAD Arch Door",
  },
  {
    url: "https://wiki.freecad.org/Arch_Window",
    source: "freecad-arch", title: "FreeCAD Arch Window",
  },
  {
    url: "https://wiki.freecad.org/Arch_Roof",
    source: "freecad-arch", title: "FreeCAD Arch Roof",
  },
  {
    url: "https://wiki.freecad.org/Arch_Stairs",
    source: "freecad-arch", title: "FreeCAD Stair",
  },
  {
    url: "https://wiki.freecad.org/Arch_Structure",
    source: "freecad-arch", title: "FreeCAD Arch Column",
  },
  {
    url: "https://wiki.freecad.org/Arch_Panel",
    source: "freecad-arch", title: "FreeCAD Arch Slab",
  },
];

/** Group seeds by source category. */
export function seedsBySource() {
  /** @type {Map<string, SeedEntry[]>} */
  const groups = new Map();
  for (const s of SEEDS) {
    if (!groups.has(s.source)) groups.set(s.source, []);
    groups.get(s.source).push(s);
  }
  return groups;
}
