/**
 * src/lib/guide/hunkAttentionPref.svelte.ts — the off switch for per-hunk
 * attention guidance (the "what changed" strip + the receded mechanical hunks).
 *
 * Storage: localStorage `review123:hunk-attention`
 * Schema:  { enabled: boolean }
 * Default: enabled (absent / invalid entries read as enabled)
 *
 * This is per-browser UI state, NOT a settings.ts field — the same idiom as
 * src/lib/guide/sortPref.ts (`review123:inspect-sort`) and the rail-collapse
 * store. Chosen deliberately: a parallel change owns the Settings surface, and
 * this preference is about how ONE screen reads, like the sort order.
 *
 * The reactive holder lets the InspectStep toolbar toggle and every mounted
 * FileDiff stay in sync without prop threading (mirrors settingsState.svelte).
 */

const KEY = 'review123:hunk-attention'

function read(): boolean {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return true
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return true
    return (parsed as Record<string, unknown>)['enabled'] !== false
  } catch {
    return true
  }
}

/** Whether per-hunk attention guidance is on. Defaults to true. */
export function getHunkAttentionEnabled(): boolean {
  return read()
}

const holder = $state<{ enabled: boolean }>({ enabled: read() })

/** Reactive view of the preference — read `.enabled` inside components. */
export const hunkAttentionPref = {
  get enabled(): boolean {
    return holder.enabled
  },
}

/** Persist + publish the preference. */
export function setHunkAttentionEnabled(enabled: boolean): void {
  holder.enabled = enabled
  try {
    localStorage.setItem(KEY, JSON.stringify({ enabled }))
  } catch {
    // localStorage unavailable — the in-memory holder still drives this session
  }
}

/** Flip the preference (toolbar button). */
export function toggleHunkAttention(): boolean {
  setHunkAttentionEnabled(!holder.enabled)
  return holder.enabled
}

/**
 * FOR TESTS ONLY: re-read module-level state so each test starts clean.
 * Call in beforeEach alongside localStorage.clear().
 */
export function _resetHunkAttentionPrefForTest(): void {
  holder.enabled = read()
}
