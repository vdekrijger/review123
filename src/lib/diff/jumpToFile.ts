/**
 * jumpToFile — shared "jump to a file's diff card" behaviour.
 *
 * Used by BOTH:
 *   • InspectStep's file-tree drawer (click a file → scroll to its card), and
 *   • Review's hotspot/evidence/test-flag chips (rail + Understand step) which
 *     may first need an SPA navigation to the Inspect step.
 *
 * The scroll/expand mechanism is the file-tree one extracted verbatim:
 * smooth-scroll the `#file-<slug>` wrapper into view and, if the card inside
 * is collapsed (marked viewed), click its header to expand it.
 *
 * Navigation is delegated to the caller via `navigateToInspect` — Review wires
 * it to the SPA router (history.pushState), NEVER location.href, so jumping
 * from the Understand/Verdict steps is a soft navigation with no page reload.
 */
import { slugify } from '../slug'

/**
 * Max animation frames to wait for the target card to appear. When the jump
 * triggers a step switch the Inspect step mounts asynchronously; a few frames
 * cover mount + first paint without ever blocking (gives up silently after).
 */
const MAX_FRAMES = 30

/** Find the card wrapper; scroll + expand it. Returns true when found. */
function tryScrollToCard(path: string): boolean {
  const wrapper = document.getElementById(`file-${slugify(path)}`)
  if (!wrapper) return false
  wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' })
  // If the article inside is collapsed (viewed), click its header to expand
  const article = wrapper.querySelector('article.file-diff.is-collapsed')
  if (article) {
    const header = article.querySelector('header') as HTMLElement | null
    header?.click()
  }
  return true
}

/**
 * Smooth-scroll the diff card for `path` into view, expanding it if collapsed.
 * Retries across animation frames (bounded) so it also works right after a
 * step switch while the Inspect step is still mounting.
 */
export function scrollToFileCard(path: string): void {
  if (tryScrollToCard(path)) return
  let attempts = 0
  const retry = () => {
    if (tryScrollToCard(path)) return
    attempts += 1
    if (attempts < MAX_FRAMES) requestAnimationFrame(retry)
  }
  requestAnimationFrame(retry)
}

/**
 * Max animation frames to wait for a specific finding card to appear. A finding
 * may live inside a collapsed file card (revealed only after we expand it) or in
 * a file that just mounted; a few frames cover expand + paint without blocking.
 */
const FINDING_MAX_FRAMES = 30

/** How long (ms) the flash highlight stays on a jumped-to finding card. */
const FINDING_FLASH_MS = 1500

/**
 * Scroll a single reviewer finding into view and briefly flash it.
 *
 * Findings render as `.skill-finding` cards tagged with `data-finding-key`,
 * whether inline at their diff line, in the per-file fallback block, or above
 * the file (file-level). We first jump to the OWNING file card (`path`) — that
 * scrolls the file into view AND expands it if it was collapsed (marked viewed),
 * which is what makes a hidden inline finding render at all — then, across a few
 * animation frames, locate the finding card by its key, scroll it into view and
 * add a transient `.finding-flash` class.
 *
 * Unanchorable findings (off-diff) still get a card in the file's fallback block,
 * so this resolves them too — never a dead jump.
 */
export function jumpToFinding(path: string, findingKey: string): void {
  // Expand + scroll the owning file first (reveals collapsed inline findings).
  scrollToFileCard(path)

  const selector = `[data-finding-key="${cssEscape(findingKey)}"]`
  let attempts = 0
  const tryFlash = (): boolean => {
    const el = document.querySelector(selector) as HTMLElement | null
    if (!el) return false
    // A secondary (triaged) finding lives inside a collapsed <details> group
    // (FileDiff's "N more findings"; risk-first's low-attention tail likewise) —
    // open every closed ancestor so the card is actually rendered before we
    // scroll to and flash it. The popover is a navigation surface for ALL
    // findings, so a jump must never dead-end on a closed group.
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p instanceof HTMLDetailsElement && !p.open) p.open = true
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('finding-flash')
    window.setTimeout(() => el.classList.remove('finding-flash'), FINDING_FLASH_MS)
    return true
  }
  if (tryFlash()) return
  const retry = () => {
    if (tryFlash()) return
    attempts += 1
    if (attempts < FINDING_MAX_FRAMES) requestAnimationFrame(retry)
  }
  requestAnimationFrame(retry)
}

/** CSS.escape with a minimal fallback for jsdom / older runtimes. */
function cssEscape(value: string): string {
  const cssApi = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS
  if (cssApi?.escape) return cssApi.escape(value)
  // Fallback: escape the characters that matter inside an attribute selector.
  return value.replace(/["\\]/g, '\\$&')
}

export interface JumpToFileDiffOptions {
  /** Whether the Inspect step (where diff cards live) is already active. */
  isInspectActive: boolean
  /** SPA navigation to the Inspect step (router pushState — never location.href). */
  navigateToInspect: () => void
}

/**
 * Jump to a file's diff card from anywhere in the review:
 * navigate to the Inspect step first when not already there (SPA router),
 * then scroll to / expand the card exactly like a file-tree click.
 */
export function jumpToFileDiff(path: string, opts: JumpToFileDiffOptions): void {
  if (!opts.isInspectActive) {
    opts.navigateToInspect()
  }
  scrollToFileCard(path)
}
