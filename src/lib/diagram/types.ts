/**
 * Graph types for the diagram module.
 *
 * NOTE FOR TASK 6: This is the canonical source of Graph / GraphResult types.
 * src/lib/ai/schemas.ts (Task 6) should import Graph and GraphResult from here
 * rather than redefining them, to avoid divergence between the serializer and
 * the AI schema validator.
 */

export interface Graph {
  nodes: { id: string; label: string }[]
  edges: { from: string; to: string; label?: string }[]
}

export interface GraphResult {
  before: Graph
  after: Graph
  kind: 'flow' | 'module'
}
