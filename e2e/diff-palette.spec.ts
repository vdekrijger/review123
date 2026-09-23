/**
 * e2e/diff-palette.spec.ts — the diff viewer paints from the app's palette, and
 * receded rows recede by INK, in a real browser.
 *
 * Why this exists alongside src/lib/theme/contrast.test.ts: that file proves the
 * VALUES are right and the bindings are written. It cannot prove the bindings
 * WIN. The viewer is a vendored dependency whose own theme rules are already in
 * the page, so everything here depends on a cascade — one class-level unit of
 * specificity on ~40 selectors, and a custom property inheriting down into
 * markup we do not author. A declaration that is out-specified looks exactly
 * like a declaration that is right, in the source.
 *
 * That is the lesson Batch 2A paid for: its spacing fix was re-broken two lines
 * below itself by a shorthand, the screenshots caught it and the unit gates did
 * not, because they measured a different element. So this spec measures what
 * the browser computed.
 *
 * Four passes: light/dark x unified/split. The route is /demo, whose Inspect
 * step has a deterministic eight receded rows under Focus: imports.
 */

import { test, expect, type Page } from '@playwright/test'

/**
 * Every token the diff surface is allowed to paint from. Resolved in-page, so
 * the spec compares against what the palette actually computes rather than a
 * second copy of it.
 */
const PALETTE = [
  '--bg', '--surface', '--surface-sunken', '--hairline', '--border-control',
  '--text', '--text-secondary', '--text-muted', '--accent', '--on-accent',
  '--legend-added-bg', '--legend-added-color', '--legend-added-border',
  '--legend-removed-bg', '--legend-removed-color', '--legend-removed-border',
  '--legend-changed-bg', '--legend-changed-color', '--legend-changed-border',
  '--legend-unchanged-bg', '--legend-unchanged-color',
  '--diff-added-emphasis', '--diff-removed-emphasis',
  '--syntax-ink', '--syntax-keyword', '--syntax-entity', '--syntax-constant',
  '--syntax-string', '--syntax-variable', '--syntax-comment', '--syntax-tag',
  '--syntax-bullet', '--syntax-receded',
  '--surface-draft', '--border-draft', '--text-draft',
  '--surface-banner', '--text-banner', '--border-banner',
] as const

async function openInspect(page: Page, theme: 'light' | 'dark', diffMode: 'unified' | 'split') {
  await page.route('**/*posthog.com/**', (r) => r.abort())
  await page.route('**/us.i.posthog.com/**', (r) => r.abort())
  await page.addInitScript(
    (s) => localStorage.setItem('review123:settings', JSON.stringify(s)),
    { theme, diffMode, focusMode: 'imports', railCollapsed: true, deepseekKey: '' },
  )
  await page.goto('/demo')
  await page.getByRole('button', { name: /next step/i }).first().click()
  await page.locator('.diff-tailwindcss-wrapper').first().waitFor({ timeout: 20_000 })
  await expect(page.locator('.dimmed-noise, .hunk-receded').first()).toBeVisible()
  await settle(page)
}

/**
 * The receded cells carry `transition: color 0.12s ease`, so a colour read the
 * instant they appear is a value part-way between the role ink and the receded
 * ink — which is exactly what this spec caught on its first run. Wait it out
 * rather than assert on a frame in the middle of it.
 */
const TRANSITION_MS = 120
async function settle(page: Page) {
  await page.waitForTimeout(TRANSITION_MS * 3)
}

for (const theme of ['light', 'dark'] as const) {
  for (const diffMode of ['unified', 'split'] as const) {
    test(`diff palette: every colour inside the viewer is an app token (${theme}, ${diffMode})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await openInspect(page, theme, diffMode)

      const { foreign, blues, elements } = await page.evaluate((names) => {
        // Resolve each token by assigning it and reading the computed colour —
        // the only way to resolve light-dark(), which stays unsubstituted in a
        // custom property until it is used.
        const probe = document.createElement('span')
        document.body.appendChild(probe)
        const allowed = new Set<string>(['rgba(0, 0, 0, 0)'])
        for (const n of names) {
          probe.style.color = ''
          probe.style.color = `var(${n})`
          allowed.add(getComputedStyle(probe).color)
        }
        document.body.removeChild(probe)

        const wrapper = document.querySelector('.diff-tailwindcss-wrapper')!
        const props = ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'borderLeftColor', 'borderRightColor', 'outlineColor'] as const
        const foreign: Record<string, number> = {}
        let blues = 0
        let elements = 0
        for (const el of Array.from(wrapper.querySelectorAll('*'))) {
          const cs = getComputedStyle(el)
          elements++
          for (const p of props) {
            const v = cs[p]
            if (p.startsWith('border') && parseFloat(cs[p.replace('Color', 'Width') as 'borderTopWidth']) === 0) continue
            if (p === 'outlineColor' && cs.outlineStyle === 'none') continue
            if (!allowed.has(v)) foreign[`${p} ${v}`] = (foreign[`${p} ${v}`] ?? 0) + 1
            // GitHub's #0969da / #0969d2 — the audit's "second accent", 78 of
            // them on the add-comment widgets.
            if (/^rgba?\(9, 105, 21[08]/.test(v)) blues++
          }
        }
        return { foreign, blues, elements }
      }, PALETTE as unknown as string[])

      expect(elements, 'the diff viewer did not render').toBeGreaterThan(100)
      expect(foreign, `colours outside the palette: ${JSON.stringify(foreign)}`).toEqual({})
      expect(blues, 'GitHub blue is back in the diff viewer').toBe(0)
    })

    test(`diff palette: a receded row paints ONE ink, and hover restores it (${theme}, ${diffMode})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await openInspect(page, theme, diffMode)

      const before = await page.evaluate(() => {
        const probe = document.createElement('span')
        document.body.appendChild(probe)
        probe.style.color = 'var(--syntax-receded)'
        const receded = getComputedStyle(probe).color
        probe.style.color = 'var(--syntax-ink)'
        const ink = getComputedStyle(probe).color
        document.body.removeChild(probe)

        const cells = Array.from(document.querySelectorAll('.dimmed-noise, .hunk-receded'))
        const spans = cells.flatMap((c) =>
          Array.from(c.querySelectorAll('[class*="hljs-"]')).map((s) => getComputedStyle(s).color),
        )
        const raws = cells
          .map((c) => c.querySelector('.diff-line-syntax-raw, .diff-line-content-raw'))
          .filter(Boolean)
          .map((r) => getComputedStyle(r as Element).color)
        const opacities = cells.map((c) => getComputedStyle(c).opacity)
        return { receded, ink, spans, raws, opacities, cellCount: cells.length }
      })

      // The substitution: EVERY syntax span in a receded row is the one muted
      // ink, not six hues dimmed toward the ground.
      expect(before.spans.length, 'no syntax tokens in the receded rows').toBeGreaterThan(4)
      expect(new Set(before.spans), 'a receded row is painting more than one ink').toEqual(
        new Set([before.receded]),
      )
      // The body ink of those rows too, and it is NOT the full-strength ink.
      expect(new Set(before.raws)).toEqual(new Set([before.receded]))
      expect(before.receded).not.toBe(before.ink)
      // And it is ink substitution, not alpha: the cell is fully opaque, so the
      // row keeps its own add/remove tint.
      expect(new Set(before.opacities)).toEqual(new Set(['1']))

      // Hover restores the role colours. `--syntax-recede-ink: initial` makes
      // the property guaranteed-invalid so every rule falls back to its own
      // role token; this proves that actually happens in a browser.
      const cell = page.locator('.dimmed-noise, .hunk-receded').first()
      await cell.scrollIntoViewIfNeeded()
      await cell.hover()
      await settle(page)

      const after = await cell.evaluate((el) => ({
        hovered: el.matches(':hover'),
        spans: Array.from(el.querySelectorAll('[class*="hljs-"]')).map((s) => ({
          cls: Array.from(s.classList).join(' '),
          color: getComputedStyle(s).color,
        })),
      }))
      expect(after.hovered, 'the pointer never landed on the receded cell').toBe(true)
      expect(after.spans.length).toBeGreaterThan(1)
      expect(
        new Set(after.spans.map((s) => s.color)).size,
        `hover did not restore the role colours: ${JSON.stringify(after.spans)}`,
      ).toBeGreaterThan(1)
      for (const s of after.spans) expect(s.color).not.toBe(before.receded)
    })

    test(`diff palette: syntax clears 4.5:1 on every ground it lands on (${theme}, ${diffMode})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await openInspect(page, theme, diffMode)

      const rows = await page.evaluate(() => {
        const parse = (css: string) => {
          const m = css.match(/rgba?\(([^)]+)\)/)
          if (!m) return null
          const p = m[1].split(/[,/]/).map(Number)
          return { rgb: [p[0], p[1], p[2]] as [number, number, number], a: p.length > 3 ? p[3] : 1 }
        }
        const lum = ([r, g, b]: number[]) => {
          const f = (c: number) => {
            const s = c / 255
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
          }
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
        }
        const ratio = (a: number[], b: number[]) => {
          const [l1, l2] = [lum(a), lum(b)]
          const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1]
          return (hi + 0.05) / (lo + 0.05)
        }
        const out: Array<{ cls: string; fg: string; bg: string; ratio: number; receded: boolean }> = []
        for (const s of Array.from(document.querySelectorAll('td [class*="hljs-"], td .diff-line-syntax-raw, td .diff-line-content-raw'))) {
          const td = s.closest('td')!
          const fg = parse(getComputedStyle(s).color)
          const bg = parse(getComputedStyle(td).backgroundColor)
          if (!fg || !bg || bg.a === 0) continue
          out.push({
            cls: Array.from(s.classList).join(' '),
            fg: getComputedStyle(s).color,
            bg: getComputedStyle(td).backgroundColor,
            ratio: Math.round(ratio(fg.rgb, bg.rgb) * 100) / 100,
            receded: td.classList.contains('dimmed-noise') || td.classList.contains('hunk-receded'),
          })
        }
        return out
      })

      expect(rows.length, 'nothing measurable rendered').toBeGreaterThan(20)
      // Full-strength syntax: the rubric's normal-text floor. Receded content:
      // the non-text/large floor, which it clears with room (the unit test pins
      // the exact per-ground numbers).
      const failures = rows.filter((r) => r.ratio < (r.receded ? 3.0 : 4.5))
      expect(failures, `below the floor: ${JSON.stringify(failures, null, 1)}`).toEqual([])
    })
  }
}
