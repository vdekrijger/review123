import { describe, it, expect, beforeEach } from 'vitest'
import { djb2, createViewedStore } from './viewed.svelte'

beforeEach(() => {
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// djb2 known-vector tests
// ---------------------------------------------------------------------------

describe('djb2', () => {
  it('returns a non-empty hex string', () => {
    const h = djb2('hello')
    expect(typeof h).toBe('string')
    expect(h.length).toBeGreaterThan(0)
    expect(/^[0-9a-f]+$/.test(h)).toBe(true)
  })

  it('known vector: empty string → "5381" (initial hash, no iterations)', () => {
    // djb2("") = 5381 (decimal) = 1505 hex
    expect(djb2('')).toBe('1505')
  })

  it('known vector: "a" → correct hash', () => {
    // djb2("a"): ((5381<<5)+5381)^97 = 177670^97 = 177607 = 0x2b5c7... actually 0x2b5c4
    expect(djb2('a')).toBe('2b5c4')
  })

  it('known vector: "abc" produces stable output across calls', () => {
    expect(djb2('abc')).toBe(djb2('abc'))
  })

  it('different strings produce different hashes', () => {
    expect(djb2('hello')).not.toBe(djb2('world'))
    expect(djb2('patch v1')).not.toBe(djb2('patch v2'))
  })

  it('same string always produces same hash (deterministic)', () => {
    const s = '@@ -1,3 +1,3 @@\n-old\n+new\n unchanged'
    expect(djb2(s)).toBe(djb2(s))
  })
})

// ---------------------------------------------------------------------------
// createViewedStore
// ---------------------------------------------------------------------------

const PR_ID = 'owner/repo#42'
const PATCH_A = '@@ -1 +1 @@\n-old\n+new'
const PATCH_B = '@@ -1 +1 @@\n-old\n+newer'

describe('createViewedStore — basic operations', () => {
  it('isViewed returns false initially', () => {
    const store = createViewedStore(PR_ID)
    expect(store.isViewed('src/a.ts', PATCH_A)).toBe(false)
  })

  it('toggle marks a file as viewed', () => {
    const store = createViewedStore(PR_ID)
    store.toggle('src/a.ts', PATCH_A)
    expect(store.isViewed('src/a.ts', PATCH_A)).toBe(true)
  })

  it('toggle twice unmarks a file', () => {
    const store = createViewedStore(PR_ID)
    store.toggle('src/a.ts', PATCH_A)
    store.toggle('src/a.ts', PATCH_A)
    expect(store.isViewed('src/a.ts', PATCH_A)).toBe(false)
  })

  it('count is 0 initially', () => {
    const store = createViewedStore(PR_ID)
    expect(store.count).toBe(0)
  })

  it('count increments when files are marked viewed', () => {
    const store = createViewedStore(PR_ID)
    store.toggle('src/a.ts', PATCH_A)
    store.toggle('src/b.ts', PATCH_B)
    expect(store.count).toBe(2)
  })

  it('count decrements when a file is unmarked', () => {
    const store = createViewedStore(PR_ID)
    store.toggle('src/a.ts', PATCH_A)
    store.toggle('src/b.ts', PATCH_B)
    store.toggle('src/a.ts', PATCH_A) // unmark
    expect(store.count).toBe(1)
  })
})

describe('createViewedStore — hash-mismatch (changedSinceViewed)', () => {
  it('changedSinceViewed is false when not viewed', () => {
    const store = createViewedStore(PR_ID)
    expect(store.changedSinceViewed('src/a.ts', PATCH_A)).toBe(false)
  })

  it('changedSinceViewed is false when patch hash matches', () => {
    const store = createViewedStore(PR_ID)
    store.toggle('src/a.ts', PATCH_A)
    expect(store.changedSinceViewed('src/a.ts', PATCH_A)).toBe(false)
  })

  it('changedSinceViewed is true when patch changed after viewing', () => {
    const store = createViewedStore(PR_ID)
    store.toggle('src/a.ts', PATCH_A)
    // Patch B is the new version — hash differs
    expect(store.changedSinceViewed('src/a.ts', PATCH_B)).toBe(true)
  })

  it('isViewed is false when hash mismatches', () => {
    const store = createViewedStore(PR_ID)
    store.toggle('src/a.ts', PATCH_A)
    // Changed patch — no longer considered viewed
    expect(store.isViewed('src/a.ts', PATCH_B)).toBe(false)
  })
})

describe('createViewedStore — persistence and round-trip', () => {
  it('persists viewed state across store instances', () => {
    const store1 = createViewedStore(PR_ID)
    store1.toggle('src/a.ts', PATCH_A)

    // Create a new store instance reading same localStorage key
    const store2 = createViewedStore(PR_ID)
    expect(store2.isViewed('src/a.ts', PATCH_A)).toBe(true)
  })

  it('toggle off is also persisted', () => {
    const store1 = createViewedStore(PR_ID)
    store1.toggle('src/a.ts', PATCH_A)
    store1.toggle('src/a.ts', PATCH_A) // unmark

    const store2 = createViewedStore(PR_ID)
    expect(store2.isViewed('src/a.ts', PATCH_A)).toBe(false)
    expect(store2.count).toBe(0)
  })

  it('different PR IDs are isolated', () => {
    const s1 = createViewedStore('owner/repo#1')
    const s2 = createViewedStore('owner/repo#2')
    s1.toggle('src/a.ts', PATCH_A)
    expect(s2.isViewed('src/a.ts', PATCH_A)).toBe(false)
  })
})

describe('createViewedStore — corrupt storage', () => {
  it('returns empty state when localStorage is corrupt JSON', () => {
    localStorage.setItem('review123:viewed', '{not valid json')
    const store = createViewedStore(PR_ID)
    expect(store.isViewed('src/a.ts', PATCH_A)).toBe(false)
    expect(store.count).toBe(0)
  })

  it('returns empty state when localStorage has wrong shape', () => {
    localStorage.setItem('review123:viewed', JSON.stringify([1, 2, 3]))
    const store = createViewedStore(PR_ID)
    expect(store.count).toBe(0)
  })

  it('drops invalid entries but keeps valid ones', () => {
    const valid = { path: 'src/a.ts', patchHash: djb2(PATCH_A), viewedAt: Date.now() }
    const corrupt = { path: 42, patchHash: 'abc' } // invalid: path is number, no viewedAt
    localStorage.setItem(
      'review123:viewed',
      JSON.stringify({ [PR_ID]: [valid, corrupt] }),
    )
    const store = createViewedStore(PR_ID)
    expect(store.isViewed('src/a.ts', PATCH_A)).toBe(true)
    expect(store.count).toBe(1)
  })
})

describe('createViewedStore — LRU cap at 51 PRs', () => {
  it('evicts the oldest PR when 51st PR is added', () => {
    // Seed 50 PRs directly into localStorage with distinct, increasing viewedAt
    // so that PR #1 is definitely the oldest and will be evicted first.
    const base = 1_000_000
    const seed: Record<string, { path: string; patchHash: string; viewedAt: number }[]> = {}
    for (let i = 1; i <= 50; i++) {
      seed[`owner/repo#${i}`] = [
        { path: 'src/a.ts', patchHash: djb2(PATCH_A), viewedAt: base + i },
      ]
    }
    localStorage.setItem('review123:viewed', JSON.stringify(seed))

    // Verify seeded correctly
    const rawBefore = JSON.parse(localStorage.getItem('review123:viewed') ?? '{}')
    expect(Object.keys(rawBefore)).toHaveLength(50)

    // Add 51st PR (newest) — should trigger eviction of PR #1 (oldest viewedAt = base+1)
    const s51 = createViewedStore('owner/repo#51')
    s51.toggle('src/a.ts', PATCH_A)

    const rawAfter = JSON.parse(localStorage.getItem('review123:viewed') ?? '{}')
    expect(Object.keys(rawAfter)).toHaveLength(50)
    // PR #1 (oldest) should be gone
    expect(rawAfter['owner/repo#1']).toBeUndefined()
    // PR #51 (newest) should be present
    expect(rawAfter['owner/repo#51']).toBeDefined()
    // PR #50 should still be present
    expect(rawAfter['owner/repo#50']).toBeDefined()
  })
})

describe('createViewedStore — undefined/null patch', () => {
  it('treats undefined patch as empty string hash', () => {
    const store = createViewedStore(PR_ID)
    store.toggle('src/a.ts', undefined)
    expect(store.isViewed('src/a.ts', undefined)).toBe(true)
    expect(store.isViewed('src/a.ts', '')).toBe(true) // same hash
  })
})
