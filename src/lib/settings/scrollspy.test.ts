/**
 * scrollspy.test.ts
 *
 * Unit tests for the pure scrollspy selection logic used by the
 * /settings page section nav. The selection rule: pick the last section
 * (in document order) whose top edge is at or above the viewport
 * midline; fall back to the first section at scroll top; force the last
 * section when the page is scrolled to the bottom (classic scrollspy
 * bottom bug — a short last section may never dominate the viewport).
 */

import { describe, it, expect, vi } from 'vitest'
import { pickActiveSection, isAtBottom, observeSections } from './scrollspy'

const VIEWPORT = 800 // midline at 400

function sections(tops: Record<string, number>) {
  return Object.entries(tops).map(([id, top]) => ({ id, top }))
}

describe('pickActiveSection', () => {
  it('returns null for an empty section list', () => {
    expect(pickActiveSection([], VIEWPORT)).toBeNull()
  })

  it('returns the first section at scroll top (its top at viewport top)', () => {
    const result = pickActiveSection(
      sections({ appearance: 0, providers: 600, 'ai-models': 1200, skills: 1800 }),
      VIEWPORT,
    )
    expect(result).toBe('appearance')
  })

  it('falls back to the first section even when every top is below the midline', () => {
    // e.g. a tall page header pushes all sections below the fold
    const result = pickActiveSection(
      sections({ appearance: 500, providers: 1100, 'ai-models': 1700, skills: 2300 }),
      VIEWPORT,
    )
    expect(result).toBe('appearance')
  })

  it('picks the last section whose top is above the viewport midline', () => {
    // providers (top 100) crossed the midline; ai-models (top 700) has not
    const result = pickActiveSection(
      sections({ appearance: -500, providers: 100, 'ai-models': 700, skills: 1300 }),
      VIEWPORT,
    )
    expect(result).toBe('providers')
  })

  it('treats a top exactly on the midline as active', () => {
    const result = pickActiveSection(
      sections({ appearance: -500, providers: 400, skills: 900 }),
      VIEWPORT,
    )
    expect(result).toBe('providers')
  })

  it('picks the last section when all sections are above the midline', () => {
    const result = pickActiveSection(
      sections({ appearance: -1500, providers: -900, 'ai-models': -300, skills: 200 }),
      VIEWPORT,
    )
    expect(result).toBe('skills')
  })

  it('forces the last section when at the page bottom, even if a short last section never dominates', () => {
    // skills is short: its top (450) stays below the midline even at the
    // bottom of the page — atBottom must override the midline rule.
    const result = pickActiveSection(
      sections({ appearance: -1800, providers: -1000, 'ai-models': -200, skills: 450 }),
      VIEWPORT,
      true,
    )
    expect(result).toBe('skills')
  })

  it('ignores atBottom for an empty section list', () => {
    expect(pickActiveSection([], VIEWPORT, true)).toBeNull()
  })
})

describe('isAtBottom', () => {
  it('is true when scroll position plus viewport reaches the document height', () => {
    expect(isAtBottom(1200, 800, 2000)).toBe(true)
  })

  it('is true within the rounding epsilon of the bottom', () => {
    expect(isAtBottom(1198.5, 800, 2000)).toBe(true)
  })

  it('is false when there is still room to scroll', () => {
    expect(isAtBottom(1000, 800, 2000)).toBe(false)
  })

  it('is false when the document height is unknown (0), as in jsdom', () => {
    // jsdom reports scrollHeight 0 — must not misreport "at bottom"
    expect(isAtBottom(0, 800, 0)).toBe(false)
  })
})

describe('observeSections', () => {
  it('returns a no-op cleanup when IntersectionObserver is unavailable (jsdom)', () => {
    // jsdom has no IntersectionObserver — the seam must degrade gracefully
    expect(typeof IntersectionObserver).toBe('undefined')
    const cleanup = observeSections([document.createElement('div')], vi.fn())
    expect(typeof cleanup).toBe('function')
    expect(() => cleanup()).not.toThrow()
  })

  it('observes every element and disconnects on cleanup when IntersectionObserver exists', () => {
    const observe = vi.fn()
    const disconnect = vi.fn()
    const ctor = vi.fn(function (this: unknown) {
      return { observe, disconnect }
    })
    vi.stubGlobal('IntersectionObserver', ctor)
    try {
      const a = document.createElement('div')
      const b = document.createElement('div')
      const cleanup = observeSections([a, b], vi.fn())
      expect(ctor).toHaveBeenCalledTimes(1)
      expect(observe).toHaveBeenCalledWith(a)
      expect(observe).toHaveBeenCalledWith(b)
      cleanup()
      expect(disconnect).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('invokes the onChange callback when the observer fires', () => {
    let capturedCallback: (() => void) | undefined
    const ctor = vi.fn(function (cb: () => void) {
      capturedCallback = cb
      return { observe: vi.fn(), disconnect: vi.fn() }
    })
    vi.stubGlobal('IntersectionObserver', ctor)
    try {
      const onChange = vi.fn()
      observeSections([document.createElement('div')], onChange)
      capturedCallback?.()
      expect(onChange).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
