import { describe, it, expect, beforeEach } from 'vitest'
import {
  isQualified,
  qualifyPrId,
  qualifyPrKey,
  unqualify,
  migrateLegacyVisits,
  migrateLegacyViewed,
} from './storeKeys'

describe('isQualified', () => {
  it('returns true for qualified github key', () => {
    expect(isQualified('github:owner/repo#1')).toBe(true)
  })

  it('returns true for qualified gitlab key', () => {
    expect(isQualified('gitlab:owner/repo#1')).toBe(true)
  })

  it('returns true for qualified bitbucket key', () => {
    expect(isQualified('bitbucket:owner/repo#1')).toBe(true)
  })

  it('returns false for legacy key', () => {
    expect(isQualified('owner/repo#1')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isQualified('')).toBe(false)
  })
})

describe('qualifyPrId', () => {
  it('adds github: prefix to a legacy prId', () => {
    expect(qualifyPrId('owner/repo#123')).toBe('github:owner/repo#123')
  })

  it('passes through an already-qualified prId unchanged', () => {
    expect(qualifyPrId('github:owner/repo#123')).toBe('github:owner/repo#123')
  })

  it('uses the given provider prefix', () => {
    expect(qualifyPrId('owner/repo#42', 'gitlab')).toBe('gitlab:owner/repo#42')
  })
})

describe('qualifyPrKey', () => {
  it('adds github: prefix to a legacy prKey', () => {
    expect(qualifyPrKey('owner/repo#123@abc1234')).toBe('github:owner/repo#123@abc1234')
  })

  it('passes through an already-qualified prKey unchanged', () => {
    expect(qualifyPrKey('github:owner/repo#123@abc1234')).toBe('github:owner/repo#123@abc1234')
  })

  it('uses the given provider prefix', () => {
    expect(qualifyPrKey('owner/repo#1@sha', 'bitbucket')).toBe('bitbucket:owner/repo#1@sha')
  })
})

describe('unqualify', () => {
  it('strips the provider prefix', () => {
    expect(unqualify('github:owner/repo#123')).toBe('owner/repo#123')
  })

  it('returns legacy key unchanged', () => {
    expect(unqualify('owner/repo#123')).toBe('owner/repo#123')
  })
})

describe('migrateLegacyVisits', () => {
  const VISITS_KEY = 'review123:visits'

  beforeEach(() => {
    localStorage.clear()
  })

  it('copies legacy keys to qualified keys', () => {
    localStorage.setItem(VISITS_KEY, JSON.stringify({
      'a/b#1': { headSha: 'sha1', visitedAt: 1000 },
      'c/d#2': { headSha: 'sha2', visitedAt: 2000 },
    }))

    migrateLegacyVisits()

    const stored = JSON.parse(localStorage.getItem(VISITS_KEY)!)
    expect(stored['github:a/b#1']).toEqual({ headSha: 'sha1', visitedAt: 1000 })
    expect(stored['github:c/d#2']).toEqual({ headSha: 'sha2', visitedAt: 2000 })
    // Legacy keys are preserved (not deleted)
    expect(stored['a/b#1']).toEqual({ headSha: 'sha1', visitedAt: 1000 })
  })

  it('does not overwrite an existing qualified key', () => {
    localStorage.setItem(VISITS_KEY, JSON.stringify({
      'a/b#1': { headSha: 'old-sha', visitedAt: 1000 },
      'github:a/b#1': { headSha: 'new-sha', visitedAt: 2000 },
    }))

    migrateLegacyVisits()

    const stored = JSON.parse(localStorage.getItem(VISITS_KEY)!)
    expect(stored['github:a/b#1']).toEqual({ headSha: 'new-sha', visitedAt: 2000 })
  })

  it('is a no-op when storage is empty', () => {
    expect(() => migrateLegacyVisits()).not.toThrow()
  })

  it('is idempotent — safe to call multiple times', () => {
    localStorage.setItem(VISITS_KEY, JSON.stringify({
      'a/b#1': { headSha: 'sha1', visitedAt: 1000 },
    }))

    migrateLegacyVisits()
    migrateLegacyVisits()

    const stored = JSON.parse(localStorage.getItem(VISITS_KEY)!)
    // Only one qualified key
    const qualifiedKeys = Object.keys(stored).filter((k) => k.startsWith('github:'))
    expect(qualifiedKeys).toHaveLength(1)
  })
})

describe('migrateLegacyViewed', () => {
  const VIEWED_KEY = 'review123:viewed'

  beforeEach(() => {
    localStorage.clear()
  })

  it('copies legacy viewed keys to qualified keys', () => {
    localStorage.setItem(VIEWED_KEY, JSON.stringify({
      'a/b#1': [{ path: 'src/foo.ts', patchHash: 'abc', viewedAt: 1000 }],
    }))

    migrateLegacyViewed()

    const stored = JSON.parse(localStorage.getItem(VIEWED_KEY)!)
    expect(stored['github:a/b#1']).toEqual([{ path: 'src/foo.ts', patchHash: 'abc', viewedAt: 1000 }])
    // Legacy key preserved
    expect(stored['a/b#1']).toBeDefined()
  })

  it('does not overwrite an existing qualified viewed key', () => {
    localStorage.setItem(VIEWED_KEY, JSON.stringify({
      'a/b#1': [{ path: 'old.ts', patchHash: 'old', viewedAt: 1000 }],
      'github:a/b#1': [{ path: 'new.ts', patchHash: 'new', viewedAt: 2000 }],
    }))

    migrateLegacyViewed()

    const stored = JSON.parse(localStorage.getItem(VIEWED_KEY)!)
    expect(stored['github:a/b#1']).toEqual([{ path: 'new.ts', patchHash: 'new', viewedAt: 2000 }])
  })

  it('is a no-op when storage is empty', () => {
    expect(() => migrateLegacyViewed()).not.toThrow()
  })
})
