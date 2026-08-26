/**
 * Tests for fix/ai-task-hardening (part 2 of the failure-rate fix):
 *
 *   1. Size-aware timeouts — every non-streaming JSON task passes
 *      maxTokens: 8192, and a 120s timeoutMs ONLY when the prompt exceeds
 *      ~30k estimated tokens (small prompts keep the transport's 60s default).
 *   2. Alternatives salvage — a partially-malformed alternatives payload is
 *      salvaged (valid elements kept) instead of failing the whole task.
 *   3. Fusion fail-fast — a rate-limited fusion RETHROWS (task fails with the
 *      real error; NO fallback single-pass+verify double-spend), while
 *      non-rate-limited fusion failures keep the existing fallback behavior.
 *   4. autoRetryDelayMs — the pacing policy for reviewer auto-retry rounds.
 *
 * No prompt text is asserted or changed here (PROMPT_VERSIONS untouched).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAiRun, autoRetryDelayMs, JSON_TASK_MAX_TOKENS, LARGE_PROMPT_TIMEOUT_MS } from './run.svelte'
import { LlmError } from '../llm/llm'
import type { PackedContext } from '../context/pack'
import type { CiSummary } from '../github/checks'
import type { SkillReviewResult, VerdictResult, AlternativesResult } from './schemas'
import {
  setDeepseekKey,
  setAnthropicKey,
  setAiProvider,
  setAiPanel,
} from '../settings/settings'
import { addSkill, removeSkill } from '../skills/skills'

// ---------------------------------------------------------------------------
// Fixtures + harness (mirrors run.test.ts / crossVerifyRun.test.ts)
// ---------------------------------------------------------------------------

const SMALL_CTX: PackedContext = {
  text: 'a small PR context',
  notAnalyzed: [],
  includedFiles: ['src/foo.ts'],
}

// ~120k chars → ~34.3k estimated tokens (chars / 3.5) — above the 30k threshold.
const BIG_CTX: PackedContext = {
  text: 'x'.repeat(120_000),
  notAnalyzed: [],
  includedFiles: ['src/foo.ts', 'src/bar.ts'],
}

const CI_SUMMARY: CiSummary = { total: 1, passed: 1, failed: 0, pending: 0, failures: [] }

const VERDICT_RESULT: VerdictResult = {
  level: 'minor-changes',
  evidence: ['src/foo.ts changed'],
  notAnalyzed: [],
}

type ValidateFn = (x: unknown) => unknown

/** Per-validator fixture dispatch (same trick as run.test.ts). */
const ATTENTION = { readingOrder: ['src/foo.ts'], hotspots: [], testFlags: [] }
const GRAPH = {
  kind: 'flow',
  before: { nodes: [{ id: 'a', label: 'A' }], edges: [] },
  after: { nodes: [{ id: 'a', label: 'A' }], edges: [] },
}
const TESTS = { covered: [], gaps: [] }
const ALTERNATIVES: AlternativesResult = {
  problem: 'A problem.',
  alternatives: [
    { approach: 'A different way.', tradeoffs: 'Some.', assessment: 'comparable', rationale: 'Because.' },
  ],
}
const STORY = {
  steps: [{ index: 0, files: ['src/foo.ts'], caption: 'Foo.', layer: 'logic', relatedTests: [] }],
}
const RISK = { score: 1, rationale: 'Low risk.', snippets: [] }

function jsonDispatch(_opts: unknown, validate: ValidateFn): unknown {
  for (const candidate of [STORY, ATTENTION, GRAPH, TESTS, ALTERNATIVES, VERDICT_RESULT, RISK]) {
    if (validate(candidate) !== null) return candidate
  }
  return ATTENTION
}

function makeDeps() {
  const gateAi = vi.fn().mockResolvedValue(true)
  const getCached = vi.fn().mockResolvedValue(null)
  const setCached = vi.fn().mockResolvedValue(undefined)
  const llmStream = vi.fn().mockResolvedValue('summary')
  const llmStreamWithUsage = vi.fn().mockImplementation(
    async (_opts: unknown, onDelta: (d: string) => void) => {
      onDelta('summary')
      return { content: 'summary', usage: undefined }
    },
  )
  const llmJsonWithRepair = vi.fn().mockImplementation(
    async (opts: unknown, validate: ValidateFn) => jsonDispatch(opts, validate),
  )
  const llmJsonWithRepairWithUsage = vi.fn().mockImplementation(
    async (opts: unknown, validate: ValidateFn) => ({ result: jsonDispatch(opts, validate), usage: undefined }),
  )
  const llmJsonWithRepairFor = vi.fn()
  const llmToolLoop = vi.fn()
  const track = vi.fn()
  return {
    gateAi,
    getCached,
    setCached,
    llmStream,
    llmStreamWithUsage,
    llmJsonWithRepair,
    llmJsonWithRepairWithUsage,
    llmJsonWithRepairFor,
    llmToolLoop,
    track,
  }
}

function makeInput(ctx: PackedContext = SMALL_CTX) {
  return {
    prKey: 'owner/repo#1@abc',
    repo: 'owner/repo',
    isPrivate: false as boolean | undefined,
    pack: async () => ctx,
    ci: async (): Promise<CiSummary | null> => CI_SUMMARY,
    ask: async () => true,
  }
}

beforeEach(() => {
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// 1. Size-aware timeouts + output headroom
// ---------------------------------------------------------------------------

describe('JSON task call options — maxTokens + size-aware timeoutMs', () => {
  it('every JSON task passes maxTokens 8192; small prompts get NO timeoutMs (60s default)', async () => {
    setDeepseekKey('sk-test')
    const deps = makeDeps()
    const run = createAiRun(makeInput(SMALL_CTX), deps)
    await run.start()

    const calls = deps.llmJsonWithRepairWithUsage.mock.calls
    // attention, diagrams, tests, alternatives, story, risk-judge, outcomes, verdict
    expect(calls.length).toBe(8)
    for (const call of calls) {
      const opts = call[0] as { maxTokens?: number; timeoutMs?: number }
      expect(opts.maxTokens).toBe(JSON_TASK_MAX_TOKENS)
      expect(opts.timeoutMs).toBeUndefined()
    }
  })

  it('large packed context (>30k est. tokens) scales the timeout to 120s on every JSON task', async () => {
    setDeepseekKey('sk-test')
    const deps = makeDeps()
    const run = createAiRun(makeInput(BIG_CTX), deps)
    await run.start()

    const calls = deps.llmJsonWithRepairWithUsage.mock.calls
    expect(calls.length).toBe(8)
    for (const call of calls) {
      const opts = call[0] as { maxTokens?: number; timeoutMs?: number }
      expect(opts.maxTokens).toBe(JSON_TASK_MAX_TOKENS)
      expect(opts.timeoutMs).toBe(LARGE_PROMPT_TIMEOUT_MS)
    }
  })

  it('skill reviewers (single-pass) carry the same options', async () => {
    setDeepseekKey('sk-test')
    const deps = makeDeps()
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_o: unknown, _v: ValidateFn) => ({
      result: { skillName: 'My Reviewer', findings: [] } satisfies SkillReviewResult,
      usage: undefined,
    }))
    const skill = addSkill('My Reviewer', 'find bugs')

    const run = createAiRun(makeInput(BIG_CTX), deps)
    await run.runSkillReviews()

    expect(deps.llmJsonWithRepairWithUsage).toHaveBeenCalledTimes(1)
    const opts = deps.llmJsonWithRepairWithUsage.mock.calls[0][0] as { maxTokens?: number; timeoutMs?: number }
    expect(opts.maxTokens).toBe(JSON_TASK_MAX_TOKENS)
    expect(opts.timeoutMs).toBe(LARGE_PROMPT_TIMEOUT_MS)

    removeSkill(skill.id)
  })

  it('coach chunks carry maxTokens (chunk prompts are small → no scaled timeout)', async () => {
    setDeepseekKey('sk-test')
    const deps = makeDeps()
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_o: unknown, _v: ValidateFn) => ({
      result: { reviews: [] },
      usage: undefined,
    }))
    const run = createAiRun(makeInput(SMALL_CTX), deps)
    const result = await run.coach([
      { path: 'src/foo.ts', line: 1, side: 'RIGHT', body: 'nit: rename' } as never,
    ])
    expect('error' in result).toBe(false)
    const opts = deps.llmJsonWithRepairWithUsage.mock.calls[0][0] as { maxTokens?: number; timeoutMs?: number }
    expect(opts.maxTokens).toBe(JSON_TASK_MAX_TOKENS)
    expect(opts.timeoutMs).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. Alternatives salvage wired into the task (validate → salvage → error)
// ---------------------------------------------------------------------------

describe('alternatives task — salvage of partially-malformed results', () => {
  it('keeps the valid elements when one alternatives[] element is malformed', async () => {
    setDeepseekKey('sk-test')
    const deps = makeDeps()
    const partiallyBroken = {
      problem: 'A problem.',
      alternatives: [
        { approach: 'Good one.', tradeoffs: 'T.', assessment: 'comparable', rationale: 'R.' },
        { approach: 42, tradeoffs: 'truncated garbage' }, // malformed element
      ],
    }
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_o: unknown, validate: ValidateFn) => {
      const v = validate(partiallyBroken)
      if (v === null) throw new LlmError('invalid-output', 'LLM produced invalid JSON after repair retry')
      return { result: v, usage: undefined }
    })

    const run = createAiRun(makeInput(SMALL_CTX), deps)
    await run.retry('alternatives')

    expect(run.alternatives.status).toBe('done')
    const value = run.alternatives.value as AlternativesResult
    expect(value.alternatives).toEqual([
      { approach: 'Good one.', tradeoffs: 'T.', assessment: 'comparable', rationale: 'R.' },
    ])
  })

  it('keeps an element whose assessment is invalid by omitting the field', async () => {
    setDeepseekKey('sk-test')
    const deps = makeDeps()
    const badAssessment = {
      problem: 'P.',
      alternatives: [
        { approach: 'A.', tradeoffs: 'T.', assessment: 'way-better', rationale: 'R.' },
      ],
    }
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_o: unknown, validate: ValidateFn) => {
      const v = validate(badAssessment)
      if (v === null) throw new LlmError('invalid-output', 'invalid')
      return { result: v, usage: undefined }
    })

    const run = createAiRun(makeInput(SMALL_CTX), deps)
    await run.retry('alternatives')

    expect(run.alternatives.status).toBe('done')
    const value = run.alternatives.value as AlternativesResult
    expect(value.alternatives[0].approach).toBe('A.')
    expect(value.alternatives[0].assessment).toBeUndefined()
  })

  it('still errors when NOTHING is salvageable', async () => {
    setDeepseekKey('sk-test')
    const deps = makeDeps()
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_o: unknown, validate: ValidateFn) => {
      const v = validate({ problem: 'P.', alternatives: ['junk', 42] })
      if (v === null) throw new LlmError('invalid-output', 'LLM produced invalid JSON after repair retry')
      return { result: v, usage: undefined }
    })

    const run = createAiRun(makeInput(SMALL_CTX), deps)
    await run.retry('alternatives')

    expect(run.alternatives.status).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// 3. Fusion fail-fast on rate limits (no fallback double-spend)
// ---------------------------------------------------------------------------

const TWO_GENERATORS = [
  { provider: 'deepseek' as const, model: 'deepseek-v4-flash', role: 'generator' as const },
  { provider: 'anthropic' as const, model: 'claude-opus-4-8', role: 'generator' as const },
]

function setupFusionPanel() {
  setAiProvider('deepseek')
  setDeepseekKey('k')
  setAnthropicKey('a')
  setAiPanel({ participants: TWO_GENERATORS })
}

describe('fuseSkillReview — rate-limit fail-fast', () => {
  it('ALL generators rate-limited → reviewer entry fails with the real error; NO fallback single-pass', async () => {
    setupFusionPanel()
    const deps = makeDeps()
    deps.llmJsonWithRepairFor.mockRejectedValue(
      new LlmError('rate-limited', 'Rate limited (429)', { status: 429, retryAfterMs: 7_000 }),
    )
    const skill = addSkill('My Reviewer', 'find bugs')

    const run = createAiRun(makeInput(SMALL_CTX), deps)
    await run.runSkillReviews()

    expect(run.skillReviews[0].state.status).toBe('error')
    expect(run.skillReviews[0].state.error).toMatch(/rate limited/i)
    // THE point: no second full single-pass+verify spend on an exhausted limit.
    expect(deps.llmJsonWithRepairWithUsage).not.toHaveBeenCalled()

    removeSkill(skill.id)
  })

  it('one generator rate-limited, the other fine → fusion continues (no error, no fallback)', async () => {
    setupFusionPanel()
    const deps = makeDeps()
    deps.llmJsonWithRepairFor.mockImplementation(async (cfg: { providerId: string }, _o: unknown, validate: ValidateFn) => {
      if (cfg.providerId === 'anthropic') {
        throw new LlmError('rate-limited', 'Rate limited (429)', { status: 429 })
      }
      const gen = { skillName: 'My Reviewer', findings: [] }
      if (validate(gen) !== null) return { result: gen, usage: undefined }
      return { result: validate({ verdicts: [] }), usage: undefined }
    })
    const skill = addSkill('My Reviewer', 'find bugs')

    const run = createAiRun(makeInput(SMALL_CTX), deps)
    await run.runSkillReviews()

    expect(run.skillReviews[0].state.status).toBe('done')
    expect(deps.llmJsonWithRepairWithUsage).not.toHaveBeenCalled()

    removeSkill(skill.id)
  })

  it('ALL generators failing NON-rate-limited keeps the existing semantics (0-finding fusion result, no error)', async () => {
    setupFusionPanel()
    const deps = makeDeps()
    deps.llmJsonWithRepairFor.mockRejectedValue(new LlmError('server', 'Server error (500)', { status: 500 }))
    const skill = addSkill('My Reviewer', 'find bugs')

    const run = createAiRun(makeInput(SMALL_CTX), deps)
    await run.runSkillReviews()

    // Pre-existing behavior preserved: generators that failed still yield an
    // (empty) generated result with generator rows — NOT a rethrow.
    expect(run.skillReviews[0].state.status).toBe('done')
    const value = run.skillReviews[0].state.value as SkillReviewResult
    expect(value.findings).toEqual([])

    removeSkill(skill.id)
  })
})

describe('fuseVerdict — rate-limit fail-fast', () => {
  it('ALL generators rate-limited → verdict fails with the real error; NO fallback single-pass', async () => {
    setupFusionPanel()
    const deps = makeDeps()
    deps.llmJsonWithRepairFor.mockRejectedValue(
      new LlmError('rate-limited', 'Rate limited (429)', { status: 429, retryAfterMs: 4_000 }),
    )

    const run = createAiRun(makeInput(SMALL_CTX), deps)
    await run.retry('verdict')

    expect(run.verdict.status).toBe('error')
    expect(run.verdict.error).toMatch(/rate limited/i)
    expect(deps.llmJsonWithRepairWithUsage).not.toHaveBeenCalled()
  })

  it('non-rate-limited total fusion failure keeps the existing fallback (single-pass verdict runs)', async () => {
    setupFusionPanel()
    const deps = makeDeps()
    deps.llmJsonWithRepairFor.mockRejectedValue(new LlmError('server', 'Server error (500)', { status: 500 }))

    const run = createAiRun(makeInput(SMALL_CTX), deps)
    await run.retry('verdict')

    // Fallback single-pass produced the verdict (existing behavior preserved).
    expect(run.verdict.status).toBe('done')
    expect(deps.llmJsonWithRepairWithUsage).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 4. autoRetryDelayMs — pacing policy unit tests
// ---------------------------------------------------------------------------

describe('autoRetryDelayMs', () => {
  it('follows the 2s/4s/8s ladder when nothing was observed', () => {
    expect(autoRetryDelayMs(0, [])).toBe(2_000)
    expect(autoRetryDelayMs(1, [])).toBe(4_000)
    expect(autoRetryDelayMs(2, [])).toBe(8_000)
  })

  it('clamps rounds beyond the ladder to the last rung', () => {
    expect(autoRetryDelayMs(3, [])).toBe(8_000)
    expect(autoRetryDelayMs(9, [])).toBe(8_000)
  })

  it('uses the MAX observed Retry-After when knowable', () => {
    expect(autoRetryDelayMs(0, [1_000, 9_500, 3_000])).toBe(9_500)
  })

  it('caps every delay at 20s (Retry-After included)', () => {
    expect(autoRetryDelayMs(0, [90_000])).toBe(20_000)
  })

  it('honors a 0ms Retry-After (provider said now)', () => {
    expect(autoRetryDelayMs(0, [0])).toBe(0)
  })
})
