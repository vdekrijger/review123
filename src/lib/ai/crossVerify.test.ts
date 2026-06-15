import { describe, it, expect, vi } from 'vitest'
import {
  aggregateFinding,
  crossVerify,
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
