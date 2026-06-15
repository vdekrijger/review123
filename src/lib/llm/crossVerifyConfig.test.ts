import { describe, it, expect, beforeEach } from 'vitest'
import {
  verifierProviderConfigs,
  crossModelVerifyEffective,
  resolveEnsemble,
  MAX_VERIFIER_PROVIDERS,
  MAX_ENSEMBLE_PARTICIPANTS,
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

  it('caps total participants at MAX_ENSEMBLE_PARTICIPANTS (generator + verifiers)', () => {
    setAnthropicKey('a')
    setAiEnsemble({
      generator: { provider: 'anthropic', model: 'claude-opus-4-8' },
      verifiers: [
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
        { provider: 'anthropic', model: 'claude-fable-5' },
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      ],
    })
    const { generator, verifiers } = resolveEnsemble()
    expect(1 + verifiers.length).toBe(MAX_ENSEMBLE_PARTICIPANTS)
    expect(generator).not.toBeNull()
  })
})
