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
