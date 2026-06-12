/**
 * src/lib/history/history.ts — recently reviewed PRs.
 *
 * Stores up to 10 recently reviewed PRs in localStorage under
 * 'review123:history'. Each entry records owner/repo/number/title/viewedAt.
 *
 * addToHistory deduplicates by owner+repo+number (moves to front on revisit).
 * getHistory reads and validates the stored array; corrupt entries are silently
 * dropped (shape-validated read, same pattern as settings.ts).
 */

const KEY = 'review123:history'
const MAX_ENTRIES = 10

export interface HistoryEntry {
  owner: string
  repo: string
  number: number
  title: string
  viewedAt: number // timestamp (ms since epoch)
  provider?: 'github' | 'gitlab' | 'bitbucket' // optional for backward compat
}

function isValidEntry(raw: unknown): raw is HistoryEntry {
  if (typeof raw !== 'object' || raw === null) return false
  const obj = raw as Record<string, unknown>
  return (
    typeof obj['owner'] === 'string' &&
    typeof obj['repo'] === 'string' &&
    typeof obj['number'] === 'number' &&
    typeof obj['title'] === 'string' &&
    typeof obj['viewedAt'] === 'number'
  )
}

/**
 * Read the history array from localStorage.
 * Returns [] when missing or corrupt; invalid individual entries are dropped.
 */
export function getHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidEntry)
  } catch {
    return []
  }
}

/**
 * Add a PR to the history list.
 *
 * - Deduplicates by owner+repo+number (moves existing entry to front)
 * - Updates viewedAt to now
 * - Caps the list at MAX_ENTRIES (10), dropping the oldest
 */
export function addToHistory(entry: Omit<HistoryEntry, 'viewedAt'>): void {
  const history = getHistory()
  // Remove any existing entry for this PR
  const filtered = history.filter(
    (e) => !(e.owner === entry.owner && e.repo === entry.repo && e.number === entry.number)
  )
  // Prepend the new entry (most recent first)
  const updated: HistoryEntry[] = [
    { ...entry, viewedAt: Date.now() },
    ...filtered,
  ].slice(0, MAX_ENTRIES)

  try {
    localStorage.setItem(KEY, JSON.stringify(updated))
  } catch {
    // localStorage unavailable — silently ignore
  }
}

/**
 * Clear the entire history list.
 */
export function clearHistory(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}
