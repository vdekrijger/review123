/**
 * collapse.test.ts — per-browser landing-section collapse persistence.
 *
 * Storage: localStorage `review123:landing-collapsed`
 * Schema:  { [sectionId: string]: boolean }
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { isSectionCollapsed, setSectionCollapsed } from './collapse'

const KEY = 'review123:landing-collapsed'

describe('landing collapse persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to expanded (not collapsed) when nothing is stored', () => {
    expect(isSectionCollapsed('queue')).toBe(false)
    expect(isSectionCollapsed('recent')).toBe(false)
  })

  it('setSectionCollapsed(true) persists and is read back', () => {
    setSectionCollapsed('queue', true)
    expect(isSectionCollapsed('queue')).toBe(true)
    // other sections unaffected
    expect(isSectionCollapsed('recent')).toBe(false)
  })

  it('setSectionCollapsed(false) restores the expanded default', () => {
    setSectionCollapsed('recent', true)
    setSectionCollapsed('recent', false)
    expect(isSectionCollapsed('recent')).toBe(false)
  })

  it('stores both sections independently in a single map key', () => {
    setSectionCollapsed('queue', true)
    setSectionCollapsed('recent', true)
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    expect(raw).toEqual({ queue: true, recent: true })
  })

  it('survives corrupted JSON in localStorage (falls back to defaults)', () => {
    localStorage.setItem(KEY, 'not-json{{')
    expect(isSectionCollapsed('queue')).toBe(false)
    // and writing after corruption works
    setSectionCollapsed('queue', true)
    expect(isSectionCollapsed('queue')).toBe(true)
  })

  it('ignores non-boolean values in the stored map', () => {
    localStorage.setItem(KEY, JSON.stringify({ queue: 'yes', recent: 1 }))
    expect(isSectionCollapsed('queue')).toBe(false)
    expect(isSectionCollapsed('recent')).toBe(false)
  })

  it('ignores a stored array or non-object', () => {
    localStorage.setItem(KEY, JSON.stringify([true]))
    expect(isSectionCollapsed('queue')).toBe(false)
    localStorage.setItem(KEY, JSON.stringify('collapsed'))
    expect(isSectionCollapsed('queue')).toBe(false)
  })
})
