/**
 * src/lib/theme/layerScale.test.ts — THE LAYER-SCALE GUARD.
 *
 * WHY THIS EXISTS. A dropdown on the Verdict step opened behind the sticky
 * bottom draft bar. `.review-cmd-dropdown` was `z-index: 30` ("a dropdown,
 * above its siblings"); `.draft-bar` was `z-index: 100` ("a fixed bar, above
 * the page"). Both authors were right about their own file. Nobody was wrong,
 * and the bug shipped anyway — because fourteen files each picked a z-index by
 * hand and the only thing tying them together was PROSE: comments that said
 * "just below the rail (300)" and "above the topbar (200)". A comment naming
 * another file's magic number is a dependency no grep can follow and no rename
 * can update, so the next hand-picked number reproduces the bug.
 *
 * src/app.css now owns the scale. This file is what stops the numbers coming
 * back — the same job src/lib/theme/scaleRatchet.test.ts does for type and
 * spacing, and the same `import.meta.glob` + `?raw` idiom as
 * src/source-bytes.test.ts (the `src` tsconfig has no @types/node, so reading
 * the tree with `node:fs` would fail `pnpm check`).
 *
 * WHAT IT ASSERTS, in three parts:
 *   1. the scale exists, is integers, and is ORDERED — including the specific
 *      orderings the bug fix depends on, stated as behaviour ("a popover
 *      outranks every fixed bar") rather than as arithmetic on two literals;
 *   2. no component declares a raw numeric z-index, with an EXACT allowlist of
 *      the files a concurrent change is holding. That allowlist is now EMPTY:
 *      every component reads a --z-* token, so part 2 covers the whole tree.
 *
 * The allowlist kept a third part while it had entries — an assertion that each
 * held file's raw numbers still landed in the right BAND of the scale, which is
 * what made deferring them honest rather than merely permitted. Those files are
 * migrated, so the band checks went with them: a token cannot be in the wrong
 * band. The mechanism below stays armed for the next concurrent change.
 *
 * WHAT THIS CANNOT SEE, stated so nobody trusts it too far: it reads
 * DECLARATIONS. A correct z-index still loses if an ancestor establishes a
 * stacking context (a transform, filter, opacity < 1, contain, will-change,
 * isolation, or a positioned ancestor with its own z-index), and no static scan
 * can know the DOM ancestry. e2e/layer-scale.spec.ts is the other half: it
 * hit-tests `elementFromPoint` in a real browser, which is the only thing that
 * can answer "which surface actually won this pixel".
 */

import { describe, it, expect } from 'vitest'
import appCss from '../../app.css?raw'
import { stripCssComments } from './scaleScan'

/** Every component + route. Patterns MUST be string literals (Vite's rule). */
const rawSources = import.meta.glob<string>(['/src/**/*.svelte'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** Sources keyed `src/...`, no leading slash, comments stripped. */
function components(): Map<string, string> {
  const out = new Map<string, string>()
  for (const [abs, source] of Object.entries(rawSources)) {
    out.set(abs.replace(/^\//, ''), stripCssComments(source))
  }
  return out
}

/** Read one `--z-*` step out of app.css as a number. */
function layer(name: string): number {
  const match = stripCssComments(appCss).match(new RegExp(`--z-${name}\\s*:\\s*([^;]+);`))
  if (!match) throw new Error(`--z-${name} is not declared in src/app.css`)
  const value = match[1].trim()
  if (!/^\d+$/.test(value)) {
    throw new Error(`--z-${name} must be a plain integer, got "${value}"`)
  }
  return Number(value)
}

/**
 * The scale, bottom to top. The ORDER of this array is the assertion — adding
 * a step means placing it here, which is the review moment the old free-form
 * numbers never had.
 */
const SCALE = [
  'pinned-header',
  'dock',
  'drawer',
  'drawer-tab',
  'progress',
  'bar',
  'panel',
  'topbar',
  'popover',
  'scrim',
  'takeover',
  'modal',
] as const

/**
 * Files still carrying a raw z-index, and why. This is an EXACT list, not a
 * ceiling: a file that gets migrated must be deleted from here or the test
 * fails, so the remaining work stays visible instead of decaying into a
 * permanent exemption. `destined` records the token each literal is heading
 * for, so the follow-up is a lookup rather than a re-derivation.
 */
const HELD: Record<string, { count: number; destined: string[]; why: string }> = {
  // EMPTY, and that is the finished state: InspectStep, CommentEditor and
  // SymbolPopover — the three files the scale's own PR could not touch — now
  // read tokens, so the `var(--z-*)` guard below scans every component with no
  // exemptions. The mechanism is left in place, not deleted, because the next
  // concurrent change will need it: add an entry, and deleting that entry is
  // what the migrating change has to do to go green.
}

/** Every raw numeric `z-index: <n>` in a source, comments already stripped. */
function rawLayers(source: string): number[] {
  return [...source.matchAll(/z-index\s*:\s*(-?\d+)\s*(?:;|})/g)].map((m) => Number(m[1]))
}

describe('the layer scale itself', () => {
  it('declares every step as a plain integer', () => {
    for (const step of SCALE) expect(() => layer(step), step).not.toThrow()
  })

  it('is strictly ordered bottom to top', () => {
    const values = SCALE.map(layer)
    for (let i = 1; i < values.length; i++) {
      expect(values[i], `--z-${SCALE[i]} must outrank --z-${SCALE[i - 1]}`).toBeGreaterThan(
        values[i - 1],
      )
    }
  })

  it('leaves room to insert a layer between steps, except the pinned pairs', () => {
    // A scale with no gaps is a scale the next surface has to renumber.
    //
    // The two exceptions started as literals inside a file the scale's PR was
    // not allowed to touch: 5/6 (pinned header, phase dock) and 20/21 (drawer,
    // its tab). That file has since migrated, so respacing them is now POSSIBLE
    // — and deliberately not done here. Both pairs are adjacent-but-correctly-
    // ordered, nothing needs to slot between them, and renumbering them would
    // turn a rename into a behavioural change for no gain. Respace when a real
    // surface needs the room, not for tidiness — see the pinned-header note in
    // src/app.css for what tidiness cost last time.
    const PINNED = new Set(['dock', 'drawer-tab'])
    for (let i = 1; i < SCALE.length; i++) {
      const gap = layer(SCALE[i]) - layer(SCALE[i - 1])
      if (PINNED.has(SCALE[i])) expect(gap, `--z-${SCALE[i]}`).toBe(1)
      else expect(gap, `gap below --z-${SCALE[i]}`).toBeGreaterThanOrEqual(10)
    }
  })
})

describe('the orderings the reported bug turned on', () => {
  it('a popover outranks every piece of fixed chrome, including the topbar', () => {
    // THE FIX. The dropdown lost to the draft bar at --z-bar. Raising one
    // dropdown past one bar would have left the same bug in three other files,
    // so the whole CLASS sits above the chrome: a popover is transient and the
    // user just asked for it, a bar is permanent and was already there.
    for (const chrome of ['progress', 'bar', 'panel', 'topbar'] as const) {
      expect(layer('popover'), `popover vs ${chrome}`).toBeGreaterThan(layer(chrome))
    }
  })

  it('the preview panel outranks the bars it overlaps', () => {
    expect(layer('panel')).toBeGreaterThan(layer('bar'))
  })

  it('a takeover covers the topbar, and its scrim sits directly under it', () => {
    expect(layer('takeover')).toBeGreaterThan(layer('topbar'))
    expect(layer('scrim')).toBeLessThan(layer('takeover'))
    expect(layer('scrim')).toBeGreaterThan(layer('topbar'))
  })

  it('a modal outranks everything, rather than tying the topbar and winning on document order', () => {
    // .runpr-dialog was a literal 200 — the topbar's exact value — and painted
    // above it only because Review renders after App's header. It lost outright
    // to the narrow-mode rail at 300.
    const top = layer('modal')
    for (const step of SCALE.filter((s) => s !== 'modal')) {
      expect(top, `modal vs ${step}`).toBeGreaterThan(layer(step))
    }
  })

  it('the pinned diff header is the floor — it only has to beat the rows it pins over', () => {
    expect(layer('pinned-header')).toBeLessThan(layer('drawer'))
    expect(layer('pinned-header')).toBeGreaterThan(0)
  })

  it('the phase dock sits above the pinned header it scrolls past, and well under the bars', () => {
    // PR #276 landed `.phase-dock` at a literal 6 whose comment reads "sits
    // just above FileDiff's sticky file header (z-index 5)". An early draft of
    // this scale moved the header to 10 for tidiness and would have inverted
    // that silently. This is the assertion that keeps the two in the order
    // their authors wrote down, whichever file migrates first.
    expect(layer('dock')).toBeGreaterThan(layer('pinned-header'))
    expect(layer('dock')).toBeLessThan(layer('bar'))
  })
})

describe('no component picks a layer by hand', () => {
  it('scans components at all (a guard that scans nothing passes forever)', () => {
    expect(components().size).toBeGreaterThan(50)
  })

  it('every z-index outside the held files is a var(--z-*) token', () => {
    const offenders: string[] = []
    for (const [path, source] of components()) {
      if (path in HELD) continue
      const raw = rawLayers(source)
      if (raw.length > 0) offenders.push(`${path}: z-index ${raw.join(', ')}`)
    }
    expect(
      offenders,
      'use a --z-* step from src/app.css; add a step there if none fits',
    ).toEqual([])
  })

  it('the held files carry exactly the number of raw values recorded — no more, and no fewer', () => {
    // "No fewer" is the half that matters: when a held file is migrated its
    // entry must be DELETED, so the remaining work is visible in the diff
    // instead of sitting behind an exemption nobody revisits.
    const actual: Record<string, number> = {}
    const expected: Record<string, number> = {}
    for (const path of Object.keys(HELD)) {
      const source = components().get(path)
      expect(source, `${path} is recorded as held but does not exist`).toBeDefined()
      actual[path] = rawLayers(source!).length
      expected[path] = HELD[path].count
    }
    expect(actual).toEqual(expected)
  })

  it('every held file names a destination token for each literal it still carries', () => {
    for (const [path, entry] of Object.entries(HELD)) {
      expect(entry.destined.length, `${path} destinations`).toBe(entry.count)
      for (const token of entry.destined) {
        expect(() => layer(token.replace(/^--z-/, '')), `${path} → ${token}`).not.toThrow()
      }
      expect(entry.why.length, `${path} must say why`).toBeGreaterThan(20)
    }
  })
})
