import { describe, it, expect, beforeEach, vi } from 'vitest'
import { recordVisit, lastVisit } from './visits'

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

const PR_ID = 'owner/repo#42'
const SHA_A = 'abc1234'
const SHA_B = 'def5678'

describe('lastVisit', () => {
  it('returns null when PR has never been visited', () => {
    expect(lastVisit(PR_ID)).toBeNull()
  })

  it('returns null for unknown PR when other PRs exist', () => {
    recordVisit('owner/repo#1', SHA_A)
    expect(lastVisit('owner/repo#999')).toBeNull()
  })
})

describe('recordVisit + lastVisit — round-trip', () => {
  it('round-trips headSha and visitedAt', () => {
    const before = Date.now()
    recordVisit(PR_ID, SHA_A)
    const after = Date.now()

    const entry = lastVisit(PR_ID)
    expect(entry).not.toBeNull()
    expect(entry!.headSha).toBe(SHA_A)
    expect(entry!.visitedAt).toBeGreaterThanOrEqual(before)
    expect(entry!.visitedAt).toBeLessThanOrEqual(after)
  })

  it('overwrites previous visit when called again', () => {
    recordVisit(PR_ID, SHA_A)
    recordVisit(PR_ID, SHA_B)

    const entry = lastVisit(PR_ID)
    expect(entry!.headSha).toBe(SHA_B)
  })

  it('different PR IDs are isolated', () => {
    recordVisit('owner/repo#1', SHA_A)
    recordVisit('owner/repo#2', SHA_B)

    expect(lastVisit('owner/repo#1')!.headSha).toBe(SHA_A)
    expect(lastVisit('owner/repo#2')!.headSha).toBe(SHA_B)
  })

  it('persists across calls (reads from localStorage)', () => {
    recordVisit(PR_ID, SHA_A)
    // Clear in-memory caches by re-reading from a fresh perspective:
    // the module reads localStorage each time, so this tests persistence
    expect(lastVisit(PR_ID)!.headSha).toBe(SHA_A)
  })
})

describe('LRU cap at 50', () => {
  it('evicts the oldest entry when 51st is added', () => {
    const base = 1_000_000
    // Seed 50 entries with increasing visitedAt
    const seed: Record<string, { headSha: string; visitedAt: number }> = {}
    for (let i = 1; i <= 50; i++) {
      seed[`owner/repo#${i}`] = { headSha: SHA_A, visitedAt: base + i }
    }
    localStorage.setItem('review123:visits', JSON.stringify(seed))

    // Add 51st — oldest should be evicted (PR #1 with visitedAt = base+1)
    recordVisit('owner/repo#51', SHA_B)

    const raw = JSON.parse(localStorage.getItem('review123:visits') ?? '{}')
    expect(Object.keys(raw)).toHaveLength(50)
    expect(raw['owner/repo#1']).toBeUndefined()
    expect(raw['owner/repo#51']).toBeDefined()
    expect(raw['owner/repo#50']).toBeDefined()
  })
})

describe('corrupt storage', () => {
  it('returns null when localStorage has invalid JSON', () => {
    localStorage.setItem('review123:visits', '{not valid json')
    expect(lastVisit(PR_ID)).toBeNull()
  })

  it('returns null when localStorage has wrong shape (array)', () => {
    localStorage.setItem('review123:visits', JSON.stringify([1, 2, 3]))
    expect(lastVisit(PR_ID)).toBeNull()
  })

  it('drops entries with missing fields but keeps valid ones', () => {
    const good = { headSha: SHA_A, visitedAt: Date.now() }
    const bad = { headSha: SHA_A } // missing visitedAt
    localStorage.setItem(
      'review123:visits',
      JSON.stringify({ [PR_ID]: good, 'owner/repo#2': bad }),
    )
    expect(lastVisit(PR_ID)!.headSha).toBe(SHA_A)
    expect(lastVisit('owner/repo#2')).toBeNull()
  })

  it('handles corrupt individual entry gracefully', () => {
    localStorage.setItem(
      'review123:visits',
      JSON.stringify({ [PR_ID]: { visitedAt: 'not-a-number', headSha: SHA_A } }),
    )
    // visitedAt is not a number → invalid
    expect(lastVisit(PR_ID)).toBeNull()
  })
})
