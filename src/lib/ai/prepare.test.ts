/**
 * Tests for src/lib/ai/prepare.svelte.ts — Prepare-ahead headless pipeline.
 *
 * Covers:
 *  - happy path: enabled tasks execute, results cached under the route's keys,
 *    prepared record persisted, review_prepared tracked, ready row
 *  - task selection: aiTaskModes off stays off (no call, no cache entry)
 *  - keylessness: refuses before touching any loader
 *  - single-flight: a second prepare while one runs is refused ('busy')
 *  - cancel-on-navigate: pending LLM calls are blocked, in-flight ones still
 *    cache, the run's task analytics are muted, no record is written
 *  - progress: task K/N derived live from the run's panel states
 *  - error isolation: one failing task → calm error row, siblings cached;
 *    re-prepare re-runs ONLY the missing task (warm-cache resume)
 *  - consent: private repo without stored consent → 'declined' (headless
 *    ask never pops a dialog)
 *  - persistence: updatedAt-based invalidation + LRU bound
 *  - skills phase: reviewers run in prepare (with existing comments fetched)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  preparePr,
  cancelPrepare,
  preparePrId,
  prepareStore,
  prepareProgress,
  preparedRecord,
  isPreparedFor,
  markPrepared,
  PREPARED_LRU_MAX,
  _resetPrepareForTest,
} from './prepare.svelte'
import { LlmError } from '../llm/llm'
import type { PrMeta, PrFile } from '../github/types'
import type { CiSummary } from '../github/checks'
import type { ReviewProvider } from '../provider/types'
import type {
  AttentionResult,
  VerdictResult,
  GraphResult,
  TestInsight,
  AlternativesResult,
  StoryOrderResult,
  RiskJudgeResult,
  SkillReviewResult,
  ExpectedOutcomesResult,
} from './schemas'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HEAD_SHA = 'headsha123'
const BASE_SHA = 'basesha456'

const META: PrMeta = {
  title: 'Test PR',
  state: 'open',
  merged: false,
  // null body → the intent task SKIPS itself (zero tokens) — keeps the
  // default fixture at 9 executing auto tasks (summary + 8 JSON).
  body: null,
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
  private: false,
  changedFiles: 1,
  authorLogin: 'author',
}

const FILES: PrFile[] = [
  { filename: 'src/foo.ts', status: 'modified', patch: '@@ -1,2 +1,3 @@\n a\n+b\n c', additions: 1, deletions: 0 },
]

const CI: CiSummary = { total: 1, passed: 1, failed: 0, pending: 0, failures: [] }

const ATTENTION_RESULT: AttentionResult = {
  readingOrder: ['src/foo.ts'],
  hotspots: [{ path: 'src/foo.ts', reason: 'critical', level: 'high' }],
  testFlags: [],
}
const GRAPH_RESULT: GraphResult = {
  kind: 'flow',
  before: { nodes: [{ id: 'a', label: 'A' }], edges: [] },
  after: { nodes: [{ id: 'a', label: 'A' }], edges: [] },
}
const VERDICT_RESULT: VerdictResult = { level: 'minor-changes', evidence: [], notAnalyzed: [] }
const TEST_INSIGHT_RESULT: TestInsight = { covered: [], gaps: ['no tests'] }
const ALTERNATIVES_RESULT: AlternativesResult = {
  problem: 'A global cache without isolation.',
  alternatives: [],
}
// Steps must reference a REAL changed file — otherwise the run degrades to the
// deterministic fallback, which prepare honestly counts as "not warm".
const STORY_RESULT: StoryOrderResult = {
  steps: [{ index: 0, files: ['src/foo.ts'], caption: 'Foo changes.', layer: 'logic', relatedTests: [] }],
}
const RISK_JUDGE_RESULT: RiskJudgeResult = { score: 1, rationale: 'small', snippets: [] }
const OUTCOMES_RESULT: ExpectedOutcomesResult = {
  outcomes: [{ id: 'o1', before: 'b', after: 'a', evidence: [{ path: 'src/foo.ts' }], symbols: [] }],
  withoutThis: 'The change never lands.',
}
const SKILL_RESULT: SkillReviewResult = { skillName: 'Security reviewer', findings: [] }

type ValidateFn = (x: unknown) => unknown

/** Return the first fixture the task's validator accepts (run.test.ts idiom). */
function dispatchByValidator(validate: ValidateFn): unknown {
  for (const candidate of [
    STORY_RESULT,
    ATTENTION_RESULT,
    GRAPH_RESULT,
    TEST_INSIGHT_RESULT,
    ALTERNATIVES_RESULT,
    OUTCOMES_RESULT,
    SKILL_RESULT,
    VERDICT_RESULT,
    RISK_JUDGE_RESULT,
  ]) {
    if (validate(candidate) !== null) return candidate
  }
  throw new Error('no fixture matched the validator')
}

/** True when the validator is the risk-judge one (accepts only its shape). */
function isRiskJudgeValidator(validate: ValidateFn): boolean {
  return validate(RISK_JUDGE_RESULT) !== null && validate(ATTENTION_RESULT) === null
}

// ---------------------------------------------------------------------------
// Deps factory
// ---------------------------------------------------------------------------

function seedSettings(extra: Record<string, unknown> = {}): void {
  localStorage.setItem(
    'review123:settings',
    JSON.stringify({ deepseekKey: 'sk-test', ...extra }),
  )
}

function makeProvider(overrides: Partial<Record<string, unknown>> = {}): ReviewProvider {
  return {
    getPrMeta: vi.fn().mockResolvedValue(META),
    getPrFiles: vi.fn().mockResolvedValue(FILES),
    getCiSummary: vi.fn().mockResolvedValue(CI),
    getComments: vi.fn().mockResolvedValue([]),
    getFileAtRef: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as ReviewProvider
}

function makeDeps({ provider = makeProvider() }: { provider?: ReviewProvider } = {}) {
  // In-memory cache so warm-resume behavior is observable (jsdom has no IDB).
  const cache = new Map<string, unknown>()
  const getCached = vi.fn().mockImplementation(async (key: string) => cache.get(key) ?? null)
  const setCached = vi.fn().mockImplementation(async (key: string, value: unknown) => {
    cache.set(key, value)
  })

  const llmStream = vi.fn().mockImplementation(async (_o: unknown, onDelta: (d: string) => void) => {
    onDelta('summary text')
    return 'summary text'
  })
  const llmStreamWithUsage = vi.fn().mockImplementation(
    async (o: unknown, onDelta: (d: string) => void) => ({
      content: await llmStream(o, onDelta),
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }),
  )
  const llmJsonWithRepair = vi.fn().mockImplementation(
    async (_o: unknown, validate: ValidateFn) => dispatchByValidator(validate),
  )
  const llmJsonWithRepairWithUsage = vi.fn().mockImplementation(
    async (o: unknown, validate: ValidateFn) => ({
      result: await llmJsonWithRepair(o, validate),
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  )
  const aiTrack = vi.fn()
  const track = vi.fn()

  const fetchContents = vi.fn().mockResolvedValue(new Map())

  return {
    provider,
    cache,
    aiDeps: { getCached, setCached, llmStream, llmStreamWithUsage, llmJsonWithRepair, llmJsonWithRepairWithUsage, track: aiTrack },
    getCached,
    setCached,
    llmStream,
    llmStreamWithUsage,
    llmJsonWithRepair,
    llmJsonWithRepairWithUsage,
    aiTrack,
    track,
    fetchContents,
    asPrepareDeps() {
      return {
        provider: () => provider,
        fetchContents,
        aiDeps: this.aiDeps,
        track,
      }
    },
  }
}

const TARGET = { providerId: 'github', owner: 'o', repo: 'r', number: 1, updatedAt: '2026-08-01T00:00:00Z' }
const PR_ID = preparePrId('github', 'o', 'r', 1)
const PR_KEY_PREFIX = `github:o/r#1@${HEAD_SHA}|`

beforeEach(() => {
  localStorage.clear()
  _resetPrepareForTest()
  seedSettings({ aiTaskModes: { skills: 'off' } })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('preparePr — happy path', () => {
  it('executes the enabled auto tasks, caches under the route prKey, records prepared, tracks ready', async () => {
    const d = makeDeps()
    const result = await preparePr(TARGET, d.asPrepareDeps())

    expect(result).toEqual({ started: true, outcome: 'ready' })
    expect(prepareStore.rows[PR_ID]?.status).toBe('ready')
    expect(prepareStore.activeId).toBeNull()

    // Summary streamed once; the 8 JSON tasks each called once (intent skipped
    // on the null body; skills off).
    expect(d.llmStreamWithUsage).toHaveBeenCalledTimes(1)
    expect(d.llmJsonWithRepairWithUsage).toHaveBeenCalledTimes(8)

    // Every cached key carries the ROUTE's prKey (provider:owner/repo#n@head).
    const keys = [...d.cache.keys()]
    expect(keys.length).toBeGreaterThanOrEqual(8)
    for (const key of keys) expect(key.startsWith(PR_KEY_PREFIX)).toBe(true)
    expect(keys.some((k) => k.includes('|summary|'))).toBe(true)
    expect(keys.some((k) => k.includes('|verdict|'))).toBe(true)
    expect(keys.some((k) => k.includes('|story|'))).toBe(true)

    // Persistence: record carries head SHA + the queue row's updatedAt.
    const rec = preparedRecord(PR_ID)
    expect(rec).not.toBeNull()
    expect(rec!.headSha).toBe(HEAD_SHA)
    expect(rec!.updatedAt).toBe(TARGET.updatedAt)
    expect(rec!.tasksRun).toBe(9) // 8 JSON + summary
    expect(rec!.usage?.total_tokens).toBe(8 * 15 + 8)
    expect(isPreparedFor(PR_ID, TARGET.updatedAt)).toBe(true)

    // Analytics: one review_prepared with outcome/tasks_run/duration.
    expect(d.track).toHaveBeenCalledWith('review_prepared', {
      outcome: 'ready',
      tasks_run: 9,
      duration_ms: expect.any(Number),
    })
  })

  it('intent runs (and caches) when the PR body states a meaningful intent', async () => {
    const provider = makeProvider({
      getPrMeta: vi.fn().mockResolvedValue({ ...META, body: 'This PR adds a real feature with intent.' }),
    })
    const d = makeDeps({ provider })
    // The dispatcher has no IntentCheckResult fixture — give the stub one.
    d.llmJsonWithRepair.mockImplementation(async (_o: unknown, validate: ValidateFn) => {
      const intent = { intents: [{ id: 'i1', text: 'Add a feature' }], matched: [], unrequested: [], unfulfilled: [] }
      if (validate(intent) !== null) return intent
      return dispatchByValidator(validate)
    })

    const result = await preparePr(TARGET, d.asPrepareDeps())
    expect(result).toEqual({ started: true, outcome: 'ready' })
    expect([...d.cache.keys()].some((k) => k.includes('|intent:'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Task selection — off stays off
// ---------------------------------------------------------------------------

describe('preparePr — task modes', () => {
  it('never runs tasks the user turned off', async () => {
    seedSettings({ aiTaskModes: { skills: 'off', summary: 'off', alternatives: 'off' } })
    const d = makeDeps()
    const result = await preparePr(TARGET, d.asPrepareDeps())

    expect(result).toEqual({ started: true, outcome: 'ready' })
    expect(d.llmStreamWithUsage).not.toHaveBeenCalled() // summary off
    const keys = [...d.cache.keys()]
    expect(keys.some((k) => k.includes('|summary|'))).toBe(false)
    expect(keys.some((k) => k.includes('|alternatives|'))).toBe(false)
    expect(keys.some((k) => k.includes('|attention|'))).toBe(true) // still on
  })
})

// ---------------------------------------------------------------------------
// Keylessness + single-flight
// ---------------------------------------------------------------------------

describe('preparePr — gates', () => {
  it('refuses without an API key, before touching any loader', async () => {
    localStorage.removeItem('review123:settings')
    const d = makeDeps()
    const result = await preparePr(TARGET, d.asPrepareDeps())

    expect(result).toEqual({ started: false, reason: 'no-key' })
    expect(d.provider.getPrMeta).not.toHaveBeenCalled()
    expect(prepareStore.rows[PR_ID]).toBeUndefined()
  })

  it('single-flight: a second prepare while one runs is refused', async () => {
    const d = makeDeps()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    d.llmJsonWithRepair.mockImplementation(async (_o: unknown, validate: ValidateFn) => {
      await gate
      return dispatchByValidator(validate)
    })

    const first = preparePr(TARGET, d.asPrepareDeps())
    await Promise.resolve() // let the first prepare claim the slot
    const second = await preparePr({ ...TARGET, number: 2 }, d.asPrepareDeps())
    expect(second).toEqual({ started: false, reason: 'busy' })

    release()
    await expect(first).resolves.toEqual({ started: true, outcome: 'ready' })
  })
})

// ---------------------------------------------------------------------------
// Cancel-on-navigate
// ---------------------------------------------------------------------------

describe('preparePr — cancel-on-navigate', () => {
  it('cancel resets the row, blocks pending calls, still caches in-flight results, writes no record', async () => {
    const d = makeDeps()
    const releases: Array<() => void> = []
    d.llmJsonWithRepair.mockImplementation(async (_o: unknown, validate: ValidateFn) => {
      await new Promise<void>((resolve) => releases.push(resolve))
      return dispatchByValidator(validate)
    })
    d.llmStream.mockImplementation(async (_o: unknown, onDelta: (s: string) => void) => {
      await new Promise<void>((resolve) => releases.push(resolve))
      onDelta('late summary')
      return 'late summary'
    })

    const p = preparePr(TARGET, d.asPrepareDeps())
    // Wait until every task has DISPATCHED its (held) LLM call.
    await vi.waitFor(() => {
      expect(releases.length).toBe(9)
    })
    expect(prepareStore.rows[PR_ID]?.status).toBe('preparing')

    cancelPrepare(PR_ID)
    // The row returns to idle and the single-flight slot frees IMMEDIATELY.
    expect(prepareStore.rows[PR_ID]).toBeUndefined()
    expect(prepareStore.activeId).toBeNull()

    // In-flight calls complete and still warm the cache (results never wasted).
    for (const release of releases) release()
    const result = await p
    expect(result).toEqual({ started: true, outcome: 'cancelled' })
    expect([...d.cache.keys()].length).toBeGreaterThanOrEqual(8)

    // No prepared record, no ready row; the run's own task analytics are muted
    // post-cancel (a discarded run must not pollute the task metrics).
    expect(preparedRecord(PR_ID)).toBeNull()
    expect(d.aiTrack).not.toHaveBeenCalledWith('ai_task_completed', expect.anything())
    expect(d.track).toHaveBeenCalledWith('review_prepared', expect.objectContaining({ outcome: 'cancelled' }))
  })

  it('cancelPrepare for a different id is a no-op', async () => {
    const d = makeDeps()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    d.llmJsonWithRepair.mockImplementation(async (_o: unknown, validate: ValidateFn) => {
      await gate
      return dispatchByValidator(validate)
    })
    const p = preparePr(TARGET, d.asPrepareDeps())
    await Promise.resolve()
    cancelPrepare('github:someone/else#9')
    expect(prepareStore.activeId).toBe(PR_ID)
    release()
    await expect(p).resolves.toEqual({ started: true, outcome: 'ready' })
  })
})

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

describe('prepareProgress', () => {
  it('derives task K/N from the live run and advances as tasks settle', async () => {
    const d = makeDeps()
    const releases: Array<() => void> = []
    d.llmJsonWithRepair.mockImplementation(async (_o: unknown, validate: ValidateFn) => {
      await new Promise<void>((resolve) => releases.push(resolve))
      return dispatchByValidator(validate)
    })
    d.llmStream.mockImplementation(async (_o: unknown, onDelta: (s: string) => void) => {
      await new Promise<void>((resolve) => releases.push(resolve))
      onDelta('s')
      return 's'
    })

    const p = preparePr(TARGET, d.asPrepareDeps())
    await vi.waitFor(() => {
      expect(releases.length).toBe(9)
    })

    // 9 pending tasks + the skipped intent (settled at zero tokens) = 10 total.
    const before = prepareProgress(PR_ID)
    expect(before).toEqual({ done: 1, total: 10 })

    releases[0]()
    await vi.waitFor(() => {
      expect(prepareProgress(PR_ID)?.done).toBe(2)
    })

    for (const release of releases) release()
    await p
    expect(prepareProgress(PR_ID)).toBeNull() // settled rows report no progress
  })
})

// ---------------------------------------------------------------------------
// Error isolation + warm retry
// ---------------------------------------------------------------------------

describe('preparePr — error isolation', () => {
  it('one failing task → calm retryable error row; siblings cached; retry re-runs only the gap', async () => {
    const d = makeDeps()
    let failRiskJudge = true
    d.llmJsonWithRepair.mockImplementation(async (_o: unknown, validate: ValidateFn) => {
      if (failRiskJudge && isRiskJudgeValidator(validate)) {
        throw new LlmError('server', 'DeepSeek exploded (503)')
      }
      return dispatchByValidator(validate)
    })

    const first = await preparePr(TARGET, d.asPrepareDeps())
    expect(first).toEqual({ started: true, outcome: 'error' })
    const row = prepareStore.rows[PR_ID]
    expect(row?.status).toBe('error')
    expect(row?.error).toBe('1 of 9 AI tasks failed')
    expect(row?.errorDetail).toContain('DeepSeek exploded')
    // Failure never blocks anything: the siblings all cached (7 of 8 entries;
    // errors are never cached), and no prepared record was written.
    expect([...d.cache.keys()].length).toBeGreaterThanOrEqual(7)
    expect(preparedRecord(PR_ID)).toBeNull()
    expect(d.track).toHaveBeenCalledWith('review_prepared', expect.objectContaining({ outcome: 'error' }))

    // Retry: cached tasks resume warm — only the failed task re-hits the LLM.
    failRiskJudge = false
    const callsBefore = d.llmJsonWithRepairWithUsage.mock.calls.length
    const streamCallsBefore = d.llmStreamWithUsage.mock.calls.length
    const second = await preparePr(TARGET, d.asPrepareDeps())
    expect(second).toEqual({ started: true, outcome: 'ready' })
    expect(d.llmJsonWithRepairWithUsage.mock.calls.length - callsBefore).toBe(1)
    expect(d.llmStreamWithUsage.mock.calls.length - streamCallsBefore).toBe(0)
    expect(preparedRecord(PR_ID)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Consent (headless ask never pops a dialog)
// ---------------------------------------------------------------------------

describe('preparePr — consent', () => {
  it('private repo without stored consent → declined with an actionable row', async () => {
    const provider = makeProvider({
      getPrMeta: vi.fn().mockResolvedValue({ ...META, private: true }),
    })
    const d = makeDeps({ provider })
    // No gateAi override → the REAL consent gate runs; the prepare path's
    // headless ask denies, so the run declines without any dialog.
    const result = await preparePr(TARGET, d.asPrepareDeps())

    expect(result).toEqual({ started: true, outcome: 'declined' })
    expect(prepareStore.rows[PR_ID]?.status).toBe('error')
    expect(prepareStore.rows[PR_ID]?.error).toContain('consent')
    expect(d.llmJsonWithRepairWithUsage).not.toHaveBeenCalled()
    expect(preparedRecord(PR_ID)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Load failure
// ---------------------------------------------------------------------------

describe('preparePr — load failure', () => {
  it('a failing loader → calm error row with the concrete detail, never throws', async () => {
    const provider = makeProvider({
      getPrMeta: vi.fn().mockRejectedValue(new Error('rate limited by GitHub')),
    })
    const d = makeDeps({ provider })
    const result = await preparePr(TARGET, d.asPrepareDeps())

    expect(result).toEqual({ started: true, outcome: 'load-failed' })
    expect(prepareStore.rows[PR_ID]?.status).toBe('error')
    expect(prepareStore.rows[PR_ID]?.errorDetail).toContain('rate limited')
    expect(prepareStore.activeId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Persistence — invalidation + LRU
// ---------------------------------------------------------------------------

describe('prepared records', () => {
  it('invalidates when the queue row updatedAt moves (new commits included)', async () => {
    const d = makeDeps()
    await preparePr(TARGET, d.asPrepareDeps())
    expect(isPreparedFor(PR_ID, TARGET.updatedAt)).toBe(true)
    expect(isPreparedFor(PR_ID, '2026-08-02T00:00:00Z')).toBe(false)
  })

  it(`keeps at most ${PREPARED_LRU_MAX} records, evicting the oldest`, () => {
    for (let i = 0; i < PREPARED_LRU_MAX + 5; i++) {
      markPrepared(`github:o/r#${i}`, {
        headSha: `sha${i}`,
        updatedAt: 'u',
        preparedAt: 1000 + i,
        tasksRun: 1,
      })
    }
    // Oldest five evicted; newest kept.
    for (let i = 0; i < 5; i++) expect(preparedRecord(`github:o/r#${i}`)).toBeNull()
    expect(preparedRecord(`github:o/r#${PREPARED_LRU_MAX + 4}`)).not.toBeNull()
    const raw = JSON.parse(localStorage.getItem('review123:prepared-reviews')!) as Record<string, unknown>
    expect(Object.keys(raw).length).toBe(PREPARED_LRU_MAX)
  })

  it('survives corrupt storage (treated as empty, never throws)', () => {
    localStorage.setItem('review123:prepared-reviews', '{not json')
    expect(preparedRecord('github:o/r#1')).toBeNull()
    markPrepared('github:o/r#1', { headSha: 's', updatedAt: 'u', preparedAt: 1, tasksRun: 1 })
    expect(preparedRecord('github:o/r#1')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Skills phase
// ---------------------------------------------------------------------------

describe('preparePr — skill reviewers', () => {
  it('runs enabled reviewers (with existing comments fetched) and caches them', async () => {
    seedSettings() // skills mode default (on)
    localStorage.setItem(
      'review123:reviewer-skills',
      JSON.stringify([
        { id: 'sk1', name: 'Security reviewer', content: 'Check security.', enabled: true, addedAt: 1 },
        { id: 'sk2', name: 'Disabled reviewer', content: 'Off.', enabled: false, addedAt: 2 },
      ]),
    )
    const provider = makeProvider({
      getComments: vi.fn().mockResolvedValue([{ id: 1, body: 'existing comment' }]),
    })
    const d = makeDeps({ provider })

    const result = await preparePr(TARGET, d.asPrepareDeps())
    expect(result).toEqual({ started: true, outcome: 'ready' })
    // Comments were fetched as the reviewers' dedupe aid.
    expect(provider.getComments).toHaveBeenCalledTimes(1)
    // Exactly one ENABLED reviewer ran and cached under its content hash.
    expect([...d.cache.keys()].some((k) => k.includes('|skill:'))).toBe(true)
    expect(preparedRecord(PR_ID)?.tasksRun).toBe(10) // 9 auto + 1 reviewer
  })

  it('skills mode off → no reviewer phase, no comment fetch', async () => {
    localStorage.setItem(
      'review123:reviewer-skills',
      JSON.stringify([{ id: 'sk1', name: 'R', content: 'C.', enabled: true, addedAt: 1 }]),
    )
    const d = makeDeps()
    await preparePr(TARGET, d.asPrepareDeps())
    expect(d.provider.getComments).not.toHaveBeenCalled()
    expect([...d.cache.keys()].some((k) => k.includes('|skill:'))).toBe(false)
  })
})
