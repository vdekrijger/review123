/**
 * fixVerifyRun — the seam between the pure pass and the app: personas, the
 * model panel, and the cache that stops re-opening the panel re-spending.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  fixVerifyCacheKey,
  fixVerifyShape,
  verifyAgentFix,
  verifyAgentFixDetailed,
  type AgentFixChangeInput,
  type AgentFixFindingInput,
  type FixVerifyDeps,
} from './fixVerifyRun'
import type { FixVerifyParticipant } from './fixVerify'
import type { ProviderConfig } from '../llm/llm'

const HEAD = 'a'.repeat(40)

const cfg = (id: string): ProviderConfig =>
  ({ providerId: 'openai', model: { id }, key: 'k' }) as unknown as ProviderConfig

const panel = (...models: string[]): FixVerifyParticipant[] =>
  models.map((m) => ({ provider: `P-${m}`, model: m, cfg: cfg(m) }))

const change = (findingId: string, over: Partial<AgentFixChangeInput> = {}): AgentFixChangeInput => ({
  findingId,
  commit: `${findingId}commit`,
  intent: 'made the smallest change',
  diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
  truncated: false,
  ...over,
})

const finding = (key: string, over: Partial<AgentFixFindingInput> = {}): AgentFixFindingInput => ({
  key,
  skillName: 'Security',
  path: 'src/x.ts',
  line: 3,
  body: 'unsafe',
  suggestedFix: 'make it safe',
  ...over,
})

/** Deps with no network, no IDB and no settings — every default overridden. */
function deps(over: Partial<FixVerifyDeps> = {}): Partial<FixVerifyDeps> {
  return {
    personaContent: () => 'PERSONA BODY',
    participants: () => panel('m1'),
    complete: vi.fn(async () => ({
      result: { reReads: [{ id: 'f1', verdict: 'still-standing' as const, reason: 'r' }], newProblems: [] },
    })) as unknown as FixVerifyDeps['complete'],
    readCache: async () => null,
    writeCache: async () => {},
    ...over,
  }
}

describe('verifyAgentFix — batching by persona', () => {
  it('asks the persona that RAISED each finding, with its own content', async () => {
    const seen: { system: string; model: string }[] = []
    await verifyAgentFix(
      HEAD,
      [change('f1'), change('f2')],
      [finding('f1', { skillName: 'Security' }), finding('f2', { skillName: 'Performance' })],
      deps({
        personaContent: (name) => `BODY OF ${name}`,
        complete: (async (c: ProviderConfig, opts: { system: string }) => {
          seen.push({ system: opts.system, model: c.model.id })
          return { result: { reReads: [], newProblems: [] } }
        }) as unknown as FixVerifyDeps['complete'],
      }),
    )
    // One call per persona, each carrying its OWN criterion — not the other's.
    expect(seen).toHaveLength(2)
    expect(seen.some((s) => s.system.includes('BODY OF Security'))).toBe(true)
    expect(seen.some((s) => s.system.includes('BODY OF Performance'))).toBe(true)
  })

  it('polls every model in the panel, so models that did not raise it are present', async () => {
    const complete = vi.fn(async () => ({ result: { reReads: [], newProblems: [] } }))
    await verifyAgentFix(
      HEAD,
      [change('f1')],
      [finding('f1')],
      deps({
        participants: () => panel('m1', 'm2', 'm3'),
        complete: complete as unknown as FixVerifyDeps['complete'],
      }),
    )
    expect(complete).toHaveBeenCalledTimes(3)
  })

  it('still re-reads a finding whose persona the user has since deleted', async () => {
    const seen: string[] = []
    const report = await verifyAgentFix(
      HEAD,
      [change('f1')],
      [finding('f1', { skillName: 'Deleted reviewer' })],
      deps({
        personaContent: () => null,
        complete: (async (_c: ProviderConfig, opts: { system: string }) => {
          seen.push(opts.system)
          return { result: { reReads: [{ id: 'f1', verdict: 'unsure' as const, reason: '' }], newProblems: [] } }
        }) as unknown as FixVerifyDeps['complete'],
      }),
    )
    expect(seen[0]).toContain('Deleted reviewer')
    expect(report.byFinding[0].outcome).toBe('could-not-tell')
  })

  it('ignores a change it cannot attribute to a finding', async () => {
    const complete = vi.fn(async () => ({ result: { reReads: [], newProblems: [] } }))
    const report = await verifyAgentFix(
      HEAD,
      [change('ghost')],
      [finding('f1')],
      deps({ complete: complete as unknown as FixVerifyDeps['complete'] }),
    )
    expect(complete).not.toHaveBeenCalled()
    expect(report.byFinding).toEqual([])
  })

  it('spends nothing on a run that produced only SKIPS', async () => {
    // A refused / agent-failed / no-change finding has no commit, so there is
    // no diff to re-read and no model call to make. Structural: skips never
    // enter `changes`, and the panel does not start the pass without one.
    const complete = vi.fn(async () => ({ result: { reReads: [], newProblems: [] } }))
    const report = await verifyAgentFix(
      HEAD,
      [],
      [finding('f1')],
      deps({ complete: complete as unknown as FixVerifyDeps['complete'] }),
    )
    expect(complete).not.toHaveBeenCalled()
    expect(report.calls).toBe(0)
    expect(report.byFinding).toEqual([])
  })

  it('reports not-re-read — never silence — when there is no model configured', async () => {
    const report = await verifyAgentFix(
      HEAD,
      [change('f1')],
      [finding('f1')],
      deps({ participants: () => [] }),
    )
    expect(report.byFinding).toHaveLength(1)
    expect(report.byFinding[0].outcome).toBe('not-re-read')
  })
})

describe('verifyAgentFix — caching', () => {
  it('returns the cached report without calling a model', async () => {
    const complete = vi.fn(async () => ({ result: { reReads: [], newProblems: [] } }))
    const cached = {
      byFinding: [],
      newProblems: [],
      witnesses: ['Security · P-m1'],
      calls: 1,
      failedCalls: 0,
    }
    const report = await verifyAgentFix(
      HEAD,
      [change('f1')],
      [finding('f1')],
      deps({
        readCache: (async () => cached) as unknown as FixVerifyDeps['readCache'],
        complete: complete as unknown as FixVerifyDeps['complete'],
      }),
    )
    expect(complete).not.toHaveBeenCalled()
    expect(report).toBe(cached)
  })

  it('writes a completed report to the cache', async () => {
    const writeCache = vi.fn(async () => {})
    await verifyAgentFix(HEAD, [change('f1')], [finding('f1')], deps({ writeCache }))
    expect(writeCache).toHaveBeenCalledTimes(1)
  })

  it('does NOT cache a report in which every call failed', async () => {
    // Otherwise "not re-read" pins forever and the obvious retry never reaches
    // a model.
    const writeCache = vi.fn(async () => {})
    const report = await verifyAgentFix(
      HEAD,
      [change('f1')],
      [finding('f1')],
      deps({
        writeCache,
        complete: (async () => {
          throw new Error('down')
        }) as unknown as FixVerifyDeps['complete'],
      }),
    )
    expect(report.byFinding[0].outcome).toBe('not-re-read')
    expect(writeCache).not.toHaveBeenCalled()
  })
})

describe('fixVerifyCacheKey', () => {
  it('is stable for the same commits whatever order they arrive in', () => {
    const a = fixVerifyCacheKey(HEAD, [change('f1'), change('f2')], ['m1'])
    const b = fixVerifyCacheKey(HEAD, [change('f2'), change('f1')], ['m1'])
    expect(a).toBe(b)
  })

  it('misses when the agent produced DIFFERENT commits', () => {
    const a = fixVerifyCacheKey(HEAD, [change('f1', { commit: 'aaa' })], ['m1'])
    const b = fixVerifyCacheKey(HEAD, [change('f1', { commit: 'bbb' })], ['m1'])
    expect(a).not.toBe(b)
  })

  it('misses when a different set of findings was sent', () => {
    const a = fixVerifyCacheKey(HEAD, [change('f1')], ['m1'])
    const b = fixVerifyCacheKey(HEAD, [change('f1'), change('f2')], ['m1'])
    expect(a).not.toBe(b)
  })

  it('misses when the model panel changed — a different poll is a different answer', () => {
    const a = fixVerifyCacheKey(HEAD, [change('f1')], ['m1'])
    const b = fixVerifyCacheKey(HEAD, [change('f1')], ['m1', 'm2'])
    expect(a).not.toBe(b)
  })

  it('carries the pass’s own prompt version, not another task’s', () => {
    expect(fixVerifyCacheKey(HEAD, [change('f1')], ['m1'])).toMatch(/\|fixVerify:[0-9a-f]+\|v1$/)
  })
})

// ---------------------------------------------------------------------------
// Reporting on the pass — counts and enums, never a word of it
// ---------------------------------------------------------------------------

describe('verifyAgentFixDetailed', () => {
  it('separates a fresh poll from a cache hit', async () => {
    const fresh = await verifyAgentFixDetailed(HEAD, [change('f1')], [finding('f1')], deps())
    expect(fresh.cached).toBe(false)
    expect(fresh.report.calls).toBeGreaterThan(0)

    const hit = await verifyAgentFixDetailed(
      HEAD,
      [change('f1')],
      [finding('f1')],
      deps({
        readCache: async () =>
          ({ byFinding: [], newProblems: [], witnesses: [], calls: 4, failedCalls: 0 }) as never,
      }),
    )
    expect(hit.cached).toBe(true)
  })

  // A pass with nothing to re-read spent nothing AND read nothing. Reporting it
  // as a cache hit would claim a saving that never existed.
  it('does not call an empty pass cached', async () => {
    const empty = await verifyAgentFixDetailed(HEAD, [], [], deps())
    expect(empty.cached).toBe(false)
    expect(empty.report.calls).toBe(0)
  })
})

describe('fixVerifyShape', () => {
  it('is counts, enums and one boolean — and carries nothing anyone said', () => {
    const shape = fixVerifyShape({
      cached: false,
      durationMs: 1234.7,
      report: {
        byFinding: [
          { findingId: 'f1', persona: 'Security', outcome: 'still-standing', votes: [], polledModels: 2, agreeing: 2 },
          { findingId: 'f2', persona: 'Security', outcome: 'not-raised-again', votes: [], polledModels: 2, agreeing: 1 },
          { findingId: 'f3', persona: 'Perf', outcome: 'could-not-tell', votes: [], polledModels: 2, agreeing: 1 },
          { findingId: 'f4', persona: 'Perf', outcome: 'not-re-read', votes: [], polledModels: 0, agreeing: 0 },
        ],
        newProblems: [
          {
            key: 'np1',
            path: 'src/secret.ts',
            line: 9,
            severity: 'high',
            body: 'The new escape helper throws on null',
            suggestedFix: 'guard it',
            raisedBy: ['Anthropic · claude'],
            polledModels: 2,
          },
        ],
        witnesses: ['Anthropic · claude-x', 'OpenAI · gpt-y'],
        calls: 4,
        failedCalls: 1,
      },
    })

    expect(shape).toEqual({
      findings: 4,
      still_standing: 1,
      not_raised_again: 1,
      could_not_tell: 1,
      not_re_read: 1,
      new_problems: 1,
      models: 2,
      failed_calls: 1,
      cached: false,
      duration_ms: 1235,
    })

    // The whole payload, stringified, carries no persona, path, body or model.
    const blob = JSON.stringify(shape)
    for (const leak of ['Security', 'src/secret.ts', 'escape helper', 'claude', 'OpenAI']) {
      expect(blob).not.toContain(leak)
    }
  })
})
