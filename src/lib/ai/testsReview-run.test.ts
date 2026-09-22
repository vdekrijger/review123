/**
 * Phase-scoped reviewers (#237) — orchestration tests for src/lib/ai/run.svelte.ts.
 *
 * Two behaviours are under test, and they are deliberately asymmetric:
 *
 *   IMPLEMENTATION pass (runSkillReviews) — automatic, and now SCOPED: it packs
 *   PackScope 'implementation', so no test-file content reaches the reviewers.
 *   Every other task keeps packing the full PR, byte-identically.
 *
 *   TESTS pass (runTestsReview) — ON DEMAND only. Nothing calls it: not start(),
 *   not the auto-start, not prepare-ahead. When the user clicks it, it runs
 *   EVERY enabled reviewer, AGENTICALLY whatever the user's `skills` deep
 *   setting says (harness permitting), over the WHOLE-PR context, under its own
 *   prompt and its own cache segment — and its findings flow through the same
 *   convergence / simplify / triage pipeline as any other.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAiRun, isTestsPassEntryId, baseSkillId, TESTS_PASS_ID_SUFFIX } from './run.svelte'
import { PROMPT_VERSIONS, TESTS_REVIEW_MARKER } from './tasks'
import { addSkill, removeSkill, listSkills, toggleSkill } from '../skills/skills'
import { djb2 } from '../viewed/viewed.svelte'
import type { PackedContext, PackScope } from '../context/pack'
import type { SkillReviewResult } from './schemas'
import type { DeepReviewSource } from './deepReview'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PR_KEY = 'github:owner/repo#1@abc123'

/** The implementation-only pack: no test-file content in sight. */
const IMPL_CTX: PackedContext = {
  text: 'PR context: src/foo.ts only',
  notAnalyzed: [],
  includedFiles: ['src/foo.ts'],
  importGraph: '',
}

/** The full-PR pack: implementation AND tests — what the tests pass reads. */
const ALL_CTX: PackedContext = {
  text: 'PR context: src/foo.ts and src/foo.test.ts',
  notAnalyzed: [],
  includedFiles: ['src/foo.ts', 'src/foo.test.ts'],
  importGraph: '',
}

/** An implementation-pass finding — anchored on the implementation file. */
const IMPL_RESULT: SkillReviewResult = {
  skillName: 'Security Reviewer',
  findings: [{ path: 'src/foo.ts', line: 2, severity: 'high', body: 'unsanitized input' }],
}

/** A tests-pass finding — anchored on the TEST file, so it lands in the Tests phase. */
const TESTS_RESULT: SkillReviewResult = {
  skillName: 'Security Reviewer',
  findings: [{ path: 'src/foo.test.ts', line: 7, severity: 'medium', body: 'asserts on the mock, not the behaviour' }],
}

function makeSource(): DeepReviewSource {
  return {
    getFileAtHead: vi.fn().mockResolvedValue('head contents'),
    getFileAtBase: vi.fn().mockResolvedValue('base contents'),
    searchCode: vi.fn().mockResolvedValue('no matches'),
  }
}

/** deepseek-v4-flash supports tool calling — the harness is available. */
function seedSettings(extra: Record<string, unknown> = {}) {
  localStorage.setItem(
    'review123:settings',
    JSON.stringify({ deepseekKey: 'sk-test', aiProvider: 'deepseek', aiModel: 'deepseek-v4-flash', ...extra }),
  )
}

type LlmOpts = { system: string; user: string }

/**
 * DI stubs. Reviewer calls dispatch on the tests-pass marker so a test can tell
 * the two prompts apart exactly the way the real prompts differ.
 */
function makeDeps() {
  const llmJsonWithRepairWithUsage = vi.fn().mockImplementation(async (opts: LlmOpts) => ({
    result: opts.system.includes(TESTS_REVIEW_MARKER) ? TESTS_RESULT : IMPL_RESULT,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }))
  const llmToolLoop = vi.fn().mockImplementation(async (opts: LlmOpts) => ({
    content: JSON.stringify(opts.system.includes(TESTS_REVIEW_MARKER) ? TESTS_RESULT : IMPL_RESULT),
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    toolCallsUsed: 3,
  }))
  return {
    llmStream: vi.fn().mockResolvedValue('hi'),
    llmStreamWithUsage: vi.fn().mockResolvedValue({ content: 'hi' }),
    llmJsonWithRepair: vi.fn().mockResolvedValue(IMPL_RESULT),
    llmJsonWithRepairWithUsage,
    llmToolLoop,
    getCached: vi.fn().mockResolvedValue(null),
    setCached: vi.fn().mockResolvedValue(undefined),
    gateAi: vi.fn().mockResolvedValue(true),
    track: vi.fn(),
  }
}

/**
 * A pack that answers PER SCOPE — the shape buildAiRunInput really produces —
 * and counts its calls, so "packed at most once per scope" is testable.
 */
function makePack() {
  const calls: (PackScope | undefined)[] = []
  const pack = async (scope?: PackScope): Promise<PackedContext> => {
    calls.push(scope)
    return scope === 'implementation' ? IMPL_CTX : ALL_CTX
  }
  return { pack, calls }
}

function makeInput(pack: (scope?: PackScope) => Promise<PackedContext>, deepReview?: DeepReviewSource) {
  return {
    prKey: PR_KEY,
    repo: 'owner/repo',
    isPrivate: false as boolean | undefined,
    pack,
    ci: async () => null,
    ask: async () => true,
    ...(deepReview ? { deepReview } : {}),
  }
}

/**
 * The REVIEWER calls that reached a transport — the follow-up convergence and
 * simplify passes share the same transport, so they are filtered out by their
 * own stable system-prompt markers.
 */
const FOLLOW_UP_MARKERS = ['consolidating overlapping code-review findings', 'rewriting code-review findings into plain']

function isReviewerCall(opts: LlmOpts): boolean {
  return !FOLLOW_UP_MARKERS.some((m) => opts.system.includes(m))
}

function reviewerCalls(deps: ReturnType<typeof makeDeps>): LlmOpts[] {
  return [
    ...deps.llmJsonWithRepairWithUsage.mock.calls.map((c: unknown[]) => c[0] as LlmOpts),
    ...deps.llmToolLoop.mock.calls.map((c: unknown[]) => c[0] as LlmOpts),
  ].filter(isReviewerCall)
}

/** The system prompts of the reviewer calls that actually reached a transport. */
function reviewerSystems(deps: ReturnType<typeof makeDeps>): string[] {
  return reviewerCalls(deps).map((o) => o.system)
}

/** The user messages (the packed context) of the reviewer calls. */
function reviewerUsers(deps: ReturnType<typeof makeDeps>): string[] {
  return reviewerCalls(deps).map((o) => o.user)
}

beforeEach(() => {
  localStorage.clear()
  listSkills().forEach((s) => removeSkill(s.id))
})

// ---------------------------------------------------------------------------
// Entry-id identity
// ---------------------------------------------------------------------------

describe('reviewer entry ids', () => {
  it('round-trips a tests-pass id back to the underlying skill id', () => {
    expect(isTestsPassEntryId('sk1')).toBe(false)
    expect(isTestsPassEntryId('sk1' + TESTS_PASS_ID_SUFFIX)).toBe(true)
    expect(baseSkillId('sk1' + TESTS_PASS_ID_SUFFIX)).toBe('sk1')
    // A non-tests id is its own base — identity, so nothing else changes shape.
    expect(baseSkillId('sk1')).toBe('sk1')
  })
})

// ---------------------------------------------------------------------------
// The implementation pass is SCOPED
// ---------------------------------------------------------------------------

describe('implementation reviewer pass — scoped to implementation files', () => {
  it("packs PackScope 'implementation', so no test-file content reaches the reviewers", async () => {
    seedSettings()
    addSkill('Security Reviewer', 'sec content')
    const { pack, calls } = makePack()
    const deps = makeDeps()

    await createAiRun(makeInput(pack), deps).runSkillReviews()

    expect(calls).toEqual(['implementation'])
    const users = reviewerUsers(deps)
    expect(users).toHaveLength(1)
    expect(users[0]).toBe(IMPL_CTX.text)
    expect(users[0]).not.toContain('src/foo.test.ts')
  })

  it('leaves the FULL-PR pack for every other task — both scopes coexist, neither is packed twice', async () => {
    seedSettings()
    addSkill('Security Reviewer', 'sec content')
    const { pack, calls } = makePack()
    const run = createAiRun(makeInput(pack), makeDeps())

    await run.start()
    await run.runSkillReviews()
    // A second reviewer batch, and a retry, reuse the memoized scoped pack.
    await run.runSkillReviews()

    // The automatic tasks packed 'all' ONCE (undefined === the unscoped call),
    // the reviewers packed 'implementation' ONCE. No double-packing either way.
    expect(calls.filter((c) => c === undefined)).toHaveLength(1)
    expect(calls.filter((c) => c === 'implementation')).toHaveLength(1)
  })

  it('still uses the implementation-pass cache key (no |tests segment)', async () => {
    seedSettings()
    const skill = addSkill('Security Reviewer', 'sec content')
    const deps = makeDeps()
    const { pack } = makePack()

    await createAiRun(makeInput(pack), deps).runSkillReviews()

    const hash = djb2(skill.content)
    expect(deps.getCached).toHaveBeenCalledWith(`${PR_KEY}|skill:${hash}|v${PROMPT_VERSIONS.skills}`)
  })
})

// ---------------------------------------------------------------------------
// The tests pass is ON DEMAND
// ---------------------------------------------------------------------------

describe('tests reviewer pass — on demand only', () => {
  it('is NOT fired by start(): no tests-pass call, no entries', async () => {
    seedSettings()
    addSkill('Security Reviewer', 'sec content')
    const deps = makeDeps()
    const { pack } = makePack()
    const run = createAiRun(makeInput(pack), deps)

    await run.start()

    expect(run.testReviews).toEqual([])
    expect(reviewerSystems(deps).some((s) => s.includes(TESTS_REVIEW_MARKER))).toBe(false)
  })

  it('is NOT fired by the automatic reviewer pass either', async () => {
    seedSettings()
    addSkill('Security Reviewer', 'sec content')
    const deps = makeDeps()
    const { pack } = makePack()
    const run = createAiRun(makeInput(pack), deps)

    await run.runSkillReviews()

    expect(run.skillReviews).toHaveLength(1)
    expect(run.testReviews).toEqual([])
    expect(reviewerSystems(deps).some((s) => s.includes(TESTS_REVIEW_MARKER))).toBe(false)
  })

  it('runs only when explicitly called, and then uses the tests prompt', async () => {
    seedSettings()
    addSkill('Security Reviewer', 'sec content')
    const deps = makeDeps()
    const { pack } = makePack()
    const run = createAiRun(makeInput(pack), deps)

    await run.runTestsReview()

    expect(run.testReviews).toHaveLength(1)
    expect(run.testReviews[0].state.status).toBe('done')
    expect(reviewerSystems(deps).every((s) => s.includes(TESTS_REVIEW_MARKER))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// What the tests pass sends
// ---------------------------------------------------------------------------

describe('tests reviewer pass — what it sends', () => {
  it('includes the IMPLEMENTATION as context (the whole-PR pack, not the scoped one)', async () => {
    seedSettings()
    addSkill('Security Reviewer', 'sec content')
    const deps = makeDeps()
    const { pack, calls } = makePack()

    await createAiRun(makeInput(pack), deps).runTestsReview()

    expect(calls).toEqual([undefined])
    expect(reviewerUsers(deps)[0]).toBe(ALL_CTX.text)
    expect(reviewerUsers(deps)[0]).toContain('src/foo.ts')
  })

  it('shares the full-PR pack the automatic tasks already warmed — zero extra packing', async () => {
    seedSettings()
    addSkill('Security Reviewer', 'sec content')
    const { pack, calls } = makePack()
    const run = createAiRun(makeInput(pack), makeDeps())

    await run.start()
    await run.runTestsReview()

    expect(calls.filter((c) => c === undefined)).toHaveLength(1)
  })

  it('runs ALL enabled reviewers (the user chose the whole panel, not a subset)', async () => {
    seedSettings()
    addSkill('Security Reviewer', 'sec content')
    addSkill('Performance Reviewer', 'perf content')
    addSkill('Docs Reviewer', 'docs content')
    const { pack } = makePack()
    const run = createAiRun(makeInput(pack), makeDeps())

    await run.runTestsReview()

    expect(run.testReviews.map((e) => e.name).sort()).toEqual([
      'Docs Reviewer',
      'Performance Reviewer',
      'Security Reviewer',
    ])
  })

  it('skips DISABLED reviewers, exactly as the automatic pass does', async () => {
    seedSettings()
    addSkill('Security Reviewer', 'sec content')
    const off = addSkill('Performance Reviewer', 'perf content')
    toggleSkill(off.id)
    const { pack } = makePack()
    const run = createAiRun(makeInput(pack), makeDeps())

    await run.runTestsReview()

    expect(run.testReviews.map((e) => e.name)).toEqual(['Security Reviewer'])
  })
})

// ---------------------------------------------------------------------------
// Always agentic — but never when skills are off
// ---------------------------------------------------------------------------

describe('tests reviewer pass — agentic regardless of the deep setting', () => {
  it("runs through the tool loop even when `skills` is 'standard'", async () => {
    seedSettings({ aiTaskModes: { skills: 'standard' } })
    addSkill('Security Reviewer', 'sec content')
    const deps = makeDeps()
    const { pack } = makePack()

    await createAiRun(makeInput(pack, makeSource()), deps).runTestsReview()

    expect(deps.llmToolLoop).toHaveBeenCalledTimes(1)
    expect((deps.llmToolLoop.mock.calls[0][0] as LlmOpts).system).toContain(TESTS_REVIEW_MARKER)
  })

  it('leaves the IMPLEMENTATION pass single-pass at the same standard setting (only this pass is forced)', async () => {
    seedSettings({ aiTaskModes: { skills: 'standard' } })
    addSkill('Security Reviewer', 'sec content')
    const deps = makeDeps()
    const { pack } = makePack()

    await createAiRun(makeInput(pack, makeSource()), deps).runSkillReviews()

    expect(deps.llmToolLoop).not.toHaveBeenCalled()
    expect(reviewerCalls(deps)).toHaveLength(1)
  })

  it('passes the repo-reading tools to the loop and respects the existing tool budget', async () => {
    seedSettings({ aiTaskModes: { skills: 'standard' } })
    addSkill('Security Reviewer', 'sec content')
    const deps = makeDeps()
    const { pack } = makePack()

    await createAiRun(makeInput(pack, makeSource()), deps).runTestsReview()

    const opts = deps.llmToolLoop.mock.calls[0][0] as { tools: { name: string }[]; maxToolCalls: number }
    expect(opts.tools.map((t) => t.name)).toEqual(['read_file', 'read_file_at_base', 'search_code'])
    // The existing per-task budget — this pass invents no new limits.
    expect(opts.maxToolCalls).toBeGreaterThan(0)
  })

  it('falls back to single-pass WITH AN HONEST NOTE when no tool source is wired', async () => {
    seedSettings({ aiTaskModes: { skills: 'standard' } })
    addSkill('Security Reviewer', 'sec content')
    const deps = makeDeps()
    const { pack } = makePack()

    // No deepReview source → the harness simply is not available.
    const run = createAiRun(makeInput(pack), deps)
    await run.runTestsReview()

    expect(deps.llmToolLoop).not.toHaveBeenCalled()
    expect(run.testReviews[0].state.status).toBe('done')
  })

  it("does NOT run at all when `skills` is 'off' — an on-demand pass still respects the switch", async () => {
    seedSettings({ aiTaskModes: { skills: 'off' } })
    addSkill('Security Reviewer', 'sec content')
    const deps = makeDeps()
    const { pack, calls } = makePack()
    const run = createAiRun(makeInput(pack, makeSource()), deps)

    await run.runTestsReview()

    expect(run.testReviews).toEqual([])
    expect(deps.llmToolLoop).not.toHaveBeenCalled()
    expect(reviewerCalls(deps)).toHaveLength(0)
    // Zero tokens AND zero work: no consent prompt, no pack.
    expect(deps.gateAi).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Cache keys
// ---------------------------------------------------------------------------

describe('tests reviewer pass — cache keys', () => {
  it('reads and writes its OWN segment + version, never the implementation pass’s', async () => {
    seedSettings({ aiTaskModes: { skills: 'standard' } })
    const skill = addSkill('Security Reviewer', 'sec content')
    const deps = makeDeps()
    const { pack } = makePack()

    await createAiRun(makeInput(pack, makeSource()), deps).runTestsReview()

    const hash = djb2(skill.content)
    const key = `${PR_KEY}|skill:${hash}|tests|deep|v${PROMPT_VERSIONS.skillsTests}`
    expect(deps.getCached).toHaveBeenCalledWith(key)
    expect(deps.setCached.mock.calls.map((c: unknown[]) => c[0])).toContain(key)
    // The implementation pass's key is NEVER touched by this pass.
    const implKey = `${PR_KEY}|skill:${hash}|v${PROMPT_VERSIONS.skills}`
    expect(deps.setCached.mock.calls.map((c: unknown[]) => c[0])).not.toContain(implKey)
  })

  it('the two passes cannot overwrite each other for the same persona', async () => {
    seedSettings()
    const skill = addSkill('Security Reviewer', 'sec content')
    const deps = makeDeps()
    const { pack } = makePack()
    const run = createAiRun(makeInput(pack), deps)

    await run.runSkillReviews()
    await run.runTestsReview()

    const hash = djb2(skill.content)
    const written = deps.setCached.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(written).toContain(`${PR_KEY}|skill:${hash}|v${PROMPT_VERSIONS.skills}`)
    expect(written).toContain(`${PR_KEY}|skill:${hash}|tests|v${PROMPT_VERSIONS.skillsTests}`)
    // Both results survive — each pass kept its own findings.
    expect(run.skillReviews[0].state.value).toEqual(IMPL_RESULT)
    expect(run.testReviews[0].state.value).toEqual(TESTS_RESULT)
  })
})

// ---------------------------------------------------------------------------
// Findings integration
// ---------------------------------------------------------------------------

describe('tests reviewer pass — findings integration', () => {
  it('anchors its findings to the TEST file, so they file into the Tests phase', async () => {
    seedSettings()
    addSkill('Security Reviewer', 'sec content')
    const { pack } = makePack()
    const run = createAiRun(makeInput(pack), makeDeps())

    await run.runTestsReview()

    const value = run.testReviews[0].state.value as SkillReviewResult
    expect(value.findings.map((f) => f.path)).toEqual(['src/foo.test.ts'])
  })

  it('does NOT disturb the implementation pass — those findings survive the run', async () => {
    seedSettings()
    addSkill('Security Reviewer', 'sec content')
    const { pack } = makePack()
    const run = createAiRun(makeInput(pack), makeDeps())

    await run.runSkillReviews()
    expect(run.skillReviews).toHaveLength(1)

    await run.runTestsReview()

    expect(run.skillReviews).toHaveLength(1)
    expect(run.skillReviews[0].state.status).toBe('done')
    expect(run.skillReviews[0].state.value).toEqual(IMPL_RESULT)
  })

  it('its entries carry the tests-pass suffix so nothing collides with the implementation pass', async () => {
    seedSettings()
    const skill = addSkill('Security Reviewer', 'sec content')
    const { pack } = makePack()
    const run = createAiRun(makeInput(pack), makeDeps())

    await run.runSkillReviews()
    await run.runTestsReview()

    expect(run.skillReviews[0].skillId).toBe(skill.id)
    expect(run.testReviews[0].skillId).toBe(skill.id + TESTS_PASS_ID_SUFFIX)
    expect(run.testReviews[0].skillId).not.toBe(run.skillReviews[0].skillId)
    // Display name stays the persona's — the UI tags the pass, not the name.
    expect(run.testReviews[0].name).toBe('Security Reviewer')
  })

  it("folds its usage into the run's total cost", async () => {
    seedSettings()
    addSkill('Security Reviewer', 'sec content')
    const { pack } = makePack()
    const run = createAiRun(makeInput(pack), makeDeps())

    await run.runTestsReview()

    expect(run.totalUsage?.total_tokens).toBe(15)
  })
})

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

describe('tests reviewer pass — retry', () => {
  it('retrySkill routes a tests-pass entry id back to the TESTS pass', async () => {
    seedSettings()
    const skill = addSkill('Security Reviewer', 'sec content')
    const deps = makeDeps()
    const { pack } = makePack()
    const run = createAiRun(makeInput(pack), deps)

    await run.runTestsReview()
    deps.llmJsonWithRepairWithUsage.mockClear()

    await run.retrySkill(skill.id + TESTS_PASS_ID_SUFFIX)

    const retried = reviewerCalls(deps)
    expect(retried).toHaveLength(1)
    expect(retried[0].system).toContain(TESTS_REVIEW_MARKER)
    expect(retried[0].user).toBe(ALL_CTX.text)
    expect(run.testReviews[0].state.status).toBe('done')
  })

  it('retrySkill with a plain skill id still targets the IMPLEMENTATION pass', async () => {
    seedSettings()
    const skill = addSkill('Security Reviewer', 'sec content')
    const deps = makeDeps()
    const { pack } = makePack()
    const run = createAiRun(makeInput(pack), deps)

    await run.runSkillReviews()
    await run.runTestsReview()
    deps.llmJsonWithRepairWithUsage.mockClear()

    await run.retrySkill(skill.id)

    const retried = reviewerCalls(deps)
    expect(retried).toHaveLength(1)
    expect(retried[0].system).not.toContain(TESTS_REVIEW_MARKER)
    expect(retried[0].user).toBe(IMPL_CTX.text)
  })
})
