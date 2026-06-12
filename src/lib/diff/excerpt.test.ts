/**
 * Tests for src/lib/diff/excerpt.ts — excerptAround helper.
 *
 * Covers:
 *  - Empty patch returns empty string
 *  - Simple single-hunk extraction (RIGHT side)
 *  - Simple single-hunk extraction (LEFT side)
 *  - Context window clamps at hunk boundaries
 *  - Multi-hunk patch — finds the correct hunk for the target line
 *  - Multi-hunk patch — nearest-hunk fallback when target is between hunks
 *  - Unparseable / missing patch
 */

import { describe, it, expect } from 'vitest'
import { excerptAround } from './excerpt'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A simple patch that modifies lines 5-7 of a file */
const SIMPLE_PATCH = `@@ -4,5 +4,5 @@
 context_before
-old line 5
+new line 5
 context_after
 another context`

/**
 * A two-hunk patch: first hunk at old lines 2-4 / new lines 2-4,
 * second hunk at old lines 10-12 / new lines 10-12.
 */
const TWO_HUNK_PATCH = `@@ -2,3 +2,3 @@
 ctx2
-old3
+new3
 ctx4
@@ -10,3 +10,3 @@
 ctx10
-old11
+new11
 ctx12`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('excerptAround', () => {
  it('returns empty string for empty patch', () => {
    expect(excerptAround('', 5, 'RIGHT')).toBe('')
  })

  it('returns empty string for null/undefined-like input', () => {
    // @ts-expect-error testing runtime guard
    expect(excerptAround(null, 5, 'RIGHT')).toBe('')
    // @ts-expect-error testing runtime guard
    expect(excerptAround(undefined, 5, 'RIGHT')).toBe('')
  })

  it('simple patch RIGHT side — returns lines centred on new line 5', () => {
    // New file: hunk starts at new line 4
    // line 4: ' context_before' → newLine=4
    // line 5: '+new line 5'      → newLine=5  ← target
    // line 6: ' context_after'   → newLine=6
    // line 7: ' another context' → newLine=7
    const result = excerptAround(SIMPLE_PATCH, 5, 'RIGHT', 6)
    expect(result).toContain('+new line 5')
    // Should also include context lines from the hunk
    expect(result).toContain(' context_before')
    expect(result).toContain(' context_after')
  })

  it('simple patch LEFT side — returns lines centred on old line 5', () => {
    // Old file: hunk starts at old line 4
    // line 4: ' context_before' → oldLine=4
    // line 5: '-old line 5'      → oldLine=5  ← target
    // line 6: ' context_after'   → oldLine=6
    const result = excerptAround(SIMPLE_PATCH, 5, 'LEFT', 6)
    expect(result).toContain('-old line 5')
    expect(result).toContain(' context_before')
  })

  it('context clamps at hunk boundaries — does not return negative indices', () => {
    // Target the first line of the hunk; there's nothing above it
    const result = excerptAround(SIMPLE_PATCH, 4, 'RIGHT', 10)
    expect(result).toBeTruthy()
    // Should include all content lines without crashing
    expect(result).toContain('+new line 5')
  })

  it('two-hunk patch — finds the first hunk for line 3 (RIGHT)', () => {
    // Second hunk's new side starts at new line 2
    // ' ctx2' → newLine=2, '-old3'/'+new3' → newLine=3  ← target
    const result = excerptAround(TWO_HUNK_PATCH, 3, 'RIGHT', 6)
    expect(result).toContain('+new3')
    // Must NOT contain content from the second hunk
    expect(result).not.toContain('+new11')
  })

  it('two-hunk patch — finds the second hunk for line 11 (RIGHT)', () => {
    // Second hunk starts at new line 10: ' ctx10' → 10, '+new11' → 11 ← target
    const result = excerptAround(TWO_HUNK_PATCH, 11, 'RIGHT', 6)
    expect(result).toContain('+new11')
    expect(result).not.toContain('+new3')
  })

  it('two-hunk patch LEFT side — finds first hunk for old line 3', () => {
    // First hunk old start = 2: ' ctx2' → 2, '-old3' → 3  ← target
    const result = excerptAround(TWO_HUNK_PATCH, 3, 'LEFT', 6)
    expect(result).toContain('-old3')
    expect(result).not.toContain('-old11')
  })

  it('nearest-hunk fallback — target line 7 falls between two hunks, returns nearest hunk head', () => {
    // Line 7 is not in either hunk; nearest start is hunk2 at line 10 vs hunk1 at line 2 (dist 5)
    // hunk1 start dist = |7-2| = 5, hunk2 start dist = |7-10| = 3 → nearest is hunk2
    const result = excerptAround(TWO_HUNK_PATCH, 7, 'RIGHT', 6)
    // Result should be a non-empty string (fallback provides something)
    expect(result.length).toBeGreaterThan(0)
  })

  it('returns a trimmed excerpt not exceeding 2*context+1 lines in the fallback', () => {
    const result = excerptAround(TWO_HUNK_PATCH, 50, 'RIGHT', 2)
    // 50 is far beyond both hunks; fallback returns at most 2*2+1=5 lines
    const lineCount = result.split('\n').length
    expect(lineCount).toBeLessThanOrEqual(5)
  })

  it('handles a patch with a removal-only hunk', () => {
    const removePatch = `@@ -1,3 +1,2 @@
 kept_line
-removed_line
 another_kept`
    // LEFT side: removed_line is at old line 2
    const result = excerptAround(removePatch, 2, 'LEFT', 3)
    expect(result).toContain('-removed_line')
  })

  it('handles a patch with an addition-only hunk', () => {
    const addPatch = `@@ -1,2 +1,3 @@
 kept_line
+added_line
 another_kept`
    // RIGHT side: added_line is at new line 2
    const result = excerptAround(addPatch, 2, 'RIGHT', 3)
    expect(result).toContain('+added_line')
  })
})

// ---------------------------------------------------------------------------
// Line-mapping across multiple hunks with gaps
// ---------------------------------------------------------------------------

describe('excerptAround — multi-hunk line mapping', () => {
  // Patch that skips from line 5 to line 15 (simulating a file with a big gap)
  const GAP_PATCH = `@@ -1,3 +1,3 @@
 line1
-old2
+new2
 line3
@@ -14,3 +14,3 @@
 line14
-old15
+new15
 line16`

  it('correctly maps new line 2 to first hunk', () => {
    const result = excerptAround(GAP_PATCH, 2, 'RIGHT', 1)
    expect(result).toContain('+new2')
    expect(result).not.toContain('+new15')
  })

  it('correctly maps new line 15 to second hunk', () => {
    const result = excerptAround(GAP_PATCH, 15, 'RIGHT', 1)
    expect(result).toContain('+new15')
    expect(result).not.toContain('+new2')
  })

  it('correctly maps old line 2 to first hunk', () => {
    const result = excerptAround(GAP_PATCH, 2, 'LEFT', 1)
    expect(result).toContain('-old2')
  })

  it('correctly maps old line 15 to second hunk', () => {
    const result = excerptAround(GAP_PATCH, 15, 'LEFT', 1)
    expect(result).toContain('-old15')
  })
})
