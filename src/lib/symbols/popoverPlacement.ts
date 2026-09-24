/**
 * src/lib/symbols/popoverPlacement.ts — where the symbol popover sits, as a
 * pure function of the click point and the viewport.
 *
 * WHY THIS IS A MODULE AND NOT THREE LINES IN THE COMPONENT. The popover is
 * anchored to wherever the reader clicked an identifier, and it now holds a
 * code block that the reader can expand. Two properties have to hold at once:
 *
 *   1. It never renders off-screen. Not at a narrow window, not on a click
 *      near the right edge, not on a click near the bottom.
 *   2. It never MOVES once open. The box — left, top, width and the height it
 *      is allowed to reach — is decided from the click and then frozen, so
 *      expanding the code lengthens the popover's own scroll rather than
 *      shoving the thing the reader is reading out from under the cursor.
 *
 * Both are geometry, and jsdom has none (every element measures 0×0), so the
 * component would have no way to test them. Here they are arithmetic.
 */

export interface PopoverPlacement {
  /** Viewport px. */
  left: number
  top: number
  /** Rendered width — the max, narrowed to fit a small viewport. */
  width: number
  /** Ceiling for the popover's own height; content beyond it scrolls. */
  maxHeight: number
}

/**
 * Wide enough to read a line of code without horizontal scrolling — roughly
 * 100 columns of the 0.72rem mono the peek uses, which covers the great
 * majority of real source lines. Narrowed on small viewports (see below).
 */
export const POPOVER_MAX_WIDTH = 760

/** Never thinner than this, even if it means overflowing a tiny viewport. */
export const POPOVER_MIN_WIDTH = 240

/** Breathing room kept between the popover and every viewport edge. */
export const POPOVER_VIEWPORT_MARGIN = 8

/** Gap below the click point, so the popover never opens under the cursor. */
export const POPOVER_ANCHOR_GAP = 10

/** Share of the viewport height the popover may occupy at most. */
const MAX_HEIGHT_RATIO = 0.7

/** Floor for the height ceiling — below this the popover is not usable. */
const MIN_HEIGHT = 160

export function popoverPlacement(x: number, y: number, vw: number, vh: number): PopoverPlacement {
  const m = POPOVER_VIEWPORT_MARGIN
  const width = Math.max(POPOVER_MIN_WIDTH, Math.min(POPOVER_MAX_WIDTH, vw - 2 * m))
  const left = Math.max(m, Math.min(x, vw - width - m))

  const ceiling = Math.max(MIN_HEIGHT, Math.round(vh * MAX_HEIGHT_RATIO))
  const below = y + POPOVER_ANCHOR_GAP
  const spaceBelow = vh - below - m
  const spaceAbove = y - POPOVER_ANCHOR_GAP - m

  // Below the click is the natural reading direction, and the only reason to
  // flip is that there is genuinely more room the other way AND what is left
  // below is too little to be worth reading in.
  if (spaceBelow >= MIN_HEIGHT || spaceBelow >= spaceAbove) {
    return { left, top: Math.max(m, below), width, maxHeight: clampHeight(ceiling, spaceBelow) }
  }
  const maxHeight = clampHeight(ceiling, spaceAbove)
  return { left, top: Math.max(m, y - POPOVER_ANCHOR_GAP - maxHeight), width, maxHeight }
}

function clampHeight(ceiling: number, available: number): number {
  return Math.max(MIN_HEIGHT, Math.min(ceiling, available))
}
