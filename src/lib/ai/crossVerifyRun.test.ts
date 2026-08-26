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
  setGeminiKey,
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
    // Verifier (anthropic) confirms via llmJsonWithRepairFor — pass it through
    // makeDeps (the supported override) so the deps type carries the property.
    const llmJsonWithRepairFor = vi.fn().mockImplementation(async (_cfg: unknown, _opts: unknown, validate: (x: unknown) => unknown) => {
      return { result: validate({ verdicts: [] }), usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }
    })
    const deps = makeDeps({ llmJsonWithRepairFor })
    deps.llmJsonWithRepairWithUsage.mockImplementation(async (_opts: unknown, validate: (x: unknown) => unknown) => {
      const v = VERDICT_BY_PROVIDER.deepseek
      if (validate(v) !== null) return { result: v, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      return { result: validate({ skillName: 'x', findings: [] }), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
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

// ---------------------------------------------------------------------------
// Part B — tool-backed verification of absence/external-evidence findings
// ---------------------------------------------------------------------------

/** Skill review whose finding is an ABSENCE claim ("no test covers fooBar"). */
const ABSENCE_SKILL_RESULT: SkillReviewResult = {
  skillName: 'My Reviewer',
  findings: [{ path: 'src/foo.ts', line: 10, severity: 'high', body: 'no test covers fooBar' }],
}

/** A deepReview source stub — search/read fns are driven by the test. */
function makeDeepSource(overrides: Record<string, unknown> = {}) {
  return {
    getFileAtHead: vi.fn(async () => null),
    getFileAtBase: vi.fn(async () => null),
    searchCode: vi.fn(async () => ''),
    findReferences: vi.fn(async () => ''),
    ...overrides,
  }
}

describe('tool-backed absence verification in runSkillReviews (Part B)', () => {
  it('no deepReview source (tools unavailable) → absence finding DEMOTED by the prompt floor', async () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')

    const { addSkill } = await import('../skills/skills')
    addSkill('My Reviewer', 'find bugs')

    // Generator (active model) returns the absence finding; verifier CONFIRMS it.
    const llmJsonWithRepairWithUsage = vi.fn().mockResolvedValue({
      result: ABSENCE_SKILL_RESULT,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
    const llmJsonWithRepairFor = vi.fn().mockImplementation(async (_cfg, _opts, validate) => {
      const resp = { verdicts: [{ id: 'src/foo.ts:10:' + djb2('no test covers fooBar'), verdict: 'confirm', reason: 'plausible' }] }
      return { result: validate(resp), usage: undefined }
    })
    const llmToolLoop = vi.fn() // must NOT be called (no source)

    // No `deepReview` in input → tool-backed verification is gated off.
    const run = createAiRun(makeInput(), makeDeps({ llmJsonWithRepairWithUsage, llmJsonWithRepairFor, llmToolLoop }))
    await run.runSkillReviews()

    expect(llmToolLoop).not.toHaveBeenCalled()
    const result = run.skillReviews[0].state.value as SkillReviewResult
    const f = result.findings[0]
    // Even though the verifier confirmed, the unverified absence is demoted.
    expect(f.verification!.surfaced).toBe(false)
  })

  it('tool check FINDS a matching test (search_code) → REFUTED/demoted', async () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')

    const { addSkill } = await import('../skills/skills')
    addSkill('My Reviewer', 'find bugs')

    const llmJsonWithRepairWithUsage = vi.fn().mockResolvedValue({
      result: ABSENCE_SKILL_RESULT,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
    const llmJsonWithRepairFor = vi.fn().mockImplementation(async (_cfg, _opts, validate) => {
      const resp = { verdicts: [{ id: 'src/foo.ts:10:' + djb2('no test covers fooBar'), verdict: 'confirm', reason: 'plausible' }] }
      return { result: validate(resp), usage: undefined }
    })
    // With a deep source, the tool loop serves TWO surfaces: the GROUNDED
    // verifier call (adversarial system prompt → a VerifierResponse) and the
    // Part B absence check (single-claim prompt → {"verdict"}). Discriminate
    // by system content, exactly like the real models would see.
    const llmToolLoop = vi.fn().mockImplementation(async (opts: { system: string }) => {
      if (/ADVERSARIAL verifier/i.test(opts.system)) {
        // Grounded verifier: confirms without needing a lookup.
        return {
          content: JSON.stringify({ verdicts: [{ id: 'src/foo.ts:10:' + djb2('no test covers fooBar'), verdict: 'confirm', reason: 'plausible' }] }),
          usage: undefined,
          toolCallsUsed: 0,
        }
      }
      // Absence check: searched and FOUND the test → refute.
      return { content: JSON.stringify({ verdict: 'refute' }), usage: undefined, toolCallsUsed: 1 }
    })

    const source = makeDeepSource({ searchCode: vi.fn(async () => 'src/foo.test.ts: describe(fooBar)') })
    const run = createAiRun(
      { ...makeInput(), deepReview: source },
      makeDeps({ llmJsonWithRepairWithUsage, llmJsonWithRepairFor, llmToolLoop }),
    )
    await run.runSkillReviews()

    // Both loop surfaces ran: 1 grounded verifier call + 1 absence check.
    expect(llmToolLoop).toHaveBeenCalledTimes(2)
    const result = run.skillReviews[0].state.value as SkillReviewResult
    expect(result.findings[0].verification!.surfaced).toBe(false)
  })

  it('tool check finds NOTHING (confirm) → absence verified → SURFACES', async () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')

    const { addSkill } = await import('../skills/skills')
    addSkill('My Reviewer', 'find bugs')

    const llmJsonWithRepairWithUsage = vi.fn().mockResolvedValue({
      result: ABSENCE_SKILL_RESULT,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
    const llmJsonWithRepairFor = vi.fn().mockImplementation(async (_cfg, _opts, validate) => {
      const resp = { verdicts: [{ id: 'src/foo.ts:10:' + djb2('no test covers fooBar'), verdict: 'confirm', reason: 'real gap' }] }
      return { result: validate(resp), usage: undefined }
    })
    // The tool loop searched and found NOTHING → confirm the absence.
    const llmToolLoop = vi.fn().mockResolvedValue({
      content: JSON.stringify({ verdict: 'confirm' }),
      usage: undefined,
      toolCallsUsed: 2,
    })

    const run = createAiRun(
      { ...makeInput(), deepReview: makeDeepSource() },
      makeDeps({ llmJsonWithRepairWithUsage, llmJsonWithRepairFor, llmToolLoop }),
    )
    await run.runSkillReviews()

    expect(llmToolLoop).toHaveBeenCalled()
    const result = run.skillReviews[0].state.value as SkillReviewResult
    // Absence positively verified + verifier confirmed → surfaces.
    expect(result.findings[0].verification!.surfaced).toBe(true)
  })

  it('single key (cross-verify off) → no verifier call AND no tool loop (no-op path)', async () => {
    setAiProvider('deepseek')
    setDeepseekKey('k') // only one key → cross-verify not effective

    const { addSkill } = await import('../skills/skills')
    addSkill('My Reviewer', 'find bugs')

    const llmJsonWithRepairWithUsage = vi.fn().mockResolvedValue({
      result: ABSENCE_SKILL_RESULT,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
    const llmJsonWithRepairFor = vi.fn()
    const llmToolLoop = vi.fn()

    const run = createAiRun(
      { ...makeInput(), deepReview: makeDeepSource() },
      makeDeps({ llmJsonWithRepairWithUsage, llmJsonWithRepairFor, llmToolLoop }),
    )
    await run.runSkillReviews()

    expect(llmJsonWithRepairFor).not.toHaveBeenCalled()
    expect(llmToolLoop).not.toHaveBeenCalled()
    const result = run.skillReviews[0].state.value as SkillReviewResult
    // No verification ran → finding shown unverified (never dropped).
    expect(result.findings[0].verification).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Honoring configured roles — NO silent demotion (the user's complaint)
//
// A configured Generator must ALWAYS be attributed as a generator, even when it
// (and its peers) surface ZERO findings. Before the fix, the run bailed to the
// single-generator path whenever fewer than 2 generators PRODUCED findings — so
// a 0-finding review demoted the second generator to a verifier. These tests
// pin that down.
// ---------------------------------------------------------------------------

describe('generators always generate (no silent demotion) — skill reviews', () => {
  const TWO_GENERATORS = [
    { provider: 'deepseek' as const, model: 'deepseek-v4-flash', role: 'generator' as const },
    { provider: 'anthropic' as const, model: 'claude-opus-4-8', role: 'generator' as const },
  ]

  it('2 generators producing ZERO findings → BOTH still generator rows (not verifiers)', async () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')
    setAiPanel({ participants: TWO_GENERATORS })

    const { addSkill } = await import('../skills/skills')
    addSkill('My Reviewer', 'find bugs')

    // Every generator returns an EMPTY finding set (a valid generated result).
    const llmJsonWithRepairFor = vi.fn().mockImplementation(async (cfg, _opts, validate) => {
      const empty = { skillName: 'My Reviewer', findings: [] }
      if (validate(empty) !== null) {
        return { result: empty, usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }
      }
      // A verify call (shouldn't happen with 0 merged findings) — neutral.
      return { result: validate({ verdicts: [] }), usage: undefined }
    })

    const run = createAiRun(makeInput(), makeDeps({ llmJsonWithRepairFor }))
    await run.runSkillReviews()

    const models = run.skillReviews[0].state.models ?? []
    const generatorProviders = models.filter((m) => m.role === 'generator').map((m) => m.providerId).sort()
    // BOTH configured generators are generator rows — NEITHER demoted to verifier.
    expect(generatorProviders).toEqual(['anthropic', 'deepseek'])
    expect(models.some((m) => m.role === 'verifier')).toBe(false)
    // The result is a (valid) empty finding set.
    const result = run.skillReviews[0].state.value as SkillReviewResult
    expect(result.findings).toEqual([])
  })

  it('the breakdown generator set EXACTLY matches the configured generators (role match)', async () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')
    setOpenaiKey('o')
    // 2 generators + 1 verifier — the panel the user configured.
    setAiPanel({ participants: [
      { provider: 'deepseek', model: 'deepseek-v4-flash', role: 'generator' },
      { provider: 'anthropic', model: 'claude-opus-4-8', role: 'generator' },
      { provider: 'openai', model: 'gpt-5.5', role: 'verifier' },
    ] })

    const { addSkill } = await import('../skills/skills')
    addSkill('My Reviewer', 'find bugs')

    const GEN: Record<string, SkillReviewResult> = {
      deepseek: { skillName: 'My Reviewer', findings: [{ path: 'src/foo.ts', line: 10, severity: 'high', body: 'deepseek bug' }] },
      anthropic: { skillName: 'My Reviewer', findings: [{ path: 'src/foo.ts', line: 50, severity: 'high', body: 'anthropic bug' }] },
    }
    const llmJsonWithRepairFor = vi.fn().mockImplementation(async (cfg, _opts, validate) => {
      const gen = GEN[cfg.providerId]
      if (gen && validate(gen) !== null) {
        return { result: gen, usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }
      }
      return { result: { verdicts: [] }, usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }
    })

    const run = createAiRun(makeInput(), makeDeps({ llmJsonWithRepairFor }))
    await run.runSkillReviews()

    const models = run.skillReviews[0].state.models ?? []
    const generatorSet = models.filter((m) => m.role === 'generator').map((m) => m.providerId).sort()
    const verifierSet = models.filter((m) => m.role === 'verifier').map((m) => m.providerId).sort()
    // generator set === configured generators; verifier set === configured verifiers.
    expect(generatorSet).toEqual(['anthropic', 'deepseek'])
    expect(verifierSet).toEqual(['openai'])
  })
})

// ---------------------------------------------------------------------------
// Deep multi-generator — each generator runs its OWN deep pass (Plan P deep)
//
// With deep ON + ≥2 generators, every generator GENERATES through its own
// runDeepJson tool loop (provider override), sharing the per-review deep cache
// so a file read once is reused across generators. Usage is captured per
// generator; both are generator rows (no demotion).
// ---------------------------------------------------------------------------

describe('deep multi-generator fusion in runSkillReviews (Plan P deep)', () => {
  /** A deep source whose getFileAtHead is a spy so we can count fetches. */
  function makeDeepSource(overrides: Record<string, unknown> = {}) {
    return {
      getFileAtHead: vi.fn(async () => 'the file contents'),
      getFileAtBase: vi.fn(async () => null),
      searchCode: vi.fn(async () => ''),
      findReferences: vi.fn(async () => ''),
      ...overrides,
    }
  }

  it('each generator runs a deep pass with its OWN provider override; shared cache reused; usage captured; both generator rows', async () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')
    setAiPanel({ participants: [
      { provider: 'deepseek', model: 'deepseek-v4-flash', role: 'generator' },
      { provider: 'anthropic', model: 'claude-opus-4-8', role: 'generator' },
    ] })
    // Deep mode on (legacy all-deep matrix).
    localStorage.setItem('review123:settings', JSON.stringify({
      deepseekKey: 'k', anthropicKey: 'a', aiProvider: 'deepseek', aiModel: 'deepseek-v4-flash',
      aiDeepReview: true,
      aiPanel: { participants: [
        { provider: 'deepseek', model: 'deepseek-v4-flash', role: 'generator' },
        { provider: 'anthropic', model: 'claude-opus-4-8', role: 'generator' },
      ] },
    }))

    const { addSkill } = await import('../skills/skills')
    addSkill('My Reviewer', 'find bugs')

    const source = makeDeepSource()
    const overridesSeen: (string | undefined)[] = []

    // Each generator's deep loop reads the SAME file (src/foo.ts) and returns a
    // unique finding. The loop calls executeTool so the shared cache is exercised.
    // Distinct lines so the two findings don't dedup-merge into one.
    const GEN_FINDING: Record<string, { line: number; body: string }> = {
      deepseek: { line: 10, body: 'deepseek deep bug' },
      anthropic: { line: 99, body: 'anthropic deep bug' },
    }
    const llmToolLoop = vi.fn().mockImplementation(
      async (opts: {
        system: string
        override?: { provider: { id: string } }
        executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
      }) => {
        const providerId = opts.override?.provider.id
        // GROUNDED cross-confirm verify calls also run through the loop now —
        // answer them neutrally (zero lookups) and keep them out of the
        // generation bookkeeping below.
        if (/ADVERSARIAL verifier/i.test(opts.system)) {
          return {
            content: JSON.stringify({ verdicts: [] }),
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
            toolCallsUsed: 0,
          }
        }
        overridesSeen.push(providerId)
        // Read the same file in both generators' loops — exercises the cache.
        await opts.executeTool('read_file', { path: 'src/foo.ts' })
        const f = providerId ? GEN_FINDING[providerId] ?? { line: 1, body: 'unknown' } : { line: 1, body: 'no-override' }
        return {
          content: JSON.stringify({ skillName: 'My Reviewer', findings: [{ path: 'src/foo.ts', line: f.line, severity: 'high', body: f.body }] }),
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          toolCallsUsed: 1,
        }
      },
    )

    // Any residual single-pass calls (none expected for verify now that
    // grounding routes them through the loop) stay neutral.
    const llmJsonWithRepairFor = vi.fn().mockImplementation(async (_cfg, _opts, validate) => {
      return { result: validate({ verdicts: [] }) ?? { verdicts: [] }, usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }
    })

    const run = createAiRun(
      { ...makeInput(), deepReview: source },
      makeDeps({ llmToolLoop, llmJsonWithRepairFor }),
    )
    await run.runSkillReviews()

    // Each generator's deep loop ran with ITS OWN provider override.
    expect(overridesSeen.filter(Boolean).sort()).toEqual(['anthropic', 'deepseek'])

    // The shared deep cache means src/foo.ts was fetched ONCE across both
    // generators (a file read once is not refetched per generator).
    expect(source.getFileAtHead).toHaveBeenCalledTimes(1)

    // Both configured generators are generator rows carrying usage.
    const models = run.skillReviews[0].state.models ?? []
    const genRows = models.filter((m) => m.role === 'generator')
    expect(genRows.map((m) => m.providerId).sort()).toEqual(['anthropic', 'deepseek'])
    expect(genRows.every((m) => m.usage !== undefined)).toBe(true)

    // The union carries BOTH generators' deep findings (recall).
    const result = run.skillReviews[0].state.value as SkillReviewResult
    const bodies = result.findings.map((f) => f.body)
    expect(bodies).toContain('deepseek deep bug')
    expect(bodies).toContain('anthropic deep bug')
  })
})

// ---------------------------------------------------------------------------
// Narration label — the active model that ONLY ran descriptive single-pass
// tasks is labelled "active · narration", NOT "Generator".
// ---------------------------------------------------------------------------

describe('active/narration model labelling in modelCostBreakdown', () => {
  it('default panel: the active model that generated the verdict stays a Generator row (narration folds in)', async () => {
    setAiProvider('deepseek')
    setDeepseekKey('k') // single key → single-generator default path

    const llmJsonWithRepairFor = vi.fn()
    // The active model produces a real verdict (a finding-generation task) so it
    // earns a generator row; narration tasks then fold into it.
    const llmJsonWithRepairWithUsage = vi.fn().mockImplementation(async (_opts: unknown, validate: (x: unknown) => unknown) => {
      const v: VerdictResult = { level: 'minor-changes', evidence: ['src/foo.ts ev'], notAnalyzed: [] }
      if (validate(v) !== null) return { result: v, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      // Other single-pass (narration) tasks.
      return { result: validate({ skillName: 'x', findings: [] }) ?? null, usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }
    })
    const run = createAiRun(makeInput(), makeDeps({ llmJsonWithRepairFor, llmJsonWithRepairWithUsage }))
    await run.start()

    const rows = run.modelCostBreakdown
    // The active model (deepseek) has ONE row, and it's a Generator (it produced
    // the verdict/findings) — its narration tasks (Summary/Hotspots/…) fold in.
    const deepseekRows = rows.filter((r) => r.providerId === 'deepseek')
    expect(deepseekRows).toHaveLength(1)
    expect(deepseekRows[0].role).toBe('generator')
    // Narration tasks appear in the generator row's drilldown, not as a separate
    // narrator row.
    const taskNames = deepseekRows[0].byTask.map((t) => t.task)
    // The verdict (generation) AND a narration task (Hotspots) share the row.
    expect(taskNames).toContain('Verdict')
    expect(taskNames).toContain('Hotspots')
    // No standalone narrator row in the default single-model path.
    expect(rows.some((r) => r.role === 'narrator')).toBe(false)
  })

  it('active model that ONLY narrated (not a configured generator) → standalone "narrator" row, not Generator', async () => {
    // Active = gemini (runs the descriptive tasks); the configured GENERATORS are
    // deepseek + anthropic. gemini never generates findings → pure narrator.
    setAiProvider('gemini')
    setGeminiKey('g')
    setDeepseekKey('k')
    setAnthropicKey('a')
    setAiPanel({ participants: [
      { provider: 'deepseek', model: 'deepseek-v4-flash', role: 'generator' },
      { provider: 'anthropic', model: 'claude-opus-4-8', role: 'generator' },
    ] })

    const { addSkill } = await import('../skills/skills')
    addSkill('My Reviewer', 'find bugs')

    const VERDICT: Record<string, VerdictResult> = {
      deepseek: { level: 'minor-changes', evidence: ['src/foo.ts ev'], notAnalyzed: [] },
      anthropic: { level: 'minor-changes', evidence: ['src/bar.ts ev'], notAnalyzed: [] },
    }
    const SKILL: Record<string, SkillReviewResult> = {
      deepseek: { skillName: 'My Reviewer', findings: [{ path: 'src/foo.ts', line: 1, severity: 'low', body: 'd' }] },
      anthropic: { skillName: 'My Reviewer', findings: [{ path: 'src/bar.ts', line: 1, severity: 'low', body: 'a' }] },
    }
    const llmJsonWithRepairFor = vi.fn().mockImplementation(async (cfg, _opts, validate) => {
      const v = VERDICT[cfg.providerId]
      if (v && validate(v) !== null) return { result: v, usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }
      const s = SKILL[cfg.providerId]
      if (s && validate(s) !== null) return { result: s, usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }
      return { result: { verdicts: [] }, usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }
    })
    // The descriptive tasks (summary/hotspots/…) run on gemini via the WithUsage stub.
    const llmJsonWithRepairWithUsage = vi.fn().mockImplementation(async (_opts: unknown, validate: (x: unknown) => unknown) => {
      // gemini single-pass narration tasks — return a benign valid shape per task.
      return { result: validate({ skillName: 'x', findings: [] }) ?? null, usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }
    })

    const deps = makeDeps({ llmJsonWithRepairFor, llmJsonWithRepairWithUsage })
    const run = createAiRun(makeInput(), deps)
    await run.start()
    await run.runSkillReviews()

    const rows = run.modelCostBreakdown
    const geminiRows = rows.filter((r) => r.providerId === 'gemini')
    // gemini appears ONLY as a narrator (it never generated findings).
    expect(geminiRows.every((r) => r.role === 'narrator')).toBe(true)
    expect(geminiRows.some((r) => r.role === 'generator')).toBe(false)
    expect(rows.some((r) => r.role === 'narrator' && r.providerId === 'gemini')).toBe(true)
    // The configured generators (deepseek, anthropic) are the generator rows.
    const genProviders = rows.filter((r) => r.role === 'generator').map((r) => r.providerId).sort()
    expect(genProviders).toEqual(['anthropic', 'deepseek'])
  })
})
