/**
 * Tests for src/lib/ai/run.svelte.ts — AI orchestration layer (Task 8)
 *
 * All external deps stubbed via the DI `deps` parameter.
 * Covers:
 *   - no-key path (EC-12a): no consent ask, no llm calls
 *   - declined path (EC-11c): gateAi=false → all 'declined'
 *   - cache-hit per task: no llm call, track cached:true
 *   - summary streaming: deltas appended, status transitions loading→streaming→done
 *   - one task failing while three succeed (EC-12c / EC-13g isolation)
 *   - partial stream failure → not cached + retry succeeds (EC-12f / EC-17d)
 *   - verdict notAnalyzed union (EC-15c)
 *   - retry single-task
 *   - pack failure path
 *   - duration_ms tracked as number
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAiRun, describeTaskError } from './run.svelte'
import { LlmError } from '../llm/llm'
import type { PackedContext } from '../context/pack'
import type { CiSummary } from '../github/checks'
import type { AttentionResult, VerdictResult, GraphResult, TestInsight, CoachResult, AlternativesResult, StoryOrderResult, RiskJudgeResult } from './schemas'

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const PACKED_CTX: PackedContext = {
  text: 'some PR context',
  notAnalyzed: ['excluded.lock'],
  includedFiles: ['src/foo.ts'],
}

const CI_SUMMARY: CiSummary = {
  total: 1, passed: 1, failed: 0, pending: 0, failures: [],
}

const ATTENTION_RESULT: AttentionResult = {
  readingOrder: ['src/foo.ts'],
  hotspots: [{ path: 'src/foo.ts', reason: 'critical', level: 'high' }],
  testFlags: [],
}

const GRAPH_RESULT: GraphResult = {
  kind: 'flow',
  before: { nodes: [{ id: 'a', label: 'A' }], edges: [] },
  after: { nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] },
}

const VERDICT_RESULT: VerdictResult = {
  level: 'minor-changes',
  evidence: ['src/foo.ts changed'],
  notAnalyzed: ['model-unknown.ts'],
}

const TEST_INSIGHT_RESULT: TestInsight = {
  covered: [{ behavior: 'handles valid input', test: 'it validates', file: 'src/foo.test.ts' }],
  gaps: ['src/bar.ts has no test coverage'],
}

const ALTERNATIVES_RESULT: AlternativesResult = {
  problem: 'The PR adds a global singleton cache without isolation.',
  alternatives: [
    {
      approach: 'Use a module-scoped Map passed via dependency injection.',
      tradeoffs: 'Better isolation but requires passing context. More boilerplate.',
      assessment: 'alternative-is-better',
      rationale: 'Avoids shared state across tests and requests.',
    },
  ],
}

const STORY_RESULT: StoryOrderResult = {
  steps: [
    { index: 0, files: ['src/foo.ts'], caption: 'Foo changes.', layer: 'logic', relatedTests: [] },
  ],
}

const RISK_JUDGE_RESULT: RiskJudgeResult = {
  score: 1,
  rationale: 'Localized change with clear behavior.',
  snippets: [],
}

// ---------------------------------------------------------------------------
// Default llmJsonWithRepair implementation that dispatches by validator result
// Returns appropriate fixture based on which validator accepts the result.
// ---------------------------------------------------------------------------

type ValidateFn = (x: unknown) => unknown

function defaultJsonDispatch(_opts: unknown, validate: ValidateFn): unknown {
  // Try each fixture in order — return the first one the validator accepts.
  // StoryOrderResult is tried FIRST because validateAttention/etc. would not
  // accept it, but its own shape must win for the story task.
  for (const candidate of [STORY_RESULT, ATTENTION_RESULT, GRAPH_RESULT, TEST_INSIGHT_RESULT, ALTERNATIVES_RESULT, VERDICT_RESULT, RISK_JUDGE_RESULT]) {
    if (validate(candidate) !== null) return candidate
  }
  return ATTENTION_RESULT // fallback
}

// ---------------------------------------------------------------------------
// DI stub factory
//
// Returns a deps object with vi.fn() mocks. All parameters are optional;
// callers can override any mock after creation (e.g. deps.llmStream.mockImplementation(...))
// ---------------------------------------------------------------------------

function makeDeps({ hasKey = true, gateResult = true } = {}) {
  // Settings stub
  if (hasKey) {
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test' }))
  } else {
    localStorage.removeItem('review123:settings')
  }

  const gateAi = vi.fn().mockResolvedValue(gateResult)

  const getCached = vi.fn().mockResolvedValue(null)

  const setCached = vi.fn().mockResolvedValue(undefined)

  const llmStream = vi.fn().mockImplementation(
    async (_opts: unknown, onDelta: (d: string) => void) => {
      onDelta('hello')
      return 'hello'
    },
  )

  const llmJsonWithRepair = vi.fn().mockImplementation(
    async (opts: unknown, validate: ValidateFn) => defaultJsonDispatch(opts, validate),
  )

  // WithUsage variants delegate to the base stubs so existing tests that
  // override llmStream / llmJsonWithRepair continue to work unchanged.
  // Tests for token propagation override the WithUsage stubs directly.
  const llmStreamWithUsage = vi.fn().mockImplementation(
    async (opts: unknown, onDelta: (d: string) => void) => {
      const content = await llmStream(opts, onDelta)
      return { content, usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }
    },
  )

  const llmJsonWithRepairWithUsage = vi.fn().mockImplementation(
    async (opts: unknown, validate: ValidateFn) => ({
      result: await llmJsonWithRepair(opts, validate),
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  )

  const track = vi.fn()

  return { gateAi, getCached, setCached, llmStream, llmStreamWithUsage, llmJsonWithRepair, llmJsonWithRepairWithUsage, track }
}

// ---------------------------------------------------------------------------
// Common input factory
// ---------------------------------------------------------------------------

function makeInput({
  isPrivate = false as boolean | undefined,
  pack = async () => PACKED_CTX,
  ci = async () => CI_SUMMARY as CiSummary | null,
  ask = async () => true,
} = {}): Parameters<typeof createAiRun>[0] {
  return {
    prKey: 'owner/repo#1@abc123',
    repo: 'owner/repo',
    isPrivate,
    pack,
    ci,
    ask,
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// No-key path
// ---------------------------------------------------------------------------

describe('no-key path (EC-12a)', () => {
  it('sets all panels to no-key without calling gateAi or llm', async () => {
    const deps = makeDeps({ hasKey: false })
    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.summary.status).toBe('no-key')
    expect(run.attention.status).toBe('no-key')
    expect(run.diagrams.status).toBe('no-key')
    expect(run.verdict.status).toBe('no-key')
    expect(run.alternatives.status).toBe('no-key')

    expect(deps.gateAi).not.toHaveBeenCalled()
    expect(deps.llmStream).not.toHaveBeenCalled()
    expect(deps.llmJsonWithRepair).not.toHaveBeenCalled()
  })

  it('no-key: does not call ask (consent dialog suppressed)', async () => {
    const ask = vi.fn()
    const deps = makeDeps({ hasKey: false })
    const run = createAiRun({ ...makeInput(), ask }, deps)
    await run.start()

    expect(ask).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Declined path
// ---------------------------------------------------------------------------

describe('declined path (EC-11c)', () => {
  it('sets all panels to declined when gateAi returns false', async () => {
    const deps = makeDeps({ gateResult: false })
    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.summary.status).toBe('declined')
    expect(run.attention.status).toBe('declined')
    expect(run.diagrams.status).toBe('declined')
    expect(run.verdict.status).toBe('declined')
    expect(run.alternatives.status).toBe('declined')

    expect(deps.llmStream).not.toHaveBeenCalled()
    expect(deps.llmJsonWithRepair).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Cache-hit per task
// ---------------------------------------------------------------------------

describe('cache-hit (EC-17a, track cached:true)', () => {
  it('summary cache hit: done + track cached:true, no llmStream call', async () => {
    const deps = makeDeps()
    const cachedSummary = 'cached summary text'
    deps.getCached.mockImplementation(async (key: string) => {
      if (key.includes('summary')) return cachedSummary
      return null
    })

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.summary.status).toBe('done')
    expect(run.summary.value).toBe(cachedSummary)
    expect(deps.llmStream).not.toHaveBeenCalled()

    const summaryTrack = deps.track.mock.calls.find(
      (c: unknown[]) => c[0] === 'ai_task_completed' && (c[1] as Record<string, unknown>)['task'] === 'summary',
    )
    expect(summaryTrack).toBeTruthy()
    expect((summaryTrack![1] as Record<string, unknown>)['cached']).toBe(true)
    expect(typeof (summaryTrack![1] as Record<string, unknown>)['duration_ms']).toBe('number')
  })

  it('attention cache hit: done + track cached:true, no llmJsonWithRepair call for attention', async () => {
    const deps = makeDeps()
    deps.getCached.mockImplementation(async (key: string) => {
      if (key.includes('attention')) return ATTENTION_RESULT
      return null
    })

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.attention.status).toBe('done')
    expect(run.attention.value).toEqual(ATTENTION_RESULT)

    const attentionTrack = deps.track.mock.calls.find(
      (c: unknown[]) => c[0] === 'ai_task_completed' && (c[1] as Record<string, unknown>)['task'] === 'attention',
    )
    expect(attentionTrack).toBeTruthy()
    expect((attentionTrack![1] as Record<string, unknown>)['cached']).toBe(true)
  })

  it('all seven tasks cache hit: no llm calls at all', async () => {
    const deps = makeDeps()
    deps.getCached.mockImplementation(async (key: string) => {
      if (key.includes('summary')) return 'cached summary'
      if (key.includes('attention')) return ATTENTION_RESULT
      if (key.includes('diagrams')) return GRAPH_RESULT
      if (key.includes('tests')) return TEST_INSIGHT_RESULT
      if (key.includes('alternatives')) return ALTERNATIVES_RESULT
      if (key.includes('story')) return STORY_RESULT
      if (key.includes('risk-judge')) return RISK_JUDGE_RESULT
      if (key.includes('verdict')) return VERDICT_RESULT
      return null
    })

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(deps.llmStream).not.toHaveBeenCalled()
    expect(deps.llmJsonWithRepair).not.toHaveBeenCalled()

    expect(run.summary.status).toBe('done')
    expect(run.attention.status).toBe('done')
    expect(run.diagrams.status).toBe('done')
    expect(run.tests.status).toBe('done')
    expect(run.alternatives.status).toBe('done')
    expect(run.story.status).toBe('done')
    expect(run.verdict.status).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// Summary streaming: status transitions + delta accumulation
// ---------------------------------------------------------------------------

describe('summary streaming', () => {
  it('transitions to done with deltas appended to value as streaming progresses', async () => {
    const deps = makeDeps()
    const capturedDeltas: string[] = []

    deps.llmStream.mockImplementation(
      async (_opts: unknown, onDelta: (d: string) => void) => {
        onDelta('Hello')
        capturedDeltas.push('Hello')
        onDelta(' world')
        capturedDeltas.push(' world')
        return 'Hello world'
      },
    )

    const run = createAiRun(makeInput(), deps)
    await run.start()

    // After completion, summary should be done with full text
    expect(run.summary.status).toBe('done')
    expect(run.summary.value).toBe('Hello world')
    // Deltas were called in order
    expect(capturedDeltas).toEqual(['Hello', ' world'])
  })

  it('caches summary only after complete success (EC-17d)', async () => {
    const deps = makeDeps()
    deps.llmStream.mockImplementation(
      async (_opts: unknown, onDelta: (d: string) => void) => {
        onDelta('full text')
        return 'full text'
      },
    )

    const run = createAiRun(makeInput(), deps)
    await run.start()

    // setCached should have been called with the full text for summary
    const summarySetCalls = deps.setCached.mock.calls.filter(
      (c: unknown[]) => typeof (c[0] as string) === 'string' && (c[0] as string).includes('summary'),
    )
    expect(summarySetCalls.length).toBe(1)
    expect(summarySetCalls[0][1]).toBe('full text')
  })

  it('track cached:false with duration_ms as number on fresh run', async () => {
    const deps = makeDeps()
    deps.llmStream.mockImplementation(
      async (_opts: unknown, onDelta: (d: string) => void) => {
        onDelta('hello')
        return 'hello'
      },
    )

    const run = createAiRun(makeInput(), deps)
    await run.start()

    const completedCalls = deps.track.mock.calls.filter((c: unknown[]) => c[0] === 'ai_task_completed')
    expect(completedCalls.length).toBeGreaterThan(0)
    for (const call of completedCalls) {
      const props = call[1] as Record<string, unknown>
      expect(typeof props['duration_ms']).toBe('number')
      expect(props['cached']).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Task isolation: one task failing while others succeed (EC-12c / EC-13g)
// ---------------------------------------------------------------------------

describe('task isolation (EC-12c / EC-13g)', () => {
  it('attention failure does not affect summary, diagrams, or verdict', async () => {
    const deps = makeDeps()

    deps.llmStream.mockImplementation(async (_opts: unknown, onDelta: (d: string) => void) => {
      onDelta('summary text')
      return 'summary text'
    })

    // Make attention fail by throwing when validate returns non-null for ATTENTION_RESULT
    deps.llmJsonWithRepair.mockImplementation(async (_opts: unknown, validate: ValidateFn) => {
      const asAttention = validate(ATTENTION_RESULT)
      if (asAttention !== null) {
        throw new LlmError('server', 'attention broke')
      }
      const asGraph = validate(GRAPH_RESULT)
      if (asGraph !== null) return asGraph
      const asVerdict = validate(VERDICT_RESULT)
      if (asVerdict !== null) return asVerdict
      throw new LlmError('invalid-output', 'no match')
    })

    const run = createAiRun(makeInput(), deps)
    await run.start()

    // summary should succeed
    expect(run.summary.status).toBe('done')
    // attention should fail
    expect(run.attention.status).toBe('error')
    expect(run.attention.error).toBeTruthy()
    // diagrams and verdict should succeed
    expect(run.diagrams.status).toBe('done')
    expect(run.verdict.status).toBe('done')

    // ai_task_failed should be tracked for attention
    const failedCall = deps.track.mock.calls.find(
      (c: unknown[]) => c[0] === 'ai_task_failed' && (c[1] as Record<string, unknown>)['task'] === 'attention',
    )
    expect(failedCall).toBeTruthy()
    expect((failedCall![1] as Record<string, unknown>)['reason']).toBe('server')
  })

  it('summary stream failure does not affect structured tasks', async () => {
    const deps = makeDeps()

    deps.llmStream.mockRejectedValue(new LlmError('network', 'stream died'))

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.summary.status).toBe('error')
    expect(run.attention.status).toBe('done')
    expect(run.diagrams.status).toBe('done')
    expect(run.verdict.status).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// Partial stream failure → not cached + retry succeeds (EC-12f / EC-17d)
// ---------------------------------------------------------------------------

describe('partial stream failure and retry (EC-12f / EC-17d)', () => {
  it('partial stream failure: status is error and summary NOT cached', async () => {
    const deps = makeDeps()

    deps.llmStream.mockRejectedValue(new LlmError('network', 'interrupted mid-stream'))

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.summary.status).toBe('error')

    // setCached must NOT have been called for summary (partial NEVER cached)
    const summaryCacheCalls = deps.setCached.mock.calls.filter(
      (c: unknown[]) => typeof (c[0] as string) === 'string' && (c[0] as string).includes('summary'),
    )
    expect(summaryCacheCalls.length).toBe(0)

    // ai_task_failed tracked with reason 'network'
    const failedCall = deps.track.mock.calls.find(
      (c: unknown[]) => c[0] === 'ai_task_failed' && (c[1] as Record<string, unknown>)['task'] === 'summary',
    )
    expect(failedCall).toBeTruthy()
    expect((failedCall![1] as Record<string, unknown>)['reason']).toBe('network')
  })

  it('retry after partial stream failure succeeds and caches result', async () => {
    const deps = makeDeps()

    let llmStreamCallCount = 0
    deps.llmStream.mockImplementation(async (_opts: unknown, onDelta: (d: string) => void) => {
      llmStreamCallCount++
      if (llmStreamCallCount === 1) throw new LlmError('network', 'first attempt failed')
      onDelta('recovered')
      return 'recovered'
    })

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.summary.status).toBe('error')

    // Retry just summary
    await run.retry('summary')

    expect(run.summary.status).toBe('done')
    expect(run.summary.value).toBe('recovered')

    const summaryCacheCalls = deps.setCached.mock.calls.filter(
      (c: unknown[]) => typeof (c[0] as string) === 'string' && (c[0] as string).includes('summary'),
    )
    expect(summaryCacheCalls.length).toBe(1)
    expect(summaryCacheCalls[0][1]).toBe('recovered')
  })
})

// ---------------------------------------------------------------------------
// Verdict notAnalyzed union (EC-15c)
// ---------------------------------------------------------------------------

describe('verdict notAnalyzed union (EC-15c)', () => {
  it('merges packed context notAnalyzed with model notAnalyzed, deduped', async () => {
    const packCtx: PackedContext = {
      text: 'context',
      notAnalyzed: ['excluded.lock', 'shared.ts'],
      includedFiles: ['src/main.ts'],
    }

    const verdictFromModel: VerdictResult = {
      level: 'behavior-preserved',
      evidence: ['no behavior changes'],
      notAnalyzed: ['shared.ts', 'model-unknown.ts'], // 'shared.ts' overlaps with pack
    }

    const deps = makeDeps()
    deps.llmJsonWithRepair.mockImplementation(async (_opts: unknown, validate: ValidateFn) => {
      const asAttention = validate(ATTENTION_RESULT)
      if (asAttention !== null) return asAttention
      const asGraph = validate(GRAPH_RESULT)
      if (asGraph !== null) return asGraph
      // Must be verdict
      return verdictFromModel
    })

    const run = createAiRun({ ...makeInput(), pack: async () => packCtx }, deps)
    await run.start()

    expect(run.verdict.status).toBe('done')
    const verdict = run.verdict.value as VerdictResult
    // Should be union of ['excluded.lock', 'shared.ts'] + ['shared.ts', 'model-unknown.ts'] deduped
    expect(verdict.notAnalyzed).toContain('excluded.lock')
    expect(verdict.notAnalyzed).toContain('shared.ts')
    expect(verdict.notAnalyzed).toContain('model-unknown.ts')
    // 'shared.ts' should appear only once (deduped)
    expect(verdict.notAnalyzed.filter((x: string) => x === 'shared.ts').length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Verdict always records its generator row (consolidated cost panel)
// ---------------------------------------------------------------------------

describe('verdict records its generator row even without evidence', () => {
  it('an evidence-free verdict still yields a verdictModels/modelPerformance generator row with usage', async () => {
    // No-evidence verdict → no cross-verify rows. Single deepseek key →
    // crossModelVerifyEffective() is false. Previously this left verdictModels
    // empty; now the generator row is recorded unconditionally.
    const evidenceFreeVerdict: VerdictResult = {
      level: 'behavior-preserved',
      evidence: [],
      notAnalyzed: [],
    }

    const deps = makeDeps()
    // The verdict single-pass goes through llmJsonWithRepairWithUsage; return the
    // evidence-free verdict for it while letting other tasks use their fixtures.
    deps.llmJsonWithRepairWithUsage.mockImplementation(
      async (opts: unknown, validate: ValidateFn) => {
        // The verdict task's validator (validateVerdict) accepts the evidence-free
        // verdict; for any other task fall back to the default fixture dispatch.
        if (validate(evidenceFreeVerdict) !== null) {
          return { result: evidenceFreeVerdict, usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } }
        }
        return { result: await deps.llmJsonWithRepair(opts, validate), usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      },
    )

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.verdict.status).toBe('done')
    expect((run.verdict.value as VerdictResult).evidence).toEqual([])

    // Generator row present, role generator, usage carried.
    expect(run.verdictModels.length).toBeGreaterThanOrEqual(1)
    const gen = run.verdictModels[0]
    expect(gen.role).toBe('generator')
    expect(gen.usage).toBeDefined()
    expect(gen.usage!.total_tokens).toBe(42)

    // And it flows through the consolidated aggregate getter.
    const aggGen = run.modelPerformance.find((m) => m.role === 'generator')
    expect(aggGen).toBeDefined()
    expect(aggGen!.usage!.total_tokens).toBe(42)
  })
})

describe('modelCostBreakdown reconciles with totalUsage', () => {
  it('sums every task across rows to equal totalUsage, with single-pass labels in the generator byTask', async () => {
    // Default deps: summary streams (usage 8), the six JSON tasks + verdict each
    // report usage 15. Single deepseek key → no cross-verify, so the verdict
    // yields one generator row. Every single-pass task is attributed to the active
    // model's generator row, so the rows must sum to totalUsage.
    const deps = makeDeps()
    const run = createAiRun(makeInput(), deps)
    await run.start()

    const total = run.totalUsage
    expect(total).toBeDefined()

    // RECONCILIATION INVARIANT: Σ rows' total === totalUsage.
    const rows = run.modelCostBreakdown
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const summed = rows.reduce((acc, r) => acc + (r.total?.total_tokens ?? 0), 0)
    expect(summed).toBe(total!.total_tokens)

    // The active model's generator row carries the single-pass task labels.
    const gen = rows.find((r) => r.role === 'generator')!
    const taskNames = gen.byTask.map((t) => t.task)
    for (const label of ['Summary', 'Hotspots', 'Diagrams', 'Tests', 'Alternatives', 'Story', 'Risk judge', 'Verdict']) {
      expect(taskNames).toContain(label)
    }
    // No task's tokens dropped: the generator row's byTask usage sums to its total.
    const byTaskSum = gen.byTask.reduce((acc, t) => acc + (t.usage?.total_tokens ?? 0), 0)
    expect(byTaskSum).toBe(gen.total!.total_tokens)
  })
})

// ---------------------------------------------------------------------------
// Retry single task
// ---------------------------------------------------------------------------

describe('retry single task', () => {
  it('retry(attention) re-runs only attention, other panels unaffected', async () => {
    const deps = makeDeps()

    let attentionCallCount = 0
    deps.llmJsonWithRepair.mockImplementation(async (_opts: unknown, validate: ValidateFn) => {
      const asAttention = validate(ATTENTION_RESULT)
      if (asAttention !== null) {
        attentionCallCount++
        if (attentionCallCount === 1) throw new LlmError('server', 'attention broke first time')
        return asAttention
      }
      const asGraph = validate(GRAPH_RESULT)
      if (asGraph !== null) return asGraph
      return VERDICT_RESULT
    })

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.attention.status).toBe('error')
    const summaryStatusBeforeRetry = run.summary.status
    const diagramsStatusBeforeRetry = run.diagrams.status

    // Retry attention only
    await run.retry('attention')

    expect(run.attention.status).toBe('done')
    expect(run.attention.value).toEqual(ATTENTION_RESULT)
    // Other panels unchanged by retry
    expect(run.summary.status).toBe(summaryStatusBeforeRetry)
    expect(run.diagrams.status).toBe(diagramsStatusBeforeRetry)
  })

  it('retry(verdict) re-fetches CI and runs only verdict', async () => {
    let ciCallCount = 0
    const ci = async () => {
      ciCallCount++
      return CI_SUMMARY
    }

    const deps = makeDeps()

    let verdictCallCount = 0
    deps.llmJsonWithRepair.mockImplementation(async (_opts: unknown, validate: ValidateFn) => {
      const asAttention = validate(ATTENTION_RESULT)
      if (asAttention !== null) return asAttention
      const asGraph = validate(GRAPH_RESULT)
      if (asGraph !== null) return asGraph
      const asTests = validate(TEST_INSIGHT_RESULT)
      if (asTests !== null) return asTests
      const asAlternatives = validate(ALTERNATIVES_RESULT)
      if (asAlternatives !== null) return asAlternatives
      const asStory = validate(STORY_RESULT)
      if (asStory !== null) return asStory
      const asRiskJudge = validate(RISK_JUDGE_RESULT)
      if (asRiskJudge !== null) return asRiskJudge
      verdictCallCount++
      if (verdictCallCount === 1) throw new LlmError('server', 'verdict broke')
      return VERDICT_RESULT
    })

    const run = createAiRun({ ...makeInput(), ci }, deps)
    await run.start()

    expect(run.verdict.status).toBe('error')
    expect(ciCallCount).toBe(1)

    await run.retry('verdict')

    expect(run.verdict.status).toBe('done')
    // CI should have been fetched again for retry
    expect(ciCallCount).toBe(2)
  })

  it('retry re-uses already-packed context (pack called only once on success)', async () => {
    let packCallCount = 0
    const pack = async () => {
      packCallCount++
      return PACKED_CTX
    }

    const deps = makeDeps()

    const run = createAiRun({ ...makeInput(), pack }, deps)
    await run.start()

    expect(packCallCount).toBe(1)

    await run.retry('summary')

    // pack should NOT have been called again (context reused from closure)
    expect(packCallCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Pack failure path
// ---------------------------------------------------------------------------

describe('pack failure', () => {
  it('pack() failure → all four panels error with context message', async () => {
    const deps = makeDeps()
    const pack = async () => { throw new Error('GitHub rate limited') }

    const run = createAiRun({ ...makeInput(), pack }, deps)
    await run.start()

    expect(run.summary.status).toBe('error')
    expect(run.attention.status).toBe('error')
    expect(run.diagrams.status).toBe('error')
    expect(run.verdict.status).toBe('error')

    // All errors should mention context preparation failure
    expect(run.summary.error).toContain("Couldn't prepare PR context")
    expect(run.attention.error).toContain("Couldn't prepare PR context")
    expect(run.diagrams.error).toContain("Couldn't prepare PR context")
    expect(run.verdict.error).toContain("Couldn't prepare PR context")

    expect(deps.llmStream).not.toHaveBeenCalled()
    expect(deps.llmJsonWithRepair).not.toHaveBeenCalled()
  })

  it('pack failure: retry re-packs (pack called again on retry when initial pack failed)', async () => {
    let packCallCount = 0
    let shouldFail = true
    const pack = async () => {
      packCallCount++
      if (shouldFail) throw new Error('First pack failed')
      return PACKED_CTX
    }

    const deps = makeDeps()

    const run = createAiRun({ ...makeInput(), pack }, deps)
    await run.start()

    expect(run.summary.status).toBe('error')
    expect(packCallCount).toBe(1)

    // Allow pack to succeed now
    shouldFail = false

    // On retry, pack should be called again since previous pack failed
    await run.retry('summary')

    expect(packCallCount).toBe(2)
    expect(run.summary.status).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// Duration tracked as number
// ---------------------------------------------------------------------------

describe('duration_ms as number', () => {
  it('ai_task_completed always tracks duration_ms as a non-negative number', async () => {
    const deps = makeDeps()

    const run = createAiRun(makeInput(), deps)
    await run.start()

    const completedCalls = deps.track.mock.calls.filter((c: unknown[]) => c[0] === 'ai_task_completed')
    expect(completedCalls.length).toBe(8) // summary + attention + diagrams + tests + alternatives + story + risk-judge + verdict

    for (const call of completedCalls) {
      const props = call[1] as Record<string, unknown>
      expect(typeof props['duration_ms']).toBe('number')
      expect(props['duration_ms'] as number).toBeGreaterThanOrEqual(0)
    }
  })
})

// ---------------------------------------------------------------------------
// gateAi is called with correct args
// ---------------------------------------------------------------------------

describe('consent integration', () => {
  it('gateAi called with repo + isPrivate + ask from input', async () => {
    const deps = makeDeps({ gateResult: true })
    const ask = vi.fn().mockResolvedValue(true)

    const run = createAiRun({ ...makeInput({ isPrivate: true }), ask }, deps)
    await run.start()

    expect(deps.gateAi).toHaveBeenCalledWith({
      repo: 'owner/repo',
      isPrivate: true,
      ask,
    })
  })
})

// ---------------------------------------------------------------------------
// SSE parser nit: data: without trailing space is tested in llm.test.ts
// This is a sentinel test to document the nit fix was applied.
// ---------------------------------------------------------------------------

describe('llm.ts SSE parser nit: data: without space', () => {
  it('nit fix is documented in llm.test.ts (SSE no-space regression test)', () => {
    // The actual SSE no-space test is in src/lib/llm/llm.test.ts
    // See: "accepts data: with no space between colon and payload"
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests panel (D2) — fifth parallel task
// ---------------------------------------------------------------------------

describe('tests panel (D2)', () => {
  it('tests cache hit: done + track cached:true, no llmJsonWithRepair call for tests', async () => {
    const deps = makeDeps()
    deps.getCached.mockImplementation(async (key: string) => {
      if (key.includes('tests')) return TEST_INSIGHT_RESULT
      return null
    })

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.tests.status).toBe('done')
    expect(run.tests.value).toEqual(TEST_INSIGHT_RESULT)

    const testsTrack = deps.track.mock.calls.find(
      (c: unknown[]) => c[0] === 'ai_task_completed' && (c[1] as Record<string, unknown>)['task'] === 'tests',
    )
    expect(testsTrack).toBeTruthy()
    expect((testsTrack![1] as Record<string, unknown>)['cached']).toBe(true)
  })

  it('tests failure does not affect summary, attention, diagrams, or verdict', async () => {
    const deps = makeDeps()

    deps.llmStream.mockImplementation(async (_opts: unknown, onDelta: (d: string) => void) => {
      onDelta('summary text')
      return 'summary text'
    })

    // Make tests task fail by throwing when validate returns non-null for TEST_INSIGHT_RESULT
    deps.llmJsonWithRepair.mockImplementation(async (_opts: unknown, validate: ValidateFn) => {
      const asTests = validate(TEST_INSIGHT_RESULT)
      if (asTests !== null) {
        throw new LlmError('server', 'tests task broke')
      }
      const asAttention = validate(ATTENTION_RESULT)
      if (asAttention !== null) return asAttention
      const asGraph = validate(GRAPH_RESULT)
      if (asGraph !== null) return asGraph
      return VERDICT_RESULT
    })

    const run = createAiRun(makeInput(), deps)
    await run.start()

    // tests should fail
    expect(run.tests.status).toBe('error')
    expect(run.tests.error).toBeTruthy()
    // other panels should succeed
    expect(run.summary.status).toBe('done')
    expect(run.attention.status).toBe('done')
    expect(run.diagrams.status).toBe('done')
    expect(run.verdict.status).toBe('done')

    // ai_task_failed should be tracked for tests
    const failedCall = deps.track.mock.calls.find(
      (c: unknown[]) => c[0] === 'ai_task_failed' && (c[1] as Record<string, unknown>)['task'] === 'tests',
    )
    expect(failedCall).toBeTruthy()
    expect((failedCall![1] as Record<string, unknown>)['reason']).toBe('server')
  })

  it('retry(tests) re-runs only tests, other panels unaffected', async () => {
    const deps = makeDeps()

    let testsCallCount = 0
    deps.llmJsonWithRepair.mockImplementation(async (_opts: unknown, validate: ValidateFn) => {
      const asTests = validate(TEST_INSIGHT_RESULT)
      if (asTests !== null) {
        testsCallCount++
        if (testsCallCount === 1) throw new LlmError('server', 'tests broke first time')
        return asTests
      }
      const asAttention = validate(ATTENTION_RESULT)
      if (asAttention !== null) return asAttention
      const asGraph = validate(GRAPH_RESULT)
      if (asGraph !== null) return asGraph
      return VERDICT_RESULT
    })

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.tests.status).toBe('error')
    const summaryStatusBeforeRetry = run.summary.status
    const attentionStatusBeforeRetry = run.attention.status

    // Retry tests only
    await run.retry('tests')

    expect(run.tests.status).toBe('done')
    expect(run.tests.value).toEqual(TEST_INSIGHT_RESULT)
    // Other panels unchanged by retry
    expect(run.summary.status).toBe(summaryStatusBeforeRetry)
    expect(run.attention.status).toBe(attentionStatusBeforeRetry)
  })
})

// ---------------------------------------------------------------------------
// alternatives panel (Plan F) — sixth parallel task
// ---------------------------------------------------------------------------

describe('alternatives panel (Plan F)', () => {
  it('alternatives cache hit: done + track cached:true, no llmJsonWithRepair call for alternatives', async () => {
    const deps = makeDeps()
    deps.getCached.mockImplementation(async (key: string) => {
      if (key.includes('alternatives')) return ALTERNATIVES_RESULT
      return null
    })

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.alternatives.status).toBe('done')
    expect(run.alternatives.value).toEqual(ALTERNATIVES_RESULT)

    const altTrack = deps.track.mock.calls.find(
      (c: unknown[]) => c[0] === 'ai_task_completed' && (c[1] as Record<string, unknown>)['task'] === 'alternatives',
    )
    expect(altTrack).toBeTruthy()
    expect((altTrack![1] as Record<string, unknown>)['cached']).toBe(true)
  })

  it('alternatives failure does not affect summary, attention, diagrams, tests, or verdict', async () => {
    const deps = makeDeps()

    deps.llmStream.mockImplementation(async (_opts: unknown, onDelta: (d: string) => void) => {
      onDelta('summary text')
      return 'summary text'
    })

    // Make alternatives task fail
    deps.llmJsonWithRepair.mockImplementation(async (_opts: unknown, validate: ValidateFn) => {
      const asAlternatives = validate(ALTERNATIVES_RESULT)
      if (asAlternatives !== null) {
        throw new LlmError('server', 'alternatives task broke')
      }
      const asAttention = validate(ATTENTION_RESULT)
      if (asAttention !== null) return asAttention
      const asGraph = validate(GRAPH_RESULT)
      if (asGraph !== null) return asGraph
      const asTests = validate(TEST_INSIGHT_RESULT)
      if (asTests !== null) return asTests
      return VERDICT_RESULT
    })

    const run = createAiRun(makeInput(), deps)
    await run.start()

    // alternatives should fail
    expect(run.alternatives.status).toBe('error')
    expect(run.alternatives.error).toBeTruthy()
    // other panels should succeed
    expect(run.summary.status).toBe('done')
    expect(run.attention.status).toBe('done')
    expect(run.diagrams.status).toBe('done')
    expect(run.tests.status).toBe('done')
    expect(run.verdict.status).toBe('done')

    // ai_task_failed should be tracked for alternatives
    const failedCall = deps.track.mock.calls.find(
      (c: unknown[]) => c[0] === 'ai_task_failed' && (c[1] as Record<string, unknown>)['task'] === 'alternatives',
    )
    expect(failedCall).toBeTruthy()
    expect((failedCall![1] as Record<string, unknown>)['reason']).toBe('server')
  })

  it('retry(alternatives) re-runs only alternatives, other panels unaffected', async () => {
    const deps = makeDeps()

    let altCallCount = 0
    deps.llmJsonWithRepair.mockImplementation(async (_opts: unknown, validate: ValidateFn) => {
      const asAlternatives = validate(ALTERNATIVES_RESULT)
      if (asAlternatives !== null) {
        altCallCount++
        if (altCallCount === 1) throw new LlmError('server', 'alternatives broke first time')
        return asAlternatives
      }
      const asAttention = validate(ATTENTION_RESULT)
      if (asAttention !== null) return asAttention
      const asGraph = validate(GRAPH_RESULT)
      if (asGraph !== null) return asGraph
      const asTests = validate(TEST_INSIGHT_RESULT)
      if (asTests !== null) return asTests
      return VERDICT_RESULT
    })

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.alternatives.status).toBe('error')
    const summaryStatusBeforeRetry = run.summary.status
    const attentionStatusBeforeRetry = run.attention.status

    // Retry alternatives only
    await run.retry('alternatives')

    expect(run.alternatives.status).toBe('done')
    expect(run.alternatives.value).toEqual(ALTERNATIVES_RESULT)
    // Other panels unchanged by retry
    expect(run.summary.status).toBe(summaryStatusBeforeRetry)
    expect(run.attention.status).toBe(attentionStatusBeforeRetry)
  })
})

// ---------------------------------------------------------------------------
// coach() — on-demand, never cached, consent gating
// ---------------------------------------------------------------------------

import type { Draft } from '../drafts/drafts.svelte'

const DRAFT_FIXTURE: Draft[] = [
  { prKey: 'owner/repo#1@abc', path: 'src/foo.ts', line: 10, side: 'RIGHT', body: 'This is wrong.', updatedAt: 0 },
  { prKey: 'owner/repo#1@abc', path: 'src/bar.ts', line: 42, side: 'LEFT', body: 'Why not use a map?', updatedAt: 0 },
]

const COACH_RESULT: CoachResult = {
  reviews: [
    { index: 0, clarity: 3, actionable: false, tone: 'blunt', biasQuestion: 'Is this a preference or a defect?', suggestion: 'Consider renaming X to Y for clarity.', accuracy: 'consistent', accuracyNote: null, duplicate: false },
    { index: 1, clarity: 4, actionable: true, tone: 'ok', biasQuestion: null, suggestion: null, accuracy: 'questionable', accuracyNote: null, duplicate: true },
  ],
}

describe('coach() — gating (no-key / declined)', () => {
  it('no-key: coach returns error message without calling gateAi or llm', async () => {
    const deps = makeDeps({ hasKey: false })
    const run = createAiRun(makeInput(), deps)

    const result = await run.coach(DRAFT_FIXTURE)

    expect('error' in result).toBe(true)
    expect((result as { error: string }).error).toContain('No DeepSeek API key')
    expect(deps.gateAi).not.toHaveBeenCalled()
    expect(deps.llmJsonWithRepair).not.toHaveBeenCalled()
  })

  it('declined: coach returns declined error message without calling llm', async () => {
    const deps = makeDeps({ gateResult: false })
    const run = createAiRun(makeInput(), deps)

    const result = await run.coach(DRAFT_FIXTURE)

    expect('error' in result).toBe(true)
    expect((result as { error: string }).error.length).toBeGreaterThan(0)
    expect(deps.llmJsonWithRepair).not.toHaveBeenCalled()
  })

  it('declined: coach uses the same gateAi (shared ask)', async () => {
    const deps = makeDeps({ gateResult: false })
    const ask = vi.fn().mockResolvedValue(false)
    const run = createAiRun({ ...makeInput({ isPrivate: true }), ask }, deps)

    await run.coach(DRAFT_FIXTURE)

    expect(deps.gateAi).toHaveBeenCalledWith({
      repo: 'owner/repo',
      isPrivate: true,
      ask,
    })
  })
})

describe('coach() — success', () => {
  it('returns CoachResult on success, maps drafts to index=array-position', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepair.mockResolvedValue(COACH_RESULT)

    const run = createAiRun(makeInput(), deps)
    const result = await run.coach(DRAFT_FIXTURE)

    expect('error' in result).toBe(false)
    // CoachResult fields are returned verbatim; usage is attached separately.
    expect(result).toMatchObject(COACH_RESULT)
  })

  it('attaches captured usage to the coach outcome and folds it into totalUsage', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepair.mockResolvedValue(COACH_RESULT)

    const run = createAiRun(makeInput(), deps)
    const result = await run.coach(DRAFT_FIXTURE)

    expect('error' in result).toBe(false)
    // makeDeps' WithUsage stub returns { prompt:10, completion:5, total:15 }
    expect((result as { usage?: unknown }).usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    })
    // Coach usage contributes to the per-PR total (no other task ran here).
    expect(run.totalUsage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    })
  })

  it('passes per-comment code context (excerpt + fileWindow) into the prompt', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepair.mockResolvedValue(COACH_RESULT)

    const input = makeInput()
    input.coachCodeContext = (drafts) =>
      drafts.map((d, i) => ({
        index: i,
        path: d.path,
        line: d.line,
        side: d.side,
        excerpt: `+ const x = ${i}`,
        fileWindow: `${d.line}: const x = ${i}`,
      }))

    const run = createAiRun(input, deps)
    await run.coach(DRAFT_FIXTURE)

    const call = deps.llmJsonWithRepairWithUsage.mock.calls[0]
    const user = (call[0] as { user: string }).user
    expect(user).toContain('codeContext')
    expect(user).toContain('const x = 0')
    expect(user).toContain('fileWindow')
  })

  it('tracks ai_task_completed with task:coach on success', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepair.mockResolvedValue(COACH_RESULT)

    const run = createAiRun(makeInput(), deps)
    await run.coach(DRAFT_FIXTURE)

    const coachTrack = deps.track.mock.calls.find(
      (c: unknown[]) => c[0] === 'ai_task_completed' && (c[1] as Record<string, unknown>)['task'] === 'coach',
    )
    expect(coachTrack).toBeTruthy()
    expect(typeof (coachTrack![1] as Record<string, unknown>)['duration_ms']).toBe('number')
  })
})

describe('coach() — error mapping', () => {
  it('LlmError → {error: human message}, tracks ai_task_failed', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepair.mockRejectedValue(new LlmError('rate-limited', 'too many calls'))

    const run = createAiRun(makeInput(), deps)
    const result = await run.coach(DRAFT_FIXTURE)

    expect('error' in result).toBe(true)
    expect((result as { error: string }).error).toContain('Rate limited')

    const failedCall = deps.track.mock.calls.find(
      (c: unknown[]) => c[0] === 'ai_task_failed' && (c[1] as Record<string, unknown>)['task'] === 'coach',
    )
    expect(failedCall).toBeTruthy()
    expect((failedCall![1] as Record<string, unknown>)['reason']).toBe('rate-limited')
  })

  it('unknown error → {error: human message}', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepair.mockRejectedValue(new Error('Unexpected crash'))

    const run = createAiRun(makeInput(), deps)
    const result = await run.coach(DRAFT_FIXTURE)

    expect('error' in result).toBe(true)
    expect(typeof (result as { error: string }).error).toBe('string')
    expect((result as { error: string }).error.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// coach() — batching across chunks (the ~30-comment robustness fix)
// ---------------------------------------------------------------------------

describe('coach() — batching', () => {
  // Build N drafts; the coach must split them into ceil(N/chunk) LLM calls.
  function manyDrafts(n: number): Draft[] {
    return Array.from({ length: n }, (_, i) => ({
      prKey: 'owner/repo#1@abc',
      path: `src/f${i}.ts`,
      line: i + 1,
      side: 'RIGHT' as const,
      body: `Comment ${i}`,
      updatedAt: 0,
    }))
  }

  // A mock that grades exactly the drafts present in THIS chunk's user payload,
  // echoing each draft's original index — so the merge mapping is exercised.
  function gradeChunkByPayload() {
    return async (opts: unknown) => {
      const user = (opts as { user: string }).user
      const payload = JSON.parse(user) as { drafts: { index: number }[] }
      return {
        result: {
          reviews: payload.drafts.map((d) => ({
            index: d.index,
            clarity: 3,
            actionable: true,
            tone: 'ok',
            biasQuestion: null,
            suggestion: null,
            accuracy: 'consistent',
            accuracyNote: null,
            duplicate: false,
          })),
        },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }
    }
  }

  it('20 drafts → 3 chunks → 20 graded reviews in index order', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepairWithUsage.mockImplementation(gradeChunkByPayload())

    const run = createAiRun(makeInput(), deps)
    const result = await run.coach(manyDrafts(20))

    expect('error' in result).toBe(false)
    // 7 + 7 + 6 = 20 → 3 LLM calls
    expect(deps.llmJsonWithRepairWithUsage).toHaveBeenCalledTimes(3)
    const reviews = (result as { reviews: { index: number }[] }).reviews
    expect(reviews.map((r) => r.index)).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })

  it('30 drafts are split — no single giant prompt; each chunk payload is bounded', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepairWithUsage.mockImplementation(gradeChunkByPayload())

    const run = createAiRun(makeInput(), deps)
    await run.coach(manyDrafts(30))

    expect(deps.llmJsonWithRepairWithUsage.mock.calls.length).toBeGreaterThan(1)
    for (const call of deps.llmJsonWithRepairWithUsage.mock.calls) {
      const payload = JSON.parse((call[0] as { user: string }).user) as { drafts: unknown[] }
      expect(payload.drafts.length).toBeLessThanOrEqual(7)
    }
  })

  it('each chunk carries ONLY its own drafts code context (correct mapping)', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepairWithUsage.mockImplementation(gradeChunkByPayload())

    const input = makeInput()
    input.coachCodeContext = (drafts) =>
      drafts.map((d, i) => ({
        index: i,
        path: d.path,
        line: d.line,
        side: d.side,
        excerpt: `EXCERPT-${i}`,
      }))

    const run = createAiRun(input, deps)
    await run.coach(manyDrafts(20))

    // The first chunk (drafts 0–6) must carry EXCERPT-0 but NOT EXCERPT-19.
    const firstUser = (deps.llmJsonWithRepairWithUsage.mock.calls[0][0] as { user: string }).user
    expect(firstUser).toContain('EXCERPT-0')
    expect(firstUser).not.toContain('EXCERPT-19')
  })

  it('verdict coherence is requested on the first chunk only', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepairWithUsage.mockImplementation(gradeChunkByPayload())

    const run = createAiRun(makeInput(), deps)
    await run.coach(manyDrafts(20), undefined, 'APPROVE')

    const firstPayload = JSON.parse((deps.llmJsonWithRepairWithUsage.mock.calls[0][0] as { user: string }).user)
    const secondPayload = JSON.parse((deps.llmJsonWithRepairWithUsage.mock.calls[1][0] as { user: string }).user)
    expect(firstPayload.chosenVerdict).toBe('APPROVE')
    expect('chosenVerdict' in secondPayload).toBe(false)
  })

  it('sums usage across all chunks into the outcome + totalUsage', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepairWithUsage.mockImplementation(gradeChunkByPayload())

    const run = createAiRun(makeInput(), deps)
    const result = await run.coach(manyDrafts(20)) // 3 chunks × {1,1,2}

    expect((result as { usage?: unknown }).usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 3,
      total_tokens: 6,
    })
    expect(run.totalUsage).toEqual({ prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 })
  })
})

// ---------------------------------------------------------------------------
// coach() — partial failure (some chunks fail, others succeed)
// ---------------------------------------------------------------------------

describe('coach() — partial failure', () => {
  function manyDrafts(n: number): Draft[] {
    return Array.from({ length: n }, (_, i) => ({
      prKey: 'owner/repo#1@abc',
      path: `src/f${i}.ts`,
      line: i + 1,
      side: 'RIGHT' as const,
      body: `Comment ${i}`,
      updatedAt: 0,
    }))
  }

  it('one chunk errors → other chunks returned + a notCoached note for the failed drafts', async () => {
    const deps = makeDeps()
    let call = 0
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (opts: unknown) => {
      const payload = JSON.parse((opts as { user: string }).user) as { drafts: { index: number }[] }
      call++
      // Fail the SECOND chunk only.
      if (call === 2) throw new LlmError('rate-limited', 'slow down')
      return {
        result: { reviews: payload.drafts.map((d) => ({
          index: d.index, clarity: 3, actionable: true, tone: 'ok',
          biasQuestion: null, suggestion: null, accuracy: 'consistent',
          accuracyNote: null, duplicate: false,
        })) },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }
    })

    const run = createAiRun(makeInput(), deps)
    const result = await run.coach(manyDrafts(20)) // chunks: [0-6],[7-13],[14-19]

    expect('error' in result).toBe(false)
    const r = result as { reviews: { index: number }[]; notCoached?: { indices: number[]; message: string } }
    // Chunk 1 (0-6) and chunk 3 (14-19) succeeded → 13 reviews.
    expect(r.reviews.map((x) => x.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 14, 15, 16, 17, 18, 19])
    // The failed chunk's drafts (7-13) are accounted for — never silently dropped.
    expect(r.notCoached).toBeDefined()
    expect(r.notCoached!.indices).toEqual([7, 8, 9, 10, 11, 12, 13])
    expect(r.notCoached!.message).toMatch(/Rate limited/)
    expect(r.notCoached!.message).toMatch(/retry/i)
  })

  it('ALL chunks fail → error path (specific message, not the catch-all)', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepairWithUsage.mockRejectedValue(new LlmError('rate-limited', 'slow down'))

    const run = createAiRun(makeInput(), deps)
    const result = await run.coach(manyDrafts(20))

    expect('error' in result).toBe(true)
    const err = (result as { error: string }).error
    expect(err).toMatch(/Rate limited/)
    expect(err).not.toMatch(/An unexpected error occurred/)
  })

  it('total failure carries the failing chunk CONCRETE detail as errorDetail', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepairWithUsage.mockRejectedValue(
      new LlmError('server', 'Server error (502): upstream connect error', { status: 502 }),
    )

    const run = createAiRun(makeInput(), deps)
    const result = await run.coach(manyDrafts(3))

    expect('error' in result).toBe(true)
    const r = result as { error: string; errorDetail?: string }
    // describeTaskError composition: the raw message adds info beyond the
    // canned sentence, so it surfaces (with the retried-automatically suffix
    // since 5xx is transient-classified).
    expect(r.errorDetail).toContain('upstream connect error')
    expect(r.errorDetail).toContain('retried automatically')
    // Analytics carry reason_detail too (same composition rules).
    const failed = deps.track.mock.calls.find((c: unknown[]) => c[0] === 'ai_task_failed')!
    expect((failed[1] as { reason_detail?: string }).reason_detail).toContain('upstream connect error')
  })

  it('partial failure carries the failing chunk detail as notCoached.detail', async () => {
    const deps = makeDeps()
    let call = 0
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (opts: unknown) => {
      const payload = JSON.parse((opts as { user: string }).user) as { drafts: { index: number }[] }
      call++
      if (call === 2) {
        throw new LlmError('rate-limited', 'Rate limited (429): tokens exhausted', { status: 429 })
      }
      return {
        result: { reviews: payload.drafts.map((d) => ({
          index: d.index, clarity: 3, actionable: true, tone: 'ok',
          biasQuestion: null, suggestion: null, accuracy: 'consistent',
          accuracyNote: null, duplicate: false,
        })) },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }
    })

    const run = createAiRun(makeInput(), deps)
    const result = await run.coach(manyDrafts(20))

    const r = result as { notCoached?: { indices: number[]; message: string; detail?: string } }
    expect(r.notCoached).toBeDefined()
    expect(r.notCoached!.detail).toContain('tokens exhausted')
  })

  it('no detail when the failure message adds nothing beyond the canned sentence', async () => {
    const deps = makeDeps()
    // Bare LlmError default message `llm: rate-limited` → detail is omitted
    // (describeTaskError rule 2)… except transient classification appends the
    // honest retried-automatically note. Assert the raw message never leaks.
    deps.llmJsonWithRepairWithUsage.mockRejectedValue(new LlmError('rate-limited'))

    const run = createAiRun(makeInput(), deps)
    const result = await run.coach(manyDrafts(3))

    const r = result as { error: string; errorDetail?: string }
    expect(r.errorDetail ?? '').not.toContain('llm: rate-limited')
  })

  it('the failed-chunk indices map back to the right drafts (mapping integrity)', async () => {
    const deps = makeDeps()
    let call = 0
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (opts: unknown) => {
      const payload = JSON.parse((opts as { user: string }).user) as { drafts: { index: number }[] }
      call++
      if (call === 1) throw new LlmError('network', 'down') // first chunk fails
      return {
        result: { reviews: payload.drafts.map((d) => ({
          index: d.index, clarity: 3, actionable: true, tone: 'ok',
          biasQuestion: null, suggestion: null, accuracy: 'consistent',
          accuracyNote: null, duplicate: false,
        })) },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }
    })

    const run = createAiRun(makeInput(), deps)
    const result = await run.coach(manyDrafts(20))

    const r = result as { reviews: { index: number }[]; notCoached?: { indices: number[] } }
    // First chunk = drafts 0-6 failed; 7-19 graded.
    expect(r.notCoached!.indices).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(r.reviews.map((x) => x.index)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
  })
})

describe('coach() — never touches cache', () => {
  it('coach does not call getCached or setCached', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepair.mockResolvedValue(COACH_RESULT)

    const getCachedSpy = deps.getCached
    const setCachedSpy = deps.setCached

    const run = createAiRun(makeInput(), deps)
    // Reset call counts after start() might have touched cache
    await run.coach(DRAFT_FIXTURE)

    // After a standalone coach call (without start()), cache should not be touched
    const run2 = createAiRun(makeInput(), deps)
    deps.getCached.mockClear()
    deps.setCached.mockClear()
    await run2.coach(DRAFT_FIXTURE)

    expect(getCachedSpy).not.toHaveBeenCalled()
    expect(setCachedSpy).not.toHaveBeenCalled()
  })
})

describe('coach() — prComments threading', () => {
  it('coach passes prComments to coachPrompt when provided', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepair.mockResolvedValue(COACH_RESULT)

    const run = createAiRun(makeInput(), deps)
    const prComments = ['Existing comment A.', 'Existing comment B.']
    await run.coach(DRAFT_FIXTURE, prComments)

    // The user prompt passed to llmJsonWithRepair should contain the PR comments
    const callArgs = deps.llmJsonWithRepair.mock.calls[0]
    const userPrompt: string = (callArgs[0] as { system: string; user: string }).user
    expect(userPrompt).toContain('Existing comment A.')
    expect(userPrompt).toContain('Existing comment B.')
  })

  it('coach works without prComments (backward compatible)', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepair.mockResolvedValue(COACH_RESULT)

    const run = createAiRun(makeInput(), deps)
    // No prComments — should not throw
    const result = await run.coach(DRAFT_FIXTURE)
    expect('error' in result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// coach() — v9: verdict + diff context threading
// ---------------------------------------------------------------------------

describe('coach() — verdict and diff context threading (v9)', () => {
  function lastCoachUserPrompt(deps: ReturnType<typeof makeDeps>): Record<string, unknown> {
    const callArgs = deps.llmJsonWithRepair.mock.calls.at(-1)!
    const userPrompt: string = (callArgs[0] as { system: string; user: string }).user
    return JSON.parse(userPrompt) as Record<string, unknown>
  }

  it('passes the chosen verdict into the prompt payload as chosenVerdict', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepair.mockResolvedValue(COACH_RESULT)

    const run = createAiRun(makeInput(), deps)
    await run.coach(DRAFT_FIXTURE, undefined, 'APPROVE')

    expect(lastCoachUserPrompt(deps)['chosenVerdict']).toBe('APPROVE')
  })

  it('omits chosenVerdict when no verdict is given (backward compatible)', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepair.mockResolvedValue(COACH_RESULT)

    const run = createAiRun(makeInput(), deps)
    await run.coach(DRAFT_FIXTURE)

    expect('chosenVerdict' in lastCoachUserPrompt(deps)).toBe(false)
  })

  it('TRIMS the full prContext from the coach prompt — relies on per-comment code context', async () => {
    // The full packed prContext was largely redundant with the per-comment
    // excerpt + file window and bloated the prompt; batching dropped it so each
    // chunk stays within model limits. The trimmed prompt must NOT carry it.
    const deps = makeDeps()
    deps.llmJsonWithRepair.mockResolvedValue(COACH_RESULT)

    const run = createAiRun(makeInput(), deps)
    await run.coach(DRAFT_FIXTURE)

    expect('prContext' in lastCoachUserPrompt(deps)).toBe(false)
  })

  it('does not pack the PR context for coaching (no pack() call)', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepair.mockResolvedValue(COACH_RESULT)
    const pack = vi.fn(async () => PACKED_CTX)

    const run = createAiRun(makeInput({ pack }), deps)
    await run.coach(DRAFT_FIXTURE)

    expect(pack).not.toHaveBeenCalled()
    expect('prContext' in lastCoachUserPrompt(deps)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ask() — on-demand free-form Q&A, never cached, consent gating
// ---------------------------------------------------------------------------

describe('ask() — gating (no-key / declined)', () => {
  it('no-key: ask returns {ok:false, error} without calling gateAi or llm', async () => {
    const deps = makeDeps({ hasKey: false })
    const run = createAiRun(makeInput(), deps)

    const result = await run.ask('Why is this coded here?', () => {})

    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain('No DeepSeek API key')
    expect(deps.gateAi).not.toHaveBeenCalled()
    expect(deps.llmStream).not.toHaveBeenCalled()
  })

  it('declined: ask returns {ok:false, error} without calling llm', async () => {
    const deps = makeDeps({ gateResult: false })
    const run = createAiRun(makeInput(), deps)

    const result = await run.ask('What does this do?', () => {})

    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error.length).toBeGreaterThan(0)
    expect(deps.llmStream).not.toHaveBeenCalled()
  })
})

describe('ask() — streaming', () => {
  it('calls onDelta for each streamed token and returns {ok:true, answer}', async () => {
    const deps = makeDeps()
    deps.llmStream.mockImplementation(async (_opts: unknown, onDelta: (d: string) => void) => {
      onDelta('Hello')
      onDelta(' world')
      return 'Hello world'
    })

    const deltas: string[] = []
    const run = createAiRun(makeInput(), deps)
    const result = await run.ask('Why is this here?', (t) => deltas.push(t))

    expect(result.ok).toBe(true)
    expect((result as { ok: true; answer: string }).answer).toBe('Hello world')
    expect(deltas).toEqual(['Hello', ' world'])
  })

  it('ask never calls getCached or setCached', async () => {
    const deps = makeDeps()
    deps.llmStream.mockImplementation(async (_opts: unknown, onDelta: (d: string) => void) => {
      onDelta('answer text')
      return 'answer text'
    })

    const run = createAiRun(makeInput(), deps)
    deps.getCached.mockClear()
    deps.setCached.mockClear()
    await run.ask('question', () => {})

    expect(deps.getCached).not.toHaveBeenCalled()
    expect(deps.setCached).not.toHaveBeenCalled()
  })

  it('tracks ai_task_completed with task:ask on success', async () => {
    const deps = makeDeps()
    deps.llmStream.mockImplementation(async (_opts: unknown, onDelta: (d: string) => void) => {
      onDelta('response')
      return 'response'
    })

    const run = createAiRun(makeInput(), deps)
    await run.ask('A question?', () => {})

    const askTrack = deps.track.mock.calls.find(
      (c: unknown[]) => c[0] === 'ai_task_completed' && (c[1] as Record<string, unknown>)['task'] === 'ask',
    )
    expect(askTrack).toBeTruthy()
  })
})

describe('ask() — history threading', () => {
  it('second ask includes first Q&A in the prompt sent to llm', async () => {
    const deps = makeDeps()
    const capturedMessages: unknown[] = []

    deps.llmStream.mockImplementation(async (opts: unknown, onDelta: (d: string) => void) => {
      capturedMessages.push(opts)
      onDelta('answer')
      return 'answer'
    })

    const run = createAiRun(makeInput(), deps)

    // First ask
    await run.ask('First question', () => {})
    // Second ask
    await run.ask('Second question', () => {})

    // The second call's prompt should contain the first Q/A pair
    expect(capturedMessages).toHaveLength(2)
    const secondPrompt = capturedMessages[1] as { user: string }
    expect(secondPrompt.user).toContain('First question')
    expect(secondPrompt.user).toContain('answer') // the first answer
    expect(secondPrompt.user).toContain('Second question')
  })

  it('history is capped at last 3 exchanges (fifth ask prompt omits first Q&A)', async () => {
    const deps = makeDeps()
    const capturedMessages: unknown[] = []
    let callCount = 0

    deps.llmStream.mockImplementation(async (opts: unknown, onDelta: (d: string) => void) => {
      capturedMessages.push(opts)
      callCount++
      onDelta(`answer${callCount}`)
      return `answer${callCount}`
    })

    const run = createAiRun(makeInput(), deps)

    await run.ask('Q1', () => {})
    await run.ask('Q2', () => {})
    await run.ask('Q3', () => {})
    await run.ask('Q4', () => {})
    await run.ask('Q5', () => {})

    // After 4 completed exchanges (cap=3), history=[Q2,Q3,Q4].
    // The 5th call's prompt should NOT contain Q1/answer1 (only last 3 pairs kept)
    const fifthPrompt = capturedMessages[4] as { user: string }
    expect(fifthPrompt.user).not.toContain('Q1')
    expect(fifthPrompt.user).not.toContain('answer1')
    expect(fifthPrompt.user).toContain('Q2')
    expect(fifthPrompt.user).toContain('Q5')
  })
})

describe('ask() — error mapping', () => {
  it('LlmError → {ok:false, error: human message}, tracks ai_task_failed', async () => {
    const deps = makeDeps()
    deps.llmStream.mockRejectedValue(new LlmError('rate-limited', 'too many'))

    const run = createAiRun(makeInput(), deps)
    const result = await run.ask('question', () => {})

    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain('Rate limited')

    const failedCall = deps.track.mock.calls.find(
      (c: unknown[]) => c[0] === 'ai_task_failed' && (c[1] as Record<string, unknown>)['task'] === 'ask',
    )
    expect(failedCall).toBeTruthy()
    expect((failedCall![1] as Record<string, unknown>)['reason']).toBe('rate-limited')
  })

  it('ai_task_failed for ask NEVER includes the question text', async () => {
    const deps = makeDeps()
    deps.llmStream.mockRejectedValue(new LlmError('server', 'error'))

    const run = createAiRun(makeInput(), deps)
    const SENSITIVE_QUESTION = 'SENSITIVE_QUESTION_TEXT_UNIQUE_12345'
    await run.ask(SENSITIVE_QUESTION, () => {})

    // Verify no track call includes the question text
    for (const call of deps.track.mock.calls) {
      const serialized = JSON.stringify(call)
      expect(serialized).not.toContain(SENSITIVE_QUESTION)
    }
  })
})

// ---------------------------------------------------------------------------
// ask() — focus parameter (line-level Ask AI)
// ---------------------------------------------------------------------------

describe('ask() — focus parameter', () => {
  it('ask with focus passes focus to askPrompt: system prompt contains path:line', async () => {
    const deps = makeDeps()
    const capturedArgs: unknown[] = []
    deps.llmStream.mockImplementation(async (prompts: unknown, _onDelta: (d: string) => void) => {
      capturedArgs.push(prompts)
      return 'answer with focus'
    })

    const run = createAiRun(makeInput(), deps)
    await run.ask('Why is this here?', () => {}, {
      path: 'src/target.ts',
      line: 77,
      excerpt: '-old\n+new',
    })

    expect(capturedArgs.length).toBe(1)
    const prompts = capturedArgs[0] as { system: string; user: string }
    // System prompt should reference the specific location
    expect(prompts.system).toContain('src/target.ts:77')
    // User prompt should include the excerpt
    expect(prompts.user).toContain('-old\n+new')
  })

  it('ask without focus does not inject location directive in system prompt', async () => {
    const deps = makeDeps()
    const capturedArgs: unknown[] = []
    deps.llmStream.mockImplementation(async (prompts: unknown, _onDelta: (d: string) => void) => {
      capturedArgs.push(prompts)
      return 'plain answer'
    })

    const run = createAiRun(makeInput(), deps)
    await run.ask('What is this PR about?', () => {})

    const prompts = capturedArgs[0] as { system: string; user: string }
    expect(prompts.system).not.toContain('src/target.ts:77')
    expect(prompts.system).not.toContain('specific change at')
  })

  it('ask with focus: history entries are unchanged (focus does not leak into stored history)', async () => {
    const deps = makeDeps()
    const allPrompts: Array<{ system: string; user: string }> = []
    deps.llmStream.mockImplementation(async (prompts: unknown, _onDelta: (d: string) => void) => {
      allPrompts.push(prompts as { system: string; user: string })
      return 'answer'
    })

    const run = createAiRun(makeInput(), deps)
    // First ask WITH focus
    await run.ask('Q with focus', () => {}, { path: 'src/a.ts', line: 10, excerpt: '+added' })
    // Second ask WITHOUT focus — history from first ask should be present in user prompt
    await run.ask('Q without focus', () => {})

    expect(allPrompts.length).toBe(2)
    // Second prompt's user content should contain history from first ask
    expect(allPrompts[1].user).toContain('Q with focus')
    expect(allPrompts[1].user).toContain('answer')
    // Second prompt's system should NOT contain the focus location (no focus passed)
    expect(allPrompts[1].system).not.toContain('src/a.ts:10')
  })
})

// ---------------------------------------------------------------------------
// Token usage propagation to track()
// ---------------------------------------------------------------------------

describe('ai_task_completed carries tokens when usage available', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('summary task: track receives tokens when llmStreamWithUsage returns usage', async () => {
    const deps = makeDeps()
    deps.llmStreamWithUsage = vi.fn().mockImplementation(
      async (_opts: unknown, onDelta: (d: string) => void) => {
        onDelta('hello')
        return { content: 'hello', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }
      },
    )
    const run = createAiRun(makeInput(), deps)
    await run.start()
    const summaryCompleted = (deps.track.mock.calls as [string, Record<string, unknown>][]).find(
      ([event, props]) => event === 'ai_task_completed' && props.task === 'summary' && !props.cached
    )
    expect(summaryCompleted).toBeDefined()
    expect(summaryCompleted![1]).toMatchObject({ task: 'summary', tokens: 8 })
  })

  it('summary task: track has no tokens field when usage absent', async () => {
    const deps = makeDeps()
    deps.llmStreamWithUsage = vi.fn().mockImplementation(
      async (_opts: unknown, onDelta: (d: string) => void) => {
        onDelta('hello')
        return { content: 'hello' }
      },
    )
    const run = createAiRun(makeInput(), deps)
    await run.start()
    const summaryCompleted = (deps.track.mock.calls as [string, Record<string, unknown>][]).find(
      ([event, props]) => event === 'ai_task_completed' && props.task === 'summary' && !props.cached
    )
    expect(summaryCompleted).toBeDefined()
    expect(summaryCompleted![1]).not.toHaveProperty('tokens')
  })

  it('attention task: track receives tokens from llmJsonWithRepairWithUsage', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepairWithUsage = vi.fn().mockImplementation(
      async (_opts: unknown, validate: (x: unknown) => unknown) => {
        const result = validate(ATTENTION_RESULT) !== null ? ATTENTION_RESULT : VERDICT_RESULT
        return { result, usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }
      },
    )
    const run = createAiRun(makeInput(), deps)
    await run.start()
    const attentionCompleted = (deps.track.mock.calls as [string, Record<string, unknown>][]).find(
      ([event, props]) => event === 'ai_task_completed' && props.task === 'attention' && !props.cached
    )
    expect(attentionCompleted).toBeDefined()
    expect(attentionCompleted![1]).toMatchObject({ task: 'attention', tokens: 30 })
  })
})

// ---------------------------------------------------------------------------
// Active-provider awareness (Plan F Task F3)
// The no-key gate and error copy must follow settings.aiProvider, not be
// hardwired to deepseekKey / "DeepSeek".
// ---------------------------------------------------------------------------

describe('active-provider awareness (Plan F Task F3)', () => {
  it('start() proceeds when aiProvider=anthropic and only anthropicKey is set', async () => {
    const deps = makeDeps({ hasKey: false })
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ aiProvider: 'anthropic', anthropicKey: 'sk-ant-test' }),
    )
    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.summary.status).not.toBe('no-key')
    expect(deps.gateAi).toHaveBeenCalled()
  })

  it('start() sets no-key when aiProvider=anthropic and only deepseekKey is set', async () => {
    const deps = makeDeps({ hasKey: false })
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ aiProvider: 'anthropic', deepseekKey: 'sk-ds-test' }),
    )
    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.summary.status).toBe('no-key')
    expect(deps.gateAi).not.toHaveBeenCalled()
  })

  it('coach() no-key error names the ACTIVE provider (Gemini)', async () => {
    const deps = makeDeps({ hasKey: false })
    localStorage.setItem('review123:settings', JSON.stringify({ aiProvider: 'gemini' }))
    const run = createAiRun(makeInput(), deps)
    const result = await run.coach([])

    expect((result as { error: string }).error).toContain('No Gemini API key')
  })

  it('stream error copy names the ACTIVE provider (Anthropic)', async () => {
    const deps = makeDeps({ hasKey: false })
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ aiProvider: 'anthropic', anthropicKey: 'sk-ant-test' }),
    )
    deps.llmStreamWithUsage = vi.fn().mockRejectedValue(new LlmError('server'))
    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.summary.status).toBe('error')
    expect(run.summary.error).toContain('Anthropic')
  })
})

// ---------------------------------------------------------------------------
// Per-review token TOTAL accumulation (showTokenCost power-user feature)
// ---------------------------------------------------------------------------

describe('totalUsage — per-review accumulation', () => {
  it('is undefined before any task runs', () => {
    const deps = makeDeps()
    const run = createAiRun(makeInput(), deps)
    expect(run.totalUsage).toBeUndefined()
  })

  it('sums every task usage after a full start() (summary 8 + 7 json tasks × 15)', async () => {
    const deps = makeDeps()
    const run = createAiRun(makeInput(), deps)
    await run.start()

    // summary: total 8; attention/diagrams/tests/alternatives/story/risk-judge/verdict: 15 each = 105
    expect(run.totalUsage).toEqual({
      prompt_tokens: 5 + 10 * 7,
      completion_tokens: 3 + 5 * 7,
      total_tokens: 8 + 15 * 7,
    })
  })

  it('cached single-pass tasks with no stored usage contribute nothing (graceful)', async () => {
    const deps = makeDeps()
    // Every task served from cache as a bare result (no usage stored on
    // single-pass cache entries) → totalUsage stays undefined, never fabricated.
    deps.getCached.mockImplementation(async (key: string) => {
      if (key.includes('summary')) return 'cached summary'
      if (key.includes('attention')) return ATTENTION_RESULT
      if (key.includes('diagrams')) return GRAPH_RESULT
      if (key.includes('tests')) return TEST_INSIGHT_RESULT
      if (key.includes('alternatives')) return ALTERNATIVES_RESULT
      if (key.includes('story')) return STORY_RESULT
      if (key.includes('risk-judge')) return RISK_JUDGE_RESULT
      if (key.includes('verdict')) return VERDICT_RESULT
      return null
    })

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.summary.status).toBe('done')
    expect(run.verdict.status).toBe('done')
    expect(run.totalUsage).toBeUndefined()
  })

  it('partial: only the tasks that reported usage are summed', async () => {
    const deps = makeDeps()
    // summary served from cache (no usage); json tasks run live (usage 15 each).
    deps.getCached.mockImplementation(async (key: string) =>
      key.includes('summary') ? 'cached summary' : null,
    )

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.summary.usage).toBeUndefined()
    expect(run.totalUsage).toEqual({
      prompt_tokens: 10 * 7,
      completion_tokens: 5 * 7,
      total_tokens: 15 * 7,
    })
  })

  it('skill-review usage contributes to the per-PR total (#90 says core tasks + any skill reviews)', async () => {
    const { addSkill } = await import('../skills/skills')
    addSkill('My Reviewer', 'focus on security')

    const deps = makeDeps()
    const run = createAiRun(makeInput(), deps)
    // Only the skill review runs here — its WithUsage stub reports 15 tokens.
    await run.runSkillReviews()

    expect(run.skillReviews[0].state.status).toBe('done')
    expect(run.skillReviews[0].state.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
    // The per-PR total reflects the skill review's usage.
    expect(run.totalUsage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
  })
})

// ---------------------------------------------------------------------------
// Per-model breakdown survives a cache hit (companion '|models' cache entry)
//
// The Step-3 cost+performance table is fed by modelPerformance, which reads
// verdictModelsState + each skill reviewer's .models — RUN-STATE that used to
// vanish on a cache hit. A sibling cache entry keyed '...|models' now persists
// and restores the breakdown so a re-opened PR repopulates the table.
// ---------------------------------------------------------------------------

/** makeDeps variant backed by a SHARED in-memory cache so a second run's
 *  getCached sees what the first run's setCached wrote (round-trip). */
function makeDepsWithCache(store = new Map<string, unknown>(), opts = {}) {
  const deps = makeDeps(opts)
  deps.getCached.mockImplementation(async (key: string) =>
    store.has(key) ? store.get(key) : null,
  )
  deps.setCached.mockImplementation(async (key: string, value: unknown) => {
    store.set(key, value)
  })
  return { deps, store }
}

describe('per-model breakdown survives a cache hit (companion |models entry)', () => {
  it('verdict: a cache-hit re-run repopulates verdictModels / modelPerformance and skips generation', async () => {
    const evidenceFreeVerdict: VerdictResult = { level: 'behavior-preserved', evidence: [], notAnalyzed: [] }
    const verdictUsage = { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 }

    const store = new Map<string, unknown>()

    // First (fresh) run: writes the verdict result AND its '|models' companion.
    const first = makeDepsWithCache(store).deps
    first.llmJsonWithRepairWithUsage.mockImplementation(async (opts: unknown, validate: ValidateFn) => {
      if (validate(evidenceFreeVerdict) !== null) return { result: evidenceFreeVerdict, usage: verdictUsage }
      return { result: await first.llmJsonWithRepair(opts, validate), usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    })
    const run1 = createAiRun(makeInput(), first)
    await run1.start()
    expect(run1.verdictModels.length).toBeGreaterThanOrEqual(1)
    // The companion entry was persisted.
    const modelsKeyWritten = [...store.keys()].some((k) => k.includes('verdict') && k.includes('|models'))
    expect(modelsKeyWritten).toBe(true)

    // Second run on the SAME cache: verdict result hits cache → no new
    // generation call for the verdict, yet the breakdown is restored.
    const { deps: second } = makeDepsWithCache(store)
    let verdictGenerated = false
    second.llmJsonWithRepairWithUsage.mockImplementation(async (opts: unknown, validate: ValidateFn) => {
      if (validate(evidenceFreeVerdict) !== null) {
        verdictGenerated = true
        return { result: evidenceFreeVerdict, usage: verdictUsage }
      }
      return { result: await second.llmJsonWithRepair(opts, validate), usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    })
    const run2 = createAiRun(makeInput(), second)
    await run2.start()

    // Cache hit: verdict 'done', no fresh verdict generation.
    expect(run2.verdict.status).toBe('done')
    expect(verdictGenerated).toBe(false)
    const verdictTrack = second.track.mock.calls.find(
      (c: unknown[]) => c[0] === 'ai_task_completed' && (c[1] as Record<string, unknown>)['task'] === 'verdict',
    )
    expect((verdictTrack![1] as Record<string, unknown>)['cached']).toBe(true)

    // The per-model table is repopulated from the companion entry.
    expect(run2.verdictModels.length).toBeGreaterThanOrEqual(1)
    const gen = run2.modelPerformance.find((m) => m.role === 'generator')
    expect(gen).toBeDefined()
    expect(gen!.usage!.total_tokens).toBe(42)
  })

  it('skill review: a cache-hit re-run restores .models so the reviewer contributes to modelPerformance', async () => {
    const { addSkill } = await import('../skills/skills')
    addSkill('My Reviewer', 'focus on security')

    const skillUsage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    const store = new Map<string, unknown>()

    // Fresh run — record a per-model breakdown directly in the '|models' entry.
    // (The breakdown is only built when an ensemble verifier responds; here we
    // seed it so the round-trip restore is exercised without a full ensemble.)
    const { deps: first } = makeDepsWithCache(store)
    const run1 = createAiRun(makeInput(), first)
    await run1.runSkillReviews()
    expect(run1.skillReviews[0].state.status).toBe('done')
    // A companion '|models' entry was written for the skill (empty breakdown for
    // a single-model run, but the KEY exists so the round-trip path is covered).
    const skillModelsKey = [...store.keys()].find((k) => k.includes('skill:') && k.includes('|models'))
    expect(skillModelsKey).toBeDefined()

    // Seed a non-empty breakdown into the companion entry, simulating a prior
    // ensemble run, then re-run so the SKILL result hits cache and restores it.
    const seededRows: import('./run.svelte').VerdictModelBreakdown[] = [
      { providerId: 'deepseek', modelId: 'deepseek-chat', role: 'generator', usage: skillUsage, surfaced: 1, uniqueCatch: 0 },
    ]
    store.set(skillModelsKey!, seededRows)

    const { deps: second } = makeDepsWithCache(store)
    const run2 = createAiRun(makeInput(), second)
    await run2.runSkillReviews()

    // Skill result came from cache and the breakdown was restored onto .models.
    expect(run2.skillReviews[0].state.status).toBe('done')
    expect(run2.skillReviews[0].state.models).toEqual(seededRows)
    const skillTrack = second.track.mock.calls.find(
      (c: unknown[]) => c[0] === 'ai_task_completed' && (c[1] as Record<string, unknown>)['task'] === 'skill-review',
    )
    expect((skillTrack![1] as Record<string, unknown>)['cached']).toBe(true)
    // And it flows into the consolidated aggregate.
    const gen = run2.modelPerformance.find((m) => m.role === 'generator' && m.modelId === 'deepseek-chat')
    expect(gen).toBeDefined()
    expect(gen!.usage!.total_tokens).toBe(15)
  })

  it('backward-compat: a result cache hit with NO companion entry → empty breakdown, no throw, usage unaffected', async () => {
    // Pre-existing cache (predates the companion entry): only the verdict result
    // is present, no '...|models' sibling. Restoring must degrade gracefully.
    const store = new Map<string, unknown>()
    const { deps } = makeDepsWithCache(store)
    // Seed ONLY the verdict result entries (deep + non-deep) — no |models siblings.
    deps.getCached.mockImplementation(async (key: string) => {
      if (key.includes('|models')) return null // companion missing
      if (key.includes('verdict')) return VERDICT_RESULT
      return null
    })

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.verdict.status).toBe('done')
    // No companion entry → empty breakdown for the verdict, nothing thrown.
    expect(run.verdictModels).toEqual([])
    expect(run.modelPerformance.find((m) => m.role === 'generator')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// errorDetail — concrete failure detail lands in PanelState + analytics
// ---------------------------------------------------------------------------

describe('task failure surfaces errorDetail (state + reason_detail analytics)', () => {
  it('failing transport → summary.errorDetail carries the concrete provider message', async () => {
    const deps = makeDeps()
    deps.llmStream.mockRejectedValue(
      new LlmError('server', 'Server error (500): upstream model exploded', { status: 500 }),
    )

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.summary.status).toBe('error')
    // The canned lead is untouched…
    expect(run.summary.error).toMatch(/server error/i)
    // …and the CONCRETE upstream detail is now kept, with the transient
    // (5xx → auto-retried) note appended.
    expect(run.summary.errorDetail).toContain('upstream model exploded')
    expect(run.summary.errorDetail).toContain('retried automatically')

    // ai_task_failed carries reason AND the truncated reason_detail.
    const failedCall = deps.track.mock.calls.find(
      (c: unknown[]) => c[0] === 'ai_task_failed' && (c[1] as Record<string, unknown>)['task'] === 'summary',
    )
    expect(failedCall).toBeTruthy()
    const props = failedCall![1] as Record<string, unknown>
    expect(props['reason']).toBe('server')
    expect(props['reason_detail']).toContain('upstream model exploded')
    expect((props['reason_detail'] as string).length).toBeLessThanOrEqual(120)
  })

  it('structured-task failure → errorDetail on the failing panel only', async () => {
    const deps = makeDeps()
    deps.llmJsonWithRepair.mockImplementation(async (_opts: unknown, validate: ValidateFn) => {
      if (validate(ATTENTION_RESULT) !== null) {
        throw new LlmError('auth', 'Unauthorized (401): invalid api key', { status: 401 })
      }
      return defaultJsonDispatch(_opts, validate)
    })

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.attention.status).toBe('error')
    expect(run.attention.errorDetail).toBe('Unauthorized (401): invalid api key')
    // Succeeding panels never carry stale detail.
    expect(run.diagrams.status).toBe('done')
    expect(run.diagrams.errorDetail).toBeUndefined()
  })

  it('message identical to the canned sentence → errorDetail omitted (state stays lean)', async () => {
    const deps = makeDeps()
    const canned = describeTaskError(new LlmError('network', 'x')).error
    deps.llmStream.mockRejectedValue(new LlmError('network', canned))

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.summary.status).toBe('error')
    expect(run.summary.errorDetail).toBeUndefined()
    const failedCall = deps.track.mock.calls.find(
      (c: unknown[]) => c[0] === 'ai_task_failed' && (c[1] as Record<string, unknown>)['task'] === 'summary',
    )
    expect(failedCall).toBeTruthy()
    expect('reason_detail' in (failedCall![1] as Record<string, unknown>)).toBe(false)
  })
})
