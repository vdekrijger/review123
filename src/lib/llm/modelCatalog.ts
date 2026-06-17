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
 * Pricing verified against OpenRouter's public models API (openrouter.ai/api/v1/models)
 * via scripts/sync-models.mts on 2026-06-16; per-token decimals ×1e6 = per-1M USD.
 * EVERY model now carries pricing so the Step-3 cost column never reads blank.
 * Ids OpenRouter doesn't list directly (hyphenated Anthropic ids, legacy DeepSeek
 * aliases) are priced from their dotted upstream equivalent / provider rate.
 */

import type { LlmModelDef, LlmProviderId } from './providers'

export const MODEL_CATALOG: Record<LlmProviderId, LlmModelDef[]> = {
  deepseek: [
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 0.098, outputPer1M: 0.196 } },
    { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 0.435, outputPer1M: 0.87 } },
    // Legacy ids — alias deepseek-v4-flash's non-thinking/thinking modes;
    // deprecated 2026-07-24. Kept so saved aiModel values keep working.
    // reasoner has no upstream OpenRouter entry → priced at the chat-legacy rate.
    { id: 'deepseek-chat', label: 'DeepSeek Chat (legacy)', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 0.2002, outputPer1M: 0.8001 } },
    { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (legacy)', contextWindowTokens: 1_000_000, supportsTools: false, pricing: { inputPer1M: 0.2002, outputPer1M: 0.8001 } },
  ],
  openai: [
    { id: 'gpt-5.5', label: 'GPT-5.5', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 5, outputPer1M: 30 } },
    { id: 'gpt-5.4', label: 'GPT-5.4', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 2.5, outputPer1M: 15 } },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', contextWindowTokens: 400_000, pricing: { inputPer1M: 0.75, outputPer1M: 4.5 } },
    { id: 'gpt-5.2', label: 'GPT-5.2', contextWindowTokens: 400_000, pricing: { inputPer1M: 1.75, outputPer1M: 14 } },
  ],
  anthropic: [
    { id: 'claude-fable-5', label: 'Claude Fable 5', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 10, outputPer1M: 50 } },
    // claude-opus-4-8 / -haiku-4-5 use hyphenated ids; priced from their dotted
    // OpenRouter equivalents (claude-opus-4.8 $5/$25, claude-haiku-4.5 $1/$5).
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 5, outputPer1M: 25 } },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 3, outputPer1M: 15 } },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextWindowTokens: 200_000, pricing: { inputPer1M: 1, outputPer1M: 5 } },
  ],
  gemini: [
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindowTokens: 1_048_576, pricing: { inputPer1M: 1.5, outputPer1M: 9 } },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', contextWindowTokens: 1_048_576, pricing: { inputPer1M: 2, outputPer1M: 12 } },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindowTokens: 1_048_576, pricing: { inputPer1M: 0.3, outputPer1M: 2.5 } },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindowTokens: 1_048_576, pricing: { inputPer1M: 1.25, outputPer1M: 10 } },
  ],
  // OpenRouter — a single OpenAI-compatible gateway fronting many labs' models
  // behind one key, so the slugs here are namespaced (vendor/model). Curated ~14
  // representative models from the LIVE public list openrouter.ai/api/v1/models
  // (fetched 2026-06-17; per-token decimals ×1e6 = per-1M USD, the same
  // conversion scripts/sync-models.mts does). A spread of the current frontier
  // from each major lab plus cheap workhorses. supportsTools reflects each
  // model's `supported_parameters` containing "tools" upstream (all true here).
  openrouter: [
    { id: 'deepseek/deepseek-chat-v3.1', label: 'DeepSeek V3.1', contextWindowTokens: 163_840, pricing: { inputPer1M: 0.21, outputPer1M: 0.79 } },
    { id: 'openai/gpt-5.1', label: 'OpenAI GPT-5.1', contextWindowTokens: 400_000, pricing: { inputPer1M: 1.25, outputPer1M: 10 } },
    { id: 'openai/gpt-5', label: 'OpenAI GPT-5', contextWindowTokens: 400_000, pricing: { inputPer1M: 1.25, outputPer1M: 10 } },
    { id: 'anthropic/claude-sonnet-4.5', label: 'Anthropic Claude Sonnet 4.5', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 3, outputPer1M: 15 } },
    { id: 'anthropic/claude-opus-4.1', label: 'Anthropic Claude Opus 4.1', contextWindowTokens: 200_000, pricing: { inputPer1M: 15, outputPer1M: 75 } },
    { id: 'anthropic/claude-3.5-haiku', label: 'Anthropic Claude 3.5 Haiku', contextWindowTokens: 200_000, pricing: { inputPer1M: 0.8, outputPer1M: 4 } },
    { id: 'google/gemini-2.5-pro', label: 'Google Gemini 2.5 Pro', contextWindowTokens: 1_048_576, pricing: { inputPer1M: 1.25, outputPer1M: 10 } },
    { id: 'google/gemini-2.5-flash', label: 'Google Gemini 2.5 Flash', contextWindowTokens: 1_048_576, pricing: { inputPer1M: 0.3, outputPer1M: 2.5 } },
    { id: 'x-ai/grok-4.20', label: 'xAI Grok 4.20', contextWindowTokens: 2_000_000, pricing: { inputPer1M: 1.25, outputPer1M: 2.5 } },
    { id: 'x-ai/grok-4.3', label: 'xAI Grok 4.3', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 1.25, outputPer1M: 2.5 } },
    { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Meta Llama 3.3 70B Instruct', contextWindowTokens: 131_072, pricing: { inputPer1M: 0.1, outputPer1M: 0.32 } },
    { id: 'mistralai/mistral-large', label: 'Mistral Large', contextWindowTokens: 128_000, pricing: { inputPer1M: 2, outputPer1M: 6 } },
    { id: 'qwen/qwen3-235b-a22b', label: 'Qwen3 235B A22B', contextWindowTokens: 131_072, pricing: { inputPer1M: 0.455, outputPer1M: 1.82 } },
    { id: 'qwen/qwen-2.5-72b-instruct', label: 'Qwen2.5 72B Instruct', contextWindowTokens: 131_072, pricing: { inputPer1M: 0.36, outputPer1M: 0.4 } },
  ],
}
