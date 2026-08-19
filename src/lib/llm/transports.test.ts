/**
 * Multi-LLM transport layer tests (Plan F Task F1).
 *
 * Coverage:
 *   - providers.ts: defs, getProvider, getModelDef, computeBudgetTokens
 *   - config.ts: activeLlmConfig() provider/model selection
 *   - llm.ts: deepseek default path (openai-compat), anthropic transport,
 *             gemini transport — complete + stream + usage
 *   - key gating per provider (no-key LlmError)
 *   - cache key model component (cacheKey with modelId)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  PROVIDERS,
  getProvider,
  getModelDef,
  computeBudgetTokens,
} from './providers'
import { setTransientRetryPolicyForTests } from './transientRetry'
import { activeLlmConfig } from './config'
import {
  llmComplete,
  llmCompleteWithUsage,
  llmStream,
  llmStreamWithUsage,
  LlmError,
  INVALID_KEY_CHAR_MESSAGE,
} from './llm'
import {
  setDeepseekKey,
  setOpenaiKey,
  setAnthropicKey,
  setGeminiKey,
  setOpenrouterKey,
  setAiProvider,
  setAiModel,
} from '../settings/settings'
import { cacheKey } from '../cache/aiCache'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
  // This suite is about terminal status MAPPING per transport — transient
  // retry has its own dedicated suite (transientRetry.test.ts).
  setTransientRetryPolicyForTests({ maxRetries: 0 })
})

afterEach(() => {
  setTransientRetryPolicyForTests(null)
})

// ===========================================================================
// providers.ts
// ===========================================================================

describe('PROVIDERS — structure', () => {
  it('exports exactly 5 providers: deepseek, openai, anthropic, gemini, openrouter', () => {
    const ids = PROVIDERS.map((p) => p.id)
    expect(ids).toEqual(['deepseek', 'openai', 'anthropic', 'gemini', 'openrouter'])
  })

  it('openrouter has transport openai-compat, a direct baseUrl, and a curated default', () => {
    const p = getProvider('openrouter')!
    expect(p.transport).toBe('openai-compat')
    expect(p.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(p.maxTokensParam).toBe('max_tokens')
    expect(p.defaultModel).toBe('deepseek/deepseek-chat-v3.1')
    // The default resolves to a real catalog entry with pricing.
    const def = getModelDef(p, p.defaultModel)!
    expect(def).toBeDefined()
    expect(def.pricing).toBeDefined()
    expect(p.models.length).toBeGreaterThanOrEqual(1)
  })

  it('deepseek has transport openai-compat and default model deepseek-v4-flash', () => {
    const p = getProvider('deepseek')!
    expect(p.transport).toBe('openai-compat')
    expect(p.defaultModel).toBe('deepseek-v4-flash')
    expect(p.baseUrl).toBe('https://api.deepseek.com')
  })

  it('deepseek keeps the legacy deepseek-chat/-reasoner ids until their 2026-07-24 deprecation', () => {
    const p = getProvider('deepseek')!
    expect(getModelDef(p, 'deepseek-chat')).toBeDefined()
    expect(getModelDef(p, 'deepseek-reasoner')).toBeDefined()
  })

  it('openai has transport openai-compat and default model gpt-5.4', () => {
    const p = getProvider('openai')!
    expect(p.transport).toBe('openai-compat')
    expect(p.defaultModel).toBe('gpt-5.4')
    // Must route through proxy, not api.openai.com directly
    expect(p.baseUrl).toBe('/api/llm/openai')
  })

  it('openai keeps the previous default gpt-5.2 (still available)', () => {
    expect(getModelDef(getProvider('openai')!, 'gpt-5.2')).toBeDefined()
  })

  it('anthropic has transport anthropic and default model claude-sonnet-4-6', () => {
    const p = getProvider('anthropic')!
    expect(p.transport).toBe('anthropic')
    expect(p.defaultModel).toBe('claude-sonnet-4-6')
    expect(p.baseUrl).toBe('https://api.anthropic.com')
  })

  it('anthropic lineup spans Fable 5 down to Haiku 4.5', () => {
    const p = getProvider('anthropic')!
    expect(getModelDef(p, 'claude-fable-5')).toBeDefined()
    expect(getModelDef(p, 'claude-opus-4-8')).toBeDefined()
    expect(getModelDef(p, 'claude-haiku-4-5')).toBeDefined()
  })

  it('gemini has transport gemini and default model gemini-3.5-flash', () => {
    const p = getProvider('gemini')!
    expect(p.transport).toBe('gemini')
    expect(p.defaultModel).toBe('gemini-3.5-flash')
    expect(p.baseUrl).toBe('https://generativelanguage.googleapis.com')
  })

  it('gemini keeps the previous default gemini-2.5-flash (still stable)', () => {
    expect(getModelDef(getProvider('gemini')!, 'gemini-2.5-flash')).toBeDefined()
  })

  it('every provider ships a lineup (single-vendor 2-4; the OpenRouter gateway the FULL generated list)', () => {
    for (const p of PROVIDERS) {
      expect(p.models.length).toBeGreaterThanOrEqual(2)
      if (p.id === 'openrouter') {
        // OpenRouter now carries the FULL generated chat lineup (~300 models)
        // for the searchable, lab-grouped picker — not a hand-curated handful.
        expect(p.models.length).toBeGreaterThan(50)
      } else {
        // The single-vendor providers stay tight (2-4).
        expect(p.models.length).toBeLessThanOrEqual(4)
      }
    }
  })

  it('every OpenRouter model is a `lab/model` slug with pricing + context (single pricing source)', () => {
    const or = getProvider('openrouter')!
    for (const m of or.models) {
      expect(m.id).toMatch(/^[~]?[\w.-]+\/[\w.:-]+$/)
      expect(m.contextWindowTokens).toBeGreaterThan(0)
      expect(m.pricing).toBeDefined()
      expect(m.pricing!.inputPer1M).toBeGreaterThanOrEqual(0)
      expect(m.pricing!.outputPer1M).toBeGreaterThanOrEqual(0)
    }
  })

  it('OpenRouter marks a small featured set (~10 flagships) for the picker default view', () => {
    const featured = getProvider('openrouter')!.models.filter((m) => m.featured)
    expect(featured.length).toBeGreaterThanOrEqual(5)
    expect(featured.length).toBeLessThanOrEqual(15)
  })

  it('every model def has a non-empty id, a human label and a positive context window', () => {
    for (const p of PROVIDERS) {
      for (const m of p.models) {
        expect(m.id).toBeTruthy()
        expect(m.label).toBeTruthy()
        expect(m.contextWindowTokens).toBeGreaterThan(0)
      }
    }
  })

  it('model ids are unique within each provider', () => {
    for (const p of PROVIDERS) {
      const ids = p.models.map((m) => m.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('each provider defaultModel is in its models list', () => {
    for (const p of PROVIDERS) {
      const found = getModelDef(p, p.defaultModel)
      expect(found).toBeDefined()
    }
  })
})

describe('computeBudgetTokens', () => {
  it('64_000 context → 58_000 budget', () => {
    expect(computeBudgetTokens(64_000)).toBe(58_000)
  })

  it('200_000 context → 194_000 budget', () => {
    expect(computeBudgetTokens(200_000)).toBe(194_000)
  })

  it('1_000_000 context → 994_000 budget', () => {
    expect(computeBudgetTokens(1_000_000)).toBe(994_000)
  })
})

describe('getProvider', () => {
  it('returns provider for known ids', () => {
    expect(getProvider('deepseek')).toBeDefined()
    expect(getProvider('openai')).toBeDefined()
    expect(getProvider('anthropic')).toBeDefined()
    expect(getProvider('gemini')).toBeDefined()
  })

  it('returns undefined for unknown id', () => {
    // @ts-expect-error intentional
    expect(getProvider('unknown')).toBeUndefined()
  })
})

// ===========================================================================
// activeLlmConfig()
// ===========================================================================

describe('activeLlmConfig()', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to deepseek provider and deepseek-v4-flash model when no settings stored', () => {
    const cfg = activeLlmConfig()
    expect(cfg.provider.id).toBe('deepseek')
    expect(cfg.model.id).toBe('deepseek-v4-flash')
    expect(cfg.budgetTokens).toBe(994_000)
  })

  it('returns anthropic provider and claude-sonnet-4-6 when aiProvider=anthropic and no aiModel', () => {
    setAiProvider('anthropic')
    const cfg = activeLlmConfig()
    expect(cfg.provider.id).toBe('anthropic')
    expect(cfg.model.id).toBe('claude-sonnet-4-6')
  })

  it('returns the stored model when aiModel is valid for the provider', () => {
    setAiProvider('gemini')
    setAiModel('gemini-2.5-pro')
    const cfg = activeLlmConfig()
    expect(cfg.provider.id).toBe('gemini')
    expect(cfg.model.id).toBe('gemini-2.5-pro')
  })

  it('falls back to provider default when aiModel is not found in provider models', () => {
    setAiProvider('anthropic')
    setAiModel('nonexistent-model')
    const cfg = activeLlmConfig()
    expect(cfg.model.id).toBe('claude-sonnet-4-6')
  })

  it('falls back to defaultModel when a saved aiModel was removed in a lineup refresh', () => {
    // o4-mini was a valid OpenAI model id before the June 2026 lineup refresh.
    setAiProvider('openai')
    setAiModel('o4-mini')
    const cfg = activeLlmConfig()
    expect(cfg.provider.id).toBe('openai')
    expect(cfg.model.id).toBe('gpt-5.4')
    expect(cfg.budgetTokens).toBe(994_000) // budget follows the fallback model
  })

  it('returns openai provider with gpt-5.4 default when aiProvider=openai', () => {
    setAiProvider('openai')
    const cfg = activeLlmConfig()
    expect(cfg.provider.id).toBe('openai')
    expect(cfg.model.id).toBe('gpt-5.4')
    expect(cfg.budgetTokens).toBe(994_000) // 1_000_000 - 4_000 - 2_000
  })
})

// ===========================================================================
// Key gating — no-key throws LlmError('no-key') for each provider
// ===========================================================================

describe('key gating — no key throws LlmError("no-key") for each provider', () => {
  it('deepseek: no deepseekKey → no-key (deepseek default path)', async () => {
    // localStorage is empty (no key)
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'no-key' })
    expect(f).not.toHaveBeenCalled()
  })

  it('anthropic: no anthropicKey → no-key', async () => {
    setAiProvider('anthropic')
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'no-key' })
    expect(f).not.toHaveBeenCalled()
  })

  it('gemini: no geminiKey → no-key', async () => {
    setAiProvider('gemini')
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'no-key' })
    expect(f).not.toHaveBeenCalled()
  })

  it('openai: no openaiKey → no-key', async () => {
    setAiProvider('openai')
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'no-key' })
    expect(f).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// openai-compat transport — deepseek default path (regression guard)
// ===========================================================================

describe('openai-compat — deepseek default path (regression)', () => {
  beforeEach(() => {
    setDeepseekKey('sk-test')
    // aiProvider defaults to deepseek
  })

  it('posts to api.deepseek.com/chat/completions with Bearer auth', async () => {
    const f = vi.fn().mockResolvedValue(makeJsonResponse({ choices: [{ message: { content: 'hello' } }] }))
    vi.stubGlobal('fetch', f)
    const result = await llmComplete({ system: 'sys', user: 'usr' })
    expect(result).toBe('hello')
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test')
  })

  it('sends model deepseek-v4-flash (provider default) in body', async () => {
    const f = vi.fn().mockResolvedValue(makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }))
    vi.stubGlobal('fetch', f)
    await llmComplete({ system: 's', user: 'u' })
    const body = JSON.parse((f.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.model).toBe('deepseek-v4-flash')
  })

  it('llmCompleteWithUsage captures usage', async () => {
    const body = {
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(body)))
    const { content, usage } = await llmCompleteWithUsage({ system: 's', user: 'u' })
    expect(content).toBe('hi')
    expect(usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
  })

  it('llmStream accumulates deltas and returns full content', async () => {
    const sseEvent = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
    const chunks = [sseEvent('Hello'), sseEvent(' world'), 'data: [DONE]\n\n']
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 })))
    const deltas: string[] = []
    const result = await llmStream({ system: 's', user: 'u' }, (d) => deltas.push(d))
    expect(result).toBe('Hello world')
    expect(deltas).toEqual(['Hello', ' world'])
  })

  it('llmStreamWithUsage captures usage from final chunk', async () => {
    const sseEvent = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
    const usageChunk = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`
    const chunks = [sseEvent('hi'), usageChunk, 'data: [DONE]\n\n']
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 })))
    const result = await llmStreamWithUsage({ system: 's', user: 'u' }, () => {})
    expect(result.content).toBe('hi')
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
  })
})

describe('openai-compat — openrouter path (direct, with attribution headers)', () => {
  beforeEach(() => {
    setAiProvider('openrouter')
    setOpenrouterKey('sk-or-test')
  })

  it('posts DIRECT to openrouter.ai/api/v1/chat/completions with Bearer + attribution headers', async () => {
    const f = vi.fn().mockResolvedValue(makeJsonResponse({ choices: [{ message: { content: 'hi' } }] }))
    vi.stubGlobal('fetch', f)
    const result = await llmComplete({ system: 'sys', user: 'usr' })
    expect(result).toBe('hi')
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-or-test')
    expect(headers['HTTP-Referer']).toBe('https://review123.dev')
    expect(headers['X-Title']).toBe('Review 1-2-3')
  })

  it('sends the openrouter default model (namespaced slug) in the body', async () => {
    const f = vi.fn().mockResolvedValue(makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }))
    vi.stubGlobal('fetch', f)
    await llmComplete({ system: 's', user: 'u' })
    const body = JSON.parse((f.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.model).toBe('deepseek/deepseek-chat-v3.1')
  })
})

// ===========================================================================
// anthropic transport — complete + stream + usage
// ===========================================================================

describe('anthropic transport — llmComplete', () => {
  beforeEach(() => {
    setAiProvider('anthropic')
    setAnthropicKey('sk-ant-test')
  })

  it('posts to api.anthropic.com/v1/messages with correct headers', async () => {
    const body = { content: [{ type: 'text', text: 'hello from claude' }], usage: { input_tokens: 10, output_tokens: 5 } }
    const f = vi.fn().mockResolvedValue(makeJsonResponse(body))
    vi.stubGlobal('fetch', f)
    const result = await llmComplete({ system: 'sys', user: 'usr' })
    expect(result).toBe('hello from claude')
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true')
  })

  it('sends model id in request body (not Authorization Bearer)', async () => {
    const body = { content: [{ type: 'text', text: 'ok' }] }
    const f = vi.fn().mockResolvedValue(makeJsonResponse(body))
    vi.stubGlobal('fetch', f)
    await llmComplete({ system: 's', user: 'u' })
    const reqBody = JSON.parse((f.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(reqBody.model).toBe('claude-sonnet-4-6')
    // No Authorization header (Anthropic uses x-api-key instead)
    const headers = (f.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })

  it('llmCompleteWithUsage maps Anthropic usage (input_tokens/output_tokens) to LlmUsage', async () => {
    const body = {
      content: [{ type: 'text', text: 'content' }],
      usage: { input_tokens: 20, output_tokens: 8 },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(body)))
    const { content, usage } = await llmCompleteWithUsage({ system: 's', user: 'u' })
    expect(content).toBe('content')
    expect(usage).toEqual({ prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 })
  })

  it('throws LlmError("server") when no text content block in response', async () => {
    const body = { content: [{ type: 'image' }] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(body)))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'server' })
  })

  it('maps 401 → LlmError("auth")', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse({}, 401)))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps 429 → LlmError("rate-limited")', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse({}, 429)))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'rate-limited' })
  })

  it('json flag does NOT add response_format field (Anthropic: prompt-enforced)', async () => {
    const body = { content: [{ type: 'text', text: '{"x":1}' }] }
    const f = vi.fn().mockResolvedValue(makeJsonResponse(body))
    vi.stubGlobal('fetch', f)
    await llmComplete({ system: 's', user: 'u', json: true })
    const reqBody = JSON.parse((f.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(reqBody.response_format).toBeUndefined()
  })
})

describe('anthropic transport — llmStream (SSE: content_block_delta)', () => {
  beforeEach(() => {
    setAiProvider('anthropic')
    setAnthropicKey('sk-ant-test')
  })

  /**
   * Realistic Anthropic SSE fixture:
   *   event: message_start → message: { usage: { input_tokens, output_tokens } }
   *   event: content_block_delta → delta: { type: "text_delta", text: "..." }
   *   event: message_delta → usage: { output_tokens }
   *   event: message_stop
   */
  function anthropicSseStream(textParts: string[], inputTokens = 10, outputTokens = 5): string[] {
    const lines: string[] = []

    // message_start with input usage
    lines.push(`data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: inputTokens, output_tokens: 0 } } })}\n\n`)

    // content_block_start
    lines.push(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`)

    // text deltas
    for (const text of textParts) {
      lines.push(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`)
    }

    // content_block_stop
    lines.push(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`)

    // message_delta with output usage
    lines.push(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } })}\n\n`)

    // message_stop
    lines.push(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`)

    return lines
  }

  it('accumulates text from content_block_delta events', async () => {
    const chunks = anthropicSseStream(['Hello', ' Claude'])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 })))
    const deltas: string[] = []
    const result = await llmStream({ system: 's', user: 'u' }, (d) => deltas.push(d))
    expect(result).toBe('Hello Claude')
    expect(deltas).toEqual(['Hello', ' Claude'])
  })

  it('llmStreamWithUsage captures input + output tokens from Anthropic events', async () => {
    const chunks = anthropicSseStream(['Hello'], 15, 8)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 })))
    const result = await llmStreamWithUsage({ system: 's', user: 'u' }, () => {})
    expect(result.content).toBe('Hello')
    expect(result.usage).toEqual({ prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 })
  })

  it('skips non-text-delta events (content_block_start, content_block_stop, etc.)', async () => {
    const chunks = anthropicSseStream(['hi', ' there'])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 })))
    const deltas: string[] = []
    const result = await llmStream({ system: 's', user: 'u' }, (d) => deltas.push(d))
    expect(result).toBe('hi there')
    // Only the actual text parts should trigger onDelta
    expect(deltas).toEqual(['hi', ' there'])
  })

  it('throws LlmError("network") when stream ends without message_stop', async () => {
    // Only send a content_block_delta — no message_stop
    const partial = [`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } })}\n\n`]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(partial), { status: 200 })))
    await expect(llmStream({ system: 's', user: 'u' }, () => {})).rejects.toMatchObject({ kind: 'network' })
  })

  it('handles content_block_delta split across two fetch chunks (SSE buffering)', async () => {
    const event = `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'splittext' } })}\n\n`
    const stop = `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`
    const mid = Math.floor(event.length / 2)
    const chunks = [event.slice(0, mid), event.slice(mid), stop]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 })))
    const result = await llmStream({ system: 's', user: 'u' }, () => {})
    expect(result).toBe('splittext')
  })
})

// ===========================================================================
// gemini transport — complete + stream + usage
// ===========================================================================

describe('gemini transport — llmComplete', () => {
  beforeEach(() => {
    setAiProvider('gemini')
    setGeminiKey('AIza-test-key')
  })

  it('posts to generateContent endpoint with x-goog-api-key header', async () => {
    const body = {
      candidates: [{ content: { parts: [{ text: 'hello from gemini' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }
    const f = vi.fn().mockResolvedValue(makeJsonResponse(body))
    vi.stubGlobal('fetch', f)
    const result = await llmComplete({ system: 'sys', user: 'usr' })
    expect(result).toBe('hello from gemini')
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('generativelanguage.googleapis.com')
    expect(url).toContain(':generateContent')
    expect(url).toContain('gemini-3.5-flash')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-test-key')
  })

  it('sends responseMimeType: application/json when json:true', async () => {
    const body = { candidates: [{ content: { parts: [{ text: '{"x":1}' }] } }] }
    const f = vi.fn().mockResolvedValue(makeJsonResponse(body))
    vi.stubGlobal('fetch', f)
    await llmComplete({ system: 's', user: 'u', json: true })
    const reqBody = JSON.parse((f.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(reqBody.generationConfig?.responseMimeType).toBe('application/json')
  })

  it('omits generationConfig when json is not set', async () => {
    const body = { candidates: [{ content: { parts: [{ text: 'text' }] } }] }
    const f = vi.fn().mockResolvedValue(makeJsonResponse(body))
    vi.stubGlobal('fetch', f)
    await llmComplete({ system: 's', user: 'u' })
    const reqBody = JSON.parse((f.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(reqBody.generationConfig).toBeUndefined()
  })

  it('llmCompleteWithUsage maps usageMetadata to LlmUsage', async () => {
    const body = {
      candidates: [{ content: { parts: [{ text: 'content' }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(body)))
    const { content, usage } = await llmCompleteWithUsage({ system: 's', user: 'u' })
    expect(content).toBe('content')
    expect(usage).toEqual({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 })
  })

  it('throws LlmError("server") when no text in candidates', async () => {
    const body = { candidates: [{ content: { parts: [] } }] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(body)))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'server' })
  })

  it('maps 401 → LlmError("auth")', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse({}, 401)))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps 429 → LlmError("rate-limited")', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse({}, 429)))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'rate-limited' })
  })
})

describe('gemini transport — llmStream (streamGenerateContent?alt=sse)', () => {
  beforeEach(() => {
    setAiProvider('gemini')
    setGeminiKey('AIza-test-key')
  })

  /**
   * Realistic Gemini SSE stream: each data line is a JSON chunk with
   * candidates[0].content.parts[0].text and optional usageMetadata on last chunk.
   */
  function geminiSseStream(
    textParts: string[],
    usage?: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number },
  ): string[] {
    const lines: string[] = []
    for (let i = 0; i < textParts.length; i++) {
      const chunk: Record<string, unknown> = {
        candidates: [{ content: { parts: [{ text: textParts[i] }] } }],
      }
      if (i === textParts.length - 1 && usage) {
        chunk.usageMetadata = usage
      }
      lines.push(`data: ${JSON.stringify(chunk)}\n\n`)
    }
    return lines
  }

  it('accumulates text from Gemini SSE chunks', async () => {
    const chunks = geminiSseStream(['Hello', ' Gemini'])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 })))
    const deltas: string[] = []
    const result = await llmStream({ system: 's', user: 'u' }, (d) => deltas.push(d))
    expect(result).toBe('Hello Gemini')
    expect(deltas).toEqual(['Hello', ' Gemini'])
  })

  it('llmStreamWithUsage captures Gemini usageMetadata from final chunk', async () => {
    const usage = { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 }
    const chunks = geminiSseStream(['hi'], usage)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 })))
    const result = await llmStreamWithUsage({ system: 's', user: 'u' }, () => {})
    expect(result.content).toBe('hi')
    expect(result.usage).toEqual({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 })
  })

  it('llmStreamWithUsage returns usage as undefined when no usageMetadata', async () => {
    const chunks = geminiSseStream(['hi'])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 })))
    const result = await llmStreamWithUsage({ system: 's', user: 'u' }, () => {})
    expect(result.usage).toBeUndefined()
  })

  it('calls streamGenerateContent?alt=sse endpoint', async () => {
    const chunks = geminiSseStream(['ok'])
    const f = vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 }))
    vi.stubGlobal('fetch', f)
    await llmStream({ system: 's', user: 'u' }, () => {})
    const [url] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toContain(':streamGenerateContent?alt=sse')
  })

  it('handles Gemini SSE chunk split across two fetch chunks', async () => {
    const chunkJson = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'splitok' }] } }] })
    const event = `data: ${chunkJson}\n\n`
    const stop = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '' }] } }] })}\n\n`
    const mid = Math.floor(event.length / 2)
    const parts = [event.slice(0, mid), event.slice(mid), stop]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(parts), { status: 200 })))
    const result = await llmStream({ system: 's', user: 'u' }, () => {})
    expect(result).toContain('splitok')
  })
})

// ===========================================================================
// openai transport — proxied via /api/llm/openai with x-user-openai-key
// ===========================================================================

describe('openai-compat via proxy — correct headers', () => {
  beforeEach(() => {
    setAiProvider('openai')
    setOpenaiKey('sk-openai-test')
  })

  it('posts to /api/llm/openai/chat/completions (local proxy path)', async () => {
    const body = { choices: [{ message: { content: 'from openai' } }] }
    const f = vi.fn().mockResolvedValue(makeJsonResponse(body))
    vi.stubGlobal('fetch', f)
    const result = await llmComplete({ system: 's', user: 'u' })
    expect(result).toBe('from openai')
    const [url] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/llm/openai/chat/completions')
  })

  it('sends x-user-openai-key header for proxy passthrough', async () => {
    const body = { choices: [{ message: { content: 'ok' } }] }
    const f = vi.fn().mockResolvedValue(makeJsonResponse(body))
    vi.stubGlobal('fetch', f)
    await llmComplete({ system: 's', user: 'u' })
    const headers = (f.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>
    expect(headers['x-user-openai-key']).toBe('sk-openai-test')
  })

  it('sends model gpt-5.4 (provider default) in body', async () => {
    const body = { choices: [{ message: { content: 'ok' } }] }
    const f = vi.fn().mockResolvedValue(makeJsonResponse(body))
    vi.stubGlobal('fetch', f)
    await llmComplete({ system: 's', user: 'u' })
    const reqBody = JSON.parse((f.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(reqBody.model).toBe('gpt-5.4')
  })
})

// ===========================================================================
// cacheKey — model component
// ===========================================================================

describe('cacheKey — model id component', () => {
  it('without modelId produces legacy key shape', () => {
    expect(cacheKey('owner/repo#1@sha', 'summary', 1)).toBe('owner/repo#1@sha|summary|v1')
  })

  it('with modelId appends m:<model> segment', () => {
    expect(cacheKey('owner/repo#1@sha', 'summary', 1, 'claude-sonnet-4-6')).toBe(
      'owner/repo#1@sha|summary|v1|m:claude-sonnet-4-6',
    )
  })

  it('different models produce different keys for same prKey+task+version', () => {
    const keyA = cacheKey('repo#1@sha', 'verdict', 2, 'deepseek-chat')
    const keyB = cacheKey('repo#1@sha', 'verdict', 2, 'claude-sonnet-4-6')
    expect(keyA).not.toBe(keyB)
  })

  it('same model produces same key deterministically', () => {
    const key1 = cacheKey('repo#1@sha', 'summary', 1, 'gemini-2.5-flash')
    const key2 = cacheKey('repo#1@sha', 'summary', 1, 'gemini-2.5-flash')
    expect(key1).toBe(key2)
  })
})

// ===========================================================================
// activeLlmConfig() — budgetTokens reflects the active model's context window
// ===========================================================================

describe('activeLlmConfig() — budgetTokens from active model', () => {
  it('deepseek-v4-flash (default, 1M context) → 994_000 budget', () => {
    // Default
    expect(activeLlmConfig().budgetTokens).toBe(994_000)
  })

  it('anthropic (claude-sonnet-4-6, 1M context) → 994_000 budget', () => {
    setAiProvider('anthropic')
    expect(activeLlmConfig().budgetTokens).toBe(994_000)
  })

  it('anthropic (claude-haiku-4-5, 200k context) → 194_000 budget', () => {
    setAiProvider('anthropic')
    setAiModel('claude-haiku-4-5')
    expect(activeLlmConfig().budgetTokens).toBe(194_000)
  })

  it('gemini (gemini-3.5-flash, 1_048_576 context) → 1_042_576 budget', () => {
    setAiProvider('gemini')
    expect(activeLlmConfig().budgetTokens).toBe(1_042_576)
  })
})

// ===========================================================================
// Header-character TypeError mapping (belt-and-braces for keys saved BEFORE
// save-time sanitization landed): fetch throws a TypeError when a header
// value (the key) contains a non-ISO-8859-1 character — the raw engine
// message ("Cannot convert value to ByteString…") must never surface.
// ===========================================================================

describe('invalid header character → friendly LlmError (all transports)', () => {
  const FIREFOX_BYTESTRING_ERROR = new TypeError(
    'Window.fetch: Cannot convert value to ByteString because the character at index 49 has value 8212 which is greater than 255.',
  )
  const CHROME_HEADER_ERROR = new TypeError("Failed to execute 'fetch' on 'Window': Invalid value")

  it('openai-compat (deepseek): maps the Firefox ByteString TypeError to a friendly auth LlmError', async () => {
    setDeepseekKey('sk-legacy-saved-before-fix')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(FIREFOX_BYTESTRING_ERROR))
    const err = (await llmComplete({ system: 's', user: 'u' }).then(
      () => null,
      (e: unknown) => e,
    )) as LlmError
    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('auth')
    expect(err.message).toBe(INVALID_KEY_CHAR_MESSAGE)
    expect(err.message).not.toMatch(/ByteString|8212/)
  })

  it('anthropic: maps the Chrome invalid-value TypeError to the same friendly message', async () => {
    setAiProvider('anthropic')
    setAnthropicKey('sk-ant-legacy')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(CHROME_HEADER_ERROR))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({
      kind: 'auth',
      message: INVALID_KEY_CHAR_MESSAGE,
    })
  })

  it('gemini: maps the ByteString TypeError on the streaming path too', async () => {
    setAiProvider('gemini')
    setGeminiKey('AIza-legacy')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(FIREFOX_BYTESTRING_ERROR))
    await expect(llmStream({ system: 's', user: 'u' }, () => {})).rejects.toMatchObject({
      kind: 'auth',
      message: INVALID_KEY_CHAR_MESSAGE,
    })
  })

  it('a generic network TypeError ("Failed to fetch") still maps to kind network', async () => {
    setDeepseekKey('sk-ds-ok')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({
      kind: 'network',
      message: 'Failed to fetch',
    })
  })
})
