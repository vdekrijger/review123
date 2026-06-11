/**
 * src/lib/viewed/viewed.svelte.ts — per-file viewed state with patch-hash tracking.
 *
 * Storage: localStorage `review123:viewed`
 * Schema:  { [prId: string]: { path: string; patchHash: string; viewedAt: number }[] }
 * prId:    "owner/repo#number"  (NO sha — survives force-pushes)
 * Cap:     50 PRs LRU (evict by oldest max-viewedAt)
 */

const KEY = 'review123:viewed'
const MAX_PRS = 50

// ---------------------------------------------------------------------------
// djb2 hash — exported and tested with known vectors
// ---------------------------------------------------------------------------

/** djb2 hash of a string — returns lowercase hex string. */
export function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    // h * 33 + c  (bitwise keeps within 32-bit range)
    h = ((h << 5) + h) ^ s.charCodeAt(i)
    h = h >>> 0 // convert to unsigned 32-bit
  }
  return h.toString(16)
}

// ---------------------------------------------------------------------------
// Storage types
// ---------------------------------------------------------------------------

export interface ViewedEntry {
  path: string
  patchHash: string
  viewedAt: number
}

export type ViewedStore = Record<string, ViewedEntry[]>

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

function isValidEntry(raw: unknown): raw is ViewedEntry {
  if (typeof raw !== 'object' || raw === null) return false
  const obj = raw as Record<string, unknown>
  return (
    typeof obj['path'] === 'string' &&
    typeof obj['patchHash'] === 'string' &&
    typeof obj['viewedAt'] === 'number'
  )
}

function readStore(): ViewedStore {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: ViewedStore = {}
    for (const [prId, entries] of Object.entries(parsed)) {
      if (!Array.isArray(entries)) continue
      const valid = entries.filter(isValidEntry)
      if (valid.length > 0) result[prId] = valid
    }
    return result
  } catch {
    return {}
  }
}

function writeStore(store: ViewedStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // localStorage unavailable — silently ignore
  }
}

// ---------------------------------------------------------------------------
// LRU cap: keep at most MAX_PRS PRs (evict by oldest max-viewedAt)
// ---------------------------------------------------------------------------

function applyLruCap(store: ViewedStore): ViewedStore {
  const prIds = Object.keys(store)
  if (prIds.length <= MAX_PRS) return store

  // Score each PR by its most recent viewedAt
  const scored = prIds.map((prId) => {
    const maxViewedAt = Math.max(...store[prId].map((e) => e.viewedAt))
    return { prId, maxViewedAt }
  })
  // Sort most-recent first; drop the tail
  scored.sort((a, b) => b.maxViewedAt - a.maxViewedAt)
  const keep = new Set(scored.slice(0, MAX_PRS).map((s) => s.prId))
  const result: ViewedStore = {}
  for (const prId of prIds) {
    if (keep.has(prId)) result[prId] = store[prId]
  }
  return result
}

// ---------------------------------------------------------------------------
// createViewedStore — reactive Svelte 5 store
// ---------------------------------------------------------------------------

export function createViewedStore(prId: string) {
  // Reactive state: entries for this PR only
  let entries = $state<ViewedEntry[]>(readStore()[prId] ?? [])

  function persist(updated: ViewedEntry[]): void {
    let store = readStore()
    store[prId] = updated
    store = applyLruCap(store)
    writeStore(store)
    // Re-read just this PR's entries in case LRU evicted us (very unlikely but safe)
    entries = store[prId] ?? []
  }

  return {
    /** True only when the stored patchHash === djb2(patch ?? '') */
    isViewed(path: string, patch: string | undefined): boolean {
      const hash = djb2(patch ?? '')
      return entries.some((e) => e.path === path && e.patchHash === hash)
    },

    /** Entry exists but hash differs (file was updated since marked viewed). */
    changedSinceViewed(path: string, patch: string | undefined): boolean {
      const entry = entries.find((e) => e.path === path)
      if (!entry) return false
      return entry.patchHash !== djb2(patch ?? '')
    },

    /** Toggle viewed state for a file. */
    toggle(path: string, patch: string | undefined): void {
      const hash = djb2(patch ?? '')
      const existingIdx = entries.findIndex((e) => e.path === path)
      let updated: ViewedEntry[]
      if (existingIdx >= 0 && entries[existingIdx].patchHash === hash) {
        // Already viewed with same hash → unmark
        updated = entries.filter((_, i) => i !== existingIdx)
      } else if (existingIdx >= 0) {
        // Entry exists with different hash → update hash + re-mark
        updated = entries.map((e, i) =>
          i === existingIdx ? { path, patchHash: hash, viewedAt: Date.now() } : e,
        )
      } else {
        // New entry
        updated = [...entries, { path, patchHash: hash, viewedAt: Date.now() }]
      }
      persist(updated)
    },

    /** Number of currently-viewed files (hash-matching). */
    get count(): number {
      return entries.filter((e) => {
        // We can only count based on the stored hashes — no patch at this level.
        // count reflects all stored entries (each was viewed with some hash).
        return true
      }).length
    },
  }
}
