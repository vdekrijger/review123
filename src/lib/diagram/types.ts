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
 * Change-impact / blast-radius diagram (PROMPT_VERSION 24).
 *
 * REPLACES the retired flow-of-execution diagram (Plan L). Instead of tracing
 * the WHOLE execution path (which dragged in unchanged plumbing → a big,
 * low-value spaghetti graph), this answers the reviewer's real question — *what
 * does this change touch?* — with a TINY graph centred on the CHANGED symbols:
 *
 *   - `changed`  : the functions/classes/methods/endpoints the diff adds /
 *                  changes / removes (the centre, accent-styled).
 *   - `callers`  : 1-hop UPSTREAM — code that references the changed symbols
 *                  (the blast radius / "affected by this change" / risk).
 *   - `callees`  : 1-hop DOWNSTREAM — what the changed code now calls/depends on
 *                  ("this change uses").
 *
 * Renders by composition into a `Graph` (changed = added/changed/removed status,
 * callers + callees = de-emphasized `context` status) — see impactToMermaid /
 * impactToGraph in lib/diagram/mermaid.ts.
 *
 * An EMPTY impact (no changed symbols with notable callers/callees) is the
 * AUTO-SUPPRESS signal — the panel shows an honest muted note rather than a
 * forced/empty diagram (most data/config/CRUD changes land here).
 */

/** What KIND of change the symbol underwent — drives the centre node status. */
export type ImpactKind = 'added' | 'changed' | 'removed'

/** One changed symbol at the centre of the blast radius. */
export interface ImpactChanged {
  /** The changed symbol (function/class/method/endpoint). */
  symbol: string
  /** File the symbol lives in (for jump-to + grounding). Optional. */
  file?: string
  kind: ImpactKind
}

/** One caller or callee node (1-hop neighbour of the changed code). */
export interface ImpactNode {
  symbol: string
  /** File the symbol lives in. Optional. */
  file?: string
}

export interface ChangeImpact {
  /** The changed code — centre of the graph. */
  changed: ImpactChanged[]
  /** 1-hop upstream: what calls/references the changed code (affected / risk). */
  callers: ImpactNode[]
  /** 1-hop downstream: what the changed code now calls/depends on. */
  callees: ImpactNode[]
}

export interface GraphResult {
  before: Graph
  after: Graph
  kind: 'flow' | 'module'
  changeMap?: Graph
  /**
   * Change-impact / blast-radius view (PROMPT_VERSION 24). Optional and
   * additive — old cached results lacking `impact` validate and degrade to the
   * suppressed note (never a forced diagram). When present with at least one
   * changed symbol the panel prefers it; an empty `impact` auto-suppresses.
   */
  impact?: ChangeImpact
}
