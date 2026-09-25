/**
 * src/lib/guide/botThreadsPref.svelte.ts — the switch that EXCLUDES review-bot
 * comment threads from the diff.
 *
 * Storage: localStorage `review123:hide-bot-comments`
 * Schema:  { hidden: boolean }
 * Default: HIDDEN (absent / invalid entries read as hidden)
 *
 * Why hidden by default, in the user's own words: "these bot comments are quite
 * noisy and distracting during a review with no way to hide or filter them
 * out". The screenshot that prompted it had ONE line of code carrying a bot
 * finding, two resolved threads, two more bot comments and two of their own
 * replies — a screen and a half of chrome over one line. They were offered
 * three shapes (collapse, filter chip, hidden-by-default) and chose hidden by
 * default with one click to reveal.
 *
 * Nothing is hidden SILENTLY, which is this codebase's standing rule (the
 * findings-triage "Showing K of M · N collapsed" line, the mechanical tail's
 * "N low-attention files", the whitespace toggle's "N whitespace-only files
 * hidden", and #272's own resolved-thread count). The count is stated in the
 * Inspect toolbar AND again at every place threads were removed from, each with
 * a one-click reveal.
 *
 * THIS IS A READING PREFERENCE, AND ONLY THAT. #285 made review-bot comments
 * candidates for the fixing agent, and AgentFixPanel builds that list from the
 * PULL REQUEST (loadBotComments → provider.getComments), never from what the
 * diff chose to render. Nothing in this module is imported there, and nothing
 * should be: a reading preference that quietly disabled a fixing feature would
 * take away a class of findings with no indication why. The toolbar note says
 * so out loud, because the reader is otherwise left to work out why the panel
 * offers comments the diff does not show.
 *
 * Deliberately a sibling of src/lib/guide/resolvedThreadsPref.svelte.ts rather
 * than a generalisation of it. The two filters answer different questions —
 * "is this conversation finished?" and "did a person write it?" — they are
 * independently togglable, and #272's file is the shape this one follows
 * exactly: same localStorage idiom, same reactive holder, same test reset hook.
 * That is also why FileDiff needs no new props and Story mode follows for free.
 */

const KEY = 'review123:hide-bot-comments'

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

/** Whether review-bot threads are excluded from the diff. Defaults to true. */
export function getHideBotThreads(): boolean {
  return read()
}

const holder = $state<{ hidden: boolean }>({ hidden: read() })

/** Reactive view of the preference — read `.hidden` inside components. */
export const botThreadsPref = {
  get hidden(): boolean {
    return holder.hidden
  },
}

/** Persist + publish the preference. */
export function setHideBotThreads(hidden: boolean): void {
  holder.hidden = hidden
  try {
    localStorage.setItem(KEY, JSON.stringify({ hidden }))
  } catch {
    // localStorage unavailable — the in-memory holder still drives this session
  }
}

/** Flip the preference (toolbar button). */
export function toggleHideBotThreads(): boolean {
  setHideBotThreads(!holder.hidden)
  return holder.hidden
}

/**
 * FOR TESTS ONLY: re-read module-level state so each test starts clean.
 * Call in beforeEach alongside localStorage.clear().
 */
export function _resetBotThreadsPrefForTest(): void {
  holder.hidden = read()
}
