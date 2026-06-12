/**
 * src/lib/diff/whitespace.ts — client-side "hide whitespace changes" recompute.
 *
 * Mirrors `git diff -w`: lines that differ ONLY in whitespace (leading,
 * trailing, internal runs — even whitespace vs. none) are treated as
 * unchanged. We cannot get a `-w` patch from the provider APIs, but the app
 * already fetches full before/after file contents for context expansion, so
 * we recompute the diff locally:
 *
 *   1. Normalize each line by stripping ALL whitespace (git -w semantics).
 *      Normalization is per-line, so line COUNT and line NUMBERS are
 *      preserved exactly.
 *   2. Run jsdiff's structuredPatch over the normalized texts. The resulting
 *      hunk line numbers therefore refer to REAL file lines.
 *   3. Re-substitute the original (un-normalized) line content into the hunk
 *      bodies: '-' lines from the old file, '+' lines from the new file, and
 *      context lines from the NEW file (verified against real `git diff -w`
 *      output — git emits the new side for ws-differing context lines).
 *
 * The output is a bare-hunk patch string (same shape the providers return),
 * which flows through the existing buildDiffFile envelope pipeline.
 *
 * Dependency note: `diff` (jsdiff) was already in the tree as a transitive
 * dependency of @git-diff-view/file — promoting it to a direct dependency
 * adds zero new code to the install.
 */
import { structuredPatch } from 'diff'

/** git -w comparison key: the line with ALL whitespace removed. */
export function stripWhitespace(line: string): string {
  return line.replace(/\s+/g, '')
}

export type WhitespacePatchResult =
  /** Every change in the file was whitespace-only — nothing left to show. */
  | { kind: 'collapsed' }
  /** A recomputed bare-hunk patch with whitespace-only changes hidden. */
  | { kind: 'recomputed'; patch: string }

/** Marker emitted by jsdiff for files without a trailing newline. */
const NO_NEWLINE_MARKER = '\\'

/**
 * Recompute a file's diff ignoring whitespace (git -w semantics).
 * Both full file contents must be available; callers are responsible for
 * falling back to the provider patch when they are not.
 */
export function computeWhitespaceHiddenPatch(
  oldContent: string,
  newContent: string,
): WhitespacePatchResult {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')

  // Per-line normalization preserves line structure (split/join round-trips),
  // so hunk numbers computed on normalized text map 1:1 to original lines.
  const normalizedOld = oldLines.map(stripWhitespace).join('\n')
  const normalizedNew = newLines.map(stripWhitespace).join('\n')

  const { hunks } = structuredPatch('a', 'b', normalizedOld, normalizedNew, '', '', { context: 3 })

  if (hunks.length === 0) return { kind: 'collapsed' }

  const parts: string[] = []
  for (const hunk of hunks) {
    parts.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    // Walk the hunk re-substituting original line content by line number.
    let oldLineNo = hunk.oldStart
    let newLineNo = hunk.newStart
    for (const line of hunk.lines) {
      const prefix = line[0]
      if (prefix === NO_NEWLINE_MARKER) {
        // "\ No newline at end of file" — keep verbatim, consumes no lines
        parts.push(line)
      } else if (prefix === '-') {
        parts.push('-' + (oldLines[oldLineNo - 1] ?? ''))
        oldLineNo++
      } else if (prefix === '+') {
        parts.push('+' + (newLines[newLineNo - 1] ?? ''))
        newLineNo++
      } else {
        // Context: git -w emits the NEW side for ws-differing context lines
        parts.push(' ' + (newLines[newLineNo - 1] ?? ''))
        oldLineNo++
        newLineNo++
      }
    }
  }

  return { kind: 'recomputed', patch: parts.join('\n') + '\n' }
}

/**
 * Per-file display decision for the "Hide whitespace changes" toggle.
 * - 'collapsed'   → render the "No changes when hiding whitespace" placeholder
 * - 'recomputed'  → render the recomputed patch (line comments disabled)
 * - 'unavailable' → full contents missing; keep the provider diff + show a note
 */
export type WhitespaceDisplay = WhitespacePatchResult | { kind: 'unavailable' }
