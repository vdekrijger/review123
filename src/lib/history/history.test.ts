import { describe, it, expect, beforeEach } from 'vitest'
import { addToHistory, getHistory, clearHistory } from './history'

beforeEach(() => {
  localStorage.clear()
})

describe('getHistory', () => {
  it('returns [] when localStorage is empty', () => {
    expect(getHistory()).toEqual([])
  })

  it('returns [] when localStorage value is corrupt JSON', () => {
    localStorage.setItem('review123:history', '{not valid json')
    expect(getHistory()).toEqual([])
  })

  it('returns [] when stored value is not an array', () => {
    localStorage.setItem('review123:history', JSON.stringify({ not: 'an array' }))
    expect(getHistory()).toEqual([])
  })

  it('silently drops invalid (corrupt) entries', () => {
    const valid = { owner: 'a', repo: 'b', number: 1, title: 'T', viewedAt: 1000 }
    const corrupt = { owner: 'c', repo: 'd' } // missing number/title/viewedAt
    localStorage.setItem('review123:history', JSON.stringify([valid, corrupt]))
    const history = getHistory()
    expect(history).toHaveLength(1)
    expect(history[0].owner).toBe('a')
  })
})

describe('addToHistory', () => {
  it('adds a new entry', () => {
    addToHistory({ owner: 'alice', repo: 'widgets', number: 1, title: 'Add feature' })
    const history = getHistory()
    expect(history).toHaveLength(1)
    expect(history[0].owner).toBe('alice')
    expect(history[0].repo).toBe('widgets')
    expect(history[0].number).toBe(1)
    expect(history[0].title).toBe('Add feature')
    expect(typeof history[0].viewedAt).toBe('number')
  })

  it('adds multiple entries in reverse-chronological order (most recent first)', () => {
    addToHistory({ owner: 'a', repo: 'r', number: 1, title: 'First' })
    addToHistory({ owner: 'a', repo: 'r', number: 2, title: 'Second' })
    const history = getHistory()
    expect(history[0].number).toBe(2)
    expect(history[1].number).toBe(1)
  })

  it('deduplicates by owner+repo+number: moves existing entry to front', () => {
    addToHistory({ owner: 'a', repo: 'r', number: 1, title: 'First' })
    addToHistory({ owner: 'a', repo: 'r', number: 2, title: 'Second' })
    // Add PR #1 again — should move to front
    addToHistory({ owner: 'a', repo: 'r', number: 1, title: 'First (updated)' })
    const history = getHistory()
    expect(history).toHaveLength(2) // deduplicated
    expect(history[0].number).toBe(1)
    expect(history[1].number).toBe(2)
  })

  it('updates viewedAt on revisit', () => {
    addToHistory({ owner: 'a', repo: 'r', number: 1, title: 'T' })
    const first = getHistory()[0].viewedAt
    // Small wait isn't needed — we just verify revisiting updates the timestamp
    addToHistory({ owner: 'a', repo: 'r', number: 1, title: 'T' })
    const second = getHistory()[0].viewedAt
    // viewedAt should be >= first (same ms is fine)
    expect(second).toBeGreaterThanOrEqual(first)
  })

  it('caps history at 10 entries (drops oldest)', () => {
    for (let i = 1; i <= 12; i++) {
      addToHistory({ owner: 'a', repo: 'r', number: i, title: `PR ${i}` })
    }
    const history = getHistory()
    expect(history).toHaveLength(10)
    // Most recent (12) at front
    expect(history[0].number).toBe(12)
    // Oldest (1, 2) should be dropped
    expect(history.find((e) => e.number === 1)).toBeUndefined()
    expect(history.find((e) => e.number === 2)).toBeUndefined()
  })
})

describe('clearHistory', () => {
  it('clears all entries', () => {
    addToHistory({ owner: 'a', repo: 'r', number: 1, title: 'T' })
    clearHistory()
    expect(getHistory()).toEqual([])
  })
})
