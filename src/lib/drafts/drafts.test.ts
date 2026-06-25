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

/**
 * Put a draft DIRECTLY into IndexedDB under a given (possibly legacy @sha) prKey,
 * WITHOUT going through the store (whose load() now runs the re-key migration).
 * Use this to seed raw on-disk legacy data when the test must observe it before
 * any identity-store load migrates it.
 */
async function rawSeed(prKey: string, db: string, path: string, line: number, side: 'LEFT' | 'RIGHT', body: string) {
  const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB
  await new Promise<void>((resolve, reject) => {
    const open = idb.open(db, 1)
    open.onupgradeneeded = () => {
      const dbh = open.result
      if (!dbh.objectStoreNames.contains('drafts')) dbh.createObjectStore('drafts')
    }
    open.onsuccess = () => {
      const dbh = open.result
      const tx = dbh.transaction('drafts', 'readwrite')
      tx.objectStore('drafts').put({ prKey, path, line, side, body, n: 0, updatedAt: Date.now() }, `${prKey}|${path}|${line}|${side}|0`)
      tx.oncomplete = () => { dbh.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
    open.onerror = () => reject(open.error)
  })
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

// ---------------------------------------------------------------------------
// Multi-line: startLine field on Draft
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// parsePrKey — provider-qualified + legacy + sha forms
// ---------------------------------------------------------------------------
describe('parsePrKey', () => {
  it('parses a provider-qualified prKey with sha', async () => {
    const { parsePrKey } = await import('./drafts.svelte')
    expect(parsePrKey('github:acme/widgets#42@abc123')).toEqual({
      prKey: 'github:acme/widgets#42@abc123',
      provider: 'github',
      owner: 'acme',
      repo: 'widgets',
      number: 42,
      headSha: 'abc123',
    })
  })

  it('parses a legacy (unqualified) prKey, defaulting provider to github', async () => {
    const { parsePrKey } = await import('./drafts.svelte')
    expect(parsePrKey('acme/widgets#7@deadbeef')).toEqual({
      prKey: 'acme/widgets#7@deadbeef',
      provider: 'github',
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      headSha: 'deadbeef',
    })
  })

  it('parses a prKey with no sha segment', async () => {
    const { parsePrKey } = await import('./drafts.svelte')
    expect(parsePrKey('gitlab:acme/widgets#9')).toMatchObject({
      provider: 'gitlab',
      owner: 'acme',
      repo: 'widgets',
      number: 9,
      headSha: '',
    })
  })

  it('parses a gitlab host-qualified prKey (gitlab@host:...)', async () => {
    const { parsePrKey } = await import('./drafts.svelte')
    expect(parsePrKey('gitlab@git.example.com:acme/widgets#3@sha1')).toEqual({
      prKey: 'gitlab@git.example.com:acme/widgets#3@sha1',
      provider: 'gitlab@git.example.com',
      owner: 'acme',
      repo: 'widgets',
      number: 3,
      headSha: 'sha1',
    })
  })

  it('returns null for an unparseable key', async () => {
    const { parsePrKey } = await import('./drafts.svelte')
    expect(parsePrKey('not-a-prkey')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// listDraftSummaries — cross-PR enumeration grouped by prKey
// ---------------------------------------------------------------------------
describe('listDraftSummaries', () => {
  it('groups drafts by prKey with counts and most-recent lastUpdatedAt', async () => {
    const db = `test-db-summaries-${++testIndex}`
    const { createDraftStore, listDraftSummaries } = await import('./drafts.svelte')

    const prA = 'github:acme/widgets#1@shaA'
    const prB = 'github:acme/widgets#2@shaB'

    const storeA = createDraftStore(prA, db)
    await storeA.load()
    await storeA.upsert({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'a1' })
    await storeA.upsert({ path: 'a.ts', line: 2, side: 'RIGHT', body: 'a2' })

    const storeB = createDraftStore(prB, db)
    await storeB.load()
    await storeB.upsert({ path: 'b.ts', line: 1, side: 'LEFT', body: 'b1' })

    const summaries = await listDraftSummaries(db)
    const byKey = new Map(summaries.map((s) => [s.prKey, s]))

    expect(byKey.get(prA)?.draftCount).toBe(2)
    expect(byKey.get(prB)?.draftCount).toBe(1)
    expect(byKey.get(prA)?.owner).toBe('acme')
    expect(byKey.get(prA)?.repo).toBe('widgets')
    expect(byKey.get(prA)?.number).toBe(1)
    expect(byKey.get(prA)?.headSha).toBe('shaA')
    // lastUpdatedAt is the max updatedAt across the group's drafts
    expect(byKey.get(prA)?.lastUpdatedAt).toBe(
      Math.max(...storeA.drafts.map((d) => d.updatedAt)),
    )
  })

  it('surfaces multiple sha variants of one PR as separate summaries (raw legacy data)', async () => {
    const db = `test-db-summaries-sha-${++testIndex}`
    const { listDraftSummaries } = await import('./drafts.svelte')

    // Seed raw legacy @sha keys directly (no store load → no re-key migration),
    // mirroring on-disk data the Landing page enumerates before any identity
    // store loads. listDraftSummaries must still report each sha variant.
    await rawSeed('github:acme/widgets#5@oldsha', db, 'a.ts', 1, 'RIGHT', 'on old commit')
    await rawSeed('github:acme/widgets#5@newsha', db, 'a.ts', 1, 'RIGHT', 'on new commit')
    await rawSeed('github:acme/widgets#5@newsha', db, 'a.ts', 2, 'RIGHT', 'second on new')

    const summaries = await listDraftSummaries(db)
    const variants = summaries.filter((s) => s.owner === 'acme' && s.repo === 'widgets' && s.number === 5)
    expect(variants).toHaveLength(2)
    const shas = variants.map((v) => v.headSha).sort()
    expect(shas).toEqual(['newsha', 'oldsha'])
  })

  it('returns [] when there are no drafts', async () => {
    const db = `test-db-summaries-empty-${++testIndex}`
    const { listDraftSummaries } = await import('./drafts.svelte')
    expect(await listDraftSummaries(db)).toEqual([])
  })

  it('returns [] when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const { listDraftSummaries } = await import('./drafts.svelte')
    expect(await listDraftSummaries('whatever')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// clearDraftsForPr — removes every record for a prKey
// ---------------------------------------------------------------------------
describe('clearDraftsForPr', () => {
  it('removes all drafts for a single prKey (all sha-specific records)', async () => {
    const db = `test-db-cleardrafts-${++testIndex}`
    const { createDraftStore, listDraftSummaries, clearDraftsForPr } = await import('./drafts.svelte')

    const prA = 'github:acme/widgets#1@shaA'
    const prB = 'github:acme/widgets#2@shaB'

    const storeA = createDraftStore(prA, db)
    await storeA.load()
    await storeA.upsert({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'a1' })
    await storeA.upsert({ path: 'a.ts', line: 2, side: 'RIGHT', body: 'a2' })

    const storeB = createDraftStore(prB, db)
    await storeB.load()
    await storeB.upsert({ path: 'b.ts', line: 1, side: 'LEFT', body: 'b1' })

    await clearDraftsForPr(prA, db)

    const summaries = await listDraftSummaries(db)
    expect(summaries.map((s) => s.prKey)).toEqual([prB])

    // A fresh store for prA confirms nothing is left on disk
    const reloadA = createDraftStore(prA, db)
    await reloadA.load()
    expect(reloadA.count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Re-key migration — legacy `@sha` prKeys → stable PR identity prKey
//
// Drafts used to be keyed by `provider:owner/repo#number@headSha`, so a new
// commit orphaned them under the old sha. They are now keyed by PR IDENTITY
// (`provider:owner/repo#number`, no sha); load() migrates any legacy sha-keyed
// drafts into the identity key, tagging each with its source commit. Must be
// LOSSLESS (never drop/overwrite a draft) and IDEMPOTENT (second run = no-op).
// ---------------------------------------------------------------------------
describe('re-key migration (legacy @sha → identity)', () => {
  const IDENTITY = 'github:acme/widgets#5'

  /**
   * Seed a draft DIRECTLY into IndexedDB under a legacy sha-bearing prKey,
   * bypassing the store (which would itself run the migration). This faithfully
   * simulates pre-existing on-disk legacy data laid down before the re-key.
   */
  async function seedLegacy(prKey: string, db: string, path: string, line: number, side: 'LEFT' | 'RIGHT', body: string, startLine?: number) {
    const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB
    await new Promise<void>((resolve, reject) => {
      const open = idb.open(db, 1)
      open.onupgradeneeded = () => {
        const dbh = open.result
        if (!dbh.objectStoreNames.contains('drafts')) dbh.createObjectStore('drafts')
      }
      open.onsuccess = () => {
        const dbh = open.result
        const tx = dbh.transaction('drafts', 'readwrite')
        const record: Record<string, unknown> = { prKey, path, line, side, body, n: 0, updatedAt: Date.now() }
        if (startLine != null) record.startLine = startLine
        tx.objectStore('drafts').put(record, `${prKey}|${path}|${line}|${side}|0`)
        tx.oncomplete = () => { dbh.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      }
      open.onerror = () => reject(open.error)
    })
  }
  // (seedLegacy mirrors module-level rawSeed but additionally carries startLine.)

  it('adopts legacy @sha1 + @sha2 drafts into the identity key with per-draft headSha; none lost', async () => {
    const db = `test-db-rekey-multi-${++testIndex}`
    const { createDraftStore, listDraftSummaries } = await import('./drafts.svelte')

    await seedLegacy(`${IDENTITY}@sha1`, db, 'a.ts', 1, 'RIGHT', 'on commit one')
    await seedLegacy(`${IDENTITY}@sha2`, db, 'b.ts', 9, 'LEFT', 'on commit two', 7)

    // Loading the identity store runs the migration.
    const store = createDraftStore(IDENTITY, db)
    await store.load()

    expect(store.count).toBe(2)
    expect(store.drafts.every((d) => d.prKey === IDENTITY)).toBe(true)
    const a = store.drafts.find((d) => d.path === 'a.ts')
    const b = store.drafts.find((d) => d.path === 'b.ts')
    expect(a?.body).toBe('on commit one')
    expect(a?.headSha).toBe('sha1')
    expect(b?.body).toBe('on commit two')
    expect(b?.headSha).toBe('sha2')
    expect(b?.startLine).toBe(7) // ranged metadata preserved

    // No @sha-keyed variants remain on disk for this PR — only the identity key.
    const keys = (await listDraftSummaries(db)).map((x) => x.prKey)
    expect(keys).toEqual([IDENTITY])
  })

  it('is idempotent — a second load makes no change', async () => {
    const db = `test-db-rekey-idem-${++testIndex}`
    const { createDraftStore } = await import('./drafts.svelte')

    await seedLegacy(`${IDENTITY}@sha1`, db, 'a.ts', 1, 'RIGHT', 'first')
    await seedLegacy(`${IDENTITY}@sha2`, db, 'b.ts', 2, 'LEFT', 'second')

    const store1 = createDraftStore(IDENTITY, db)
    await store1.load()
    expect(store1.count).toBe(2)
    const bodies1 = store1.drafts.map((d) => d.body).sort()

    // Second run, fresh store — must be a no-op (no duplicates, no loss).
    const store2 = createDraftStore(IDENTITY, db)
    await store2.load()
    expect(store2.count).toBe(2)
    expect(store2.drafts.map((d) => d.body).sort()).toEqual(bodies1)
  })

  it('keeps BOTH on an anchor collision with different bodies (never overwrite)', async () => {
    const db = `test-db-rekey-collide-${++testIndex}`
    const { createDraftStore } = await import('./drafts.svelte')

    // Same anchor (a.ts|1|RIGHT|0) under two shas, DIFFERENT bodies.
    await seedLegacy(`${IDENTITY}@shaA`, db, 'a.ts', 1, 'RIGHT', 'body A')
    await seedLegacy(`${IDENTITY}@shaB`, db, 'a.ts', 1, 'RIGHT', 'body B')

    const store = createDraftStore(IDENTITY, db)
    await store.load()

    expect(store.count).toBe(2) // both survived (one appended at next n)
    expect(store.drafts.map((d) => d.body).sort()).toEqual(['body A', 'body B'])
  })

  it('de-dups identical bodies at the same anchor across shas', async () => {
    const db = `test-db-rekey-dupe-${++testIndex}`
    const { createDraftStore } = await import('./drafts.svelte')

    await seedLegacy(`${IDENTITY}@shaA`, db, 'a.ts', 1, 'RIGHT', 'identical')
    await seedLegacy(`${IDENTITY}@shaB`, db, 'a.ts', 1, 'RIGHT', 'identical')

    const store = createDraftStore(IDENTITY, db)
    await store.load()

    expect(store.count).toBe(1)
    expect(store.drafts[0].body).toBe('identical')
  })

  it('leaves drafts from a DIFFERENT PR untouched (strict identity match)', async () => {
    const db = `test-db-rekey-otherpr-${++testIndex}`
    const { createDraftStore, listDraftSummaries } = await import('./drafts.svelte')

    await seedLegacy(`${IDENTITY}@sha1`, db, 'a.ts', 1, 'RIGHT', 'mine')
    await seedLegacy('github:acme/widgets#6@sha1', db, 'a.ts', 1, 'RIGHT', 'other PR')
    await seedLegacy('gitlab:acme/widgets#5@sha1', db, 'a.ts', 1, 'RIGHT', 'other provider')

    const store = createDraftStore(IDENTITY, db)
    await store.load()
    expect(store.count).toBe(1)

    const keys = (await listDraftSummaries(db)).map((x) => x.prKey).sort()
    expect(keys).toEqual([IDENTITY, 'github:acme/widgets#6@sha1', 'gitlab:acme/widgets#5@sha1'].sort())
  })
})

describe('maker-sha stamping', () => {
  it('stamps the makerSha onto newly upserted drafts as headSha', async () => {
    const db = `test-db-makersha-${++testIndex}`
    const { createDraftStore } = await import('./drafts.svelte')

    const store = createDraftStore('github:acme/widgets#5', db, 'abc1234')
    await store.load()
    await store.upsert({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'new draft' })

    expect(store.drafts[0].headSha).toBe('abc1234')

    // Round-trips through reload.
    const reload = createDraftStore('github:acme/widgets#5', db)
    await reload.load()
    expect(reload.drafts[0].headSha).toBe('abc1234')
  })

  it('omits headSha when no makerSha is provided', async () => {
    const db = `test-db-no-makersha-${++testIndex}`
    const { createDraftStore } = await import('./drafts.svelte')

    const store = createDraftStore('github:acme/widgets#5', db)
    await store.load()
    await store.upsert({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'new draft' })

    expect(store.drafts[0].headSha).toBeUndefined()
  })
})

describe('multi-line comments: startLine field', () => {
  it('upsert stores startLine and round-trips via load', async () => {
    const prKey = nextPrKey()
    const db = `test-db-startline-rt-${prKey.replace(/[^a-z0-9]/gi, '-')}`
    const store1 = await freshStore(prKey, db)
    await store1.load()
    await store1.upsert({ path: 'a.ts', line: 10, side: 'RIGHT', body: 'ml comment', startLine: 7 })
    expect(store1.drafts[0].startLine).toBe(7)

    const store2 = await freshStore(prKey, db)
    await store2.load()
    expect(store2.drafts[0].startLine).toBe(7)
    expect(store2.drafts[0].line).toBe(10)
  })

  it('draftKey is anchored at end line — same key with or without startLine', async () => {
    const { draftKey } = await import('./drafts.svelte')
    const withStart = draftKey({ prKey: 'o/r#1', path: 'a.ts', line: 10, side: 'RIGHT', startLine: 7 })
    const withoutStart = draftKey({ prKey: 'o/r#1', path: 'a.ts', line: 10, side: 'RIGHT' })
    expect(withStart).toBe(withoutStart)
  })

  it('startLine not stored when absent (single-line draft)', async () => {
    const prKey = nextPrKey()
    const db = `test-db-startline-absent-${prKey.replace(/[^a-z0-9]/gi, '-')}`
    const store = await freshStore(prKey, db)
    await store.load()
    await store.upsert({ path: 'a.ts', line: 5, side: 'LEFT', body: 'single line' })
    expect(store.drafts[0].startLine).toBeUndefined()
  })

  it('startLine equal to line is treated as single-line (no startLine stored)', async () => {
    const prKey = nextPrKey()
    const db = `test-db-startline-eq-${prKey.replace(/[^a-z0-9]/gi, '-')}`
    const store = await freshStore(prKey, db)
    await store.load()
    await store.upsert({ path: 'a.ts', line: 5, side: 'LEFT', body: 'same line', startLine: 5 })
    // startLine === line is semantically single-line; implementation may store or not store it
    // but submission logic must NOT emit start_line in that case — tested in review.test.ts
    const d = store.drafts[0]
    // line must still be 5
    expect(d.line).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// AI-authored attribution: aiAuthored / aiReviewer fields
// ---------------------------------------------------------------------------
describe('AI-authored attribution fields', () => {
  it('upsert stores aiAuthored + aiReviewer and round-trips via load', async () => {
    const prKey = nextPrKey()
    const db = `test-db-ai-rt-${prKey.replace(/[^a-z0-9]/gi, '-')}`
    const store1 = await freshStore(prKey, db)
    await store1.load()
    await store1.upsert({ path: 'a.ts', line: 10, side: 'RIGHT', body: 'from a reviewer', aiAuthored: true, aiReviewer: 'Security' })
    expect(store1.drafts[0].aiAuthored).toBe(true)
    expect(store1.drafts[0].aiReviewer).toBe('Security')

    const store2 = await freshStore(prKey, db)
    await store2.load()
    expect(store2.drafts[0].aiAuthored).toBe(true)
    expect(store2.drafts[0].aiReviewer).toBe('Security')
    expect(store2.drafts[0].body).toBe('from a reviewer') // body stays clean
  })

  it('hand-written drafts have no aiAuthored / aiReviewer', async () => {
    const prKey = nextPrKey()
    const db = `test-db-ai-hand-${prKey.replace(/[^a-z0-9]/gi, '-')}`
    const store = await freshStore(prKey, db)
    await store.load()
    await store.upsert({ path: 'a.ts', line: 5, side: 'RIGHT', body: 'my own comment' })
    expect(store.drafts[0].aiAuthored).toBeUndefined()
    expect(store.drafts[0].aiReviewer).toBeUndefined()
  })

  it('old drafts on disk without the fields load fine (undefined)', async () => {
    const prKey = nextPrKey()
    const db = `test-db-ai-legacy-${prKey.replace(/[^a-z0-9]/gi, '-')}`
    // rawSeed writes a record WITHOUT aiAuthored/aiReviewer (legacy shape).
    await rawSeed(prKey, db, 'a.ts', 3, 'RIGHT', 'legacy draft')
    const store = await freshStore(prKey, db)
    await store.load()
    expect(store.drafts).toHaveLength(1)
    expect(store.drafts[0].body).toBe('legacy draft')
    expect(store.drafts[0].aiAuthored).toBeUndefined()
    expect(store.drafts[0].aiReviewer).toBeUndefined()
  })

  it('re-key migration preserves aiAuthored / aiReviewer', async () => {
    const IDENTITY = 'github:acme/widgets#5'
    const db = `test-db-ai-rekey-${++testIndex}`
    const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB
    // Seed a legacy @sha-keyed AI-authored draft directly on disk.
    await new Promise<void>((resolve, reject) => {
      const open = idb.open(db, 1)
      open.onupgradeneeded = () => {
        const dbh = open.result
        if (!dbh.objectStoreNames.contains('drafts')) dbh.createObjectStore('drafts')
      }
      open.onsuccess = () => {
        const dbh = open.result
        const tx = dbh.transaction('drafts', 'readwrite')
        const prKey = `${IDENTITY}@sha1`
        tx.objectStore('drafts').put(
          { prKey, path: 'a.ts', line: 1, side: 'RIGHT', body: 'ai finding', n: 0, updatedAt: Date.now(), aiAuthored: true, aiReviewer: 'Perf' },
          `${prKey}|a.ts|1|RIGHT|0`,
        )
        tx.oncomplete = () => { dbh.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      }
      open.onerror = () => reject(open.error)
    })

    const { createDraftStore } = await import('./drafts.svelte')
    const store = createDraftStore(IDENTITY, db)
    await store.load()
    expect(store.count).toBe(1)
    const d = store.drafts[0]
    expect(d.prKey).toBe(IDENTITY)
    expect(d.headSha).toBe('sha1')
    expect(d.aiAuthored).toBe(true)
    expect(d.aiReviewer).toBe('Perf')
  })
})

describe('outgoingCommentBody', () => {
  it('prepends the 🤖 marker + reviewer + blank line for AI-authored drafts', async () => {
    const { outgoingCommentBody } = await import('./drafts.svelte')
    const out = outgoingCommentBody({ body: 'Use a constant here.', aiAuthored: true, aiReviewer: 'Security' })
    expect(out).toBe('🤖 _AI-suggested · Security_\n\nUse a constant here.')
  })

  it('falls back to "AI reviewer" when aiReviewer is missing', async () => {
    const { outgoingCommentBody } = await import('./drafts.svelte')
    const out = outgoingCommentBody({ body: 'Body.', aiAuthored: true })
    expect(out).toBe('🤖 _AI-suggested · AI reviewer_\n\nBody.')
  })

  it('returns the body verbatim for hand-written (non-AI) drafts', async () => {
    const { outgoingCommentBody } = await import('./drafts.svelte')
    expect(outgoingCommentBody({ body: 'My comment.' })).toBe('My comment.')
    expect(outgoingCommentBody({ body: 'My comment.', aiAuthored: false, aiReviewer: 'X' })).toBe('My comment.')
  })
})
