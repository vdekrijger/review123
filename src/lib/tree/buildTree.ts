import type { PrFile } from '../github/types'
import { isGeneratedPath } from '../diff/generated'

export interface TreeNode {
  name: string
  path: string
  children: TreeNode[]
  file: PrFile | null
}

interface MutableNode {
  name: string
  path: string
  children: Map<string, MutableNode>
  file: PrFile | null
}

function makeNode(name: string, path: string, file: PrFile | null = null): MutableNode {
  return { name, path, children: new Map(), file }
}

/** Insert a file into the trie at `segments[depth..]` under `parent`. */
function insert(parent: MutableNode, segments: string[], depth: number, file: PrFile): void {
  if (depth === segments.length - 1) {
    // Leaf: file node
    const seg = segments[depth]
    const path = segments.slice(0, depth + 1).join('/')
    parent.children.set(seg, makeNode(seg, path, file))
    return
  }
  const seg = segments[depth]
  const path = segments.slice(0, depth + 1).join('/')
  if (!parent.children.has(seg)) {
    parent.children.set(seg, makeNode(seg, path))
  }
  insert(parent.children.get(seg)!, segments, depth + 1, file)
}

/** Collapse single-child directory chains (GitHub-style path segments). */
function collapse(node: MutableNode): TreeNode {
  if (node.file !== null) {
    // Leaf file node — no collapsing
    return { name: node.name, path: node.path, children: [], file: node.file }
  }

  // For directory nodes: collapse single-child directory chains into one segment.
  // e.g. a -> b -> c.ts becomes "a/b" node with child "c.ts"
  // The root (name='') is never collapsed into its children — only non-root dirs are.
  if (node.name !== '') {
    // Walk down as long as: exactly one child that is also a dir (not a file)
    let current = node
    const nameParts = [current.name]
    while (current.children.size === 1) {
      const [child] = current.children.values()
      if (child.file !== null) break // stop before file leaves
      nameParts.push(child.name)
      current = child
    }

    const collapsedName = nameParts.join('/')
    const sortedChildren = sortNodes([...current.children.values()])

    return {
      name: collapsedName,
      path: current.path,
      children: sortedChildren.map(collapse),
      file: null,
    }
  }

  // Root node (name='') — just sort and recurse children
  const sortedChildren = sortNodes([...node.children.values()])
  return {
    name: '',
    path: '',
    children: sortedChildren.map(collapse),
    file: null,
  }
}

/**
 * Sort: directories before files; generated file leaves AFTER non-generated
 * file leaves; alphabetical within each group.
 *
 * Generated detection here is PATH-only (the tree builder has no file
 * contents); a content-marked-but-innocuous-path file won't sink in the tree,
 * which is acceptable — the tree mirrors path structure and path-detected
 * generated files (lockfiles, generated/ dirs, snapshots) are the common case.
 */
function sortNodes(nodes: MutableNode[]): MutableNode[] {
  return nodes.slice().sort((a, b) => {
    const aIsDir = a.file === null
    const bIsDir = b.file === null
    if (aIsDir && !bIsDir) return -1
    if (!aIsDir && bIsDir) return 1
    // Both are file leaves: generated sinks below non-generated.
    if (!aIsDir && !bIsDir) {
      const aGen = isGeneratedPath(a.path)
      const bGen = isGeneratedPath(b.path)
      if (aGen !== bGen) return aGen ? 1 : -1
    }
    return a.name.localeCompare(b.name)
  })
}

/**
 * Build a file tree from a flat list of PR files.
 * Returns a virtual root node (name='', path='', file=null).
 * Single-child directory chains are collapsed GitHub-style.
 * Sort: directories first, then files, alphabetical within each group.
 */
export function buildFileTree(files: PrFile[]): TreeNode {
  const root = makeNode('', '')

  for (const file of files) {
    const segments = file.filename.split('/')
    insert(root, segments, 0, file)
  }

  return collapse(root)
}
