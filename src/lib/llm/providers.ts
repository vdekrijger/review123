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

export type LlmProviderId = 'deepseek' | 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'bridge'

/**
 * The API providers — everything except the local bridge. MODEL_CATALOG is
 * keyed by this, because the bridge's "models" are CLI ids, not a vendor
 * lineup, and the daily OpenRouter sync must never touch them.
 */
export type ApiProviderId = Exclude<LlmProviderId, 'bridge'>

export type LlmTransport = 'openai-compat' | 'anthropic' | 'gemini' | 'bridge'

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
  /**
   * Flagship marker for providers with a LARGE lineup (OpenRouter's ~300). The
   * searchable model picker shows the featured set first on an empty query so the
   * user isn't dumped into hundreds of options. Omitted = false. Set by the model
   * sync from the stable OPENROUTER_FEATURED_IDS list; ignored for the small,
   * fully-listed single-vendor providers.
   */
  featured?: boolean
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

/**
 * The LOCAL BRIDGE's "model" lineup — which CLI to drive, not which model.
 *
 * Hand-authored here rather than in MODEL_CATALOG: these are process names, the
 * daily OpenRouter sync has nothing to say about them, and regenerating the
 * catalog must never drop them.
 *
 * Three fields carry real weight:
 *
 * - NO `pricing`. Inference on the user's own subscription has no per-token
 *   list price we could honestly quote, and estimateCostUsd returns null
 *   without it — so the UI shows tokens and no fabricated dollar figure.
 * - `supportsTools: true`, with a DIFFERENT MECHANISM behind it than every other
 *   provider — which is why this comment is long.
 *
 *   The flag answers one question for its callers: "can a deep (agentic) review
 *   run on this model?" For an API model the answer is yes because review123
 *   drives its own tool loop. For the bridge the answer is ALSO yes, but the
 *   loop runs inside the CLI: it is given real read-only tools (Read, Glob,
 *   Grep) and investigates the user's actual working tree. llmToolLoop's bridge
 *   arm delegates to that instead of driving rounds itself, so every existing
 *   call site keeps working with no change — which is precisely what the flag
 *   is for.
 *
 *   IT STILL DOES NOT MEAN review123's tool loop drives the CLI. That remains a
 *   bad idea for the original reason — an agent steering an agent through a text
 *   pipe, with two tool vocabularies that do not agree — and llmToolLoop does
 *   not do it. What changed is that "the CLI is already an agent" turned out to
 *   be the wrong reason to refuse: in the ordinary invocation the CLI is NOT
 *   acting as an agent, because the bridge passes `--tools ""` and takes its
 *   tools away. Giving three read-only ones back is the whole feature.
 *
 *   AVAILABILITY IS STILL CHECKED SEPARATELY, and must be. This flag is a fact
 *   about the model lineup, but a paired bridge may be too OLD to understand the
 *   agentic request — and an old bridge does not fail, it silently answers
 *   tool-less. deepReview.ts's harness gate reads the live
 *   `capabilities.inferAgentic` for exactly that case.
 * - `contextWindowTokens` is deliberately CONSERVATIVE. The real window belongs
 *   to whichever model the user's CLI is configured for, which the bridge never
 *   reports, so the packer is given a budget every current option can hold.
 */
export const BRIDGE_MODELS: LlmModelDef[] = [
  {
    id: 'claude',
    label: 'Claude Code CLI',
    contextWindowTokens: 200_000,
    supportsTools: true,
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    contextWindowTokens: 200_000,
    supportsTools: true,
  },
]

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
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    // OpenAI-compatible gateway: same chat/completions wire format as DeepSeek,
    // and built for client-side use (sends CORS headers), so we call it DIRECT
    // from the browser — no serverless proxy. baseUrl/chat/completions is the
    // endpoint; the openai-compat adapter adds OpenRouter's attribution headers.
    transport: 'openai-compat',
    baseUrl: 'https://openrouter.ai/api/v1',
    // OpenRouter is OpenAI-compatible and accepts max_tokens (not the GPT-5
    // max_completion_tokens quirk — it normalizes the param per upstream model).
    maxTokensParam: 'max_tokens',
    // Default: DeepSeek V3.1 — a cheap-but-capable workhorse from the curated set.
    defaultModel: 'deepseek/deepseek-chat-v3.1',
    keyHint: 'sk-or-...',
    models: MODEL_CATALOG.openrouter,
  },
  {
    id: 'bridge',
    displayName: 'Local bridge',
    // Not an HTTP vendor at all: the "request" is a POST to 127.0.0.1 that
    // makes the bridge spawn the user's own CLI. baseUrl is unused — the
    // address comes from the stored pairing (port), never from a constant.
    transport: 'bridge',
    baseUrl: '',
    defaultModel: 'claude',
    // There is no key to paste: the credential is the bridge pairing token,
    // stored by the Local bridge settings section.
    keyHint: '',
    models: BRIDGE_MODELS,
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
