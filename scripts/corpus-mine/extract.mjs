/**
 * extract.mjs — step extraction + WEB-CAD translation.
 *
 * Given a FetchedDoc (from fetch.mjs), extracts procedure steps and translates
 * each step into a WEB-CAD scenario entry.
 *
 * Step-detection heuristics (applied in order):
 *   1. Numbered-list items preserved by htmlToText: "N. text"
 *   2. Explicit "Step N:" / "Step N —" markers
 *   3. Imperative-verb sentences near a known CAD command token
 *
 * Translation:
 *   - Verb token detected via lookupVerb() (translate.mjs)
 *   - Dimensions extracted via DIMENSION_RE (converts metric → imperial if needed)
 *   - Instruction string rewritten for imperial-only rule
 *
 * Output schema per scenario:
 * {
 *   id:             string           // "{source}-{sha8}-{seq}"
 *   instruction:    string           // imperial NL instruction
 *   expected_state: {
 *     verb:          string          // WEB-CAD verb
 *     geometry_class: string         // "sketch" | "solid" | "transform" | "architectural"
 *   }
 *   provenance: {
 *     source:       string           // seed source category
 *     url:          string
 *     fetched_at:   string
 *     step_context: string           // surrounding paragraph (≤500 chars)
 *   }
 * }
 */

import { lookupVerb } from "./translate.mjs";

// Matches "N. text" from htmlToText numbered lists
const NUMBERED_STEP_RE = /^(\d+)\.\s+(.{10,300})$/m;

// Matches "Step N:" / "Step N —" / "Step N -" patterns
const STEP_LABEL_RE = /\bstep\s+\d+\s*[:\-–—]\s*(.{10,300})/gi;

// Detects a dimension value (e.g. "10 feet", "5 ft", "24 inches", "1.5 m", "2.5 meters")
const DIMENSION_RE = /(\d+(?:\.\d+)?)\s*(feet|foot|ft|inches?|in\b|"|mm|cm|m\b|meters?)/gi;

// Detects a known CAD verb token in a sentence
const VERB_TOKEN_RE = /\b(rectangle|rect|circle|line|arc|polyline|polygon|ellipse|spline|box|cylinder|sphere|cone|extrudecrv|extrude|revolve|sweep1?|sweep2?|loft|booleanunion|union|booleandifference|difference|booleanintersection|intersection|filletedge|fillet|chamferedge|chamfer|shell|offsetsrf|offset|move|rotate|rotate3d|scale|mirror|arrayrect|arraypolar|array|wall|createwall|floor|slab|createfloor|column|createcolumn|beam|door|createdoor|window|createwindow|roof|createroofbyoutline|stair|stairbysketch)\b/i;

/**
 * @param {string} text  contentText from a FetchedDoc
 * @param {string} url
 * @param {string} source
 * @param {string} fetchedAt
 * @param {string} seedTitle
 * @param {string} sourcePrefix  e.g. "rhino-docs" → used for id prefix
 * @param {{ startSeq: number }} state  mutable counter for id generation
 * @returns {import('./run.mjs').ScenarioEntry[]}
 */
export function extractScenarios(text, url, source, fetchedAt, seedTitle, sourcePrefix, state) {
  const scenarios = [];
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Try numbered-step pattern first
    const numMatch = line.match(/^(\d+)\.\s+(.{15,300})$/);
    if (numMatch) {
      const stepText = numMatch[2];
      if (isInstructional(stepText)) {
        const scenario = tryTranslate(stepText, url, source, fetchedAt, sourcePrefix, state, lines, i);
        if (scenario) scenarios.push(scenario);
      }
      continue;
    }

    // Try Step-N label pattern
    const stepLabelMatch = line.match(/\bstep\s+\d+\s*[:\-–—]\s*(.{15,300})/i);
    if (stepLabelMatch) {
      const stepText = stepLabelMatch[1];
      if (isInstructional(stepText)) {
        const scenario = tryTranslate(stepText, url, source, fetchedAt, sourcePrefix, state, lines, i);
        if (scenario) scenarios.push(scenario);
      }
    }
    // Note: VERB_TOKEN_RE catch-all removed — too noisy on command-reference pages.
    // Numbered steps + Step-N labels are the reliable signal; description sentences are not.
  }

  return scenarios;
}

/**
 * Heuristic: does this text look like an instruction vs. a description?
 * Filters out: "The X command...", "UseExtrusion...", "Note:", single words, etc.
 * Passes: "Pick the first corner...", "Type the height...", "Create a box...", etc.
 * @param {string} text
 * @returns {boolean}
 */
function isInstructional(text) {
  const t = text.trim();
  if (t.length < 20) return false;
  // Description patterns to reject
  if (/^the\s+\w+\s+command/i.test(t)) return false;
  if (/^(use|this|note:|tip:|warning:|see also|related)/i.test(t)) return false;
  if (/^[A-Z][a-z]*$/.test(t)) return false; // single capitalized word (option name)
  if (/^(creates?|sets?|specifies?|determines?|controls?)\s/i.test(t)) return false;
  if (t.includes(" | ")) return false; // breadcrumb nav: "Box | Rhino 3-D modeling"
  return true;
}

/**
 * Positional mapping: verb → ordered list of arg names for dimensional parsing.
 * Values stored in inches (imperial-only hard ban). Angles excluded (not linear dims).
 */
const VERB_ARGS_SCHEMA = {
  SdBox:        ["width", "depth", "height"],
  SdCylinder:   ["r", "height"],
  SdSphere:     ["r"],
  SdCone:       ["r", "height"],
  SdRect:       ["width", "height"],
  SdCircle:     ["r"],
  SdLine:       ["length"],
  SdArc:        ["r"],
  SdExtrude:    ["distance"],
  SdFillet:     ["r"],
  SdChamfer:    ["distance"],
  SdShell:      ["thickness"],
  SdMove:       ["x"],
  SdBeam:       ["length"],
  SdWall:       ["length", "thickness", "height"],
  SdSlab:       ["width", "length"],
  SdDoor:       ["width", "height"],
  SdWindow:     ["width", "height"],
  SdRoof:       ["width", "length"],
  SdStair:      ["height", "run"],
};

/**
 * Parse imperial dimensions from an instruction string into typed arg objects.
 * All values stored in inches {value: N, unit: "in"}.
 * Returns null if no dimensions found or verb has no schema.
 * @param {string} instruction
 * @param {string} verb  WEB-CAD verb e.g. "SdBox"
 * @returns {object|null}
 */
function parseArgsFromInstruction(instruction, verb) {
  const schema = VERB_ARGS_SCHEMA[verb];
  if (!schema || schema.length === 0) return null;

  const dims = [];
  // Allow optional hyphen/space between number and unit ("10-foot", "6-inch", "10 feet")
  const re = /(\d+(?:\.\d+)?)[\s-]*(feet?|foot|ft|inch(?:es)?|in\b|"(?!\w))/gi;
  let m;
  while ((m = re.exec(instruction)) !== null) {
    const raw = parseFloat(m[1]);
    const u = m[2].toLowerCase();
    const inInches = (u === "ft" || u.startsWith("foot") || u.startsWith("feet"))
      ? Math.round(raw * 12 * 100) / 100
      : Math.round(raw * 100) / 100;
    dims.push(inInches);
  }

  if (dims.length === 0) return null;

  const args = {};
  const count = Math.min(dims.length, schema.length);
  for (let i = 0; i < count; i++) {
    args[schema[i]] = { value: dims[i], unit: "in" };
  }
  return Object.keys(args).length > 0 ? args : null;
}

/**
 * Attempt to translate a candidate step text into a WEB-CAD scenario.
 * Returns null if no WEB-CAD verb is found.
 */
function tryTranslate(stepText, url, source, fetchedAt, sourcePrefix, state, lines, lineIdx) {
  // Find the first CAD verb token in the step
  const verbMatch = stepText.match(VERB_TOKEN_RE);
  if (!verbMatch) return null;

  const verbToken = verbMatch[0];
  const target = lookupVerb(verbToken);
  if (!target) return null;

  // Build instruction — convert to imperial if metric dims present
  const instruction = imperializeInstruction(stepText);

  // Parse args from imperial dims in instruction
  const args = parseArgsFromInstruction(instruction, target.verb);

  // Step context = surrounding lines (±2)
  const ctxLines = lines.slice(Math.max(0, lineIdx - 2), lineIdx + 3);
  const step_context = ctxLines.join(" ").slice(0, 500);

  const id = `${sourcePrefix.replace(/[^a-z0-9]/gi, "-")}-${(state.startSeq++).toString().padStart(4, "0")}`;

  return {
    id,
    instruction,
    expected_state: {
      verb: target.verb,
      geometry_class: target.geometry_class,
      ...(args ? { args } : {}),
    },
    provenance: {
      source,
      url,
      fetched_at: fetchedAt,
      step_context,
    },
  };
}

/**
 * Convert metric dimension strings to imperial in-place.
 * "1 m" → "3.3 feet", "100 mm" → "4 inches", "30 cm" → "12 inches"
 * Leaves existing feet/inches unchanged.
 * @param {string} text
 * @returns {string}
 */
function imperializeInstruction(text) {
  return text.replace(DIMENSION_RE, (match, num, unit) => {
    const n = parseFloat(num);
    const u = unit.toLowerCase();
    if (u === "mm") {
      return `${(n / 25.4).toFixed(1)} inches`;
    } else if (u === "cm") {
      return `${(n / 2.54).toFixed(1)} inches`;
    } else if (u === "m" || u === "meter" || u === "meters") {
      const feet = n * 3.281;
      return `${feet.toFixed(1)} feet`;
    }
    return match; // already imperial
  });
}

/**
 * Template-based scenario generation from a command-reference page.
 * For pages that describe ONE command (sparse numbered steps), generates
 * one high-quality scenario from the command name + default dimensions.
 * Uses imperial-only dimensions.
 *
 * @param {string} seedTitle  e.g. "Rhino Box command"
 * @param {string} url
 * @param {string} source
 * @param {string} fetchedAt
 * @param {string} sourcePrefix
 * @param {{ startSeq: number }} state
 * @returns {object | null}
 */
export function templateScenario(seedTitle, url, source, fetchedAt, sourcePrefix, state) {
  // Extract the command name from the title
  const m = seedTitle.match(/\b(Box|Cylinder|Sphere|Cone|Rectangle|Circle|Line|Arc|Polyline|Polygon|Ellipse|Spline|ExtrudeCrv|Extrude|Revolve|Sweep|Loft|BooleanUnion|BooleanDifference|FilletEdge|Fillet|ChamferEdge|Chamfer|Shell|Move|Rotate|Scale|Mirror|ArrayRect|Array|Wall|Floor|Slab|Column|Beam|Door|Window|Roof|Stair)\b/i);
  if (!m) return null;
  const cmd = m[1].toLowerCase();

  // Static template map — imperial-only dimensions
  const TEMPLATES = {
    box:            "Draw a 10-foot by 8-foot by 9-foot box",
    cylinder:       "Draw a cylinder with a 3-foot radius and 8-foot height",
    sphere:         "Draw a sphere with a 5-foot radius",
    cone:           "Draw a cone with a 2-foot base radius and 6-foot height",
    rectangle:      "Draw a 12-foot by 20-foot rectangle",
    circle:         "Draw a circle with a 4-foot radius",
    line:           "Draw a 15-foot line",
    arc:            "Draw an arc with a 6-foot radius spanning 90 degrees",
    polyline:       "Draw a 4-point polyline forming an L-shape",
    polygon:        "Draw a hexagonal polygon with a 3-foot inradius",
    extrudecrv:     "Extrude a closed curve 10 feet upward",
    extrude:        "Extrude a rectangle 10 feet along the Z axis",
    revolve:        "Revolve a profile curve 360 degrees around the Z axis",
    sweep:          "Sweep a circular cross-section along a path curve",
    loft:           "Loft three parallel rectangular curves into a solid",
    booleanunion:   "Boolean union two overlapping boxes into one solid",
    booleandifference: "Boolean difference to cut a cylinder out of a box",
    filletedge:     "Apply a 6-inch fillet radius to the top edges of a box",
    fillet:         "Apply a 3-inch fillet to all vertical edges of a box",
    chamferedge:    "Chamfer the top edges of a box with a 4-inch distance",
    chamfer:        "Chamfer the bottom edge of a cylinder 2 inches",
    shell:          "Shell a solid box to a 1-inch wall thickness",
    move:           "Move the selected box 5 feet in the X direction",
    rotate:         "Rotate the selected object 45 degrees around the Z axis",
    scale:          "Scale the selected object uniformly by a factor of 2",
    mirror:         "Mirror the selected wall about the center line",
    arrayrect:      "Create a 4 by 3 rectangular array of columns spaced 10 feet apart",
    array:          "Create a 3 by 2 array of boxes spaced 8 feet on center",
    wall:           "Draw a 20-foot long wall that is 8 inches thick and 9 feet tall",
    floor:          "Create a floor slab 30 feet by 40 feet at the ground level",
    slab:           "Create a concrete slab 20 feet by 30 feet at level 1",
    column:         "Place a structural column at the corner of the floor plan",
    beam:           "Add a horizontal beam spanning 20 feet between two columns",
    door:           "Insert a 3-foot wide by 7-foot tall door in the exterior wall",
    window:         "Insert a 4-foot wide by 5-foot tall window in the south wall",
    roof:           "Create a gabled roof over a 24-foot by 40-foot floor plan",
    stair:          "Add a straight stair rising 9 feet over a 12-foot run",
  };

  const instruction = TEMPLATES[cmd] ?? TEMPLATES[cmd.replace(/edge$/, "")];
  if (!instruction) return null;

  const target = lookupVerb(cmd);
  if (!target) return null;

  const args = parseArgsFromInstruction(instruction, target.verb);

  const id = `${sourcePrefix.replace(/[^a-z0-9]/gi, "-")}-tmpl-${(state.startSeq++).toString().padStart(4, "0")}`;
  return {
    id,
    instruction,
    expected_state: {
      verb: target.verb,
      geometry_class: target.geometry_class,
      ...(args ? { args } : {}),
    },
    provenance: {
      source,
      url,
      fetched_at: fetchedAt,
      step_context: `(template generated from command reference: ${seedTitle})`,
    },
  };
}

/**
 * Deduplicate scenarios by instruction text (case-insensitive, trimmed).
 * Keeps the first occurrence.
 * @param {object[]} scenarios
 * @returns {object[]}
 */
export function deduplicateScenarios(scenarios) {
  const seen = new Set();
  return scenarios.filter(s => {
    const key = s.instruction.toLowerCase().trim().slice(0, 120);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
