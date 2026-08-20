/**
 * src/lib/github/anchorSplit.ts — pre-submit split of drafts by anchorability.
 *
 * GitHub (and GitLab/Bitbucket) reject line-anchored review comments whose
 * line is not part of the diff hunks — and on GitHub's atomic create-review
 * endpoint ONE bad anchor 422s the ENTIRE review, losing the valid comments
 * too. This module is the client-side truth for that split: drafts whose
 * anchor is resolvable in the current patch go `inline`; the rest go
 * `offDiff` and are re-routed by the caller (file-level comments,
 * position-less notes, or review-body folding — never dropped).
 *
 * Semantics mirror FileDiff.svelte's isAnchoredDraft exactly:
 *   - a draft is inline when its line number appears in
 *     patchLineNumbers(patch, side) for its side (LEFT/RIGHT);
 *   - a RANGE draft (startLine < line) is inline only when BOTH endpoints are
 *     in the diff (conservative — GitHub documents no laxer rule);
 *   - a file with no patch at all (binary / very large — EC-05j) or a path
 *     missing from the file list anchors nothing → offDiff.
 *
 * When `files` is EMPTY the split is skipped and every draft stays inline:
 * a real PR diff always has ≥1 file, so an empty list means the caller has no
 * patches to judge against (demo/tests/legacy callers) — never that every
 * line left the diff. Same honesty rule as isStaleDraft.
 */

import type { Draft } from '../drafts/drafts.svelte'
import type { PrFile } from './types'
import { patchLineNumbers } from '../diff/patchLines'

/** The subset of PrFile the split needs — filename + raw patch text. */
export type PatchFile = Pick<PrFile, 'filename' | 'patch'>

export interface AnchorSplit {
  /** Drafts whose line (and startLine, for ranges) is in the diff hunks. */
  inline: Draft[]
  /** Drafts that cannot anchor to the current diff — re-route, never drop. */
  offDiff: Draft[]
}

/**
 * Split drafts into inline (anchorable) vs off-diff (not anchorable) against
 * the given per-file patches. PURE — no network, no mutation; draft order is
 * preserved within each bucket.
 */
export function splitDraftsByAnchor(
  drafts: readonly Draft[],
  files: readonly PatchFile[],
): AnchorSplit {
  if (files.length === 0) {
    return { inline: [...drafts], offDiff: [] }
  }

  const patchByPath = new Map<string, string | undefined>()
  for (const f of files) patchByPath.set(f.filename, f.patch)

  // Lazy per-(path, side) line-number sets — patches are parsed at most twice.
  const lineSets = new Map<string, Set<number>>()
  function linesFor(path: string, side: 'LEFT' | 'RIGHT'): Set<number> | null {
    if (!patchByPath.has(path)) return null // file not in the diff at all
    const key = `${path}|${side}`
    let set = lineSets.get(key)
    if (!set) {
      set = patchLineNumbers(patchByPath.get(path), side)
      lineSets.set(key, set)
    }
    return set
  }

  const inline: Draft[] = []
  const offDiff: Draft[] = []
  for (const d of drafts) {
    const lines = linesFor(d.path, d.side)
    const isRange = d.startLine != null && d.startLine < d.line
    const anchored =
      lines != null &&
      lines.has(d.line) &&
      (!isRange || lines.has(d.startLine!))
    ;(anchored ? inline : offDiff).push(d)
  }
  return { inline, offDiff }
}

// ---------------------------------------------------------------------------
// Off-diff comment bodies — shared copy for the re-routed posts
// ---------------------------------------------------------------------------

/** "line 7" or "lines 3–7" for a (possibly ranged) draft anchor. */
export function offDiffLineLabel(d: Pick<Draft, 'line' | 'startLine'>): string {
  return d.startLine != null && d.startLine < d.line
    ? `lines ${d.startLine}–${d.line}`
    : `line ${d.line}`
}

/**
 * Body for a re-routed off-diff comment. The prefix names the intended anchor
 * so the PR author still knows which line the note was about:
 *
 *   **Re: line 7** _(line not in the current diff)_ — <body>
 *
 * With `includePath` (GitLab position-less notes / Bitbucket non-inline
 * comments, which are not attached to a file) the path rides in the label:
 *
 *   **Re: src/foo.ts:7** _(line not in the current diff)_ — <body>
 */
export function offDiffCommentBody(
  d: Pick<Draft, 'path' | 'line' | 'startLine'>,
  outgoingBody: string,
  opts: { includePath?: boolean } = {},
): string {
  const label = opts.includePath
    ? `${d.path}:${d.startLine != null && d.startLine < d.line ? `${d.startLine}–${d.line}` : d.line}`
    : offDiffLineLabel(d)
  return `**Re: ${label}** _(line not in the current diff)_ — ${outgoingBody}`
}

/** Heading for the review-body fallback section. */
export const OFF_DIFF_SECTION_HEADING = '#### Comments on lines outside the diff'

/**
 * Fold off-diff comments into a review body under a clearly-marked section —
 * the last-resort fallback when they can be posted nowhere else. Appends to
 * any existing fold section (retry paths may fold twice).
 */
export function foldOffDiffIntoBody(
  baseBody: string,
  entries: readonly { draft: Pick<Draft, 'path' | 'line' | 'startLine'>; outgoingBody: string }[],
): string {
  if (entries.length === 0) return baseBody
  const items = entries.map(
    ({ draft, outgoingBody }) =>
      `**${draft.path}:${draft.startLine != null && draft.startLine < draft.line ? `${draft.startLine}–${draft.line}` : draft.line}** — ${outgoingBody}`,
  )
  const alreadyFolded = baseBody.includes(OFF_DIFF_SECTION_HEADING)
  const prefix = alreadyFolded
    ? baseBody
    : baseBody.trim().length > 0
      ? `${baseBody}\n\n${OFF_DIFF_SECTION_HEADING}`
      : OFF_DIFF_SECTION_HEADING
  return `${prefix}\n\n${items.join('\n\n')}`
}
