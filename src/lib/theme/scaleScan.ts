/**
 * src/lib/theme/scaleScan.ts — THE ONE definition of the type/spacing-scale scan.
 *
 * Shared by src/lib/theme/scaleRatchet.test.ts AND
 * scripts/generate-scale-baseline.mjs so the test and the generator can never
 * drift. It is pure: callers hand it sources (the test via `import.meta.glob`,
 * the generator via `fs`), it hands back counts.
 *
 * WHAT IT COUNTS, and why these three kinds (plan Batch 2D; audit F6 + F7):
 *
 *   emFont   — `font-size` declarations that use `em`. This is the disease, not
 *              merely a symptom: `em` COMPOUNDS through nesting, so three levels
 *              of it produce 12.1125px, a size no one chose and that is on no
 *              scale by construction (rubric p.92-93, the audit's F6 headline).
 *              It is a strict subset of offScaleFont and gets its own column so
 *              it can be driven to zero FIRST, ahead of the tidier rem literals.
 *
 *   offScaleFont — every `font-size` whose value is a length literal rather than
 *              a `var(--text-*)` step. 604 declarations carried 50 distinct
 *              values when this baseline was taken, ~400 of them inside the
 *              10.5-13.5px band: twelve near-identical sizes for one role.
 *
 *   offScaleSpace — every length component in a padding / margin / gap
 *              declaration that is not a `var(--space-*)` step. Counted per
 *              COMPONENT, not per declaration, because `padding: 0.4rem 0.75rem`
 *              is two independent spacing decisions and a migration that fixes
 *              one of them should register as progress. `0` and `auto` are free
 *              — they are not points on a scale.
 *
 *   offScaleWeight — every `font-weight` that is neither the body weight (400)
 *              nor the emphasis weight (600). This is audit F18, and this batch
 *              deliberately only FREEZES it: the surplus is 500 (×56) and 700
 *              (×24), and collapsing them is a design decision, not a mechanical
 *              one — Batch 2A chose 500 for the 12px secondary `.field-label`
 *              with a stated reason, and 400/600 would overturn that. Recording
 *              it here stops a fifth weight arriving and stops the two surplus
 *              ones spreading further, which is what a ratchet is for when the
 *              decision behind a number has not been taken yet.
 *
 * WHAT IT DOES NOT COUNT, deliberately:
 *   - `line-height`. F6 records 21 distinct line-heights too, but a line-height
 *     scale is a separate decision (it is a ratio, not a length) and adding it
 *     here would make the first ratchet reading un-actionable.
 *   - CSS comments. Stripped first — `/* 0.4rem is the old gap *\/` is prose.
 *   - Anything outside `src/`. `e2e/` asserts rendered geometry, not declarations.
 */

/** Files the ratchet governs: every component + the global stylesheet. */
export const SCALE_SCOPE_GLOB = ['/src/**/*.svelte', '/src/app.css'] as const

/** Per-file counts under {@link countScaleOffenders}. */
export interface ScaleCounts {
  /** `font-size` declarations using an `em` length (subset of offScaleFont). */
  emFont: number
  /** `font-size` declarations not pointing at a `var(--text-*)` step. */
  offScaleFont: number
  /** padding/margin/gap length components not pointing at a `var(--space-*)` step. */
  offScaleSpace: number
  /** `font-weight` declarations that are neither 400 nor 600 (audit F18). */
  offScaleWeight: number
}

export const SCALE_KINDS = ['emFont', 'offScaleFont', 'offScaleSpace', 'offScaleWeight'] as const

/** The spacing properties whose values carry scale decisions. */
const SPACING_PROPERTY =
  'padding|margin|gap|row-gap|column-gap|' +
  'padding-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end)|' +
  'margin-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end)'

export const SCALE_PATTERNS = {
  /** Captures the VALUE of every font-size declaration. */
  fontSize: /(?:^|[;{}\s])font-size\s*:\s*([^;}]+)/g,
  /** Captures the VALUE of every spacing declaration. */
  spacing: new RegExp(`(?:^|[;{}\\s])(?:${SPACING_PROPERTY})\\s*:\\s*([^;}]+)`, 'g'),
  /** Captures the VALUE of every font-weight declaration. */
  fontWeight: /(?:^|[;{}\s])font-weight\s*:\s*([^;}]+)/g,
  /** A non-zero length component. `0` (unitless) and `auto` never match. */
  length: /-?\d*\.?\d+(?:rem|em|px|ch|ex|vh|vw|vmin|vmax|%)/g,
  /** A reference to a step on either scale. */
  textToken: /var\(\s*--text-(?:xs|sm|base|lg|xl|2xl)\s*\)/,
  spaceToken: /var\(\s*--space-[1-8]\s*\)/g,
} as const

/** Drop CSS block comments so prose about a value is never counted as the value. */
export function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** True when a length component is zero in any unit (`0rem`, `0px`, `0%`). */
function isZero(component: string): boolean {
  return parseFloat(component) === 0
}

/**
 * Count the off-scale type and spacing decisions in one file's source.
 *
 * Svelte components are scanned whole rather than only inside `<style>`: a
 * `style="font-size: 0.8em"` attribute is the same defect in a different place,
 * and the scan must not hand anyone a way to launder one into the other.
 */
export function countScaleOffenders(source: string): ScaleCounts {
  const text = stripCssComments(source)
  const counts: ScaleCounts = { emFont: 0, offScaleFont: 0, offScaleSpace: 0, offScaleWeight: 0 }

  for (const match of text.matchAll(SCALE_PATTERNS.fontSize)) {
    const value = match[1].trim()
    if (SCALE_PATTERNS.textToken.test(value)) continue
    const lengths = value.match(SCALE_PATTERNS.length) ?? []
    if (lengths.length === 0) continue // `inherit`, `smaller`, a bare var() of something else
    counts.offScaleFont += 1
    if (lengths.some((l) => l.endsWith('em') && !l.endsWith('rem'))) counts.emFont += 1
  }

  for (const match of text.matchAll(SCALE_PATTERNS.spacing)) {
    // Remove the on-scale references first, then count what is left over.
    const remainder = match[1].replace(SCALE_PATTERNS.spaceToken, ' ')
    const lengths = remainder.match(SCALE_PATTERNS.length) ?? []
    counts.offScaleSpace += lengths.filter((l) => !isZero(l)).length
  }

  for (const match of text.matchAll(SCALE_PATTERNS.fontWeight)) {
    const value = match[1].trim()
    // `inherit` takes no position, and a var() has already made the decision
    // somewhere a scale can govern.
    if (value === 'inherit' || value.startsWith('var(')) continue
    if (value !== '400' && value !== '600') counts.offScaleWeight += 1
  }

  return counts
}

/** Sum a set of per-file counts. */
export function totalScaleOffenders(all: Iterable<ScaleCounts>): ScaleCounts {
  const total: ScaleCounts = { emFont: 0, offScaleFont: 0, offScaleSpace: 0, offScaleWeight: 0 }
  for (const c of all) for (const k of SCALE_KINDS) total[k] += c[k]
  return total
}
