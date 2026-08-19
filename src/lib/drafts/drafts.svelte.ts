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

import type { PrFile } from '../github/types'
import { relativeTime } from '../time'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Draft {
  /**
   * The PR IDENTITY key: `provider:owner/repo#number` (NO head sha). All of a
   * PR's drafts — across every commit they were made on — live under this one
   * key; the commit each draft was made on is carried in `headSha` below.
   */
  prKey: string
  path: string
  line: number
  /** For multi-line comments: the first (start) line of the range (must be < line). */
  startLine?: number
  side: 'LEFT' | 'RIGHT'
  body: string
  /** Thread ordinal — 0 for first comment, 1+ for replies. Default 0. */
  n?: number
  /**
   * The PR head commit SHA this draft was made on. Undefined for drafts created
   * before this field existed (and for the demo route). Used to (a) show a
   * "from commit abc1234" note when the draft was made on an older commit, and
   * (b) preserve provenance when migrating legacy `@sha`-keyed drafts.
   */
  headSha?: string
  /**
   * True when this draft was created from an AI reviewer's finding (e.g. via
   * "Add as draft"). Drives the in-app 🤖 badge and the GitHub-only attribution
   * marker. Undefined/false for hand-written line comments. The editable `body`
   * itself stays CLEAN — the marker is only prepended on the way out (see
   * `outgoingCommentBody`).
   */
  aiAuthored?: boolean
  /**
   * Display name of the AI reviewer/skill that suggested this finding (e.g.
   * "Security"). Only meaningful when `aiAuthored` is true. Undefined for older
   * drafts and hand-written comments.
   */
  aiReviewer?: string
  /**
   * Epoch-ms when this draft was first created. Undefined for drafts that
   * predate this field — such drafts render an "earlier session" fallback
   * instead of a relative age. Preserved (never backfilled) on edits and by
   * the re-key migration, so its absence stays an honest "unknown age".
   */
  createdAt?: number
  /**
   * Epoch-ms of the last body write. Optional because drafts written by very
   * old app versions may lack it; consumers must tolerate undefined.
   */
  updatedAt?: number
}

/**
 * The body to POST to GitHub for a draft. AI-authored drafts get a small
 * attribution marker prepended so the PR author sees the comment came from an AI
 * reviewer; hand-written drafts post verbatim. PURE — the stored `body` is never
 * mutated. Used by BOTH the real submit (`submitReview`) and the copy-able
 * console/curl/gh exports (`buildReviewPayload`) so they never drift. NOT used by
 * the "Copy as LLM prompt" export (a handoff to a coding agent — stays clean).
 */
export function outgoingCommentBody(draft: Pick<Draft, 'body' | 'aiAuthored' | 'aiReviewer'>): string {
  return draft.aiAuthored
    ? `🤖 _AI-suggested · ${draft.aiReviewer ?? 'AI reviewer'}_\n\n${draft.body}`
    : draft.body
}

// ---------------------------------------------------------------------------
// Draft lifecycle — staleness + age labels
// ---------------------------------------------------------------------------

/** The two lifecycle signals for a draft against the PR's CURRENT diff. */
export interface DraftStaleness {
  /**
   * Hard signal: the draft's file is not in the PR's current diff at all
   * (deleted from the PR, or renamed away — PrFile.filename is always the
   * CURRENT name, so a draft anchored at a renamed file's OLD path is stale).
   * Note: a file with status 'removed' is still IN the diff (the deletion is
   * part of the PR), so drafts on it are NOT stale.
   */
  stale: boolean
  /**
   * Soft signal: the draft was made on a different (older) head commit than
   * the current one. The draft may still anchor fine — this is informational.
   * False when either sha is unknown.
   */
  olderRevision: boolean
}

/**
 * Classify one draft against the PR's current file list + head sha. PURE.
 *
 * When `files` is empty the staleness check is skipped (stale: false): a real
 * PR diff always has ≥1 file, so an empty list means the caller has no file
 * list to judge against (demo/tests) — never that every file left the diff.
 */
export function isStaleDraft(
  draft: Pick<Draft, 'path' | 'headSha'>,
  files: readonly Pick<PrFile, 'filename'>[],
  headSha?: string,
): DraftStaleness {
  const stale = files.length > 0 && !files.some((f) => f.filename === draft.path)
  const olderRevision = !!draft.headSha && !!headSha && draft.headSha !== headSha
  return { stale, olderRevision }
}

/**
 * Relative age label for a draft's creation time: "just now", "5m ago",
 * "3h ago", "2d ago" — or "earlier session" when the draft predates the
 * createdAt field (we don't know its age, only that it wasn't made now).
 */
export function draftTimeLabel(createdAt: number | undefined): string {
  if (createdAt == null) return 'earlier session'
  return relativeTime(new Date(createdAt).toISOString())
}

/**
 * Tooltip (title=) text for a draft's creation time: the exact local datetime,
 * or an honest explanation when the draft has no recorded creation time.
 */
export function draftTimeTitle(createdAt: number | undefined): string {
  if (createdAt == null) return 'Created in an earlier session (no timestamp recorded)'
  return new Date(createdAt).toLocaleString()
}

export function draftKey(d: Pick<Draft, 'prKey' | 'path' | 'line' | 'side'> & { n?: number; startLine?: number }): string {
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
// prKey parsing — provider:owner/repo#number@sha (+ legacy unqualified form)
// ---------------------------------------------------------------------------

/**
 * A single in-flight PR's draft summary, grouped by prKey
 * (one entry per provider:owner/repo#number@sha variant).
 */
export interface DraftSummary {
  /** The full prKey: provider:owner/repo#number@sha (or legacy owner/repo#number@sha). */
  prKey: string
  provider: string
  owner: string
  repo: string
  number: number
  /** The head SHA segment, or '' when the prKey carried none. */
  headSha: string
  draftCount: number
  lastUpdatedAt: number
}

/**
 * Parse a prKey into its parts. Handles:
 *   - provider-qualified:   "github:owner/repo#42@abc123"
 *   - gitlab host-qualified: "gitlab@gitlab.example.com:owner/repo#42@abc123"
 *   - legacy (unqualified): "owner/repo#42@abc123"
 *   - sha may be absent:    "github:owner/repo#42"
 *
 * Returns null when the core owner/repo#number shape can't be recovered.
 */
export function parsePrKey(prKey: string): {
  prKey: string
  provider: string
  owner: string
  repo: string
  number: number
  headSha: string
} | null {
  let rest = prKey
  let provider = 'github'

  // Provider prefix: leading "<provider>:" where provider may be "gitlab@host".
  // The owner/repo segment never contains ':' or '@' before the first '/',
  // so a ':' that appears before the first '/' delimits the provider prefix.
  const slashIdx = rest.indexOf('/')
  const colonIdx = rest.indexOf(':')
  if (colonIdx !== -1 && (slashIdx === -1 || colonIdx < slashIdx)) {
    provider = rest.slice(0, colonIdx)
    rest = rest.slice(colonIdx + 1)
  }

  // Split off the head sha: "...#number@sha". The sha is everything after the
  // LAST '@' (host-qualified gitlab providers already had their '@' consumed
  // above as part of the provider prefix).
  let headSha = ''
  const atIdx = rest.lastIndexOf('@')
  if (atIdx !== -1) {
    headSha = rest.slice(atIdx + 1)
    rest = rest.slice(0, atIdx)
  }

  // rest is now "owner/repo#number"
  const hashIdx = rest.lastIndexOf('#')
  if (hashIdx === -1) return null
  const ownerRepo = rest.slice(0, hashIdx)
  const numberStr = rest.slice(hashIdx + 1)
  const number = Number(numberStr)
  if (!ownerRepo || numberStr === '' || isNaN(number)) return null

  const firstSlash = ownerRepo.indexOf('/')
  if (firstSlash === -1) return null
  const owner = ownerRepo.slice(0, firstSlash)
  const repo = ownerRepo.slice(firstSlash + 1)
  if (!owner || !repo) return null

  return { prKey, provider, owner, repo, number, headSha }
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
// Re-key migration — legacy `@sha` prKeys → stable PR identity prKey
// ---------------------------------------------------------------------------

/**
 * Adopt every draft stored under a LEGACY `@sha`-keyed prKey belonging to the
 * SAME PR identity (`provider:owner/repo#number`) into the identity prKey,
 * tagging each migrated draft with the source commit's sha (`headSha`).
 *
 * This is the re-keying that makes drafts immune to head-sha churn: once a PR's
 * drafts all live under one identity key, pushing a new commit can no longer
 * orphan them. It SUPERSEDES the old orphan-recovery dance.
 *
 * Guarantees:
 *   - Lossless: a source is deleted ONLY after its content exists under the
 *     identity key (adopt-then-delete). On an anchor COLLISION with an existing
 *     identity draft, the source is appended at the next free `n` (never
 *     overwrites) — unless the bodies are identical, in which case it is a
 *     duplicate already present and is simply dropped.
 *   - Idempotent: a second run finds no non-identity keys for this PR → no-op.
 *
 * No-op when `identityPrKey` is unparseable (e.g. the demo key) or when there
 * are no legacy sha-keyed variants for this identity.
 */
async function migrateLegacyShaKeysToIdentity(db: IDBDatabase, identityPrKey: string): Promise<void> {
  const target = parsePrKey(identityPrKey)
  if (!target) return

  // Collect every record whose prKey segment is a DIFFERENT (sha-bearing)
  // variant of this same PR identity.
  type Source = { sourceKey: string; sourcePrKey: string; sourceSha: string; value: Draft }
  const sources: Source[] = []

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const req = store.openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        const rawKey = cursor.key as string
        const pipeIdx = rawKey.indexOf('|')
        const sourcePrKey = pipeIdx === -1 ? rawKey : rawKey.slice(0, pipeIdx)
        if (sourcePrKey !== identityPrKey) {
          const parsed = parsePrKey(sourcePrKey)
          if (
            parsed &&
            parsed.provider === target.provider &&
            parsed.owner === target.owner &&
            parsed.repo === target.repo &&
            parsed.number === target.number
          ) {
            sources.push({
              sourceKey: rawKey,
              sourcePrKey,
              sourceSha: parsed.headSha,
              value: cursor.value as Draft,
            })
          }
        }
        cursor.continue()
      } else {
        resolve()
      }
    }
    req.onerror = () => reject(req.error)
  })

  if (sources.length === 0) return

  // Track per-anchor occupancy under the identity key so collisions can append
  // at a fresh `n`. Seed from the identity records already on disk.
  const identityEntries = await idbGetAllForPr(db, identityPrKey)
  // anchor "path|line|side" -> Map<n, body> of identity drafts present there
  const occupied = new Map<string, Map<number, string>>()
  for (const { value } of identityEntries) {
    const n = value.n ?? 0
    const anchor = `${value.path}|${value.line}|${value.side}`
    let slots = occupied.get(anchor)
    if (!slots) { slots = new Map(); occupied.set(anchor, slots) }
    slots.set(n, value.body)
  }

  // Oldest-first so de-dup keeps deterministic ordering.
  sources.sort((a, b) => (a.value.updatedAt ?? 0) - (b.value.updatedAt ?? 0))

  for (const src of sources) {
    const path = src.value.path
    const line = src.value.line
    const side = src.value.side
    const body = src.value.body
    const startLine = (src.value.startLine != null && src.value.startLine < line) ? src.value.startLine : undefined
    const anchor = `${path}|${line}|${side}`
    let slots = occupied.get(anchor)
    if (!slots) { slots = new Map(); occupied.set(anchor, slots) }

    // Identical-body short-circuit (idempotency / duplicate across shas):
    // if any occupied slot at this anchor already holds this exact body, the
    // draft is already represented — just delete the source.
    let alreadyPresent = false
    for (const existingBody of slots.values()) {
      if (existingBody === body) { alreadyPresent = true; break }
    }
    if (alreadyPresent) {
      await idbDelete(db, src.sourceKey)
      continue
    }

    // Choose n: prefer the source's own n if that slot is free; else append.
    const srcN = src.value.n ?? 0
    let n = srcN
    if (slots.has(n)) {
      let next = 0
      while (slots.has(next)) next++
      n = next
    }

    const record: Draft = {
      path,
      line,
      side,
      body,
      prKey: identityPrKey,
      n,
      // Timestamps are PRESERVED verbatim — including their absence. A legacy
      // draft without createdAt/updatedAt keeps rendering as "earlier session";
      // fabricating times here would lie about the draft's age.
      ...(src.value.createdAt != null ? { createdAt: src.value.createdAt } : {}),
      ...(src.value.updatedAt != null ? { updatedAt: src.value.updatedAt } : {}),
      ...(startLine != null ? { startLine } : {}),
      ...(src.sourceSha ? { headSha: src.sourceSha } : {}),
      // AI-attribution fields ride along with the value during re-keying.
      ...(src.value.aiAuthored ? { aiAuthored: true } : {}),
      ...(src.value.aiReviewer != null ? { aiReviewer: src.value.aiReviewer } : {}),
    }
    const targetKey = draftKey({ prKey: identityPrKey, path, line, side, n })
    await idbPut(db, targetKey, record) // adopt
    slots.set(n, body)
    await idbDelete(db, src.sourceKey) // ...then delete source (lossless)
  }
}

// ---------------------------------------------------------------------------
// createDraftStore
// ---------------------------------------------------------------------------

/**
 * Creates a reactive draft store bound to a single PR IDENTITY key.
 *
 * @param prKey    - the PR identity: "provider:owner/repo#number" (NO head sha)
 * @param dbName   - override the DB name (useful in tests for isolation)
 * @param makerSha - the CURRENT head sha; stamped onto newly upserted drafts as
 *                   `headSha` so each draft records the commit it was made on.
 *                   Optional (undefined for the demo route / older callers).
 */
export function createDraftStore(prKey: string, dbName = 'review123-drafts', makerSha?: string) {
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

      // Re-key migration (lossless + idempotent): adopt any drafts stored under a
      // LEGACY `@sha`-keyed prKey for THIS PR identity into the identity key,
      // tagging each with the source commit's sha. Runs before reading so the
      // store loads every commit's drafts under one identity. See plan doc
      // 2026-06-16-review123-draft-rekey.md.
      await migrateLegacyShaKeysToIdentity(db, prKey)

      // Read the identity range (plus legacy 4-part key fixing, as before).
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
      // Only store startLine when it forms a real range (< line)
      const startLine = (d.startLine != null && d.startLine < d.line) ? d.startLine : undefined
      // createdAt: stamped once at creation; a body edit PRESERVES the original
      // (including its absence on pre-timestamp drafts — never backfilled, so
      // "earlier session" stays honest). updatedAt tracks the last body write.
      const existingIdx = drafts.findIndex((x) => draftKey(x) === key)
      const createdAt = existingIdx >= 0 ? drafts[existingIdx].createdAt : Date.now()
      const record: Draft = { path: d.path, line: d.line, side: d.side, body: d.body, prKey, n, updatedAt: Date.now(), ...(createdAt != null ? { createdAt } : {}), ...(startLine != null ? { startLine } : {}), ...(makerSha ? { headSha: makerSha } : {}), ...(d.aiAuthored ? { aiAuthored: true } : {}), ...(d.aiReviewer != null ? { aiReviewer: d.aiReviewer } : {}) }

      // Update in-memory state (last-write-wins: replace existing if same key)
      const idx = existingIdx
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

// ---------------------------------------------------------------------------
// Cross-PR draft enumeration (for the landing "In-flight reviews" section)
// ---------------------------------------------------------------------------

/** Open the shared drafts DB, returning null when IndexedDB is unavailable. */
async function openSharedDb(dbName: string): Promise<IDBDatabase | null> {
  if (typeof (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB === 'undefined') {
    return null
  }
  try {
    return await openDb(dbName)
  } catch {
    return null
  }
}

/**
 * Enumerate every prKey that has drafts, returning one summary per prKey.
 *
 * Cursors the whole object store, groups raw draft keys by their prKey segment
 * (everything before the first '|'), and rolls each group up into a count and a
 * most-recent updatedAt. SHA variants of the same PR remain SEPARATE summaries
 * here — the landing layer groups them by PR identity.
 *
 * Returns [] when IndexedDB is unavailable (in-memory fallback has no cross-PR
 * visibility, by design).
 */
export async function listDraftSummaries(dbName = 'review123-drafts'): Promise<DraftSummary[]> {
  const db = await openSharedDb(dbName)
  if (!db) return []

  type Acc = { count: number; lastUpdatedAt: number }
  const byPrKey = new Map<string, Acc>()

  const tx = db.transaction(STORE_NAME, 'readonly')
  const store = tx.objectStore(STORE_NAME)
  await new Promise<void>((resolve, reject) => {
    const req = store.openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        const rawKey = cursor.key as string
        const pipeIdx = rawKey.indexOf('|')
        const prKey = pipeIdx === -1 ? rawKey : rawKey.slice(0, pipeIdx)
        const value = cursor.value as Draft
        const updatedAt = typeof value?.updatedAt === 'number' ? value.updatedAt : 0
        const existing = byPrKey.get(prKey)
        if (existing) {
          existing.count += 1
          if (updatedAt > existing.lastUpdatedAt) existing.lastUpdatedAt = updatedAt
        } else {
          byPrKey.set(prKey, { count: 1, lastUpdatedAt: updatedAt })
        }
        cursor.continue()
      } else {
        resolve()
      }
    }
    req.onerror = () => reject(req.error)
  })

  const summaries: DraftSummary[] = []
  for (const [prKey, acc] of byPrKey) {
    const parsed = parsePrKey(prKey)
    if (!parsed) continue
    summaries.push({
      prKey,
      provider: parsed.provider,
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
      headSha: parsed.headSha,
      draftCount: acc.count,
      lastUpdatedAt: acc.lastUpdatedAt,
    })
  }
  return summaries
}

/**
 * Delete every draft under a single prKey (all path/line/side/n records).
 * Reuses idbClearRange. No-op when IndexedDB is unavailable.
 */
export async function clearDraftsForPr(prKey: string, dbName = 'review123-drafts'): Promise<void> {
  const db = await openSharedDb(dbName)
  if (!db) return
  await idbClearRange(db, prKey)
}

/**
 * Delete every draft under a single prKey. Alias of clearDraftsForPr with the
 * lifecycle-management name — one implementation, two entry points.
 *
 * NOTE: this operates on DISK only. When a live createDraftStore instance
 * exists for the prKey, call store.clearAll() instead so the reactive in-memory
 * array updates too.
 */
export function clearAllDrafts(prKey: string, dbName = 'review123-drafts'): Promise<void> {
  return clearDraftsForPr(prKey, dbName)
}

/**
 * Delete only the STALE drafts under a prKey — those whose file is no longer
 * in the PR's current diff (see isStaleDraft). Non-stale drafts are untouched.
 * Returns how many drafts were removed. No-op (0) when IndexedDB is
 * unavailable or `files` is empty (no file list to judge against).
 *
 * Same disk-only caveat as clearAllDrafts: with a live store, prefer removing
 * the stale drafts through the store so the UI updates reactively.
 */
export async function clearStaleDrafts(
  prKey: string,
  files: readonly Pick<PrFile, 'filename'>[],
  headSha?: string,
  dbName = 'review123-drafts',
): Promise<number> {
  const db = await openSharedDb(dbName)
  if (!db || files.length === 0) return 0

  const entries = await idbGetAllForPr(db, prKey)
  let removed = 0
  for (const { key, value } of entries) {
    if (isStaleDraft(value, files, headSha).stale) {
      await idbDelete(db, key)
      removed++
    }
  }
  return removed
}
