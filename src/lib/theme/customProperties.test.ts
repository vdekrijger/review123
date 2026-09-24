/**
 * src/lib/theme/customProperties.test.ts — EVERY var() READ MUST RESOLVE.
 *
 * WHY THIS EXISTS. `ReviewProgress.svelte` read `var(--topbar-height, 48px)`.
 * The app declares `--topbar-h`. The two have never been the same name, so for
 * the component's entire life the read fell through to its 48px fallback while
 * the real topbar was 41.25px tall (`--topbar-h: 2.75rem` against the `:root`
 * `font-size: 15px`) — the fixed progress bar sat 6.75px below the topbar it is
 * meant to sit directly under, with a strip of scrolling page showing through.
 *
 * Nothing caught it, and nothing could have: an unresolved custom property is
 * invalid-at-computed-value-time, which is a SILENT fallback by design, not a
 * parse error. `pnpm check`, `pnpm test`, `pnpm build` and the browser console
 * are all quiet. That is the whole defect class — a typo'd token is
 * indistinguishable from a deliberate default until someone measures pixels.
 *
 * The same scan immediately found a second one: `SymbolTestPairing.svelte` read
 * `var(--mono, …)` at five sites where the declared token is `--font-mono`, so
 * it rendered in the generic monospace stack instead of the app's IBM Plex Mono
 * like the other 65 call sites.
 *
 * HOW IT WORKS. Same `import.meta.glob` + `?raw` idiom as layerScale.test.ts
 * and scaleRatchet.test.ts (the `src` tsconfig has no @types/node, so walking
 * the tree with `node:fs` would fail `pnpm check`). A name counts as DECLARED
 * if any source either declares it in CSS (`--name:`) or names it as a string
 * literal (`'--name'`), which is how a property set from JS via
 * `element.style.setProperty(DIFF_COL_H_VAR, …)` is declared — the constant
 * holds the literal, so the literal is in the tree.
 *
 * WHAT IT CANNOT SEE: a name that is spelled consistently but WRONG (declared
 * and read as `--topbar-height` everywhere) resolves fine and is invisible
 * here, as is a token whose VALUE is wrong. This catches the mismatch between
 * the two halves, which is the half that fails silently.
 */

import { describe, it, expect } from 'vitest'
import { stripCssComments } from './scaleScan'

/** Components, routes and the global stylesheet. Patterns MUST be literals. */
const rawSources = import.meta.glob<string>(['/src/**/*.svelte', '/src/**/*.css'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** Sources that can DECLARE a property, including the `.ts` that set them. */
const rawDeclarers = import.meta.glob<string>(
  ['/src/**/*.svelte', '/src/**/*.css', '/src/**/*.ts'],
  { query: '?raw', import: 'default', eager: true },
)

/**
 * Strip everything that is prose rather than a declaration: CSS block comments,
 * HTML comments, and `//` line comments. Without this the scan trips over
 * FileDiff.svelte, whose recede note explains that both rules "used to set
 * `opacity: var(--recede-opacity)`" — a description of deleted code.
 */
function stripProse(source: string): string {
  return stripCssComments(source)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/** Every custom property this repo declares, in CSS or as a JS string literal. */
function declared(): Set<string> {
  const names = new Set<string>()
  for (const source of Object.values(rawDeclarers)) {
    const text = stripProse(source)
    for (const m of text.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) names.add(m[1])
    for (const m of text.matchAll(/['"`](--[A-Za-z0-9_-]+)['"`]/g)) names.add(m[1])
  }
  return names
}

/** Every `var(--x)` read, keyed by name → the files that read it. */
function reads(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const [abs, source] of Object.entries(rawSources)) {
    const path = abs.replace(/^\//, '')
    for (const m of stripProse(source).matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
      const at = out.get(m[1]) ?? new Set<string>()
      at.add(path)
      out.set(m[1], at)
    }
  }
  return out
}

/**
 * Names read but never declared, kept deliberately. This is an EXACT list, not
 * a ceiling — the same mechanism as layerScale.test.ts's allowlist, and for the
 * same reason: an entry that stops being true has to be deleted, so the list
 * cannot decay into a permanent exemption nobody revisits.
 *
 * All four are the SAME shape and are NOT typos: an aspirational semantic token
 * that was never added to the palette, read as `var(--token, <literal>)` so the
 * literal is doing the work. Naming a real substitute for each is a palette
 * decision (which of `--border-subtle` / `--border-control` is "the" border?),
 * not a mechanical rename, so this change records them rather than guessing.
 */
const UNDECLARED_BY_DESIGN: Record<string, string> = {
  '--border': 'aspirational; every read supplies a literal fallback (#3a4060). Candidates are --border-subtle / --border-control / --border-banner — choosing between them is a palette decision.',
  '--danger': 'aspirational error colour; read as var(--danger, #b3261e | #c0392b | crimson). The three different fallbacks are themselves the argument for declaring one token, in a palette change.',
  '--ok': 'aspirational success colour; read as var(--ok, #1a7f37).',
  '--surface-hover': 'aspirational hover ground; four different literal fallbacks across the call sites, incl. a color-mix() on --surface-raised.',
}

describe('every var() read resolves to a declared custom property', () => {
  it('scans a real number of sources (a guard that scans nothing passes forever)', () => {
    expect(Object.keys(rawSources).length).toBeGreaterThan(50)
    expect(declared().size).toBeGreaterThan(50)
  })

  it('has no read whose name is simply not declared anywhere', () => {
    // THE GUARD. A miss here is a silent fallback in the built app, never an
    // error — see the file header for the two this scan found on its first run.
    const known = declared()
    const offenders: string[] = []
    for (const [name, paths] of reads()) {
      if (known.has(name)) continue
      if (name in UNDECLARED_BY_DESIGN) continue
      offenders.push(`${name} read in ${[...paths].sort().join(', ')}`)
    }
    expect(
      offenders.sort(),
      'declare the property, or fix the spelling — an unresolved var() silently uses its fallback',
    ).toEqual([])
  })

  it('keeps the deliberate list exact — a token that gets declared must leave it', () => {
    const known = declared()
    const read = reads()
    for (const [name, why] of Object.entries(UNDECLARED_BY_DESIGN)) {
      expect(read.has(name), `${name} is listed but nothing reads it any more`).toBe(true)
      expect(known.has(name), `${name} is declared now — delete its entry`).toBe(false)
      expect(why.length, `${name} must say why`).toBeGreaterThan(20)
    }
  })

  it('pins the two names this scan was written for', () => {
    // Regression locks, stated as the names rather than as a count: these are
    // the reads that were broken, and re-breaking either must fail HERE with an
    // obvious message rather than only as a geometry change three files away.
    const known = declared()
    expect(known.has('--topbar-h'), '--topbar-h is the real topbar token').toBe(true)
    expect(known.has('--font-mono'), '--font-mono is the real mono token').toBe(true)
    const read = reads()
    expect(read.has('--topbar-height'), 'nothing may read the misspelled --topbar-height').toBe(
      false,
    )
    expect(read.has('--mono'), 'nothing may read the misspelled --mono').toBe(false)
  })
})
