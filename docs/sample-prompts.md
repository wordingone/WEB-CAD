# WEB-CAD MCP — Sample Prompts

Representative prompts for the `webcad` MCP server. All geometry uses imperial units.

---

## Architectural

- "Draw a 20-foot wall starting at the origin, heading east."
- "Add a 3-foot-wide, 7-foot-tall door opening in the north wall."
- "Place a 12-by-12-inch structural column at each corner of a 30-by-40-foot plan."
- "Create a 4-storey building shell: 30×40-foot plan, 12-foot floor-to-floor, starting at level 1."
- "Add a pitched roof over the existing walls — 8-foot eave height, 6/12 pitch."

## Geometry

- "Create a 6-foot-diameter sphere at the origin."
- "Draw a 10-foot cube, then subtract a 2-foot cylinder from its center."
- "Extrude this closed L-profile 15 feet along +Z to create a column."
- "Sweep the rectangular tube profile along the curved guide rail."
- "Build a lofted surface through 3 elliptical cross-sections spaced 5 feet apart."
- "Add a 3-inch fillet to all vertical edges of the box."
- "Create a NURBS surface from the 4×4 control-point grid."

## Analysis / inspection

- "List all objects in the current scene with their UUIDs, types, and layers."
- "How many walls are on level 2?"
- "Measure the floor area enclosed by the perimeter walls."

## Slot-based parallel session

- "Create a WEB-CAD slot, draw a 20-foot wall, capture a screenshot, then close the slot."
- "Open two isolated slots: place a box in slot A and a sphere in slot B, then compare the scenes."
- "Run 3 parallel slot sessions, each testing a different roof form; capture a screenshot from each, then close all slots."

## Verb discovery

- "What geometry verbs are available in the 'boolean' category?"
- "Show me the parameter schema for SdWall before I call it."
- "List all verbs in the 'NURBS surface' category."
