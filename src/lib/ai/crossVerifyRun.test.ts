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
import type { SkillReviewResult } from './schemas'
import {
  setDeepseekKey,
  setAnthropicKey,
  setOpenaiKey,
  setAiProvider,
  setAiEnsemble,
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
    setAiEnsemble({
      generator: { provider: 'anthropic', model: 'claude-opus-4-8' },
      verifiers: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
    })

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
