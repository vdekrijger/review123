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

import { MODEL_CATALOG } from './modelCatalog'

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

// The per-provider model lineup lives in ./modelCatalog (MODEL_CATALOG), a
// single typed catalog the daily sync script regenerates against OpenRouter's
// public models API. Each provider below sources its `models` from
// MODEL_CATALOG[id]; all OTHER provider fields (defaultModel, baseUrl, …) are
// authored here and are NEVER touched by the sync.
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
    models: MODEL_CATALOG.deepseek,
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
    models: MODEL_CATALOG.openai,
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
    models: MODEL_CATALOG.anthropic,
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
    models: MODEL_CATALOG.gemini,
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
