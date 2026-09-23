/**
 * e2e/diff-density.spec.ts — side-by-side density, measured rather than argued.
 *
 * This is the gate that closes Phase 3's item 4. That item was deferred with a
 * hypothesis, from the audit: "side-by-side inherits the same padding as unified
 * at half the column width, so each pane's code sits tighter against its
 * gutter." Measured in the built app, the second half of that sentence is FALSE
 * — the distance from a line number to its own code is 38px in BOTH modes, to
 * the pixel, because every cell padding is literally the same declaration. What
 * actually differs is how much column is left for code afterwards, and that is a
 * WIDTH question, not a padding question. The decision recorded in
 * docs/design/ui-refactor-plan.md (Phase 3, item 4) is therefore "measured, not
 * changed", and this spec is what keeps that decision honest.
 *
 * Why an e2e spec for a no-op change: the padding lives in the VENDORED
 * package's Tailwind classes (`pl-[10px]`, `pl-[2.0em]`, `border-l-[1px]`), not
 * in anything this repo declares. Nothing in `src/` would fail if a dependency
 * upgrade re-tuned them, and nothing in `src/` would fail if someone "tightened"
 * split from diff-view-theme.css either. The relationships below are the ones
 * the rubric actually cares about, so they are the ones under test.
 *
 * Every assertion is a RELATIONSHIP, not a magic number — the point is that
 * split and unified share one density decision (rubric A1) and that the seam
 * between the two panes stays a group boundary (p.83, p.86, rubric A3), not that
 * any particular value is 10px.
 *
 * Route: /demo's Inspect step, the same deterministic fixture diff-palette uses.
 */

import { test, expect, type Page } from '@playwright/test'

type Mode = 'unified' | 'split'
type Width = 'centered' | 'full'

async function openInspect(page: Page, theme: 'light' | 'dark', diffMode: Mode, diffWidth: Width = 'centered') {
  await page.route('**/*posthog.com/**', (r) => r.abort())
  await page.route('**/us.i.posthog.com/**', (r) => r.abort())
  await page.addInitScript(
    (s) => localStorage.setItem('review123:settings', JSON.stringify(s)),
    { theme, diffMode, diffWidth, focusMode: 'imports', railCollapsed: true, deepseekKey: '' },
  )
  await page.goto('/demo')
  await page.getByRole('button', { name: /next step/i }).first().click()
  await page.locator('.diff-tailwindcss-wrapper').first().waitFor({ timeout: 20_000 })
  await expect(page.locator('tr.diff-line').first()).toBeVisible()
}

/**
 * Everything this spec reasons about, read out of the rendered page in one pass.
 *
 * `codeWidth` is the honest one: the content cell's width MINUS its own padding
 * MINUS the 2em inset that holds the +/- marker. That is the number of pixels a
 * line of code actually gets, and dividing it by the measured monospace advance
 * gives the column count that decides whether the line wraps.
 */
async function measure(page: Page, mode: Mode) {
  return page.evaluate((m: Mode) => {
    const px = (s: string) => parseFloat(s) || 0
    const R = (n: number) => +n.toFixed(2)

    // Monospace advance, measured in the viewer's own font rather than assumed.
    const anyItem = document.querySelector('.diff-line-content-item')
    const probe = document.createElement('span')
    if (anyItem) {
      const cs = getComputedStyle(anyItem)
      probe.style.font = cs.font
      probe.style.fontFamily = cs.fontFamily
      probe.style.fontSize = cs.fontSize
      probe.style.whiteSpace = 'pre'
      probe.style.position = 'absolute'
      probe.textContent = 'M'.repeat(100)
      document.body.appendChild(probe)
    }
    const charWidth = probe.getBoundingClientRect().width / 100
    probe.remove()

    // Content rows only. Extend rows host OUR inline UI (drafts, findings, the
    // receded-hunk marker) and widget/hunk rows are chrome — none of them are
    // code, so none of them belong in a code-density measurement.
    const rows = (Array.from(document.querySelectorAll('tr.diff-line')) as HTMLElement[]).filter(
      (r) => !r.classList.contains('diff-line-extend') &&
             !r.classList.contains('diff-line-widget') &&
             !r.classList.contains('diff-line-hunk'),
    )

    const heights = rows.map((r) => R(r.getBoundingClientRect().height))
    const hist = new Map<number, number>()
    for (const h of heights) hist.set(h, (hist.get(h) ?? 0) + 1)
    // An unwrapped row is the modal height; anything taller has wrapped.
    const unitRowHeight = [...hist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
    const wrappedRows = heights.filter((h) => h > unitRowHeight * 1.5).length

    // The row to take the geometry from. It has to satisfy two things at once:
    //
    //  - BOTH panes present. The demo's first file is all-add, so its old side
    //    renders `.diff-line-old-placeholder` (colspan 2) with no gutter cell at
    //    all — measuring a pane there yields null.
    //  - a real +/- glyph in the marker, since the marker's INK is what the
    //    within-group gap is measured against, and a context row's marker is a
    //    space with nothing to measure.
    //
    // A delete/add pair satisfies both. Falling back progressively rather than
    // to rows[0] keeps a fixture change from silently measuring a placeholder.
    const complete = (r: HTMLElement) =>
      m === 'split'
        ? !!(r.querySelector('.diff-line-old-content .diff-line-content-item') &&
             r.querySelector('.diff-line-new-content .diff-line-content-item'))
        : !!r.querySelector('.diff-line-content .diff-line-content-item')
    const hasMarker = (r: HTMLElement) =>
      m === 'split'
        ? !!(r.querySelector('.diff-line-old-content .diff-line-content-operator[data-operator]') &&
             r.querySelector('.diff-line-new-content .diff-line-content-operator[data-operator]'))
        : !!r.querySelector('.diff-line-content-operator[data-operator]')

    const marked = rows.find((r) => complete(r) && hasMarker(r)) ?? rows.find(complete) ?? null

    const inkLeft = (el: Element | null) => {
      if (!el) return null
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let n: Node | null
      while ((n = w.nextNode())) {
        const t = n.textContent ?? ''
        if (!t.trim()) continue
        const range = document.createRange()
        range.setStart(n, t.length - t.replace(/^\s+/, '').length)
        range.setEnd(n, t.length)
        const r = range.getBoundingClientRect()
        if (r.width || r.height) return R(r.left)
      }
      return null
    }
    const inkRight = (el: Element | null) => {
      if (!el) return null
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let n: Node | null, last: number | null = null
      while ((n = w.nextNode())) {
        const t = n.textContent ?? ''
        if (!t.trim()) continue
        const range = document.createRange()
        range.setStart(n, 0)
        range.setEnd(n, t.length - (t.length - t.replace(/\s+$/, '').length))
        const r = range.getBoundingClientRect()
        if (r.width || r.height) last = R(r.right)
      }
      return last
    }

    /** One pane: its gutter cell, its content cell, and the group geometry. */
    const pane = (numSel: string, contentSel: string) => {
      const numEl = marked?.querySelector(numSel) as HTMLElement | null
      const contentEl = marked?.querySelector(contentSel) as HTMLElement | null
      if (!numEl || !contentEl) return null
      const numCs = getComputedStyle(numEl), contentCs = getComputedStyle(contentEl)
      const numRect = numEl.getBoundingClientRect(), contentRect = contentEl.getBoundingClientRect()
      const item = contentEl.querySelector('.diff-line-content-item') as HTMLElement | null
      const op = contentEl.querySelector('.diff-line-content-operator') as HTMLElement | null
      const markerInset = item ? px(getComputedStyle(item).paddingLeft) : 0
      const codeWidth = contentRect.width - px(contentCs.paddingLeft) - px(contentCs.paddingRight) - markerInset

      // The gaps INSIDE the [number | marker | code] group, ink to ink. The
      // larger of the two is what the seam has to beat for the grouping to read
      // (p.83: the space around a group must exceed the space inside it).
      const numInkR = inkRight(numEl)
      const markerInkL = inkLeft(op)
      const codeInkL = item ? R(item.getBoundingClientRect().left + markerInset) : null
      const opRect = op?.getBoundingClientRect()

      return {
        numPaddingLeft: numCs.paddingLeft,
        numPaddingRight: numCs.paddingRight,
        contentPaddingLeft: contentCs.paddingLeft,
        contentPaddingRight: contentCs.paddingRight,
        markerInsetPx: markerInset,
        markerInsetEm: item ? R(markerInset / px(getComputedStyle(item).fontSize)) : 0,
        // number ink -> code text origin: identical in both modes, and the
        // single number that disproves "split sits tighter against its gutter".
        numberInkToCode: numInkR !== null && codeInkL !== null ? R(codeInkL - numInkR) : null,
        gapNumberToMarker: numInkR !== null && markerInkL !== null ? R(markerInkL - numInkR) : null,
        gapMarkerToCode: opRect && codeInkL !== null ? R(codeInkL - opRect.right) : null,
        codeWidthPx: R(codeWidth),
        codeWidthChars: charWidth ? Math.floor(codeWidth / charWidth) : 0,
      }
    }

    const oldPane = m === 'split' ? pane('.diff-line-old-num', '.diff-line-old-content') : null
    const newPane = m === 'split' ? pane('.diff-line-new-num', '.diff-line-new-content') : null
    const unified = m === 'unified' ? pane('.diff-line-num', '.diff-line-content') : null

    // The seam: the last pixels of pane one's content, the divider, and the
    // first pixels of pane two's gutter.
    let seam: { gapPx: number; dividerWidth: string; dividerColor: string } | null = null
    if (m === 'split') {
      const oc = marked?.querySelector('.diff-line-old-content') as HTMLElement | null
      const nn = marked?.querySelector('.diff-line-new-num') as HTMLElement | null
      if (oc && nn) {
        const ocCs = getComputedStyle(oc), nnCs = getComputedStyle(nn)
        seam = {
          gapPx: R(px(ocCs.paddingRight) + px(nnCs.borderLeftWidth) + px(nnCs.paddingLeft)),
          dividerWidth: nnCs.borderLeftWidth,
          dividerColor: nnCs.borderLeftColor,
        }
      }
    }

    // Resolve --hairline the way diff-palette.spec does: assign and read back,
    // because light-dark() stays unsubstituted inside a custom property.
    const tokenProbe = document.createElement('span')
    tokenProbe.style.color = 'var(--hairline)'
    document.body.appendChild(tokenProbe)
    const hairline = getComputedStyle(tokenProbe).color
    tokenProbe.remove()

    const rowCs = marked ? getComputedStyle(marked) : null

    return {
      hairline,
      fontSize: rowCs?.fontSize ?? '',
      lineHeight: rowCs?.lineHeight ?? '',
      lineHeightRatio: rowCs ? R(px(rowCs.lineHeight) / px(rowCs.fontSize)) : 0,
      unitRowHeight,
      contentRows: rows.length,
      wrappedRows,
      unified, oldPane, newPane, seam,
    }
  }, mode)
}

for (const theme of ['light', 'dark'] as const) {
  /**
   * Rubric A1 — "density is a decision per surface, declared once. A surface may
   * not be dense merely because it inherited tight padding." Split DID inherit
   * unified's padding, and that is correct here: they are one surface with one
   * density, not two surfaces that happen to look alike. The failure A1 describes
   * would be the two modes DRIFTING apart, so that is what this asserts.
   *
   * It is also the guard against the tempting wrong fix — "split is cramped,
   * tighten/loosen split only" — which is what would make the diff body two
   * density decisions instead of one.
   */
  test(`diff density: split and unified share ONE density decision (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.emulateMedia({ colorScheme: theme })

    await openInspect(page, theme, 'unified')
    const u = await measure(page, 'unified')
    await openInspect(page, theme, 'split')
    const s = await measure(page, 'split')

    expect(u.unified, 'unified pane geometry').toBeTruthy()
    expect(s.oldPane, 'split old-pane geometry').toBeTruthy()
    expect(s.newPane, 'split new-pane geometry').toBeTruthy()

    for (const [label, p] of [['old', s.oldPane!], ['new', s.newPane!]] as const) {
      expect.soft(p.numPaddingLeft, `${label} gutter padding-left == unified`).toBe(u.unified!.numPaddingLeft)
      expect.soft(p.numPaddingRight, `${label} gutter padding-right == unified`).toBe(u.unified!.numPaddingRight)
      expect.soft(p.contentPaddingLeft, `${label} content padding-left == unified`).toBe(u.unified!.contentPaddingLeft)
      expect.soft(p.contentPaddingRight, `${label} content padding-right == unified`).toBe(u.unified!.contentPaddingRight)
      expect.soft(p.markerInsetPx, `${label} marker inset == unified`).toBe(u.unified!.markerInsetPx)
      // The sentence the audit got wrong: code does NOT sit tighter against its
      // gutter in split. Same declaration, same distance, both modes.
      expect.soft(p.numberInkToCode, `${label} line-number ink -> code == unified`)
        .toBeCloseTo(u.unified!.numberInkToCode!, 0)
    }

    // Vertical rhythm is the other half of "one density decision".
    expect.soft(s.fontSize, 'split font-size == unified').toBe(u.fontSize)
    expect.soft(s.lineHeight, 'split line-height == unified').toBe(u.lineHeight)
    expect.soft(s.unitRowHeight, 'split unwrapped row height == unified').toBeCloseTo(u.unitRowHeight, 1)
  })

  /**
   * p.83 / p.86 and rubric A3 — the space around a group must exceed the space
   * inside it, horizontally too. In split there are TWO [number | marker | code]
   * groups on one row, so the seam between them is a group boundary and has to
   * out-measure the largest gap within either group.
   *
   * It currently clears it by ~1px (21px seam vs ~19.8px number->marker), which
   * is why this is a gate and not a comment: the margin is thin enough that any
   * future tightening of the seam — or loosening inside a pane — inverts it, and
   * an inverted boundary reads as one continuous row rather than two panes.
   */
  test(`diff density: the split seam still reads as a group boundary (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.emulateMedia({ colorScheme: theme })
    await openInspect(page, theme, 'split')
    const s = await measure(page, 'split')

    expect(s.seam, 'seam geometry').toBeTruthy()

    const innerGaps = [
      s.oldPane!.gapNumberToMarker, s.oldPane!.gapMarkerToCode,
      s.newPane!.gapNumberToMarker, s.newPane!.gapMarkerToCode,
    ].filter((n): n is number => n !== null)
    expect(innerGaps.length, 'within-pane gaps measured').toBeGreaterThan(0)
    const largestInnerGap = Math.max(...innerGaps)

    expect(
      s.seam!.gapPx,
      `seam (${s.seam!.gapPx}px) must exceed the largest gap inside a pane (${largestInnerGap}px)`,
    ).toBeGreaterThan(largestInnerGap)

    // The seam's spatial margin is thin, so the divider is not decorative — it
    // is what actually carries the boundary. It must exist, and it must be the
    // app's hairline rather than the vendor's #e1e1e1 (audit F5, Phase 3).
    expect(parseFloat(s.seam!.dividerWidth), 'seam divider is drawn').toBeGreaterThanOrEqual(1)
    expect(s.seam!.dividerColor, 'seam divider paints from --hairline').toBe(s.hairline)

    // Two panes, one surface: an asymmetric split would mean the old side and
    // the new side disagree about how much code a line gets.
    expect(s.newPane!.codeWidthPx, 'panes are symmetric').toBeCloseTo(s.oldPane!.codeWidthPx, 0)
  })

  /**
   * The actual finding behind Phase 3 item 4: split's density cost is COLUMN
   * WIDTH, not cell padding. Every padding above is identical between modes, so
   * the only thing that moves split's lines-per-screen is how many characters
   * fit before a line wraps — and the app already ships that lever as the
   * Appearance setting `diffWidth`.
   *
   * Pinning it means a layout regression that silently stops full-width mode
   * from widening the diff (PR #18's bug, which fullwidth-rail.spec guards from
   * the rail side) is also caught from the density side.
   */
  test(`diff density: width, not padding, is split's density lever (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.emulateMedia({ colorScheme: theme })

    await openInspect(page, theme, 'split', 'centered')
    const centered = await measure(page, 'split')
    await openInspect(page, theme, 'split', 'full')
    const full = await measure(page, 'split')

    // Same declarations in both — the width setting changes the column, not the
    // density decision.
    expect.soft(full.oldPane!.markerInsetPx, 'marker inset unchanged by width').toBe(centered.oldPane!.markerInsetPx)
    expect.soft(full.oldPane!.numPaddingLeft, 'gutter padding unchanged by width').toBe(centered.oldPane!.numPaddingLeft)
    expect.soft(full.seam!.gapPx, 'seam unchanged by width').toBe(centered.seam!.gapPx)

    // ...and yet each pane gains a third again as many columns, which is the
    // whole density difference.
    expect(
      full.oldPane!.codeWidthChars,
      `full-width pane (${full.oldPane!.codeWidthChars} cols) must beat centered (${centered.oldPane!.codeWidthChars} cols)`,
    ).toBeGreaterThan(centered.oldPane!.codeWidthChars * 1.25)

    // Fewer wrapped rows is the visible consequence: a wrapped row's second
    // visual line has no line number and no marker, so it costs a row of height
    // while breaking rubric A3's grouping for that line.
    expect(full.contentRows, 'same fixture, same rows').toBe(centered.contentRows)
    expect(
      full.wrappedRows,
      `full-width wraps fewer rows (${full.wrappedRows}) than centered (${centered.wrappedRows})`,
    ).toBeLessThan(centered.wrappedRows)
  })
}
