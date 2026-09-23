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

/**
 * Disabled-state opacity — one meaning, one token (plan P1-4a, finished in 2D).
 *
 * The audit found 35 disabled-state opacity rules carrying SEVEN different
 * values (0.35 … 0.85) for one meaning. Batch 2A converted the 14 inside its own
 * fence; Batch 2D converted the rest, per site rather than by sweep, because two
 * of them are a deliberate outlier: `.run-reviewers-btn` and `.tests-review-btn`
 * are `disabled={isRunning}` with aria-busy, so their label is the status
 * message and must stay readable. Those two took --busy-opacity.
 *
 * This guard is what stops the eighth value. It is deliberately stricter than
 * "no literals anywhere": it looks ONLY at rules whose selector is a disabled
 * state, so a hover or a transition keeps its own number.
 */
describe('disabled-state opacity — one token, and the outlier is explicit', () => {
  /** Rule blocks whose selector marks an unavailable control. */
  function disabledRules(css: string): { selector: string; body: string }[] {
    const out: { selector: string; body: string }[] = []
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim().replace(/\s+/g, ' ')
      // `:not(:disabled)` is the INVERSE and must not be swept — it is the
      // enabled state, and 2A's record names that trap by name.
      if (/:not\(\s*:disabled\s*\)/.test(selector)) continue
      if (!/:disabled|\[disabled\]|\.locked\b|\.disabled\b/.test(selector)) continue
      out.push({ selector, body: m[2] })
    }
    return out
  }

  it('no component writes a bare opacity number on a disabled state', () => {
    const offenders: string[] = []
    for (const [file, source] of Object.entries(svelteSources)) {
      const styleMatch = source.match(/<style[^>]*>([\s\S]*?)<\/style>/)
      if (!styleMatch) continue
      for (const { selector, body } of disabledRules(styleMatch[1])) {
        const opacity = body.match(/opacity\s*:\s*([^;}]+)/)
        if (!opacity) continue
        if (!opacity[1].includes('var(--')) {
          offenders.push(`${file} → ${selector} { opacity: ${opacity[1].trim()} }`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the busy outlier is named, not blended away', () => {
    // If a later sweep flattens these onto --disabled-opacity, the user loses
    // sight of a running review. The token exists so that sweep reads an
    // intention; this asserts both sites still carry it.
    const inspect = svelteSources['./InspectStep.svelte']
    expect(inspect, 'InspectStep.svelte is not in the glob').toBeTruthy()
    for (const selector of ['.run-reviewers-btn:disabled', '.tests-review-btn:disabled']) {
      expect(inspect, selector).toMatch(
        new RegExp(`${selector.replace('.', '\\.')}\\s*\\{[^}]*opacity:\\s*var\\(--busy-opacity\\)`),
      )
    }
    // …and nothing else in the app claims to be busy-disabled.
    const claimants = Object.entries(svelteSources).filter(([, s]) =>
      s.includes('var(--busy-opacity)'),
    )
    expect(claimants.map(([f]) => f)).toEqual(['./InspectStep.svelte'])
  })

  it('app.css still owns the three control primitives that carry it', () => {
    // The primitives are where a component gets the behaviour for free; if one
    // of them stopped referencing the token, the per-component guard above
    // would still pass while most of the app quietly lost the treatment.
    for (const selector of ['\\.btn:disabled', 'select:disabled']) {
      const rule = appCss.match(new RegExp(`(^|\\n)${selector}\\s*\\{([^}]*)\\}`))?.[2] ?? ''
      expect(rule, selector).toMatch(/opacity:\s*var\(--disabled-opacity\)/)
    }
    expect(appCss).toMatch(
      /input\[type='checkbox'\]:disabled[\s\S]{0,80}\{[^}]*opacity:\s*var\(--disabled-opacity\)/,
    )
  })
})

/**
 * F18 / this batch — the weight set.
 *
 * The audit found four weights (400, 500, 600, 700) on every surface it
 * measured, and p.34 asks for two. Batch 2D deliberately FROZE this rather than
 * sweeping it, because a blind collapse to 400/600 would have overturned Batch
 * 2A's stated choice of 500 for the 12px secondary .field-label — the one place
 * where weight goes UP because size and colour have both gone down.
 *
 * The decision this batch took, and what these tests encode:
 *
 *   400  body, and anything whose emphasis is already carried by another axis.
 *   600  emphasis.
 *   500  ONLY where BOTH --text-xs and --text-secondary are already in play.
 *
 * That last line is the point. 2A's reasoning was never "500 is nice on
 * labels"; it was "two axes went down, so stroke has to pay some back". Written
 * as a rule it stops BOTH failure modes at once: a future sweep cannot delete
 * 2A's 500, and nobody can spread 500 to a site that has not earned it.
 *
 * SCOPE: app.css and src/components/settings/**, the fence this batch owned.
 * Twenty-odd 500/700 declarations remain in step components and panels; the
 * scaleBaseline ratchet holds those at their current count until a later slice
 * takes them, and the rule above is the one it should apply.
 */
describe('F18 — two weights, plus one named exception', () => {
  const stripCss = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
  const styleOf = (source: string) => source.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? ''

  /** Every `selector { body }` pair, at-rule wrappers skipped. */
  const rulesOf = (css: string) =>
    [...stripCss(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      selector: m[1].trim().replace(/\s+/g, ' '),
      body: m[2],
    }))

  /** Every rule that declares a weight, with the value it declares. */
  const weightRules = (css: string) =>
    rulesOf(css).flatMap((rule) => {
      const value = rule.body.match(/font-weight:\s*([^;]+)/)?.[1]?.trim()
      return value ? [{ ...rule, value }] : []
    })

  const settingsSources = Object.entries(svelteSources).filter(([file]) =>
    file.includes('/settings/'),
  )

  /** app.css plus every settings section, as (label, css) pairs. */
  const fence = (): Array<[string, string]> => [
    ['src/app.css', appCss],
    ...settingsSources.map(([file, source]) => [file, styleOf(source)] as [string, string]),
  ]

  it('the glob really reaches the settings sections', () => {
    // Without this, every assertion below passes vacuously the day the glob
    // pattern changes — the failure mode the elevation allowlist was built to
    // avoid, in a new place.
    expect(settingsSources.length).toBeGreaterThanOrEqual(6)
  })

  it('app.css declares only 400, 500 and 600 — 700 is abolished', () => {
    const values = weightRules(appCss).map((r) => r.value)
    expect(values.length, 'app.css declares no weights at all?').toBeGreaterThan(0)
    expect([...new Set(values)].sort()).toEqual(['400', '500', '600'])
  })

  it('no rule in the fence spells a weight `normal` or `bold`', () => {
    // `normal` IS 400 and `bold` IS 700, so a second spelling is a weight the
    // ratchet cannot count and a reader cannot compare. One spelling per value.
    const offenders: string[] = []
    for (const [file, css] of fence()) {
      for (const rule of weightRules(css)) {
        if (/^(normal|bold|bolder|lighter)$/.test(rule.value)) {
          offenders.push(`${file} → ${rule.selector}: ${rule.value}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('every 500 in the fence sits on text demoted in BOTH size and colour', () => {
    // THE rule. A 500 is legitimate only where --text-xs and --text-secondary
    // are both already doing their part — which is exactly Batch 2A's argument,
    // made checkable so the next batch inherits it instead of re-litigating it.
    const unearned: string[] = []
    for (const [file, css] of fence()) {
      for (const rule of weightRules(css)) {
        if (rule.value !== '500') continue
        const demotedSize = /font-size:\s*var\(--text-xs\)/.test(rule.body)
        const demotedInk = /color:\s*var\(--text-secondary\)/.test(rule.body)
        if (!demotedSize || !demotedInk) {
          unearned.push(
            `${file} → ${rule.selector} (size ${demotedSize ? 'ok' : 'NOT --text-xs'}, ` +
              `ink ${demotedInk ? 'ok' : 'NOT --text-secondary'})`,
          )
        }
      }
    }
    expect(unearned).toEqual([])
  })

  it('the exception is still actually taken, so the rule is not vacuous', () => {
    // The mirror of the test above: if .field / .field-label ever lost their
    // 500, "every 500 is earned" would pass with no 500s left and 2A's finding
    // would evaporate silently. Same shape as the elevation allowlist's
    // "an exemption cannot outlive its exception" guard.
    for (const selector of ['\\.field', '\\.field-label']) {
      const rule = appCss.match(new RegExp(`(^|\\n)${selector}\\s*\\{([^}]*)\\}`))?.[2] ?? ''
      expect(rule, selector).toMatch(/font-weight:\s*500/)
    }
  })

  it('a control is identified by its box, not by its stroke', () => {
    // .btn and .chip both carried 500 at FULL --text ink: weight competing with
    // a border, a fill, padding and a radius that had already done the work
    // (p.44). Pinned at 400 so the demotion cannot quietly creep back.
    for (const selector of ['\\.btn', '\\.chip']) {
      const rule = appCss.match(new RegExp(`(^|\\n)${selector}\\s*\\{([^}]*)\\}`))?.[2] ?? ''
      expect(rule, selector).toMatch(/font-weight:\s*400/)
    }
  })

  it('no settings section declares 700', () => {
    const offenders = settingsSources.flatMap(([file, source]) =>
      weightRules(styleOf(source))
        .filter((r) => r.value === '700')
        .map((r) => `${file} → ${r.selector}`),
    )
    expect(offenders).toEqual([])
  })
})
