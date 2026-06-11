/**
 * IndexedDB-backed AI response cache.
 * Falls back to no-op (getCached→null, setCached→void) when IndexedDB is
 * unavailable — callers must not throw and must treat the cache as a pure
 * performance optimisation (EC-17e).
 *
 * DB name  : review123-ai-cache  (overridable for tests via the second arg)
 * Store    : responses
 * Key      : cacheKey string  (prKey|task|v<promptVersion>)
 *
 * IMPORTANT (EC-17d): Only fully-completed results must be cached.
 * Partial/interrupted results (e.g. a stream that threw mid-flight) must
 * NEVER be passed to setCached. This contract is enforced by the caller
 * (the AI orchestrator in lib/ai/run.svelte.ts), not by this module.
 */

// ---------------------------------------------------------------------------
// Key helper
// ---------------------------------------------------------------------------

/**
 * Builds a deterministic cache key.
 * Distinct for every (prKey, task, promptVersion) triple (EC-17b/c/i).
 */
export function cacheKey(prKey: string, task: string, promptVersion: number): string {
  return `${prKey}|${task}|v${promptVersion}`
}

// ---------------------------------------------------------------------------
// Tiny promisified IndexedDB helpers
// ---------------------------------------------------------------------------

const DB_VERSION = 1
const STORE_NAME = 'responses'

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB.open(dbName, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME) // out-of-line key (supplied explicitly)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('IDB open blocked'))
  })
}

// ---------------------------------------------------------------------------
// Module-level DB handle (lazy, shared across calls)
// ---------------------------------------------------------------------------

let _dbName = 'review123-ai-cache'
let _dbPromise: Promise<IDBDatabase | null> | null = null

/** Override the DB name — only used in tests for isolation. */
export function _setDbName(name: string): void {
  _dbName = name
  _dbPromise = null // reset so next call re-opens under the new name
}

function getDb(): Promise<IDBDatabase | null> {
  if (_dbPromise) return _dbPromise

  // IndexedDB unavailable → graceful no-op (EC-17e)
  if (typeof (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB === 'undefined') {
    _dbPromise = Promise.resolve(null)
    return _dbPromise
  }

  _dbPromise = openDb(_dbName)
    .then((db) => db)
    .catch(() => null) // open failed → treat as unavailable, no throw
  return _dbPromise
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the cached value for `key`, or null on miss, unavailability, or a
 * corrupt/unreadable entry (EC-17e, EC-17h-lite).
 */
export async function getCached<T>(key: string): Promise<T | null> {
  const db = await getDb()
  if (!db) return null // unavailable (EC-17e)

  try {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const raw = await idbRequest<unknown>(store.get(key))
    if (raw === undefined) return null // cache miss
    // Stored value is the serialised object — return directly (IDB preserves types)
    return raw as T
  } catch {
    // Corrupt/unreadable entry → treat as miss, no throw (EC-17h-lite)
    return null
  }
}

/**
 * Stores `value` under `key`.
 * When IndexedDB is unavailable, this is a silent no-op — never throws (EC-17e).
 */
export async function setCached<T>(key: string, value: T): Promise<void> {
  const db = await getDb()
  if (!db) return // unavailable (EC-17e)

  try {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    await idbRequest(store.put(value, key))
  } catch {
    // Write failure → silent no-op, no throw
  }
}
