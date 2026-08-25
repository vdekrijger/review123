/**
 * src/lib/guide/sortPref.ts — per-browser Files-mode sort preference.
 *
 * Storage: localStorage `review123:inspect-sort`
 * Schema:  { order: 'narrative' | 'risk' }
 * Default: 'narrative' (absent / invalid entries read as narrative — the
 *          current Files-mode order stays the default, unchanged)
 *
 * Mirrors the rail-collapse pattern (src/lib/rail/collapse.ts): this is
 * per-browser UI state (like visits/viewed), NOT a settings.ts field.
 */

const KEY = 'review123:inspect-sort'

export type InspectSort = 'narrative' | 'risk'

/** The persisted Files-mode sort order. Defaults to 'narrative'. */
export function getInspectSort(): InspectSort {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return 'narrative'
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'narrative'
    return (parsed as Record<string, unknown>)['order'] === 'risk' ? 'risk' : 'narrative'
  } catch {
    return 'narrative'
  }
}

/** Persist the Files-mode sort order. */
export function setInspectSort(order: InspectSort): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ order }))
  } catch {
    // localStorage unavailable — silently ignore
  }
}
