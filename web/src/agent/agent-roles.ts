// agent-roles.ts — Role-based verb filter for the agent system prompt (#395 gap #5 PR 1).
// Each role receives a subset of the 323 spatial verbs relevant to its task domain.
// §15 AgentMeta goal verbs (create_goal / update_goal / get_goal) are always included
// regardless of role so the agent can signal task completion in every context.

import type { SpatialDictionaryEntry } from '../commands/dictionary';

export type AgentRole = 'architectural' | 'geometry' | 'analysis';

// §15 AgentMeta verbs — always included regardless of role.
const AGENT_META_NAMES = new Set(['create_goal', 'update_goal', 'get_goal']);

// Maps each role to the set of topology_role values it should receive.
// topology_role is the canonical field on SpatialDictionaryEntry that mirrors
// the §N section groupings in spatial-api.yaml.
const ROLE_TOPOLOGIES: Record<AgentRole, ReadonlySet<string>> = {
  // Architectural: IFC4 building elements + positioning + organisation + views.
  // Excludes raw geometry (solid / edge / face / curve / compound / NURBS mesh).
  architectural: new Set(['host', 'hosted', 'system', 'transform', 'view', 'selection', 'annotation']),
  // Geometry: 3-D modelling — primitives, NURBS, boolean ops, transforms, mesh.
  // Excludes IFC-specific host/hosted elements (walls, doors, etc.).
  geometry:      new Set(['solid', 'edge', 'face', 'curve', 'compound', 'transform', 'selection']),
  // Analysis: inspection, measurement, annotation, queries.
  // Excludes mutation verbs (nothing gets created or moved).
  analysis:      new Set(['annotation', 'system', 'view', 'selection']),
};

/** Returns true if `entry` belongs in the system prompt for `role`. */
export function matchesRole(entry: SpatialDictionaryEntry, role: AgentRole): boolean {
  if (AGENT_META_NAMES.has(entry.name)) return true;
  return (ROLE_TOPOLOGIES[role] as Set<string>).has(entry.topology_role as string);
}

// ---------------------------------------------------------------------------
// Role classifier — keyword scoring, no model call (#395 gap #5 PR 3)
// ---------------------------------------------------------------------------

// Exclusive keyword banks: each term appears in at most one role.
// Verbs and highly specific nouns only — avoids common words that appear in
// multi-role prompts (e.g. "floor", "surface", "solid") and cause false ties.
const ROLE_KEYWORDS: Record<AgentRole, readonly string[]> = {
  architectural: [
    'wall', 'door', 'window', 'slab', 'column', 'beam',
    'stair', 'ramp', 'railing', 'curtain wall', 'opening', 'void', 'ifc', 'room',
  ],
  geometry: [
    'sphere', 'cylinder', 'box', 'cube', 'cone', 'torus', 'nurbs',
    'extrude', 'revolve', 'boolean', 'union', 'subtract', 'intersect',
    'chamfer', 'fillet', 'sweep', 'loft', 'brep',
  ],
  analysis: [
    'measure', 'count', 'area', 'volume', 'distance', 'perimeter',
    'how many', 'list all', 'get all', 'report', 'inspect', 'query',
    'properties', 'find all', 'what is', 'how far',
  ],
};

/**
 * Infers the most appropriate role for a user prompt using keyword scoring.
 * Returns `undefined` when confidence is low (0 hits, tie, or equal top scores)
 * so the caller defaults to all verbs rather than mis-routing.
 */
export function selectAgentRole(prompt: string): AgentRole | undefined {
  const lower = prompt.toLowerCase();
  const scores: Record<AgentRole, number> = { architectural: 0, geometry: 0, analysis: 0 };
  for (const role of Object.keys(ROLE_KEYWORDS) as AgentRole[]) {
    for (const kw of ROLE_KEYWORDS[role]) {
      if (lower.includes(kw)) scores[role]++;
    }
  }
  const nonZero = (Object.entries(scores) as [AgentRole, number][]).filter(([, s]) => s > 0);
  // Narrow only when exactly one role matches — multi-role prompts get all-verbs to avoid
  // dropping verbs the agent will need (e.g. "draw a wall and measure its area" → undefined,
  // not "analysis", so SdWall is still available).
  if (nonZero.length === 1) return nonZero[0][0];
  return undefined;
}
