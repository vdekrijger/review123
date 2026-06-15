/**
 * Tests for AiRun.retrySkill — per-reviewer retry (the error-chip retry).
 *
 * Contract:
 *   - retrySkill(id) re-runs JUST that reviewer through the normal cache-miss
 *     path (errors are never cached → it re-hits the LLM).
 *   - It sets ONLY that entry to loading then resolves it to done/error.
 *   - Sibling entries are never disturbed.
 *   - A successful retry replaces the prior error with a result value.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAiRun } from './run.svelte'
import { addSkill } from '../skills/skills'

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test' }))
})

function makeStubDeps(overrides: Record<string, unknown> = {}) {
  const llmStream = vi.fn()
  const llmJsonWithRepair = vi.fn()

  const llmStreamWithUsage = vi.fn().mockImplementation(
    async (opts: unknown, onDelta: (d: string) => void) => {
      const content = await llmStream(opts, onDelta)
      return { content, usage: undefined }
    },
  )
  const llmJsonWithRepairWithUsage = vi.fn().mockImplementation(
    async (opts: unknown, validate: unknown) => ({
      result: await (llmJsonWithRepair as (o: unknown, v: unknown) => unknown)(opts, validate),
      usage: undefined,
    }),
  )

  const base = {
    llmStream,
    llmStreamWithUsage,
    llmJsonWithRepair,
    llmJsonWithRepairWithUsage,
    getCached: vi.fn().mockResolvedValue(null),
    setCached: vi.fn().mockResolvedValue(undefined),
    gateAi: vi.fn().mockResolvedValue(true),
    track: vi.fn(),
  }

  if ('llmJsonWithRepair' in overrides) {
    const overrideFn = overrides['llmJsonWithRepair'] as (o: unknown, v: unknown) => unknown
    const wrappedWithUsage = vi.fn().mockImplementation(
      async (opts: unknown, validate: unknown) => ({
        result: await overrideFn(opts, validate),
        usage: undefined,
      }),
    )
    return { ...base, ...overrides, llmJsonWithRepairWithUsage: wrappedWithUsage }
  }
  return { ...base, ...overrides }
}

function makeStubInput() {
  return {
    prKey: 'test-pr',
    repo: 'owner/repo',
    isPrivate: false,
    pack: vi.fn().mockResolvedValue({ text: 'packed context', notAnalyzed: [], includedFiles: [], importGraph: '' }),
    ci: vi.fn().mockResolvedValue(null),
    ask: vi.fn().mockResolvedValue(true),
  }
}

describe('AiRun.retrySkill', () => {
  it('re-runs an errored reviewer and resolves it to done (re-hits LLM, not cache)', async () => {
    addSkill('Flaky Reviewer', 'content')

    const result = { findings: [{ path: 'src/a.ts', line: 3, severity: 'high', body: 'found it' }] }
    // First call rejects (error), second call (retry) resolves.
    const llmFn = vi.fn()
      .mockRejectedValueOnce(new Error('rate-limited'))
      .mockResolvedValueOnce(result)
    const deps = makeStubDeps({ llmJsonWithRepair: llmFn })

    const run = createAiRun(makeStubInput(), deps)
    await run.runSkillReviews()

    expect(run.skillReviews[0].state.status).toBe('error')
    const skillId = run.skillReviews[0].skillId

    await run.retrySkill(skillId)

    expect(run.skillReviews[0].state.status).toBe('done')
    expect(run.skillReviews[0].state.value).toEqual(result)
    // Two LLM invocations: original failure + the retry (cache never served it).
    expect(llmFn).toHaveBeenCalledTimes(2)
  })

  it('sets the targeted entry to loading during the retry without resolving others', async () => {
    addSkill('Reviewer A', 'a')
    addSkill('Reviewer B', 'b')

    // Both fail initially; A's retry hangs so we can observe loading.
    const llmFn = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementationOnce(() => new Promise(() => { /* hang */ }))
    const deps = makeStubDeps({ llmJsonWithRepair: llmFn })

    const run = createAiRun(makeStubInput(), deps)
    await run.runSkillReviews()

    const a = run.skillReviews.find(e => e.name === 'Reviewer A')!
    const b = run.skillReviews.find(e => e.name === 'Reviewer B')!
    expect(a.state.status).toBe('error')
    expect(b.state.status).toBe('error')

    const retryPromise = run.retrySkill(a.skillId)
    await new Promise(r => setTimeout(r, 0))

    // A is loading; B is untouched (still error).
    expect(run.skillReviews.find(e => e.name === 'Reviewer A')!.state.status).toBe('loading')
    expect(run.skillReviews.find(e => e.name === 'Reviewer B')!.state.status).toBe('error')

    retryPromise.catch(() => { /* ignore the hanging promise */ })
  })

  it('does nothing for an unknown skill id (no entries exist / wrong id)', async () => {
    addSkill('Reviewer', 'content')
    const deps = makeStubDeps({ llmJsonWithRepair: vi.fn().mockResolvedValue({ findings: [] }) })
    const run = createAiRun(makeStubInput(), deps)
    await run.runSkillReviews()

    const before = run.skillReviews.map(e => e.state.status)
    await run.retrySkill('does-not-exist')
    const after = run.skillReviews.map(e => e.state.status)
    expect(after).toEqual(before)
  })

  it('fires onUpdate callbacks during the retry', async () => {
    addSkill('Reviewer', 'content')
    const llmFn = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ findings: [] })
    const deps = makeStubDeps({ llmJsonWithRepair: llmFn })
    const run = createAiRun(makeStubInput(), deps)
    await run.runSkillReviews()

    const onUpdate = vi.fn()
    await run.retrySkill(run.skillReviews[0].skillId, onUpdate)
    expect(onUpdate).toHaveBeenCalled()
  })
})
