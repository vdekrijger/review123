import type { Graph } from './types'

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
 *
 * @param g    The graph to serialize.
 * @param _kind  The diagram kind ('flow' | 'module') — currently both use
 *               flowchart TD; reserved for future layout variation.
 */
export function graphToMermaid(g: Graph, _kind: 'flow' | 'module' = 'flow'): MermaidResult {
  if (g.nodes.length === 0) {
    return { mermaid: '', dropped: [] }
  }

  // Build a map: original id → safe alias (n0, n1, …)
  const idMap = new Map<string, string>()
  for (let i = 0; i < g.nodes.length; i++) {
    idMap.set(g.nodes[i].id, `n${i}`)
  }

  const lines: string[] = ['flowchart TD']

  // Emit node definitions: nN["label"]
  for (const node of g.nodes) {
    const alias = idMap.get(node.id)!
    const label = escapeLabel(node.label)
    lines.push(`    ${alias}["${label}"]`)
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

    if (edge.label !== undefined && edge.label !== '') {
      const edgeLabel = escapeLabel(edge.label)
      lines.push(`    ${fromAlias} -- "${edgeLabel}" --> ${toAlias}`)
    } else {
      lines.push(`    ${fromAlias} --> ${toAlias}`)
    }
  }

  return { mermaid: lines.join('\n'), dropped }
}
