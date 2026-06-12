/**
 * Tests for the diff-column height observer (the --diff-col-h seam).
 *
 * jsdom has no ResizeObserver, so the constructor is injected as a mock —
 * exactly the seam the production code uses (default = globalThis.ResizeObserver).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { observeDiffColHeight, DIFF_COL_H_VAR } from './diffColHeight'

class MockResizeObserver {
  static instances: MockResizeObserver[] = []
  callback: () => void
  observed: Element[] = []
  disconnected = false

  constructor(callback: () => void) {
    this.callback = callback
    MockResizeObserver.instances.push(this)
  }
  observe(el: Element) {
    this.observed.push(el)
  }
  disconnect() {
    this.disconnected = true
  }
}

function makeEls(height: number): { diffCol: HTMLElement; layout: HTMLElement } {
  const layout = document.createElement('div')
  const diffCol = document.createElement('div')
  layout.appendChild(diffCol)
  diffCol.getBoundingClientRect = () =>
    ({ height, width: 800, top: 0, left: 0, right: 800, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  return { diffCol, layout }
}

// rAF queue we control manually (jsdom's rAF timing is not deterministic)
let rafQueue: FrameRequestCallback[]

beforeEach(() => {
  MockResizeObserver.instances = []
  rafQueue = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafQueue[id - 1] = () => {}
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function flushRaf(): void {
  const cbs = rafQueue
  rafQueue = []
  for (const cb of cbs) cb(0)
}

describe('observeDiffColHeight', () => {
  it('writes the initial diff column height into --diff-col-h synchronously', () => {
    const { diffCol, layout } = makeEls(420)
    observeDiffColHeight(diffCol, layout, MockResizeObserver)
    expect(layout.style.getPropertyValue(DIFF_COL_H_VAR)).toBe('420px')
  })

  it('observes the diff column element (not the window, not the layout)', () => {
    const { diffCol, layout } = makeEls(420)
    observeDiffColHeight(diffCol, layout, MockResizeObserver)
    expect(MockResizeObserver.instances).toHaveLength(1)
    expect(MockResizeObserver.instances[0].observed).toEqual([diffCol])
  })

  it('updates the property when the observer fires (after the rAF tick)', () => {
    const { diffCol, layout } = makeEls(420)
    observeDiffColHeight(diffCol, layout, MockResizeObserver)

    // Diff column grows (e.g. a file card expands)
    diffCol.getBoundingClientRect = () => ({ height: 900 }) as DOMRect
    MockResizeObserver.instances[0].callback()

    // Throttled: not yet written before the frame runs
    expect(layout.style.getPropertyValue(DIFF_COL_H_VAR)).toBe('420px')
    flushRaf()
    expect(layout.style.getPropertyValue(DIFF_COL_H_VAR)).toBe('900px')
  })

  it('rAF-throttles: multiple observer callbacks in one frame queue one write', () => {
    const { diffCol, layout } = makeEls(420)
    observeDiffColHeight(diffCol, layout, MockResizeObserver)

    const cb = MockResizeObserver.instances[0].callback
    cb()
    cb()
    cb()
    expect(rafQueue).toHaveLength(1)
  })

  it('rounds fractional heights to whole pixels', () => {
    const { diffCol, layout } = makeEls(333.6)
    observeDiffColHeight(diffCol, layout, MockResizeObserver)
    expect(layout.style.getPropertyValue(DIFF_COL_H_VAR)).toBe('334px')
  })

  it('cleanup disconnects the observer, cancels pending frames, removes the property', () => {
    const { diffCol, layout } = makeEls(420)
    const cleanup = observeDiffColHeight(diffCol, layout, MockResizeObserver)

    MockResizeObserver.instances[0].callback() // queue a frame
    cleanup()

    expect(MockResizeObserver.instances[0].disconnected).toBe(true)
    expect(layout.style.getPropertyValue(DIFF_COL_H_VAR)).toBe('')

    // The cancelled frame must not write after cleanup
    flushRaf()
    expect(layout.style.getPropertyValue(DIFF_COL_H_VAR)).toBe('')
  })

  it('no-ops when ResizeObserver is unavailable (jsdom guard)', () => {
    const { diffCol, layout } = makeEls(420)
    const cleanup = observeDiffColHeight(diffCol, layout, undefined)
    expect(layout.style.getPropertyValue(DIFF_COL_H_VAR)).toBe('')
    expect(() => cleanup()).not.toThrow()
  })
})
