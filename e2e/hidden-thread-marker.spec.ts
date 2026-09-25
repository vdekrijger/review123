/**
 * e2e/hidden-thread-marker.spec.ts — the hidden-thread notice is out of the
 * code flow, and revealing it is reversible (#295).
 *
 * THE REPORT was a screenshot: four full-width blue "2 resolved threads hidden
 * — show" bands stacked between code lines inside twenty lines of Python, plus
 * two expanded RESOLVED rows. "would be great if we could re-hide the resolved
 * threads by the click of a button, and if the blue thing maybe just becomes a
 * marker on the left side at the line numbers so we don't take away from the
 * reading code experience".
 *
 * WHY A REAL BROWSER, and not more jsdom. Two of the three claims are geometry,
 * and the third is a stacking question:
 *
 *   1. "the code column is uninterrupted" is a statement about PIXELS. jsdom
 *      lays nothing out, so a band that still costs a row would look identical
 *      there to one that is gone. This file measures the rows.
 *   2. the marker lives inside @git-diff-view's own `td.diff-line-num`, which
 *      is `position: sticky` with a z-index — the exact shape #279 proved traps
 *      absolutely-positioned descendants one level down, in
 *      `.diff-line-extend-wrapper`. "The CSS looks right" is what #279 already
 *      disbelieved once, so this hit-tests `elementFromPoint` and clicks with a
 *      real mouse.
 *
 * /demo carries four hidden groups for this (src/lib/demo/fixture.ts):
 *   api.ts        RIGHT 5   1 resolved thread (9002 + reply 9003)
 *   useSearch.ts  RIGHT 8   1 resolved thread (9009)
 *   useSearch.ts  RIGHT 19  1 resolved thread (9011) AND 1 bot thread (9010)
 *   useSearch.ts  RIGHT 22  1 bot thread (9006)
 * — three of them inside one fifteen-line hunk, which is the stack the report
 * was a picture of.
 */

import { test, expect, type Page, type Locator } from '@playwright/test'

const MARKER = '[data-testid="hidden-threads-marker"]'
const USE_SEARCH = '#file-src-search-useSearch-ts'

type Opts = { theme?: 'light' | 'dark'; diffMode?: 'unified' | 'split'; width?: number }

async function openInspect(page: Page, opts: Opts = {}) {
  const theme = opts.theme ?? 'light'
  if (opts.width) await page.setViewportSize({ width: opts.width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.route('**/*posthog.com/**', (r) => r.abort())
  await page.route('**/us.i.posthog.com/**', (r) => r.abort())
  await page.addInitScript((s) => localStorage.setItem('review123:settings', JSON.stringify(s)), {
    theme,
    diffMode: opts.diffMode ?? 'unified',
    railCollapsed: true,
    deepseekKey: '',
  })
  await page.goto('/demo')
  await page.getByRole('button', { name: /next step/i }).first().click()
  await page.locator('.diff-tailwindcss-wrapper').first().waitFor({ timeout: 20_000 })
  await expect(page.locator(MARKER).first()).toBeAttached({ timeout: 20_000 })
}

function markerAt(scope: Page | Locator, line: number): Locator {
  return scope.locator(`${MARKER}[data-line="${line}"][data-side="RIGHT"]`)
}

// ---------------------------------------------------------------------------
// The marker is where the reader was told it would be
// ---------------------------------------------------------------------------

for (const diffMode of ['unified', 'split'] as const) {
  test(`${diffMode}: every hidden group is a gutter marker, and only the hidden ones are`, async ({
    page,
  }) => {
    await openInspect(page, { diffMode })

    // Four groups, four markers — one per LINE, not one per row. The gutter
    // does not become a column of tab stops.
    await expect(page.locator(MARKER)).toHaveCount(4)

    const file = page.locator(USE_SEARCH)
    await expect(markerAt(file, 8)).toHaveAttribute('aria-label', /1 resolved thread hidden/)
    await expect(markerAt(file, 22)).toHaveAttribute('aria-label', /1 bot thread hidden/)

    // Each one is a child of the library's own line-number cell for its line —
    // in split mode, of the side the thread is anchored to, because that is the
    // column its group opens in.
    const cells = await page.locator(MARKER).evaluateAll((els) =>
      els.map((el) => el.closest('td')!.className.split(' ')[0]),
    )
    const expected = diffMode === 'split' ? 'diff-line-new-num' : 'diff-line-num'
    expect(cells).toEqual([expected, expected, expected, expected])

    // The row it sits in is the row it describes.
    const onItsOwnLine = await markerAt(file, 22).evaluate((el) => {
      const row = el.closest('tr')!
      return !!row.querySelector('[data-line-new-num="22"], [data-line-num="22"]')
    })
    expect(onItsOwnLine).toBe(true)
  })
}

// ---------------------------------------------------------------------------
// The thing the report was actually about: the reading column
// ---------------------------------------------------------------------------

for (const diffMode of ['unified', 'split'] as const) {
  for (const width of [1440, 400]) {
    test(`${diffMode} @${width}px: a hidden group costs the code column zero rows`, async ({
      page,
    }) => {
      await openInspect(page, { diffMode, width })

      // (a) No block exists ONLY to announce something is hidden. Every inline
      //     thread block that survives carries a thread the reader can read —
      //     which is precisely what the four stacked bands did not.
      const emptyBanners = await page
        .locator('.inline-comment-threads')
        .evaluateAll((els) =>
          els.filter((el) => el.querySelectorAll('[data-testid="existing-thread"]').length === 0)
            .length,
        )
      expect(emptyBanners).toBe(0)

      // (b) The rows themselves. For every marked line the next row is the next
      //     line of CODE, flush against it — UNLESS that line independently
      //     carries something the reader asked for, in which case the extend
      //     row is that content and carries no notice. On /demo exactly one
      //     marked line does: RIGHT 22 of useSearch.ts also holds a reviewer
      //     finding. (In split mode the library mirrors an extend row on the
      //     far side as a same-height placeholder, so before #295 one hidden
      //     group cost the OTHER column a gap as well.)
      const rows = await page.locator(MARKER).evaluateAll((els) =>
        els.map((el) => {
          const row = el.closest('tr')!
          const next = row.nextElementSibling as HTMLElement | null
          const a = row.getBoundingClientRect()
          const b = next?.getBoundingClientRect()
          const isExtend = next?.dataset.state === 'extend'
          return {
            line: el.dataset.line,
            isExtend,
            carriesContent:
              isExtend &&
              next!.querySelector(
                '.inline-comment-threads, .line-findings, .draft-annotations, .hunk-marker',
              ) !== null,
            carriesNotice:
              isExtend && next!.querySelector('[data-testid$="-hidden-note"]') !== null,
            gap: b ? Math.round((b.top - a.bottom) * 10) / 10 : 0,
          }
        }),
      )
      const flush = rows.filter((r) => !r.isExtend)
      expect(flush.length, 'every marked line carried other content — nothing proved').toBeGreaterThan(0)
      for (const r of rows) {
        expect(r.gap, `line ${r.line} is not flush with the row below`).toBeLessThanOrEqual(1)
        if (r.isExtend) {
          expect(r.carriesContent, `line ${r.line}: an empty extend row follows it`).toBe(true)
          expect(r.carriesNotice, `line ${r.line}: a notice is still in the code flow`).toBe(false)
        }
      }

      // (c) And the marker takes no width from the code either: it sits inside
      //     the gutter cell, left of where the line numbers are drawn.
      const inGutter = await page.locator(MARKER).evaluateAll((els) =>
        els.every((el) => {
          const cell = el.closest('td')!.getBoundingClientRect()
          const m = el.getBoundingClientRect()
          return m.left >= cell.left - 0.5 && m.right <= cell.right + 0.5
        }),
      )
      expect(inGutter).toBe(true)
    })
  }
}

const REVEALED_AT_8 = 'A ref rather than state here is right'

test('revealed then re-hidden: the code column goes back exactly as it was', async ({ page }) => {
  await openInspect(page)
  const file = page.locator(USE_SEARCH)
  // RIGHT 8 carries a resolved thread and nothing else, so the rows and the
  // height it costs when shown are entirely this group's.
  const marker = markerAt(file, 8)
  await marker.scrollIntoViewIfNeeded()

  const rowsBefore = await file.locator('tr').count()
  const heightBefore = (await file.boundingBox())!.height

  await marker.click()
  await expect(page.getByText(REVEALED_AT_8).first()).toBeVisible({ timeout: 5_000 })
  expect(await file.locator('tr').count()).toBeGreaterThan(rowsBefore)
  expect((await file.boundingBox())!.height).toBeGreaterThan(heightBefore)

  // The way back sits at the FOOT of the group the reveal opened, where the
  // reader's eye is once they have read it.
  const rehide = file.getByTestId('resolved-rehide').first()
  await expect(rehide).toContainText('Hide 1 resolved thread again')
  await rehide.click()

  await expect(page.getByText(REVEALED_AT_8)).toHaveCount(0)
  await expect.poll(() => file.locator('tr').count()).toBe(rowsBefore)
  expect(Math.round((await file.boundingBox())!.height)).toBe(Math.round(heightBefore))
  // The global preference was never touched by either direction.
  await expect(page.getByTestId('hide-resolved-toggle')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('resolved-hidden-count')).toContainText('5 resolved threads hidden')

  // And the marker itself is the other way back — the reader who never left it.
  await marker.click()
  await expect(page.getByText(REVEALED_AT_8).first()).toBeVisible({ timeout: 5_000 })
  await marker.click()
  await expect(page.getByText(REVEALED_AT_8)).toHaveCount(0)
  await expect.poll(() => file.locator('tr').count()).toBe(rowsBefore)
})

// ---------------------------------------------------------------------------
// Not trapped, not covered — the #279 hit test
// ---------------------------------------------------------------------------

for (const diffMode of ['unified', 'split'] as const) {
  test(`${diffMode}: the marker wins its own pixels and a real mouse click reaches it`, async ({
    page,
  }) => {
    await openInspect(page, { diffMode })
    const marker = markerAt(page.locator(USE_SEARCH), 22)
    await marker.scrollIntoViewIfNeeded()

    const top = await marker.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return { isMarker: hit === el || el.contains(hit), tag: hit?.tagName ?? null }
    })
    expect(top.isMarker, `elementFromPoint returned ${top.tag}`).toBe(true)

    // The library's own "+" add-comment widget lives at the OTHER edge of the
    // same cell, so the marker cannot have taken it over.
    const box = await marker.boundingBox()
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await expect(page.getByText('Issue description').first()).toBeVisible({ timeout: 5_000 })
  })
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

test('the marker is reachable and operable from the keyboard', async ({ page }) => {
  await openInspect(page)
  const marker = markerAt(page.locator(USE_SEARCH), 22)
  await marker.scrollIntoViewIfNeeded()

  await marker.focus()
  await expect(marker).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Issue description').first()).toBeVisible({ timeout: 5_000 })
  await expect(marker).toHaveAttribute('aria-expanded', 'true')

  await marker.focus()
  await page.keyboard.press(' ')
  await expect(page.getByText('Issue description')).toHaveCount(0)
  await expect(marker).toHaveAttribute('aria-expanded', 'false')
})

// ---------------------------------------------------------------------------
// Two reasons on one line
// ---------------------------------------------------------------------------

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: a line holding both reasons is one marker that still tells them apart`, async ({
    page,
  }, testInfo) => {
    await openInspect(page, { theme })
    const file = page.locator(USE_SEARCH)
    const marker = markerAt(file, 19)
    await marker.scrollIntoViewIfNeeded()

    // One marker, one bar per reason, and each reason's own count in the name.
    await expect(marker).toHaveCount(1)
    await expect(marker).toHaveAttribute('data-reasons', 'resolved bot')
    await expect(marker.locator('.gutter-thread-marker-bar')).toHaveCount(2)
    const label = await marker.getAttribute('aria-label')
    expect(label).toContain('1 resolved thread hidden')
    expect(label).toContain('1 bot thread hidden')

    // The bar is painted, in both themes — quieter than a band is fine,
    // invisible is not.
    const paint = await marker.locator('.gutter-thread-marker-bar').first().evaluate((el) => {
      const s = getComputedStyle(el)
      return { bg: s.backgroundColor, opacity: Number(s.opacity), w: el.getBoundingClientRect().width }
    })
    expect(paint.bg).not.toBe('rgba(0, 0, 0, 0)')
    expect(paint.opacity).toBeGreaterThan(0.5)
    expect(paint.w).toBeGreaterThan(1)

    // What it opens distinguishes them: a way back PER reason.
    await marker.click()
    const group = file.locator('.inline-comment-threads').filter({ hasText: 'Forwarding the signal' })
    await expect(group.getByTestId('resolved-rehide')).toBeVisible()
    await expect(group.getByTestId('bot-rehide')).toBeVisible()

    await testInfo.attach(`both-reasons-${theme}`, {
      body: await file.screenshot(),
      contentType: 'image/png',
    })

    // Putting back one leaves the other where the reader is still reading it.
    await group.getByTestId('bot-rehide').click()
    await expect(page.getByText('a linter that cannot see')).toHaveCount(0)
    await expect(page.getByText('Forwarding the signal').first()).toBeVisible()
    await expect(marker).toHaveAttribute('aria-label', /1 resolved thread shown/)
  })
}

// ---------------------------------------------------------------------------
// The surface with no line to hang a marker on
// ---------------------------------------------------------------------------

test('the per-file bottom list keeps its sentence, and gains the same way back', async ({
  page,
}) => {
  await openInspect(page)
  const file = page.locator(USE_SEARCH)
  const note = file.getByTestId('resolved-hidden-note').first()
  await note.scrollIntoViewIfNeeded()

  // 9004 + 9005 are file-level: no line, so nothing for a gutter marker to
  // attach to. The counted sentence stays exactly what #272 shipped.
  await expect(note).toContainText('2 resolved threads hidden — show')
  await note.click()

  const rehide = file.locator('.existing-comments').getByTestId('resolved-rehide')
  await expect(rehide).toContainText('Hide 2 resolved threads again')
  await rehide.click()
  await expect(note).toContainText('2 resolved threads hidden — show')
})
