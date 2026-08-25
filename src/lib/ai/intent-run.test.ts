/**
 * Intent-vs-implementation check — run.svelte.ts wiring tests.
 *
 * Covers:
 *   - mode off → 'disabled', no LLM call, no cache read for the task
 *   - skip-when-empty → distinct 'skipped' state, ZERO llm/cache activity
 *     (null body, blank body, checklist-noise-only body, absent meta)
 *   - meaningful body → single-pass run, result cached under
 *     "<pr>|intent:<djb2(title\nbody)>|v<N>", usage folded into totalUsage
 *   - cache hit → 'done' without an LLM call
 *   - a description edit → different cache key (invalidation by content hash)
 *   - error path → 'error' + errorDetail via describeTaskError
 *   - salvage path → a partially-malformed payload still lands 'done'
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAiRun } from './run.svelte'
import { promptVersionFor } from './tasks'
import { cacheKey } from '../cache/aiCache'
import { djb2 } from '../viewed/viewed.svelte'
import { LlmError } from '../llm/llm'
import type { PackedContext } from '../context/pack'
import type { IntentCheckResult } from './schemas'

const PR_KEY = 'github:owner/repo#1@abc123'

const PACKED_CTX: PackedContext = {
  text: 'some PR context', notAnalyzed: [], includedFiles: ['src/foo.ts'], importGraph: '',
}

const INTENT_RESULT: IntentCheckResult = {
  intents: [{ id: 'i1', text: 'Add a rate limiter' }],
  matched: [{ intentId: 'i1', evidence: [{ path: 'src/foo.ts', line: 3 }], note: 'Limiter added.' }],
  unrequested: [],
  unfulfilled: [],
}

const MEANINGFUL_BODY = 'Adds a token-bucket rate limiter to the API client.'

function seedSettings(extra: Record<string, unknown> = {}) {
  localStorage.setItem(
    'review123:settings',
    JSON.stringify({ deepseekKey: 'sk-test', aiProvider: 'deepseek', aiModel: 'deepseek-v4-flash', ...extra }),
  )
}

type ValidateFn = (x: unknown) => unknown

function makeDeps(intentPayload: unknown = INTENT_RESULT) {
  // Validator-dispatch mock (taskModes-run idiom): every JSON task's call runs
  // its own validator over the candidate payloads; the intent task is the only
  // one whose validator accepts INTENT_PAYLOAD, so per-task isolation holds.
  const CANDIDATES: unknown[] = [
    intentPayload,
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

/** The intent prompts are the only ones whose user text carries the description heading. */
function intentCalls(fn: ReturnType<typeof vi.fn>): unknown[][] {
  return fn.mock.calls.filter((c) => {
    const opts = c[0] as { system?: string }
    return typeof opts?.system === 'string' && opts.system.includes('checking the implementation against the stated intent')
  })
}

beforeEach(() => localStorage.clear())

describe('intent task — mode gating', () => {
  it('off → disabled, no LLM call, no intent cache read', async () => {
    seedSettings({ aiTaskModes: { intent: 'off' } })
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, { title: 't', body: MEANINGFUL_BODY }), deps)
    await run.start()

    expect(run.intent.status).toBe('disabled')
    expect(intentCalls(deps.llmJsonWithRepairWithUsage)).toHaveLength(0)
    const keysRead = deps.getCached.mock.calls.map((c) => c[0] as string)
    expect(keysRead.some((k) => k.includes('|intent:'))).toBe(false)
    // Sibling tasks are unaffected.
    expect(run.verdict.status).toBe('done')
  })

  it('all-auto-off matrices (which derive intent off) leave the panel disabled with zero pack work', async () => {
    seedSettings({
      aiTaskModes: {
        summary: 'off', attention: 'off', diagrams: 'off',
        tests: 'off', alternatives: 'off', verdict: 'off',
      },
    })
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, { title: 't', body: MEANINGFUL_BODY }), deps)
    await run.start()
    expect(pack).not.toHaveBeenCalled()
    expect(run.intent.status).toBe('disabled')
  })

  it('no-key sweep marks intent no-key like its siblings (off still wins)', async () => {
    localStorage.setItem('review123:settings', JSON.stringify({}))
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, { title: 't', body: MEANINGFUL_BODY }), deps)
    await run.start()
    expect(run.intent.status).toBe('no-key')

    localStorage.setItem('review123:settings', JSON.stringify({ aiTaskModes: { intent: 'off' } }))
    const second = makeDeps()
    const run2 = createAiRun(makeInput(second.pack, { title: 't', body: MEANINGFUL_BODY }), second.deps)
    await run2.start()
    expect(run2.intent.status).toBe('disabled')
  })
})

describe('intent task — skip-when-empty (zero tokens)', () => {
  async function expectSkipped(meta?: { title: string; body: string | null }) {
    seedSettings()
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, meta), deps)
    await run.start()
    expect(run.intent.status).toBe('skipped')
    // ZERO intent activity: no LLM call, no cache read, no cache write.
    expect(intentCalls(deps.llmJsonWithRepairWithUsage)).toHaveLength(0)
    const keysRead = deps.getCached.mock.calls.map((c) => c[0] as string)
    expect(keysRead.some((k) => k.includes('|intent:'))).toBe(false)
    const keysWritten = deps.setCached.mock.calls.map((c) => c[0] as string)
    expect(keysWritten.some((k) => k.includes('|intent:'))).toBe(false)
    return run
  }

  it('null body → skipped', async () => {
    await expectSkipped({ title: 'feat: x', body: null })
  })

  it('blank body → skipped', async () => {
    await expectSkipped({ title: 'feat: x', body: '   \n  ' })
  })

  it('checklist/template-noise-only body → skipped', async () => {
    await expectSkipped({
      title: 'feat: x',
      body: '<!-- describe the change and its motivation here please -->\n- [ ] Tests\n- [x] Lint',
    })
  })

  it('absent meta (older callers) → skipped, never an error', async () => {
    await expectSkipped(undefined)
  })

  it('skipped intent contributes nothing to totalUsage', async () => {
    const run = await expectSkipped({ title: 'feat: x', body: null })
    // Only the other tasks' usage is in the total — intent added nothing.
    expect(run.intent.usage).toBeUndefined()
  })
})

describe('intent task — run, cache, and usage', () => {
  const META = { title: 'feat: add rate limiting', body: MEANINGFUL_BODY }
  const KEY = cacheKey(PR_KEY, 'intent:' + djb2(`${META.title}\n${META.body}`), promptVersionFor('intent'))

  it('meaningful body → single-pass run lands done with the validated result', async () => {
    seedSettings()
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, META), deps)
    await run.start()

    expect(run.intent.status).toBe('done')
    expect(run.intent.value).toEqual(INTENT_RESULT)
    expect(intentCalls(deps.llmJsonWithRepairWithUsage)).toHaveLength(1)
    // Never the deep harness, never the ensemble — the active model, single pass.
    expect(deps.llmToolLoop).not.toHaveBeenCalled()
  })

  it('caches the result under the title+body content-hash key with the intent prompt version', async () => {
    seedSettings()
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, META), deps)
    await run.start()

    const write = deps.setCached.mock.calls.find((c) => (c[0] as string).includes('|intent:'))
    expect(write).toBeDefined()
    expect(write![0]).toBe(KEY)
    expect(write![1]).toEqual(INTENT_RESULT)
  })

  it('a description edit changes the cache key (content-hash invalidation)', async () => {
    seedSettings()
    const edited = { ...META, body: `${META.body} Also adds retry with backoff.` }
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, edited), deps)
    await run.start()

    const write = deps.setCached.mock.calls.find((c) => (c[0] as string).includes('|intent:'))
    expect(write).toBeDefined()
    expect(write![0]).not.toBe(KEY)
    expect(write![0]).toBe(cacheKey(PR_KEY, 'intent:' + djb2(`${edited.title}\n${edited.body}`), promptVersionFor('intent')))
  })

  it('cache hit → done with the cached value, no LLM call', async () => {
    seedSettings()
    const { deps, pack } = makeDeps()
    deps.getCached.mockImplementation(async (key: string) =>
      key === KEY ? INTENT_RESULT : null,
    )
    const run = createAiRun(makeInput(pack, META), deps)
    await run.start()

    expect(run.intent.status).toBe('done')
    expect(run.intent.value).toEqual(INTENT_RESULT)
    expect(intentCalls(deps.llmJsonWithRepairWithUsage)).toHaveLength(0)
  })

  it('captured usage lands on the panel state and folds into totalUsage', async () => {
    seedSettings({ aiTaskModes: {
      summary: 'off', attention: 'off', diagrams: 'off', tests: 'off',
      alternatives: 'off', verdict: 'off', story: 'off', riskJudge: 'off',
      intent: 'standard',
    } })
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, META), deps)
    await run.start()

    expect(run.intent.status).toBe('done')
    expect(run.intent.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
    // Every other task is off → the run total IS the intent task's usage.
    expect(run.totalUsage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
  })

  it('error path → error state with the canned lead + concrete errorDetail; nothing cached', async () => {
    seedSettings()
    const { deps, pack } = makeDeps()
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (o: { system?: string }, validate: ValidateFn) => {
      if (o.system?.includes('checking the implementation against the stated intent')) {
        throw new LlmError('server', 'HTTP 500: upstream exploded')
      }
      // Siblings keep succeeding so isolation is visible.
      for (const c of [{ level: 'minor-changes', evidence: [], notAnalyzed: [] }, { readingOrder: [], hotspots: [], testFlags: [] }, { kind: 'flow', before: { nodes: [], edges: [] }, after: { nodes: [], edges: [] } }, { covered: [], gaps: [] }, { problem: 'p', alternatives: [] }, { score: 1, rationale: 'r', snippets: [] }]) {
        const v = validate(c)
        if (v !== null) return { result: v, usage: undefined }
      }
      throw new LlmError('invalid-output', 'no candidate')
    })
    const run = createAiRun(makeInput(pack, META), deps)
    await run.start()

    expect(run.intent.status).toBe('error')
    expect(run.intent.error).toContain('server error')
    expect(run.intent.errorDetail).toContain('upstream exploded')
    const keysWritten = deps.setCached.mock.calls.map((c) => c[0] as string)
    expect(keysWritten.some((k) => k.includes('|intent:'))).toBe(false)
    // Sibling tasks unaffected.
    expect(run.verdict.status).toBe('done')
  })

  it('retry("intent") re-runs the task through the same path after an error', async () => {
    seedSettings()
    const { deps, pack } = makeDeps()
    let fail = true
    const original = deps.llmJsonWithRepairWithUsage.getMockImplementation()!
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (o: { system?: string }, validate: ValidateFn) => {
      if (fail && o.system?.includes('checking the implementation against the stated intent')) {
        throw new LlmError('server', 'boom')
      }
      return original(o, validate)
    })
    const run = createAiRun(makeInput(pack, META), deps)
    await run.start()
    expect(run.intent.status).toBe('error')

    fail = false
    await run.retry('intent')
    expect(run.intent.status).toBe('done')
    expect(run.intent.value).toEqual(INTENT_RESULT)
  })

  it('salvage path: a partially-malformed payload (bad elements) still lands done with the salvaged shape', async () => {
    seedSettings()
    const partiallyBroken = {
      intents: [
        { id: 'i1', text: 'Add a rate limiter' },
        { id: 'i2' }, // malformed — dropped by the salvage
      ],
      matched: [
        { intentId: 'i1', evidence: [{ path: 'src/foo.ts' }, 'junk'], note: 'Limiter added.' },
        { intentId: 'i-unknown', evidence: [], note: 'unknown ref — dropped' },
      ],
      unrequested: [{ description: 'Extra churn', paths: ['a.ts'], significance: 'catastrophic' }],
      // unfulfilled missing entirely → salvages to []
    }
    const { deps, pack } = makeDeps(partiallyBroken)
    const run = createAiRun(makeInput(pack, META), deps)
    await run.start()

    expect(run.intent.status).toBe('done')
    expect(run.intent.value).toEqual({
      intents: [{ id: 'i1', text: 'Add a rate limiter' }],
      matched: [{ intentId: 'i1', evidence: [{ path: 'src/foo.ts' }], note: 'Limiter added.' }],
      unrequested: [{ description: 'Extra churn', paths: ['a.ts'], significance: 'minor' }],
      unfulfilled: [],
    })
  })
})
