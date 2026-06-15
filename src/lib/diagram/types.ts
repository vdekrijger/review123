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

/**
 * Plan L — flow-of-execution diagram.
 *
 * Where the change-map (Graph) shows STATIC module structure, ExecutionFlow
 * shows the EXECUTION PATH the change touches — entry point → handler →
 * service → store/effect — as a single delta-annotated flow (NOT before/after).
 * added/changed/removed steps render visually distinct so the delta is visible
 * in one view.
 */

/** What KIND of step this is — drives the node SHAPE in the serializer. */
export type FlowStepKind = 'entry' | 'call' | 'branch' | 'effect' | 'return'

/** Per-step delta tag — drives the node COLOUR (reuses the status classDefs). */
export type FlowChange = 'added' | 'changed' | 'unchanged' | 'removed'

export interface FlowStep {
  /** Unique id within the flow (arbitrary string; remapped before Mermaid). */
  id: string
  /** What happens at this step, ≤6 words. */
  label: string
  /** File the step lives in (for click-jump + #114 coverage). Optional. */
  file?: string
  /** Function/symbol the step lives in. Optional. */
  symbol?: string
  kind: FlowStepKind
  change: FlowChange
}

export interface FlowTransition {
  /** Source step id. */
  from: string
  /** Target step id. */
  to: string
  /** Optional ordered-edge label. */
  label?: string
  /** Optional branch condition (renders as an edge label, distinct from loops). */
  condition?: string
}

/**
 * An ordered execution flow. `steps` is the canonical reading order; the
 * serializer renders nodes in this order deterministically. An EMPTY steps
 * array is the graceful-fallback signal — the panel shows an honest "no clear
 * execution flow" note instead of a forced/empty diagram.
 */
export interface ExecutionFlow {
  steps: FlowStep[]
  transitions: FlowTransition[]
}

export interface GraphResult {
  before: Graph
  after: Graph
  kind: 'flow' | 'module'
  changeMap?: Graph
  /**
   * Plan L (PROMPT_VERSION 17): the flow-of-execution diagram. Optional and
   * additive — old cached change-map results lacking `flow` still validate and
   * render via the change-map path. When present (even with empty steps) the
   * panel prefers it over the change-map.
   */
  flow?: ExecutionFlow
}
