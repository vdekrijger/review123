/**
 * src/lib/diff/excerpt.ts — Extract a hunk excerpt around a target diff line.
 *
 * excerptAround(patch, targetLine, side, context?)
 *
 * Given a raw GitHub patch string (bare hunks, no --- / +++ header) and a
 * target line number (1-based, referring to the OLD file for 'LEFT' side or
 * the NEW file for 'RIGHT' side), returns a short code snippet of ±`context`
 * lines centred on the target line.
 *
 * Line-mapping approach:
 *   Parse each @@ hunk header to track the current old-line and new-line
 *   counters.  For each content line (+/-/space) advance the appropriate
 *   counter(s) and record the mapped position.  When the target line is
 *   found inside a hunk, collect ±context lines from that hunk's content
 *   and return them as a string.
 *
 *   If the exact line is NOT inside any hunk (e.g. unchanged context lines
 *   that appear in some hunks but not others), fall back to the nearest
 *   hunk excerpt — document this below.
 *
 * Nearest-hunk fallback:
 *   When no hunk contains the exact target line, the function picks the hunk
 *   whose range is closest to the target line and returns that hunk's first
 *   `2 * context + 1` lines.  This is intentional: the caller (widget) should
 *   still receive something meaningful even when the target line falls in
 *   unexpanded context.  The behaviour is documented here so maintainers
 *   understand it is by design, not a bug.
 *
 * @param patch      - Raw patch string from the GitHub files API (bare hunks).
 * @param targetLine - 1-based line number in the old (LEFT) or new (RIGHT) file.
 * @param side       - Which side the line number refers to ('LEFT' = old, 'RIGHT' = new).
 * @param context    - Number of lines to include above and below (default 6).
 * @returns Excerpt string, or '' when the patch is empty / unparseable.
 */
export function excerptAround(
  patch: string,
  targetLine: number,
  side: 'LEFT' | 'RIGHT',
  context = 6,
): string {
  if (!patch) return ''

  // Parse hunks from the patch
  const hunks = parsePatchHunks(patch)
  if (hunks.length === 0) return ''

  // Try to find the exact hunk containing the target line
  for (const hunk of hunks) {
    const excerpt = extractFromHunk(hunk, targetLine, side, context)
    if (excerpt !== null) return excerpt
  }

  // Fallback: return a snippet from the nearest hunk (by range proximity)
  const nearest = findNearestHunk(hunks, targetLine, side)
  return excerptFromHunkHead(nearest, 2 * context + 1)
}

// ---------------------------------------------------------------------------
// Internal types and parsing
// ---------------------------------------------------------------------------

interface ParsedHunk {
  /** Raw hunk lines including the @@ header line */
  lines: string[]
  /** 1-based old-file starting line */
  oldStart: number
  /** 1-based new-file starting line */
  newStart: number
}

/** Parse the patch string into an array of hunks with header metadata. */
function parsePatchHunks(patch: string): ParsedHunk[] {
  const rawLines = patch.split('\n')
  const hunks: ParsedHunk[] = []
  let current: ParsedHunk | null = null

  const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

  for (const line of rawLines) {
    const m = HUNK_HEADER.exec(line)
    if (m) {
      // Start new hunk
      current = {
        lines: [line],
        oldStart: parseInt(m[1], 10),
        newStart: parseInt(m[2], 10),
      }
      hunks.push(current)
    } else if (current) {
      current.lines.push(line)
    }
  }

  return hunks
}

/**
 * Walk a hunk's content lines, track old/new counters, and when the target
 * line is encountered collect ±context surrounding lines.
 * Returns null when the target is not in this hunk.
 */
function extractFromHunk(
  hunk: ParsedHunk,
  targetLine: number,
  side: 'LEFT' | 'RIGHT',
  context: number,
): string | null {
  // Content lines: everything after the @@ header line
  const contentLines = hunk.lines.slice(1)

  let oldLine = hunk.oldStart
  let newLine = hunk.newStart

  // Map each content line to its old/new line numbers
  const mapped: Array<{ line: string; oldLine: number | null; newLine: number | null }> = []

  for (const cl of contentLines) {
    if (cl.startsWith('+')) {
      mapped.push({ line: cl, oldLine: null, newLine })
      newLine++
    } else if (cl.startsWith('-')) {
      mapped.push({ line: cl, oldLine, newLine: null })
      oldLine++
    } else if (cl === '\\ No newline at end of file') {
      // Ignore this line
    } else {
      // context line — appears in both
      mapped.push({ line: cl, oldLine, newLine })
      oldLine++
      newLine++
    }
  }

  // Find the index of the target line
  const targetIdx = mapped.findIndex((m) =>
    side === 'LEFT' ? m.oldLine === targetLine : m.newLine === targetLine,
  )

  if (targetIdx === -1) return null

  // Collect ±context lines
  const start = Math.max(0, targetIdx - context)
  const end = Math.min(mapped.length - 1, targetIdx + context)
  const slice = mapped.slice(start, end + 1).map((m) => m.line)
  return slice.join('\n')
}

/**
 * Find the hunk whose range is closest to the target line.
 * Closeness is measured as the minimum distance from targetLine to the
 * hunk's range endpoints (old or new side as appropriate).
 */
function findNearestHunk(
  hunks: ParsedHunk[],
  targetLine: number,
  side: 'LEFT' | 'RIGHT',
): ParsedHunk {
  let nearest = hunks[0]
  let minDist = Infinity

  for (const hunk of hunks) {
    const start = side === 'LEFT' ? hunk.oldStart : hunk.newStart
    const dist = Math.abs(start - targetLine)
    if (dist < minDist) {
      minDist = dist
      nearest = hunk
    }
  }

  return nearest
}

/** Return the first `maxLines` content lines of a hunk as a string excerpt. */
function excerptFromHunkHead(hunk: ParsedHunk, maxLines: number): string {
  const contentLines = hunk.lines.slice(1) // skip @@ header
  return contentLines.slice(0, maxLines).join('\n')
}
