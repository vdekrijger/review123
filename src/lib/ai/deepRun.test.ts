/**
 * Deep-review orchestration tests (Plan G part 2) — run.svelte.ts integration.
 *
 * Covers:
 *   - toggle OFF → llmToolLoop never called, cache keys unchanged (byte-identical)
 *   - deep verdict: '|deep' cache key, loop invoked with toolkit tools, result
 *     cached as a wrapper carrying toolCallsUsed, activity lines populate
 *   - deep cache hit unwraps result + toolCallsUsed
 *   - model without tool support → single-pass fallback + honest note
 *   - loop failure → error state, partial NEVER cached
 *   - invalid loop JSON → one single-pass repair, result still cached
 *   - deep skill reviews: marker key + per-entry toolCallsUsed
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAiRun } from './run.svelte'
import { PROMPT_VERSION } from './tasks'
import { LlmError } from '../llm/llm'
import { addSkill } from '../skills/skills'
import { djb2 } from '../viewed/viewed.svelte'
import type { PackedContext } from '../context/pack'
import type { VerdictResult, SkillReviewResult } from './schemas'
import type { DeepReviewSource } from './deepReview'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PR_KEY = 'github:owner/repo#1@abc123'

const PACKED_CTX: PackedContext = {
  text: 'some PR context',
  notAnalyzed: [],
  includedFiles: ['src/foo.ts'],
  importGraph: '',
}

const VERDICT_RESULT: VerdictResult = {
  level: 'minor-changes',
  evidence: ['src/foo.ts changed'],
  notAnalyzed: [],
}

const SKILL_RESULT: SkillReviewResult = {
  skillName: 'Security Reviewer',
  findings: [{ path: 'src/foo.ts', line: 2, severity: 'high', body: 'verified issue' }],
}

function makeSource(): DeepReviewSource {
  return {
    getFileAtHead: vi.fn().mockResolvedValue('head contents'),
    getFileAtBase: vi.fn().mockResolvedValue('base contents'),
    searchCode: vi.fn().mockResolvedValue('no matches'),
  }
}

function seedSettings(extra: Record<string, unknown> = {}) {
  localStorage.setItem(
    'review123:settings',
    JSON.stringify({ deepseekKey: 'sk-test', aiProvider: 'deepseek', aiModel: 'deepseek-v4-flash', ...extra }),
  )
}

type ValidateFn = (x: unknown) => unknown

function makeDeps() {
  const llmJsonWithRepair = vi.fn().mockImplementation(async (_opts: unknown, validate: ValidateFn) => {
    for (const candidate of [VERDICT_RESULT, SKILL_RESULT]) {
      if (validate(candidate) !== null) return candidate
    }
    return VERDICT_RESULT
  })
  const llmJsonWithRepairWithUsage = vi.fn().mockImplementation(async (opts: unknown, validate: ValidateFn) => ({
    result: await llmJsonWithRepair(opts, validate),
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }))
  const llmStream = vi.fn().mockImplementation(async (_o: unknown, onDelta: (d: string) => void) => {
    onDelta('hi')
    return 'hi'
  })
  const llmStreamWithUsage = vi.fn().mockImplementation(async (opts: unknown, onDelta: (d: string) => void) => ({
    content: await llmStream(opts, onDelta),
    usage: undefined,
  }))
  // Deep loop default: emits two tool events then returns a valid verdict.
  const llmToolLoop = vi.fn().mockImplementation(
    async (opts: { onToolEvent?: (ev: { name: string; detail: string }) => void }) => {
      opts.onToolEvent?.({ name: 'read_file', detail: 'Reading src/foo.ts…' })
      opts.onToolEvent?.({ name: 'search_code', detail: 'Searching: createPrLoad…' })
      return {
        content: JSON.stringify(VERDICT_RESULT),
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        toolCallsUsed: 2,
      }
    },
  )
  return {
    llmStream,
    llmStreamWithUsage,
    llmJsonWithRepair,
    llmJsonWithRepairWithUsage,
    llmToolLoop,
    getCached: vi.fn().mockResolvedValue(null),
    setCached: vi.fn().mockResolvedValue(undefined),
    gateAi: vi.fn().mockResolvedValue(true),
    track: vi.fn(),
  }
}

function makeInput(deepReview?: DeepReviewSource): Parameters<typeof createAiRun>[0] {
  return {
    prKey: PR_KEY,
    repo: 'owner/repo',
    isPrivate: false,
    pack: async () => PACKED_CTX,
    ci: async () => null,
    ask: async () => true,
    ...(deepReview ? { deepReview } : {}),
  }
}

beforeEach(() => {
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// Toggle OFF — byte-identical behavior
// ---------------------------------------------------------------------------

describe('deep review toggle OFF (default)', () => {
  it('never calls llmToolLoop and uses the unchanged verdict cache key', async () => {
    seedSettings() // aiDeepReview absent → defaults false
    const deps = makeDeps()
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    expect(deps.llmToolLoop).not.toHaveBeenCalled()
    expect(deps.getCached).toHaveBeenCalledWith(`${PR_KEY}|verdict|v${PROMPT_VERSION}`)
    expect(run.verdict.status).toBe('done')
    expect(run.verdict.toolCallsUsed).toBeUndefined()
    expect(run.verdict.note).toBeUndefined()
  })

  it('toggle on but NO source wired → still single-pass, silently', async () => {
    seedSettings({ aiDeepReview: true })
    const deps = makeDeps()
    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(deps.llmToolLoop).not.toHaveBeenCalled()
    expect(run.verdict.status).toBe('done')
    expect(run.verdict.note).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Deep verdict
// ---------------------------------------------------------------------------

describe('deep verdict task', () => {
  it('runs the tool loop, uses the |deep cache key, and caches a wrapper with toolCallsUsed', async () => {
    seedSettings({ aiDeepReview: true })
    const deps = makeDeps()
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    expect(deps.llmToolLoop).toHaveBeenCalledTimes(1)
    const loopOpts = deps.llmToolLoop.mock.calls[0][0]
    // Toolkit tools passed through (source has searchCode → all 3)
    expect(loopOpts.tools.map((t: { name: string }) => t.name)).toEqual([
      'read_file',
      'read_file_at_base',
      'search_code',
    ])
    // Deep guidance composed onto the verdict system prompt
    expect(loopOpts.system).toContain('Deep review mode')
    expect(loopOpts.system).toContain('respond with JSON ONLY')
    expect(loopOpts.maxToolCalls).toBe(8)

    const deepKey = `${PR_KEY}|verdict|deep|v${PROMPT_VERSION}`
    expect(deps.getCached).toHaveBeenCalledWith(deepKey)
    expect(deps.setCached).toHaveBeenCalledWith(deepKey, {
      deep: true,
      result: VERDICT_RESULT,
      toolCallsUsed: 2,
    })

    expect(run.verdict.status).toBe('done')
    expect(run.verdict.value).toEqual(VERDICT_RESULT)
    expect(run.verdict.toolCallsUsed).toBe(2)
    // Activity cleared once done
    expect(run.verdict.activity).toBeUndefined()

    // Token events keep working: summed loop usage lands in tokens + tool_calls
    const completed = deps.track.mock.calls.find(
      (c: unknown[]) => c[0] === 'ai_task_completed' && (c[1] as { task: string }).task === 'verdict',
    )!
    expect(completed[1]).toMatchObject({ tokens: 150, deep: true, tool_calls: 2, cached: false })
  })

  it('surfaces tool activity lines while the loop runs', async () => {
    seedSettings({ aiDeepReview: true })
    const deps = makeDeps()
    let activityDuringRun: string[] = []
    deps.llmToolLoop.mockImplementation(
      async (opts: { onToolEvent?: (ev: { name: string; detail: string }) => void }) => {
        opts.onToolEvent?.({ name: 'read_file', detail: 'Reading src/foo.ts…' })
        activityDuringRun = [...(run.verdict.activity ?? [])]
        return { content: JSON.stringify(VERDICT_RESULT), usage: undefined, toolCallsUsed: 1 }
      },
    )
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    expect(activityDuringRun).toEqual(['Reading src/foo.ts…'])
  })

  it('unwraps a deep cache hit: result + toolCallsUsed, no loop call', async () => {
    seedSettings({ aiDeepReview: true })
    const deps = makeDeps()
    deps.getCached.mockImplementation(async (key: string) =>
      key === `${PR_KEY}|verdict|deep|v${PROMPT_VERSION}`
        ? { deep: true, result: VERDICT_RESULT, toolCallsUsed: 5 }
        : null,
    )
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    expect(deps.llmToolLoop).not.toHaveBeenCalled()
    expect(run.verdict.status).toBe('done')
    expect(run.verdict.value).toEqual(VERDICT_RESULT)
    expect(run.verdict.toolCallsUsed).toBe(5)
  })

  it('falls back to single-pass WITH a note when the model lacks tool support', async () => {
    seedSettings({ aiDeepReview: true, aiModel: 'deepseek-reasoner' })
    const deps = makeDeps()
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    expect(deps.llmToolLoop).not.toHaveBeenCalled()
    expect(deps.llmJsonWithRepairWithUsage).toHaveBeenCalled()
    // Single-pass key (no |deep marker) — same cache as a normal run
    expect(deps.getCached).toHaveBeenCalledWith(`${PR_KEY}|verdict|v${PROMPT_VERSION}`)
    expect(run.verdict.status).toBe('done')
    expect(run.verdict.note).toContain('does not support tool calling')
  })

  it('loop failure → error state with retry, partial NEVER cached', async () => {
    seedSettings({ aiDeepReview: true })
    const deps = makeDeps()
    deps.llmToolLoop.mockRejectedValue(new LlmError('rate-limited'))
    deps.llmJsonWithRepairWithUsage.mockRejectedValue(new LlmError('rate-limited'))
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    expect(run.verdict.status).toBe('error')
    expect(run.verdict.activity).toBeUndefined()
    const verdictWrites = deps.setCached.mock.calls.filter((c: unknown[]) => String(c[0]).includes('verdict'))
    expect(verdictWrites).toHaveLength(0)
  })

  it('invalid loop JSON → single-pass repair grounded in the loop output, then cached', async () => {
    seedSettings({ aiDeepReview: true })
    const deps = makeDeps()
    deps.llmToolLoop.mockResolvedValue({
      content: 'Here is my verdict: minor changes (not JSON)',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      toolCallsUsed: 3,
    })
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    // Repair call carries the loop's verified output for reformatting
    const repairCall = deps.llmJsonWithRepairWithUsage.mock.calls.find((c: unknown[]) =>
      (c[0] as { user: string }).user.includes('Here is my verdict'),
    )
    expect(repairCall).toBeDefined()
    expect(run.verdict.status).toBe('done')
    expect(run.verdict.toolCallsUsed).toBe(3)
    expect(deps.setCached).toHaveBeenCalledWith(`${PR_KEY}|verdict|deep|v${PROMPT_VERSION}`, {
      deep: true,
      result: VERDICT_RESULT,
      toolCallsUsed: 3,
    })
  })
})

// ---------------------------------------------------------------------------
// Deep skill reviews
// ---------------------------------------------------------------------------

describe('deep skill reviews', () => {
  function seedSkill(): string {
    const skill = addSkill('Security Reviewer', '## Security\nCheck inputs.')
    return skill.content
  }

  it('uses the content-hash key with a |deep marker and records toolCallsUsed per entry', async () => {
    seedSettings({ aiDeepReview: true })
    const content = seedSkill()
    const deps = makeDeps()
    deps.llmToolLoop.mockResolvedValue({
      content: JSON.stringify(SKILL_RESULT),
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      toolCallsUsed: 4,
    })
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.runSkillReviews()

    const deepKey = `${PR_KEY}|skill:${djb2(content)}|deep|v${PROMPT_VERSION}`
    expect(deps.getCached).toHaveBeenCalledWith(deepKey)
    expect(deps.setCached).toHaveBeenCalledWith(deepKey, {
      deep: true,
      result: SKILL_RESULT,
      toolCallsUsed: 4,
    })
    expect(run.skillReviews[0].state.status).toBe('done')
    expect(run.skillReviews[0].state.toolCallsUsed).toBe(4)
  })

  it('toggle off → skill cache key is unchanged (no |deep marker)', async () => {
    seedSettings()
    const content = seedSkill()
    const deps = makeDeps()
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.runSkillReviews()

    expect(deps.llmToolLoop).not.toHaveBeenCalled()
    expect(deps.getCached).toHaveBeenCalledWith(`${PR_KEY}|skill:${djb2(content)}|v${PROMPT_VERSION}`)
    expect(run.skillReviews[0].state.status).toBe('done')
    expect(run.skillReviews[0].state.toolCallsUsed).toBeUndefined()
  })

  it('unsupported model → entries carry the honest fallback note', async () => {
    seedSettings({ aiDeepReview: true, aiModel: 'deepseek-reasoner' })
    seedSkill()
    const deps = makeDeps()
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.runSkillReviews()

    expect(deps.llmToolLoop).not.toHaveBeenCalled()
    expect(run.skillReviews[0].state.status).toBe('done')
    expect(run.skillReviews[0].state.note).toContain('does not support tool calling')
  })
})
