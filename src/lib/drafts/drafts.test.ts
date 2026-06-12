/**
 * Tests for the IndexedDB-backed draft store.
 * Uses fake-indexeddb/auto to provide IndexedDB in the Node/vitest environment.
 */
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

// We use unique db names per test to ensure isolation.
// After each test we also restore any stubbed globals.

afterEach(() => {
  vi.unstubAllGlobals()
})

// Helper: create a unique db-name-safe prKey per test
let testIndex = 0
function nextPrKey() {
  return `owner/repo#${++testIndex}`
}

async function freshStore(prKey: string, dbSuffix?: string) {
  // Dynamic import lets us re-import with a fresh module each time we need
  // a new IDB factory (workaround: we pass dbSuffix to use unique db names).
  const { createDraftStore } = await import('./drafts.svelte')
  return createDraftStore(prKey, dbSuffix)
}

// ---------------------------------------------------------------------------
// Round-trip across store instances (EC-07f: simulates tab close)
// ---------------------------------------------------------------------------
describe('round-trip persistence across store instances', () => {
  it('data written with one instance is visible to a fresh instance after load()', async () => {
    const prKey = nextPrKey()
    const db = `test-db-rt-${prKey.replace(/[^a-z0-9]/gi, '-')}`

    const store1 = await freshStore(prKey, db)
    await store1.load()
    await store1.upsert({ path: 'src/foo.ts', line: 10, side: 'RIGHT', body: 'nice change' })

    // Simulate tab close: fresh instance, same DB name
    const store2 = await freshStore(prKey, db)
    await store2.load()

    expect(store2.drafts).toHaveLength(1)
    expect(store2.drafts[0].body).toBe('nice change')
    expect(store2.drafts[0].path).toBe('src/foo.ts')
    expect(store2.drafts[0].line).toBe(10)
    expect(store2.drafts[0].side).toBe('RIGHT')
    expect(store2.drafts[0].prKey).toBe(prKey)
  })
})

// ---------------------------------------------------------------------------
// EC-07a: empty body upsert removes
// ---------------------------------------------------------------------------
describe('empty body upsert removes draft', () => {
  it('upsert with empty body removes existing draft', async () => {
    const prKey = nextPrKey()
    const db = `test-db-empty-${prKey.replace(/[^a-z0-9]/gi, '-')}`

    const store = await freshStore(prKey, db)
    await store.load()
    await store.upsert({ path: 'a.ts', line: 1, side: 'LEFT', body: 'initial' })
    expect(store.count).toBe(1)

    await store.upsert({ path: 'a.ts', line: 1, side: 'LEFT', body: '' })
    expect(store.count).toBe(0)
    expect(store.drafts).toHaveLength(0)
  })

  it('upsert with whitespace-only body removes draft', async () => {
    const prKey = nextPrKey()
    const db = `test-db-ws-${prKey.replace(/[^a-z0-9]/gi, '-')}`

    const store = await freshStore(prKey, db)
    await store.load()
    await store.upsert({ path: 'b.ts', line: 5, side: 'RIGHT', body: 'hello' })
    await store.upsert({ path: 'b.ts', line: 5, side: 'RIGHT', body: '   \t\n  ' })
    expect(store.count).toBe(0)
  })

  it('upsert with empty body on non-existent key is a no-op', async () => {
    const prKey = nextPrKey()
    const db = `test-db-noop-${prKey.replace(/[^a-z0-9]/gi, '-')}`

    const store = await freshStore(prKey, db)
    await store.load()
    await store.upsert({ path: 'c.ts', line: 1, side: 'LEFT', body: '' })
    expect(store.count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// EC-07e: same-key overwrite is last-write-wins
// ---------------------------------------------------------------------------
describe('same-key overwrite (EC-07e)', () => {
  it('upserting the same key twice uses the last value', async () => {
    const prKey = nextPrKey()
    const db = `test-db-overwrite-${prKey.replace(/[^a-z0-9]/gi, '-')}`

    const store = await freshStore(prKey, db)
    await store.load()
    await store.upsert({ path: 'x.ts', line: 3, side: 'LEFT', body: 'first' })
    await store.upsert({ path: 'x.ts', line: 3, side: 'LEFT', body: 'second' })

    expect(store.count).toBe(1)
    expect(store.drafts[0].body).toBe('second')
  })

  it('overwrite is also reflected in a fresh store instance (persistence)', async () => {
    const prKey = nextPrKey()
    const db = `test-db-overwrite-persist-${prKey.replace(/[^a-z0-9]/gi, '-')}`

    const store1 = await freshStore(prKey, db)
    await store1.load()
    await store1.upsert({ path: 'x.ts', line: 3, side: 'LEFT', body: 'first' })
    await store1.upsert({ path: 'x.ts', line: 3, side: 'LEFT', body: 'second' })

    const store2 = await freshStore(prKey, db)
    await store2.load()
    expect(store2.drafts[0].body).toBe('second')
  })
})

// ---------------------------------------------------------------------------
// Per-PR isolation: different prKey loads nothing from another PR's drafts
// ---------------------------------------------------------------------------
describe('per-PR isolation', () => {
  it('drafts from prKey A are not visible to a store with prKey B', async () => {
    const prKeyA = nextPrKey()
    const prKeyB = nextPrKey()
    const db = `test-db-isolation-${testIndex}`

    const storeA = await freshStore(prKeyA, db)
    await storeA.load()
    await storeA.upsert({ path: 'only-a.ts', line: 1, side: 'LEFT', body: 'draft from A' })

    const storeB = await freshStore(prKeyB, db)
    await storeB.load()
    expect(storeB.drafts).toHaveLength(0)
    expect(storeB.count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// EC-07d: unicode / markdown / HTML bodies stored verbatim
// ---------------------------------------------------------------------------
describe('verbatim body storage (EC-07d)', () => {
  it('stores unicode correctly', async () => {
    const prKey = nextPrKey()
    const db = `test-db-unicode-${prKey.replace(/[^a-z0-9]/gi, '-')}`
    const body = '日本語 テスト 🎉 <b>bold</b> & "quotes"'

    const store = await freshStore(prKey, db)
    await store.load()
    await store.upsert({ path: 'unicode.ts', line: 1, side: 'LEFT', body })

    expect(store.drafts[0].body).toBe(body)
  })

  it('stores markdown verbatim', async () => {
    const prKey = nextPrKey()
    const db = `test-db-markdown-${prKey.replace(/[^a-z0-9]/gi, '-')}`
    const body = '## Heading\n\n- item 1\n- item 2\n\n```ts\nconst x = 1\n```'

    const store = await freshStore(prKey, db)
    await store.load()
    await store.upsert({ path: 'md.ts', line: 1, side: 'LEFT', body })

    expect(store.drafts[0].body).toBe(body)
  })

  it('stores raw HTML verbatim (sanitization is render-side)', async () => {
    const prKey = nextPrKey()
    const db = `test-db-html-${prKey.replace(/[^a-z0-9]/gi, '-')}`
    const body = '<script>alert(1)</script><img onerror="xss()">'

    const store = await freshStore(prKey, db)
    await store.load()
    await store.upsert({ path: 'html.ts', line: 1, side: 'LEFT', body })

    expect(store.drafts[0].body).toBe(body)
  })
})

// ---------------------------------------------------------------------------
// count reactivity: after upsert / remove
// ---------------------------------------------------------------------------
describe('count reactivity', () => {
  it('count increments after upsert and decrements after remove', async () => {
    const prKey = nextPrKey()
    const db = `test-db-count-${prKey.replace(/[^a-z0-9]/gi, '-')}`

    const store = await freshStore(prKey, db)
    await store.load()
    expect(store.count).toBe(0)

    await store.upsert({ path: 'a.ts', line: 1, side: 'LEFT', body: 'first' })
    expect(store.count).toBe(1)

    await store.upsert({ path: 'b.ts', line: 2, side: 'RIGHT', body: 'second' })
    expect(store.count).toBe(2)

    const { draftKey } = await import('./drafts.svelte')
    const key = draftKey({ prKey, path: 'a.ts', line: 1, side: 'LEFT' })
    await store.remove(key)
    expect(store.count).toBe(1)
  })

  it('clearAll resets count to 0', async () => {
    const prKey = nextPrKey()
    const db = `test-db-clearAll-${prKey.replace(/[^a-z0-9]/gi, '-')}`

    const store = await freshStore(prKey, db)
    await store.load()
    await store.upsert({ path: 'a.ts', line: 1, side: 'LEFT', body: 'x' })
    await store.upsert({ path: 'b.ts', line: 2, side: 'LEFT', body: 'y' })
    expect(store.count).toBe(2)

    await store.clearAll()
    expect(store.count).toBe(0)
    expect(store.drafts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// EC-07h: in-memory fallback when IndexedDB is unavailable
// ---------------------------------------------------------------------------
describe('in-memory fallback (EC-07h)', () => {
  it('works without IndexedDB: persistent===false, upsert/count still function', async () => {
    // Stub indexedDB out of globalThis so the store falls back to in-memory
    vi.stubGlobal('indexedDB', undefined)

    const prKey = nextPrKey()
    // Dynamically import so the module uses the stubbed global
    const { createDraftStore } = await import('./drafts.svelte')
    const store = createDraftStore(prKey)
    await store.load()

    expect(store.persistent).toBe(false)

    await store.upsert({ path: 'mem.ts', line: 1, side: 'LEFT', body: 'memory draft' })
    expect(store.count).toBe(1)
    expect(store.drafts[0].body).toBe('memory draft')

    await store.upsert({ path: 'mem.ts', line: 1, side: 'LEFT', body: '' }) // EC-07a still works
    expect(store.count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// updatedAt is set at upsert time
// ---------------------------------------------------------------------------
describe('updatedAt timestamp', () => {
  it('updatedAt is set to roughly Date.now() at upsert', async () => {
    const prKey = nextPrKey()
    const db = `test-db-ts-${prKey.replace(/[^a-z0-9]/gi, '-')}`

    const before = Date.now()
    const store = await freshStore(prKey, db)
    await store.load()
    await store.upsert({ path: 'ts.ts', line: 1, side: 'LEFT', body: 'hi' })
    const after = Date.now()

    const { updatedAt } = store.drafts[0]
    expect(updatedAt).toBeGreaterThanOrEqual(before)
    expect(updatedAt).toBeLessThanOrEqual(after)
  })
})

// ---------------------------------------------------------------------------
// draftKey function
// ---------------------------------------------------------------------------
describe('draftKey', () => {
  it('produces the expected composite key with n=0 default', async () => {
    const { draftKey } = await import('./drafts.svelte')
    expect(draftKey({ prKey: 'owner/repo#42', path: 'src/app.ts', line: 99, side: 'RIGHT' }))
      .toBe('owner/repo#42|src/app.ts|99|RIGHT|0')
  })

  it('includes n in the key when specified', async () => {
    const { draftKey } = await import('./drafts.svelte')
    expect(draftKey({ prKey: 'owner/repo#42', path: 'src/app.ts', line: 99, side: 'RIGHT', n: 2 }))
      .toBe('owner/repo#42|src/app.ts|99|RIGHT|2')
  })
})

// ---------------------------------------------------------------------------
// Fix-B: Threaded follow-ups + legacy key migration
// ---------------------------------------------------------------------------
describe('Fix-B: threaded follow-ups', () => {
  it('first upsert at a location uses n=0', async () => {
    const prKey = nextPrKey()
    const db = `test-db-thread-${prKey.replace(/[^a-z0-9]/gi, '-')}`
    const store = await freshStore(prKey, db)
    await store.load()
    await store.upsert({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'first comment' })
    expect(store.count).toBe(1)
    expect(store.drafts[0].n ?? 0).toBe(0)
  })

  it('upsert with n=-1 appends a reply with next n', async () => {
    const prKey = nextPrKey()
    const db = `test-db-thread-reply-${prKey.replace(/[^a-z0-9]/gi, '-')}`
    const store = await freshStore(prKey, db)
    await store.load()
    await store.upsert({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'first' })
    await store.upsert({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'reply', n: -1 })
    expect(store.count).toBe(2)
    const sorted = [...store.drafts].sort((a, b) => (a.n ?? 0) - (b.n ?? 0))
    expect(sorted[0].body).toBe('first')
    expect(sorted[0].n ?? 0).toBe(0)
    expect(sorted[1].body).toBe('reply')
    expect(sorted[1].n ?? 0).toBe(1)
  })

  it('upsert with explicit n=0 edits the first draft in place', async () => {
    const prKey = nextPrKey()
    const db = `test-db-thread-edit-${prKey.replace(/[^a-z0-9]/gi, '-')}`
    const store = await freshStore(prKey, db)
    await store.load()
    await store.upsert({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'original' })
    await store.upsert({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'reply', n: -1 })
    // Edit n=0 in place
    await store.upsert({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'edited', n: 0 })
    expect(store.count).toBe(2)
    const at = store.draftsAt('a.ts', 1, 'RIGHT')
    expect(at[0].body).toBe('edited')
    expect(at[1].body).toBe('reply')
  })

  it('draftsAt returns drafts at a line sorted by n', async () => {
    const prKey = nextPrKey()
    const db = `test-db-draftsAt-${prKey.replace(/[^a-z0-9]/gi, '-')}`
    const store = await freshStore(prKey, db)
    await store.load()
    await store.upsert({ path: 'b.ts', line: 5, side: 'LEFT', body: 'A' })
    await store.upsert({ path: 'b.ts', line: 5, side: 'LEFT', body: 'B', n: -1 })
    const at = store.draftsAt('b.ts', 5, 'LEFT')
    expect(at).toHaveLength(2)
    expect(at[0].body).toBe('A')
    expect(at[1].body).toBe('B')
  })
})

describe('Fix-B: legacy key migration', () => {
  it('parseDraftKey handles legacy 4-part key as n=0', async () => {
    const { parseDraftKey } = await import('./drafts.svelte')
    const result = parseDraftKey('owner/repo#42|src/foo.ts|10|RIGHT')
    expect(result).toEqual({ prKey: 'owner/repo#42', path: 'src/foo.ts', line: 10, side: 'RIGHT', n: 0 })
  })

  it('parseDraftKey handles 5-part key with n', async () => {
    const { parseDraftKey } = await import('./drafts.svelte')
    const result = parseDraftKey('owner/repo#42|src/foo.ts|10|RIGHT|2')
    expect(result).toEqual({ prKey: 'owner/repo#42', path: 'src/foo.ts', line: 10, side: 'RIGHT', n: 2 })
  })
})

describe('Fix-B: submitReview maps multiple same-line drafts', () => {
  it('count reflects all threaded drafts', async () => {
    const prKey = nextPrKey()
    const db = `test-db-count-thread-${prKey.replace(/[^a-z0-9]/gi, '-')}`
    const store = await freshStore(prKey, db)
    await store.load()
    await store.upsert({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'first' })
    await store.upsert({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'second', n: -1 })
    expect(store.count).toBe(2)
  })
})
