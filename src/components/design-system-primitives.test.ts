/**
 * Design-system primitive guards (static CSS assertions).
 *
 * Two visual bugs these tests pin down:
 *
 * 1. Double chevron on <details>/<summary> sections.
 *    app.css owns the collapsible marker: it hides the native marker and draws
 *    ONE triangle via `details > summary::before`. When a component ALSO declares
 *    `content:` on a summary ::before, the cascade merges both rules onto the same
 *    pseudo-element (component `content` glyph + global border-triangle props),
 *    rendering two chevrons. Components must therefore never set `content:` on a
 *    summary ::before/::after — the global pattern is the single source of truth.
 *
 * 2. Unstyled native <select> dropdowns.
 *    The global select primitive must opt out of native appearance and supply a
 *    themed chevron, so every dropdown matches the Reading Instrument system
 *    without per-component copies.
 */
import { describe, it, expect } from 'vitest'
import appCss from '../app.css?raw'

// Raw source of every component in the app, keyed by path.
const svelteSources = import.meta.glob('../**/*.svelte', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

describe('details/summary marker — single source of truth', () => {
  it('app.css defines exactly one global summary triangle', () => {
    const markers = appCss.match(/details\s*>\s*summary::before/g) ?? []
    expect(markers).toHaveLength(1) // single base rule draws the triangle
    expect(appCss).toMatch(/details\[open\]\s*>\s*summary::before\s*\{[^}]*rotate\(90deg\)/)
    expect(appCss).toMatch(/details\s*>\s*summary::-webkit-details-marker\s*\{\s*display:\s*none/)
    expect(appCss).toMatch(/details\s*>\s*summary\s*\{[^}]*list-style:\s*none/)
  })

  it('no component declares its own summary ::before/::after content (double-chevron guard)', () => {
    const offenders: string[] = []
    for (const [file, source] of Object.entries(svelteSources)) {
      const styleMatch = source.match(/<style[^>]*>([\s\S]*?)<\/style>/)
      if (!styleMatch) continue
      const css = styleMatch[1]
      // Any rule whose selector touches a summary pseudo-element and sets content:
      const ruleRe = /([^{}]*summary[^{}]*::(?:before|after)[^{}]*)\{([^}]*)\}/g
      let m: RegExpExecArray | null
      while ((m = ruleRe.exec(css)) !== null) {
        if (/content\s*:/.test(m[2])) offenders.push(`${file} → ${m[1].trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('select primitive — themed dropdown', () => {
  it('app.css opts selects out of native appearance and draws a themed chevron', () => {
    const selectRules = [...appCss.matchAll(/(^|\n)select\s*\{([^}]*)\}/g)].map(m => m[2])
    const combined = selectRules.join('\n')
    expect(combined).toMatch(/appearance:\s*none/)
    expect(combined).toMatch(/background-image:\s*var\(--select-chevron\)/)
    expect(combined).toMatch(/text-overflow:\s*ellipsis/)
    // chevron token must exist for dark (default), explicit light, and auto-light
    const chevronDefs = appCss.match(/--select-chevron:/g) ?? []
    expect(chevronDefs.length).toBeGreaterThanOrEqual(3)
  })

  it('no component re-declares the select chrome (background/border belong to the primitive)', () => {
    const offenders: string[] = []
    for (const [file, source] of Object.entries(svelteSources)) {
      const styleMatch = source.match(/<style[^>]*>([\s\S]*?)<\/style>/)
      if (!styleMatch) continue
      const ruleRe = /([^{}]*select[^{}]*)\{([^}]*)\}/g
      let m: RegExpExecArray | null
      while ((m = ruleRe.exec(styleMatch[1])) !== null) {
        const selector = m[1].trim()
        // only selectors actually targeting a <select> element or *-select class
        if (!/(^|[\s>+~(])select\b|-select\b/.test(selector)) continue
        if (/(^|[^-])(background|border)\s*:/.test(m[2])) {
          offenders.push(`${file} → ${selector}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

/**
 * Elevation primitive — the scale is the only source of depth (audit F10).
 *
 * Before Batch 2B, elevation was a per-component improvisation: 16 non-focus
 * box-shadow declarations with 9 hand-picked values, every alpha chosen against
 * the dark ground. app.css now owns a five-step scale plus a drawer variant
 * (see :root, and src/lib/theme/contrast.test.ts for the measurements). The
 * point of a scale is that nobody hand-picks the tenth value, so this guard
 * fails the moment a component writes a raw shadow of its own.
 */
describe('elevation primitive — one scale, no bespoke shadows', () => {
  /**
   * EMPTY, and it should stay that way.
   *
   * Batch 2B shipped this guard with two exemptions, each a call site outside
   * its own fence: ContextRail (taken by Batch 2C, onto --elevation-drawer) and
   * settings/ModelCombobox (taken by Batch 2A, onto --elevation-4). Every
   * box-shadow in the app now comes from the scale, so the guard below is
   * unconditional. DELETE an entry here as its batch converts it — never add one.
   */
  const DEFERRED_TO_A_LATER_BATCH: string[] = []

  it('no component hand-picks a raw black shadow', () => {
    const offenders: string[] = []
    for (const [file, source] of Object.entries(svelteSources)) {
      if (DEFERRED_TO_A_LATER_BATCH.includes(file)) continue
      const styleMatch = source.match(/<style[^>]*>([\s\S]*?)<\/style>/)
      if (!styleMatch) continue
      for (const m of styleMatch[1].matchAll(/box-shadow\s*:\s*([^;]+);/g)) {
        // An rgba() of pure black is the F10 signature: a shadow ink picked by
        // hand instead of taken from --shadow-tight/--shadow-soft/--shadow-faint.
        if (/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/.test(m[1])) {
          offenders.push(`${file} → box-shadow: ${m[1].trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the deferred list is empty — every shadow now comes from the scale', () => {
    // Batch 2A converted the last entry (settings/ModelCombobox). Re-opening the
    // allowlist should be a deliberate act with a failing test to justify it,
    // not something a component can slip past by being added to a list.
    expect(DEFERRED_TO_A_LATER_BATCH).toEqual([])
  })

  it('the deferred list names only files that really do still carry one', () => {
    // Stops the allowlist from outliving the exception it documents.
    for (const file of DEFERRED_TO_A_LATER_BATCH) {
      const source = svelteSources[file]
      expect(source, `${file} is listed as deferred but does not exist`).toBeTruthy()
      expect(source, `${file} no longer needs its exemption — remove it`).toMatch(
        /box-shadow\s*:[^;]*rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/,
      )
    }
  })

  it('app.css gives the card and the modal a real elevation', () => {
    const rule = (selector: string) =>
      appCss.match(new RegExp(`(^|\\n)${selector}\\s*\\{([^}]*)\\}`))?.[2] ?? ''
    // A modal with no shadow is the one case p.159-160 treats as
    // non-negotiable, and dialog had none at all before Batch 2B.
    expect(rule('dialog')).toMatch(/box-shadow:\s*var\(--elevation-5\)/)
    expect(rule('\\.card')).toMatch(/box-shadow:\s*var\(--elevation-1\)/)
    // Both drop the rim in LIGHT, where the shadow measures 1.58:1 against the
    // page and beats the 1.33:1 border outright, and keep it in DARK, where a
    // black shadow cannot exceed 1.08:1 at any alpha. The measurements behind
    // that split are asserted in src/lib/theme/contrast.test.ts; this only
    // pins that both primitives express it the same way and neither has
    // quietly gone back to an unconditional border.
    for (const selector of ['dialog', '\\.card']) {
      expect(rule(selector), selector).toMatch(
        /border:\s*1px solid light-dark\(\s*transparent\s*,\s*var\(--hairline\)\s*\)/,
      )
    }
  })

  it('a chip takes no elevation — it is a label, not an object (p.158)', () => {
    const chip = appCss.match(/(^|\n)\.chip\s*\{([^}]*)\}/)?.[2] ?? ''
    expect(chip).toMatch(/box-shadow:\s*none/)
    // …and carries the flat depth cue instead: an un-set chip recedes.
    expect(chip).toMatch(/background:\s*var\(--surface-sunken\)/)
  })
})
