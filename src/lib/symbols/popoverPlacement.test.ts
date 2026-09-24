/**
 * popoverPlacement tests — the geometry jsdom cannot measure.
 *
 * The invariant every case checks: the box stays inside the viewport, with the
 * margin honoured on all four sides whenever the viewport is big enough to
 * allow it.
 */

import { describe, it, expect } from 'vitest'
import {
  popoverPlacement,
  POPOVER_MAX_WIDTH,
  POPOVER_MIN_WIDTH,
  POPOVER_VIEWPORT_MARGIN as M,
  POPOVER_ANCHOR_GAP as GAP,
} from './popoverPlacement'

const DESKTOP = { vw: 1440, vh: 900 }

function place(x: number, y: number, vw = DESKTOP.vw, vh = DESKTOP.vh) {
  return popoverPlacement(x, y, vw, vh)
}

/** Every placement must satisfy this, whatever the click. */
function expectInsideViewport(p: ReturnType<typeof place>, vw: number, vh: number) {
  expect(p.left).toBeGreaterThanOrEqual(M)
  expect(p.top).toBeGreaterThanOrEqual(M)
  expect(p.left + p.width).toBeLessThanOrEqual(vw - M)
  expect(p.top + p.maxHeight).toBeLessThanOrEqual(vh - M)
}

describe('popoverPlacement — horizontal', () => {
  it('opens at the click point, full width, with room to spare', () => {
    const p = place(300, 200)
    expect(p.left).toBe(300)
    expect(p.width).toBe(POPOVER_MAX_WIDTH)
    expectInsideViewport(p, DESKTOP.vw, DESKTOP.vh)
  })

  it('pulls back from the right edge instead of rendering off-screen', () => {
    const p = place(DESKTOP.vw - 20, 200)
    expect(p.left).toBe(DESKTOP.vw - POPOVER_MAX_WIDTH - M)
    expectInsideViewport(p, DESKTOP.vw, DESKTOP.vh)
  })

  it('narrows to fit a phone-width viewport rather than overflowing it', () => {
    const vw = 400
    const p = place(380, 200, vw, DESKTOP.vh)
    expect(p.width).toBe(vw - 2 * M)
    expect(p.left).toBe(M)
    expectInsideViewport(p, vw, DESKTOP.vh)
  })

  it('never goes below the minimum width, even on an absurdly narrow viewport', () => {
    const p = place(0, 200, 120, DESKTOP.vh)
    expect(p.width).toBe(POPOVER_MIN_WIDTH)
    expect(p.left).toBe(M) // clamped to the near edge; overflow is unavoidable
  })
})

describe('popoverPlacement — vertical', () => {
  it('opens just below the click, clear of the cursor', () => {
    const p = place(300, 200)
    expect(p.top).toBe(200 + GAP)
  })

  it('caps the height at the room below rather than running off the bottom', () => {
    const p = place(300, 600)
    expect(p.top).toBe(600 + GAP)
    expect(p.maxHeight).toBe(DESKTOP.vh - (600 + GAP) - M)
    expectInsideViewport(p, DESKTOP.vw, DESKTOP.vh)
  })

  it('flips ABOVE the click when the room below is too small to read in', () => {
    const p = place(300, 860)
    expect(p.top).toBeLessThan(860)
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(860 - GAP)
    expectInsideViewport(p, DESKTOP.vw, DESKTOP.vh)
  })

  it('stays below when below is cramped but above is worse', () => {
    const p = place(300, 60, DESKTOP.vw, 300)
    expect(p.top).toBe(60 + GAP)
  })

  it('never exceeds 70% of the viewport height, however much room there is', () => {
    const p = place(300, 0)
    expect(p.maxHeight).toBeLessThanOrEqual(Math.round(DESKTOP.vh * 0.7))
  })
})

describe('popoverPlacement — the box is stable', () => {
  it('is a pure function of the click and viewport — same input, same box', () => {
    // This is what lets the component freeze the box at open: nothing the
    // reader does INSIDE the popover (expanding the code) can change it.
    expect(place(640, 480)).toEqual(place(640, 480))
  })

  it('keeps every corner inside the viewport across a sweep of click points', () => {
    for (const vw of [400, 768, 1440]) {
      for (const vh of [600, 900]) {
        for (const x of [0, Math.round(vw / 2), vw]) {
          for (const y of [0, Math.round(vh / 2), vh]) {
            const p = popoverPlacement(x, y, vw, vh)
            expect(p.left).toBeGreaterThanOrEqual(M)
            expect(p.top).toBeGreaterThanOrEqual(M)
            if (vw >= POPOVER_MIN_WIDTH + 2 * M) expect(p.left + p.width).toBeLessThanOrEqual(vw - M)
            expect(p.top + p.maxHeight).toBeLessThanOrEqual(vh - M)
          }
        }
      }
    }
  })
})
