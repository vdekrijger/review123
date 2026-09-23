import { describe, it, expect, beforeEach } from 'vitest'
import {
  verifierProviderConfigs,
  crossModelVerifyEffective,
  resolveEnsemble,
  resolvePanel,
  panelMode,
  providerCredential,
  providerIsUsable,
  activeProviderHasKey,
  MAX_VERIFIER_PROVIDERS,
  ENSEMBLE_RUNAWAY_BACKSTOP,
} from './config'
import { BRIDGE_STORAGE_KEY } from '../bridge/storage'
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

// ===========================================================================
// The LOCAL BRIDGE as a credential-bearing source
//
// It has no API key. Its credential is the pairing token, which lives in
// localStorage rather than in settings — so every gate that asks "is this
// provider configured?" has to know about it, or selecting the bridge silently
// disables AI everywhere.
// ===========================================================================

const BRIDGE_TOKEN = 'pairing-token-0000000000000000000000000000'

function pairBridge(): void {
  localStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify({ token: BRIDGE_TOKEN, port: 7321 }))
}

describe('providerCredential — the bridge pairing counts as a credential', () => {
  it('is null for the bridge when nothing is paired', () => {
    expect(providerCredential('bridge')).toBeNull()
  })

  it('is the pairing token once a bridge is paired', () => {
    pairBridge()
    expect(providerCredential('bridge')).toBe(BRIDGE_TOKEN)
  })

  it('still reads API providers from their settings key field', () => {
    setDeepseekKey('sk-k')
    expect(providerCredential('deepseek')).toBe('sk-k')
    expect(providerCredential('openai')).toBeNull()
  })

  it('treats an EMPTY stored key as no credential, not as an empty one', () => {
    // setDeepseekKey refuses an empty value, but a record written by an older
    // build can still hold one — and `'' ` is falsy, so a naive read would
    // return it and a naive gate would call it configured.
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: '' }))
    expect(providerCredential('deepseek')).toBeNull()
  })
})

describe('providerIsUsable — the one gate every call site asks', () => {
  // It exists because open-coding the question kept producing a five-way key
  // chain that ended `: s.openrouterKey`, off the end of which 'bridge' fell
  // and read as unkeyed. These cases pin the answer for EVERY provider id so a
  // future chain cannot quietly reintroduce the same hole.
  it('a PAIRED bridge is usable, with no API key anywhere', () => {
    pairBridge()
    expect(providerIsUsable('bridge')).toBe(true)
  })

  it('an unpaired bridge is NOT usable', () => {
    expect(providerIsUsable('bridge')).toBe(false)
  })

  it('a disconnected bridge — pairing cleared — is not usable', () => {
    pairBridge()
    expect(providerIsUsable('bridge')).toBe(true)
    localStorage.removeItem(BRIDGE_STORAGE_KEY)
    expect(providerIsUsable('bridge')).toBe(false)
  })

  it('a paired bridge is usable even with EVERY api key empty (the #252 regression)', () => {
    pairBridge()
    expect(providerIsUsable('deepseek')).toBe(false)
    expect(providerIsUsable('openai')).toBe(false)
    expect(providerIsUsable('anthropic')).toBe(false)
    expect(providerIsUsable('gemini')).toBe(false)
    expect(providerIsUsable('openrouter')).toBe(false)
    // …and the bridge is STILL usable. The old chain answered false here,
    // because it resolved 'bridge' to the (empty) openrouter key.
    expect(providerIsUsable('bridge')).toBe(true)
  })

  it('agrees with providerCredential for api providers', () => {
    setDeepseekKey('sk-k')
    expect(providerIsUsable('deepseek')).toBe(true)
    expect(providerIsUsable('openai')).toBe(false)
  })
})

describe('a paired bridge makes cross-verification available', () => {
  // The user-visible consequence of the key-gate bug: a bridge plus a second
  // model resolved to ONE usable participant, so crossModelVerifyEffective was
  // false and cross-model verification — the one feature PR #250 measured as
  // cutting the noise rate (36–45% → 9%) — silently did not run.
  it('bridge generator + one api verifier resolves to two participants', () => {
    pairBridge()
    setDeepseekKey('sk-k')
    setCrossModelVerify(true)
    setAiPanel({ participants: [gen('bridge', 'claude'), ver('deepseek', 'deepseek-v4-flash')] })

    const panel = resolvePanel()
    expect(panel.generators).toHaveLength(1)
    expect(panel.generators[0].providerId).toBe('bridge')
    expect(panel.verifiers).toHaveLength(1)
    expect(crossModelVerifyEffective()).toBe(true)
  })

  it('an UNPAIRED bridge drops out, leaving too few participants', () => {
    setDeepseekKey('sk-k')
    setCrossModelVerify(true)
    setAiPanel({ participants: [gen('deepseek', 'deepseek-v4-flash'), ver('bridge', 'claude')] })

    expect(resolvePanel().verifiers).toHaveLength(0)
    expect(crossModelVerifyEffective()).toBe(false)
  })
})

describe('activeProviderHasKey with the bridge selected', () => {
  it('is false with no bridge paired — every AI gate stays closed', () => {
    setAiProvider('bridge')
    expect(activeProviderHasKey()).toBe(false)
  })

  it('is true once paired, with no API key anywhere', () => {
    setAiProvider('bridge')
    pairBridge()
    expect(activeProviderHasKey()).toBe(true)
  })

  it('means PAIRED, not reachable — same contract as a saved-but-expired API key', () => {
    // No health probe is consulted. Gating the product on a live probe would
    // make every review unavailable the moment a terminal was closed; the
    // failure belongs at call time, with a message about what to do.
    setAiProvider('bridge')
    pairBridge()
    expect(activeProviderHasKey()).toBe(true)
  })
})

describe('the bridge is never an AUTOMATIC verifier', () => {
  it('is excluded from the default panel even when paired and keyed providers exist', () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setOpenaiKey('o')
    pairBridge()

    // Fanning a review across every configured source would multiply CLI
    // invocations on ONE subscription seat, behind the user's back.
    expect(verifierProviderConfigs().map((c) => c.providerId)).toEqual(['openai'])
  })

  it('can still be a generator when the user selects it', () => {
    setAiProvider('bridge')
    pairBridge()
    const { generators } = resolvePanel()
    expect(generators.map((g) => g.providerId)).toEqual(['bridge'])
    expect(generators[0]!.key).toBe(BRIDGE_TOKEN)
    expect(generators[0]!.model.id).toBe('claude')
  })

  it('can be named EXPLICITLY in a custom panel, as a verifier', () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    pairBridge()
    setAiPanel({ participants: [gen('deepseek', 'deepseek-v4-flash'), ver('bridge', 'codex')] })

    const cfgs = verifierProviderConfigs()
    expect(cfgs.map((c) => c.providerId)).toEqual(['bridge'])
    expect(cfgs[0]!.model.id).toBe('codex')
  })

  it('drops a bridge participant from a custom panel when no bridge is paired', () => {
    setAiProvider('deepseek')
    setDeepseekKey('k')
    setAiPanel({ participants: [gen('deepseek', 'deepseek-v4-flash'), ver('bridge', 'claude')] })
    expect(verifierProviderConfigs()).toEqual([])
  })
})

describe('crossModelVerifyEffective with the bridge as generator', () => {
  it('is false with the bridge alone — one participant is not cross-verification', () => {
    setAiProvider('bridge')
    pairBridge()
    setCrossModelVerify(true)
    expect(crossModelVerifyEffective()).toBe(false)
  })

  it('is true with the bridge generating and a keyed API verifier', () => {
    setAiProvider('bridge')
    pairBridge()
    setOpenaiKey('o')
    setCrossModelVerify(true)
    expect(crossModelVerifyEffective()).toBe(true)
    expect(verifierProviderConfigs().map((c) => c.providerId)).toEqual(['openai'])
  })
})
