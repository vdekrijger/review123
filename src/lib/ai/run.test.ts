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
import { createAiRun } from './run.svelte'
import { LlmError } from '../llm/llm'
import type { PackedContext } from '../context/pack'
import type { CiSummary } from '../github/checks'
import type { AttentionResult, VerdictResult, GraphResult, TestInsight, CoachResult } from './schemas'

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

// ---------------------------------------------------------------------------
// Default llmJsonWithRepair implementation that dispatches by validator result
// Returns appropriate fixture based on which validator accepts the result.
// ---------------------------------------------------------------------------

type ValidateFn = (x: unknown) => unknown

function defaultJsonDispatch(_opts: unknown, validate: ValidateFn): unknown {
  // Try each fixture in order — return the first one the validator accepts
  for (const candidate of [ATTENTION_RESULT, GRAPH_RESULT, TEST_INSIGHT_RESULT, VERDICT_RESULT]) {
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

  const track = vi.fn()

  return { gateAi, getCached, setCached, llmStream, llmJsonWithRepair, track }
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

  it('all five tasks cache hit: no llm calls at all', async () => {
    const deps = makeDeps()
    deps.getCached.mockImplementation(async (key: string) => {
      if (key.includes('summary')) return 'cached summary'
      if (key.includes('attention')) return ATTENTION_RESULT
      if (key.includes('diagrams')) return GRAPH_RESULT
      if (key.includes('tests')) return TEST_INSIGHT_RESULT
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
    expect(completedCalls.length).toBe(5) // summary + attention + diagrams + tests + verdict

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
// coach() — on-demand, never cached, consent gating
// ---------------------------------------------------------------------------

import type { Draft } from '../drafts/drafts.svelte'

const DRAFT_FIXTURE: Draft[] = [
  { prKey: 'owner/repo#1@abc', path: 'src/foo.ts', line: 10, side: 'RIGHT', body: 'This is wrong.', updatedAt: 0 },
  { prKey: 'owner/repo#1@abc', path: 'src/bar.ts', line: 42, side: 'LEFT', body: 'Why not use a map?', updatedAt: 0 },
]

const COACH_RESULT: CoachResult = {
  reviews: [
    { index: 0, clarity: 3, actionable: false, tone: 'blunt', biasQuestion: 'Is this a preference or a defect?', suggestion: 'Consider renaming X to Y for clarity.' },
    { index: 1, clarity: 4, actionable: true, tone: 'ok', biasQuestion: null, suggestion: null },
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
    expect(result).toEqual(COACH_RESULT)
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
