import { describe, it, expect, beforeEach } from 'vitest'
import {
  verifierProviderConfigs,
  crossModelVerifyEffective,
  resolveEnsemble,
  resolvePanel,
  panelMode,
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
  setAiPanel,
  type PanelParticipant,
} from '../settings/settings'

beforeEach(() => {
  localStorage.clear()
})

const gen = (provider: string, model: string): PanelParticipant =>
  ({ provider: provider as PanelParticipant['provider'], model, role: 'generator' })
const ver = (provider: string, model: string): PanelParticipant =>
  ({ provider: provider as PanelParticipant['provider'], model, role: 'verifier' })

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

  it('caps default verifiers at MAX_VERIFIER_PROVIDERS', () => {
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

  it('includes extra generators (beyond the first) as verifiers of the primary set', () => {
    setAnthropicKey('a')
    // Two generators + one verifier; verifierProviderConfigs surfaces the
    // non-primary generator too (it verifies findings it did not raise).
    setAiPanel({ participants: [
      gen('anthropic', 'claude-opus-4-8'),
      gen('anthropic', 'claude-sonnet-4-6'),
      ver('anthropic', 'claude-haiku-4-5'),
    ] })
    const cfgs = verifierProviderConfigs()
    expect(cfgs.map((c) => c.model.id).sort()).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-6'])
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

describe('resolvePanel / resolveEnsemble — Plan P unified panel', () => {
  it('default panel reproduces #128: active sole generator + other keyed verifiers', () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setOpenaiKey('o')
    const { generators, verifiers } = resolvePanel()
    expect(generators.map((g) => g.providerId)).toEqual(['deepseek'])
    expect(generators[0].model.id).toBe('deepseek-v4-flash')
    expect(verifiers.map((v) => v.providerId)).toEqual(['openai'])
    // resolveEnsemble exposes the first generator + verifiers (byte-identical wrapper)
    const ens = resolveEnsemble()
    expect(ens.generator?.providerId).toBe('deepseek')
    expect(verifierProviderConfigs()).toEqual(verifiers)
  })

  it('default has no generator when the active provider has no key', () => {
    setAiProvider('deepseek')
    setOpenaiKey('o')
    expect(resolvePanel().generators).toEqual([])
    expect(resolveEnsemble().generator).toBeNull()
  })

  it('custom panel: multiple models of the SAME provider on one key (the unlock)', () => {
    setAnthropicKey('a')
    setAiPanel({ participants: [
      gen('anthropic', 'claude-opus-4-8'),
      ver('anthropic', 'claude-sonnet-4-6'),
      ver('anthropic', 'claude-haiku-4-5'),
    ] })
    const { generators, verifiers } = resolvePanel()
    expect(generators[0].model.id).toBe('claude-opus-4-8')
    expect(verifiers.map((v) => v.model.id)).toEqual(['claude-sonnet-4-6', 'claude-haiku-4-5'])
    expect(verifiers.every((v) => v.providerId === 'anthropic' && v.key === 'a')).toBe(true)
    expect(crossModelVerifyEffective()).toBe(true)
    expect(panelMode()).toBe('verify') // exactly 1 generator
  })

  it('skips a participant whose provider key is missing', () => {
    setAnthropicKey('a')
    setAiPanel({ participants: [
      gen('anthropic', 'claude-opus-4-8'),
      ver('anthropic', 'claude-sonnet-4-6'),
      ver('openai', 'gpt-5.4'), // no openai key → dropped
    ] })
    expect(resolvePanel().verifiers.map((v) => v.providerId)).toEqual(['anthropic'])
  })

  it('no generator (and thus not effective) when the generator key is missing', () => {
    setAnthropicKey('a')
    setAiPanel({ participants: [
      gen('openai', 'gpt-5.4'), // no openai key
      ver('anthropic', 'claude-sonnet-4-6'),
    ] })
    expect(resolvePanel().generators).toEqual([])
    expect(crossModelVerifyEffective()).toBe(false)
  })

  it('<2 usable models → no-op (single model, no verifiers)', () => {
    setAnthropicKey('a')
    setAiPanel({ participants: [
      gen('anthropic', 'claude-opus-4-8'),
      ver('openai', 'gpt-5.4'), // dropped, no key
    ] })
    expect(resolvePanel().verifiers).toEqual([])
    expect(crossModelVerifyEffective()).toBe(false)
  })

  it('does NOT truncate to a product cap: a 10-participant panel resolves all 10', () => {
    setAnthropicKey('a')
    setAiPanel({ participants: [
      gen('anthropic', 'claude-opus-4-8'),
      ...Array.from({ length: 9 }, () => ver('anthropic', 'claude-sonnet-4-6')),
    ] })
    const { generators, verifiers } = resolvePanel()
    expect(generators.length + verifiers.length).toBe(10)
  })

  it('applies only the runaway backstop, never a product cap of 8', () => {
    setAnthropicKey('a')
    setAiPanel({ participants: [
      gen('anthropic', 'claude-opus-4-8'),
      ...Array.from({ length: 30 }, () => ver('anthropic', 'claude-sonnet-4-6')),
    ] })
    const { generators, verifiers } = resolvePanel()
    expect(generators.length + verifiers.length).toBe(ENSEMBLE_RUNAWAY_BACKSTOP)
    expect(ENSEMBLE_RUNAWAY_BACKSTOP).toBeGreaterThan(8)
  })
})

// ---------------------------------------------------------------------------
// Plan P — emergent mode + multi-generator gating
// ---------------------------------------------------------------------------

import { fusionGenerateEffective, fusionParticipants, fusionGenerators } from './config'

describe('fusionGenerateEffective — Plan P emergent gating', () => {
  it('default (1 generator) → false even with 2+ keys (byte-identical to verify)', () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')
    expect(crossModelVerifyEffective()).toBe(true)
    expect(fusionGenerateEffective()).toBe(false)
    expect(panelMode()).toBe('verify')
  })

  it('1 generator with only 1 keyed model → false', () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    expect(fusionGenerateEffective()).toBe(false)
  })

  it('≥2 generators with ≥2 keyed models → true (emergent generate)', () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')
    setAiPanel({ participants: [
      gen('deepseek', 'deepseek-v4-flash'),
      gen('anthropic', 'claude-opus-4-8'),
    ] })
    expect(fusionGenerateEffective()).toBe(true)
    expect(panelMode()).toBe('generate')
  })

  it('≥2 generators but crossModelVerify off → false', () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')
    setAiPanel({ participants: [
      gen('deepseek', 'deepseek-v4-flash'),
      gen('anthropic', 'claude-opus-4-8'),
    ] })
    setCrossModelVerify(false)
    expect(fusionGenerateEffective()).toBe(false)
  })

  it('single-key multi-model all-generate panel → true', () => {
    setAnthropicKey('a')
    setAiPanel({ participants: [
      gen('anthropic', 'claude-opus-4-8'),
      gen('anthropic', 'claude-sonnet-4-6'),
    ] })
    expect(fusionGenerateEffective()).toBe(true)
    expect(panelMode()).toBe('generate')
  })
})

describe('fusionParticipants / fusionGenerators', () => {
  it('generators first, then verifiers; each tagged with a display name', () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAnthropicKey('a')
    const ps = fusionParticipants()
    expect(ps.length).toBe(2)
    expect(ps[0].cfg.providerId).toBe('deepseek')
    expect(ps[1].cfg.providerId).toBe('anthropic')
    expect(ps.every((p) => p.generator.length > 0)).toBe(true)
    // Default = 1 generator → fusionGenerators is just that one.
    expect(fusionGenerators().map((p) => p.cfg.providerId)).toEqual(['deepseek'])
  })

  it('fusionGenerators returns all generators in an all-generate panel', () => {
    setAnthropicKey('a')
    setAiPanel({ participants: [
      gen('anthropic', 'claude-opus-4-8'),
      gen('anthropic', 'claude-sonnet-4-6'),
      ver('anthropic', 'claude-haiku-4-5'),
    ] })
    expect(fusionGenerators().map((p) => p.cfg.model.id)).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6'])
    expect(fusionParticipants().length).toBe(3)
  })

  it('disambiguates same-provider participants by model id', () => {
    setAnthropicKey('a')
    setAiPanel({ participants: [
      gen('anthropic', 'claude-opus-4-8'),
      ver('anthropic', 'claude-sonnet-4-6'),
    ] })
    const ps = fusionParticipants()
    const names = ps.map((p) => p.generator)
    expect(new Set(names).size).toBe(2)
    expect(names[0]).toContain('claude-opus-4-8')
  })

  it('empty when no usable generator', () => {
    setAiProvider('deepseek') // no key
    expect(fusionParticipants()).toEqual([])
  })
})
