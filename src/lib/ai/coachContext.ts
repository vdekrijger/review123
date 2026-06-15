/**
 * src/lib/ai/coachContext.ts — build per-comment CODE context for the coach.
 *
 * The comment coach kept defaulting to "cannot verify against the diff" /
 * "claims not verifiable" because the prompt only carried the general packed
 * PR context (prContext) — it had no idea what code sat AT each commented
 * file:line. This helper closes that gap: for each draft being coached it
 * extracts the concrete code at the comment's anchor so the model can VERIFY
 * accuracy / grounded / specificity against real code instead of guessing.
 *
 * Two evidence layers per comment:
 *   - excerpt:    a ±N-line hunk excerpt around file:line (reuses excerptAround,
 *                 the same helper Ask AI / FileDiff use).
 *   - fileWindow: when full file contents were fetched (the app already pulls
 *                 them for expand-context / story — contentsMap), a wider
 *                 bounded window (±WINDOW_LINES around the line, capped) of the
 *                 relevant side's file contents.
 *
 * Pure + display-of-evidence only: no network, no analytics. Respects a token
 * budget by capping the per-comment context AND the number of comments.
 */

import { excerptAround } from '../diff/excerpt'
import type { Draft } from '../drafts/drafts.svelte'
import type { PrFile } from '../github/types'

/** Per-comment code context fed to the coach (one per evaluated draft). */
export interface CoachCodeContext {
  /** Matches the draft's index in the coachPrompt input. */
  index: number
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
  /** ±N-line hunk excerpt around file:line. '' when the patch is unavailable. */
  excerpt: string
  /** Wider window of the file's contents around the line, when available. */
  fileWindow?: string
}

/** Default count of drafts to attach code context for (token budget). */
export const COACH_CONTEXT_MAX_DRAFTS = 20
/** Lines of file content above/below the commented line for fileWindow. */
export const COACH_WINDOW_LINES = 40
/** Hard cap on fileWindow characters (defensive against very long lines). */
export const COACH_WINDOW_MAX_CHARS = 4000
/** Hunk-excerpt context lines above/below (matches FileDiff / Ask AI). */
export const COACH_EXCERPT_CONTEXT = 6

/** Slice a ±window of file content around a 1-based line, capped by chars. */
function fileWindowFor(
  contents: string | null | undefined,
  line: number,
  windowLines = COACH_WINDOW_LINES,
  maxChars = COACH_WINDOW_MAX_CHARS,
): string | undefined {
  if (!contents) return undefined
  const lines = contents.split('\n')
  if (lines.length === 0) return undefined
  // 1-based line → 0-based index
  const idx = line - 1
  const start = Math.max(0, idx - windowLines)
  const end = Math.min(lines.length - 1, idx + windowLines)
  if (start > end) return undefined
  // Prefix each line with its 1-based number so the model can anchor claims.
  const out: string[] = []
  for (let i = start; i <= end; i++) {
    out.push(`${i + 1}: ${lines[i]}`)
  }
  let text = out.join('\n')
  if (text.length > maxChars) text = text.slice(0, maxChars)
  return text || undefined
}

/**
 * Build per-comment code context for a set of drafts.
 *
 * @param drafts   - drafts being coached (index = array position, matching coachPrompt).
 * @param files    - PR files (for patches → hunk excerpts).
 * @param contents - full file contents map (filename → { before, after }), when fetched.
 * @param maxDrafts - cap on how many drafts receive context (token budget).
 */
export function buildCoachCodeContext(
  drafts: Pick<Draft, 'path' | 'line' | 'side'>[],
  files: PrFile[],
  contents: Map<string, { before: string | null; after: string | null }> | null,
  maxDrafts = COACH_CONTEXT_MAX_DRAFTS,
): CoachCodeContext[] {
  const byName = new Map<string, PrFile>()
  for (const f of files) byName.set(f.filename, f)

  const out: CoachCodeContext[] = []
  const limit = Math.min(drafts.length, maxDrafts)
  for (let index = 0; index < limit; index++) {
    const d = drafts[index]
    const file = byName.get(d.path)
    const excerpt =
      file?.patch ? excerptAround(file.patch, d.line, d.side, COACH_EXCERPT_CONTEXT) : ''

    // Pick the side's content: RIGHT (new) uses `after`, LEFT (old) uses `before`.
    const entry = contents?.get(d.path)
    const sideContent = entry ? (d.side === 'LEFT' ? entry.before : entry.after) : null
    const fileWindow = fileWindowFor(sideContent, d.line)

    out.push({
      index,
      path: d.path,
      line: d.line,
      side: d.side,
      excerpt,
      ...(fileWindow ? { fileWindow } : {}),
    })
  }
  return out
}
