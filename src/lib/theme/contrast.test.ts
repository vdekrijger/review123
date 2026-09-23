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
