/**
 * Model catalog — the per-provider MODEL LIST, extracted from providers.ts so a
 * sync script (scripts/sync-models.mts) can regenerate it deterministically
 * against OpenRouter's public models API.
 *
 * This file is the SINGLE SOURCE OF TRUTH for model ids / labels / context
 * windows / pricing / tool-support. providers.ts wires each provider's `models`
 * from MODEL_CATALOG[id] and authors everything else (id, displayName,
 * transport, baseUrl, defaultModel, keyHint, maxTokensParam) itself — those
 * provider-level fields NEVER live here and are out of scope for the sync.
 *
 * Human-readable TS (not JSON) on purpose: the typing and the pricing-source /
 * deprecation comments below are load-bearing context. The sync script rewrites
 * this file from a computed catalog when upstream drifts; keep the format it
 * emits in mind when hand-editing.
 *
 * Model lineups verified against official provider docs on 2026-06-12:
 * - DeepSeek:  https://api-docs.deepseek.com/quick_start/pricing
 * - OpenAI:    https://developers.openai.com/api/docs/models
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/models/overview
 * - Gemini:    https://ai.google.dev/gemini-api/docs/models
 */

import type { LlmModelDef, LlmProviderId } from './providers'

export const MODEL_CATALOG: Record<LlmProviderId, LlmModelDef[]> = {
  deepseek: [
    // Pricing (api-docs.deepseek.com/quick_start/pricing, verified 2026-06-14):
    // V4 Flash standard cache-miss $0.14 in / $0.28 out per MTok.
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 0.14, outputPer1M: 0.28 } },
    { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindowTokens: 1_000_000 },
    // Legacy ids — per DeepSeek docs they now alias deepseek-v4-flash's
    // non-thinking/thinking modes; deprecated 2026-07-24. Kept so saved
    // aiModel values from earlier versions keep working until then.
    { id: 'deepseek-chat', label: 'DeepSeek Chat (legacy)', contextWindowTokens: 1_000_000 },
    { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (legacy)', contextWindowTokens: 1_000_000, supportsTools: false },
  ],
  openai: [
    // Pricing (openai.com/api/pricing, verified 2026-06-14), USD per MTok:
    { id: 'gpt-5.5', label: 'GPT-5.5', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 5, outputPer1M: 30 } },
    { id: 'gpt-5.4', label: 'GPT-5.4', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 2.5, outputPer1M: 15 } },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', contextWindowTokens: 400_000, pricing: { inputPer1M: 0.75, outputPer1M: 4.5 } },
    // Previous default — still available ("previous frontier model").
    // gpt-5.2 pricing not re-verified → tokens only (no $ shown).
    { id: 'gpt-5.2', label: 'GPT-5.2', contextWindowTokens: 400_000 },
  ],
  anthropic: [
    // Pricing (platform.claude.com/docs pricing, verified 2026-06-14), USD per MTok.
    // Fable 5 / Opus 4.8 list prices not re-verified → tokens only (no $).
    { id: 'claude-fable-5', label: 'Claude Fable 5', contextWindowTokens: 1_000_000 },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindowTokens: 1_000_000 },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 3, outputPer1M: 15 } },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextWindowTokens: 200_000 },
  ],
  gemini: [
    // Pricing (ai.google.dev/gemini-api/docs/pricing, verified 2026-06-14):
    // 3.5 Flash global tier $1.50 in / $9.00 out per MTok.
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindowTokens: 1_048_576, pricing: { inputPer1M: 1.5, outputPer1M: 9 } },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', contextWindowTokens: 1_048_576 },
    // Previous generation — still stable; gemini-2.5-flash was the old default.
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindowTokens: 1_048_576 },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindowTokens: 1_048_576 },
  ],
}
