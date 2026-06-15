import { describe, it, expect, beforeEach } from 'vitest'
import {
  verifierProviderConfigs,
  crossModelVerifyEffective,
  resolveEnsemble,
  MAX_VERIFIER_PROVIDERS,
  ENSEMBLE_RUNAWAY_BACKSTOP,
} from './config'
import {
  setDeepseekKey,
  setOpenaiKey,
  setAnthropicKey,
  setGeminiKey,
  setAiProvider,
  setCrossModelVerify,
  setAiEnsemble,
} from '../settings/settings'

beforeEach(() => {
  localStorage.clear()
})

describe('verifierProviderConfigs', () => {
  it('is empty with only the active provider keyed', () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    expect(verifierProviderConfigs()).toEqual([])
  })

  it('excludes the active generator, includes other keyed providers in PROVIDERS order', () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setGeminiKey('g')
    setOpenaiKey('o')
    const cfgs = verifierProviderConfigs()
    // PROVIDERS order is deepseek, openai, anthropic, gemini → openai before gemini
    expect(cfgs.map((c) => c.providerId)).toEqual(['openai', 'gemini'])
    expect(cfgs.every((c) => c.key.length > 0 && c.model.id.length > 0)).toBe(true)
  })

  it('caps verifiers at MAX_VERIFIER_PROVIDERS', () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setOpenaiKey('o')
    setAnthropicKey('a')
    setGeminiKey('g')
    const cfgs = verifierProviderConfigs()
    expect(cfgs.length).toBe(MAX_VERIFIER_PROVIDERS)
    expect(cfgs.length).toBe(3)
  })

  it('each verifier uses its provider default model', () => {
    setAiProvider('openai')
    setOpenaiKey('o')
    setAnthropicKey('a')
    const cfgs = verifierProviderConfigs()
    expect(cfgs.map((c) => c.providerId)).toEqual(['anthropic'])
    expect(cfgs[0].model.id).toBe('claude-sonnet-4-6')
  })
})

describe('crossModelVerifyEffective — gating', () => {
  it('false with 0 keys', () => {
    expect(crossModelVerifyEffective()).toBe(false)
  })

  it('false with only the active provider keyed (single-key no-op)', () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    expect(crossModelVerifyEffective()).toBe(false)
  })

  it('true with 2+ keys when the setting is on (default)', () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')
    expect(crossModelVerifyEffective()).toBe(true)
  })

  it('false when the setting is explicitly off even with 2+ keys', () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')
    setCrossModelVerify(false)
    expect(crossModelVerifyEffective()).toBe(false)
  })
})

describe('resolveEnsemble — Plan N configurable ensemble', () => {
  it('default ensemble reproduces #128: active generator + other keyed verifiers', () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setOpenaiKey('o')
    const { generator, verifiers } = resolveEnsemble()
    expect(generator?.providerId).toBe('deepseek')
    expect(generator?.model.id).toBe('deepseek-v4-flash')
    expect(verifiers.map((v) => v.providerId)).toEqual(['openai'])
    // verifierProviderConfigs is the same list (byte-identical wrapper)
    expect(verifierProviderConfigs()).toEqual(verifiers)
  })

  it('default generator is null when the active provider has no key', () => {
    setAiProvider('deepseek')
    setOpenaiKey('o')
    expect(resolveEnsemble().generator).toBeNull()
  })

  it('custom ensemble: multiple models of the SAME provider on one key (the unlock)', () => {
    setAnthropicKey('a')
    setAiEnsemble({
      generator: { provider: 'anthropic', model: 'claude-opus-4-8' },
      verifiers: [
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
      ],
    })
    const { generator, verifiers } = resolveEnsemble()
    expect(generator?.model.id).toBe('claude-opus-4-8')
    expect(verifiers.map((v) => v.model.id)).toEqual(['claude-sonnet-4-6', 'claude-haiku-4-5'])
    expect(verifiers.every((v) => v.providerId === 'anthropic' && v.key === 'a')).toBe(true)
    // Single key, 2+ models → cross-verify effective
    expect(crossModelVerifyEffective()).toBe(true)
  })

  it('skips a participant whose provider key is missing', () => {
    setAnthropicKey('a')
    setAiEnsemble({
      generator: { provider: 'anthropic', model: 'claude-opus-4-8' },
      verifiers: [
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        { provider: 'openai', model: 'gpt-5.4' }, // no openai key → dropped
      ],
    })
    const { verifiers } = resolveEnsemble()
    expect(verifiers.map((v) => v.providerId)).toEqual(['anthropic'])
  })

  it('generator is null (and thus not effective) when its provider key is missing', () => {
    setAnthropicKey('a')
    setAiEnsemble({
      generator: { provider: 'openai', model: 'gpt-5.4' }, // no openai key
      verifiers: [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }],
    })
    expect(resolveEnsemble().generator).toBeNull()
    expect(crossModelVerifyEffective()).toBe(false)
  })

  it('<2 usable models → no-op (single model, no verifiers)', () => {
    setAnthropicKey('a')
    setAiEnsemble({
      generator: { provider: 'anthropic', model: 'claude-opus-4-8' },
      verifiers: [{ provider: 'openai', model: 'gpt-5.4' }], // dropped, no key
    })
    expect(resolveEnsemble().verifiers).toEqual([])
    expect(crossModelVerifyEffective()).toBe(false)
  })

  it('does NOT truncate to a product cap: a 10-participant ensemble resolves all 10', () => {
    setAnthropicKey('a')
    // Generator + 9 verifiers = 10 participants (single-key, same provider).
    // There is no hard product cap (the old 8) — all 10 resolve since each
    // provider key is present and the count is under the runaway backstop.
    setAiEnsemble({
      generator: { provider: 'anthropic', model: 'claude-opus-4-8' },
      verifiers: Array.from({ length: 9 }, () => ({
        provider: 'anthropic' as const,
        model: 'claude-sonnet-4-6',
      })),
    })
    const { generator, verifiers } = resolveEnsemble()
    expect(generator).not.toBeNull()
    expect(1 + verifiers.length).toBe(10)
  })

  it('applies only the runaway backstop, never a product cap of 8', () => {
    setAnthropicKey('a')
    // Far more verifiers than the backstop — generator + 30 requested. Only the
    // runaway backstop trims the overflow; the old 8-cap is gone.
    setAiEnsemble({
      generator: { provider: 'anthropic', model: 'claude-opus-4-8' },
      verifiers: Array.from({ length: 30 }, () => ({
        provider: 'anthropic' as const,
        model: 'claude-sonnet-4-6',
      })),
    })
    const { generator, verifiers } = resolveEnsemble()
    expect(generator).not.toBeNull()
    // Bounded by the runaway backstop, not 8.
    expect(1 + verifiers.length).toBe(ENSEMBLE_RUNAWAY_BACKSTOP)
    expect(ENSEMBLE_RUNAWAY_BACKSTOP).toBeGreaterThan(8)
  })
})

// ---------------------------------------------------------------------------
// Plan O — fusionMode gating
// ---------------------------------------------------------------------------

import { fusionGenerateEffective, fusionParticipants } from './config'
import { setFusionMode } from '../settings/settings'

describe('fusionGenerateEffective — Plan O gating', () => {
  it("default ('verify') → false even with 2+ keys (byte-identical to #130)", () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')
    // crossModelVerify is effective, but fusionMode defaults to 'verify'.
    expect(crossModelVerifyEffective()).toBe(true)
    expect(fusionGenerateEffective()).toBe(false)
  })

  it("'generate' with only 1 keyed model → false (needs ≥2)", () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setFusionMode('generate')
    expect(fusionGenerateEffective()).toBe(false)
  })

  it("'generate' with ≥2 keyed models → true", () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')
    setFusionMode('generate')
    expect(fusionGenerateEffective()).toBe(true)
  })

  it("'generate' but crossModelVerify off → false", () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')
    setFusionMode('generate')
    setCrossModelVerify(false)
    expect(fusionGenerateEffective()).toBe(false)
  })

  it("'generate' single-key multi-model ensemble → true (Plan N unlock composes)", () => {
    setAnthropicKey('a')
    setAiEnsemble({
      generator: { provider: 'anthropic', model: 'claude-opus-4-8' },
      verifiers: [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }],
    })
    setFusionMode('generate')
    expect(fusionGenerateEffective()).toBe(true)
  })
})

describe('fusionParticipants', () => {
  it('generator first, then verifiers; each tagged with a display name', () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')
    const ps = fusionParticipants()
    expect(ps.length).toBe(2)
    expect(ps[0].cfg.providerId).toBe('deepseek')
    expect(ps[1].cfg.providerId).toBe('anthropic')
    expect(ps.every((p) => p.generator.length > 0)).toBe(true)
  })

  it('disambiguates same-provider participants by model id', () => {
    setAnthropicKey('a')
    setAiEnsemble({
      generator: { provider: 'anthropic', model: 'claude-opus-4-8' },
      verifiers: [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }],
    })
    const ps = fusionParticipants()
    const names = ps.map((p) => p.generator)
    expect(new Set(names).size).toBe(2) // distinct names despite same provider
    expect(names[0]).toContain('claude-opus-4-8')
  })

  it('empty when no usable generator', () => {
    setAiProvider('deepseek') // no key
    expect(fusionParticipants()).toEqual([])
  })
})
