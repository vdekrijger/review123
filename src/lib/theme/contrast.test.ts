/**
 * src/lib/theme/contrast.test.ts — the palette's contrast floors, as a gate.
 *
 * The UI audit (docs/design/ui-audit.md) measured every token pair by hand and
 * found nine WCAG failures, all but one of them light-only — the signature of a
 * palette that was authored against the dark ground and merely re-mapped for
 * light. Phase 1 inverted that: light is now the authored palette and dark is
 * derived. This file is what stops the audit from being needed a second time.
 *
 * It reads the REAL token values straight out of src/app.css — not a copy — so
 * it cannot drift from what ships, and computes WCAG 2.1 relative-luminance
 * ratios, compositing rgba() tints and opacity over their real ground first
 * (exactly the method Appendix A of the audit used).
 *
 * Floors (p.142, SC 1.4.11):
 *   4.5:1  normal text
 *   3.0:1  large text and non-text UI boundaries
 *
 * Phase 2 and Phase 3 are meant to trust these tokens. That is only safe if a
 * value change that breaks a floor turns CI red, which is what this file buys.
 */
import { describe, it, expect } from 'vitest'
import appCss from '../../app.css?raw'

// ---------------------------------------------------------------------------
// Colour maths (WCAG 2.1)
// ---------------------------------------------------------------------------

type Rgb = [number, number, number]

/** Parse #rgb, #rrggbb, #rrggbbaa or rgb()/rgba() into 0-255 channels + alpha. */
function parseColor(value: string): { rgb: Rgb; alpha: number } {
  const v = value.trim()

  const fn = v.match(/^rgba?\(([^)]+)\)$/i)
  if (fn) {
    const parts = fn[1].split(/[,/]/).map((p) => parseFloat(p.trim()))
    return { rgb: [parts[0], parts[1], parts[2]], alpha: parts.length > 3 ? parts[3] : 1 }
  }

  const hexMatch = v.match(/^#([0-9a-f]{3,8})$/i)
  if (!hexMatch) throw new Error(`cannot parse colour: ${value}`)
  let h = hexMatch[1]
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('')
  const ch = (i: number) => parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return { rgb: [ch(0), ch(1), ch(2)], alpha: h.length === 8 ? ch(3) / 255 : 1 }
}

/** Composite a (possibly translucent) colour over an opaque ground. */
function composite(fg: string, ground: Rgb, extraAlpha = 1): Rgb {
  const { rgb, alpha } = parseColor(fg)
  const a = alpha * extraAlpha
  return rgb.map((c, i) => c * a + ground[i] * (1 - a)) as Rgb
}

function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function ratio(a: Rgb, b: Rgb): number {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)]
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

/** Contrast of `fg` (composited if translucent) against an opaque `bg` token. */
function contrast(fg: string, bg: string, fgOpacity = 1): number {
  const ground = composite(bg, [255, 255, 255])
  return ratio(composite(fg, ground, fgOpacity), ground)
}

const round2 = (n: number) => Math.round(n * 100) / 100

// ---------------------------------------------------------------------------
// Parsing the real tokens out of src/app.css
// ---------------------------------------------------------------------------

/** Strip /* *​/ comments — the palette's prose contains braces that would
 *  otherwise break brace matching. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Split a comma-separated argument list, respecting nested parentheses. */
function splitArgs(input: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of input) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(current)
      current = ''
    } else current += ch
  }
  out.push(current)
  return out.map((s) => s.trim())
}

/** The body of the first `:root { … }` rule, with comments removed. */
function rootBlock(css: string): string {
  const clean = stripComments(css)
  const start = clean.indexOf(':root {')
  const open = clean.indexOf('{', start)
  let depth = 0
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === '{') depth++
    else if (clean[i] === '}') {
      depth--
      if (depth === 0) return clean.slice(open + 1, i)
    }
  }
  throw new Error(':root block not found in app.css')
}

/** Every `--name: value;` declaration in a block, in source order. */
function declarations(block: string): Array<[string, string]> {
  return [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(
    ([, name, value]) => [name, value.trim()] as [string, string],
  )
}

/**
 * Resolve the palette for one theme: unwrap `light-dark(a, b)` to the requested
 * side, and follow `var(--other)` aliases.
 */
function palette(theme: 'light' | 'dark'): Record<string, string> {
  const raw = Object.fromEntries(declarations(rootBlock(appCss)))

  // Dark overrides the two tokens light-dark() cannot carry.
  if (theme === 'dark') {
    for (const [name, value] of darkOverrideDeclarations()) raw[name] = value
  }

  const pick = (value: string): string => {
    const ld = value.match(/^light-dark\(([\s\S]*)\)$/)
    if (ld) {
      const [light, dark] = splitArgs(ld[1])
      return theme === 'light' ? light : dark
    }
    return value
  }

  const resolved: Record<string, string> = {}
  const resolve = (name: string, seen = new Set<string>()): string => {
    if (resolved[name]) return resolved[name]
    if (seen.has(name)) throw new Error(`circular token alias: ${name}`)
    seen.add(name)
    const value = pick(raw[name])
    const alias = value.match(/^var\((--[\w-]+)\)$/)
    const out = alias ? resolve(alias[1], seen) : value
    resolved[name] = out
    return out
  }
  for (const name of Object.keys(raw)) resolve(name)
  return resolved
}

/** Custom-property declarations from the explicit-dark override rule. */
function darkOverrideDeclarations(): Array<[string, string]> {
  const clean = stripComments(appCss)
  const rules = [...clean.matchAll(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/g)]
  return rules.flatMap((m) => declarations(m[1]))
}

/** Custom-property declarations from the auto-dark (media query) override rule. */
function autoDarkOverrideDeclarations(): Array<[string, string]> {
  const clean = stripComments(appCss)
  const media = clean.match(
    /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/,
  )
  return media ? declarations(media[1]) : []
}

const LIGHT = palette('light')
const DARK = palette('dark')
const THEMES = { light: LIGHT, dark: DARK } as const

// The grounds a text token can land on.
const GROUNDS = ['--bg', '--surface', '--surface-sunken'] as const

/**
 * The diff viewer's OWN grounds and ink, harvested from the vendored dependency
 * (node_modules/@git-diff-view/svelte/dist/css/diff-view.css) rather than from
 * our palette — because that is what `--recede-opacity` actually dims today.
 *
 * The viewer ships GitHub's palette, not the app's (audit F5): it paints plain
 * #ffffff / #000000 body ink, not --text. Phase 3 re-points these at the app's
 * tokens; until then, measuring against --text would flatter the result. When
 * Phase 3 lands, update these constants (or delete them in favour of the real
 * tokens) — this comment is the breadcrumb.
 */
const DIFF_GROUNDS = {
  light: { ink: '#000000', context: '#ffffff', added: '#dafbe1', removed: '#ffebe9' },
  dark: { ink: '#ffffff', context: '#0d1117', added: '#18271f', removed: '#23191c' },
} as const

// ---------------------------------------------------------------------------

describe('palette parsing', () => {
  it('finds a complete palette for both themes', () => {
    for (const [name, tokens] of Object.entries(THEMES)) {
      expect(Object.keys(tokens).length, `${name} token count`).toBeGreaterThan(25)
      for (const required of ['--bg', '--surface', '--text', '--accent', '--on-accent']) {
        expect(tokens[required], `${name} ${required}`).toBeTruthy()
      }
    }
  })

  it('light and dark actually differ (the light-dark() pairs are real)', () => {
    for (const token of ['--bg', '--surface', '--text', '--accent', '--on-accent']) {
      expect(LIGHT[token], token).not.toBe(DARK[token])
    }
  })
})

/**
 * P1-1 — the last copy of the F17 hazard.
 *
 * Every colour token is a single light-dark() declaration and cannot diverge.
 * The two non-colour tokens are still written out for both dark paths, so pin
 * them here. e2e/theme-token-parity.spec.ts proves the same property for EVERY
 * token in a real browser.
 */
describe('P1-1 — the two dark paths declare identical values', () => {
  it('explicit dark and auto-dark carry the same non-colour tokens', () => {
    const explicit = darkOverrideDeclarations()
    const auto = autoDarkOverrideDeclarations()

    expect(auto.length, 'auto-dark override block is missing').toBeGreaterThan(0)
    expect(auto).toEqual(explicit)
  })

  it('no light palette block survives — light is the :root default', () => {
    const clean = stripComments(appCss)
    expect(clean).not.toMatch(/@media\s*\(prefers-color-scheme:\s*light\)/)
    const lightRules = [...clean.matchAll(/:root\[data-theme='light'\]\s*\{([^}]*)\}/g)]
    for (const rule of lightRules) {
      expect(declarations(rule[1]), 'light rules must only set color-scheme').toEqual([])
    }
  })

  it('every theme-dependent colour is a light-dark() pair, not a second block', () => {
    const colourTokens = declarations(rootBlock(appCss)).filter(([, v]) =>
      /^#|^rgba?\(/.test(v),
    )
    // A bare colour in :root would be theme-independent — legitimate only if it
    // really is the same in both themes. Today there are none.
    expect(colourTokens.map(([n]) => n)).toEqual([])
  })
})

describe('text tiers clear AA on every ground', () => {
  for (const [themeName, tokens] of Object.entries(THEMES)) {
    for (const ink of ['--text', '--text-secondary', '--text-muted'] as const) {
      for (const ground of GROUNDS) {
        it(`${themeName}: ${ink} on ${ground} >= 4.5`, () => {
          const r = contrast(tokens[ink], tokens[ground])
          expect(round2(r), `measured ${round2(r)}`).toBeGreaterThanOrEqual(4.5)
        })
      }
    }
  }
})

describe('F3 — --accent is a legal text colour in BOTH themes', () => {
  for (const [themeName, tokens] of Object.entries(THEMES)) {
    for (const ground of GROUNDS) {
      it(`${themeName}: --accent as text on ${ground} >= 4.5`, () => {
        const r = contrast(tokens['--accent'], tokens[ground])
        expect(round2(r), `measured ${round2(r)}`).toBeGreaterThanOrEqual(4.5)
      })
    }

    it(`${themeName}: --accent on its own --accent-subtle tint >= 3.0`, () => {
      // The settings nav's active item: accent text on the subtle tint over --bg.
      const ground = composite(tokens['--accent-subtle'], composite(tokens['--bg'], [255, 255, 255]))
      const r = ratio(composite(tokens['--accent'], ground), ground)
      expect(round2(r), `measured ${round2(r)}`).toBeGreaterThanOrEqual(3.0)
    })
  }
})

describe('F1/F2 — --on-accent carries the accent fill in both themes', () => {
  for (const [themeName, tokens] of Object.entries(THEMES)) {
    it(`${themeName}: --on-accent on --accent >= 4.5`, () => {
      const r = contrast(tokens['--on-accent'], tokens['--accent'])
      expect(round2(r), `measured ${round2(r)}`).toBeGreaterThanOrEqual(4.5)
    })

    it(`${themeName}: --accent as a fill stands off --surface >= 3.0`, () => {
      const r = contrast(tokens['--accent'], tokens['--surface'])
      expect(round2(r), `measured ${round2(r)}`).toBeGreaterThanOrEqual(3.0)
    })

    it(`${themeName}: --accent-contrast is an alias of --on-accent, not a rival`, () => {
      expect(tokens['--accent-contrast']).toBe(tokens['--on-accent'])
    })
  }

  it('dark --on-accent repairs the 2.47:1 white fallback it replaces', () => {
    // The regression this token exists to fix: six call sites said
    // var(--on-accent, #fff) while --on-accent was undefined.
    expect(round2(contrast('#ffffff', DARK['--accent']))).toBeLessThan(3)
    expect(round2(contrast(DARK['--on-accent'], DARK['--accent']))).toBeGreaterThanOrEqual(7)
  })
})

describe('F11 — --border-control meets the non-text boundary floor', () => {
  for (const [themeName, tokens] of Object.entries(THEMES)) {
    for (const ground of GROUNDS) {
      it(`${themeName}: --border-control on ${ground} >= 3.0`, () => {
        const r = contrast(tokens['--border-control'], tokens[ground])
        expect(round2(r), `measured ${round2(r)}`).toBeGreaterThanOrEqual(3.0)
      })
    }

    it(`${themeName}: --hairline stays decorative (below the control floor)`, () => {
      // Not a failure — a guard that the two roles stay separate tokens. If a
      // hairline ever reaches 3:1 it is no longer a hairline.
      const r = contrast(tokens['--hairline'], tokens['--surface'])
      expect(round2(r), `measured ${round2(r)}`).toBeLessThan(3.0)
    })
  }
})

describe('F16 — status chip inks clear AA on their own tint', () => {
  for (const [themeName, tokens] of Object.entries(THEMES)) {
    for (const status of ['added', 'removed', 'changed', 'unchanged'] as const) {
      it(`${themeName}: ${status} chip >= 4.5`, () => {
        const r = contrast(tokens[`--legend-${status}-color`], tokens[`--legend-${status}-bg`])
        expect(round2(r), `measured ${round2(r)}`).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})

/**
 * P1-4 — the recede token.
 *
 * Floor is 3:1, not 4.5:1: receded rows are de-emphasised content the reader can
 * restore by hovering, and the rubric's non-text/large floor is the honest bar
 * for them. The pre-Phase-1 light value (0.45) did not even clear that.
 */
describe('F4 — --recede-opacity keeps receded code legible on every diff ground', () => {
  for (const themeName of ['light', 'dark'] as const) {
    const alpha = parseFloat(THEMES[themeName]['--recede-opacity'])
    const { ink, ...grounds } = DIFF_GROUNDS[themeName]

    it(`${themeName}: --recede-opacity is a number in (0,1)`, () => {
      expect(Number.isFinite(alpha)).toBe(true)
      expect(alpha).toBeGreaterThan(0)
      expect(alpha).toBeLessThan(1)
    })

    for (const [groundName, ground] of Object.entries(grounds)) {
      it(`${themeName}: receded ink on the ${groundName} line >= 3.0`, () => {
        const r = contrast(ink, ground, alpha)
        expect(round2(r), `measured ${round2(r)}`).toBeGreaterThanOrEqual(3.0)
      })
    }
  }

  it('the two themes recede to within 0.3 of each other on the context line', () => {
    // The point of tokenising: light must not be visibly harsher than dark.
    const at = (t: 'light' | 'dark') =>
      contrast(DIFF_GROUNDS[t].ink, DIFF_GROUNDS[t].context, parseFloat(THEMES[t]['--recede-opacity']))
    expect(Math.abs(at('light') - at('dark'))).toBeLessThanOrEqual(0.3)
  })

  it('documents the limit: alpha cannot rescue COLOURED syntax (Phase 3)', () => {
    // Recorded as a test so the limitation is not quietly forgotten. Even at an
    // alpha that no longer reads as receded, the light comment token misses 3:1
    // — which is why Phase 3 substitutes a single muted ink instead.
    const lightComment = '#6a737d'
    expect(contrast(lightComment, DIFF_GROUNDS.light.context, 0.7)).toBeLessThan(3.0)
  })
})

/**
 * F10 / Batch 2B — the elevation scale.
 *
 * The audit's finding was not "the shadows are wrong", it was "there is no
 * scale": 16 non-focus box-shadow declarations carrying 9 hand-picked values,
 * every alpha chosen against the dark ground. These assertions pin the two
 * things that can silently rot — the shape of the scale, and the fact that its
 * light ramp is genuinely light-appropriate rather than dark values re-used.
 */
describe('F10 — the elevation scale', () => {
  const root = Object.fromEntries(declarations(rootBlock(appCss)))
  const STEPS = ['--elevation-1', '--elevation-2', '--elevation-3', '--elevation-4', '--elevation-5'] as const
  const INKS = ['--shadow-tight', '--shadow-soft', '--shadow-faint'] as const

  it('is a fixed scale of five steps plus one drawer variant (p.160-161)', () => {
    for (const step of [...STEPS, '--elevation-drawer']) {
      expect(root[step], `${step} is missing`).toBeTruthy()
    }
    // Nobody has quietly added a sixth step instead of reusing one.
    const declared = Object.keys(root).filter((n) => n.startsWith('--elevation-'))
    expect(declared.sort()).toEqual([...STEPS, '--elevation-drawer'].sort())
  })

  it('every step is a TWO-part shadow built only from the scale inks (p.163-165)', () => {
    for (const step of [...STEPS, '--elevation-drawer']) {
      const parts = splitArgs(root[step])
      expect(parts, `${step} must be two shadows, not one`).toHaveLength(2)
      for (const part of parts) {
        const ref = part.match(/var\((--shadow-[\w-]+)\)/)
        expect(ref, `${step}: "${part}" must take its colour from a scale ink`).toBeTruthy()
        expect(INKS as readonly string[]).toContain(ref![1])
      }
    }
  })

  it('the tight ambient part fades out as the element rises (p.165-166)', () => {
    // Steps 1-2 sit close to the page and keep the firm ambient part; 3-5 are
    // far enough off it that the contact shadow has to fade.
    const tightPartOf = (step: string) => splitArgs(root[step])[0]
    expect(tightPartOf('--elevation-1')).toContain('var(--shadow-tight)')
    expect(tightPartOf('--elevation-2')).toContain('var(--shadow-tight)')
    for (const step of ['--elevation-3', '--elevation-4', '--elevation-5']) {
      expect(tightPartOf(step), step).toContain('var(--shadow-faint)')
    }
  })

  it("the soft part follows the rubric's reference ramp verbatim (p.161)", () => {
    const softGeometry = (step: string) =>
      splitArgs(root[step])[1].replace(/\s*var\(--shadow-[\w-]+\)\s*/, '').trim()
    expect(STEPS.map(softGeometry)).toEqual([
      '0 1px 3px',
      '0 4px 6px',
      '0 5px 15px',
      '0 10px 24px',
      '0 15px 35px',
    ])
  })

  it('a drawer casts SIDEWAYS, not down — it is anchored to a screen edge', () => {
    for (const part of splitArgs(LIGHT['--elevation-drawer'] ?? root['--elevation-drawer'])) {
      const [x, y] = part.trim().split(/\s+/)
      expect(parseFloat(x), `x offset of "${part}"`).toBeLessThan(0)
      expect(parseFloat(y), `y offset of "${part}"`).toBe(0)
    }
  })

  it('the ramp is ordered: tight is firmer than soft, soft firmer than faint', () => {
    for (const [themeName, tokens] of Object.entries(THEMES)) {
      const weight = (ink: string) => contrast(tokens[ink], tokens['--bg'])
      expect(weight('--shadow-tight'), `${themeName} tight vs soft`).toBeGreaterThan(weight('--shadow-soft'))
      expect(weight('--shadow-soft'), `${themeName} soft vs faint`).toBeGreaterThan(weight('--shadow-faint'))
    }
  })

  /**
   * THE reason the alphas are theme-dependent. A shadow's weight is the
   * luminance drop it makes in ITS OWN ground, and the nine values Batch 2B
   * replaced were all picked against #14161a. Re-measured on each page ground,
   * the same declaration is nearly three times heavier in light — which is what
   * made the light page read as sooty. This is the mutation guard: paste a dark
   * alpha into the light ramp and this turns red.
   */
  it('proves the old dark-chosen alphas were wrong for light', () => {
    const asDarkChose = 'rgba(0,0,0,.40)' // the heaviest of the nine it replaced
    const inLight = contrast(asDarkChose, LIGHT['--bg'])
    const inDark = contrast(asDarkChose, DARK['--bg'])
    expect(round2(inLight)).toBeGreaterThan(2.5) // sooty
    expect(round2(inDark)).toBeLessThan(1.1) // barely there
    expect(inLight / inDark).toBeGreaterThan(2.5)
  })

  it('the light ramp lands in the visible-but-not-sooty band on its own ground', () => {
    // Floor: a shadow nobody can see is not separation (p.207). Ceiling: well
    // below the 2.83:1 mark the old 0.40 black left on this same ground.
    const tight = contrast(LIGHT['--shadow-tight'], LIGHT['--bg'])
    expect(round2(tight), `measured ${round2(tight)}`).toBeGreaterThan(1.15)
    expect(round2(tight), `measured ${round2(tight)}`).toBeLessThan(1.6)
  })

  it('the dark ramp stays inside the 0.18-0.40 envelope it already had', () => {
    // No dark surface gains or loses a shadow it did not have: the whole dark
    // ramp sits between the lightest and heaviest values Batch 2B replaced.
    const floor = contrast('rgba(0,0,0,.18)', DARK['--bg'])
    const ceiling = contrast('rgba(0,0,0,.40)', DARK['--bg'])
    for (const ink of INKS) {
      const r = contrast(DARK[ink], DARK['--bg'])
      expect(r, `${ink} measured ${round2(r)}`).toBeLessThanOrEqual(ceiling)
    }
    expect(contrast(DARK['--shadow-tight'], DARK['--bg'])).toBeGreaterThan(floor * 0.9)
  })

  /**
   * THE reason .card, dialog, .glance-card and .detail-panel[open] drop their
   * border in light and KEEP it in dark.
   *
   * p.206-209 says separate with space, a background shift or a shadow before
   * reaching for another border. Measured against this app's real grounds, that
   * holds in light and fails in dark — and the failure is physical, not a
   * tuning problem: a black shadow has nowhere to cast on a near-black ground,
   * so it tops out around 1.07:1 even at the heaviest alpha the app ever used.
   * That is very likely WHY the nine replaced values kept climbing toward 0.40
   * without ever separating anything.
   *
   * Shipping "drop the border" in both themes would therefore have traded a
   * 1.31:1 rim for a 1.08:1 shadow in dark — a regression dressed as a
   * principle. These two assertions are what make that trade-off visible to
   * whoever edits the scale next.
   */
  it('light: the shadow BEATS the border it replaces, so the border goes', () => {
    const border = contrast(LIGHT['--hairline'], LIGHT['--bg'])
    const shadowCore = contrast(LIGHT['--shadow-tight'], LIGHT['--bg'])
    expect(round2(border), `hairline measured ${round2(border)}`).toBeLessThan(1.4)
    expect(shadowCore, `shadow ${round2(shadowCore)} vs border ${round2(border)}`)
      .toBeGreaterThan(border * 0.95)
  })

  it('dark: NO alpha lets a shadow beat the border, so the border stays', () => {
    const border = contrast(DARK['--hairline'], DARK['--surface'])
    // Not just our alphas — the whole usable range, including the heaviest
    // value the app ever shipped. Every one of them loses to the rim.
    for (const alpha of [0.2, 0.3, 0.4, 0.5, 0.6]) {
      const r = contrast(`rgba(0,0,0,${alpha})`, DARK['--bg'])
      expect(r, `black @${alpha} measured ${round2(r)}`).toBeLessThan(border)
    }
  })
})

/**
 * P1-5 / Batch 2B — the flat-design depth cue (p.167-168, rubric quick-scan 11).
 *
 * "Make an element lighter than its background to bring it forward, darker to
 * push it back." The audit's complaint was that --surface-raised was DARKER
 * than both grounds while being used for raised things — the name and the
 * optics disagreed. Phase 1 renamed it --surface-sunken; these assertions are
 * what stop a later batch from re-introducing the contradiction.
 */
describe('P1-5 — forward surfaces are lighter than their ground, wells darker', () => {
  const lum = (token: string) => relativeLuminance(composite(token, [255, 255, 255]))

  it('light: --surface comes FORWARD off --bg', () => {
    expect(lum(LIGHT['--surface'])).toBeGreaterThan(lum(LIGHT['--bg']))
  })

  it('light: --surface-sunken RECEDES behind --bg, as its name says', () => {
    expect(lum(LIGHT['--surface-sunken'])).toBeLessThan(lum(LIGHT['--bg']))
  })

  it('dark: --surface still comes FORWARD off --bg', () => {
    expect(lum(DARK['--surface'])).toBeGreaterThan(lum(DARK['--bg']))
  })

  /**
   * MEASURED AND LEFT ALONE, deliberately.
   *
   * In dark, --surface-sunken (#22262d) is LIGHTER than --surface (#1b1e24) and
   * lighter than --bg — the opposite of the direction it takes in light. That is
   * not an oversight: on a dark ground, "add light to raise, remove light to
   * recede" has nowhere to go downward, so every dark UI (this one included)
   * signals depth by ADDING light in both directions and lets proximity and
   * shadow carry the sign. The token's job is "the second surface", and both
   * themes deliver that; only the arithmetic sign differs.
   *
   * Batch 2B's brief forbids changing a settled palette value, so this is
   * recorded as a measurement rather than repaired. Anything that wants the
   * literal p.167-168 direction in BOTH themes needs a separate --surface-well
   * value for dark, which is a token decision, not a component one.
   */
  it('dark: the well is lighter than the card — recorded, not repaired', () => {
    expect(lum(DARK['--surface-sunken'])).toBeGreaterThan(lum(DARK['--surface']))
    expect(lum(DARK['--surface-sunken'])).toBeGreaterThan(lum(DARK['--bg']))
  })

  it('--surface-raised is still only a deprecated alias, never a third value', () => {
    for (const [themeName, tokens] of Object.entries(THEMES)) {
      expect(tokens['--surface-raised'], themeName).toBe(tokens['--surface-sunken'])
    }
  })
})

/**
 * F11 / Batch 2A — the control boundary is CONSUMED, not merely defined.
 *
 * Phase 1 added --border-control and gated its ratio, but nothing pointed at
 * it: every input, select, textarea, checkbox and button still drew its edge
 * with --hairline at 1.19-1.43:1. A field's own fill stands 1.06:1 off the page
 * it sits on, so that line was the whole control. SC 1.4.11 asks 3:1.
 *
 * The ratios themselves are already asserted above; these pin the two things
 * that can rot afterwards — that the two tokens stay two ROLES, and that the
 * primitives actually reference the right one.
 */
describe('F11 — the two border roles stay two tokens', () => {
  const root = Object.fromEntries(declarations(rootBlock(appCss)))

  for (const [themeName, tokens] of Object.entries(THEMES)) {
    for (const ground of GROUNDS) {
      it(`${themeName}: --border-control beats --hairline on ${ground} by 2x`, () => {
        // A clear margin, not a tie: if a re-tone ever brings them within 2x of
        // each other, one of them has stopped doing its job and the split is a
        // fiction. Measured today: 2.65x/2.65x/2.66x light, 2.65x/2.66x/2.66x dark.
        const control = contrast(tokens['--border-control'], tokens[ground])
        const hairline = contrast(tokens['--hairline'], tokens[ground])
        expect(
          control / hairline,
          `control ${round2(control)} vs hairline ${round2(hairline)}`,
        ).toBeGreaterThan(2)
      })
    }
  }

  it('--border-subtle is an alias of --hairline, not a third border value', () => {
    expect(root['--border-subtle']).toBe('var(--hairline)')
  })

  /**
   * The control primitives themselves. Static, because the ratio is only worth
   * anything if something renders it — and this is the assertion that failed to
   * exist between Phase 1 defining the token and Batch 2A wiring it up.
   */
  const ruleBody = (selector: string) =>
    stripComments(appCss).match(new RegExp(`(^|\\n)${selector}\\s*\\{([^}]*)\\}`))?.[2] ?? ''

  it('every control primitive draws its boundary with --border-control', () => {
    const controlRules = [
      '\\.btn',
      'input:not\\(\\[type="radio"\\]\\):not\\(\\[type="checkbox"\\]\\),\\s*\\ntextarea,\\s*\\nselect',
      "input\\[type='checkbox'\\],\\s*\\ninput\\[type='radio'\\]",
    ]
    for (const selector of controlRules) {
      expect(ruleBody(selector), selector).toMatch(
        /border:\s*1px solid var\(--border-control\)/,
      )
    }
  })

  it('the decorative primitives keep --hairline — the split is visible in app.css', () => {
    // .card and dialog carry Batch 2B's theme-dependent rim; a chip has none.
    // None of the three is a control, so none of them takes the control token.
    for (const selector of ['\\.card', 'dialog']) {
      expect(ruleBody(selector), selector).toMatch(/var\(--hairline\)/)
      expect(ruleBody(selector), selector).not.toMatch(/--border-control/)
    }
  })
})

/**
 * F12 / Batch 2A — the three text tiers, and the .field primitive that uses them.
 *
 * The forms wrapped the control in its label, so the label inherited the page
 * size and the page ink while the control re-declared itself smaller: a label
 * LARGER than, and exactly as dark as, the value it labelled. p.44 says a label
 * you only need for scanning is support. --text-secondary is the middle tier
 * Phase 1 added for precisely this and left unconsumed until now.
 */
describe('F12 — the label ranks below its value', () => {
  const root = Object.fromEntries(declarations(rootBlock(appCss)))
  const ruleBody = (selector: string) =>
    stripComments(appCss).match(new RegExp(`(^|\\n)${selector}\\s*\\{([^}]*)\\}`))?.[2] ?? ''

  for (const [themeName, tokens] of Object.entries(THEMES)) {
    it(`${themeName}: the three tiers are strictly ordered, --text > secondary > muted`, () => {
      // The ordering is what makes a demotion MEAN anything. If secondary ever
      // ties --text the label stops being support; if it ties --text-muted the
      // label and the hint below it collapse onto one tier, which is what
      // BridgeSection's hand-rolled --text-muted labels were doing.
      const on = (ink: string) => contrast(tokens[ink], tokens['--surface'])
      expect(on('--text')).toBeGreaterThan(on('--text-secondary'))
      expect(on('--text-secondary')).toBeGreaterThan(on('--text-muted'))
    })

    it(`${themeName}: a demoted label is still a comfortable read on every ground`, () => {
      // Demotion is a hierarchy move, not a legibility trade. Already covered by
      // the tier sweep above at 4.5; this says so in F12's own terms.
      for (const ground of GROUNDS) {
        const r = contrast(tokens['--text-secondary'], tokens[ground])
        expect(round2(r), `${ground} measured ${round2(r)}`).toBeGreaterThanOrEqual(4.5)
      }
    })
  }

  it('the .field label is SMALLER than the control value it labels (p.44)', () => {
    const label = ruleBody('\\.field-label').match(/font-size:\s*([\d.]+)rem/)
    const field = ruleBody('\\.field').match(/font-size:\s*([\d.]+)rem/)
    const control = ruleBody(
      'input:not\\(\\[type="radio"\\]\\):not\\(\\[type="checkbox"\\]\\),\\s*\\ntextarea,\\s*\\nselect',
    ).match(/font-size:\s*([\d.]+)rem/)
    expect(label?.[1], '.field-label needs an explicit size').toBeTruthy()
    expect(control?.[1], 'the control primitive needs an explicit size').toBeTruthy()
    expect(parseFloat(label![1])).toBeLessThan(parseFloat(control![1]))
    // Both spellings of the label — the span and the bare text node in a .field
    // — must agree, or the same form renders two different labels.
    expect(field?.[1]).toBe(label?.[1])
  })

  it('the .field label takes --text-secondary, never --text or --text-muted', () => {
    for (const selector of ['\\.field', '\\.field-label']) {
      expect(ruleBody(selector), selector).toMatch(/color:\s*var\(--text-secondary\)/)
    }
  })

  it('a control does not inherit the label weight around it', () => {
    // .field sets font-weight: 500 on the wrapper, so the primitive has to say
    // 400 explicitly or every input in a field renders semi-bold.
    expect(
      ruleBody('input:not\\(\\[type="radio"\\]\\):not\\(\\[type="checkbox"\\]\\),\\s*\\ntextarea,\\s*\\nselect'),
    ).toMatch(/font-weight:\s*400/)
  })

  it('the gap BETWEEN fields is at least 3x the gap inside one (p.83-84)', () => {
    // The audit measured 3.7px inside against 7.5px between — a 2:1 ratio it
    // called unreadable as grouping. Asserted as a RATIO so a later change of
    // scale step passes as long as the relationship survives.
    const inside = ruleBody('\\.field').match(/gap:\s*([\d.]+)rem/)
    const between = ruleBody('\\.field \\+ \\.field').match(/margin-top:\s*([\d.]+)rem/)
    expect(inside?.[1], '.field needs a gap').toBeTruthy()
    expect(between?.[1], '.field + .field needs a margin').toBeTruthy()
    expect(parseFloat(between![1]) / parseFloat(inside![1])).toBeGreaterThanOrEqual(3)
  })

  it('--text-secondary is a real declaration, not an alias of another tier', () => {
    expect(root['--text-secondary']).toMatch(/^light-dark\(/)
    for (const [themeName, tokens] of Object.entries(THEMES)) {
      expect(tokens['--text-secondary'], themeName).not.toBe(tokens['--text'])
      expect(tokens['--text-secondary'], themeName).not.toBe(tokens['--text-muted'])
    }
  })
})

/**
 * F14 / Batch 2A — the link primitive.
 *
 * app.css had no `a` rule at all, so the DEFAULT for an anchor was the UA's
 * #0000EE (light) / #9e9eff (dark) — the one colour on the page in neither
 * palette, and a saturated blue standing next to a teal accent. The audit named
 * two such links, Phase 1 found a third, and grepping the pattern for this batch
 * found seven more. They kept appearing because the default was wrong, not
 * because three authors were careless.
 */
describe('F14 — an anchor can no longer fall back to browser blue', () => {
  const ruleBody = (selector: string) =>
    stripComments(appCss).match(new RegExp(`(^|\\n)${selector}\\s*\\{([^}]*)\\}`))?.[2] ?? ''

  it('app.css declares a global anchor colour and an underline affordance', () => {
    const rule = ruleBody('a')
    expect(rule, 'app.css has no global `a` rule — F14 can recur').toBeTruthy()
    expect(rule).toMatch(/color:\s*inherit/)
    expect(rule).toMatch(/text-decoration:\s*underline/)
  })

  it('it inherits rather than picking a hue, so it cannot fight the accent', () => {
    // `color: inherit` is the idiom six components had already converged on by
    // hand: a link inside a --text-muted note stays muted, and the underline
    // (p.193) is what marks it. A literal hue here would be a second accent.
    expect(ruleBody('a')).not.toMatch(/color:\s*#/)
    expect(ruleBody('a')).not.toMatch(/color:\s*var\(--accent\)/)
  })
})

/**
 * P1-4 / Batch 2A — --disabled-opacity, the second of the three semantics that
 * were stacked on one bare `opacity: 0.45`.
 */
describe('P1-4 — the disabled opacity is its own token', () => {
  const root = Object.fromEntries(declarations(rootBlock(appCss)))

  it('is a number in (0,1), declared once, theme-independent', () => {
    const alpha = parseFloat(root['--disabled-opacity'])
    expect(Number.isFinite(alpha)).toBe(true)
    expect(alpha).toBeGreaterThan(0)
    expect(alpha).toBeLessThan(1)
    // Unlike --recede-opacity it is NOT in either dark-override block: a
    // disabled control has no contrast floor to hold (SC 1.4.3 and SC 1.4.11
    // both except inactive components), so a second value would be taste
    // dressed as measurement — and it would grow the app's last copy of the
    // F17 hazard from two declarations to three.
    for (const block of [darkOverrideDeclarations(), autoDarkOverrideDeclarations()]) {
      expect(block.map(([n]) => n)).not.toContain('--disabled-opacity')
    }
  })

  it('is NOT --recede-opacity — one number, two meanings, two tokens', () => {
    // They are equal in dark today and differ in light. Asserting they are
    // separate DECLARATIONS is the point: folding them would make a receded
    // diff row and a dead button impossible to tune apart.
    expect(root['--disabled-opacity']).toBeTruthy()
    expect(root['--recede-opacity']).toBeTruthy()
    expect(root['--disabled-opacity']).not.toBe('var(--recede-opacity)')
    expect(parseFloat(LIGHT['--recede-opacity'])).not.toBe(
      parseFloat(root['--disabled-opacity']),
    )
  })

  it('records the theme asymmetry it deliberately does NOT correct', () => {
    // The measurement behind the "single value" decision, kept as a test so the
    // number is here when someone wants to revisit it rather than in a comment
    // that can drift. Light lands ~27% harsher, the same shape of bug
    // --recede-opacity exists to fix — the difference is that this one has no
    // floor to force a second value.
    const alpha = parseFloat(root['--disabled-opacity'])
    const light = contrast(LIGHT['--text'], LIGHT['--surface-sunken'], alpha)
    const dark = contrast(DARK['--text'], DARK['--surface-sunken'], alpha)
    expect(round2(light)).toBeLessThan(round2(dark))
    // A disabled control is exempt from the floors, but it must still be
    // PERCEIVABLE — "unavailable", not "absent".
    expect(round2(light), `light measured ${round2(light)}`).toBeGreaterThan(2)
  })
})

/**
 * P1-4 / Batch 2D — the LAST two of the opacity semantics, which closes the set
 * that one bare `opacity: 0.45` used to carry.
 *
 * --chrome-muted-opacity was handed to this batch by Batch 2A (a scale question,
 * not a form one). --busy-opacity was not in the plan at all: it is the
 * "deliberate outlier" 2A flagged, promoted from a literal to a token so that
 * the next sweep of "all the disabled opacities" reads an intention instead of a
 * number it is tempted to flatten. The grep found TWO sites of it, not the one
 * the plan named.
 */
describe('P1-4 — chrome-muted and busy opacities (Batch 2D)', () => {
  const root = Object.fromEntries(declarations(rootBlock(appCss)))

  it('all four opacity semantics exist as separate declarations', () => {
    // recede / disabled / chrome-muted / busy. Three of them are 0.45 or near
    // it today; that coincidence is exactly why they must not be aliases.
    for (const name of [
      '--recede-opacity',
      '--disabled-opacity',
      '--chrome-muted-opacity',
      '--busy-opacity',
    ]) {
      const value = root[name]
      expect(value, `${name} is not declared`).toBeTruthy()
      expect(value, `${name} must not be an alias`).not.toMatch(/^var\(/)
      const alpha = parseFloat(value)
      expect(Number.isFinite(alpha), `${name} must be a number`).toBe(true)
      expect(alpha).toBeGreaterThan(0)
      expect(alpha).toBeLessThan(1)
    }
  })

  it('neither new token is theme-split (the F17 hazard stays at two declarations)', () => {
    // A number cannot use light-dark(), so every theme-dependent number has to
    // be written out in BOTH dark-override blocks — which is the duplication
    // Phase 1 removed everywhere else. --recede-opacity pays that cost because
    // it has a 3:1 floor; these two have none, so they do not.
    for (const block of [darkOverrideDeclarations(), autoDarkOverrideDeclarations()]) {
      const names = block.map(([n]) => n)
      expect(names).not.toContain('--chrome-muted-opacity')
      expect(names).not.toContain('--busy-opacity')
    }
  })

  it('busy is well above disabled — a working control must stay readable', () => {
    // .run-reviewers-btn and .tests-review-btn are `disabled={isRunning}` with
    // aria-busy: at that moment the label IS the status message ("Running…"),
    // so dimming it to --disabled-opacity would hide the only thing telling the
    // user their review is under way. This ORDERING is the assertion; the two
    // numbers may be retuned as long as it holds.
    const busy = parseFloat(root['--busy-opacity'])
    const disabled = parseFloat(root['--disabled-opacity'])
    expect(busy).toBeGreaterThan(disabled)
    // And it must still clear the normal-text floor on the ground it sits on,
    // because unlike a genuinely inactive control it is carrying live copy.
    for (const [name, palette] of [
      ['light', LIGHT],
      ['dark', DARK],
    ] as const) {
      const ratio = contrast(palette['--text'], palette['--surface-sunken'], busy)
      expect(round2(ratio), `${name} busy label measured ${round2(ratio)}`).toBeGreaterThanOrEqual(
        4.5,
      )
    }
  })

  it('chrome-muted is not an alias of disabled, though they share a number', () => {
    // Equal today, separately tunable by construction. Quiet resting chrome and
    // a dead control are different questions and must not move together.
    expect(root['--chrome-muted-opacity']).not.toBe('var(--disabled-opacity)')
    expect(root['--disabled-opacity']).not.toBe('var(--chrome-muted-opacity)')
  })
})
