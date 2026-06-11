/**
 * IndexedDB-backed draft store for line comments.
 * Falls back to pure in-memory operation when IndexedDB is unavailable (EC-07h).
 *
 * DB name  : review123-drafts  (overridable for tests via the second arg)
 * Store    : drafts
 * Key      : draftKey string  (prKey|path|line|side)
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
  updatedAt: number
}

export function draftKey(d: Pick<Draft, 'prKey' | 'path' | 'line' | 'side'>): string {
  return `${d.prKey}|${d.path}|${d.line}|${d.side}`
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

async function idbGetAllForPr(db: IDBDatabase, prKey: string): Promise<Draft[]> {
  const lower = `${prKey}|`
  const upper = `${prKey}|￿`
  const range = IDBKeyRange.bound(lower, upper)
  const tx = db.transaction(STORE_NAME, 'readonly')
  const store = tx.objectStore(STORE_NAME)
  return idbRequest<Draft[]>(store.getAll(range))
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

    async load(): Promise<void> {
      const db = await getDb()
      if (!db) return // fallback: nothing to load from disk
      const stored = await idbGetAllForPr(db, prKey)
      drafts = stored
    },

    async upsert(d: Omit<Draft, 'prKey' | 'updatedAt'>): Promise<void> {
      const key = draftKey({ prKey, ...d })

      // EC-07a: empty/whitespace body → remove instead
      if (!d.body.trim()) {
        return this.remove(key)
      }

      const record: Draft = { ...d, prKey, updatedAt: Date.now() }

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
