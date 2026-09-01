/**
 * cancellation.test.ts — a DELIBERATE cancellation is not a failure.
 *
 * The user-visible bug: an aborted request surfaced as a red panel error with a
 * Retry button and the browser's "The user aborted a request." text, and fired
 * ai_task_failed. Nobody aborted anything.
 *
 * The contract pinned here:
 *   - LlmError('aborted')  → PanelStatus 'cancelled': calm, no error copy, no
 *                            errorDetail, NO ai_task_failed analytics.
 *   - LlmError('timeout')  → still an error, with HONEST timeout copy that
 *                            names the remedy (retry / faster model).
 *   - LlmError('network')  → unchanged error path (regression guard).
 *   - prepare's cancel-on-navigate sentinel is a cancellation, not a failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAiRun, describeTaskError, isCancellation, humanMessage } from './run.svelte'
import {
  preparePr,
  cancelPrepare,
  preparePrId,
  prepareStore,
  preparedRecord,
  _resetPrepareForTest,
} from './prepare.svelte'
import { LlmError, CANCELLED_MESSAGE } from '../llm/llm'
import type { PackedContext } from '../context/pack'
import type { CiSummary } from '../github/checks'
import type { PrMeta, PrFile } from '../github/types'
import type { ReviewProvider } from '../provider/types'
import type { AttentionResult, VerdictResult, GraphResult, TestInsight, AlternativesResult, StoryOrderResult, RiskJudgeResult, ExpectedOutcomesResult } from './schemas'

// ---------------------------------------------------------------------------
// Run-level fixtures (run.test.ts idiom)
// ---------------------------------------------------------------------------

const PACKED_CTX: PackedContext = {
  text: 'some PR context',
  notAnalyzed: [],
  includedFiles: ['src/foo.ts'],
}
const CI_SUMMARY: CiSummary = { total: 1, passed: 1, failed: 0, pending: 0, failures: [] }
const ATTENTION_RESULT: AttentionResult = {
  readingOrder: ['src/foo.ts'],
  hotspots: [],
  testFlags: [],
}
const GRAPH_RESULT: GraphResult = {
  kind: 'flow',
  before: { nodes: [{ id: 'a', label: 'A' }], edges: [] },
  after: { nodes: [{ id: 'a', label: 'A' }], edges: [] },
}
const VERDICT_RESULT: VerdictResult = { level: 'minor-changes', evidence: [], notAnalyzed: [] }
const TEST_INSIGHT_RESULT: TestInsight = { covered: [], gaps: [] }
const ALTERNATIVES_RESULT: AlternativesResult = { problem: 'p', alternatives: [] }
const STORY_RESULT: StoryOrderResult = {
  steps: [{ index: 0, files: ['src/foo.ts'], caption: 'Foo.', layer: 'logic', relatedTests: [] }],
}
const RISK_JUDGE_RESULT: RiskJudgeResult = { score: 1, rationale: 'small', snippets: [] }
const OUTCOMES_RESULT: ExpectedOutcomesResult = {
  outcomes: [{ id: 'o1', before: 'b', after: 'a', evidence: [{ path: 'src/foo.ts' }], symbols: [] }],
  withoutThis: 'nothing',
}

type ValidateFn = (x: unknown) => unknown

function dispatchByValidator(validate: ValidateFn): unknown {
  for (const candidate of [STORY_RESULT, ATTENTION_RESULT, GRAPH_RESULT, TEST_INSIGHT_RESULT, ALTERNATIVES_RESULT, OUTCOMES_RESULT, VERDICT_RESULT, RISK_JUDGE_RESULT]) {
    if (validate(candidate) !== null) return candidate
  }
  return ATTENTION_RESULT
}

function makeRunDeps() {
  localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test' }))
  const llmStream = vi.fn().mockImplementation(async (_o: unknown, onDelta: (d: string) => void) => {
    onDelta('hello')
    return 'hello'
  })
  const llmJsonWithRepair = vi.fn().mockImplementation(
    async (_o: unknown, validate: ValidateFn) => dispatchByValidator(validate),
  )
  const llmStreamWithUsage = vi.fn().mockImplementation(
    async (o: unknown, onDelta: (d: string) => void) => ({ content: await llmStream(o, onDelta) }),
  )
  const llmJsonWithRepairWithUsage = vi.fn().mockImplementation(
    async (o: unknown, validate: ValidateFn) => ({ result: await llmJsonWithRepair(o, validate) }),
  )
  return {
    gateAi: vi.fn().mockResolvedValue(true),
    getCached: vi.fn().mockResolvedValue(null),
    setCached: vi.fn().mockResolvedValue(undefined),
    llmStream,
    llmStreamWithUsage,
    llmJsonWithRepair,
    llmJsonWithRepairWithUsage,
    track: vi.fn(),
  }
}

function makeRunInput(): Parameters<typeof createAiRun>[0] {
  return {
    prKey: 'owner/repo#1@abc123',
    repo: 'owner/repo',
    isPrivate: false,
    pack: async () => PACKED_CTX,
    ci: async () => CI_SUMMARY as CiSummary | null,
    ask: async () => true,
  }
}

function failedEvents(track: ReturnType<typeof vi.fn>): unknown[][] {
  return track.mock.calls.filter((c: unknown[]) => c[0] === 'ai_task_failed')
}

beforeEach(() => {
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// isCancellation
// ---------------------------------------------------------------------------

describe('isCancellation', () => {
  it("is true for LlmError('aborted')", () => {
    expect(isCancellation(new LlmError('aborted', CANCELLED_MESSAGE))).toBe(true)
  })

  it('is false for every other LlmError kind', () => {
    for (const kind of ['network', 'timeout', 'auth', 'server', 'rate-limited', 'invalid-output', 'no-key'] as const) {
      expect(isCancellation(new LlmError(kind, 'x'))).toBe(false)
    }
  })

  it('is false for a plain Error and for non-errors', () => {
    expect(isCancellation(new Error('boom'))).toBe(false)
    expect(isCancellation('boom')).toBe(false)
    expect(isCancellation(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A cancelled task lands in a CALM state — never the red error state
// ---------------------------------------------------------------------------

describe('a cancelled task is not a failure', () => {
  it("streaming task: LlmError('aborted') → status 'cancelled', no error copy, no ai_task_failed", async () => {
    const deps = makeRunDeps()
    deps.llmStream.mockRejectedValue(new LlmError('aborted', CANCELLED_MESSAGE))
    deps.llmStreamWithUsage.mockRejectedValue(new LlmError('aborted', CANCELLED_MESSAGE))
    const run = createAiRun(makeRunInput(), deps)
    await run.start()

    expect(run.summary.status).toBe('cancelled')
    expect(run.summary.error).toBeUndefined()
    expect(run.summary.errorDetail).toBeUndefined()
    expect(
      failedEvents(deps.track).filter((c) => (c[1] as Record<string, unknown>).task === 'summary'),
    ).toHaveLength(0)
  })

  it("JSON task: LlmError('aborted') → status 'cancelled', no ai_task_failed", async () => {
    const deps = makeRunDeps()
    deps.llmJsonWithRepair.mockRejectedValue(new LlmError('aborted', CANCELLED_MESSAGE))
    deps.llmJsonWithRepairWithUsage.mockRejectedValue(new LlmError('aborted', CANCELLED_MESSAGE))
    const run = createAiRun(makeRunInput(), deps)
    await run.start()

    expect(run.attention.status).toBe('cancelled')
    expect(run.attention.error).toBeUndefined()
    expect(failedEvents(deps.track)).toHaveLength(0)
  })

  it('a cancelled task re-runs normally on retry (cancellation is not sticky)', async () => {
    const deps = makeRunDeps()
    deps.llmJsonWithRepairWithUsage.mockRejectedValueOnce(new LlmError('aborted', CANCELLED_MESSAGE))
    const run = createAiRun(makeRunInput(), deps)
    await run.start()
    expect(run.attention.status).toBe('cancelled')

    await run.retry('attention')
    expect(run.attention.status).toBe('done')
    expect(run.attention.error).toBeUndefined()
  })

  it('the cancelled task is NOT cached (a cancellation must never poison the cache)', async () => {
    const deps = makeRunDeps()
    deps.llmJsonWithRepair.mockRejectedValue(new LlmError('aborted', CANCELLED_MESSAGE))
    deps.llmJsonWithRepairWithUsage.mockRejectedValue(new LlmError('aborted', CANCELLED_MESSAGE))
    const run = createAiRun(makeRunInput(), deps)
    await run.start()
    const attentionWrites = deps.setCached.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('|attention|'),
    )
    expect(attentionWrites).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// A genuine timeout says so plainly; a genuine network failure is unchanged
// ---------------------------------------------------------------------------

describe('genuine failures keep the error state — with honest copy', () => {
  it("LlmError('timeout') → error state whose copy names the remedy", async () => {
    const deps = makeRunDeps()
    deps.llmJsonWithRepair.mockRejectedValue(new LlmError('timeout'))
    deps.llmJsonWithRepairWithUsage.mockRejectedValue(new LlmError('timeout'))
    const run = createAiRun(makeRunInput(), deps)
    await run.start()

    expect(run.attention.status).toBe('error')
    expect(run.attention.error).toMatch(/took too long/i)
    expect(run.attention.error).toMatch(/faster model/i)
    expect(failedEvents(deps.track).some((c) => (c[1] as Record<string, unknown>).reason === 'timeout')).toBe(true)
  })

  it('the timeout sentence never mentions the network', () => {
    expect(humanMessage('timeout')).not.toMatch(/connection|network/i)
  })

  it("LlmError('network') → unchanged error state + ai_task_failed", async () => {
    const deps = makeRunDeps()
    deps.llmJsonWithRepair.mockRejectedValue(new LlmError('network', 'Failed to fetch'))
    deps.llmJsonWithRepairWithUsage.mockRejectedValue(new LlmError('network', 'Failed to fetch'))
    const run = createAiRun(makeRunInput(), deps)
    await run.start()

    expect(run.attention.status).toBe('error')
    expect(run.attention.error).toMatch(/network error/i)
    expect(run.attention.errorDetail).toBe('Failed to fetch')
    expect(failedEvents(deps.track).some((c) => (c[1] as Record<string, unknown>).reason === 'network')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// describeTaskError — the cancelled kind carries no user-blaming text
// ---------------------------------------------------------------------------

describe('describeTaskError — aborted', () => {
  it('never surfaces the browser\'s "user aborted" wording', () => {
    const info = describeTaskError(new LlmError('aborted', CANCELLED_MESSAGE))
    expect(info.kind).toBe('aborted')
    expect(`${info.error} ${info.errorDetail ?? ''}`).not.toMatch(/user aborted/i)
  })

  it('adds no errorDetail beyond the canned cancellation sentence', () => {
    const info = describeTaskError(new LlmError('aborted', CANCELLED_MESSAGE))
    expect(info.errorDetail).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// prepare cancel-on-navigate: opening the PR mid-prepare shows NO error
// ---------------------------------------------------------------------------

const HEAD_SHA = 'headsha123'
const META: PrMeta = {
  title: 'Test PR',
  state: 'open',
  merged: false,
  body: null,
  baseSha: 'basesha456',
  headSha: HEAD_SHA,
  private: false,
  changedFiles: 1,
  authorLogin: 'author',
}
const FILES: PrFile[] = [
  { filename: 'src/foo.ts', status: 'modified', patch: '@@ -1,2 +1,3 @@\n a\n+b\n c', additions: 1, deletions: 0 },
]
const TARGET = { providerId: 'github', owner: 'o', repo: 'r', number: 1, updatedAt: '2026-08-01T00:00:00Z' }
const PR_ID = preparePrId('github', 'o', 'r', 1)

describe('prepare cancel-on-navigate — nothing renders as an error', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetPrepareForTest()
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ deepseekKey: 'sk-test', aiTaskModes: { skills: 'off' } }),
    )
  })

  it('cancelling BEFORE the calls dispatch leaves no error row and fires no ai_task_failed', async () => {
    const provider = {
      getPrMeta: vi.fn().mockResolvedValue(META),
      getPrFiles: vi.fn().mockResolvedValue(FILES),
      getCiSummary: vi.fn().mockResolvedValue(null),
      getComments: vi.fn().mockResolvedValue([]),
      getFileAtRef: vi.fn().mockResolvedValue(null),
    } as unknown as ReviewProvider

    const aiTrack = vi.fn()
    const track = vi.fn()
    // The pack gate: hold the run until we have cancelled, so EVERY task hits
    // the cancelGuard's pre-dispatch throw (the sentinel) rather than a real call.
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const p = preparePr(TARGET, {
      provider: () => provider,
      fetchContents: vi.fn().mockImplementation(async () => {
        await gate
        return new Map()
      }),
      aiDeps: {
        getCached: vi.fn().mockResolvedValue(null),
        setCached: vi.fn().mockResolvedValue(undefined),
        llmStream: vi.fn().mockResolvedValue('x'),
        llmStreamWithUsage: vi.fn().mockResolvedValue({ content: 'x' }),
        llmJsonWithRepair: vi.fn().mockImplementation(async (_o: unknown, v: ValidateFn) => dispatchByValidator(v)),
        llmJsonWithRepairWithUsage: vi.fn().mockImplementation(async (_o: unknown, v: ValidateFn) => ({ result: dispatchByValidator(v) })),
        track: aiTrack,
      },
      track,
    })

    await vi.waitFor(() => {
      expect(prepareStore.rows[PR_ID]?.status).toBe('preparing')
    })
    cancelPrepare(PR_ID)
    release()

    const result = await p
    expect(result).toEqual({ started: true, outcome: 'cancelled' })
    // No row at all — certainly not an error row.
    expect(prepareStore.rows[PR_ID]).toBeUndefined()
    expect(preparedRecord(PR_ID)).toBeNull()
    // The discarded run must not pollute the failure metrics.
    expect(failedEvents(aiTrack)).toHaveLength(0)
  })
})
