/**
 * src/lib/diff/patchLines.ts — Which line numbers does a patch actually contain?
 *
 * patchLineNumbers(patch, side) parses a raw GitHub-style patch (bare hunks,
 * no ---/+++ envelope required) and returns the set of 1-based line numbers
 * that appear in the hunks for the requested side:
 *
 *   - 'RIGHT' → new-file line numbers (context lines and `+` additions)
 *   - 'LEFT'  → old-file line numbers (context lines and `-` deletions)
 *
 * Used to decide whether a line anchor (draft comment or reviewer finding)
 * is RESOLVABLE in the rendered diff: anchors on lines in this set can be
 * rendered inline at the line via the diff view's extendData mechanism;
 * anchors outside it (or with no line at all) fall back to the per-file
 * annotation block.
 */

export function patchLineNumbers(patch: string | undefined, side: 'LEFT' | 'RIGHT'): Set<number> {
  const result = new Set<number>()
  if (!patch) return result

  const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

  let oldLine = 0
  let newLine = 0
  let inHunk = false

  for (const line of patch.split('\n')) {
    const m = HUNK_HEADER.exec(line)
    if (m) {
      oldLine = parseInt(m[1], 10)
      newLine = parseInt(m[2], 10)
      inHunk = true
      continue
    }
    if (!inHunk) continue

    if (line.startsWith('+')) {
      if (side === 'RIGHT') result.add(newLine)
      newLine++
    } else if (line.startsWith('-')) {
      if (side === 'LEFT') result.add(oldLine)
      oldLine++
    } else if (line === '\\ No newline at end of file') {
      // marker line — does not advance either counter
    } else {
      // context line — present on both sides
      result.add(side === 'LEFT' ? oldLine : newLine)
      oldLine++
      newLine++
    }
  }

  return result
}
