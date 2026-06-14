/**
 * Graph types for the diagram module.
 *
 * NOTE FOR TASK 6: This is the canonical source of Graph / GraphResult types.
 * src/lib/ai/schemas.ts (Task 6) should import Graph and GraphResult from here
 * rather than redefining them, to avoid divergence between the serializer and
 * the AI schema validator.
 */

/**
 * Node/edge status drives the Mermaid classDef styling.
 *
 * The `context` status (deep-diagram mode) marks one-hop architectural
 * neighborhood nodes — direct importers/callers of the changed modules and
 * their direct dependencies — so the diagram situates the change inside the
 * broader system. Context nodes render DE-EMPHASIZED (muted, dashed, low
 * contrast) so the changed nodes stay the visual focus.
 *
 * It is an ADDITIVE extension: old cached graphs that never carry `context`
 * still validate and render byte-identically.
 */
export type NodeStatus = 'added' | 'removed' | 'changed' | 'unchanged' | 'context'

export interface Graph {
  nodes: { id: string; label: string; status?: NodeStatus }[]
  edges: { from: string; to: string; label?: string; status?: NodeStatus }[]
}

export interface GraphResult {
  before: Graph
  after: Graph
  kind: 'flow' | 'module'
  changeMap?: Graph
}
