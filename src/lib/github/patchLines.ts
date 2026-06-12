/**
 * patchLines — extract source line text from a GitHub patch string.
 *
 * Used by the "Suggest change" button to pre-fill the suggestion fence with
 * the original line(s) content.
 *
 * GitHub patches look like unified-diff hunks (bare, no file headers):
 *   @@ -oldStart,oldCount +newStart,newCount @@
 *    context
 *   -removed
 *   +added
 *    context
 *
 * This helper walks the hunk header(s) to assign line numbers, then returns
 * the text content of the requested line range on the specified side.
 *
 * Returns undefined when extraction fails (line not in patch, invalid range,
 * no patch). Callers should gracefully omit the suggestion button in that case.
 */

/** @returns the text content of the specified line(s) on the given side, or undefined */
export function extractPatchLines(
  patch: string | undefined,
  endLine: number,
  side: 'LEFT' | 'RIGHT',
  startLine?: number,
): string[] | undefined {
  if (!patch) return undefined

  const effectiveStart = startLine ?? endLine

  // Validate range
  if (effectiveStart > endLine) return undefined

  // Parse patch into a map of {newLine → text, oldLine → text}
  const newLines = new Map<number, string>()
  const oldLines = new Map<number, string>()

  let newCursor = 0
  let oldCursor = 0

  for (const raw of patch.split('\n')) {
    const hunkMatch = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      oldCursor = parseInt(hunkMatch[1], 10)
      newCursor = parseInt(hunkMatch[2], 10)
      continue
    }

    if (newCursor === 0 && oldCursor === 0) continue // before first hunk

    if (raw.startsWith('+')) {
      // Added line — only on new file (RIGHT)
      newLines.set(newCursor, raw.slice(1))
      newCursor++
    } else if (raw.startsWith('-')) {
      // Removed line — only on old file (LEFT)
      oldLines.set(oldCursor, raw.slice(1))
      oldCursor++
    } else {
      // Context line — on both sides
      const text = raw.startsWith(' ') ? raw.slice(1) : raw
      newLines.set(newCursor, text)
      oldLines.set(oldCursor, text)
      newCursor++
      oldCursor++
    }
  }

  const map = side === 'RIGHT' ? newLines : oldLines

  const result: string[] = []
  for (let ln = effectiveStart; ln <= endLine; ln++) {
    const text = map.get(ln)
    if (text === undefined) return undefined
    result.push(text)
  }

  return result.length > 0 ? result : undefined
}
