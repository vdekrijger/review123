/**
 * Deep-review harness-depth tests (Plan G — harness depth) at the run.svelte
 * orchestration layer:
 *
 *   1. Shared per-review fetch cache: two deep tasks in ONE review that read the
 *      same file → ONE underlying provider fetch (cross-task reuse). Scoped per
 *      run/PR (a separate createAiRun has its own cache → re-fetches).
 *   2. Completeness nudge: a deep finalize with ZERO tool calls that still makes
 *      a code-dependent claim → ONE nudge (a second loop pass). A trivial change
 *      (≤1 file) → no nudge. The nudge fires at most once.
 *
 * The default-injected llmToolLoop is mocked, but the toolkit's executeTool IS
 * the real one (created inside runDeepJson with the real shared cache), so a
 * mock loop that calls opts.executeTool exercises the genuine cache + budget.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAiRun } from './run.svelte'
import type { PackedContext } from '../context/pack'
import type { VerdictResult } from './schemas'
import type { DeepReviewSource } from './deepReview'

const PR_KEY = 'github:owner/repo#1@abc123'

// Two changed files → "non-trivial" for the completeness guard.
const PACKED_CTX: PackedContext = {
  text: 'some PR context',
  notAnalyzed: [],
  includedFiles: ['src/foo.ts', 'src/bar.ts'],
  importGraph: '',
}

const VERDICT_RESULT: VerdictResult = {
  level: 'minor-changes',
  evidence: ['src/foo.ts changed behavior'],
  notAnalyzed: [],
}

function seedSettings(extra: Record<string, unknown> = {}) {
  localStorage.setItem(
    'review123:settings',
    JSON.stringify({
      deepseekKey: 'sk-test',
      aiProvider: 'deepseek',
      aiModel: 'deepseek-v4-flash',
      // Only the verdict runs deep; keep the other tasks out of the way so the
      // cache/nudge assertions are about the verdict alone.
      aiTaskModes: { verdict: 'deep', summary: 'off', attention: 'off', diagrams: 'off', tests: 'off', alternatives: 'off', story: 'off', skills: 'off' },
      ...extra,
    }),
  )
}

function baseDeps(loopImpl: (opts: LoopOpts) => Promise<LoopResult>) {
  return {
    llmStream: vi.fn(),
    llmStreamWithUsage: vi.fn().mockResolvedValue({ content: '', usage: undefined }),
    llmJsonWithRepair: vi.fn().mockResolvedValue(VERDICT_RESULT),
    llmJsonWithRepairWithUsage: vi.fn().mockResolvedValue({ result: VERDICT_RESULT, usage: undefined }),
    llmJsonWithRepairFor: vi.fn(),
    llmToolLoop: vi.fn().mockImplementation(loopImpl),
    getCached: vi.fn().mockResolvedValue(null),
    setCached: vi.fn().mockResolvedValue(undefined),
    gateAi: vi.fn().mockResolvedValue(true),
    track: vi.fn(),
  }
}

interface LoopOpts {
  executeTool: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; content: string }>
  user: string
}
interface LoopResult {
  content: string
  usage: undefined
  toolCallsUsed: number
}

function makeInput(deepReview: DeepReviewSource): Parameters<typeof createAiRun>[0] {
  return {
    prKey: PR_KEY,
    repo: 'owner/repo',
    isPrivate: false,
    pack: async () => PACKED_CTX,
    ci: async () => null,
    ask: async () => true,
    deepReview,
  }
}

beforeEach(() => {
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// 1. Shared per-review fetch cache
// ---------------------------------------------------------------------------

describe('shared per-review fetch cache (run layer)', () => {
  it('two deep tasks reading the same file → ONE underlying provider fetch', async () => {
    seedSettings({
      // Run TWO deep tasks (verdict + tests) so they can share the cache.
      aiTaskModes: { verdict: 'deep', tests: 'deep', summary: 'off', attention: 'off', diagrams: 'off', alternatives: 'off', story: 'off', skills: 'off' },
    })
    const getFileAtHead = vi.fn().mockResolvedValue('file contents')
    const source: DeepReviewSource = { getFileAtHead, getFileAtBase: vi.fn().mockResolvedValue('base') }

    // Each deep task's loop reads the SAME file then returns a valid answer.
    // verdict validates against VERDICT_RESULT; tests validates against a
    // TestInsight — return per-task valid JSON keyed off the user prompt.
    const deps = baseDeps(async (opts: LoopOpts) => {
      await opts.executeTool('read_file', { path: 'src/foo.ts' })
      const isTests = /test/i.test(opts.user)
      const content = isTests
        ? JSON.stringify({ gaps: [], covered: [] })
        : JSON.stringify(VERDICT_RESULT)
      return { content, usage: undefined, toolCallsUsed: 1 }
    })

    const run = createAiRun(makeInput(source), deps)
    await run.start()

    // Both tasks ran their loops, but the underlying file was fetched once.
    expect(deps.llmToolLoop.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(getFileAtHead).toHaveBeenCalledTimes(1)
  })

  it('cache is scoped per run/PR — a separate createAiRun re-fetches (no cross-PR reuse)', async () => {
    seedSettings()
    const getFileAtHead = vi.fn().mockResolvedValue('file contents')
    const source: DeepReviewSource = { getFileAtHead, getFileAtBase: vi.fn().mockResolvedValue('base') }
    const loopImpl = async (opts: LoopOpts): Promise<LoopResult> => {
      await opts.executeTool('read_file', { path: 'src/foo.ts' })
      return { content: JSON.stringify(VERDICT_RESULT), usage: undefined, toolCallsUsed: 1 }
    }

    await createAiRun(makeInput(source), baseDeps(loopImpl)).start()
    expect(getFileAtHead).toHaveBeenCalledTimes(1)

    // A brand-new run (models a different PR / re-open) has its OWN cache.
    await createAiRun(makeInput(source), baseDeps(loopImpl)).start()
    expect(getFileAtHead).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// 2. Completeness nudge (anti-lazy-loop)
// ---------------------------------------------------------------------------

describe('completeness nudge (anti-lazy-loop)', () => {
  it('zero tool calls + a code-dependent claim on a non-trivial change → ONE nudge', async () => {
    seedSettings()
    const source: DeepReviewSource = {
      getFileAtHead: vi.fn().mockResolvedValue('contents'),
      getFileAtBase: vi.fn().mockResolvedValue('base'),
    }
    let nudgedCalls = 0
    const deps = baseDeps(async (opts: LoopOpts) => {
      if (/WITHOUT using any verification tools/.test(opts.user)) nudgedCalls++
      // Always finalize with zero tool calls + an evidence-bearing verdict.
      return { content: JSON.stringify(VERDICT_RESULT), usage: undefined, toolCallsUsed: 0 }
    })

    const run = createAiRun(makeInput(source), deps)
    await run.start()

    // Exactly one re-run carrying the nudge — fires at most once.
    expect(nudgedCalls).toBe(1)
    // The verdict loop ran twice total (initial + nudged).
    const verdictRuns = deps.llmToolLoop.mock.calls.filter((c: unknown[]) =>
      /behavior-preserved/.test((c[0] as { system: string }).system),
    )
    expect(verdictRuns).toHaveLength(2)
    expect(run.verdict.status).toBe('done')
  })

  it('a trivial change (single file) → NO nudge', async () => {
    seedSettings()
    const source: DeepReviewSource = {
      getFileAtHead: vi.fn().mockResolvedValue('contents'),
      getFileAtBase: vi.fn().mockResolvedValue('base'),
    }
    let nudgedCalls = 0
    const deps = baseDeps(async (opts: LoopOpts) => {
      if (/WITHOUT using any verification tools/.test(opts.user)) nudgedCalls++
      return { content: JSON.stringify(VERDICT_RESULT), usage: undefined, toolCallsUsed: 0 }
    })

    // Single changed file → trivial → guard does not fire.
    const trivialCtx: PackedContext = { ...PACKED_CTX, includedFiles: ['src/foo.ts'] }
    const run = createAiRun({ ...makeInput(source), pack: async () => trivialCtx }, deps)
    await run.start()

    expect(nudgedCalls).toBe(0)
    const verdictRuns = deps.llmToolLoop.mock.calls.filter((c: unknown[]) =>
      /behavior-preserved/.test((c[0] as { system: string }).system),
    )
    expect(verdictRuns).toHaveLength(1)
  })

  it('used a tool already → NO nudge even on a code claim', async () => {
    seedSettings()
    const source: DeepReviewSource = {
      getFileAtHead: vi.fn().mockResolvedValue('contents'),
      getFileAtBase: vi.fn().mockResolvedValue('base'),
    }
    let nudgedCalls = 0
    const deps = baseDeps(async (opts: LoopOpts) => {
      if (/WITHOUT using any verification tools/.test(opts.user)) nudgedCalls++
      // toolCallsUsed > 0 → the lazy pattern is already broken; no nudge.
      return { content: JSON.stringify(VERDICT_RESULT), usage: undefined, toolCallsUsed: 2 }
    })

    const run = createAiRun(makeInput(source), deps)
    await run.start()

    expect(nudgedCalls).toBe(0)
    expect(run.verdict.toolCallsUsed).toBe(2)
  })

  it('zero tool calls but NO code claim (empty evidence) → NO nudge', async () => {
    seedSettings()
    const source: DeepReviewSource = {
      getFileAtHead: vi.fn().mockResolvedValue('contents'),
      getFileAtBase: vi.fn().mockResolvedValue('base'),
    }
    let nudgedCalls = 0
    const cleanVerdict: VerdictResult = { level: 'behavior-preserved', evidence: [], notAnalyzed: [] }
    const deps = baseDeps(async (opts: LoopOpts) => {
      if (/WITHOUT using any verification tools/.test(opts.user)) nudgedCalls++
      return { content: JSON.stringify(cleanVerdict), usage: undefined, toolCallsUsed: 0 }
    })

    const run = createAiRun(makeInput(source), deps)
    await run.start()

    // A clean "nothing to flag" answer is not a code-dependent claim → no nudge.
    expect(nudgedCalls).toBe(0)
  })
})
