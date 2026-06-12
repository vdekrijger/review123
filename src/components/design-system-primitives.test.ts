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
