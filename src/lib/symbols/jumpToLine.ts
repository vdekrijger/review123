/**
 * src/lib/symbols/jumpToLine.ts — Scroll the diff view to a specific
 * file + line + side (symbol click-through, Tier 1).
 *
 * Reuses the existing jump-to-file mechanism (src/lib/diff/jumpToFile.ts,
 * read-only): scrollToFileCard() finds the `#file-<slug>` wrapper InspectStep
 * renders around every FileDiff, scrolls it into view and expands a collapsed
 * (viewed) card. On top of that, this module locates the ROW for the target
 * line inside that card and centers + flashes it.
 *
 * Row lookup relies on the @git-diff-view DOM (same attributes FileDiff's
 * focus-dim decorator reads):
 *   - unified: spans carry `data-line-old-num` / `data-line-new-num`
 *   - split:   the num cell `td.diff-line-{old,new}-num` carries a single
 *              `[data-line-num]`
 *
 * Bounded rAF retries cover card expansion / mount latency; when the row never
 * appears (line outside the rendered hunks) the jump gracefully degrades to
 * the file-card scroll that already happened.
 */

import { slugify } from '../slug'
import { scrollToFileCard } from '../diff/jumpToFile'
import type { DiffSide } from './symbolIndex'

/** Max animation frames to wait for the target row (expansion + paint). */
const MAX_FRAMES = 30

/** How long (ms) the flash highlight stays on the jumped-to row. */
const FLASH_MS = 1500

/** CSS class the flash styling hooks onto (styled in FileDiff.svelte). */
export const JUMP_FLASH_CLASS = 'symbol-jump-flash'

function findRow(path: string, line: number, side: DiffSide): HTMLElement | null {
  const wrapper = document.getElementById(`file-${slugify(path)}`)
  if (!wrapper) return null
  const unified = wrapper.querySelector(`[data-line-${side}-num="${line}"]`)
  const split = wrapper.querySelector(`td.diff-line-${side}-num [data-line-num="${line}"]`)
  const cell = unified ?? split
  return (cell?.closest('tr') as HTMLElement | null) ?? null
}

function tryJump(path: string, line: number, side: DiffSide): boolean {
  const row = findRow(path, line, side)
  if (!row) return false
  row.scrollIntoView({ behavior: 'smooth', block: 'center' })
  row.classList.add(JUMP_FLASH_CLASS)
  window.setTimeout(() => row.classList.remove(JUMP_FLASH_CLASS), FLASH_MS)
  return true
}

/**
 * Jump to `line` (on `side`) of `path`'s diff: scroll to + expand the file
 * card, then center and flash the row. Retries across animation frames while
 * the card expands/mounts; gives up silently at the file-level scroll.
 */
export function jumpToDiffLine(path: string, line: number, side: DiffSide): void {
  scrollToFileCard(path)
  if (tryJump(path, line, side)) return
  let attempts = 0
  const retry = () => {
    if (tryJump(path, line, side)) return
    attempts += 1
    if (attempts < MAX_FRAMES) requestAnimationFrame(retry)
  }
  requestAnimationFrame(retry)
}
