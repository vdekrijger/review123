/**
 * LLM configuration helpers (Plan F: multi-LLM transport layer).
 *
 * Token budget formula: budgetTokens = contextWindowTokens - maxOutputTokens - 2000 (prompt overhead)
 * = 1_000_000 - 4_000 - 2_000 = 994_000 for the DeepSeek default (V4 Flash).
 *
 * LLM_CONFIG is kept for backward compatibility; all new code should use
 * activeLlmConfig() which reads aiProvider/aiModel from settings and returns
 * the effective provider+model+budget.
 */

import { getSettings } from '../settings/settings'
import { PROVIDERS, getProvider, getModelDef, computeBudgetTokens } from './providers'
import type { LlmProviderDef, LlmModelDef, LlmProviderId } from './providers'
import type { ProviderConfig } from './llm'

/** Settings field that stores each provider's API key. */
export const PROVIDER_KEY_FIELDS = {
  deepseek: 'deepseekKey',
  openai: 'openaiKey',
  anthropic: 'anthropicKey',
  gemini: 'geminiKey',
} as const satisfies Record<LlmProviderId, string>

/**
 * Whether the ACTIVE provider (settings.aiProvider) has an API key saved.
 * Used by no-key gates so they follow the provider selection instead of
 * being hardwired to deepseekKey.
 */
export function activeProviderHasKey(): boolean {
  const { provider } = activeLlmConfig()
  return !!getSettings()[PROVIDER_KEY_FIELDS[provider.id]]
}

/** Static fallback — kept for compatibility. Do not use in new code. */
export const LLM_CONFIG = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  contextWindowTokens: 64_000,
  maxOutputTokens: 4_000,
}

export interface ActiveLlmConfig {
  provider: LlmProviderDef
  model: LlmModelDef
  budgetTokens: number
}

/**
 * Returns the active LLM configuration from settings (aiProvider / aiModel).
 * Falls back to the DeepSeek provider + default model when stored values are
 * unknown or missing — preserving backward compatibility for existing users
 * who have no aiProvider setting.
 */
export function activeLlmConfig(): ActiveLlmConfig {
  const settings = getSettings()
  const providerId = settings.aiProvider ?? 'deepseek'

  let provider = getProvider(providerId)
  if (!provider) {
    // Unknown provider stored — fall back to DeepSeek
    provider = PROVIDERS[0]
  }

  // Resolve model: use stored aiModel if it belongs to this provider, else default
  const storedModel = settings.aiModel ?? ''
  const model =
    (storedModel ? getModelDef(provider, storedModel) : undefined) ??
    getModelDef(provider, provider.defaultModel) ??
    provider.models[0]

  return {
    provider,
    model,
    budgetTokens: computeBudgetTokens(model.contextWindowTokens),
  }
}

// ---------------------------------------------------------------------------
// Cross-model verification (Plan M) + configurable ensemble (Plan N)
// ---------------------------------------------------------------------------

/** Cap on verifier providers polled per verification — bounds token cost. */
export const MAX_VERIFIER_PROVIDERS = 3

/**
 * RUNAWAY BACKSTOP — NOT a product limit. Users may add as many ensemble
 * participants as they like; the soft scale note + the per-model cost/impact
 * data are the real governors and let users self-regulate. This bound exists
 * solely to prevent a pathological runaway (e.g. a corrupted/oversized stored
 * ensemble) from spawning an unbounded number of provider calls. It is set
 * absurdly high relative to any sane ensemble so it never bites real usage.
 */
export const ENSEMBLE_RUNAWAY_BACKSTOP = 20

/** A resolved ensemble participant: provider def + model def + its key. */
export interface ResolvedParticipant {
  providerId: LlmProviderId
  model: LlmModelDef
  key: string
}

/** A fully-resolved ensemble ready for the run layer. */
export interface ResolvedEnsemble {
  /** Generator participant when its provider key exists, else null. */
  generator: ResolvedParticipant | null
  /** Verifier participants whose provider key exists, capped. */
  verifiers: ProviderConfig[]
}

/** Read a provider's saved key (null when absent). */
function providerKey(providerId: LlmProviderId): string | null {
  return getSettings()[PROVIDER_KEY_FIELDS[providerId]] as string | null
}

/**
 * The DEFAULT ensemble (Plan M behaviour): generator = active provider+model;
 * verifiers = other keyed providers' default models, PROVIDERS order, capped.
 * Synthesized when no custom `aiEnsemble` is stored — byte-identical to #128.
 */
function defaultEnsemble(): ResolvedEnsemble {
  const active = activeLlmConfig()
  const activeKey = providerKey(active.provider.id)
  const generator: ResolvedParticipant | null = activeKey
    ? { providerId: active.provider.id, model: active.model, key: activeKey }
    : null
  const verifiers: ProviderConfig[] = []
  for (const provider of PROVIDERS) {
    if (provider.id === active.provider.id) continue
    const key = providerKey(provider.id)
    if (!key) continue
    const model = getModelDef(provider, provider.defaultModel) ?? provider.models[0]
    verifiers.push({ providerId: provider.id, model, key })
    if (verifiers.length >= MAX_VERIFIER_PROVIDERS) break
  }
  return { generator, verifiers }
}

/**
 * Resolve the effective ensemble (Plan N). When `aiEnsemble` is set, use the
 * user's hand-picked generator + verifiers — which MAY include multiple models
 * of the SAME provider (single-key cross-verify unlock). Participants whose
 * provider key is missing are dropped. There is NO product cap on participant
 * count — users add as many models as they want and self-regulate via the soft
 * scale note + per-model cost/impact data. Only the ENSEMBLE_RUNAWAY_BACKSTOP
 * is applied, purely to guard against pathological runaway. When no custom
 * ensemble is stored, returns the DEFAULT (byte-identical to #128).
 */
export function resolveEnsemble(): ResolvedEnsemble {
  const ensemble = getSettings().aiEnsemble
  if (!ensemble) return defaultEnsemble()

  // Generator: resolve provider/model/key; null when its key is missing.
  const genProvider = getProvider(ensemble.generator.provider)
  const genKey = genProvider ? providerKey(genProvider.id) : null
  let generator: ResolvedParticipant | null = null
  if (genProvider && genKey) {
    const model = getModelDef(genProvider, ensemble.generator.model) ?? genProvider.models[0]
    generator = { providerId: genProvider.id, model, key: genKey }
  }

  // Verifiers: drop key-missing. No product cap — only the runaway backstop on
  // total participants (generator + verifiers) keeps a corrupted ensemble from
  // spawning unbounded calls.
  const verifiers: ProviderConfig[] = []
  const verifierBackstop = ENSEMBLE_RUNAWAY_BACKSTOP - (generator ? 1 : 0)
  for (const v of ensemble.verifiers) {
    const provider = getProvider(v.provider)
    if (!provider) continue
    const key = providerKey(provider.id)
    if (!key) continue
    const model = getModelDef(provider, v.model) ?? provider.models[0]
    verifiers.push({ providerId: provider.id, model, key })
    if (verifiers.length >= verifierBackstop) break
  }
  return { generator, verifiers }
}

/**
 * Verifier provider configs for the current ensemble (Plan M call sites). Thin
 * wrapper over resolveEnsemble().verifiers; the default ensemble reproduces the
 * pre-Plan-N behaviour exactly.
 */
export function verifierProviderConfigs(): ProviderConfig[] {
  return resolveEnsemble().verifiers
}

/**
 * Whether cross-model verification is EFFECTIVE: the setting is on AND the
 * ensemble has a usable generator plus ≥1 verifier. With the default ensemble
 * this needs ≥2 keyed providers; with a custom ensemble a SINGLE provider key
 * with ≥2 models suffices (the Plan N unlock). With <2 usable models it is a
 * strict no-op, byte-identical to single-model behaviour.
 */
export function crossModelVerifyEffective(): boolean {
  if (!getSettings().crossModelVerify) return false
  const { generator, verifiers } = resolveEnsemble()
  return generator !== null && verifiers.length >= 1
}

/**
 * A fusion-mode participant (Plan O): a generator config that ALSO acts as a
 * verifier for findings it didn't raise. Carries a display name for raisedBy.
 */
export interface FusionParticipant {
  generator: string
  cfg: ProviderConfig
}

/**
 * Whether MULTI-GENERATOR fusion (Plan O 'generate' mode) is EFFECTIVE:
 * `fusionMode === 'generate'`, cross-verify is effective, AND the ensemble
 * resolves to ≥2 keyed participants (generator + ≥1 verifier). When false the
 * run uses the single-generator 'verify' path (byte-identical to #130/#133), so
 * single-model / single-key users and `fusionMode: 'verify'` users are unaffected.
 */
export function fusionGenerateEffective(): boolean {
  if (getSettings().fusionMode !== 'generate') return false
  if (!crossModelVerifyEffective()) return false
  return fusionParticipants().length >= 2
}

/**
 * All ensemble participants as fusion participants (generator first, then
 * verifiers), each tagged with its provider display name (for raisedBy). The
 * generator and each verifier both generate AND verify in 'generate' mode. Empty
 * when there is no usable generator.
 */
export function fusionParticipants(): FusionParticipant[] {
  const { generator, verifiers } = resolveEnsemble()
  if (!generator) return []
  const name = (id: LlmProviderId): string => getProvider(id)?.displayName ?? id
  const out: FusionParticipant[] = [
    {
      generator: name(generator.providerId),
      cfg: { providerId: generator.providerId, model: generator.model, key: generator.key },
    },
  ]
  for (const v of verifiers) {
    out.push({ generator: name(v.providerId), cfg: v })
  }
  // Disambiguate same-provider participants (multi-model on one key) by model id
  // so raisedBy / impact don't collapse two models of one provider into one name.
  const counts = new Map<string, number>()
  for (const p of out) counts.set(p.generator, (counts.get(p.generator) ?? 0) + 1)
  for (const p of out) {
    if ((counts.get(p.generator) ?? 0) > 1) p.generator = `${p.generator} (${p.cfg.model.id})`
  }
  return out
}
