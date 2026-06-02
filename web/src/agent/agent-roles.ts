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
