/**
 * requestWindow.test.ts — the size-aware per-request window ladder.
 *
 * Context: the reported failure was skill reviewers erroring while their peers
 * succeeded, with the SUCCESSFUL ones reporting 131k–368k token contexts. The
 * deep-review tool loop ran every round on a flat 60s window, which those
 * rounds cannot fit. #211 had already established the first rung of a ladder
 * for single-pass JSON tasks; this module is that ladder, shared.
 *
 * These tests pin BOTH halves: the #211 behaviour is byte-identical for every
 * prompt size it already covered, and larger prompts now get proportionally
 * more room, bounded.
 */
import { describe, it, expect } from 'vitest'
import {
  sizeAwareTimeoutMs,
  timeoutDetail,
  LARGE_PROMPT_TOKEN_THRESHOLD,
  LARGE_PROMPT_TIMEOUT_MS,
  MAX_PROMPT_TIMEOUT_MS,
} from './requestWindow'

describe('sizeAwareTimeoutMs — #211 behaviour is unchanged', () => {
  it('a small prompt gets NO explicit window (the transport default stands)', () => {
    expect(sizeAwareTimeoutMs(0)).toBeUndefined()
    expect(sizeAwareTimeoutMs(1_000)).toBeUndefined()
    expect(sizeAwareTimeoutMs(LARGE_PROMPT_TOKEN_THRESHOLD)).toBeUndefined()
  })

  it('the threshold is exclusive — one token over it crosses', () => {
    expect(sizeAwareTimeoutMs(LARGE_PROMPT_TOKEN_THRESHOLD + 1)).toBe(LARGE_PROMPT_TIMEOUT_MS)
  })

  it('every size #211 already covered (30k–100k) still gets exactly 120s', () => {
    for (const tokens of [31_000, 50_000, 75_000, 99_999]) {
      expect(sizeAwareTimeoutMs(tokens)).toBe(LARGE_PROMPT_TIMEOUT_MS)
    }
  })
})

describe('sizeAwareTimeoutMs — the huge rounds that were failing', () => {
  it('adds another step per additional 100k tokens', () => {
    // The user's succeeding reviewers reported 131k and 175k token contexts.
    expect(sizeAwareTimeoutMs(131_000)).toBe(2 * LARGE_PROMPT_TIMEOUT_MS)
    expect(sizeAwareTimeoutMs(175_000)).toBe(2 * LARGE_PROMPT_TIMEOUT_MS)
    // 230k wants a third step (360s), which the ceiling clamps to 300s.
    expect(sizeAwareTimeoutMs(230_000)).toBe(MAX_PROMPT_TIMEOUT_MS)
  })

  it('is capped — a 368k-token round does not get an unbounded window', () => {
    expect(sizeAwareTimeoutMs(368_000)).toBe(MAX_PROMPT_TIMEOUT_MS)
    expect(sizeAwareTimeoutMs(10_000_000)).toBe(MAX_PROMPT_TIMEOUT_MS)
  })

  it('never returns a window smaller than the first step once past the line', () => {
    for (const tokens of [30_001, 100_000, 250_000, 999_999]) {
      expect(sizeAwareTimeoutMs(tokens)!).toBeGreaterThanOrEqual(LARGE_PROMPT_TIMEOUT_MS)
    }
  })
})

describe('timeoutDetail — the actionable half of a timeout', () => {
  const detail = timeoutDetail('This deep-review round', 240_000, 131_000)

  it('names the stage that timed out', () => {
    expect(detail).toContain('This deep-review round')
  })

  it('names the window and the size, so "too slow" is quantified', () => {
    expect(detail).toContain('240s')
    expect(detail).toContain('~131k tokens')
  })

  it('names the three levers that actually shrink a round', () => {
    expect(detail).toMatch(/fewer reviewers/i)
    expect(detail).toMatch(/faster model/i)
    expect(detail).toMatch(/deep mode/i)
  })

  it('carries NO model output and no code — safe as analytics reason_detail', () => {
    // Only a stage label, a duration and a token count are interpolated; there
    // is no parameter through which model output or code could enter.
    expect(detail).not.toMatch(/```/)
    expect(timeoutDetail('x', 1_000, 1_000)).toBe(
      'x exceeded its 1s window at ~1k tokens of context — ' +
        'try fewer reviewers, a faster model, or turning off deep mode.',
    )
  })
})
