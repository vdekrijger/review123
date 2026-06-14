/**
 * Tests for src/lib/eval/scorer.ts — the eval-harness matching + scoring logic.
 *
 * Covers:
 * - descOverlap / tokenize fuzzy description matching
 * - isMatch: file gate, line tolerance (within / outside), file-level (null) lines,
 *   description-overlap requirement
 * - scoreCase: true positive within tolerance, noise correctly counted,
 *   clean-PR (no expectations) edge cases
 * - aggregate micro-averaging
 * - evaluateGates threshold crossing
 */

import { describe, it, expect } from 'vitest'
import {
  tokenize,
  descOverlap,
  isMatch,
  scoreCase,
  aggregate,
  evaluateGates,
  pct,
  DEFAULT_MATCH_CONFIG,
  type ProducedFinding,
  type ExpectedFinding,
  type CaseExpectation,
} from './scorer'

// ---------------------------------------------------------------------------
// tokenize / descOverlap
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('lowercases, splits on non-word chars, and drops stop words', () => {
    // "by" is a stop word, so it is dropped along with "the" and "in".
    expect(tokenize('The off-by-one error in loop')).toEqual([
      'off',
      'one',
      'error',
      'loop',
    ])
  })

  it('drops single-char tokens', () => {
    expect(tokenize('a b cd')).toEqual(['cd'])
  })
})

describe('descOverlap', () => {
  it('is 1 for identical descriptions', () => {
    expect(descOverlap('null pointer deref', 'null pointer deref')).toBe(1)
  })

  it('is 0 for disjoint descriptions', () => {
    expect(descOverlap('cache eviction bug', 'unrelated naming style')).toBe(0)
  })

  it('is 0 when either side is empty after stop-word removal', () => {
    expect(descOverlap('the a is', 'real bug here')).toBe(0)
  })

  it('gives a partial score for overlapping token sets', () => {
    const score = descOverlap(
      'off-by-one in pagination offset',
      'pagination offset off-by-one error',
    )
    expect(score).toBeGreaterThan(0.3)
    expect(score).toBeLessThan(1)
  })
})

// ---------------------------------------------------------------------------
// isMatch
// ---------------------------------------------------------------------------

describe('isMatch', () => {
  const expected: ExpectedFinding = {
    file: 'src/lib/cache.ts',
    line: 42,
    description: 'off-by-one in cache eviction loop',
  }

  it('matches a true positive within the line tolerance', () => {
    const produced: ProducedFinding = {
      file: 'src/lib/cache.ts',
      line: 44, // within ±3
      description: 'off-by-one error in the cache eviction loop',
    }
    expect(isMatch(produced, expected)).toBe(true)
  })

  it('does not match when the line is outside the tolerance', () => {
    const produced: ProducedFinding = {
      file: 'src/lib/cache.ts',
      line: 60, // |60-42| = 18 > 3
      description: 'off-by-one error in the cache eviction loop',
    }
    expect(isMatch(produced, expected)).toBe(false)
  })

  it('does not match when the file differs', () => {
    const produced: ProducedFinding = {
      file: 'src/lib/other.ts',
      line: 42,
      description: 'off-by-one error in the cache eviction loop',
    }
    expect(isMatch(produced, expected)).toBe(false)
  })

  it('does not match same-line findings about a different concern', () => {
    const produced: ProducedFinding = {
      file: 'src/lib/cache.ts',
      line: 42,
      description: 'variable name could be clearer here',
    }
    expect(isMatch(produced, expected)).toBe(false)
  })

  it('treats a file-level (null line) finding as matching any line in the file', () => {
    const fileLevel: ProducedFinding = {
      file: 'src/lib/cache.ts',
      line: null,
      description: 'off-by-one in cache eviction loop',
    }
    expect(isMatch(fileLevel, expected)).toBe(true)
  })

  it('respects a custom line tolerance', () => {
    const produced: ProducedFinding = {
      file: 'src/lib/cache.ts',
      line: 50,
      description: 'off-by-one in cache eviction loop',
    }
    expect(isMatch(produced, expected, { ...DEFAULT_MATCH_CONFIG, lineTolerance: 10 })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// scoreCase
// ---------------------------------------------------------------------------

describe('scoreCase', () => {
  const realBug: ExpectedFinding = {
    file: 'src/pay.ts',
    line: 10,
    description: 'integer overflow when summing line items',
  }
  const noiseNit: ExpectedFinding = {
    file: 'src/pay.ts',
    line: 30,
    description: 'prefer const over let for total',
  }
  const expectation: CaseExpectation = { real: [realBug], noise: [noiseNit] }

  it('counts a true positive: real caught, no noise, full recall', () => {
    const produced: ProducedFinding[] = [
      { file: 'src/pay.ts', line: 11, description: 'integer overflow summing the line items' },
    ]
    const score = scoreCase('case-bug', produced, expectation)
    expect(score.realCaught).toBe(1)
    expect(score.noiseFlagged).toBe(0)
    expect(score.recall).toBe(1)
    expect(score.noiseRate).toBe(0)
    expect(score.precision).toBe(1)
    expect(score.unmatched).toBe(0)
  })

  it('counts noise correctly when a noise item is wrongly flagged', () => {
    const produced: ProducedFinding[] = [
      { file: 'src/pay.ts', line: 30, description: 'prefer const over let for the total variable' },
    ]
    const score = scoreCase('case-noise', produced, expectation)
    expect(score.realCaught).toBe(0)
    expect(score.noiseFlagged).toBe(1)
    expect(score.recall).toBe(0)
    expect(score.noiseRate).toBe(1)
    expect(score.precision).toBe(0)
  })

  it('handles a clean PR (no expectations) producing no findings as perfect', () => {
    const score = scoreCase('case-clean', [], { real: [], noise: [] })
    expect(score.recall).toBe(1)
    expect(score.noiseRate).toBe(0)
    expect(score.precision).toBe(1)
    expect(score.produced).toBe(0)
  })

  it('counts an unmatched produced finding on a clean PR (false positive)', () => {
    const produced: ProducedFinding[] = [
      { file: 'src/pay.ts', line: 5, description: 'this function is a bit long' },
    ]
    const score = scoreCase('case-clean', produced, { real: [], noise: [] })
    expect(score.unmatched).toBe(1)
    expect(score.precision).toBe(0) // of 1 flagged, 0 real
  })

  it('reports partial recall when one of two real findings is caught', () => {
    const twoReal: CaseExpectation = {
      real: [
        realBug,
        { file: 'src/pay.ts', line: 50, description: 'missing null check on coupon' },
      ],
      noise: [],
    }
    const produced: ProducedFinding[] = [
      { file: 'src/pay.ts', line: 10, description: 'integer overflow summing line items' },
    ]
    const score = scoreCase('case-partial', produced, twoReal)
    expect(score.realCaught).toBe(1)
    expect(score.realTotal).toBe(2)
    expect(score.recall).toBe(0.5)
  })
})

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

describe('aggregate', () => {
  it('micro-averages counts across cases', () => {
    const caseA = scoreCase(
      'a',
      [{ file: 'f.ts', line: 1, description: 'real bug alpha' }],
      { real: [{ file: 'f.ts', line: 1, description: 'real bug alpha' }], noise: [] },
    )
    const caseB = scoreCase(
      'b',
      [{ file: 'g.ts', line: 5, description: 'noisy style nit here' }],
      {
        real: [{ file: 'g.ts', line: 99, description: 'real bug beta' }],
        noise: [{ file: 'g.ts', line: 5, description: 'noisy style nit here' }],
      },
    )
    const agg = aggregate([caseA, caseB])
    // 1 of 2 real caught
    expect(agg.realCaught).toBe(1)
    expect(agg.realTotal).toBe(2)
    expect(agg.recall).toBe(0.5)
    // 1 of 1 noise flagged
    expect(agg.noiseFlagged).toBe(1)
    expect(agg.noiseTotal).toBe(1)
    expect(agg.noiseRate).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// evaluateGates
// ---------------------------------------------------------------------------

describe('evaluateGates', () => {
  const cleanCase = scoreCase(
    'c',
    [{ file: 'f.ts', line: 1, description: 'real bug found here' }],
    { real: [{ file: 'f.ts', line: 1, description: 'real bug found here' }], noise: [] },
  )

  it('passes when recall is high and noise-rate is low', () => {
    const agg = aggregate([cleanCase])
    const result = evaluateGates(agg, { minRecall: 0.5, maxNoiseRate: 0.25 })
    expect(result.passed).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('fails when recall is below the minimum', () => {
    const missCase = scoreCase(
      'd',
      [],
      { real: [{ file: 'f.ts', line: 1, description: 'uncaught real bug' }], noise: [] },
    )
    const agg = aggregate([missCase])
    const result = evaluateGates(agg, { minRecall: 0.5, maxNoiseRate: 0.25 })
    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toContain('recall')
  })

  it('fails when noise-rate exceeds the maximum', () => {
    const noisyCase = scoreCase(
      'e',
      [{ file: 'f.ts', line: 2, description: 'style nit flagged wrongly' }],
      {
        real: [{ file: 'f.ts', line: 9, description: 'unrelated real bug' }],
        noise: [{ file: 'f.ts', line: 2, description: 'style nit flagged wrongly' }],
      },
    )
    const agg = aggregate([noisyCase])
    const result = evaluateGates(agg, { minRecall: 0, maxNoiseRate: 0.25 })
    expect(result.passed).toBe(false)
    expect(result.reasons.join(' ')).toContain('noise-rate')
  })
})

describe('pct', () => {
  it('formats a ratio as a whole-number percentage', () => {
    expect(pct(0.5)).toBe('50%')
    expect(pct(1)).toBe('100%')
    expect(pct(0)).toBe('0%')
  })
})
