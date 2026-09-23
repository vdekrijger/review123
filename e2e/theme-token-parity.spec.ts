/**
 * e2e/theme-token-parity.spec.ts — the two ways to reach a theme must resolve
 * to byte-identical token values.
 *
 * The hazard (audit F17): a user can arrive at light mode two ways —
 *   (1) explicitly, `data-theme="light"` on :root, and
 *   (2) with `auto` (no data-theme) while the OS prefers light.
 * Before Phase 1 those were served by two separate hand-maintained CSS blocks
 * holding 30 byte-identical declarations, so a token added to one and not the
 * other silently diverged between them. Phase 1 collapsed the palette into
 * single `light-dark()` declarations driven by `color-scheme`, which makes that
 * divergence unrepresentable for every colour token.
 *
 * Two tokens still cannot use light-dark(), because it takes <color> and they
 * are not colours: `--select-chevron` (a url()) and `--recede-opacity` (a
 * number). Those ARE still declared twice for dark, so this spec is what keeps
 * them honest.
 *
 * This spec does not take the palette's word for anything. It ENUMERATES every
 * custom property the app declares (so a token added tomorrow is covered
 * without touching this file) and asserts, in a real browser:
 *
 *   explicit light  ==  auto + OS light        (both ways to "light")
 *   explicit dark   ==  auto + OS dark         (both ways to "dark")
 *   explicit light  is independent of the OS preference
 *   explicit dark   is independent of the OS preference
 *   light          !=  dark                    (the switch actually switches)
 *
 * The sibling unit test (src/lib/theme/contrast.test.ts) pins the same property
 * statically from the CSS source; this one proves what the browser actually
 * computes.
 */

import { test, expect, type Page } from '@playwright/test'

type TokenMap = Record<string, { raw: string; resolved: string }>

/**
 * Read every custom property the app declares, in two forms:
 *
 *  - `raw`      — getPropertyValue on :root. For a light-dark() token this is
 *                 the UNRESOLVED pair, which is exactly what we want for the
 *                 non-colour tokens (a url(), a number) that cannot be probed
 *                 as a colour.
 *  - `resolved` — the value a real consumer sees, obtained by assigning
 *                 `color: var(--token)` to a probe element and reading back the
 *                 computed colour. This is the only way to resolve light-dark(),
 *                 which stays unsubstituted in a custom property until used.
 *
 * Comparing BOTH means every token is discriminated by at least one form: the
 * colours by `resolved`, the url()/number tokens by `raw`.
 */
async function readTokens(page: Page): Promise<TokenMap> {
  return page.evaluate(() => {
    // Enumerate the declared property names from the stylesheets themselves, so
    // this spec covers tokens nobody remembered to add to a list.
    const names = new Set<string>()
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList
      try {
        rules = sheet.cssRules
      } catch {
        continue // cross-origin sheet (fonts) — no custom properties of ours
      }
      const walk = (list: CSSRuleList) => {
        for (const rule of Array.from(list)) {
          if ((rule as CSSGroupingRule).cssRules) walk((rule as CSSGroupingRule).cssRules)
          const style = (rule as CSSStyleRule).style
          if (!style) continue
          for (const prop of Array.from(style)) {
            if (prop.startsWith('--')) names.add(prop)
          }
        }
      }
      walk(rules)
    }

    const root = document.documentElement
    const rootStyle = getComputedStyle(root)
    const probe = document.createElement('span')
    root.appendChild(probe)

    const out: Record<string, { raw: string; resolved: string }> = {}
    for (const name of Array.from(names).sort()) {
      probe.style.color = ''
      probe.style.color = `var(${name})`
      out[name] = {
        raw: rootStyle.getPropertyValue(name).trim(),
        // When the token is not a valid <color> this falls back to the inherited
        // colour — identical in both paths, so it simply does not discriminate
        // and `raw` carries the signal instead.
        resolved: getComputedStyle(probe).color,
      }
    }
    probe.remove()
    return out
  })
}

/** Snapshot the palette under one (OS preference, explicit theme) combination. */
async function snapshot(
  page: Page,
  os: 'light' | 'dark',
  explicit: 'light' | 'dark' | null,
): Promise<TokenMap> {
  await page.emulateMedia({ colorScheme: os })
  await page.evaluate((theme) => {
    // Exactly what applyAppearance() does: explicit value sets the attribute,
    // 'auto' removes it.
    if (theme) document.documentElement.setAttribute('data-theme', theme)
    else document.documentElement.removeAttribute('data-theme')
  }, explicit)
  return readTokens(page)
}

test('both ways to reach a theme resolve to identical token values', async ({ page }) => {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
  await page.goto('/')
  await expect(page.locator('#app')).toBeVisible()

  // Sanity: the enumeration found a real palette, not an empty set. Guards
  // against this whole spec silently passing on zero tokens.
  const probeTokens = await readTokens(page)
  const paletteTokens = Object.keys(probeTokens).filter((n) => !n.startsWith('--font'))
  expect(paletteTokens.length).toBeGreaterThan(25)
  for (const required of ['--bg', '--surface', '--text', '--accent', '--on-accent']) {
    expect(Object.keys(probeTokens)).toContain(required)
  }

  const explicitLightOnLightOs = await snapshot(page, 'light', 'light')
  const explicitLightOnDarkOs = await snapshot(page, 'dark', 'light')
  const explicitDarkOnLightOs = await snapshot(page, 'light', 'dark')
  const explicitDarkOnDarkOs = await snapshot(page, 'dark', 'dark')
  const autoOnLightOs = await snapshot(page, 'light', null)
  const autoOnDarkOs = await snapshot(page, 'dark', null)

  // 1. The F17 hazard itself: explicit light and OS-preference light are the
  //    same palette, token for token.
  expect(autoOnLightOs).toEqual(explicitLightOnLightOs)

  // 2. The same guarantee for dark.
  expect(autoOnDarkOs).toEqual(explicitDarkOnDarkOs)

  // 3. An explicit choice overrides the OS preference completely — picking
  //    "light" on a dark-preferring machine must give the identical palette to
  //    picking "light" on a light-preferring one.
  expect(explicitLightOnDarkOs).toEqual(explicitLightOnLightOs)
  expect(explicitDarkOnLightOs).toEqual(explicitDarkOnDarkOs)

  // 4. …and the switch genuinely switches, so none of the above passes by the
  //    palette being theme-independent. Checked on the tokens that must differ.
  for (const token of ['--bg', '--surface', '--text', '--accent', '--on-accent', '--select-chevron']) {
    expect(
      explicitLightOnLightOs[token],
      `${token} must differ between light and dark`,
    ).not.toEqual(explicitDarkOnDarkOs[token])
  }
})
