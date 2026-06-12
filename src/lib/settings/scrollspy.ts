/**
 * scrollspy.ts
 *
 * Scrollspy logic for the /settings page section nav.
 *
 * The selection rule is kept as a pure function (pickActiveSection) so it
 * can be unit-tested without a real browser: pick the last section (in
 * document order) whose top edge is at or above the viewport midline.
 * Two edge cases are handled explicitly:
 *  - scroll top: while the FIRST section's top edge is still at or below
 *    the viewport top (the page header above it is in view), the user is
 *    reading the first section — the midline rule must not skip ahead to
 *    a later section whose top already sits above the midline (the
 *    classic top-edge bug: a short first section under a tall page
 *    header). This geometric check needs no scrollY, so it cannot be
 *    fooled by a scroll-container vs window mismatch;
 *  - page bottom: a short last section may never reach the midline (the
 *    classic scrollspy bottom bug), so when the page is scrolled to the
 *    bottom the last section is forced active.
 *
 * observeSections is the injectable browser-API seam: jsdom has no
 * IntersectionObserver, so the function degrades to a no-op there and
 * component tests mock the module instead (same pattern as the
 * matchMedia / applyAppearance seams elsewhere in the repo).
 */

export interface SectionPosition {
  /** Section element id (matches the nav anchor target). */
  id: string
  /** Top edge of the section, in px relative to the viewport top. */
  top: number
}

/**
 * Pick the active section id for the current scroll position.
 *
 * @param sections section positions in document order
 * @param viewportHeight current viewport height in px
 * @param atBottom whether the page is scrolled to the very bottom
 */
export function pickActiveSection(
  sections: readonly SectionPosition[],
  viewportHeight: number,
  atBottom = false,
): string | null {
  if (sections.length === 0) return null
  // Top edge first: while the first section's top edge has not scrolled
  // past the viewport top, the user is at (or near) the very top of the
  // page reading the first section. Checked BEFORE atBottom so a page
  // that fits the viewport (top and bottom at once) starts on the first
  // section, where reading starts.
  if (sections[0].top >= 0) return sections[0].id
  if (atBottom) return sections[sections.length - 1].id
  const midline = viewportHeight / 2
  let active = sections[0].id
  for (const s of sections) {
    if (s.top <= midline) active = s.id
  }
  return active
}

/**
 * True when the viewport has reached the bottom of the document.
 * The epsilon absorbs sub-pixel rounding of scrollY on HiDPI displays.
 * A documentHeight of 0 (jsdom) is treated as "unknown", never "bottom".
 */
export function isAtBottom(
  scrollY: number,
  viewportHeight: number,
  documentHeight: number,
  epsilon = 2,
): boolean {
  if (documentHeight <= 0) return false
  return scrollY + viewportHeight >= documentHeight - epsilon
}

/**
 * Observe the given section elements with an IntersectionObserver and
 * invoke onChange whenever any of them crosses a visibility threshold.
 * Returns a cleanup function that disconnects the observer.
 *
 * Browser-API seam: in environments without IntersectionObserver
 * (jsdom) this is a no-op and the returned cleanup does nothing.
 */
export function observeSections(elements: readonly Element[], onChange: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => {}
  const observer = new IntersectionObserver(() => onChange(), {
    // Multiple thresholds so the callback fires often enough while a
    // section scrolls through the viewport for midline tracking.
    threshold: [0, 0.25, 0.5, 0.75, 1],
  })
  for (const el of elements) observer.observe(el)
  return () => observer.disconnect()
}
