/**
 * src/lib/guide/sortPref.test.ts — per-browser Files-mode sort persistence.
 *
 * Storage: localStorage `review123:inspect-sort`, { order: 'narrative'|'risk' }.
 * Default narrative; invalid/corrupt entries degrade to narrative.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { getInspectSort, setInspectSort } from './sortPref'

const KEY = 'review123:inspect-sort'

beforeEach(() => {
  localStorage.clear()
})

describe('sortPref', () => {
  it('defaults to narrative when nothing is stored', () => {
    expect(getInspectSort()).toBe('narrative')
  })

  it('round-trips risk', () => {
    setInspectSort('risk')
    expect(getInspectSort()).toBe('risk')
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ order: 'risk' })
  })

  it('round-trips back to narrative', () => {
    setInspectSort('risk')
    setInspectSort('narrative')
    expect(getInspectSort()).toBe('narrative')
  })

  it('degrades corrupt JSON to narrative', () => {
    localStorage.setItem(KEY, '{not json')
    expect(getInspectSort()).toBe('narrative')
  })

  it('degrades wrong shapes to narrative (array, string, unknown order)', () => {
    localStorage.setItem(KEY, JSON.stringify(['risk']))
    expect(getInspectSort()).toBe('narrative')
    localStorage.setItem(KEY, JSON.stringify('risk'))
    expect(getInspectSort()).toBe('narrative')
    localStorage.setItem(KEY, JSON.stringify({ order: 'chaos' }))
    expect(getInspectSort()).toBe('narrative')
  })
})
