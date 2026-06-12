/**
 * collapse.test.ts — per-browser context-rail section expand persistence.
 *
 * Storage: localStorage `review123:rail-expanded`
 * Schema:  { [sectionId: string]: boolean }   (true = expanded)
 * Default: collapsed — the opposite default of the landing-collapse map.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { isRailSectionExpanded, setRailSectionExpanded } from './collapse'

const KEY = 'review123:rail-expanded'

describe('rail section expand persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to collapsed (not expanded) when nothing is stored', () => {
    expect(isRailSectionExpanded('summary')).toBe(false)
    expect(isRailSectionExpanded('hotspots')).toBe(false)
    expect(isRailSectionExpanded('diagrams')).toBe(false)
  })

  it('setRailSectionExpanded(true) persists and is read back', () => {
    setRailSectionExpanded('summary', true)
    expect(isRailSectionExpanded('summary')).toBe(true)
    // other sections unaffected
    expect(isRailSectionExpanded('diagrams')).toBe(false)
  })

  it('setRailSectionExpanded(false) restores the collapsed default', () => {
    setRailSectionExpanded('hotspots', true)
    setRailSectionExpanded('hotspots', false)
    expect(isRailSectionExpanded('hotspots')).toBe(false)
  })

  it('stores all sections in a single map key', () => {
    setRailSectionExpanded('summary', true)
    setRailSectionExpanded('hotspots', true)
    setRailSectionExpanded('ci-details', false)
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    expect(raw).toEqual({ summary: true, hotspots: true, 'ci-details': false })
  })

  it('uses its own key — does not touch the landing-collapse map', () => {
    localStorage.setItem('review123:landing-collapsed', JSON.stringify({ queue: true }))
    setRailSectionExpanded('summary', true)
    expect(JSON.parse(localStorage.getItem('review123:landing-collapsed')!)).toEqual({ queue: true })
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ summary: true })
  })

  it('survives corrupted JSON in localStorage (falls back to defaults)', () => {
    localStorage.setItem(KEY, 'not-json{{')
    expect(isRailSectionExpanded('summary')).toBe(false)
    // and writing after corruption works
    setRailSectionExpanded('summary', true)
    expect(isRailSectionExpanded('summary')).toBe(true)
  })

  it('ignores non-boolean values in the stored map', () => {
    localStorage.setItem(KEY, JSON.stringify({ summary: 'yes', diagrams: 1 }))
    expect(isRailSectionExpanded('summary')).toBe(false)
    expect(isRailSectionExpanded('diagrams')).toBe(false)
  })

  it('ignores a stored array or non-object', () => {
    localStorage.setItem(KEY, JSON.stringify([true]))
    expect(isRailSectionExpanded('summary')).toBe(false)
    localStorage.setItem(KEY, JSON.stringify('expanded'))
    expect(isRailSectionExpanded('summary')).toBe(false)
  })
})
