/**
 * Provider definitions for multi-LLM support (Plan F).
 *
 * Transport facts (verified, encode as comments):
 * - 'openai-compat': OpenAI chat/completions wire format; DeepSeek uses it
 *   directly (browser CORS OK); OpenAI itself requires the api/llm/openai.ts
 *   serverless proxy (no browser CORS).
 * - 'anthropic': browser CORS supported WITH header
 *   `anthropic-dangerous-direct-browser-access: true`; Messages API
 *   (/v1/messages); SSE streaming via content_block_delta events;
 *   JSON mode = prompt-enforced (no response_format field).
 * - 'gemini': browser CORS supported; generateContent/:streamGenerateContent?alt=sse;
 *   JSON via generationConfig.responseMimeType application/json;
 *   key via x-goog-api-key header.
 */

export type LlmProviderId = 'deepseek' | 'openai' | 'anthropic' | 'gemini'
export type LlmTransport = 'openai-compat' | 'anthropic' | 'gemini'

export interface LlmModelDef {
  id: string
  label: string
  contextWindowTokens: number
  /**
   * Whether the model supports function calling / tool use (Plan G deep review).
   * Omitted = true. Verified 2026-06-13 against provider docs:
   * - DeepSeek: tools supported on deepseek-v4-flash / v4-pro / deepseek-chat
   *   (api-docs.deepseek.com/guides/function_calling); legacy deepseek-reasoner
   *   historically does NOT support function calling → flagged false.
   * - OpenAI / Anthropic / Gemini lineups here all support tool use.
   */
  supportsTools?: boolean
  /**
   * Public list price per 1M tokens (USD), used only for the OPTIONAL
   * "Show token usage" power-user estimate. Standard (cache-miss) rates;
   * we don't model prompt caching / batch discounts, so the $ shown is a
   * rough upper bound. Omitted = no $ estimate (tokens shown only).
   * Verified June 2026 against official pricing pages (see PROVIDERS below).
   */
  pricing?: { inputPer1M: number; outputPer1M: number }
}

/** True when a model supports tool use. Omitted flag = supported. */
export function modelSupportsTools(model: LlmModelDef): boolean {
  return model.supportsTools !== false
}

/**
 * Rough USD cost for a token usage split, given a model's list pricing.
 * Returns null when the model carries no pricing (caller shows tokens only —
 * never a fabricated $). Standard cache-miss rates; an upper-bound estimate.
 */
export function estimateCostUsd(
  model: Pick<LlmModelDef, 'pricing'>,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const p = model.pricing
  if (!p) return null
  return (promptTokens / 1e6) * p.inputPer1M + (completionTokens / 1e6) * p.outputPer1M
}

export interface LlmProviderDef {
  id: LlmProviderId
  displayName: string
  models: LlmModelDef[]
  defaultModel: string
  keyHint: string
  transport: LlmTransport
  /** Base URL for direct API calls. For OpenAI this points to the local proxy. */
  baseUrl: string
  /**
   * Body field for the output-token cap on openai-compat requests. OpenAI's
   * GPT-5 family rejects the legacy `max_tokens` with a 400 ("Use
   * 'max_completion_tokens' instead"); DeepSeek still uses `max_tokens`.
   * Defaults to 'max_tokens' when omitted.
   */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens'
}

// Token budget formula: budgetTokens = contextWindowTokens - maxOutputTokens - promptOverhead
// maxOutputTokens = 4_000, promptOverhead = 2_000
const MAX_OUTPUT_TOKENS = 4_000

/** Compute the token budget for context packing given a model's context window. */
export function computeBudgetTokens(contextWindowTokens: number): number {
  return contextWindowTokens - MAX_OUTPUT_TOKENS - 2_000
}

// Model lineups verified against official provider docs on 2026-06-12:
// - DeepSeek:  https://api-docs.deepseek.com/quick_start/pricing
// - OpenAI:    https://developers.openai.com/api/docs/models
// - Anthropic: https://platform.claude.com/docs/en/about-claude/models/overview
// - Gemini:    https://ai.google.dev/gemini-api/docs/models
// If a user's saved aiModel id disappears from a lineup, activeLlmConfig()
// falls back to the provider's defaultModel.
export const PROVIDERS: LlmProviderDef[] = [
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    transport: 'openai-compat',
    baseUrl: 'https://api.deepseek.com',
    // Default: V4 Flash — DeepSeek's primary current offering; best
    // cost/quality balance for code review ($0.14/$0.28 per MTok).
    defaultModel: 'deepseek-v4-flash',
    keyHint: 'sk-...',
    models: [
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
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    transport: 'openai-compat',
    // Routed through our serverless proxy (no browser CORS on api.openai.com)
    baseUrl: '/api/llm/openai',
    // GPT-5 family requires max_completion_tokens; max_tokens → 400.
    maxTokensParam: 'max_completion_tokens',
    // Default: GPT-5.4 — strong coding model at half the flagship's price
    // ($2.50/$15 vs GPT-5.5's $5/$30 per MTok).
    defaultModel: 'gpt-5.4',
    keyHint: 'sk-...',
    models: [
      // Pricing (openai.com/api/pricing, verified 2026-06-14), USD per MTok:
      { id: 'gpt-5.5', label: 'GPT-5.5', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 5, outputPer1M: 30 } },
      { id: 'gpt-5.4', label: 'GPT-5.4', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 2.5, outputPer1M: 15 } },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', contextWindowTokens: 400_000, pricing: { inputPer1M: 0.75, outputPer1M: 4.5 } },
      // Previous default — still available ("previous frontier model").
      // gpt-5.2 pricing not re-verified → tokens only (no $ shown).
      { id: 'gpt-5.2', label: 'GPT-5.2', contextWindowTokens: 400_000 },
    ],
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    transport: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    // Default: Sonnet 4.6 — "best combination of speed and intelligence"
    // ($3/$15 per MTok); also the previous default, so saved values keep working.
    defaultModel: 'claude-sonnet-4-6',
    keyHint: 'sk-ant-...',
    models: [
      // Pricing (platform.claude.com/docs pricing, verified 2026-06-14), USD per MTok.
      // Fable 5 / Opus 4.8 list prices not re-verified → tokens only (no $).
      { id: 'claude-fable-5', label: 'Claude Fable 5', contextWindowTokens: 1_000_000 },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindowTokens: 1_000_000 },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 3, outputPer1M: 15 } },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextWindowTokens: 200_000 },
    ],
  },
  {
    id: 'gemini',
    displayName: 'Gemini',
    transport: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    // Default: 3.5 Flash — stable, "frontier performance on agentic and
    // coding tasks" at workhorse pricing.
    defaultModel: 'gemini-3.5-flash',
    keyHint: 'AIza...',
    models: [
      // Pricing (ai.google.dev/gemini-api/docs/pricing, verified 2026-06-14):
      // 3.5 Flash global tier $1.50 in / $9.00 out per MTok.
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindowTokens: 1_048_576, pricing: { inputPer1M: 1.5, outputPer1M: 9 } },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', contextWindowTokens: 1_048_576 },
      // Previous generation — still stable; gemini-2.5-flash was the old default.
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindowTokens: 1_048_576 },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindowTokens: 1_048_576 },
    ],
  },
]

/** Look up a provider definition by id. Returns undefined if not found. */
export function getProvider(id: LlmProviderId): LlmProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

/** Look up a model definition within a provider. Returns undefined if not found. */
export function getModelDef(provider: LlmProviderDef, modelId: string): LlmModelDef | undefined {
  return provider.models.find((m) => m.id === modelId)
}
