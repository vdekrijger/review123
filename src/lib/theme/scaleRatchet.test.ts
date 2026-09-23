/**
 * src/lib/theme/scaleRatchet.test.ts — THE TYPE/SPACING-SCALE RATCHET.
 *
 * Batch 2D (docs/design/ui-refactor-plan.md) is the largest mechanical change
 * in the refactor plan: audit F6 counted 142 `em` font-sizes producing 21
 * distinct computed sizes on ONE page, and F7 counted 40 distinct rem spacing
 * values across 1,221 declarations with adjacent steps 7-12% apart. That is far
 * too much to land in one reviewable PR, and a multi-PR migration with nothing
 * holding the line is how a codebase ends up half-migrated forever.
 *
 * So the line is held mechanically. src/lib/theme/scaleBaseline.ts records
 * today's per-file count of off-scale decisions; this file fails the suite when
 * any of them GROWS. Every later slice shrinks it, regenerates, and banks the
 * win — and an unrecorded shrink fails too, so a win cannot silently come back
 * later disguised as "still under the ceiling".
 *
 * (The pattern is lifted from the sister project's
 * tests/theme/adminHardcodedRatchet.test.ts, which drove 2,330 hardcoded values
 * down across a dozen PRs without a single regression.)
 *
 * WHAT THIS FILE IS NOT: a check that the app looks right. It reads
 * declarations, not pixels. Batch 2A's recorded lesson — a correct primitive
 * re-broken two lines below itself by a shorthand — is exactly the failure this
 * cannot see. e2e gates and screenshots are the other half.
 */
import { describe, it, expect } from 'vitest'
import appCss from '../../app.css?raw'
import { SCALE_BASELINE } from './scaleBaseline'
import {
  countScaleOffenders,
  SCALE_KINDS,
  stripCssComments,
  totalScaleOffenders,
  type ScaleCounts,
} from './scaleScan'

// The glob patterns MUST be string literals (Vite's transform requirement).
// They mirror SCALE_SCOPE_GLOB in scaleScan.ts, and the scope-sanity test below
// proves they still do.
const rawSources = import.meta.glob<string>(['/src/**/*.svelte', '/src/app.css'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** Sources keyed the way the generator keys them: `src/...`, no leading slash. */
function scopeSources(): Map<string, string> {
  const out = new Map<string, string>()
  for (const [abs, source] of Object.entries(rawSources)) out.set(abs.replace(/^\//, ''), source)
  return out
}

const REGEN = 'regenerate: node scripts/generate-scale-baseline.mjs'
const EMPTY: ScaleCounts = { emFont: 0, offScaleFont: 0, offScaleSpace: 0, offScaleWeight: 0 }

/** Read a single custom property's value out of the `:root` block of app.css. */
function token(name: string): string {
  const match = stripCssComments(appCss).match(new RegExp(`--${name}\\s*:\\s*([^;]+);`))
  if (!match) throw new Error(`token --${name} is not declared in app.css`)
  return match[1].trim()
}

/** A rem step, as a number. Throws if the step is not authored in `rem`. */
function remStep(name: string): number {
  const value = token(name)
  const match = value.match(/^(\d*\.?\d+)rem$/)
  if (!match) throw new Error(`--${name} must be a plain rem length, got "${value}"`)
  return parseFloat(match[1])
}

const TEXT_STEPS = ['text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl', 'text-2xl']
const SPACE_STEPS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `space-${n}`)

describe('the scales themselves (audit F6 + F7, rubric p.60-64 / p.88-93)', () => {
  it('every step of both scales is authored in rem, never em', () => {
    // The disease is `em` compounding (p.92-93). Shipping the cure in the same
    // unit would reproduce it one level down, so this is the load-bearing
    // assertion of the whole batch: the SCALE may not be relative to its parent.
    for (const step of [...TEXT_STEPS, ...SPACE_STEPS]) {
      expect(() => remStep(step), step).not.toThrow()
    }
  })

  it('the type scale is six strictly increasing steps', () => {
    const sizes = TEXT_STEPS.map(remStep)
    expect(sizes).toHaveLength(6)
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i], `${TEXT_STEPS[i]} must exceed ${TEXT_STEPS[i - 1]}`).toBeGreaterThan(
        sizes[i - 1],
      )
    }
    // It IS the rubric's reference scale (p.91-92), expressed in rem against a
    // 16px base: 12 / 14 / 16 / 18 / 20 / 24px nominal.
    expect(sizes.map((s) => s * 16)).toEqual([12, 14, 16, 18, 20, 24])
  })

  it('every adjacent spacing step differs by at least 25% (p.61-62)', () => {
    // The rule that makes a scale a scale: below ~25% the choice between two
    // neighbours is a nudge, not a decision — and F7 measured the app's busiest
    // band at 7-12%, less than half the minimum, everywhere.
    const steps = SPACE_STEPS.map(remStep)
    expect(steps).toHaveLength(8)
    for (let i = 1; i < steps.length; i++) {
      const growth = steps[i] / steps[i - 1] - 1
      expect(growth, `${SPACE_STEPS[i - 1]} → ${SPACE_STEPS[i]} grows only ${growth}`).toBeGreaterThanOrEqual(0.25)
    }
    // The rubric's reference scale (p.63) in rem against a 16px base.
    expect(steps.map((s) => s * 16)).toEqual([4, 8, 12, 16, 24, 32, 48, 64])
  })

  it('the scales are root-relative, so the 15px-vs-16px root stays one decision', () => {
    // The plan forbids smuggling `:root { font-size: 15px } → 16px` into a
    // batch. That is only safe if the root really is the single lever: a step
    // declared in px, or in em, would be immune to it and would silently
    // fragment the scale the day someone takes that decision.
    expect(stripCssComments(appCss)).toMatch(/:root\s*\{[\s\S]*?font-size:\s*15px/)
    for (const step of [...TEXT_STEPS, ...SPACE_STEPS]) {
      expect(token(step), step).toMatch(/^\d*\.?\d+rem$/)
    }
  })
})

describe('off-scale ratchet (per file, both directions)', () => {
  it('no file gains an off-scale type or spacing decision, and every shrink is recorded', () => {
    const problems: string[] = []
    const actual = new Map<string, ScaleCounts>()
    for (const [file, source] of scopeSources()) actual.set(file, countScaleOffenders(source))

    for (const [file, counts] of actual) {
      const allowed = SCALE_BASELINE[file] ?? EMPTY
      for (const kind of SCALE_KINDS) {
        if (counts[kind] > allowed[kind]) {
          problems.push(
            `${file}: ${counts[kind]} ${kind} (baseline permits ${allowed[kind]}). ` +
              `Use the --text-* / --space-* steps declared in src/app.css.`,
          )
        } else if (counts[kind] < allowed[kind]) {
          problems.push(
            `${file}: only ${counts[kind]} ${kind} left (baseline says ${allowed[kind]}) — ${REGEN}`,
          )
        }
      }
    }
    for (const file of Object.keys(SCALE_BASELINE)) {
      if (!actual.has(file)) problems.push(`${file}: listed but no longer in scope — ${REGEN}`)
    }

    expect(problems, `\n${problems.join('\n')}\n`).toEqual([])
  })

  it('the scan sees the whole app (guard against a silently-empty glob)', () => {
    // A ratchet that scans nothing passes forever. These are the four files the
    // batch's own slices touch plus the densest surface it may not touch, so a
    // glob that stops matching .svelte, or stops reaching into a subdirectory,
    // fails here rather than going quietly green.
    const sources = scopeSources()
    expect(sources.has('src/app.css')).toBe(true)
    expect(sources.has('src/App.svelte')).toBe(true)
    expect(sources.has('src/components/settings/AiModelsSection.svelte')).toBe(true)
    expect(sources.has('src/components/settings/ModelCombobox.svelte')).toBe(true)
    expect(sources.has('src/components/FileDiff.svelte')).toBe(true)
    expect(sources.has('src/routes/Landing.svelte')).toBe(true)
    expect(sources.size).toBeGreaterThanOrEqual(60)
    // Nothing outside src/ — e2e asserts rendered geometry, which is a different
    // instrument, and the bridge/eval trees have no UI at all.
    for (const file of sources.keys()) expect(file.startsWith('src/')).toBe(true)
  })

  it('the opening ledger — every later slice is measured against these', () => {
    // Batch 2D's starting numbers, taken at 9ada655. They are a CEILING: this
    // assertion may only ever be lowered, and lowering it is how a slice proves
    // it did something. `emFont` is the one that must reach zero — it is the
    // compounding defect itself; the others are a long tail with real per-site
    // judgement in them (see app.css on why there is no sub-4px spacing step).
    const total = totalScaleOffenders(SCALE_BASELINE ? Object.values(SCALE_BASELINE) : [])
    expect(total.emFont).toBeLessThanOrEqual(137)
    expect(total.offScaleFont).toBeLessThanOrEqual(596)
    expect(total.offScaleSpace).toBeLessThanOrEqual(1391)
    expect(total.offScaleWeight).toBeLessThanOrEqual(83)
    expect(Object.keys(SCALE_BASELINE).length).toBeLessThanOrEqual(61)
  })

  it('the generator and the test count with the SAME module', () => {
    // The one way this ratchet can lie: two copies of the patterns drifting
    // apart, so the recorded ceiling stops describing what the test measures.
    const generator = readGenerator()
    expect(generator).toContain("from '../src/lib/theme/scaleScan.ts'")
    expect(generator).toContain('countScaleOffenders')
    // No second copy of the patterns anywhere in the generator.
    expect(generator).not.toContain('font-size\\s*:')
    expect(generator).not.toContain('--space-')
  })
})

/** The generator's source, read through Vite's ?raw so no fs access is needed. */
function readGenerator(): string {
  const generators = import.meta.glob<string>('/scripts/generate-scale-baseline.mjs', {
    query: '?raw',
    import: 'default',
    eager: true,
  })
  const source = generators['/scripts/generate-scale-baseline.mjs']
  if (!source) throw new Error('scripts/generate-scale-baseline.mjs is missing')
  return source
}
