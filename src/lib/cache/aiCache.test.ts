/**
 * Tests for the IndexedDB AI response cache.
 * Uses fake-indexeddb/auto to provide IndexedDB in the Node/vitest environment.
 */
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// We reset the module's DB state between tests to keep isolation clean.
afterEach(() => {
  vi.unstubAllGlobals()
})

// Each test gets its own DB name to avoid cross-test pollution.
let testIndex = 0
function nextDbName(): string {
  return `test-ai-cache-${++testIndex}`
}

async function freshCache(dbName: string) {
  const mod = await import('./aiCache')
  mod._setDbName(dbName)
  return mod
}

// ---------------------------------------------------------------------------
// cacheKey
// ---------------------------------------------------------------------------
describe('cacheKey', () => {
  it('produces the expected composite key', async () => {
    const { cacheKey } = await import('./aiCache')
    expect(cacheKey('owner/repo#42@abc', 'summary', 1)).toBe('owner/repo#42@abc|summary|v1')
  })
})

// ---------------------------------------------------------------------------
// EC-17a: round trip — miss → set → hit
// ---------------------------------------------------------------------------
describe('round trip (EC-17a)', () => {
  it('getCached returns null on miss, then returns value after setCached', async () => {
    const { cacheKey, getCached, setCached } = await freshCache(nextDbName())

    const key = cacheKey('owner/repo#1@sha1', 'summary', 1)

    // miss
    expect(await getCached(key)).toBeNull()

    // set
    await setCached(key, 'hello world summary')

    // hit
    expect(await getCached(key)).toBe('hello world summary')
  })
})

// ---------------------------------------------------------------------------
// EC-17b: distinct keys for different sha (prKey)
// ---------------------------------------------------------------------------
describe('distinct keys for sha change (EC-17b)', () => {
  it('changing prKey sha produces a distinct key — different cache entry', async () => {
    const { cacheKey, getCached, setCached } = await freshCache(nextDbName())

    const keyA = cacheKey('owner/repo#1@sha1', 'summary', 1)
    const keyB = cacheKey('owner/repo#1@sha2', 'summary', 1)

    await setCached(keyA, 'result for sha1')

    expect(await getCached(keyA)).toBe('result for sha1')
    expect(await getCached(keyB)).toBeNull() // sha2 has no entry
  })
})

// ---------------------------------------------------------------------------
// EC-17c: distinct keys for different task
// ---------------------------------------------------------------------------
describe('distinct keys for task change (EC-17c)', () => {
  it('changing task produces a distinct key — different cache entry', async () => {
    const { cacheKey, getCached, setCached } = await freshCache(nextDbName())

    const keySummary = cacheKey('owner/repo#1@sha1', 'summary', 1)
    const keyVerdict = cacheKey('owner/repo#1@sha1', 'verdict', 1)

    await setCached(keySummary, 'summary result')

    expect(await getCached(keySummary)).toBe('summary result')
    expect(await getCached(keyVerdict)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// EC-17i: distinct keys for different promptVersion
// ---------------------------------------------------------------------------
describe('distinct keys for promptVersion change (EC-17i)', () => {
  it('changing promptVersion produces a distinct key — different cache entry', async () => {
    const { cacheKey, getCached, setCached } = await freshCache(nextDbName())

    const keyV1 = cacheKey('owner/repo#1@sha1', 'summary', 1)
    const keyV2 = cacheKey('owner/repo#1@sha1', 'summary', 2)

    await setCached(keyV1, 'v1 result')

    expect(await getCached(keyV1)).toBe('v1 result')
    expect(await getCached(keyV2)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// EC-17e: IndexedDB unavailable → getCached null, setCached no-op, no throw
// ---------------------------------------------------------------------------
describe('unavailable fallback (EC-17e)', () => {
  it('getCached returns null when indexedDB is not available', async () => {
    vi.stubGlobal('indexedDB', undefined)

    const { cacheKey, getCached } = await freshCache(nextDbName())
    const key = cacheKey('owner/repo#2@sha', 'summary', 1)

    // must not throw, must return null
    const result = await getCached(key)
    expect(result).toBeNull()
  })

  it('setCached is a no-op when indexedDB is not available — no throw', async () => {
    vi.stubGlobal('indexedDB', undefined)

    const { cacheKey, setCached } = await freshCache(nextDbName())
    const key = cacheKey('owner/repo#2@sha', 'summary', 1)

    // must not throw
    await expect(setCached(key, 'data')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Structured values round-trip (objects with types intact)
// ---------------------------------------------------------------------------
describe('structured value round-trip', () => {
  it('stores and retrieves a plain object with its shape intact', async () => {
    const { cacheKey, getCached, setCached } = await freshCache(nextDbName())

    interface VerdictResult {
      level: 'minor-changes'
      evidence: string[]
      notAnalyzed: string[]
    }

    const key = cacheKey('owner/repo#3@sha', 'verdict', 1)
    const value: VerdictResult = {
      level: 'minor-changes',
      evidence: ['renamed a variable', 'updated tests'],
      notAnalyzed: ['large-generated-file.ts'],
    }

    await setCached(key, value)

    const got = await getCached<VerdictResult>(key)
    expect(got).not.toBeNull()
    expect(got!.level).toBe('minor-changes')
    expect(got!.evidence).toEqual(['renamed a variable', 'updated tests'])
    expect(got!.notAnalyzed).toEqual(['large-generated-file.ts'])
  })

  it('stores and retrieves nested arrays and numbers correctly', async () => {
    const { cacheKey, getCached, setCached } = await freshCache(nextDbName())

    const key = cacheKey('owner/repo#4@sha', 'attention', 1)
    const value = {
      readingOrder: ['src/index.ts', 'src/utils.ts'],
      hotspots: [{ path: 'src/index.ts', reason: 'core logic', level: 'high' as const }],
      testFlags: [],
    }

    await setCached(key, value)

    const got = await getCached<typeof value>(key)
    expect(got).not.toBeNull()
    expect(got!.readingOrder).toEqual(['src/index.ts', 'src/utils.ts'])
    expect(got!.hotspots[0].level).toBe('high')
    expect(got!.testFlags).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Overwrite same key (last-write-wins)
// ---------------------------------------------------------------------------
describe('overwrite same key', () => {
  it('setCached twice on the same key keeps the last value', async () => {
    const { cacheKey, getCached, setCached } = await freshCache(nextDbName())

    const key = cacheKey('owner/repo#5@sha', 'summary', 1)

    await setCached(key, 'first value')
    await setCached(key, 'second value')

    expect(await getCached(key)).toBe('second value')
  })
})

// ---------------------------------------------------------------------------
// EC-17h-lite: corrupt/unreadable entry → null (no throw)
// ---------------------------------------------------------------------------
describe('corrupt entry treated as miss (EC-17h-lite)', () => {
  it('getCached returns null and does not throw when the IDB get request errors', async () => {
    const { cacheKey, getCached, _setDbName } = await import('./aiCache')
    _setDbName(nextDbName())

    // Simulate a corrupt store by making the transaction throw synchronously.
    // We do this by replacing the real db handle after open with a broken proxy.
    // Easiest approach: stub indexedDB.open to succeed but return a db whose
    // transaction method throws.
    const brokenDb = {
      transaction: () => {
        throw new Error('simulated IDB corruption')
      },
    } as unknown as IDBDatabase

    // Force _dbPromise to resolve to the broken db
    // We do this by re-importing and patching the internals via _setDbName trick
    // combined with a getDb-level override via a fresh module with stubbed open.
    // Simpler: use a fake IDBFactory that returns a db with broken objectStore.
    const { IDBFactory: FakeIDBFactory, IDBDatabase: FakeIDBDatabase } = await import('fake-indexeddb')

    void FakeIDBDatabase // avoid unused import warning
    void FakeIDBDatabase

    // Swapping indexedDB at this point is tricky because _dbPromise is already
    // set. Use _setDbName to reset the promise, then stub.
    _setDbName(nextDbName())

    // Stub globalThis.indexedDB to an object whose open returns a request that
    // succeeds with the brokenDb.
    const fakeOpen = () => {
      const req = {
        result: brokenDb,
        error: null,
        onupgradeneeded: null as ((e: Event) => void) | null,
        onsuccess: null as ((e: Event) => void) | null,
        onerror: null as ((e: Event) => void) | null,
        onblocked: null as ((e: Event) => void) | null,
      }
      // Trigger onsuccess asynchronously
      Promise.resolve().then(() => req.onsuccess?.(new Event('success')))
      return req
    }

    vi.stubGlobal('indexedDB', { open: fakeOpen })
    _setDbName(nextDbName()) // reset promise again so it uses the stub

    const key = cacheKey('owner/repo#6@sha', 'summary', 1)
    const result = await getCached(key)
    expect(result).toBeNull()
  })
})
