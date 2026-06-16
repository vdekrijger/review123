/**
 * Integration: cross-model verification inside the AI run (Plan M).
 *
 * Verifies that when verification is EFFECTIVE (≥2 provider keys + setting on),
 * skill-review findings carry an aggregated `verification`; and that when it is
 * NOT effective (single key), the run is byte-identical — no verifier call, no
 * verification attached.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAiRun } from './run.svelte'
import type { PackedContext } from '../context/pack'
import type { SkillReviewResult, VerdictResult } from './schemas'
import {
  setDeepseekKey,
  setAnthropicKey,
  setOpenaiKey,
  setAiProvider,
  setAiPanel,
} from '../settings/settings'
import { djb2 } from '../viewed/viewed.svelte'

const PACKED_CTX: PackedContext = {
  text: 'pr context',
  notAnalyzed: [],
  includedFiles: ['src/foo.ts'],
  importGraph: '',
}

const SKILL_RESULT: SkillReviewResult = {
  skillName: 'My Reviewer',
  findings: [
    { path: 'src/foo.ts', line: 10, severity: 'high', body: 'a real bug here' },
    { path: 'src/foo.ts', line: 20, severity: 'low', body: 'a style nit there' },
  ],
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const gateAi = vi.fn().mockResolvedValue(true)
  const getCached = vi.fn().mockResolvedValue(null)
  const setCached = vi.fn().mockResolvedValue(undefined)
  const llmStream = vi.fn()
  const llmStreamWithUsage = vi.fn()
  const llmJsonWithRepair = vi.fn()
  const llmJsonWithRepairWithUsage = vi.fn().mockImplementation(async () => ({
    result: SKILL_RESULT,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }))
  const llmToolLoop = vi.fn()
  const track = vi.fn()
  return {
    gateAi,
    getCached,
    setCached,
    llmStream,
    llmStreamWithUsage,
    llmJsonWithRepair,
    llmJsonWithRepairWithUsage,
    llmToolLoop,
    track,
    ...overrides,
  }
}

function makeInput() {
  return {
    prKey: 'owner/repo#1@abc',
    repo: 'owner/repo',
    isPrivate: false,
    pack: async () => PACKED_CTX,
    ci: async () => null,
    ask: async () => true,
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('cross-model verification in runSkillReviews', () => {
  it('attaches verification when effective (≥2 keys + setting default-on)', async () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')

    const { addSkill } = await import('../skills/skills')
    addSkill('My Reviewer', 'find bugs')

    // Verifier confirms the real bug, refutes the nit.
    const llmJsonWithRepairFor = vi.fn().mockImplementation(async (_cfg, _opts, validate) => {
      const resp = {
        verdicts: [
          { id: 'src/foo.ts:10:' + djb2('a real bug here'), verdict: 'confirm', reason: 'real' },
          { id: 'src/foo.ts:20:' + djb2('a style nit there'), verdict: 'refute', reason: 'nit' },
        ],
      }
      return { result: validate(resp), usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }
    })

    const run = createAiRun(makeInput(), makeDeps({ llmJsonWithRepairFor }))
    await run.runSkillReviews()

    expect(llmJsonWithRepairFor).toHaveBeenCalled()
    const result = run.skillReviews[0].state.value as SkillReviewResult
    const bug = result.findings.find((f) => f.line === 10)!
    const nit = result.findings.find((f) => f.line === 20)!
    expect(bug.verification).toBeDefined()
    // generator(1)+confirm(1)=2, polled 2, half 1 → surfaced
    expect(bug.verification!.surfaced).toBe(true)
    expect(bug.verification!.confirmedBy).toBe(2)
    // generator(1)+refute(0)=1, polled 2, half 1 → 1>=1 tie surfaces with ONE verifier
    expect(nit.verification!.surfaced).toBe(true)
    expect(nit.verification!.confirmedBy).toBe(1)
  })

  it('demotes a finding when two verifiers refute it', async () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')
    setOpenaiKey('o')

    const { addSkill } = await import('../skills/skills')
    addSkill('My Reviewer', 'find bugs')

    const llmJsonWithRepairFor = vi.fn().mockImplementation(async (_cfg, _opts, validate) => {
      const resp = {
        verdicts: [
          { id: 'src/foo.ts:10:' + djb2('a real bug here'), verdict: 'confirm', reason: 'real' },
          { id: 'src/foo.ts:20:' + djb2('a style nit there'), verdict: 'refute', reason: 'nit' },
        ],
      }
      return { result: validate(resp), usage: undefined }
    })

    const run = createAiRun(makeInput(), makeDeps({ llmJsonWithRepairFor }))
    await run.runSkillReviews()

    const result = run.skillReviews[0].state.value as SkillReviewResult
    const nit = result.findings.find((f) => f.line === 20)!
    // generator(1)+refute+refute = 1, polled 3, half 1.5 → 1 < 1.5 → demoted
    expect(nit.verification!.surfaced).toBe(false)
  })

  it('is a no-op (no verifier call, no verification) with a single key', async () => {
    setAiProvider('deepseek')
    setDeepseekKey('k') // only one key

    const { addSkill } = await import('../skills/skills')
    addSkill('My Reviewer', 'find bugs')

    const llmJsonWithRepairFor = vi.fn()
    const run = createAiRun(makeInput(), makeDeps({ llmJsonWithRepairFor }))
    await run.runSkillReviews()

    expect(llmJsonWithRepairFor).not.toHaveBeenCalled()
    const result = run.skillReviews[0].state.value as SkillReviewResult
    expect(result.findings.every((f) => f.verification === undefined)).toBe(true)
  })

  it('runs verification with a SINGLE provider key + 2-model ensemble (Plan N unlock)', async () => {
    // Only ONE key (anthropic), but a custom ensemble with two anthropic models
    // → cross-verify is effective and the verifier model is called.
    setAiProvider('anthropic')
    setAnthropicKey('a')
    setAiPanel({ participants: [
      { provider: 'anthropic', model: 'claude-opus-4-8', role: 'generator' },
      { provider: 'anthropic', model: 'claude-haiku-4-5', role: 'verifier' },
    ] })

    const { addSkill } = await import('../skills/skills')
    addSkill('My Reviewer', 'find bugs')

    const seenModels: string[] = []
    const llmJsonWithRepairFor = vi.fn().mockImplementation(async (cfg, _opts, validate) => {
      seenModels.push(cfg.model.id)
      const resp = {
        verdicts: [
          { id: 'src/foo.ts:10:' + djb2('a real bug here'), verdict: 'confirm', reason: 'real' },
          { id: 'src/foo.ts:20:' + djb2('a style nit there'), verdict: 'confirm', reason: 'ok' },
        ],
      }
      return { result: validate(resp), usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }
    })

    const run = createAiRun(makeInput(), makeDeps({ llmJsonWithRepairFor }))
    await run.runSkillReviews()

    // The verifier model (haiku) was called even though only ONE provider key exists.
    expect(seenModels).toEqual(['claude-haiku-4-5'])
    const result = run.skillReviews[0].state.value as SkillReviewResult
    expect(result.findings.find((f) => f.line === 10)!.verification!.surfaced).toBe(true)
  })

  it('a verifier failure never drops the findings (shown unverified)', async () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')

    const { addSkill } = await import('../skills/skills')
    addSkill('My Reviewer', 'find bugs')

    const llmJsonWithRepairFor = vi.fn().mockRejectedValue(new Error('verifier down'))
    const run = createAiRun(makeInput(), makeDeps({ llmJsonWithRepairFor }))
    await run.runSkillReviews()

    const result = run.skillReviews[0].state.value as SkillReviewResult
    expect(result.findings.length).toBe(2) // original findings intact
    expect(result.findings.every((f) => f.verification === undefined)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Plan P — multi-generator fusion (emergent 'generate' mode) inside the run
// ---------------------------------------------------------------------------

describe('multi-generator fusion in runSkillReviews (Plan P)', () => {
  it('model B raises a finding A missed and both confirm → it surfaces with raisedBy', async () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')
    // Two generators (emergent 'generate' mode).
    setAiPanel({ participants: [
      { provider: 'deepseek', model: 'deepseek-v4-flash', role: 'generator' },
      { provider: 'anthropic', model: 'claude-opus-4-8', role: 'generator' },
    ] })

    const { addSkill } = await import('../skills/skills')
    addSkill('My Reviewer', 'find bugs')

    // Each generator finds a DIFFERENT bug; both confirm each other's on verify.
    // The mock distinguishes a SKILL-REVIEW call (validate accepts a skillName
    // shape) from a VERIFY call (validate accepts a verdicts shape) by trying both.
    const GEN_BY_PROVIDER: Record<string, SkillReviewResult> = {
      deepseek: { skillName: 'My Reviewer', findings: [{ path: 'src/foo.ts', line: 10, severity: 'high', body: 'deepseek-only bug' }] },
      anthropic: { skillName: 'My Reviewer', findings: [{ path: 'src/foo.ts', line: 50, severity: 'high', body: 'anthropic-only bug' }] },
    }

    const llmJsonWithRepairFor = vi.fn().mockImplementation(async (cfg, _opts, validate) => {
      // Is this a skill-review generation call? (the per-provider generator)
      const gen = GEN_BY_PROVIDER[cfg.providerId]
      if (gen && validate(gen) !== null) {
        return { result: gen, usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }
      }
      // Otherwise it's a verify call — confirm every finding presented.
      const probe = validate({ verdicts: [] })
      if (probe !== null) {
        // We don't know the ids up front; confirm all by echoing a wildcard is not
        // possible, so confirm specific ids via the prompt is overkill — instead
        // return an empty verdicts set, which the aggregator treats as 'uncertain'
        // (neutral 0.5) for non-raisers. With 2 participants and 1 raiser, a single
        // neutral verifier: raiser(1)+uncertain(0.5)=1.5, polled 2, half 1 → surface.
        return { result: { verdicts: [] }, usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }
      }
      return { result: validate(gen ?? {}), usage: undefined }
    })

    const run = createAiRun(makeInput(), makeDeps({ llmJsonWithRepairFor }))
    await run.runSkillReviews()

    const result = run.skillReviews[0].state.value as SkillReviewResult
    const bodies = result.findings.map((f) => f.body)
    // The union contains BOTH generators' unique findings (recall).
    expect(bodies).toContain('deepseek-only bug')
    expect(bodies).toContain('anthropic-only bug')
    // Both surfaced (raiser + neutral verifier ties to surface).
    expect(result.findings.every((f) => f.verification?.surfaced)).toBe(true)
    // Each carries raisedBy provenance.
    expect(result.findings.every((f) => Array.isArray(f.raisedBy) && f.raisedBy!.length >= 1)).toBe(true)
  })

  it("'verify' mode (default, 1 generator) does NOT multi-generate — single generator path", async () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')
    // Default panel = 1 generator → emergent 'verify' mode.

    const { addSkill } = await import('../skills/skills')
    addSkill('My Reviewer', 'find bugs')

    const forCalls: string[] = []
    const llmJsonWithRepairFor = vi.fn().mockImplementation(async (cfg, _opts, validate) => {
      forCalls.push(cfg.providerId)
      return { result: validate({ verdicts: [] }), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    })

    const run = createAiRun(makeInput(), makeDeps({ llmJsonWithRepairFor }))
    await run.runSkillReviews()

    // In verify mode the generator uses llmJsonWithRepairWithUsage (the active
    // model), NOT llmJsonWithRepairFor for generation — so 'for' is only the
    // verifier (anthropic), never the deepseek generator.
    expect(forCalls).not.toContain('deepseek')
    const result = run.skillReviews[0].state.value as SkillReviewResult
    // The verify-mode result is the SKILL_RESULT generated by the active model.
    expect(result.findings.some((f) => f.body === 'a real bug here')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Plan P — multi-generator fusion for the VERDICT task ('generate' mode)
// ---------------------------------------------------------------------------

/**
 * The verdict task is exercised via run.start(). Only the verdict assertions
 * matter here; the other tasks' outputs are irrelevant to these tests. The
 * per-generator verdict generation goes through llmJsonWithRepairFor (one call
 * per generator, own provider cfg); cross-confirm + non-verdict tasks also use
 * llmJsonWithRepairFor / the WithUsage stub.
 */
describe('multi-generator fusion in runVerdictTask (Plan P)', () => {
  // Each generator returns a verdict with its OWN unique evidence bullet and its
  // own holistic level. DeepSeek is the PRIMARY (first-listed) generator.
  const VERDICT_BY_PROVIDER: Record<string, VerdictResult> = {
    deepseek: { level: 'minor-changes', evidence: ['src/foo.ts deepseek-only evidence'], notAnalyzed: [] },
    anthropic: { level: 'significant-changes', evidence: ['src/bar.ts anthropic-only evidence'], notAnalyzed: [] },
  }

  function makeVerdictDeps() {
    // The per-generator verdict + the cross-confirm verify calls both flow
    // through llmJsonWithRepairFor; distinguish by trying the validators.
    const llmJsonWithRepairFor = vi.fn().mockImplementation(async (cfg, _opts, validate) => {
      const v = VERDICT_BY_PROVIDER[cfg.providerId]
      if (v && validate(v) !== null) {
        return { result: v, usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }
      }
      // A verify call → empty verdicts (neutral 'uncertain' for non-raisers);
      // with 2 participants + 1 raiser this ties to surface (raiser 1 + 0.5 ≥ 1).
      const probe = validate({ verdicts: [] })
      if (probe !== null) {
        return { result: { verdicts: [] }, usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }
      }
      // Any other task generated through 'for' (none expected) — best effort.
      return { result: validate(v ?? {}), usage: undefined }
    })
    return makeDeps({ llmJsonWithRepairFor })
  }

  it('2 generators → verdict has TWO generator rows; evidence unioned with raisedBy; primary level used', async () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')
    // Two generators → emergent 'generate' mode.
    setAiPanel({ participants: [
      { provider: 'deepseek', model: 'deepseek-v4-flash', role: 'generator' },
      { provider: 'anthropic', model: 'claude-opus-4-8', role: 'generator' },
    ] })

    const run = createAiRun(makeInput(), makeVerdictDeps())
    await run.start()

    expect(run.verdict.status).toBe('done')
    const verdict = run.verdict.value as VerdictResult

    // The holistic level is the PRIMARY (deepseek) generator's, NOT anthropic's.
    expect(verdict.level).toBe('minor-changes')

    // Evidence from BOTH generators is unioned (recall) — each only one raised.
    expect(verdict.evidence).toContain('src/foo.ts deepseek-only evidence')
    expect(verdict.evidence).toContain('src/bar.ts anthropic-only evidence')

    // Each evidence row carries raisedBy provenance.
    expect(verdict.evidenceRaisedBy).toBeDefined()
    const raisers = Object.values(verdict.evidenceRaisedBy!).flat()
    expect(raisers.some((r) => /deepseek/i.test(r))).toBe(true)
    expect(raisers.some((r) => /anthropic/i.test(r))).toBe(true)

    // TWO generator rows in the per-model breakdown (one per configured generator).
    const generatorRows = run.verdictModels.filter((m) => m.role === 'generator')
    expect(generatorRows).toHaveLength(2)
    const generatorProviders = generatorRows.map((m) => m.providerId).sort()
    expect(generatorProviders).toEqual(['anthropic', 'deepseek'])
    // Both generator rows carry usage + a surfaced count.
    expect(generatorRows.every((m) => m.usage !== undefined)).toBe(true)
    expect(generatorRows.every((m) => typeof m.surfaced === 'number')).toBe(true)

    // Flows through the consolidated aggregate getter too.
    const aggGenerators = run.modelPerformance.filter((m) => m.role === 'generator')
    expect(aggGenerators.length).toBeGreaterThanOrEqual(2)
  })

  it('verify mode (1 generator) → ONE generator row + verifier rows (unchanged)', async () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')
    // Default panel = 1 generator (deepseek active) + anthropic verifier → 'verify'.

    // The single-generator verdict is produced by the active model via the
    // WithUsage stub; make it a real verdict so the verify path runs over it.
    const deps = makeDeps()
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_opts: unknown, validate: (x: unknown) => unknown) => {
      const v = VERDICT_BY_PROVIDER.deepseek
      if (validate(v) !== null) return { result: v, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      return { result: validate({ skillName: 'x', findings: [] }), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    })
    // Verifier (anthropic) confirms via llmJsonWithRepairFor.
    deps.llmJsonWithRepairFor = vi.fn().mockImplementation(async (_cfg: unknown, _opts: unknown, validate: (x: unknown) => unknown) => {
      return { result: validate({ verdicts: [] }), usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }
    })

    const run = createAiRun(makeInput(), deps)
    await run.start()

    expect(run.verdict.status).toBe('done')
    const generatorRows = run.verdictModels.filter((m) => m.role === 'generator')
    // Exactly ONE generator row (the single configured generator) — unchanged.
    expect(generatorRows).toHaveLength(1)
    expect(generatorRows[0].providerId).toBe('deepseek')
  })
})
