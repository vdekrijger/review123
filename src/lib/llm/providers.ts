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
}

// Token budget formula: budgetTokens = contextWindowTokens - maxOutputTokens - promptOverhead
// maxOutputTokens = 4_000, promptOverhead = 2_000
const MAX_OUTPUT_TOKENS = 4_000

/** Compute the token budget for context packing given a model's context window. */
export function computeBudgetTokens(contextWindowTokens: number): number {
  return contextWindowTokens - MAX_OUTPUT_TOKENS - 2_000
}

export const PROVIDERS: LlmProviderDef[] = [
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    transport: 'openai-compat',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    keyHint: 'sk-...',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat (V3)', contextWindowTokens: 64_000 },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)', contextWindowTokens: 64_000 },
    ],
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    transport: 'openai-compat',
    // Routed through our serverless proxy (no browser CORS on api.openai.com)
    baseUrl: '/api/llm/openai',
    defaultModel: 'gpt-5.2',
    keyHint: 'sk-...',
    models: [
      { id: 'gpt-5.2', label: 'GPT-5.2', contextWindowTokens: 128_000 },
      { id: 'gpt-4.1', label: 'GPT-4.1', contextWindowTokens: 128_000 },
      { id: 'o4-mini', label: 'o4-mini', contextWindowTokens: 128_000 },
    ],
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    transport: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-6',
    keyHint: 'sk-ant-...',
    models: [
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindowTokens: 200_000 },
      { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', contextWindowTokens: 200_000 },
      { id: 'claude-haiku-3-5', label: 'Claude Haiku 3.5', contextWindowTokens: 200_000 },
    ],
  },
  {
    id: 'gemini',
    displayName: 'Gemini',
    transport: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-2.5-flash',
    keyHint: 'AIza...',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindowTokens: 1_000_000 },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindowTokens: 1_000_000 },
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
