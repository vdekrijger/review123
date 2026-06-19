import type { Graph, NodeStatus, ChangeImpact, ImpactKind } from './types'

export type { Graph, GraphResult } from './types'

/**
 * Escape a node/edge label for use inside Mermaid double-quoted strings:
 *   - Replace " with #quot;
 *   - Replace newlines (CR, LF, CRLF) with a space
 *   - Strip backticks (they break Mermaid even inside quotes)
 */
function escapeLabel(raw: string): string {
  return raw
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/`/g, '')
    .replace(/"/g, '#quot;')
}

export interface MermaidResult {
  mermaid: string
  dropped: string[]
}

/**
 * Mermaid classDef declarations for each NodeStatus, keyed by palette.
 * Emitted once (after the header) when any node or edge carries a status.
 */
const CLASS_DEFS: Record<'dark' | 'light', Record<NodeStatus, string>> = {
  dark: {
    added:     'classDef added fill:#1a4731,stroke:#2ea44f,color:#7ee2a8',
    removed:   'classDef removed fill:#4a1a1a,stroke:#d73a49,color:#f0a3a3,stroke-dasharray: 5 5',
    changed:   'classDef changed fill:#4a3a10,stroke:#d4a72c,color:#ffd86e',
    unchanged: 'classDef unchanged fill:#2a2a2e,stroke:#555,color:#aaa',
    // Context (deep-diagram neighborhood): de-emphasized — muted dark fill,
    // thin dashed border, low-contrast text so changed nodes stay the focus.
    context:   'classDef context fill:#202024,stroke:#3d3d44,color:#8a8a93,stroke-width:1px,stroke-dasharray: 3 3',
  },
  light: {
    added:     'classDef added fill:#dcffe4,stroke:#2ea44f,color:#1a7f37',
    removed:   'classDef removed fill:#ffe5e5,stroke:#d73a49,color:#cb2431,stroke-dasharray: 5 5',
    changed:   'classDef changed fill:#fff5cc,stroke:#d4a72c,color:#9a6700',
    unchanged: 'classDef unchanged fill:#f0f0f2,stroke:#bbb,color:#666',
    // Context (deep-diagram neighborhood): de-emphasized — muted light fill,
    // thin dashed border, low-contrast text so changed nodes stay the focus.
    context:   'classDef context fill:#f6f6f8,stroke:#d0d0d6,color:#9b9b9b,stroke-width:1px,stroke-dasharray: 3 3',
  },
}

const STATUS_ORDER: NodeStatus[] = ['added', 'removed', 'changed', 'unchanged', 'context']

/**
 * Serialize a Graph to a Mermaid flowchart string.
 *
 * Contract:
 * - Uses `flowchart TD` header.
 * - Node ids are remapped deterministically to n0, n1, … (original ids never
 *   reach the Mermaid syntax, so arbitrary strings are safe).
 * - Labels are double-quoted; internal `"` → #quot;, newlines → space,
 *   backticks stripped.
 * - Edges whose `from` or `to` reference an id not present in nodes are
 *   DROPPED and returned in `dropped` (EC-14e).
 * - Empty graph → `{ mermaid: '', dropped: [] }` (EC-14a).
 * - Self-loops and cycles serialize naturally (EC-14d).
 * - Status-aware: when any node/edge carries a `status` field, emits classDef
 *   lines for each status present, then `class nX status` assignments. Edges
 *   with status=removed OR status=context use dashed syntax (`-.->`),
 *   status=added use thick syntax (`==>`); others use normal arrows. Context
 *   nodes (deep-diagram one-hop neighborhood) render de-emphasized (muted fill,
 *   thin dashed border). Graphs without any status field are byte-identical to
 *   the pre-status implementation.
 *
 * @param g    The graph to serialize.
 * @param _kind  The diagram kind ('flow' | 'module') — currently both use
 *               flowchart TD; reserved for future layout variation.
 */
export function graphToMermaid(
  g: Graph,
  _kind: 'flow' | 'module' = 'flow',
  options?: { palette?: 'dark' | 'light' }
): MermaidResult {
  const palette = options?.palette ?? 'dark'
  if (g.nodes.length === 0) {
    return { mermaid: '', dropped: [] }
  }

  // Build a map: original id → safe alias (n0, n1, …)
  const idMap = new Map<string, string>()
  for (let i = 0; i < g.nodes.length; i++) {
    idMap.set(g.nodes[i].id, `n${i}`)
  }

  // Determine whether any status is present (nodes or edges)
  const hasAnyStatus =
    g.nodes.some((n) => n.status !== undefined) ||
    g.edges.some((e) => e.status !== undefined)

  // Collect which statuses are actually used (for deterministic classDef emission)
  const usedStatuses = new Set<NodeStatus>()
  if (hasAnyStatus) {
    for (const node of g.nodes) {
      if (node.status !== undefined) usedStatuses.add(node.status)
    }
    for (const edge of g.edges) {
      if (edge.status !== undefined) usedStatuses.add(edge.status)
    }
  }

  const lines: string[] = ['flowchart TD']

  // Emit classDef lines once, in deterministic order, when statuses are present
  if (hasAnyStatus) {
    const defs = CLASS_DEFS[palette]
    for (const status of STATUS_ORDER) {
      if (usedStatuses.has(status)) {
        lines.push(`    ${defs[status]}`)
      }
    }
  }

  // Emit node definitions: nN["label"]
  for (const node of g.nodes) {
    const alias = idMap.get(node.id)!
    const label = escapeLabel(node.label)
    lines.push(`    ${alias}["${label}"]`)
  }

  // Emit class assignment lines for nodes with status
  if (hasAnyStatus) {
    for (const node of g.nodes) {
      if (node.status !== undefined) {
        const alias = idMap.get(node.id)!
        lines.push(`    class ${alias} ${node.status}`)
      }
    }
  }

  // Emit edges; drop any with unknown from/to
  const dropped: string[] = []
  for (const edge of g.edges) {
    const fromAlias = idMap.get(edge.from)
    const toAlias = idMap.get(edge.to)

    if (fromAlias === undefined) {
      dropped.push(edge.from)
      continue
    }
    if (toAlias === undefined) {
      dropped.push(edge.to)
      continue
    }

    // Determine edge arrow style based on status. `context` edges (deep-diagram
    // neighborhood "uses/calls" relationships) use the dotted arrow so they read
    // as ambient context, distinct from the thick `added` / dashed `removed`
    // change edges.
    let arrowHead: string
    if (edge.status === 'removed' || edge.status === 'context') {
      arrowHead = '-.->'
    } else if (edge.status === 'added') {
      arrowHead = '==>'
    } else {
      arrowHead = '-->'
    }

    if (edge.label !== undefined && edge.label !== '') {
      const edgeLabel = escapeLabel(edge.label)
      if (edge.status === 'removed' || edge.status === 'context') {
        lines.push(`    ${fromAlias} -. "${edgeLabel}" .-> ${toAlias}`)
      } else if (edge.status === 'added') {
        lines.push(`    ${fromAlias} == "${edgeLabel}" ==> ${toAlias}`)
      } else {
        lines.push(`    ${fromAlias} -- "${edgeLabel}" --> ${toAlias}`)
      }
    } else {
      lines.push(`    ${fromAlias} ${arrowHead} ${toAlias}`)
    }
  }

  return { mermaid: lines.join('\n'), dropped }
}

// ---------------------------------------------------------------------------
// impactToMermaid — render a ChangeImpact (blast-radius view) as a flowchart TD
// ---------------------------------------------------------------------------

/**
 * Result of serializing a ChangeImpact. `mermaid` is empty when there is no
 * changed symbol — the caller (DiagramPanel) then renders the honest
 * "No notable call-graph impact" note instead of a forced/empty diagram (the
 * AUTO-SUPPRESS path). `dropped` is reserved for parity with the graph
 * serializer (impact composes into a Graph with no dangling edges, so it is
 * always empty here).
 */
export interface ImpactMermaidResult {
  mermaid: string
  dropped: string[]
}

// The changed-symbol `kind` reuses the three change classDefs (added / removed
// / changed) so both palettes already cover the centre — no new colours.
const IMPACT_KIND_TO_STATUS: Record<ImpactKind, NodeStatus> = {
  added: 'added',
  removed: 'removed',
  changed: 'changed',
}

/** Format a node label: `symbol` alone, or `symbol — file-basename` when a file is present. */
function impactLabel(symbol: string, file?: string): string {
  if (!file) return symbol
  const base = file.split('/').pop() || file
  return `${symbol} — ${base}`
}

/**
 * Compose a ChangeImpact into a status-bearing `Graph` for rendering.
 *
 * Layout (top → bottom): callers (de-emphasized `context`) → changed (centre,
 * accent change status) → callees (de-emphasized `context`). Edges read
 * `caller --calls--> changed` and `changed --uses--> callee`, both with the
 * dotted `context` arrow so they sit as ambient blast-radius, not loud change
 * edges. The two sides are distinguished by edge labels ("calls" vs "uses") and
 * their position relative to the accent centre.
 *
 * Pure + deterministic. Node ids are namespaced (caller#i / changed#i /
 * callee#i) so duplicate symbols across groups never collide. Each caller is
 * wired to EVERY changed node, and each callee from EVERY changed node — a
 * blast-radius view, not a precise per-symbol call graph.
 */
export function impactToGraph(impact: ChangeImpact): Graph {
  const nodes: Graph['nodes'] = []
  const edges: Graph['edges'] = []

  const changedIds: string[] = []
  for (let i = 0; i < impact.changed.length; i++) {
    const c = impact.changed[i]
    const id = `changed#${i}`
    changedIds.push(id)
    nodes.push({ id, label: impactLabel(c.symbol, c.file), status: IMPACT_KIND_TO_STATUS[c.kind] })
  }

  for (let i = 0; i < impact.callers.length; i++) {
    const n = impact.callers[i]
    const id = `caller#${i}`
    nodes.push({ id, label: impactLabel(n.symbol, n.file), status: 'context' })
    for (const cid of changedIds) {
      edges.push({ from: id, to: cid, label: 'calls', status: 'context' })
    }
  }

  for (let i = 0; i < impact.callees.length; i++) {
    const n = impact.callees[i]
    const id = `callee#${i}`
    nodes.push({ id, label: impactLabel(n.symbol, n.file), status: 'context' })
    for (const cid of changedIds) {
      edges.push({ from: cid, to: id, label: 'uses', status: 'context' })
    }
  }

  return { nodes, edges }
}

/**
 * Serialize a ChangeImpact to a Mermaid `flowchart TD` string via impactToGraph
 * + graphToMermaid. An impact with NO changed symbols → `{ mermaid: '', … }`
 * (the auto-suppress signal). Deterministic.
 */
export function impactToMermaid(
  impact: ChangeImpact,
  options?: { palette?: 'dark' | 'light' },
): ImpactMermaidResult {
  if (impact.changed.length === 0) {
    return { mermaid: '', dropped: [] }
  }
  return graphToMermaid(impactToGraph(impact), 'flow', options)
}

/**
 * Whether a ChangeImpact is worth rendering. EMPTY (no changed symbol) → the
 * panel suppresses to an honest muted note. A changed symbol with zero callers
 * AND zero callees still renders (the centre alone is informative — "this
 * symbol changed; nothing references it / it calls nothing notable").
 */
export function impactIsRenderable(impact: ChangeImpact | undefined): boolean {
  return !!impact && impact.changed.length > 0
}
