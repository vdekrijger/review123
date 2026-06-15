/**
 * src/lib/eval/decisions.ts — local accept/dismiss decision store.
 *
 * Closes the accept/dismiss telemetry loop's DURABLE half: every time the user
 * ACCEPTS ('Add as draft') or DISMISSES an AI finding, we persist that outcome
 * locally (per-browser, like drafts) keyed by the PR + the finding's identity.
 * This is the ground-truth the eval `capture` flow reads to PRE-LABEL a captured
 * golden case (accepted → "real", dismissed → "noise").
 *
 * PRIVACY: a decision row holds the finding KEY/anchor needed to re-match the
 * finding at capture time (skillId, path, line) plus ids/enums/counts. It holds
 * NO finding body text, no code, no diff — only what is needed to re-identify the
 * finding when scaffolding a case. The analytics events (analytics.ts) are even
 * stricter (ids/enums/counts only, no key/anchor).
 *
 * Storage: IndexedDB (DB 'review123-decisions', store 'decisions'), with a pure
 * in-memory fallback when IndexedDB is unavailable (mirrors the drafts store).
 * Key: `${prKey}|${findingKey}`.
 *
 * SIZE BOUND: the store keeps decisions for at most MAX_PRS distinct PRs. When a
 * decision is recorded for a NEW prKey beyond that bound, the least-recently-
 * touched PR's decisions are pruned. This keeps the store small without manual
 * cleanup.
 */

export type FindingDecision = 'accepted' | 'dismissed'

/** Verification context carried on a decision (ids/enums/counts only). */
export interface DecisionVerificationContext {
  deep: boolean
  crossVerified: boolean
  confirmedBy: number
  polledModels: number
  fusionMode?: 'verify' | 'generate'
  raisedByCount: number
}

/** One persisted accept/dismiss outcome for a single finding. */
export interface DecisionRecord {
  /** The PR this decision belongs to (provider:owner/repo#number@sha or legacy). */
  prKey: string
  /**
   * The finding's stable key/anchor — the SAME key the SkillFindingCard emits as
   * data-finding-key (`${skillId}:${path}:${line}:${body.slice(0,30)}`). Used to
   * re-match the finding when scaffolding an eval case. No standalone body text.
   */
  findingKey: string
  decision: FindingDecision
  severity: 'high' | 'medium' | 'low'
  /** ids/enums/counts re-derivable from the finding — no content. */
  verificationContext: DecisionVerificationContext
  /** When the decision was recorded (ms epoch). */
  at: number
}

export function decisionStoreKey(prKey: string, findingKey: string): string {
  return `${prKey}|${findingKey}`
}

/**
 * The content-bearing TAIL of a finding key: `${path}:${line}:${body.slice(0,30)}`.
 * A finding key is `${skillId}:${path}:${line}:${bodyPrefix}` (see SkillFindingCard).
 * The capture flow re-matches a live finding to a recorded decision WITHOUT
 * knowing the runtime skillId (the live reviewer name differs), so it compares on
 * this skillId-independent tail. Derives the tail from a finding's path/line/body.
 */
export function findingMatchTail(path: string, line: number | null, body: string): string {
  return `${path}:${line}:${body.slice(0, 30)}`
}

/** The match tail of a stored decision's findingKey (strips the leading skillId). */
export function decisionMatchTail(findingKey: string): string {
  // findingKey = `${skillId}:${path}:${line}:${bodyPrefix}`. The skillId never
  // contains ':' (it's a slug / 'builtin:<name>' uses ':' — handle below), so we
  // can't blindly split. Instead, the tail is everything that re-matches a
  // captured finding: we reconstruct it from the path:line:bodyPrefix shape by
  // dropping the FIRST segment (the skillId). 'builtin:<name>' skillIds contain a
  // ':', so we additionally tolerate a two-segment skillId prefix.
  const parts = findingKey.split(':')
  // A valid tail is path:line:bodyPrefix → at least 3 trailing segments. The
  // leading 1-or-2 segments are the skillId.
  if (parts.length <= 3) return findingKey
  // Drop the skillId. 'builtin:x' → drop 2; otherwise drop 1. We detect builtin
  // by the literal first segment.
  const drop = parts[0] === 'builtin' ? 2 : 1
  return parts.slice(drop).join(':')
}

/**
 * Build a label lookup from recorded decisions: match-tail → 'accepted'|'dismissed'.
 * The capture flow consults this to PRE-LABEL each captured finding. Last write
 * per tail wins (the store already de-dupes by key, but two reviewers could
 * surface the same finding — newest decision wins).
 */
export function decisionLabelsByTail(records: DecisionRecord[]): Map<string, FindingDecision> {
  const byTail = new Map<string, { decision: FindingDecision; at: number }>()
  for (const r of records) {
    const tail = decisionMatchTail(r.findingKey)
    const prev = byTail.get(tail)
    if (!prev || r.at > prev.at) byTail.set(tail, { decision: r.decision, at: r.at })
  }
  const out = new Map<string, FindingDecision>()
  for (const [tail, v] of byTail) out.set(tail, v.decision)
  return out
}

// ---------------------------------------------------------------------------
// Tiny promisified IndexedDB helper (mirrors drafts.svelte.ts)
// ---------------------------------------------------------------------------

const DB_VERSION = 1
const STORE_NAME = 'decisions'
/** Keep decisions for at most this many distinct PRs (LRU-pruned). */
export const MAX_PRS = 50

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function hasIdb(): boolean {
  return typeof (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB !== 'undefined'
}

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB.open(dbName, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME) // out-of-line key (we supply it)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('IDB open blocked'))
  })
}

async function idbGetAll(db: IDBDatabase): Promise<{ key: string; value: DecisionRecord }[]> {
  const tx = db.transaction(STORE_NAME, 'readonly')
  const store = tx.objectStore(STORE_NAME)
  return new Promise((resolve, reject) => {
    const results: { key: string; value: DecisionRecord }[] = []
    const req = store.openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        results.push({ key: cursor.key as string, value: cursor.value as DecisionRecord })
        cursor.continue()
      } else {
        resolve(results)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

async function idbGetForPr(db: IDBDatabase, prKey: string): Promise<DecisionRecord[]> {
  const lower = `${prKey}|`
  const upper = `${prKey}|￿`
  const range = IDBKeyRange.bound(lower, upper)
  const tx = db.transaction(STORE_NAME, 'readonly')
  const store = tx.objectStore(STORE_NAME)
  return new Promise((resolve, reject) => {
    const out: DecisionRecord[] = []
    const req = store.openCursor(range)
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        out.push(cursor.value as DecisionRecord)
        cursor.continue()
      } else {
        resolve(out)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

async function idbPut(db: IDBDatabase, key: string, value: DecisionRecord): Promise<void> {
  const tx = db.transaction(STORE_NAME, 'readwrite')
  await idbRequest(tx.objectStore(STORE_NAME).put(value, key))
}

async function idbClearRange(db: IDBDatabase, prKey: string): Promise<void> {
  const lower = `${prKey}|`
  const upper = `${prKey}|￿`
  const range = IDBKeyRange.bound(lower, upper)
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.objectStore(STORE_NAME)
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

async function openShared(dbName: string): Promise<IDBDatabase | null> {
  if (!hasIdb()) return null
  try {
    return await openDb(dbName)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// LRU pruning — bound to MAX_PRS distinct PRs by most-recent decision time
// ---------------------------------------------------------------------------

/**
 * Decide which prKeys to evict so that at most MAX_PRS remain. Pure: given the
 * existing records + the prKey that's about to be touched, returns the set of
 * prKeys whose decisions should be deleted. The touched prKey is never evicted.
 */
export function prKeysToPrune(
  records: DecisionRecord[],
  touchedPrKey: string,
  now: number,
  maxPrs = MAX_PRS,
): string[] {
  // Most-recent decision time per prKey (the touched PR counts as `now`).
  const lastSeen = new Map<string, number>()
  for (const r of records) {
    const prev = lastSeen.get(r.prKey) ?? 0
    if (r.at > prev) lastSeen.set(r.prKey, r.at)
  }
  lastSeen.set(touchedPrKey, now)

  if (lastSeen.size <= maxPrs) return []

  // Oldest first; keep the newest maxPrs, prune the rest. Never prune touched.
  const sorted = [...lastSeen.entries()].sort((a, b) => a[1] - b[1])
  const evictCount = lastSeen.size - maxPrs
  const evict: string[] = []
  for (const [prKey] of sorted) {
    if (evict.length >= evictCount) break
    if (prKey === touchedPrKey) continue
    evict.push(prKey)
  }
  return evict
}

// ---------------------------------------------------------------------------
// createDecisionStore — bound to a single PR key (mirrors createDraftStore)
// ---------------------------------------------------------------------------

export function createDecisionStore(prKey: string, dbName = 'review123-decisions') {
  let dbPromise: Promise<IDBDatabase | null> | null = null
  // In-memory mirror of THIS PR's decisions (always kept in sync; the source of
  // truth for reads in fallback mode).
  const memory = new Map<string, DecisionRecord>()
  let persistent = true

  function getDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise
    if (!hasIdb()) {
      persistent = false
      dbPromise = Promise.resolve(null)
      return dbPromise
    }
    dbPromise = openDb(dbName)
      .then((db) => db)
      .catch(() => { persistent = false; return null })
    return dbPromise
  }

  return {
    get persistent() { return persistent },

    /** Load this PR's decisions from disk into the in-memory mirror. */
    async load(): Promise<void> {
      const db = await getDb()
      if (!db) return
      const rows = await idbGetForPr(db, prKey)
      memory.clear()
      for (const r of rows) memory.set(r.findingKey, r)
    },

    /**
     * Record (upsert) an accept/dismiss outcome for one finding. Last write
     * wins, so a user who dismisses then accepts ends with 'accepted'. Prunes
     * the store to MAX_PRS distinct PRs (LRU) on each write.
     */
    async record(input: {
      findingKey: string
      decision: FindingDecision
      severity: 'high' | 'medium' | 'low'
      verificationContext: DecisionVerificationContext
    }): Promise<void> {
      const record: DecisionRecord = {
        prKey,
        findingKey: input.findingKey,
        decision: input.decision,
        severity: input.severity,
        verificationContext: input.verificationContext,
        at: Date.now(),
      }
      memory.set(record.findingKey, record)

      const db = await getDb()
      if (!db) return
      await idbPut(db, decisionStoreKey(prKey, record.findingKey), record)

      // LRU prune across ALL PRs.
      const all = await idbGetAll(db)
      const evict = prKeysToPrune(all.map((e) => e.value), prKey, record.at)
      for (const stalePrKey of evict) await idbClearRange(db, stalePrKey)
    },

    /** This PR's recorded decisions, keyed by findingKey (in-memory mirror). */
    list(): DecisionRecord[] {
      return [...memory.values()]
    },

    /** The decision for a single finding key, or null. */
    get(findingKey: string): DecisionRecord | null {
      return memory.get(findingKey) ?? null
    },

    /** Forget all decisions for this PR (the drafts-discard counterpart). */
    async clearAll(): Promise<void> {
      memory.clear()
      const db = await getDb()
      if (db) await idbClearRange(db, prKey)
    },
  }
}

// ---------------------------------------------------------------------------
// Cross-PR read — for the eval capture tool (Node, via Vite SSR import)
// ---------------------------------------------------------------------------

/**
 * Read every recorded decision for a single prKey. Used by the capture flow to
 * auto-label a golden case. Returns [] when IndexedDB is unavailable (the
 * capture CLI runs in Node — it will receive decisions injected explicitly, not
 * via IDB — but this keeps the API symmetric and testable).
 */
export async function readDecisionsForPr(
  prKey: string,
  dbName = 'review123-decisions',
): Promise<DecisionRecord[]> {
  const db = await openShared(dbName)
  if (!db) return []
  return idbGetForPr(db, prKey)
}
