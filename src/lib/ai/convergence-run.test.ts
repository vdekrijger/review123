/**
 * Orchestration tests for the convergence pass in src/lib/ai/run.svelte.ts
 * (runConvergencePass, wired at the end of runSkillReviews / retrySkill).
 *
 * The load-bearing guarantee: the pass is LOSS-PROOF. Whatever happens to the
 * convergence call — error, garbage output, skip — the reviewer entries are
 * NEVER touched; the original findings render unmerged exactly as before.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAiRun } from './run.svelte'
import type { PackedContext } from '../context/pack'
import type { CiSummary } from '../github/checks'
import type { SkillReviewResult } from './schemas'
import type { Draft } from '../drafts/drafts.svelte'
import { addSkill, removeSkill, listSkills } from '../skills/skills'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PACKED_CTX: PackedContext = {
  text: 'some PR context',
  notAnalyzed: [],
  includedFiles: ['src/foo.ts'],
}

const CI_SUMMARY: CiSummary = { total: 1, passed: 1, failed: 0, pending: 0, failures: [] }

const SKILL_RESULT_A: SkillReviewResult = {
  skillName: 'Security Reviewer',
  findings: [{ path: 'src/foo.ts', line: 10, severity: 'high', body: 'SQL injection risk' }],
}

const SKILL_RESULT_B: SkillReviewResult = {
  skillName: 'Performance Reviewer',
  findings: [{ path: 'src/foo.ts', line: 20, severity: 'medium', body: 'N+1 query' }],
}

/** The convergence system prompt's stable dispatch marker (same as the e2e stubs). */
const CONVERGENCE_MARKER = 'consolidating overlapping code-review findings'

type ValidateFn = (x: unknown) => unknown

interface LlmOpts { system: string; user: string }

/**
 * DI stub factory (mirrors skill-run.test.ts). `onConvergence` decides what the
 * convergence LLM call does; reviewer calls dispatch by persona name.
 */
function makeDeps(onConvergence?: (opts: LlmOpts, validate: ValidateFn) => Promise<unknown>) {
  localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test' }))

  const gateAi = vi.fn().mockResolvedValue(true)
  const getCached = vi.fn().mockResolvedValue(null)
  const setCached = vi.fn().mockResolvedValue(undefined)
  const llmStream = vi.fn().mockResolvedValue('hello')
  const llmStreamWithUsage = vi.fn().mockResolvedValue({ content: 'hello' })
  const llmJsonWithRepair = vi.fn()
  const track = vi.fn()

  const llmJsonWithRepairWithUsage = vi.fn().mockImplementation(
    async (opts: LlmOpts, validate: ValidateFn) => {
      if (opts.system.includes(CONVERGENCE_MARKER)) {
        if (!onConvergence) throw new Error('unexpected convergence call')
        const result = await onConvergence(opts, validate)
        return { result, usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }
      }
      const result = opts.system.includes('Performance Reviewer') ? SKILL_RESULT_B : SKILL_RESULT_A
      return { result, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
  )

  return { gateAi, getCached, setCached, llmStream, llmStreamWithUsage, llmJsonWithRepair, llmJsonWithRepairWithUsage, track }
}

function makeInput(drafts?: () => Draft[]) {
  return {
    prKey: 'owner/repo#1@abc123',
    repo: 'owner/repo',
    isPrivate: false as boolean | undefined,
    pack: async (): Promise<PackedContext> => PACKED_CTX,
    ci: async (): Promise<CiSummary | null> => CI_SUMMARY,
    ask: async () => true,
    ...(drafts ? { drafts } : {}),
  }
}

function convergenceCalls(deps: ReturnType<typeof makeDeps>): LlmOpts[] {
  return deps.llmJsonWithRepairWithUsage.mock.calls
    .map((c: unknown[]) => c[0] as LlmOpts)
    .filter((o) => o.system.includes(CONVERGENCE_MARKER))
}

beforeEach(() => {
  localStorage.clear()
  listSkills().forEach((s) => removeSkill(s.id))
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('convergence pass — happy path', () => {
  it('runs once after both reviewers settle and stores fingerprinted clusters', async () => {
    const deps = makeDeps(async () => ({ clusters: [{ members: ['f0', 'f1'], primary: 'f0', reason: 'same issue' }] }))
    const a = addSkill('Security Reviewer', 'sec content')
    const b = addSkill('Performance Reviewer', 'perf content')

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    expect(convergenceCalls(deps)).toHaveLength(1)
    expect(run.convergence.status).toBe('done')
    const value = run.convergence.value as { fingerprint: string; clusters: unknown[] }
    expect(value.clusters).toEqual([{ members: ['f0', 'f1'], primary: 'f0', reason: 'same issue' }])
    expect(typeof value.fingerprint).toBe('string')

    // Loss-proof invariant: the reviewer entries themselves are NEVER rewritten
    // by the pass — the merge is applied downstream (applyConvergence in the UI).
    expect(run.skillReviews[0].state.value).toEqual(SKILL_RESULT_A)
    expect(run.skillReviews[1].state.value).toEqual(SKILL_RESULT_B)

    // Usage folds into the run total (reviewers 15+15 + convergence 6).
    expect(run.totalUsage?.total_tokens).toBe(36)

    // The result is cached under a convergence key.
    const cachedKeys = deps.setCached.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(cachedKeys.some((k) => k.includes('convergence:'))).toBe(true)

    removeSkill(a.id)
    removeSkill(b.id)
  })

  it('feeds the current draft comments into the prompt as draft-N rows', async () => {
    const deps = makeDeps(async () => ({ clusters: [] }))
    const a = addSkill('Security Reviewer', 'sec content')
    const b = addSkill('Performance Reviewer', 'perf content')
    const drafts: Draft[] = [
      { prKey: 'k', path: 'src/foo.ts', line: 11, side: 'RIGHT', body: 'I think this is injectable', updatedAt: 1 },
      // A thread REPLY (n>0) must be excluded — only root comments are candidates.
      { prKey: 'k', path: 'src/foo.ts', line: 11, side: 'RIGHT', body: 'reply text', n: 1, updatedAt: 2 },
    ]

    const run = createAiRun(makeInput(() => drafts), deps)
    await run.runSkillReviews()

    const call = convergenceCalls(deps)[0]
    expect(call.user).toContain('draft-0')
    expect(call.user).toContain('I think this is injectable')
    expect(call.user).not.toContain('draft-1')
    expect(call.user).not.toContain('reply text')
    expect(run.convergence.status).toBe('done')

    removeSkill(a.id)
    removeSkill(b.id)
  })

  it('cache hit: restores the value without an LLM call', async () => {
    const cached = { fingerprint: 'fp', clusters: [{ members: ['f0', 'f1'], primary: 'f0', reason: 'r' }] }
    const deps = makeDeps()
    deps.getCached.mockImplementation(async (key: string) => (key.includes('convergence:') ? cached : null))
    const a = addSkill('Security Reviewer', 'sec content')
    const b = addSkill('Performance Reviewer', 'perf content')

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    expect(convergenceCalls(deps)).toHaveLength(0)
    expect(run.convergence.status).toBe('done')
    expect(run.convergence.value).toEqual(cached)

    removeSkill(a.id)
    removeSkill(b.id)
  })
})

// ---------------------------------------------------------------------------
// Skip conditions
// ---------------------------------------------------------------------------

describe('convergence pass — skip conditions', () => {
  it('skips (idle, no call) when only one reviewer produced findings', async () => {
    const deps = makeDeps()
    const a = addSkill('Security Reviewer', 'sec content')

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    expect(convergenceCalls(deps)).toHaveLength(0)
    expect(run.convergence.status).toBe('idle')

    removeSkill(a.id)
  })

  it('skips when a second reviewer exists but returned zero findings', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (opts: LlmOpts) => {
      if (opts.system.includes(CONVERGENCE_MARKER)) throw new Error('unexpected convergence call')
      const result = opts.system.includes('Performance Reviewer')
        ? { skillName: 'Performance Reviewer', findings: [] }
        : SKILL_RESULT_A
      return { result, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    })
    const a = addSkill('Security Reviewer', 'sec content')
    const b = addSkill('Performance Reviewer', 'perf content')

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    expect(run.convergence.status).toBe('idle')

    removeSkill(a.id)
    removeSkill(b.id)
  })
})

// ---------------------------------------------------------------------------
// Loss-proof degradation (MANDATORY)
// ---------------------------------------------------------------------------

describe('convergence pass — loss-proof degradation', () => {
  it('LLM error → convergence "error", reviewer entries byte-identical (originals untouched)', async () => {
    const deps = makeDeps(async () => {
      throw new Error('boom')
    })
    const a = addSkill('Security Reviewer', 'sec content')
    const b = addSkill('Performance Reviewer', 'perf content')

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    const snapshot = JSON.parse(JSON.stringify(run.skillReviews))

    expect(run.convergence.status).toBe('error')
    expect(run.convergence.error).toBeTruthy()
    // THE invariant: originals render unmerged exactly as today.
    expect(run.skillReviews).toEqual(snapshot)
    expect(run.skillReviews[0].state.status).toBe('done')
    expect(run.skillReviews[0].state.value).toEqual(SKILL_RESULT_A)
    expect(run.skillReviews[1].state.value).toEqual(SKILL_RESULT_B)
    expect(deps.track).toHaveBeenCalledWith('ai_task_failed', { task: 'convergence', reason: 'unknown' })
    // Nothing cached for the failed pass.
    const cachedKeys = deps.setCached.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(cachedKeys.some((k) => k.includes('convergence:'))).toBe(false)

    removeSkill(a.id)
    removeSkill(b.id)
  })

  it('garbage output (even bypassing transport validation) → "error", originals untouched', async () => {
    // The stubbed transport RETURNS the garbage instead of validating it —
    // exercising the defense-in-depth re-validation inside the pass.
    const deps = makeDeps(async () => ({ readingOrder: [], hotspots: [] }))
    const a = addSkill('Security Reviewer', 'sec content')
    const b = addSkill('Performance Reviewer', 'perf content')

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    expect(run.convergence.status).toBe('error')
    expect(run.skillReviews[0].state.value).toEqual(SKILL_RESULT_A)
    expect(run.skillReviews[1].state.value).toEqual(SKILL_RESULT_B)

    removeSkill(a.id)
    removeSkill(b.id)
  })

  it('a throwing drafts() provider never sinks the pass', async () => {
    const deps = makeDeps(async () => ({ clusters: [] }))
    const a = addSkill('Security Reviewer', 'sec content')
    const b = addSkill('Performance Reviewer', 'perf content')

    const run = createAiRun(
      makeInput(() => {
        throw new Error('draft store gone')
      }),
      deps,
    )
    await run.runSkillReviews()

    expect(run.convergence.status).toBe('done')

    removeSkill(a.id)
    removeSkill(b.id)
  })
})

// ---------------------------------------------------------------------------
// retrySkill recomputes the pass
// ---------------------------------------------------------------------------

describe('convergence pass — retrySkill', () => {
  it('re-runs the pass after a single-reviewer retry', async () => {
    const deps = makeDeps(async () => ({ clusters: [] }))
    const a = addSkill('Security Reviewer', 'sec content')
    const b = addSkill('Performance Reviewer', 'perf content')

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()
    expect(convergenceCalls(deps)).toHaveLength(1)

    await run.retrySkill(a.id)
    // The batch pass + the retry pass (errors are never cached; the retry
    // produced the same finding set, and the batch pass cached that set's
    // clusters — retry may hit that cache OR call again; both are fine, but
    // the state must be settled and loss-proof).
    expect(run.convergence.status).toBe('done')
    expect(run.skillReviews[0].state.value).toEqual(SKILL_RESULT_A)

    removeSkill(a.id)
    removeSkill(b.id)
  })
})
