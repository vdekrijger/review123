import { describe, it, expect, beforeEach } from 'vitest'
import {
  verifierProviderConfigs,
  crossModelVerifyEffective,
  MAX_VERIFIER_PROVIDERS,
} from './config'
import {
  setDeepseekKey,
  setOpenaiKey,
  setAnthropicKey,
  setGeminiKey,
  setAiProvider,
  setCrossModelVerify,
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
