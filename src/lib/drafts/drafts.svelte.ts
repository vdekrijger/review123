/**
 * IndexedDB-backed draft store for line comments.
 * Falls back to pure in-memory operation when IndexedDB is unavailable (EC-07h).
 *
 * DB name  : review123-drafts  (overridable for tests via the second arg)
 * Store    : drafts
 * Key      : draftKey string  (prKey|path|line|side|n)
 *
 * Fix-B: Threaded follow-ups
 *   - Draft now has ordinal `n: number` (default 0)
 *   - draftKey includes n: `${prKey}|${path}|${line}|${side}|${n}`
 *   - Legacy 4-part keys (no n segment) are read as n=0
 *   - draftsAt(path, line, side) returns all drafts at a line sorted by n
 *   - upsert with no n specified appends at next n; with n specified, updates in place
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Draft {
  prKey: string
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
  body: string
  /** Thread ordinal — 0 for first comment, 1+ for replies. Default 0. */
  n?: number
  updatedAt: number
}

export function draftKey(d: Pick<Draft, 'prKey' | 'path' | 'line' | 'side'> & { n?: number }): string {
  return `${d.prKey}|${d.path}|${d.line}|${d.side}|${d.n ?? 0}`
}

/**
 * Parse a raw IDB key string into a Draft key shape.
 * Supports both 5-part keys (new) and legacy 4-part keys (treated as n=0).
 */
export function parseDraftKey(key: string): { prKey: string; path: string; line: number; side: 'LEFT' | 'RIGHT'; n: number } | null {
  // A draft key is: prKey|path|line|side[|n]
  // prKey itself contains '/' and '#', so we can't split on '|' naively.
  // prKey format: "owner/repo#number" — no pipes.
  // path may contain '/' but not '|'.
  // So split on '|': [prKey, path, line, side, n?]
  const parts = key.split('|')
  if (parts.length === 4) {
    // Legacy key: prKey|path|line|side
    const [prKey, path, lineStr, side] = parts
    const line = Number(lineStr)
    if (!prKey || !path || isNaN(line) || (side !== 'LEFT' && side !== 'RIGHT')) return null
    return { prKey, path, line, side, n: 0 }
  }
  if (parts.length === 5) {
    const [prKey, path, lineStr, side, nStr] = parts
    const line = Number(lineStr)
    const n = Number(nStr)
    if (!prKey || !path || isNaN(line) || (side !== 'LEFT' && side !== 'RIGHT') || isNaN(n)) return null
    return { prKey, path, line, side, n }
  }
  return null
}

// ---------------------------------------------------------------------------
// Tiny promisified IndexedDB helper (~60 lines)
// ---------------------------------------------------------------------------

const DB_VERSION = 1
const STORE_NAME = 'drafts'

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
        db.createObjectStore(STORE_NAME) // out-of-line key (we supply it explicitly)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('IDB open blocked'))
  })
}

async function idbGetAllForPr(db: IDBDatabase, prKey: string): Promise<{ key: string; value: Draft }[]> {
  const lower = `${prKey}|`
  const upper = `${prKey}|￿`
  const range = IDBKeyRange.bound(lower, upper)
  const tx = db.transaction(STORE_NAME, 'readonly')
  const store = tx.objectStore(STORE_NAME)
  // Use cursor to get key+value pairs (for legacy key migration)
  return new Promise((resolve, reject) => {
    const results: { key: string; value: Draft }[] = []
    const req = store.openCursor(range)
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        results.push({ key: cursor.key as string, value: cursor.value as Draft })
        cursor.continue()
      } else {
        resolve(results)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

async function idbPut(db: IDBDatabase, key: string, value: Draft): Promise<void> {
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.objectStore(STORE_NAME)
  await idbRequest(store.put(value, key))
}

async function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.objectStore(STORE_NAME)
  await idbRequest(store.delete(key))
}

async function idbDeleteLegacy(db: IDBDatabase, legacyKey: string): Promise<void> {
  // Delete the legacy 4-part key from IDB and re-store under the 5-part key
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.objectStore(STORE_NAME)
  await idbRequest(store.delete(legacyKey))
}

async function idbClearRange(db: IDBDatabase, prKey: string): Promise<void> {
  const lower = `${prKey}|`
  const upper = `${prKey}|￿`
  const range = IDBKeyRange.bound(lower, upper)
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.objectStore(STORE_NAME)
  // Open a cursor and delete each record in range
  await new Promise<void>((resolve, reject) => {
    const req = store.openCursor(range)
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        cursor.delete()
        cursor.continue()
      } else {
        resolve()
      }
    }
    req.onerror = () => reject(req.error)
  })
}

// ---------------------------------------------------------------------------
// createDraftStore
// ---------------------------------------------------------------------------

/**
 * Creates a reactive draft store bound to a single PR key.
 *
 * @param prKey    - e.g. "owner/repo#42@sha"
 * @param dbName   - override the DB name (useful in tests for isolation)
 */
export function createDraftStore(prKey: string, dbName = 'review123-drafts') {
  // $state-backed reactive array
  let drafts = $state<Draft[]>([])
  let persistent = $state(true)

  // Database handle — resolved lazily on first use; null in fallback mode
  let dbHandle: IDBDatabase | null = null
  let dbPromise: Promise<IDBDatabase | null> | null = null

  function getDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise
    // Check for IDB availability
    if (typeof (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB === 'undefined') {
      persistent = false
      dbPromise = Promise.resolve(null)
      return dbPromise
    }
    dbPromise = openDb(dbName)
      .then((db) => {
        dbHandle = db
        return db
      })
      .catch(() => {
        persistent = false
        return null
      })
    return dbPromise
  }

  return {
    get drafts() { return drafts },
    get persistent() { return persistent },
    get count() { return drafts.length },

    /**
     * Returns all drafts at a specific path/line/side, sorted by n ascending.
     * Fix-B: enables threaded display.
     */
    draftsAt(path: string, line: number, side: 'LEFT' | 'RIGHT'): Draft[] {
      return drafts
        .filter(d => d.path === path && d.line === line && d.side === side)
        .sort((a, b) => (a.n ?? 0) - (b.n ?? 0))
    },

    async load(): Promise<void> {
      const db = await getDb()
      if (!db) return // fallback: nothing to load from disk
      const entries = await idbGetAllForPr(db, prKey)
      const migrated: Draft[] = []
      for (const { key, value } of entries) {
        const parsed = parseDraftKey(key)
        if (!parsed) continue
        // If the stored Draft lacks 'n', default to 0
        const draft: Draft = { ...value, n: value.n ?? 0 }
        if (parsed.n !== draft.n) {
          // Migrate: fix n in stored object
          draft.n = parsed.n
        }
        // If key was legacy (4-part), migrate to 5-part
        const newKey = draftKey({ prKey, path: draft.path, line: draft.line, side: draft.side, n: draft.n })
        if (key !== newKey) {
          // Re-store under new key, delete old
          await idbDelete(db, key)
          await idbPut(db, newKey, draft)
        }
        migrated.push(draft)
      }
      drafts = migrated
    },

    /**
     * Upsert a draft.
     *
     * If n is provided: update the draft with that exact n in place.
     * If n is NOT provided:
     *   - Legacy / edit behavior: update n=0 draft (last-write-wins, same as before Fix-B).
     *   - If no n=0 draft exists, create one (first draft at this location).
     *
     * Fix-B: to ADD a threaded reply, pass n=-1 as a sentinel meaning "append next".
     * The store will compute the next n and store the draft there.
     */
    async upsert(d: Omit<Draft, 'prKey' | 'updatedAt' | 'n'> & { n?: number }): Promise<void> {
      // Determine the actual n to use
      const isAppend = d.n === -1 // sentinel: append as new thread entry

      // EC-07a: empty/whitespace body → remove the target draft instead
      if (!d.body.trim()) {
        if (!isAppend && d.n !== undefined) {
          // Remove specific n
          const key = draftKey({ prKey, path: d.path, line: d.line, side: d.side, n: d.n })
          return this.remove(key)
        } else if (!isAppend) {
          // No n specified: remove the n=0 draft (legacy / default behavior)
          const key = draftKey({ prKey, path: d.path, line: d.line, side: d.side, n: 0 })
          return this.remove(key)
        }
        // Append with empty body: no-op
        return
      }

      let n: number
      const existingAtLine = drafts.filter(
        x => x.path === d.path && x.line === d.line && x.side === d.side
      )

      if (isAppend) {
        // Explicit append — compute next n
        const maxN = existingAtLine.length > 0 ? Math.max(...existingAtLine.map(x => x.n ?? 0)) : -1
        n = maxN + 1
      } else if (d.n !== undefined) {
        // Edit in place — keep the given n
        n = d.n
      } else {
        // Legacy / default: always use n=0 (last-write-wins for the primary comment)
        n = 0
      }

      const key = draftKey({ prKey, path: d.path, line: d.line, side: d.side, n })
      const record: Draft = { path: d.path, line: d.line, side: d.side, body: d.body, prKey, n, updatedAt: Date.now() }

      // Update in-memory state (last-write-wins: replace existing if same key)
      const idx = drafts.findIndex((x) => draftKey(x) === key)
      if (idx >= 0) {
        drafts[idx] = record
      } else {
        drafts = [...drafts, record]
      }

      // Persist
      const db = await getDb()
      if (db) await idbPut(db, key, record)
    },

    async remove(key: string): Promise<void> {
      drafts = drafts.filter((x) => draftKey(x) !== key)
      const db = await getDb()
      if (db) await idbDelete(db, key)
    },

    async clearAll(): Promise<void> {
      drafts = []
      const db = await getDb()
      if (db) await idbClearRange(db, prKey)
    },
  }
}
