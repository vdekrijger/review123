/**
 * src/lib/guide/resolvedThreadsPref.svelte.ts — the switch that EXCLUDES
 * resolved comment threads from the diff.
 *
 * Storage: localStorage `review123:hide-resolved`
 * Schema:  { hidden: boolean }
 * Default: HIDDEN (absent / invalid entries read as hidden)
 *
 * Why hidden by default: a resolved thread is a finished conversation. On a
 * real PR the "General" block can be eight resolved threads deep, and even
 * collapsed to one line each they fill the viewport ahead of the unresolved
 * comments that still need an answer. Collapsing was not enough — the user
 * asked for them excluded.
 *
 * Nothing is hidden SILENTLY, which is this codebase's standing rule (the
 * findings-triage "Showing K of M · N collapsed" line, the mechanical tail's
 * "N low-attention files", the whitespace toggle's "N whitespace-only files
 * hidden"). The count is stated in the Inspect toolbar AND again at every
 * place threads were removed from, each with a one-click reveal.
 *
 * This is per-browser UI state, NOT a settings.ts field — the same idiom as
 * src/lib/guide/hunkAttentionPref.svelte.ts (`review123:hunk-attention`) and
 * src/lib/guide/sortPref.ts (`review123:inspect-sort`). It is a reading
 * preference about ONE screen, like the sort order and hunk focus.
 *
 * The reactive holder lets the InspectStep toolbar toggle and every mounted
 * FileDiff stay in sync without prop threading (mirrors hunkAttentionPref).
 */

const KEY = 'review123:hide-resolved'

function read(): boolean {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return true
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return true
    return (parsed as Record<string, unknown>)['hidden'] !== false
  } catch {
    return true
  }
}

/** Whether resolved threads are excluded from the diff. Defaults to true. */
export function getHideResolvedThreads(): boolean {
  return read()
}

const holder = $state<{ hidden: boolean }>({ hidden: read() })

/** Reactive view of the preference — read `.hidden` inside components. */
export const resolvedThreadsPref = {
  get hidden(): boolean {
    return holder.hidden
  },
}

/** Persist + publish the preference. */
export function setHideResolvedThreads(hidden: boolean): void {
  holder.hidden = hidden
  try {
    localStorage.setItem(KEY, JSON.stringify({ hidden }))
  } catch {
    // localStorage unavailable — the in-memory holder still drives this session
  }
}

/** Flip the preference (toolbar button). */
export function toggleHideResolvedThreads(): boolean {
  setHideResolvedThreads(!holder.hidden)
  return holder.hidden
}

/**
 * FOR TESTS ONLY: re-read module-level state so each test starts clean.
 * Call in beforeEach alongside localStorage.clear().
 */
export function _resetResolvedThreadsPrefForTest(): void {
  holder.hidden = read()
}
