/**
 * src/lib/visits/visits.ts — per-PR last-visit tracking.
 *
 * Storage: localStorage `review123:visits`
 * Schema:  { [prId: string]: { headSha: string; visitedAt: number } }
 * prId:    "owner/repo#number"
 * Cap:     50 PRs LRU (evict by oldest visitedAt)
 */

const KEY = 'review123:visits'
const MAX_ENTRIES = 50

export interface VisitEntry {
  headSha: string
  visitedAt: number
}

type VisitsStore = Record<string, VisitEntry>

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

function isValidEntry(raw: unknown): raw is VisitEntry {
  if (typeof raw !== 'object' || raw === null) return false
  const obj = raw as Record<string, unknown>
  return typeof obj['headSha'] === 'string' && typeof obj['visitedAt'] === 'number'
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function readStore(): VisitsStore {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: VisitsStore = {}
    for (const [prId, entry] of Object.entries(parsed)) {
      if (isValidEntry(entry)) result[prId] = entry
    }
    return result
  } catch {
    return {}
  }
}

function writeStore(store: VisitsStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // localStorage unavailable — silently ignore
  }
}

// ---------------------------------------------------------------------------
// LRU cap: keep at most MAX_ENTRIES PRs (evict by oldest visitedAt)
// ---------------------------------------------------------------------------

function applyLruCap(store: VisitsStore): VisitsStore {
  const prIds = Object.keys(store)
  if (prIds.length <= MAX_ENTRIES) return store

  const scored = prIds.map((prId) => ({ prId, visitedAt: store[prId].visitedAt }))
  scored.sort((a, b) => b.visitedAt - a.visitedAt)
  const keep = new Set(scored.slice(0, MAX_ENTRIES).map((s) => s.prId))

  const result: VisitsStore = {}
  for (const prId of prIds) {
    if (keep.has(prId)) result[prId] = store[prId]
  }
  return result
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a visit to a PR with the current headSha.
 * Call AFTER reading lastVisit so the caller can compare.
 */
export function recordVisit(prId: string, headSha: string): void {
  let store = readStore()
  store[prId] = { headSha, visitedAt: Date.now() }
  store = applyLruCap(store)
  writeStore(store)
}

/**
 * Return the last recorded visit for a PR, or null if never visited.
 */
export function lastVisit(prId: string): VisitEntry | null {
  const store = readStore()
  return store[prId] ?? null
}
