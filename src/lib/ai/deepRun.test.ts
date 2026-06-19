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
import type { VerdictResult, SkillReviewResult, TestInsight, AlternativesResult, GraphResult, AttentionResult } from './schemas'
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

    // start() now runs the deep loop for verdict + tests + alternatives; pick
    // the verdict invocation by its system prompt (the verdict level enum).
    const loopOpts = deps.llmToolLoop.mock.calls
      .map((c: unknown[]) => c[0] as { system: string; tools: { name: string }[]; maxToolCalls: number })
      .find((o) => /behavior-preserved/.test(o.system))!
    expect(loopOpts).toBeDefined()
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
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
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
      async (opts: { system: string; onToolEvent?: (ev: { name: string; detail: string }) => void }) => {
        opts.onToolEvent?.({ name: 'read_file', detail: 'Reading src/foo.ts…' })
        // Only capture for the verdict loop (other tasks now loop too in start()).
        if (/behavior-preserved/.test(opts.system)) {
          activityDuringRun = [...(run.verdict.activity ?? [])]
        }
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

    // The verdict came from cache → no verdict loop call (other tasks may loop).
    const verdictLoop = deps.llmToolLoop.mock.calls
      .map((c: unknown[]) => c[0] as { system: string })
      .find((o) => /behavior-preserved/.test(o.system))
    expect(verdictLoop).toBeUndefined()
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
      usage: { prompt_tokens: 110, completion_tokens: 55, total_tokens: 165 },
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
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
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

// ---------------------------------------------------------------------------
// Deep test-insight + alternatives (Plan: phase1-deepen)
//
// These two phase-1 tasks join the deep harness under the SAME aiDeepReview
// toggle. Mirrors the verdict deep tests: |deep key, loop invoked with the
// task's prompts + validator, wrapper carries toolCallsUsed, activity lines
// populate, cache-hit unwraps, unsupported model → single-pass + note, and
// toggle off → byte-identical single-pass key.
// ---------------------------------------------------------------------------

const TESTS_RESULT: TestInsight = {
  covered: [{ behavior: 'parses sentinel block', test: 'parseReadingOrder', file: 'src/foo.test.ts' }],
  gaps: ['src/foo.ts: error path untested — silent failure on bad input'],
}

const ALTERNATIVES_RESULT: AlternativesResult = {
  problem: 'parse a reading-order block from summary text',
  alternatives: [
    {
      approach: 'Regex over the whole string',
      tradeoffs: 'Gains brevity but loses line-level resilience',
      assessment: 'pr-is-better',
      rationale: 'line scanning is clearer here',
    },
  ],
}

const ATTENTION_RESULT: AttentionResult = {
  readingOrder: ['src/foo.ts'],
  hotspots: [{ path: 'src/foo.ts', reason: 'verified load-bearing change', level: 'high' }],
  testFlags: [],
}

// A deep change-impact result: the changed symbols + their 1-hop callers
// (blast radius) and callees. before/after are emitted empty under the shape.
const DIAGRAM_RESULT: GraphResult = {
  kind: 'flow',
  before: { nodes: [], edges: [] },
  after: { nodes: [], edges: [] },
  impact: {
    changed: [{ symbol: 'handleSubmit', file: 'src/router.ts', kind: 'changed' }],
    callers: [{ symbol: 'route', file: 'src/router.ts' }],
    callees: [{ symbol: 'writeStore', file: 'src/store.ts' }],
  },
}

/**
 * Validator-aware deps: the deep loop and single-pass repair return whichever
 * fixture validates for the task's own validator, so start()'s six parallel
 * tasks each get a shape-correct answer.
 */
function makeMultiTaskDeps() {
  const CANDIDATES = [DIAGRAM_RESULT, VERDICT_RESULT, SKILL_RESULT, TESTS_RESULT, ALTERNATIVES_RESULT, ATTENTION_RESULT]
  const pick = (validate: ValidateFn) => {
    for (const c of CANDIDATES) if (validate(c) !== null) return c
    return VERDICT_RESULT
  }
  const llmJsonWithRepair = vi.fn().mockImplementation(async (_o: unknown, validate: ValidateFn) => pick(validate))
  const llmJsonWithRepairWithUsage = vi.fn().mockImplementation(async (_o: unknown, validate: ValidateFn) => ({
    result: pick(validate),
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
  // The loop reads the system prompt to decide which fixture to return, so each
  // deep task gets a shape-correct JSON body.
  const llmToolLoop = vi.fn().mockImplementation(
    async (opts: { system: string; onToolEvent?: (ev: { name: string; detail: string }) => void }) => {
      opts.onToolEvent?.({ name: 'read_file', detail: 'Reading src/foo.ts…' })
      let body: unknown = VERDICT_RESULT
      if (/changed test files/i.test(opts.system)) body = TESTS_RESULT
      else if (/genuinely different approach/i.test(opts.system)) body = ALTERNATIVES_RESULT
      else if (/reviewer persona/i.test(opts.system)) body = SKILL_RESULT
      else if (/NO Mermaid syntax/i.test(opts.system)) body = DIAGRAM_RESULT
      else if (/testFlags/i.test(opts.system)) body = ATTENTION_RESULT
      return {
        content: JSON.stringify(body),
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

describe('deep test-insight task', () => {
  it('runs the tool loop, uses the |deep key, caches a wrapper with toolCallsUsed', async () => {
    seedSettings({ aiDeepReview: true })
    const deps = makeMultiTaskDeps()
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    // Deep guidance composed onto the test-insight system prompt
    const testsLoopCall = deps.llmToolLoop.mock.calls.find((c: unknown[]) =>
      /changed test files/i.test((c[0] as { system: string }).system),
    )
    expect(testsLoopCall).toBeDefined()
    expect((testsLoopCall![0] as { system: string }).system).toContain('Deep review mode')

    const deepKey = `${PR_KEY}|tests|deep|v${PROMPT_VERSION}`
    expect(deps.getCached).toHaveBeenCalledWith(deepKey)
    expect(deps.setCached).toHaveBeenCalledWith(deepKey, {
      deep: true,
      result: TESTS_RESULT,
      toolCallsUsed: 2,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    })
    expect(run.tests.status).toBe('done')
    expect(run.tests.value).toEqual(TESTS_RESULT)
    expect(run.tests.toolCallsUsed).toBe(2)
    expect(run.tests.activity).toBeUndefined()
  })

  it('unwraps a deep cache hit: result + toolCallsUsed, no loop call', async () => {
    seedSettings({ aiDeepReview: true })
    const deps = makeMultiTaskDeps()
    deps.getCached.mockImplementation(async (key: string) =>
      key === `${PR_KEY}|tests|deep|v${PROMPT_VERSION}`
        ? { deep: true, result: TESTS_RESULT, toolCallsUsed: 3 }
        : null,
    )
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    expect(run.tests.value).toEqual(TESTS_RESULT)
    expect(run.tests.toolCallsUsed).toBe(3)
    // No loop call carried the test-insight prompt
    const testsLoop = deps.llmToolLoop.mock.calls.find((c: unknown[]) =>
      /changed test files/i.test((c[0] as { system: string }).system),
    )
    expect(testsLoop).toBeUndefined()
  })

  it('unsupported model → single-pass key + honest note', async () => {
    seedSettings({ aiDeepReview: true, aiModel: 'deepseek-reasoner' })
    const deps = makeMultiTaskDeps()
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    expect(deps.getCached).toHaveBeenCalledWith(`${PR_KEY}|tests|v${PROMPT_VERSION}`)
    expect(run.tests.status).toBe('done')
    expect(run.tests.note).toContain('does not support tool calling')
    expect(run.tests.toolCallsUsed).toBeUndefined()
  })

  it('toggle off → single-pass key, no loop, byte-identical', async () => {
    seedSettings()
    const deps = makeMultiTaskDeps()
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    expect(deps.getCached).toHaveBeenCalledWith(`${PR_KEY}|tests|v${PROMPT_VERSION}`)
    expect(run.tests.status).toBe('done')
    expect(run.tests.toolCallsUsed).toBeUndefined()
    expect(run.tests.note).toBeUndefined()
  })
})

describe('deep alternatives task', () => {
  it('runs the tool loop, uses the |deep key, caches a wrapper with toolCallsUsed', async () => {
    seedSettings({ aiDeepReview: true })
    const deps = makeMultiTaskDeps()
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    const altLoopCall = deps.llmToolLoop.mock.calls.find((c: unknown[]) =>
      /genuinely different approach/i.test((c[0] as { system: string }).system),
    )
    expect(altLoopCall).toBeDefined()
    expect((altLoopCall![0] as { system: string }).system).toContain('Deep review mode')

    const deepKey = `${PR_KEY}|alternatives|deep|v${PROMPT_VERSION}`
    expect(deps.getCached).toHaveBeenCalledWith(deepKey)
    expect(deps.setCached).toHaveBeenCalledWith(deepKey, {
      deep: true,
      result: ALTERNATIVES_RESULT,
      toolCallsUsed: 2,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    })
    expect(run.alternatives.status).toBe('done')
    expect(run.alternatives.value).toEqual(ALTERNATIVES_RESULT)
    expect(run.alternatives.toolCallsUsed).toBe(2)
  })

  it('toggle off → single-pass key, no deep marker', async () => {
    seedSettings()
    const deps = makeMultiTaskDeps()
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    expect(deps.getCached).toHaveBeenCalledWith(`${PR_KEY}|alternatives|v${PROMPT_VERSION}`)
    expect(run.alternatives.toolCallsUsed).toBeUndefined()
  })

  it('invalid loop JSON → single-pass repair grounded in loop output, then cached', async () => {
    seedSettings({ aiDeepReview: true })
    const deps = makeMultiTaskDeps()
    // Alternatives loop returns non-JSON → triggers the repair pass
    deps.llmToolLoop.mockImplementation(
      async (opts: { system: string; onToolEvent?: (ev: { name: string; detail: string }) => void }) => {
        if (/genuinely different approach/i.test(opts.system)) {
          return { content: 'Here are some alternatives (not JSON)', usage: undefined, toolCallsUsed: 4 }
        }
        let body: unknown = VERDICT_RESULT
        if (/changed test files/i.test(opts.system)) body = TESTS_RESULT
        else if (/reviewer persona/i.test(opts.system)) body = SKILL_RESULT
        return { content: JSON.stringify(body), usage: undefined, toolCallsUsed: 1 }
      },
    )
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    const repairCall = deps.llmJsonWithRepairWithUsage.mock.calls.find((c: unknown[]) =>
      (c[0] as { user: string }).user.includes('Here are some alternatives'),
    )
    expect(repairCall).toBeDefined()
    expect(run.alternatives.status).toBe('done')
    expect(run.alternatives.value).toEqual(ALTERNATIVES_RESULT)
    expect(run.alternatives.toolCallsUsed).toBe(4)
    expect(deps.setCached).toHaveBeenCalledWith(`${PR_KEY}|alternatives|deep|v${PROMPT_VERSION}`, {
      deep: true,
      result: ALTERNATIVES_RESULT,
      toolCallsUsed: 4,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
  })
})

// ---------------------------------------------------------------------------
// Deep diagrams (Plan: deep-diagrams-context)
//
// When aiDeepReview is ON the diagram task joins the harness so it can situate
// the changed files inside the broader architecture (one-hop "context" nodes).
// When OFF it stays byte-identical: diff-scoped, single-pass, no |deep marker,
// no tool loop.
// ---------------------------------------------------------------------------

describe('deep diagrams task', () => {
  it('runs the tool loop, uses the |deep key, caches a wrapper with toolCallsUsed', async () => {
    seedSettings({ aiDeepReview: true })
    const deps = makeMultiTaskDeps()
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    // The diagram loop carries the deep-diagram system prompt (no-Mermaid + deep guidance)
    const diagramLoopCall = deps.llmToolLoop.mock.calls.find((c: unknown[]) =>
      /NO Mermaid syntax/i.test((c[0] as { system: string }).system),
    )
    expect(diagramLoopCall).toBeDefined()
    const diagramSystem = (diagramLoopCall![0] as { system: string }).system
    expect(diagramSystem).toContain('Deep review mode')
    // Deep-impact guidance: find REAL callers with the tools
    expect(diagramSystem).toContain('find REAL callers')
    expect(diagramSystem).toMatch(/find_references|search_code/)

    const deepKey = `${PR_KEY}|diagrams|deep|v${PROMPT_VERSION}`
    expect(deps.getCached).toHaveBeenCalledWith(deepKey)
    expect(deps.setCached).toHaveBeenCalledWith(deepKey, {
      deep: true,
      result: DIAGRAM_RESULT,
      toolCallsUsed: 2,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    })
    expect(run.diagrams.status).toBe('done')
    expect(run.diagrams.value).toEqual(DIAGRAM_RESULT)
    expect(run.diagrams.toolCallsUsed).toBe(2)
    expect(run.diagrams.activity).toBeUndefined()
  })

  it('surfaces the changed symbols with their callers + callees', async () => {
    seedSettings({ aiDeepReview: true })
    const deps = makeMultiTaskDeps()
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    const value = run.diagrams.value as GraphResult
    expect(value.impact?.changed.length).toBe(1)
    const changed = value.impact?.changed[0]
    expect(changed?.symbol).toBe('handleSubmit')
    expect(changed?.kind).toBe('changed')
    expect(changed?.file).toBe('src/router.ts')
    expect(value.impact?.callers.map((c) => c.symbol)).toContain('route')
    expect(value.impact?.callees.map((c) => c.symbol)).toContain('writeStore')
  })

  it('unwraps a deep cache hit: result + toolCallsUsed, no diagram loop call', async () => {
    seedSettings({ aiDeepReview: true })
    const deps = makeMultiTaskDeps()
    deps.getCached.mockImplementation(async (key: string) =>
      key === `${PR_KEY}|diagrams|deep|v${PROMPT_VERSION}`
        ? { deep: true, result: DIAGRAM_RESULT, toolCallsUsed: 6 }
        : null,
    )
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    expect(run.diagrams.value).toEqual(DIAGRAM_RESULT)
    expect(run.diagrams.toolCallsUsed).toBe(6)
    const diagramLoop = deps.llmToolLoop.mock.calls.find((c: unknown[]) =>
      /NO Mermaid syntax/i.test((c[0] as { system: string }).system),
    )
    expect(diagramLoop).toBeUndefined()
  })

  it('unsupported model → single-pass key + honest note, no context guidance', async () => {
    seedSettings({ aiDeepReview: true, aiModel: 'deepseek-reasoner' })
    const deps = makeMultiTaskDeps()
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    expect(deps.llmToolLoop).not.toHaveBeenCalled()
    expect(deps.getCached).toHaveBeenCalledWith(`${PR_KEY}|diagrams|v${PROMPT_VERSION}`)
    expect(run.diagrams.status).toBe('done')
    expect(run.diagrams.note).toContain('does not support tool calling')
    expect(run.diagrams.toolCallsUsed).toBeUndefined()
  })

  it('toggle off → single-pass diagrams key, no loop, byte-identical (diff-scoped)', async () => {
    seedSettings()
    const deps = makeMultiTaskDeps()
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    // Single-pass key — no |deep marker
    expect(deps.getCached).toHaveBeenCalledWith(`${PR_KEY}|diagrams|v${PROMPT_VERSION}`)
    // The diagram task never went through the tool loop
    const diagramLoop = deps.llmToolLoop.mock.calls.find((c: unknown[]) =>
      /NO Mermaid syntax/i.test((c[0] as { system: string }).system),
    )
    expect(diagramLoop).toBeUndefined()
    expect(run.diagrams.status).toBe('done')
    expect(run.diagrams.toolCallsUsed).toBeUndefined()
    expect(run.diagrams.note).toBeUndefined()
  })

  it('invalid loop JSON → single-pass repair grounded in loop output, then cached', async () => {
    seedSettings({ aiDeepReview: true })
    const deps = makeMultiTaskDeps()
    // Diagram loop returns non-JSON → triggers the repair pass
    deps.llmToolLoop.mockImplementation(
      async (opts: { system: string; onToolEvent?: (ev: { name: string; detail: string }) => void }) => {
        if (/NO Mermaid syntax/i.test(opts.system)) {
          return { content: 'Here is the graph (not JSON)', usage: undefined, toolCallsUsed: 5 }
        }
        let body: unknown = VERDICT_RESULT
        if (/changed test files/i.test(opts.system)) body = TESTS_RESULT
        else if (/genuinely different approach/i.test(opts.system)) body = ALTERNATIVES_RESULT
        else if (/reviewer persona/i.test(opts.system)) body = SKILL_RESULT
        return { content: JSON.stringify(body), usage: undefined, toolCallsUsed: 1 }
      },
    )
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    const repairCall = deps.llmJsonWithRepairWithUsage.mock.calls.find((c: unknown[]) =>
      (c[0] as { user: string }).user.includes('Here is the graph'),
    )
    expect(repairCall).toBeDefined()
    expect(run.diagrams.status).toBe('done')
    expect(run.diagrams.value).toEqual(DIAGRAM_RESULT)
    expect(run.diagrams.toolCallsUsed).toBe(5)
    expect(deps.setCached).toHaveBeenCalledWith(`${PR_KEY}|diagrams|deep|v${PROMPT_VERSION}`, {
      deep: true,
      result: DIAGRAM_RESULT,
      toolCallsUsed: 5,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
  })
})

// ---------------------------------------------------------------------------
// Deep attention / hotspots (Plan: deep-attention)
//
// When aiDeepReview is ON the attention task joins the harness so it can VERIFY
// each candidate hotspot (read the changed file + its callers/dependencies)
// before reporting it — assume best intent, drop unsubstantiated hotspots.
// When OFF it stays byte-identical: single-pass, no |deep marker, no tool loop.
// ---------------------------------------------------------------------------

describe('deep attention task', () => {
  it('runs the tool loop, uses the |deep key, caches a wrapper with toolCallsUsed', async () => {
    seedSettings({ aiDeepReview: true })
    const deps = makeMultiTaskDeps()
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    // The attention loop carries the deep-attention system prompt (hotspots +
    // verify guidance + deep guidance composed on top).
    const attentionLoopCall = deps.llmToolLoop.mock.calls.find((c: unknown[]) =>
      /testFlags/i.test((c[0] as { system: string }).system),
    )
    expect(attentionLoopCall).toBeDefined()
    const attentionSystem = (attentionLoopCall![0] as { system: string }).system
    expect(attentionSystem).toContain('Deep review mode')
    // Deep-attention-specific guidance: verify each hotspot before reporting it
    expect(attentionSystem).toContain('VERIFY each hotspot before reporting it')

    const deepKey = `${PR_KEY}|attention|deep|v${PROMPT_VERSION}`
    expect(deps.getCached).toHaveBeenCalledWith(deepKey)
    expect(deps.setCached).toHaveBeenCalledWith(deepKey, {
      deep: true,
      result: ATTENTION_RESULT,
      toolCallsUsed: 2,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    })
    expect(run.attention.status).toBe('done')
    expect(run.attention.value).toEqual(ATTENTION_RESULT)
    expect(run.attention.toolCallsUsed).toBe(2)
    expect(run.attention.activity).toBeUndefined()
  })

  it('surfaces tool activity lines while the attention loop runs', async () => {
    seedSettings({ aiDeepReview: true })
    const deps = makeMultiTaskDeps()
    let activityDuringRun: string[] = []
    deps.llmToolLoop.mockImplementation(
      async (opts: { system: string; onToolEvent?: (ev: { name: string; detail: string }) => void }) => {
        opts.onToolEvent?.({ name: 'read_file', detail: 'Reading src/foo.ts…' })
        if (/testFlags/i.test(opts.system)) {
          activityDuringRun = [...(run.attention.activity ?? [])]
        }
        let body: unknown = VERDICT_RESULT
        if (/changed test files/i.test(opts.system)) body = TESTS_RESULT
        else if (/genuinely different approach/i.test(opts.system)) body = ALTERNATIVES_RESULT
        else if (/reviewer persona/i.test(opts.system)) body = SKILL_RESULT
        else if (/NO Mermaid syntax/i.test(opts.system)) body = DIAGRAM_RESULT
        else if (/testFlags/i.test(opts.system)) body = ATTENTION_RESULT
        return { content: JSON.stringify(body), usage: undefined, toolCallsUsed: 1 }
      },
    )
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    expect(activityDuringRun).toEqual(['Reading src/foo.ts…'])
  })

  it('unwraps a deep cache hit: result + toolCallsUsed, no attention loop call', async () => {
    seedSettings({ aiDeepReview: true })
    const deps = makeMultiTaskDeps()
    deps.getCached.mockImplementation(async (key: string) =>
      key === `${PR_KEY}|attention|deep|v${PROMPT_VERSION}`
        ? { deep: true, result: ATTENTION_RESULT, toolCallsUsed: 4 }
        : null,
    )
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    expect(run.attention.value).toEqual(ATTENTION_RESULT)
    expect(run.attention.toolCallsUsed).toBe(4)
    const attentionLoop = deps.llmToolLoop.mock.calls.find((c: unknown[]) =>
      /testFlags/i.test((c[0] as { system: string }).system),
    )
    expect(attentionLoop).toBeUndefined()
  })

  it('unsupported model → single-pass key + honest note, no deep guidance', async () => {
    seedSettings({ aiDeepReview: true, aiModel: 'deepseek-reasoner' })
    const deps = makeMultiTaskDeps()
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    expect(deps.getCached).toHaveBeenCalledWith(`${PR_KEY}|attention|v${PROMPT_VERSION}`)
    expect(run.attention.status).toBe('done')
    expect(run.attention.note).toContain('does not support tool calling')
    expect(run.attention.toolCallsUsed).toBeUndefined()
    // No attention call went through the tool loop
    const attentionLoop = deps.llmToolLoop.mock.calls.find((c: unknown[]) =>
      /testFlags/i.test((c[0] as { system: string }).system),
    )
    expect(attentionLoop).toBeUndefined()
  })

  it('toggle off → single-pass attention key, no loop, byte-identical', async () => {
    seedSettings()
    const deps = makeMultiTaskDeps()
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    expect(deps.getCached).toHaveBeenCalledWith(`${PR_KEY}|attention|v${PROMPT_VERSION}`)
    const attentionLoop = deps.llmToolLoop.mock.calls.find((c: unknown[]) =>
      /testFlags/i.test((c[0] as { system: string }).system),
    )
    expect(attentionLoop).toBeUndefined()
    expect(run.attention.status).toBe('done')
    expect(run.attention.toolCallsUsed).toBeUndefined()
    expect(run.attention.note).toBeUndefined()
  })

  it('invalid loop JSON → single-pass repair grounded in loop output, then cached', async () => {
    seedSettings({ aiDeepReview: true })
    const deps = makeMultiTaskDeps()
    // Attention loop returns non-JSON → triggers the repair pass
    deps.llmToolLoop.mockImplementation(
      async (opts: { system: string; onToolEvent?: (ev: { name: string; detail: string }) => void }) => {
        if (/testFlags/i.test(opts.system)) {
          return { content: 'Here are the hotspots (not JSON)', usage: undefined, toolCallsUsed: 6 }
        }
        let body: unknown = VERDICT_RESULT
        if (/changed test files/i.test(opts.system)) body = TESTS_RESULT
        else if (/genuinely different approach/i.test(opts.system)) body = ALTERNATIVES_RESULT
        else if (/reviewer persona/i.test(opts.system)) body = SKILL_RESULT
        else if (/NO Mermaid syntax/i.test(opts.system)) body = DIAGRAM_RESULT
        return { content: JSON.stringify(body), usage: undefined, toolCallsUsed: 1 }
      },
    )
    const run = createAiRun(makeInput(makeSource()), deps)
    await run.start()

    const repairCall = deps.llmJsonWithRepairWithUsage.mock.calls.find((c: unknown[]) =>
      (c[0] as { user: string }).user.includes('Here are the hotspots'),
    )
    expect(repairCall).toBeDefined()
    expect(run.attention.status).toBe('done')
    expect(run.attention.value).toEqual(ATTENTION_RESULT)
    expect(run.attention.toolCallsUsed).toBe(6)
    expect(deps.setCached).toHaveBeenCalledWith(`${PR_KEY}|attention|deep|v${PROMPT_VERSION}`, {
      deep: true,
      result: ATTENTION_RESULT,
      toolCallsUsed: 6,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
  })
})
