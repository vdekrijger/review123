/**
 * Tests for runSkillReviews(..., { autoRetry: N }) — the auto-retry loop.
 *
 * Covers:
 *   - a reviewer that fails N times then succeeds ends 'done'
 *   - a reviewer that always fails ends 'error' after EXACTLY the retry budget
 *     of additional attempts (no infinite loop)
 *   - autoRetry omitted (or 0) is byte-identical: a single attempt, no retries
 *   - a reviewer that already succeeded is never reset/re-run during retries
 *   - PACING: each retry round WAITS before re-dispatching — max observed
 *     Retry-After from the failed round when knowable, else 2s/4s/8s, cap 20s
 *
 * Fake timers throughout: the pacing sleeps are real setTimeouts, so every
 * test drives the run with advanceTimersByTimeAsync and asserts WHEN each
 * round fires, not just that it fired.
 *
 * Reuses the run.svelte DI harness pattern from skill-run.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAiRun } from './run.svelte'
import type { PackedContext } from '../context/pack'
import type { CiSummary } from '../github/checks'
import type { SkillReviewResult } from './schemas'
import { LlmError } from '../llm/llm'
import { addSkill, removeSkill } from '../skills/skills'

const PACKED_CTX: PackedContext = {
  text: 'some PR context',
  notAnalyzed: [],
  includedFiles: ['src/foo.ts'],
}

const CI_SUMMARY: CiSummary = { total: 1, passed: 1, failed: 0, pending: 0, failures: [] }

const SKILL_RESULT: SkillReviewResult = {
  skillName: 'Security Reviewer',
  findings: [{ path: 'src/foo.ts', line: 10, severity: 'high', body: 'SQL injection risk' }],
}

type ValidateFn = (x: unknown) => unknown

function makeDeps() {
  localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test' }))
  const gateAi = vi.fn().mockResolvedValue(true)
  const getCached = vi.fn().mockResolvedValue(null)
  const setCached = vi.fn().mockResolvedValue(undefined)
  const llmJsonWithRepairWithUsage = vi.fn()
  const track = vi.fn()
  return { gateAi, getCached, setCached, llmJsonWithRepairWithUsage, track }
}

function makeInput() {
  return {
    prKey: 'owner/repo#1@abc123',
    repo: 'owner/repo',
    isPrivate: false as boolean | undefined,
    pack: async (): Promise<PackedContext> => PACKED_CTX,
    ci: async (): Promise<CiSummary | null> => CI_SUMMARY,
    ask: async () => true,
  }
}

/**
 * Drive a runSkillReviews promise to completion under fake timers: advance
 * time in 1s steps (flushing microtasks each step) until it settles. Bounded
 * so a pacing regression fails loudly instead of hanging the suite.
 */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false
  const tracked = p.finally(() => {
    done = true
  })
  for (let i = 0; i < 120 && !done; i++) {
    await vi.advanceTimersByTimeAsync(1_000)
  }
  if (!done) throw new Error('runSkillReviews did not settle under fake timers')
  return tracked
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runSkillReviews — autoRetry', () => {
  it('a reviewer that fails twice then succeeds on attempt 3 ends done', async () => {
    const deps = makeDeps()
    let attempts = 0
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_o: unknown, _v: ValidateFn) => {
      attempts += 1
      if (attempts < 3) throw new LlmError('server', 'boom')
      return { result: SKILL_RESULT, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    })
    const skill = addSkill('Security Reviewer', 'check for XSS')

    const run = createAiRun(makeInput(), deps)
    await settle(run.runSkillReviews(undefined, [], { autoRetry: 3 }))

    expect(run.skillReviews).toHaveLength(1)
    expect(run.skillReviews[0].state.status).toBe('done')
    // 1 initial + 2 retries that finally succeeded = 3 attempts.
    expect(attempts).toBe(3)

    removeSkill(skill.id)
  })

  it('a reviewer that always fails ends error after exactly the retry budget', async () => {
    const deps = makeDeps()
    let attempts = 0
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_o: unknown, _v: ValidateFn) => {
      attempts += 1
      throw new LlmError('server', 'boom')
    })
    const skill = addSkill('Security Reviewer', 'check for XSS')

    const run = createAiRun(makeInput(), deps)
    await settle(run.runSkillReviews(undefined, [], { autoRetry: 3 }))

    expect(run.skillReviews[0].state.status).toBe('error')
    // 1 initial attempt + exactly 3 retries = 4 attempts, then it stops (no loop).
    expect(attempts).toBe(4)

    removeSkill(skill.id)
  })

  it('omitting autoRetry attempts each reviewer exactly once (byte-identical)', async () => {
    const deps = makeDeps()
    let attempts = 0
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_o: unknown, _v: ValidateFn) => {
      attempts += 1
      throw new LlmError('server', 'boom')
    })
    const skill = addSkill('Security Reviewer', 'check for XSS')

    const run = createAiRun(makeInput(), deps)
    await settle(run.runSkillReviews())

    expect(run.skillReviews[0].state.status).toBe('error')
    expect(attempts).toBe(1)

    removeSkill(skill.id)
  })

  it('only re-runs errored reviewers — an already-done reviewer is never reset', async () => {
    const deps = makeDeps()
    // Reviewer A always succeeds; reviewer B fails once then succeeds.
    let aCalls = 0
    let bAttempts = 0
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (opts: { system: string }, _v: ValidateFn) => {
      const isB = opts.system.includes('Reviewer B') || opts.system.includes('persona-b')
      if (isB) {
        bAttempts += 1
        if (bAttempts < 2) throw new LlmError('server', 'boom')
        return { result: { skillName: 'Reviewer B', findings: [] }, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
      }
      aCalls += 1
      return { result: { skillName: 'Reviewer A', findings: [] }, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    })

    const a = addSkill('Reviewer A', 'persona-a content')
    const b = addSkill('Reviewer B', 'persona-b content')

    const run = createAiRun(makeInput(), deps)
    await settle(run.runSkillReviews(undefined, [], { autoRetry: 3 }))

    expect(run.skillReviews.every((sr) => sr.state.status === 'done')).toBe(true)
    // A only ran once (never reset by the retry round); B ran twice.
    expect(aCalls).toBe(1)
    expect(bAttempts).toBe(2)

    removeSkill(a.id)
    removeSkill(b.id)
  })
})

// ---------------------------------------------------------------------------
// Pacing — retry rounds wait BEFORE re-dispatching (no immediate re-hit of an
// exhausted rate limit). Fallback ladder 2s/4s/8s; Retry-After wins when
// observed; every delay capped at 20s.
// ---------------------------------------------------------------------------

describe('runSkillReviews — autoRetry pacing', () => {
  it('rounds wait 2s/4s/8s when no Retry-After was observed', async () => {
    const deps = makeDeps()
    let attempts = 0
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_o: unknown, _v: ValidateFn) => {
      attempts += 1
      throw new LlmError('server', 'boom') // transient-classified, NO retryAfterMs
    })
    const skill = addSkill('Security Reviewer', 'check for XSS')

    const run = createAiRun(makeInput(), deps)
    const promise = run.runSkillReviews(undefined, [], { autoRetry: 3 })

    // Initial round completes without any timer.
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toBe(1)

    // Round 1 fires ONLY after the 2s wait.
    await vi.advanceTimersByTimeAsync(1_999)
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toBe(2)

    // Round 2: +4s.
    await vi.advanceTimersByTimeAsync(3_999)
    expect(attempts).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toBe(3)

    // Round 3: +8s.
    await vi.advanceTimersByTimeAsync(7_999)
    expect(attempts).toBe(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toBe(4)

    await settle(promise)
    expect(run.skillReviews[0].state.status).toBe('error')
    expect(attempts).toBe(4) // budget spent, no extra attempts after settle

    removeSkill(skill.id)
  })

  it('uses the MAX observed Retry-After from the failed round when knowable', async () => {
    const deps = makeDeps()
    let aAttempts = 0
    let bAttempts = 0
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (opts: { system: string }, _v: ValidateFn) => {
      const isB = opts.system.includes('persona-b')
      if (isB) {
        bAttempts += 1
        if (bAttempts === 1) {
          throw new LlmError('rate-limited', 'Rate limited (429)', { status: 429, retryAfterMs: 9_000 })
        }
        return { result: { skillName: 'Reviewer B', findings: [] }, usage: undefined }
      }
      aAttempts += 1
      if (aAttempts === 1) {
        throw new LlmError('rate-limited', 'Rate limited (429)', { status: 429, retryAfterMs: 5_000 })
      }
      return { result: { skillName: 'Reviewer A', findings: [] }, usage: undefined }
    })
    const a = addSkill('Reviewer A', 'persona-a content')
    const b = addSkill('Reviewer B', 'persona-b content')

    const run = createAiRun(makeInput(), deps)
    const promise = run.runSkillReviews(undefined, [], { autoRetry: 3 })

    await vi.advanceTimersByTimeAsync(0)
    expect(aAttempts).toBe(1)
    expect(bAttempts).toBe(1)

    // The provider told us when capacity returns: max(5s, 9s) = 9s — NOT the 2s ladder.
    await vi.advanceTimersByTimeAsync(8_999)
    expect(aAttempts).toBe(1)
    expect(bAttempts).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(aAttempts).toBe(2)
    expect(bAttempts).toBe(2)

    await settle(promise)
    expect(run.skillReviews.every((sr) => sr.state.status === 'done')).toBe(true)

    removeSkill(a.id)
    removeSkill(b.id)
  })

  it('caps an oversized Retry-After at 20s', async () => {
    const deps = makeDeps()
    let attempts = 0
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_o: unknown, _v: ValidateFn) => {
      attempts += 1
      if (attempts === 1) {
        throw new LlmError('rate-limited', 'Rate limited (429)', { status: 429, retryAfterMs: 60_000 })
      }
      return { result: SKILL_RESULT, usage: undefined }
    })
    const skill = addSkill('Security Reviewer', 'check for XSS')

    const run = createAiRun(makeInput(), deps)
    const promise = run.runSkillReviews(undefined, [], { autoRetry: 3 })

    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toBe(1)

    // 60s Retry-After is capped: the retry fires at 20s, not 60s.
    await vi.advanceTimersByTimeAsync(19_999)
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toBe(2)

    await settle(promise)
    expect(run.skillReviews[0].state.status).toBe('done')

    removeSkill(skill.id)
  })

  it('a stale Retry-After does not leak into later rounds (ladder resumes)', async () => {
    const deps = makeDeps()
    let attempts = 0
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_o: unknown, _v: ValidateFn) => {
      attempts += 1
      if (attempts === 1) {
        // Round 0 failure carries Retry-After 3s…
        throw new LlmError('rate-limited', 'Rate limited (429)', { status: 429, retryAfterMs: 3_000 })
      }
      if (attempts === 2) {
        // …but the round-1 failure does NOT (plain 5xx).
        throw new LlmError('server', 'boom')
      }
      return { result: SKILL_RESULT, usage: undefined }
    })
    const skill = addSkill('Security Reviewer', 'check for XSS')

    const run = createAiRun(makeInput(), deps)
    const promise = run.runSkillReviews(undefined, [], { autoRetry: 3 })

    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toBe(1)

    // Round 1 honors the observed 3s Retry-After.
    await vi.advanceTimersByTimeAsync(2_999)
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toBe(2)

    // Round 2: the 3s hint is stale (cleared on the fresh attempt) — the
    // fallback ladder's round-1 delay (4s) applies, not 3s again.
    await vi.advanceTimersByTimeAsync(3_999)
    expect(attempts).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toBe(3)

    await settle(promise)
    expect(run.skillReviews[0].state.status).toBe('done')

    removeSkill(skill.id)
  })
})
