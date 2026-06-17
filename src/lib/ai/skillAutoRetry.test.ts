/**
 * Tests for runSkillReviews(..., { autoRetry: N }) — the auto-retry loop.
 *
 * Covers:
 *   - a reviewer that fails N times then succeeds ends 'done'
 *   - a reviewer that always fails ends 'error' after EXACTLY the retry budget
 *     of additional attempts (no infinite loop)
 *   - autoRetry omitted (or 0) is byte-identical: a single attempt, no retries
 *   - a reviewer that already succeeded is never reset/re-run during retries
 *
 * Reuses the run.svelte DI harness pattern from skill-run.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
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

beforeEach(() => {
  localStorage.clear()
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
    await run.runSkillReviews(undefined, [], { autoRetry: 3 })

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
    await run.runSkillReviews(undefined, [], { autoRetry: 3 })

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
    await run.runSkillReviews()

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
    await run.runSkillReviews(undefined, [], { autoRetry: 3 })

    expect(run.skillReviews.every((sr) => sr.state.status === 'done')).toBe(true)
    // A only ran once (never reset by the retry round); B ran twice.
    expect(aCalls).toBe(1)
    expect(bAttempts).toBe(2)

    removeSkill(a.id)
    removeSkill(b.id)
  })
})
