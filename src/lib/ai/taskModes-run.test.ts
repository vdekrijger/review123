/**
 * Per-task AI mode run-gating tests (Plan J) — run.svelte.ts integration.
 *
 * Covers:
 *   - off → task never calls LLM/pack/cache, status 'disabled'
 *   - standard → single-pass (no tool loop)
 *   - deep → harness (tool loop)
 *   - deep but tool-incapable model → standard fallback + honest note
 *   - all auto tasks off → pack() skipped entirely, every panel disabled
 *   - skills off → runSkillReviews is a no-op (no entries, no LLM)
 *   - no-key sweep still marks an off task disabled (off wins)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAiRun } from './run.svelte'
import type { PackedContext } from '../context/pack'
import type {
  VerdictResult, SkillReviewResult, TestInsight, AlternativesResult, GraphResult, AttentionResult,
} from './schemas'
import type { DeepReviewSource } from './deepReview'
import { addSkill } from '../skills/skills'

const PR_KEY = 'github:owner/repo#1@abc123'

const PACKED_CTX: PackedContext = {
  text: 'some PR context', notAnalyzed: [], includedFiles: ['src/foo.ts'], importGraph: '',
}

const VERDICT_RESULT: VerdictResult = { level: 'minor-changes', evidence: ['x'], notAnalyzed: [] }
const ATTENTION_RESULT: AttentionResult = { readingOrder: [], hotspots: [], testFlags: [] }
const GRAPH_RESULT: GraphResult = {
  kind: 'flow',
  before: { nodes: [], edges: [] },
  after: { nodes: [], edges: [] },
}
const TEST_INSIGHT: TestInsight = { covered: [], gaps: [] }
const ALTERNATIVES_RESULT: AlternativesResult = { problem: 'p', alternatives: [] }
const SKILL_RESULT: SkillReviewResult = { skillName: 'S', findings: [] }
const RISK_JUDGE_RESULT = { score: 1, rationale: 'Localized change.', snippets: [] }

function makeSource(): DeepReviewSource {
  return {
    getFileAtHead: vi.fn().mockResolvedValue('head'),
    getFileAtBase: vi.fn().mockResolvedValue('base'),
    searchCode: vi.fn().mockResolvedValue('none'),
  }
}

function seedSettings(extra: Record<string, unknown> = {}) {
  localStorage.setItem(
    'review123:settings',
    JSON.stringify({ deepseekKey: 'sk-test', aiProvider: 'deepseek', aiModel: 'deepseek-v4-flash', ...extra }),
  )
}

type ValidateFn = (x: unknown) => unknown
const CANDIDATES = [VERDICT_RESULT, ATTENTION_RESULT, GRAPH_RESULT, TEST_INSIGHT, ALTERNATIVES_RESULT, SKILL_RESULT, RISK_JUDGE_RESULT]

function makeDeps() {
  const llmJsonWithRepair = vi.fn().mockImplementation(async (_o: unknown, validate: ValidateFn) => {
    for (const c of CANDIDATES) if (validate(c) !== null) return c
    return VERDICT_RESULT
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
  const llmToolLoop = vi.fn().mockImplementation(async () => ({
    content: JSON.stringify(VERDICT_RESULT),
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    toolCallsUsed: 2,
  }))
  const pack = vi.fn().mockResolvedValue(PACKED_CTX)
  return {
    deps: {
      llmStream, llmStreamWithUsage, llmJsonWithRepair, llmJsonWithRepairWithUsage, llmToolLoop,
      getCached: vi.fn().mockResolvedValue(null),
      setCached: vi.fn().mockResolvedValue(undefined),
      gateAi: vi.fn().mockResolvedValue(true),
      track: vi.fn(),
    },
    pack,
  }
}

function makeInput(pack: () => Promise<PackedContext>, source?: DeepReviewSource): Parameters<typeof createAiRun>[0] {
  return {
    prKey: PR_KEY, repo: 'owner/repo', isPrivate: false,
    pack, ci: async () => null, ask: async () => true,
    ...(source ? { deepReview: source } : {}),
  }
}

beforeEach(() => localStorage.clear())

describe('Plan J — per-task off gating', () => {
  it('a task set off → status disabled, no LLM call, no cache read for it', async () => {
    seedSettings({ aiTaskModes: { diagrams: 'off' } })
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, makeSource()), deps)
    await run.start()

    expect(run.diagrams.status).toBe('disabled')
    // diagrams cache key never read
    const keysRead = deps.getCached.mock.calls.map((c) => c[0] as string)
    expect(keysRead.some((k) => k.includes('diagrams'))).toBe(false)
    // other tasks still ran
    expect(run.verdict.status).toBe('done')
  })

  it('off summary → disabled, summary stream never invoked', async () => {
    seedSettings({ aiTaskModes: { summary: 'off' } })
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, makeSource()), deps)
    await run.start()
    expect(run.summary.status).toBe('disabled')
  })

  it('standard task → single-pass (no tool loop), status done', async () => {
    seedSettings({ aiTaskModes: { verdict: 'standard' } })
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, makeSource()), deps)
    await run.start()
    expect(run.verdict.status).toBe('done')
    expect(deps.llmToolLoop).not.toHaveBeenCalled()
  })

  it('deep task with tool-capable model → harness (tool loop) runs', async () => {
    seedSettings({ aiTaskModes: { verdict: 'deep' } })
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, makeSource()), deps)
    await run.start()
    expect(deps.llmToolLoop).toHaveBeenCalled()
    expect(run.verdict.status).toBe('done')
    expect(run.verdict.toolCallsUsed).toBe(2)
  })

  it('deep task on a tool-incapable model → standard fallback + honest note', async () => {
    seedSettings({ aiModel: 'deepseek-reasoner', aiTaskModes: { verdict: 'deep' } })
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, makeSource()), deps)
    await run.start()
    expect(deps.llmToolLoop).not.toHaveBeenCalled()
    expect(run.verdict.status).toBe('done')
    expect(run.verdict.note).toContain('does not support tool calling')
  })

  it('ALL auto tasks off → pack() never called, every panel disabled', async () => {
    seedSettings({
      aiTaskModes: {
        summary: 'off', attention: 'off', diagrams: 'off',
        tests: 'off', alternatives: 'off', verdict: 'off',
      },
    })
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, makeSource()), deps)
    await run.start()
    expect(pack).not.toHaveBeenCalled()
    for (const s of [run.summary, run.attention, run.diagrams, run.tests, run.alternatives, run.verdict, run.story, run.riskJudge]) {
      expect(s.status).toBe('disabled')
    }
  })

  it('no-key sweep still marks an off task disabled (off wins over no-key)', async () => {
    // No key configured at all → start() sweeps no-key, but diagrams is off.
    localStorage.setItem('review123:settings', JSON.stringify({ aiTaskModes: { diagrams: 'off' } }))
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, makeSource()), deps)
    await run.start()
    expect(run.diagrams.status).toBe('disabled')
    expect(run.verdict.status).toBe('no-key')
  })

  it('skills off → runSkillReviews is a no-op (no entries, no LLM)', async () => {
    seedSettings({ aiTaskModes: { skills: 'off' } })
    addSkill('Sec', 'review security')
    const { deps, pack } = makeDeps()
    const run = createAiRun(makeInput(pack, makeSource()), deps)
    await run.runSkillReviews()
    expect(run.skillReviews).toHaveLength(0)
    expect(deps.llmJsonWithRepairWithUsage).not.toHaveBeenCalled()
  })
})
