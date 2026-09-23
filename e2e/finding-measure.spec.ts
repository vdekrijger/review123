/**
 * e2e/finding-measure.spec.ts — the finding-card prose measure, in CHARACTERS.
 *
 * WHY THIS SPEC EXISTS. The finding cards were the widest prose in the app.
 * Measured in the built app at 1440x1000 on /demo, the 13.5px finding paragraph
 * ran 166.7ch at `diffWidth: full` and 121.4ch at `centered`, against the 45-75
 * characters the rubric sets (p.99-101) and the 74ch Batch 2C called the top of
 * comfortable. They were ALREADY over at centered, so the full-width default
 * enlarged an existing problem rather than creating one — which is why the cap
 * has to hold at BOTH width settings, and why both are exercised below.
 *
 * WHAT IS UNDER TEST, and it is deliberately not "the CSS says 72ch".
 *
 *  1. Every prose block in a finding card measures <= 75ch — the rubric's
 *     ceiling, asserted in characters. A `ch` is the advance of "0" in the
 *     element's OWN font, so the same assertion is meaningful across the
 *     12.3 / 12.75 / 13.5 / 15px sizes these surfaces mix.
 *
 *  2. The CARD stays wide while the prose narrows. This is the tension the
 *     change exists to resolve: the card lives inside the diff surface, which
 *     legitimately wants the full window, so the fix had to constrain the
 *     CONTENT rather than the container (p.68-70, and Batch 2C's precedent for
 *     declining to widen a column whose prose was already too wide). A cap on
 *     the card would pass assertion 1 and be the wrong change; this assertion
 *     is what distinguishes them.
 *
 *  3. CODE IS EXEMPT. Amendment A2: monospace code sets its own measure and
 *     must never be re-wrapped for prose comfort. A <pre> inside a finding body
 *     keeps the card's width and scrolls. Because the demo fixture's findings
 *     contain no fences, the spec injects one into a REAL rendered card and
 *     lets the real stylesheet decide — the alternative (asserting the selector
 *     list) would test the declaration rather than the rendered result, which
 *     is the failure mode four batches of this refactor have paid for.
 *
 *  4. THE CAP IS IN CHARACTERS, NOT PIXELS. The root font-size is changed under
 *     the rendered page; the prose must keep the same ch measure while its
 *     pixel width moves. This is the assertion that a future font or type-scale
 *     change cannot silently break the measure — a hardcoded px cap would fail
 *     it, and so would a ch cap that something had quietly overridden in px.
 *
 * Route: /demo's Inspect step — the same deterministic committed fixture
 * diff-density and diff-palette measure against. No network, no clock.
 */

import { test, expect, type Page } from '@playwright/test'

type Mode = 'unified' | 'split'
type Width = 'centered' | 'full'
type Theme = 'light' | 'dark'

/** The rubric's ceiling (p.99-100). The app caps at --measure-prose (72ch). */
const MAX_CH = 75

async function openInspect(page: Page, theme: Theme, diffMode: Mode, diffWidth: Width) {
  await page.route('**/*posthog.com/**', (r) => r.abort())
  await page.route('**/us.i.posthog.com/**', (r) => r.abort())
  await page.addInitScript(
    (s) => localStorage.setItem('review123:settings', JSON.stringify(s)),
    { theme, diffMode, diffWidth, focusMode: 'imports', railCollapsed: true, deepseekKey: '' },
  )
  await page.goto('/demo')
  await page.getByRole('button', { name: /next step/i }).first().click()
  await page.locator('.diff-tailwindcss-wrapper').first().waitFor({ timeout: 30_000 })
  // Disclose the collapsed per-file secondary group so its cards are measurable.
  await page.evaluate(() => {
    document.querySelectorAll<HTMLDetailsElement>('details.secondary-findings')
      .forEach((d) => { d.open = true })
  })
  await expect(page.locator('.skill-finding').first()).toBeVisible()
}

/**
 * Every finding prose block on the page, measured in its own characters.
 *
 * `ch` is computed the way CSS defines the unit — the advance of "0" in the
 * element's own resolved font — rather than assumed from the font size, so a
 * font swap changes the measurement the same way it changes the rendering.
 */
async function measureFindings(page: Page) {
  return page.evaluate(() => {
    const R = (n: number) => +n.toFixed(1)

    const chWidth = (el: Element) => {
      const cs = getComputedStyle(el)
      const probe = document.createElement('span')
      probe.style.font = cs.font
      probe.style.fontFamily = cs.fontFamily
      probe.style.fontSize = cs.fontSize
      probe.style.fontWeight = cs.fontWeight
      probe.style.letterSpacing = cs.letterSpacing
      probe.style.whiteSpace = 'pre'
      probe.style.position = 'absolute'
      probe.style.visibility = 'hidden'
      probe.textContent = '0'.repeat(100)
      document.body.appendChild(probe)
      const w = probe.getBoundingClientRect().width / 100
      probe.remove()
      return w
    }

    const read = (el: Element) => {
      const ch = chWidth(el)
      const px = el.getBoundingClientRect().width
      return { px: R(px), ch: ch ? R(px / ch) : 0 }
    }

    const cards = Array.from(document.querySelectorAll('.skill-finding'))
    const prose: { where: string; px: number; ch: number }[] = []
    const code: { where: string; px: number; ch: number; overflowX: string }[] = []
    const containers: { where: string; px: number; ch: number }[] = []

    cards.forEach((card, i) => {
      containers.push({ where: `card[${i}]`, ...read(card) })
      // Prose blocks: the rendered-markdown paragraphs/lists of the body and of
      // the Fix block. These are the elements the measure governs.
      card.querySelectorAll('.skill-finding-body p, .skill-finding-body li, .fix-body p, .fix-body li')
        .forEach((el, j) => {
          if (el.getBoundingClientRect().width < 1) return
          prose.push({ where: `card[${i}]/prose[${j}]`, ...read(el) })
        })
      // Code blocks: exempt by A2, recorded so the exemption is asserted rather
      // than assumed.
      card.querySelectorAll('.skill-finding-body pre, .fix-body pre').forEach((el, j) => {
        if (el.getBoundingClientRect().width < 1) return
        code.push({ where: `card[${i}]/pre[${j}]`, ...read(el), overflowX: getComputedStyle(el).overflowX })
      })
    })

    // The reviewer-chip popover renders findings through a different code path
    // (inline markdown into a span), so it is measured separately.
    document.querySelectorAll('.findings-popover-body').forEach((el, i) => {
      if (el.getBoundingClientRect().width < 1) return
      prose.push({ where: `popover[${i}]`, ...read(el) })
    })

    return { prose, code, containers }
  })
}

/** Give a real rendered card a code fence and a list, so the exemption is testable. */
async function injectCodeAndList(page: Page) {
  return page.evaluate(() => {
    const card = document.querySelector('.skill-finding')
    const body = card?.querySelector('.skill-finding-body')
    const view = body?.querySelector('.markdown-view')
    if (!card || !body || !view) return false
    const long =
      'const averyLongIdentifierName = await fetchResultsFromTheSearchEndpoint(queryString, ' +
      '{ signal: controller.signal, retries: 3, backoffMs: 250 })'
    view.insertAdjacentHTML(
      'beforeend',
      `<pre data-probe="code"><code>${long}</code></pre>` +
      '<ul><li data-probe="listitem">A list item long enough to run well past the comfortable ' +
      'measure if nothing capped it, which is the entire point of measuring it here rather ' +
      'than trusting the selector list to be right.</li></ul>',
    )
    return true
  })
}

// ---------------------------------------------------------------------------
// 1 + 2: the measure holds, and the card keeps its width, on every combination
// ---------------------------------------------------------------------------

const COMBOS: { theme: Theme; mode: Mode; width: Width }[] = [
  { theme: 'light', mode: 'unified', width: 'centered' },
  { theme: 'light', mode: 'unified', width: 'full' },
  { theme: 'dark', mode: 'unified', width: 'centered' },
  { theme: 'dark', mode: 'unified', width: 'full' },
  { theme: 'light', mode: 'split', width: 'full' },
]

for (const { theme, mode, width } of COMBOS) {
  test(`finding prose stays within ${MAX_CH}ch — ${theme}/${mode}/${width}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openInspect(page, theme, mode, width)

    const { prose, containers } = await measureFindings(page)

    expect(prose.length, 'no finding prose was found to measure').toBeGreaterThan(0)
    for (const p of prose) {
      expect(p.ch, `${p.where} runs ${p.ch}ch (${p.px}px) — past the ${MAX_CH}ch measure`)
        .toBeLessThanOrEqual(MAX_CH)
    }

    // The cap must constrain the CONTENT, not the container. In full width the
    // card is ~179ch; if a future change "fixes" the measure by shrinking the
    // card instead, the prose assertion above would still pass and the diff
    // surface would have silently lost the room the width setting bought it.
    if (width === 'full' && mode === 'unified') {
      const widest = Math.max(...containers.map((c) => c.ch))
      expect(widest, 'the finding card should keep the full diff width')
        .toBeGreaterThan(MAX_CH * 1.5)
    }
  })
}

// ---------------------------------------------------------------------------
// 3: code is exempt (amendment A2)
// ---------------------------------------------------------------------------

test('a code fence in a finding keeps the card width and scrolls (A2)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openInspect(page, 'light', 'unified', 'full')
  expect(await injectCodeAndList(page), 'could not inject into a finding body').toBe(true)

  const { prose, code } = await measureFindings(page)

  // The injected list item is prose and caps...
  const listItem = prose.find((p) => p.ch > 0 && p.ch <= MAX_CH)
  expect(listItem, 'the injected list item should have been measured').toBeTruthy()
  for (const p of prose) expect(p.ch, p.where).toBeLessThanOrEqual(MAX_CH)

  // ...while the fence beside it does NOT. Monospace code sets its own measure
  // and must never be re-wrapped for prose comfort.
  expect(code.length, 'the injected code fence should have been measured').toBeGreaterThan(0)
  for (const c of code) {
    expect(c.ch, `${c.where} was capped to ${c.ch}ch — A2 exempts code from the prose measure`)
      .toBeGreaterThan(MAX_CH)
    expect(c.overflowX, `${c.where} must scroll rather than wrap`).toBe('auto')
  }
})

// ---------------------------------------------------------------------------
// 4: the cap is a character count, not a pixel count
// ---------------------------------------------------------------------------

test('the measure is in characters, so a type-scale change cannot widen it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openInspect(page, 'light', 'unified', 'full')

  const before = await measureFindings(page)

  // Simulate the font/scale change this gate exists to survive. Every size in
  // the app is rem-derived from this one declaration, so moving it is the
  // cheapest faithful stand-in for a new type scale.
  await page.evaluate(() => { document.documentElement.style.fontSize = '20px' })
  await page.waitForTimeout(150)

  const after = await measureFindings(page)

  expect(after.prose.length).toBe(before.prose.length)
  for (let i = 0; i < before.prose.length; i++) {
    const b = before.prose[i]
    const a = after.prose[i]
    // Still within the measure — this is the assertion that matters.
    expect(a.ch, `${a.where} runs ${a.ch}ch after the scale change`).toBeLessThanOrEqual(MAX_CH)
    // And it is the SAME character count at a different pixel width, which is
    // only true of a cap expressed in ch. A px cap would hold the pixels and
    // let the character count fall; a stale px cap would let it rise.
    expect(a.ch, `${a.where}: ch drifted ${b.ch} -> ${a.ch} under a scale change`)
      .toBeCloseTo(b.ch, 0)
    expect(a.px, `${a.where}: px should track the scale (${b.px} -> ${a.px})`)
      .toBeGreaterThan(b.px)
  }
})

// ---------------------------------------------------------------------------
// Story mode — the widest finding surface of all, because the card is not
// inside the diff table there (measured at 171.7ch before the cap).
// ---------------------------------------------------------------------------

test('Story mode findings obey the same measure', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openInspect(page, 'light', 'unified', 'full')

  await page.locator('.flow-btn', { hasText: /^Story$/ }).first().click()
  await expect(page.locator('.story')).toBeVisible()

  // Walk to the step that carries a file-level finding card. The fixture places
  // one on step 4 of 6; walking rather than hardcoding keeps a fixture edit from
  // turning this into a silent no-op.
  let found = false
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => {
      document.querySelectorAll<HTMLDetailsElement>('details.secondary-findings')
        .forEach((d) => { d.open = true })
    })
    if (await page.locator('.story .skill-finding').count() > 0) { found = true; break }
    const next = page.locator('.story-nav', { hasText: /Next/ }).first()
    if (!(await next.count())) break
    await next.click()
    await page.waitForTimeout(400)
  }
  expect(found, 'no finding card was reachable in Story mode').toBe(true)

  const { prose, containers } = await measureFindings(page)
  expect(prose.length).toBeGreaterThan(0)
  for (const p of prose) {
    expect(p.ch, `${p.where} runs ${p.ch}ch in Story mode`).toBeLessThanOrEqual(MAX_CH)
  }
  // Story's card is not inside the diff table, so it is the widest container
  // the prose has to resist. Same tension, same resolution.
  expect(Math.max(...containers.map((c) => c.ch))).toBeGreaterThan(MAX_CH * 1.5)
})
