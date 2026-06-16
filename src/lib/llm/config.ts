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
  /** Primary generator participant when its provider key exists, else null. */
  generator: ResolvedParticipant | null
  /** Verifier participants whose provider key exists. */
  verifiers: ProviderConfig[]
}

/** Read a provider's saved key (null when absent). */
function providerKey(providerId: LlmProviderId): string | null {
  return getSettings()[PROVIDER_KEY_FIELDS[providerId]] as string | null
}

/**
 * The DEFAULT panel (Plan P): active provider+model as the SOLE generator;
 * other keyed providers' default models as verifiers (PROVIDERS order, capped).
 * Synthesized when no custom `aiPanel` is stored — byte-identical to #128/#130.
 * Returned as a resolved {generators, verifiers} split.
 */
function defaultResolvedPanel(): ResolvedPanel {
  const active = activeLlmConfig()
  const activeKey = providerKey(active.provider.id)
  const generators: ResolvedParticipant[] = activeKey
    ? [{ providerId: active.provider.id, model: active.model, key: activeKey }]
    : []
  const verifiers: ProviderConfig[] = []
  for (const provider of PROVIDERS) {
    if (provider.id === active.provider.id) continue
    const key = providerKey(provider.id)
    if (!key) continue
    const model = getModelDef(provider, provider.defaultModel) ?? provider.models[0]
    verifiers.push({ providerId: provider.id, model, key })
    if (verifiers.length >= MAX_VERIFIER_PROVIDERS) break
  }
  return { generators, verifiers }
}

/**
 * A resolved unified panel (Plan P): generators + verifiers, each with keys, in
 * panel order. Both lists drop participants whose provider key is missing. The
 * verify-vs-generate mode is emergent from generators.length.
 */
export interface ResolvedPanel {
  /** Generator participants (role 'generator') whose provider key exists. */
  generators: ResolvedParticipant[]
  /** Verifier participants (role 'verifier') whose provider key exists. */
  verifiers: ProviderConfig[]
}

/**
 * Resolve the effective unified panel (Plan P). When `aiPanel` is set, split its
 * participants by role, dropping key-missing ones; the total is bounded only by
 * the ENSEMBLE_RUNAWAY_BACKSTOP (no product cap). When no custom panel is stored,
 * returns the DEFAULT (active gen + other-keyed verifiers) — byte-identical to
 * #128/#130.
 */
export function resolvePanel(): ResolvedPanel {
  const panel = getSettings().aiPanel
  if (!panel) return defaultResolvedPanel()

  const generators: ResolvedParticipant[] = []
  const verifiers: ProviderConfig[] = []
  let total = 0
  for (const p of panel.participants) {
    if (total >= ENSEMBLE_RUNAWAY_BACKSTOP) break
    const provider = getProvider(p.provider)
    if (!provider) continue
    const key = providerKey(provider.id)
    if (!key) continue
    const model = getModelDef(provider, p.model) ?? provider.models[0]
    if (p.role === 'generator') {
      generators.push({ providerId: provider.id, model, key })
    } else {
      verifiers.push({ providerId: provider.id, model, key })
    }
    total += 1
  }
  return { generators, verifiers }
}

/**
 * Resolve the panel into the legacy {generator, verifiers} ensemble shape for
 * call sites that still want a single primary generator (per-model cost rows,
 * the verify path). The primary generator is the FIRST resolved generator; any
 * additional generators are not exposed here (the multi-gen path uses
 * resolvePanel directly). Byte-identical to the old resolveEnsemble for the
 * default panel and for single-generator custom panels.
 */
export function resolveEnsemble(): ResolvedEnsemble {
  const { generators, verifiers } = resolvePanel()
  return { generator: generators[0] ?? null, verifiers }
}

/**
 * Verifier provider configs for the current panel (Plan M call sites). The
 * verify path verifies the primary generator's findings with the participants
 * that did NOT generate: the role-'verifier' participants PLUS any additional
 * generators beyond the first (they verify findings they didn't raise too).
 */
export function verifierProviderConfigs(): ProviderConfig[] {
  const { generators, verifiers } = resolvePanel()
  const extraGenerators: ProviderConfig[] = generators.slice(1).map((g) => ({
    providerId: g.providerId,
    model: g.model,
    key: g.key,
  }))
  return [...verifiers, ...extraGenerators]
}

/**
 * Whether cross-model verification is EFFECTIVE: the master setting is on AND
 * the panel resolves to ≥2 keyed participants (a usable generator plus ≥1 other
 * participant — verifier or second generator). With <2 usable models it is a
 * strict no-op, byte-identical to single-model behaviour.
 */
export function crossModelVerifyEffective(): boolean {
  if (!getSettings().crossModelVerify) return false
  const { generators, verifiers } = resolvePanel()
  if (generators.length === 0) return false
  return generators.length + verifiers.length >= 2
}

/**
 * Emergent panel mode (Plan P): 'generate' when ≥2 generators are effective,
 * else 'verify'. Used for the analytics label and the multi-gen gate.
 */
export function panelMode(): 'verify' | 'generate' {
  return resolvePanel().generators.length >= 2 ? 'generate' : 'verify'
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
 * Whether MULTI-GENERATOR fusion (Plan P emergent 'generate' mode) is EFFECTIVE:
 * cross-verify is effective AND the panel has ≥2 GENERATORS. When false the run
 * uses the single-generator 'verify' path (one generator + verifiers,
 * byte-identical to #130/#133). Single-model / single-key / one-generator users
 * are unaffected.
 */
export function fusionGenerateEffective(): boolean {
  if (!crossModelVerifyEffective()) return false
  return resolvePanel().generators.length >= 2
}

/** Display name for a provider, used in raisedBy / impact attribution. */
function providerName(id: LlmProviderId): string {
  return getProvider(id)?.displayName ?? id
}

/**
 * All panel participants as fusion participants for the multi-generator path
 * (generators first, then verifiers), each tagged with its provider display name
 * (for raisedBy). Every participant both VERIFIES findings it didn't raise; only
 * the GENERATORS generate (the run layer slices generators off the front). Empty
 * when there is no usable generator. Same-provider participants (multi-model on
 * one key) are disambiguated by model id so raisedBy / impact don't collapse.
 */
export function fusionParticipants(): FusionParticipant[] {
  const { generators, verifiers } = resolvePanel()
  if (generators.length === 0) return []
  const out: FusionParticipant[] = []
  for (const g of generators) {
    out.push({
      generator: providerName(g.providerId),
      cfg: { providerId: g.providerId, model: g.model, key: g.key },
    })
  }
  for (const v of verifiers) {
    out.push({ generator: providerName(v.providerId), cfg: v })
  }
  // Disambiguate same-provider participants (multi-model on one key) by model id.
  const counts = new Map<string, number>()
  for (const p of out) counts.set(p.generator, (counts.get(p.generator) ?? 0) + 1)
  for (const p of out) {
    if ((counts.get(p.generator) ?? 0) > 1) p.generator = `${p.generator} (${p.cfg.model.id})`
  }
  return out
}

/**
 * The GENERATOR participants for the multi-generator path (Plan P) — the subset
 * of fusionParticipants() that actually generate. The run layer generates with
 * these and lets ALL fusionParticipants() verify.
 */
export function fusionGenerators(): FusionParticipant[] {
  const generatorCount = resolvePanel().generators.length
  return fusionParticipants().slice(0, generatorCount)
}
