/**
 * src/lib/tree/diffColHeight.ts — keeps the file-tree drawer no taller than
 * the diff column it accompanies.
 *
 * Problem: the open .file-tree-nav was clamped only to the viewport
 * (max-height: calc(100vh - 5rem)), so with a SHORT diff and a LONG tree the
 * drawer extended well below the end of the diff column.
 *
 * Pure CSS cannot read a sibling's height, so a ResizeObserver on the diff
 * column writes its current height into the `--diff-col-h` custom property on
 * the .inspect-layout container. The nav's CSS then clamps itself to
 *
 *   max-height: min(calc(100vh - 5rem), max(12rem, var(--diff-col-h, 100vh)))
 *
 * i.e. min(viewport cap, diff column height) with a 12rem floor — a tree
 * squashed to three rows is worse than a slight overhang on a tiny diff.
 *
 * Design notes (PR #59 follow-up):
 * - PR #59's margin-vs-inline drawer decision stays PURE CSS — no viewport
 *   resize listener exists and none is added here. This observer watches
 *   CONTENT height (the diff column element, never the window), which CSS
 *   cannot express; it is a different, justified mechanism.
 * - Observer callbacks are rAF-throttled: expand/collapse churn inside the
 *   diff column coalesces into one style write per frame.
 * - jsdom has no ResizeObserver: the constructor is injectable and defaults
 *   to globalThis.ResizeObserver, no-oping when absent.
 */

/** Custom property written on .inspect-layout, read by .file-tree-nav CSS. */
export const DIFF_COL_H_VAR = '--diff-col-h'

type ResizeObserverLike = Pick<ResizeObserver, 'observe' | 'disconnect'>
type ResizeObserverCtor = new (callback: () => void) => ResizeObserverLike

function defaultObserverCtor(): ResizeObserverCtor | undefined {
  return typeof ResizeObserver === 'undefined' ? undefined : ResizeObserver
}

/**
 * Observe `diffCol`'s height and mirror it into `--diff-col-h` on `layout`.
 * Returns a cleanup function (disconnects the observer, cancels any pending
 * frame, removes the property). Safe to call in environments without
 * ResizeObserver — it becomes a no-op.
 */
export function observeDiffColHeight(
  diffCol: HTMLElement,
  layout: HTMLElement,
  Observer: ResizeObserverCtor | undefined = defaultObserverCtor(),
): () => void {
  if (!Observer) return () => {}

  const write = (): void => {
    const h = Math.round(diffCol.getBoundingClientRect().height)
    layout.style.setProperty(DIFF_COL_H_VAR, `${h}px`)
  }

  let rafId: number | null = null
  const schedule = (): void => {
    if (rafId !== null) return // a write is already queued for this frame
    rafId = requestAnimationFrame(() => {
      rafId = null
      write()
    })
  }

  const observer = new Observer(schedule)
  observer.observe(diffCol)
  // Initial value synchronously — the first paint is already clamped.
  write()

  return () => {
    if (rafId !== null) cancelAnimationFrame(rafId)
    observer.disconnect()
    layout.style.removeProperty(DIFF_COL_H_VAR)
  }
}
