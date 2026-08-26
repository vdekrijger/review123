/**
 * Tests for src/lib/ai/outcomeTests.ts — the DETERMINISTIC outcome↔test join.
 *
 * The join is pure post-processing: an outcome claim's `symbols` are resolved
 * against the PR's changed test-file contents through the #95 pairing
 * machinery (pairSymbolsWithTests). No LLM anywhere. Covers:
 *   - named match (symbol in a test title) → confidence 'named' + title
 *   - referenced-only match → confidence 'referenced' (rendered "likely")
 *   - no-match honesty → [] (the panel's "no test asserts this outcome")
 *   - empty symbols / empty test contents → []
 *   - conservative guards inherited from #95 (short symbols, whole-word only)
 *   - per-test-file dedupe keeping the highest confidence, named-first order,
 *     and the OUTCOME_TEST_REFS_MAX cap
 */

import { describe, it, expect } from 'vitest'
import { matchOutcomeTests, OUTCOME_TEST_REFS_MAX } from './outcomeTests'
import type { TestFileContent } from '../diff/symbolTests'

const NAMED_TEST: TestFileContent = {
  path: 'src/review.422.test.ts',
  content: [
    "describe('postReview', () => {",
    "  it('returns 422 on an off-diff anchor', () => {",
    '    expect(postReview(offDiff)).toBe(422)',
    '  })',
    '})',
  ].join('\n'),
}

const REFERENCED_TEST: TestFileContent = {
  path: 'src/anchor.test.ts',
  content: [
    "describe('anchoring', () => {",
    "  it('falls back to file level', () => {",
    '    const out = anchorComment(comment)',
    "    expect(out.level).toBe('file')",
    '  })',
    '})',
  ].join('\n'),
}

describe('matchOutcomeTests', () => {
  it('resolves a symbol NAMED in a test title with confidence named + the title', () => {
    const refs = matchOutcomeTests(['postReview'], [NAMED_TEST])
    expect(refs).toHaveLength(1)
    expect(refs[0].testFile).toBe('src/review.422.test.ts')
    expect(refs[0].confidence).toBe('named')
    expect(refs[0].title).toBe('postReview')
    expect(refs[0].lineRange.start).toBeGreaterThan(0)
  })

  it('resolves a symbol only CALLED in a test with confidence referenced (the "likely" tier)', () => {
    const refs = matchOutcomeTests(['anchorComment'], [REFERENCED_TEST])
    expect(refs).toHaveLength(1)
    expect(refs[0].testFile).toBe('src/anchor.test.ts')
    expect(refs[0].confidence).toBe('referenced')
    expect(refs[0].title).toBeUndefined()
  })

  it('no-match honesty: a symbol no test mentions yields [] — never a fabricated ref', () => {
    expect(matchOutcomeTests(['completelyUnknownSymbol'], [NAMED_TEST, REFERENCED_TEST])).toEqual([])
  })

  it('empty symbols yield [] (the claim names nothing to match on)', () => {
    expect(matchOutcomeTests([], [NAMED_TEST])).toEqual([])
    expect(matchOutcomeTests(['  ', ''], [NAMED_TEST])).toEqual([])
  })

  it('empty test contents yield [] (no changed test files / contents unavailable)', () => {
    expect(matchOutcomeTests(['postReview'], [])).toEqual([])
  })

  it('inherits the #95 conservative guards: <3-char symbols refused, whole-word only', () => {
    // 'po' is too short; 'post' must not match inside 'postReview'.
    expect(matchOutcomeTests(['po'], [NAMED_TEST])).toEqual([])
    expect(matchOutcomeTests(['post'], [NAMED_TEST])).toEqual([])
  })

  it('dedupes by test file across symbols, keeping the highest-confidence match', () => {
    // Both symbols live in the SAME test file: postReview is named in the
    // title, anchorHelper only referenced in the body → ONE ref, named.
    const combined: TestFileContent = {
      path: 'src/combined.test.ts',
      content: [
        "describe('postReview', () => {",
        "  it('posts', () => {",
        '    anchorHelper(x)',
        '  })',
        '})',
      ].join('\n'),
    }
    const refs = matchOutcomeTests(['anchorHelper', 'postReview'], combined ? [combined] : [])
    expect(refs).toHaveLength(1)
    expect(refs[0].confidence).toBe('named')
  })

  it('orders named matches before referenced ones', () => {
    const refs = matchOutcomeTests(['postReview', 'anchorComment'], [REFERENCED_TEST, NAMED_TEST])
    expect(refs.map((r) => r.confidence)).toEqual(['named', 'referenced'])
    expect(refs[0].testFile).toBe('src/review.422.test.ts')
  })

  it(`caps the refs at OUTCOME_TEST_REFS_MAX (${OUTCOME_TEST_REFS_MAX})`, () => {
    const many: TestFileContent[] = Array.from({ length: OUTCOME_TEST_REFS_MAX + 2 }, (_, i) => ({
      path: `src/t${i}.test.ts`,
      content: "it('x', () => { sharedSymbol() })",
    }))
    const refs = matchOutcomeTests(['sharedSymbol'], many)
    expect(refs).toHaveLength(OUTCOME_TEST_REFS_MAX)
  })

  it('dedupes repeated symbols in the claim (one search, one ref)', () => {
    const refs = matchOutcomeTests(['postReview', 'postReview'], [NAMED_TEST])
    expect(refs).toHaveLength(1)
  })
})
