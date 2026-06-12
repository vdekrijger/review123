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
