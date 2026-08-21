/**
 * Orchestration tests for the SIMPLIFY pass in src/lib/ai/run.svelte.ts
 * (runSimplifyPass, wired after runConvergencePass in runSkillReviews /
 * retrySkill).
 *
 * The load-bearing guarantee (same as convergence): the pass is LOSS-PROOF.
 * Whatever happens to the simplify call — error, garbage output, 'off' mode,
 * skip — the reviewer entries are NEVER touched; the original finding bodies
 * render exactly as before the pass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAiRun } from './run.svelte'
import type { PackedContext } from '../context/pack'
import type { CiSummary } from '../github/checks'
import type { SkillReviewResult } from './schemas'
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
  findings: [{ path: 'src/foo.ts', line: 10, severity: 'high', body: 'It is worth noting a potential SQL injection risk wherein `query` may possibly be unsafe' }],
}

const SKILL_RESULT_B: SkillReviewResult = {
  skillName: 'Performance Reviewer',
  findings: [{ path: 'src/foo.ts', line: 20, severity: 'medium', body: 'N+1 query' }],
}

/** The convergence system prompt's stable dispatch marker. */
const CONVERGENCE_MARKER = 'consolidating overlapping code-review findings'
/** The simplify system prompt's stable dispatch marker (same as the e2e stubs). */
const SIMPLIFY_MARKER = 'rewriting code-review findings into plain'

type ValidateFn = (x: unknown) => unknown

interface LlmOpts { system: string; user: string }

/**
 * DI stub factory (mirrors convergence-run.test.ts). `onSimplify` decides what
 * the simplify LLM call does; `onConvergence` the convergence call; reviewer
 * calls dispatch by persona name.
 */
function makeDeps(
  onSimplify?: (opts: LlmOpts, validate: ValidateFn) => Promise<unknown>,
  onConvergence?: (opts: LlmOpts, validate: ValidateFn) => Promise<unknown>,
) {
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
      if (opts.system.includes(SIMPLIFY_MARKER)) {
        if (!onSimplify) throw new Error('unexpected simplify call')
        const result = await onSimplify(opts, validate)
        return { result, usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }
      }
      if (opts.system.includes(CONVERGENCE_MARKER)) {
        const result = onConvergence ? await onConvergence(opts, validate) : { clusters: [] }
        return { result, usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }
      }
      const result = opts.system.includes('Performance Reviewer') ? SKILL_RESULT_B : SKILL_RESULT_A
      return { result, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    },
  )

  return { gateAi, getCached, setCached, llmStream, llmStreamWithUsage, llmJsonWithRepair, llmJsonWithRepairWithUsage, track }
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

function callsMatching(deps: ReturnType<typeof makeDeps>, marker: string): LlmOpts[] {
  return deps.llmJsonWithRepairWithUsage.mock.calls
    .map((c: unknown[]) => c[0] as LlmOpts)
    .filter((o) => o.system.includes(marker))
}

beforeEach(() => {
  localStorage.clear()
  listSkills().forEach((s) => removeSkill(s.id))
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('simplify pass — happy path', () => {
  it('runs once AFTER the convergence pass and stores fingerprinted rewrites', async () => {
    const deps = makeDeps(async () => ({ rewrites: [{ id: 'f0', simple: 'SQL injection via `query` — sanitize it.' }] }))
    const a = addSkill('Security Reviewer', 'sec content')
    const b = addSkill('Performance Reviewer', 'perf content')

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    expect(callsMatching(deps, SIMPLIFY_MARKER)).toHaveLength(1)
    // Ordering: the simplify call is dispatched after the convergence call.
    const order = deps.llmJsonWithRepairWithUsage.mock.calls.map((c: unknown[]) => (c[0] as LlmOpts).system)
    expect(order.findIndex((s) => s.includes(SIMPLIFY_MARKER))).toBeGreaterThan(
      order.findIndex((s) => s.includes(CONVERGENCE_MARKER)),
    )

    expect(run.simplify.status).toBe('done')
    const value = run.simplify.value as { fingerprint: string; rewrites: unknown[] }
    expect(value.rewrites).toEqual([{ id: 'f0', simple: 'SQL injection via `query` — sanitize it.' }])
    expect(typeof value.fingerprint).toBe('string')

    // Loss-proof invariant: the reviewer entries themselves are NEVER rewritten
    // by the pass — the rewrite is applied downstream (applySimplify in the UI).
    expect(run.skillReviews[0].state.value).toEqual(SKILL_RESULT_A)
    expect(run.skillReviews[1].state.value).toEqual(SKILL_RESULT_B)

    // Usage folds into the run total (reviewers 15+15 + convergence 6 + simplify 12).
    expect(run.totalUsage?.total_tokens).toBe(48)

    // The result is cached under the versioned simplify segment: simplify:<djb2>|v1.
    const cachedKeys = deps.setCached.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(cachedKeys.some((k) => /\|simplify:[a-z0-9]+\|v1$/.test(k))).toBe(true)

    removeSkill(a.id)
    removeSkill(b.id)
  })

  it('feeds the POST-convergence (merged) bodies: an absorbed finding does not appear', async () => {
    const deps = makeDeps(
      async (opts) => {
        // The convergence pass merged f1 into f0 → only ONE finding remains,
        // enumerated as f0 with the PRIMARY's body.
        const payload = JSON.parse(opts.user) as { findings: { id: string; body: string }[] }
        expect(payload.findings).toHaveLength(1)
        expect(payload.findings[0].id).toBe('f0')
        expect(payload.findings[0].body).toBe(SKILL_RESULT_A.findings[0].body)
        return { rewrites: [] }
      },
      async () => ({ clusters: [{ members: ['f0', 'f1'], primary: 'f0', reason: 'same issue' }] }),
    )
    const a = addSkill('Security Reviewer', 'sec content')
    const b = addSkill('Performance Reviewer', 'perf content')

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    expect(run.convergence.status).toBe('done')
    expect(run.simplify.status).toBe('done')
    expect(callsMatching(deps, SIMPLIFY_MARKER)).toHaveLength(1)

    removeSkill(a.id)
    removeSkill(b.id)
  })

  it('runs even when convergence SKIPPED itself (single reviewer with findings)', async () => {
    const deps = makeDeps(async () => ({ rewrites: [{ id: 'f0', simple: 'Plainer.' }] }))
    const a = addSkill('Security Reviewer', 'sec content')

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    expect(run.convergence.status).toBe('idle') // skipped — nobody to converge with
    expect(callsMatching(deps, CONVERGENCE_MARKER)).toHaveLength(0)
    expect(run.simplify.status).toBe('done') // simplify still ran on the raw finding
    expect(callsMatching(deps, SIMPLIFY_MARKER)).toHaveLength(1)

    removeSkill(a.id)
  })

  it('runs on the raw findings when the convergence pass FAILED', async () => {
    const deps = makeDeps(
      async () => ({ rewrites: [{ id: 'f0', simple: 'Plainer A.' }, { id: 'f1', simple: 'Plainer B.' }] }),
      async () => {
        throw new Error('convergence boom')
      },
    )
    const a = addSkill('Security Reviewer', 'sec content')
    const b = addSkill('Performance Reviewer', 'perf content')

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    expect(run.convergence.status).toBe('error')
    expect(run.simplify.status).toBe('done')
    const value = run.simplify.value as { rewrites: unknown[] }
    expect(value.rewrites).toHaveLength(2)

    removeSkill(a.id)
    removeSkill(b.id)
  })

  it('cache hit: restores the value without an LLM call', async () => {
    const cached = { fingerprint: 'fp', rewrites: [{ id: 'f0', simple: 'cached rewrite' }] }
    const deps = makeDeps()
    deps.getCached.mockImplementation(async (key: string) => (key.includes('simplify:') ? cached : null))
    const a = addSkill('Security Reviewer', 'sec content')

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    expect(callsMatching(deps, SIMPLIFY_MARKER)).toHaveLength(0)
    expect(run.simplify.status).toBe('done')
    expect(run.simplify.value).toEqual(cached)

    removeSkill(a.id)
  })

  it('a NON-STANDARD cached value is treated as a miss, never applied', async () => {
    const deps = makeDeps(async () => ({ rewrites: [] }))
    deps.getCached.mockImplementation(async (key: string) => (key.includes('simplify:') ? 'weird string' : null))
    const a = addSkill('Security Reviewer', 'sec content')

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    // Fell through to a real call instead of surfacing the garbage.
    expect(callsMatching(deps, SIMPLIFY_MARKER)).toHaveLength(1)
    expect(run.simplify.status).toBe('done')
    expect(run.simplify.value).toEqual({ fingerprint: expect.any(String), rewrites: [] })

    removeSkill(a.id)
  })
})

// ---------------------------------------------------------------------------
// Mode gate + skip conditions
// ---------------------------------------------------------------------------

describe('simplify pass — mode gate + skips', () => {
  it("aiTaskModes.simplify='off' → status 'disabled', ZERO simplify calls, nothing cached", async () => {
    const deps = makeDeps()
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test', aiTaskModes: { simplify: 'off' } }))
    const a = addSkill('Security Reviewer', 'sec content')

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    expect(run.simplify.status).toBe('disabled')
    expect(callsMatching(deps, SIMPLIFY_MARKER)).toHaveLength(0)
    const cachedKeys = deps.setCached.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(cachedKeys.some((k) => k.includes('simplify:'))).toBe(false)
    // The reviewer itself still ran normally.
    expect(run.skillReviews[0].state.status).toBe('done')

    removeSkill(a.id)
  })

  it('skips (idle, no call) when no reviewer produced findings', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (opts: LlmOpts) => {
      if (opts.system.includes(SIMPLIFY_MARKER)) throw new Error('unexpected simplify call')
      return { result: { skillName: 'Security Reviewer', findings: [] }, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    })
    const a = addSkill('Security Reviewer', 'sec content')

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    expect(run.simplify.status).toBe('idle')

    removeSkill(a.id)
  })
})

// ---------------------------------------------------------------------------
// Loss-proof degradation (MANDATORY)
// ---------------------------------------------------------------------------

describe('simplify pass — loss-proof degradation', () => {
  it('LLM error → simplify "error", reviewer entries byte-identical (originals render)', async () => {
    const deps = makeDeps(async () => {
      throw new Error('boom')
    })
    const a = addSkill('Security Reviewer', 'sec content')
    const b = addSkill('Performance Reviewer', 'perf content')

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    const snapshot = JSON.parse(JSON.stringify(run.skillReviews))

    expect(run.simplify.status).toBe('error')
    expect(run.simplify.error).toBeTruthy()
    // THE invariant: originals render exactly as today.
    expect(run.skillReviews).toEqual(snapshot)
    expect(run.skillReviews[0].state.value).toEqual(SKILL_RESULT_A)
    expect(run.skillReviews[1].state.value).toEqual(SKILL_RESULT_B)
    expect(deps.track).toHaveBeenCalledWith('ai_task_failed', { task: 'simplify', reason: 'unknown', reason_detail: 'boom' })
    // Nothing cached for the failed pass.
    const cachedKeys = deps.setCached.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(cachedKeys.some((k) => k.includes('simplify:'))).toBe(false)
    // The convergence result (empty clusters here) is unaffected.
    expect(run.convergence.status).toBe('done')

    removeSkill(a.id)
    removeSkill(b.id)
  })

  it('garbage output (even bypassing transport validation) → "error", originals untouched', async () => {
    // The stubbed transport RETURNS the garbage instead of validating it —
    // exercising the defense-in-depth re-validation inside the pass.
    const deps = makeDeps(async () => ({ readingOrder: [], hotspots: [] }))
    const a = addSkill('Security Reviewer', 'sec content')

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    expect(run.simplify.status).toBe('error')
    expect(run.skillReviews[0].state.value).toEqual(SKILL_RESULT_A)

    removeSkill(a.id)
  })
})

// ---------------------------------------------------------------------------
// retrySkill recomputes the pass
// ---------------------------------------------------------------------------

describe('simplify pass — retrySkill', () => {
  it('re-settles the pass after a single-reviewer retry', async () => {
    const deps = makeDeps(async () => ({ rewrites: [] }))
    const a = addSkill('Security Reviewer', 'sec content')

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()
    expect(callsMatching(deps, SIMPLIFY_MARKER)).toHaveLength(1)

    await run.retrySkill(a.id)
    // Same finding set → the retry may hit the cache OR call again; both are
    // fine, but the state must be settled and loss-proof.
    expect(run.simplify.status).toBe('done')
    expect(run.skillReviews[0].state.value).toEqual(SKILL_RESULT_A)

    removeSkill(a.id)
  })
})
