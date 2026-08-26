/**
 * Expected-outcomes check — run.svelte.ts wiring tests.
 *
 * Covers:
 *   - mode off → 'disabled', no LLM call, no cache read for the task
 *   - default settings → the task is IN the auto set (runs on start())
 *   - run lands 'done' with the validated result, cached under
 *     "<pr>|outcomes:<djb2(title)>|v<N>", usage folded into totalUsage
 *   - cache hit → 'done' without an LLM call
 *   - a title edit → different cache key (invalidation by content hash)
 *   - absent meta → still runs (title '' — the diff alone is the input)
 *   - empty outcomes result → 'done' (legitimate pure-refactor state)
 *   - error path → 'error' + errorDetail via describeTaskError; nothing cached
 *   - retry('outcomes') re-runs the task
 *   - salvage path → a partially-malformed payload still lands 'done'
 *   - prepare-ahead inclusion → the task joins autoPanels' progress/tally set
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAiRun } from './run.svelte'
import { promptVersionFor } from './tasks'
import { cacheKey } from '../cache/aiCache'
import { djb2 } from '../viewed/viewed.svelte'
import { LlmError } from '../llm/llm'
import type { PackedContext } from '../context/pack'
import type { ExpectedOutcomesResult } from './schemas'

const PR_KEY = 'github:owner/repo#1@abc123'

const PACKED_CTX: PackedContext = {
  text: 'some PR context', notAnalyzed: [], includedFiles: ['src/foo.ts'], importGraph: '',
}

const OUTCOMES_RESULT: ExpectedOutcomesResult = {
  outcomes: [
    {
      id: 'o1',
      before: 'An off-diff comment failed the whole review.',
      after: 'It posts as a file-level comment.',
      evidence: [{ path: 'src/foo.ts', line: 3 }],
      symbols: ['postReview'],
    },
  ],
  withoutThis: 'Reviews with off-diff comments keep failing outright.',
}

const META = { title: 'fix: post off-diff comments at file level', body: 'Some description.' }

function seedSettings(extra: Record<string, unknown> = {}) {
  localStorage.setItem(
    'review123:settings',
    JSON.stringify({ deepseekKey: 'sk-test', aiProvider: 'deepseek', aiModel: 'deepseek-v4-flash', ...extra }),
  )
}

type ValidateFn = (x: unknown) => unknown

function makeDeps(outcomesPayload: unknown = OUTCOMES_RESULT) {
  // Validator-dispatch mock (intent-run idiom): every JSON task's call runs
  // its own validator over the candidate payloads; the outcomes task is the
  // only one whose validator accepts the outcomes payload, so per-task
  // isolation holds.
  const CANDIDATES: unknown[] = [
    outcomesPayload,
    { intents: [{ id: 'i1', text: 'A promise' }], matched: [], unrequested: [], unfulfilled: [] }, // intent
    { level: 'minor-changes', evidence: ['x'], notAnalyzed: [] }, // verdict
    { readingOrder: [], hotspots: [], testFlags: [] }, // attention
    { kind: 'flow', before: { nodes: [], edges: [] }, after: { nodes: [], edges: [] } }, // diagrams
    { covered: [], gaps: [] }, // tests
    { problem: 'p', alternatives: [] }, // alternatives
    { score: 1, rationale: 'Localized change.', snippets: [] }, // risk judge
  ]
  const llmJsonWithRepair = vi.fn().mockImplementation(async (_o: unknown, validate: ValidateFn) => {
    for (const c of CANDIDATES) {
      const v = validate(c)
      if (v !== null) return v
    }
    throw new LlmError('invalid-output', 'no candidate validated')
  })
  const llmJsonWithRepairWithUsage = vi.fn().mockImplementation(async (o: unknown, validate: ValidateFn) => ({
    result: await llmJsonWithRepair(o, validate),
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }))
  const llmStream = vi.fn().mockImplementation(async (_o: unknown, onDelta: (d: string) => void) => {
    onDelta('hi'); return 'hi'
  })
  const llmStreamWithUsage = vi.fn().mockImplementation(async (o: unknown, onDelta: (d: string) => void) => ({
    content: await llmStream(o, onDelta), usage: undefined,
  }))
  const pack = vi.fn().mockResolvedValue(PACKED_CTX)
  return {
    deps: {
      llmStream, llmStreamWithUsage, llmJsonWithRepair, llmJsonWithRepairWithUsage,
      llmJsonWithRepairFor: vi.fn(),
      llmToolLoop: vi.fn(),
      getCached: vi.fn().mockResolvedValue(null),
      setCached: vi.fn().mockResolvedValue(undefined),
      gateAi: vi.fn().mockResolvedValue(true),
      track: vi.fn(),
    },
    pack,
  }
}

function makeInput(
  pack: () => Promise<PackedContext>,
  meta?: { title: string; body: string | null },
): Parameters<typeof createAiRun>[0] {
  return {
    prKey: PR_KEY, repo: 'owner/repo', isPrivate: false,
    ...(meta ? { meta } : {}),
    pack, ci: async () => null, ask: async () => true,
  }
}

/** The outcomes prompts are the only ones carrying the dispatch phrase. */
function outcomesCalls(fn: ReturnType<typeof vi.fn>): unknown[][] {
  return fn.mock.calls.filter((c) => {
    const opts = c[0] as { system?: string }
    return typeof opts?.system === 'string' && opts.system.includes('deriving the observable behavior changes')
  })
}

beforeEach(() => localStorage.clear())

describe('outcomes task — mode gating', () => {
  it('off → disabled, no LLM call, no outcomes cache read', async () => {
    seedSettings({ aiTaskModes: { outcomes: 'off' } })
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, META), deps)
    await run.start()

    expect(run.outcomes.status).toBe('disabled')
    expect(outcomesCalls(deps.llmJsonWithRepairWithUsage)).toHaveLength(0)
    const keysRead = deps.getCached.mock.calls.map((c) => c[0] as string)
    expect(keysRead.some((k) => k.includes('|outcomes:'))).toBe(false)
    // Sibling tasks are unaffected.
    expect(run.verdict.status).toBe('done')
  })

  it('all-auto-off matrices (which derive outcomes off) leave the panel disabled with zero pack work', async () => {
    seedSettings({
      aiTaskModes: {
        summary: 'off', attention: 'off', diagrams: 'off',
        tests: 'off', alternatives: 'off', verdict: 'off',
      },
    })
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, META), deps)
    await run.start()
    expect(pack).not.toHaveBeenCalled()
    expect(run.outcomes.status).toBe('disabled')
  })

  it('no-key sweep marks outcomes no-key like its siblings (off still wins)', async () => {
    localStorage.setItem('review123:settings', JSON.stringify({}))
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, META), deps)
    await run.start()
    expect(run.outcomes.status).toBe('no-key')

    localStorage.setItem('review123:settings', JSON.stringify({ aiTaskModes: { outcomes: 'off' } }))
    const second = makeDeps()
    const run2 = createAiRun(makeInput(second.pack, META), second.deps)
    await run2.start()
    expect(run2.outcomes.status).toBe('disabled')
  })
})

describe('outcomes task — run, cache, and usage', () => {
  const KEY = cacheKey(PR_KEY, 'outcomes:' + djb2(META.title), promptVersionFor('outcomes'))

  it('default settings → the task is in the auto set and lands done with the validated result', async () => {
    seedSettings()
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, META), deps)
    await run.start()

    expect(run.outcomes.status).toBe('done')
    expect(run.outcomes.value).toEqual(OUTCOMES_RESULT)
    expect(outcomesCalls(deps.llmJsonWithRepairWithUsage)).toHaveLength(1)
    // Never the deep harness, never the ensemble — the active model, single pass.
    expect(deps.llmToolLoop).not.toHaveBeenCalled()
  })

  it('caches the result under the title content-hash key with the outcomes prompt version', async () => {
    seedSettings()
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, META), deps)
    await run.start()

    const write = deps.setCached.mock.calls.find((c) => (c[0] as string).includes('|outcomes:'))
    expect(write).toBeDefined()
    expect(write![0]).toBe(KEY)
    expect(write![1]).toEqual(OUTCOMES_RESULT)
  })

  it('a title edit changes the cache key (content-hash invalidation)', async () => {
    seedSettings()
    const edited = { ...META, title: `${META.title} (rebased)` }
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, edited), deps)
    await run.start()

    const write = deps.setCached.mock.calls.find((c) => (c[0] as string).includes('|outcomes:'))
    expect(write).toBeDefined()
    expect(write![0]).not.toBe(KEY)
    expect(write![0]).toBe(cacheKey(PR_KEY, 'outcomes:' + djb2(edited.title), promptVersionFor('outcomes')))
  })

  it('absent meta (older callers) still runs — the diff alone is a full input (title "")', async () => {
    seedSettings()
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, undefined), deps)
    await run.start()

    expect(run.outcomes.status).toBe('done')
    const write = deps.setCached.mock.calls.find((c) => (c[0] as string).includes('|outcomes:'))
    expect(write![0]).toBe(cacheKey(PR_KEY, 'outcomes:' + djb2(''), promptVersionFor('outcomes')))
  })

  it('cache hit → done with the cached value, no LLM call', async () => {
    seedSettings()
    const { deps, pack } = makeDeps()
    deps.getCached.mockImplementation(async (key: string) =>
      key === KEY ? OUTCOMES_RESULT : null,
    )
    const run = createAiRun(makeInput(pack, META), deps)
    await run.start()

    expect(run.outcomes.status).toBe('done')
    expect(run.outcomes.value).toEqual(OUTCOMES_RESULT)
    expect(outcomesCalls(deps.llmJsonWithRepairWithUsage)).toHaveLength(0)
  })

  it('an EMPTY outcomes result lands done (legitimate pure-refactor state, not an error)', async () => {
    seedSettings()
    const empty: ExpectedOutcomesResult = { outcomes: [], withoutThis: 'Nothing user-visible changes.' }
    const { deps, pack } = makeDeps(empty)
    const run = createAiRun(makeInput(pack, META), deps)
    await run.start()

    expect(run.outcomes.status).toBe('done')
    expect(run.outcomes.value).toEqual(empty)
  })

  it('captured usage lands on the panel state and folds into totalUsage', async () => {
    seedSettings({ aiTaskModes: {
      summary: 'off', attention: 'off', diagrams: 'off', tests: 'off',
      alternatives: 'off', verdict: 'off', story: 'off', riskJudge: 'off',
      intent: 'off',
      outcomes: 'standard',
    } })
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, META), deps)
    await run.start()

    expect(run.outcomes.status).toBe('done')
    expect(run.outcomes.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
    // Every other task is off → the run total IS the outcomes task's usage.
    expect(run.totalUsage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
  })

  it('error path → error state with the canned lead + concrete errorDetail; nothing cached', async () => {
    seedSettings()
    const { deps, pack } = makeDeps()
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (o: { system?: string }, validate: ValidateFn) => {
      if (o.system?.includes('deriving the observable behavior changes')) {
        throw new LlmError('server', 'HTTP 500: upstream exploded')
      }
      // Siblings keep succeeding so isolation is visible.
      for (const c of [{ intents: [], matched: [], unrequested: [], unfulfilled: [] }, { level: 'minor-changes', evidence: [], notAnalyzed: [] }, { readingOrder: [], hotspots: [], testFlags: [] }, { kind: 'flow', before: { nodes: [], edges: [] }, after: { nodes: [], edges: [] } }, { covered: [], gaps: [] }, { problem: 'p', alternatives: [] }, { score: 1, rationale: 'r', snippets: [] }]) {
        const v = validate(c)
        if (v !== null) return { result: v, usage: undefined }
      }
      throw new LlmError('invalid-output', 'no candidate')
    })
    const run = createAiRun(makeInput(pack, META), deps)
    await run.start()

    expect(run.outcomes.status).toBe('error')
    expect(run.outcomes.error).toContain('server error')
    expect(run.outcomes.errorDetail).toContain('upstream exploded')
    const keysWritten = deps.setCached.mock.calls.map((c) => c[0] as string)
    expect(keysWritten.some((k) => k.includes('|outcomes:'))).toBe(false)
    // Sibling tasks unaffected.
    expect(run.verdict.status).toBe('done')
  })

  it('retry("outcomes") re-runs the task through the same path after an error', async () => {
    seedSettings()
    const { deps, pack } = makeDeps()
    let fail = true
    const original = deps.llmJsonWithRepairWithUsage.getMockImplementation()!
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (o: { system?: string }, validate: ValidateFn) => {
      if (fail && o.system?.includes('deriving the observable behavior changes')) {
        throw new LlmError('server', 'boom')
      }
      return original(o, validate)
    })
    const run = createAiRun(makeInput(pack, META), deps)
    await run.start()
    expect(run.outcomes.status).toBe('error')

    fail = false
    await run.retry('outcomes')
    expect(run.outcomes.status).toBe('done')
    expect(run.outcomes.value).toEqual(OUTCOMES_RESULT)
  })

  it('salvage path: a partially-malformed payload (bad elements) still lands done with the salvaged shape', async () => {
    seedSettings()
    const partiallyBroken = {
      outcomes: [
        {
          id: 'o1',
          before: 'The endpoint returned 500 on empty input.',
          after: 'It returns 422 with a field error.',
          evidence: [{ path: 'src/foo.ts' }, 'junk'],
          symbols: ['validateInput', 42],
        },
        { id: 'o2', before: 'only half a claim' }, // malformed — dropped
      ],
      // withoutThis missing entirely → salvages to ''
    }
    const { deps, pack } = makeDeps(partiallyBroken)
    const run = createAiRun(makeInput(pack, META), deps)
    await run.start()

    expect(run.outcomes.status).toBe('done')
    expect(run.outcomes.value).toEqual({
      outcomes: [{
        id: 'o1',
        before: 'The endpoint returned 500 on empty input.',
        after: 'It returns 422 with a field error.',
        evidence: [{ path: 'src/foo.ts' }],
        symbols: ['validateInput'],
      }],
      withoutThis: '',
    })
  })
})

describe('outcomes task — prepare-ahead inclusion', () => {
  it('the run exposes outcomes among the auto panels prepare-ahead watches', async () => {
    // prepare.svelte.ts derives progress + the warm-cache tally from the run's
    // auto panel states. The contract it relies on: run.outcomes EXISTS and
    // settles like its siblings. (prepare.test.ts covers the pipeline; this
    // guards the run-side contract.)
    seedSettings()
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, META), deps)
    expect(run.outcomes.status).toBe('idle')
    await run.start()
    expect(['done', 'error']).toContain(run.outcomes.status)
    expect(run.outcomes.status).toBe('done')
  })
})
