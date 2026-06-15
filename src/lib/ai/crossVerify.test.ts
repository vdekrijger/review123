import { describe, it, expect, vi } from 'vitest'
import {
  aggregateFinding,
  crossVerify,
  isDecisiveVote,
  validateVerifierResponse,
  buildVerifyPrompt,
  type VerifyFn,
  type VerifiableFinding,
} from './crossVerify'
import type { ProviderConfig } from '../llm/llm'
import { getModelDef, getProvider } from '../llm/providers'

function cfg(providerId: 'openai' | 'anthropic' | 'gemini' | 'deepseek'): ProviderConfig {
  const provider = getProvider(providerId)!
  return { providerId, model: getModelDef(provider, provider.defaultModel)!, key: `key-${providerId}` }
}

/** A same-provider config pinned to a specific model id (Plan N multi-model). */
function modelCfg(providerId: 'anthropic', modelId: string): ProviderConfig {
  const provider = getProvider(providerId)!
  return { providerId, model: getModelDef(provider, modelId)!, key: `key-${providerId}` }
}

function finding(id: string): VerifiableFinding {
  return { id, path: 'src/a.ts', line: 10, severity: 'high', body: `body ${id}` }
}

describe('aggregateFinding — threshold', () => {
  it('all-confirm → surfaced, confirmedBy counts generator + verifiers', () => {
    const v = aggregateFinding('deepseek', [
      { provider: 'openai', verdict: 'confirm', reason: 'real' },
      { provider: 'anthropic', verdict: 'confirm', reason: 'real' },
    ])
    expect(v.surfaced).toBe(true)
    expect(v.confirmedBy).toBe(3)
    expect(v.polledModels).toBe(3)
    expect(v.perModel[0]).toEqual({ provider: 'deepseek', verdict: 'confirm', reason: '' })
  })

  it('single verifier refutes a generator-only finding → tie at half → still surfaced', () => {
    // score = 1 (generator), polled = 2, half = 1, 1 >= 1 → surface
    const v = aggregateFinding('deepseek', [
      { provider: 'openai', verdict: 'refute', reason: 'not real' },
    ])
    expect(v.surfaced).toBe(true)
    expect(v.confirmedBy).toBe(1)
    expect(v.polledModels).toBe(2)
  })

  it('two verifiers refute → score 1 / polled 3 < 1.5 → demoted', () => {
    const v = aggregateFinding('deepseek', [
      { provider: 'openai', verdict: 'refute', reason: 'no' },
      { provider: 'anthropic', verdict: 'refute', reason: 'no' },
    ])
    expect(v.surfaced).toBe(false)
    expect(v.confirmedBy).toBe(1)
    expect(v.polledModels).toBe(3)
  })

  it('uncertain counts as a neutral half-vote', () => {
    // generator(1) + uncertain(0.5) = 1.5, polled 2, half 1 → surfaced
    const v = aggregateFinding('deepseek', [
      { provider: 'openai', verdict: 'uncertain', reason: 'cannot tell' },
    ])
    expect(v.surfaced).toBe(true)
    // one confirm refuted into uncertain still keeps confirmedBy=1 (generator only)
    expect(v.confirmedBy).toBe(1)
  })

  it('one confirm + one refute among two verifiers → score 2/polled 3 >= 1.5 → surfaced', () => {
    const v = aggregateFinding('deepseek', [
      { provider: 'openai', verdict: 'confirm', reason: 'yes' },
      { provider: 'anthropic', verdict: 'refute', reason: 'no' },
    ])
    expect(v.surfaced).toBe(true)
    expect(v.confirmedBy).toBe(2)
  })
})

describe('validateVerifierResponse', () => {
  it('accepts a well-formed response', () => {
    const r = validateVerifierResponse({
      verdicts: [{ id: 'f1', verdict: 'confirm', reason: 'ok' }],
    })
    expect(r).not.toBeNull()
    expect(r!.verdicts[0].id).toBe('f1')
  })

  it('defaults a missing reason to empty string', () => {
    const r = validateVerifierResponse({ verdicts: [{ id: 'f1', verdict: 'refute' }] })
    expect(r!.verdicts[0].reason).toBe('')
  })

  it('rejects an unknown verdict value', () => {
    expect(validateVerifierResponse({ verdicts: [{ id: 'f1', verdict: 'maybe' }] })).toBeNull()
  })

  it('rejects a non-array verdicts', () => {
    expect(validateVerifierResponse({ verdicts: 'nope' })).toBeNull()
  })
})

describe('buildVerifyPrompt', () => {
  it('embeds finding ids + code context and asks for adversarial JSON verdicts', () => {
    const { system, user } = buildVerifyPrompt([
      { ...finding('f1'), excerpt: 'EXCERPT-A', fileWindow: 'WINDOW-A' },
    ])
    expect(system).toMatch(/adversarial/i)
    expect(system).toContain('"verdicts"')
    expect(user).toContain('f1')
    expect(user).toContain('EXCERPT-A')
    expect(user).toContain('WINDOW-A')
  })
})

describe('crossVerify — orchestration', () => {
  const generator = 'deepseek'

  it('no-op when no findings or no verifiers', async () => {
    const verify: VerifyFn = vi.fn()
    const a = await crossVerify([], generator, [cfg('openai')], verify)
    expect(a.byId.size).toBe(0)
    const b = await crossVerify([finding('f1')], generator, [], verify)
    expect(b.byId.size).toBe(0)
    expect(verify).not.toHaveBeenCalled()
  })

  it('aggregates two verifiers and sums usage', async () => {
    const verify: VerifyFn = async (c) => ({
      result: {
        verdicts: [{ id: 'f1', verdict: 'confirm', reason: `${c.providerId} yes` }],
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
    const out = await crossVerify([finding('f1')], generator, [cfg('openai'), cfg('anthropic')], verify)
    const v = out.byId.get('f1')!
    expect(v.surfaced).toBe(true)
    expect(v.confirmedBy).toBe(3)
    expect(v.polledModels).toBe(3)
    expect(out.usage).toEqual({ prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 })
    expect(out.respondedProviders).toEqual(['openai', 'anthropic'])
  })

  it('a refuted finding is demoted when both verifiers refute', async () => {
    const verify: VerifyFn = async () => ({
      result: { verdicts: [{ id: 'f1', verdict: 'refute', reason: 'noise' }] },
    })
    const out = await crossVerify([finding('f1')], generator, [cfg('openai'), cfg('anthropic')], verify)
    expect(out.byId.get('f1')!.surfaced).toBe(false)
  })

  it('a failing verifier is skipped (its vote omitted), others still count', async () => {
    const verify: VerifyFn = async (c) => {
      if (c.providerId === 'openai') throw new Error('rate limited')
      return { result: { verdicts: [{ id: 'f1', verdict: 'confirm', reason: 'yes' }] } }
    }
    const out = await crossVerify([finding('f1')], generator, [cfg('openai'), cfg('anthropic')], verify)
    const v = out.byId.get('f1')!
    expect(out.respondedProviders).toEqual(['anthropic'])
    expect(v.polledModels).toBe(2) // generator + the one responder
    expect(v.surfaced).toBe(true)
  })

  it('ALL verifiers failing → empty byId (findings left unverified)', async () => {
    const verify: VerifyFn = async () => {
      throw new Error('down')
    }
    const out = await crossVerify([finding('f1')], generator, [cfg('openai')], verify)
    expect(out.byId.size).toBe(0)
    expect(out.usage).toBeUndefined()
  })

  it('a verifier that omits a finding id treats it as neutral uncertain', async () => {
    const verify: VerifyFn = async () => ({
      result: { verdicts: [] }, // returns nothing for f1
    })
    const out = await crossVerify([finding('f1')], generator, [cfg('openai')], verify)
    const v = out.byId.get('f1')!
    // generator(1) + uncertain(0.5) = 1.5 >= polled/2 (1) → surfaced
    expect(v.surfaced).toBe(true)
    expect(v.perModel[1].verdict).toBe('uncertain')
  })
})

describe('isDecisiveVote — Plan N decisiveness', () => {
  it('a refute that flips surface→demote IS decisive', () => {
    // votes: [refute, refute] → without the 2nd: [refute] → surfaced(true) vs both → demoted(false)
    const votes = [{ verdict: 'refute' as const }, { verdict: 'refute' as const }]
    expect(isDecisiveVote(votes, 0)).toBe(true)
    expect(isDecisiveVote(votes, 1)).toBe(true)
  })

  it('a redundant confirm on an already-surfacing finding is NOT decisive', () => {
    // [confirm, confirm] → removing either still surfaces → not decisive
    const votes = [{ verdict: 'confirm' as const }, { verdict: 'confirm' as const }]
    expect(isDecisiveVote(votes, 0)).toBe(false)
    expect(isDecisiveVote(votes, 1)).toBe(false)
  })

  it('the single refute among confirms is decisive only when it tips the tally', () => {
    // [refute, refute, confirm]: all → score 1+0+0+1=2, polled 4, 2>=2 → surfaced
    // remove the confirm → [refute,refute] score 1, polled 3, 1<1.5 → demoted → DECISIVE
    const votes = [
      { verdict: 'refute' as const },
      { verdict: 'refute' as const },
      { verdict: 'confirm' as const },
    ]
    expect(isDecisiveVote(votes, 2)).toBe(true)
    // removing one refute → [refute, confirm] score 2, polled 3, surfaced → no flip
    expect(isDecisiveVote(votes, 0)).toBe(false)
  })
})

describe('crossVerify — per-model usage + impact (Plan N)', () => {
  const generator = 'anthropic'

  it('attributes usage per verifier MODEL (same provider, different models stay distinct)', async () => {
    const verify: VerifyFn = async (c) => ({
      result: { verdicts: [{ id: 'f1', verdict: 'confirm', reason: 'yes' }] },
      usage: { prompt_tokens: c.model.id === 'claude-sonnet-4-6' ? 10 : 20, completion_tokens: 5, total_tokens: c.model.id === 'claude-sonnet-4-6' ? 15 : 25 },
    })
    const out = await crossVerify(
      [finding('f1')],
      generator,
      [modelCfg('anthropic', 'claude-sonnet-4-6'), modelCfg('anthropic', 'claude-haiku-4-5')],
      verify,
    )
    expect(out.perModelUsage).toEqual([
      { providerId: 'anthropic', modelId: 'claude-sonnet-4-6', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      { providerId: 'anthropic', modelId: 'claude-haiku-4-5', usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
    ])
  })

  it('reports per-verifier impact: a decisive refute that removes a finding', async () => {
    // Two verifiers both refute f1 → demoted; each refute is decisive (removing
    // one tips it back to surfaced). f2 both confirm → surfaced, redundant confirms.
    const verify: VerifyFn = async () => ({
      result: {
        verdicts: [
          { id: 'f1', verdict: 'refute', reason: 'noise' },
          { id: 'f2', verdict: 'confirm', reason: 'real' },
        ],
      },
    })
    const out = await crossVerify(
      [finding('f1'), finding('f2')],
      generator,
      [modelCfg('anthropic', 'claude-sonnet-4-6'), modelCfg('anthropic', 'claude-haiku-4-5')],
      verify,
    )
    expect(out.verifierImpact).toEqual([
      { providerId: 'anthropic', modelId: 'claude-sonnet-4-6', confirms: 1, refutes: 1, uncertains: 0, decisive: 1 },
      { providerId: 'anthropic', modelId: 'claude-haiku-4-5', confirms: 1, refutes: 1, uncertains: 0, decisive: 1 },
    ])
    expect(out.byId.get('f1')!.surfaced).toBe(false)
    expect(out.byId.get('f2')!.surfaced).toBe(true)
  })

  it('a rubber-stamp verifier (all confirms, no flips) shows 0 decisive', async () => {
    const verify: VerifyFn = async () => ({
      result: { verdicts: [{ id: 'f1', verdict: 'confirm', reason: 'yes' }, { id: 'f2', verdict: 'confirm', reason: 'yes' }] },
    })
    const out = await crossVerify(
      [finding('f1'), finding('f2')],
      generator,
      [modelCfg('anthropic', 'claude-sonnet-4-6')],
      verify,
    )
    expect(out.verifierImpact[0].confirms).toBe(2)
    expect(out.verifierImpact[0].decisive).toBe(0)
  })
})
