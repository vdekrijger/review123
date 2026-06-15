import type { Graph, NodeStatus, ExecutionFlow, FlowChange, FlowStepKind } from './types'

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
// flowToMermaid (Plan L) — render an ExecutionFlow as a flowchart TD
// ---------------------------------------------------------------------------

/**
 * Result of serializing a flow. `mermaid` is empty when there are no steps —
 * the caller (DiagramPanel) then renders the honest "no clear execution flow"
 * fallback note instead of an empty diagram. `dropped` lists transition
 * endpoints that referenced an unknown step id (defensive; mirrors graph edges).
 */
export interface FlowMermaidResult {
  mermaid: string
  dropped: string[]
}

// A flow step's `change` reuses the four core status classDefs (added / removed
// / changed / unchanged) so the dark+light palettes already cover it — no new
// colours. `context` is graph-only and never used by flows.
const FLOW_CHANGE_TO_STATUS: Record<FlowChange, NodeStatus> = {
  added: 'added',
  removed: 'removed',
  changed: 'changed',
  unchanged: 'unchanged',
}

/**
 * Wrap a (pre-escaped) label in the Mermaid shape delimiters for a step kind:
 *   - entry  → stadium  `([ … ])`  (the start of the run)
 *   - effect → subroutine `[[ … ]]` (a side effect: DB write, API response, …)
 *   - branch → rhombus  `{ … }`    (a decision point)
 *   - call / return → rectangle `[" … "]`
 * Entry/effect get distinct shapes where Mermaid supports it (per the plan);
 * call/return stay rectangles so the path reads as a straight line.
 */
function flowNodeShape(kind: FlowStepKind, escaped: string): string {
  switch (kind) {
    case 'entry':
      return `(["${escaped}"])`
    case 'effect':
      return `[["${escaped}"]]`
    case 'branch':
      return `{"${escaped}"}`
    case 'call':
    case 'return':
    default:
      return `["${escaped}"]`
  }
}

/**
 * Serialize an ExecutionFlow to a Mermaid `flowchart TD` string.
 *
 * Contract:
 * - `flowchart TD` header; steps emitted in array order (deterministic).
 * - Step ids remapped to s0, s1, … (arbitrary id strings are safe).
 * - Each step coloured by `change` via the shared status classDefs (both
 *   palettes); shaped by `kind` (entry=stadium, effect=subroutine, branch=
 *   rhombus, call/return=rectangle).
 * - Transitions render in array order. `condition` (branch) takes precedence
 *   over `label` as the edge label. Transitions to/from an unknown step id are
 *   DROPPED and reported in `dropped`.
 * - Empty steps → `{ mermaid: '', dropped: [] }` (fallback signal).
 */
export function flowToMermaid(
  flow: ExecutionFlow,
  options?: { palette?: 'dark' | 'light' },
): FlowMermaidResult {
  const palette = options?.palette ?? 'dark'
  if (flow.steps.length === 0) {
    return { mermaid: '', dropped: [] }
  }

  // original step id → safe alias (s0, s1, …)
  const idMap = new Map<string, string>()
  for (let i = 0; i < flow.steps.length; i++) {
    idMap.set(flow.steps[i].id, `s${i}`)
  }

  // Which change tags are present → which classDefs to emit (deterministic order).
  const usedStatuses = new Set<NodeStatus>()
  for (const step of flow.steps) usedStatuses.add(FLOW_CHANGE_TO_STATUS[step.change])

  const lines: string[] = ['flowchart TD']

  const defs = CLASS_DEFS[palette]
  for (const status of STATUS_ORDER) {
    if (usedStatuses.has(status)) {
      lines.push(`    ${defs[status]}`)
    }
  }

  // Node definitions (shape by kind, label escaped).
  for (const step of flow.steps) {
    const alias = idMap.get(step.id)!
    const label = escapeLabel(step.label)
    lines.push(`    ${alias}${flowNodeShape(step.kind, label)}`)
  }

  // Class assignments (colour by change → status class).
  for (const step of flow.steps) {
    const alias = idMap.get(step.id)!
    lines.push(`    class ${alias} ${FLOW_CHANGE_TO_STATUS[step.change]}`)
  }

  // Transitions in array order. Drop any with unknown endpoints.
  const dropped: string[] = []
  for (const t of flow.transitions) {
    const fromAlias = idMap.get(t.from)
    const toAlias = idMap.get(t.to)
    if (fromAlias === undefined) {
      dropped.push(t.from)
      continue
    }
    if (toAlias === undefined) {
      dropped.push(t.to)
      continue
    }
    // condition (branch) wins over a plain ordered label as the edge caption.
    const caption = t.condition ?? t.label
    if (caption !== undefined && caption !== '') {
      lines.push(`    ${fromAlias} -- "${escapeLabel(caption)}" --> ${toAlias}`)
    } else {
      lines.push(`    ${fromAlias} --> ${toAlias}`)
    }
  }

  return { mermaid: lines.join('\n'), dropped }
}
