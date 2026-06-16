/**
 * Tests for llmTestConnection (Plan F Task F3) + activeProviderHasKey helper.
 *
 * llmTestConnection sends a minimal 1-token ping through the REAL transport
 * adapters (never cached — llm.ts has no cache layer by design) for the GIVEN
 * provider, independent of which provider is currently active in settings.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { llmTestConnection, LlmError, INVALID_KEY_CHAR_MESSAGE } from './llm'
import { activeProviderHasKey } from './config'
import {
  setDeepseekKey,
  setOpenaiKey,
  setAnthropicKey,
  setGeminiKey,
  setAiProvider,
} from '../settings/settings'

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

// ===========================================================================
// llmTestConnection
// ===========================================================================

describe('llmTestConnection', () => {
  it('throws LlmError("no-key") when the provider has no key saved', async () => {
    await expect(llmTestConnection('deepseek')).rejects.toMatchObject({ kind: 'no-key' })
  })

  it('deepseek: posts a capped ping to api.deepseek.com/chat/completions with Bearer auth', async () => {
    setDeepseekKey('sk-ds-test')
    const fetchMock = vi.fn().mockResolvedValue(
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await llmTestConnection('deepseek')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-ds-test')
    const body = JSON.parse(init.body as string)
    expect(body.max_tokens).toBe(1024)
    expect(body.model).toBe('deepseek-v4-flash')
  })

  it('tests the GIVEN provider even when a different provider is active', async () => {
    setAiProvider('deepseek')
    setAnthropicKey('sk-ant-test')
    const fetchMock = vi.fn().mockResolvedValue(
      makeJsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await llmTestConnection('anthropic')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-test')
    const body = JSON.parse(init.body as string)
    expect(body.max_tokens).toBe(1024)
    expect(body.model).toBe('claude-sonnet-4-6')
  })

  it('uses an explicit modelId when it belongs to the provider', async () => {
    setAnthropicKey('sk-ant-test')
    const fetchMock = vi.fn().mockResolvedValue(
      makeJsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await llmTestConnection('anthropic', 'claude-opus-4-8')

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.model).toBe('claude-opus-4-8')
  })

  it('gemini: pings generateContent with x-goog-api-key (no 1-token cap — thinking models)', async () => {
    setGeminiKey('AIza-test')
    const fetchMock = vi.fn().mockResolvedValue(
      makeJsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await llmTestConnection('gemini')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
    )
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-test')
    // Gemini 2.5 thinking models can exhaust a 1-token cap before emitting text,
    // which would read as a failure — so the ping must NOT set maxOutputTokens.
    const body = JSON.parse(init.body as string)
    expect(body.generationConfig?.maxOutputTokens).toBeUndefined()
  })

  it('openai: routes the ping through the serverless proxy with x-user-openai-key', async () => {
    setOpenaiKey('sk-oa-test')
    const fetchMock = vi.fn().mockResolvedValue(
      makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await llmTestConnection('openai')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/llm/openai/chat/completions')
    expect((init.headers as Record<string, string>)['x-user-openai-key']).toBe('sk-oa-test')
  })

  it('maps a 401 response to LlmError("auth")', async () => {
    setDeepseekKey('sk-bad')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse({}, 401)))

    await expect(llmTestConnection('deepseek')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps a 500 response to LlmError("server")', async () => {
    setGeminiKey('AIza-test')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse({}, 500)))

    await expect(llmTestConnection('gemini')).rejects.toMatchObject({ kind: 'server' })
  })

  it('throws LlmError for an unknown provider id', async () => {
    await expect(
      llmTestConnection('nonsense' as never),
    ).rejects.toBeInstanceOf(LlmError)
  })
})

// ===========================================================================
// activeProviderHasKey
// ===========================================================================

describe('activeProviderHasKey', () => {
  it('false by default (deepseek active, no key)', () => {
    expect(activeProviderHasKey()).toBe(false)
  })

  it('true when deepseek is active and deepseekKey is set', () => {
    setDeepseekKey('sk-ds')
    expect(activeProviderHasKey()).toBe(true)
  })

  it('false when anthropic is active and only deepseekKey is set', () => {
    setDeepseekKey('sk-ds')
    setAiProvider('anthropic')
    expect(activeProviderHasKey()).toBe(false)
  })

  it('true when anthropic is active and anthropicKey is set', () => {
    setAiProvider('anthropic')
    setAnthropicKey('sk-ant')
    expect(activeProviderHasKey()).toBe(true)
  })

  it('true when gemini is active and geminiKey is set', () => {
    setAiProvider('gemini')
    setGeminiKey('AIza')
    expect(activeProviderHasKey()).toBe(true)
  })

  it('true when openai is active and openaiKey is set', () => {
    setAiProvider('openai')
    setOpenaiKey('sk-oa')
    expect(activeProviderHasKey()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Friendly error for a legacy saved key with an invalid header character:
// the Settings "Save & test" button surfaces LlmError.message directly, so
// the mapped message (not the raw DOMException text) is what the user sees.
// ---------------------------------------------------------------------------

describe('llmTestConnection — invalid header character in a saved key', () => {
  it('maps the fetch ByteString TypeError to the friendly re-copy message', async () => {
    setDeepseekKey('sk-saved-before-sanitization')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(
        new TypeError(
          'Window.fetch: Cannot convert value to ByteString because the character at index 49 has value 8212 which is greater than 255.',
        ),
      ),
    )
    const err = await llmTestConnection('deepseek').catch((e) => e as LlmError)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('auth')
    expect((err as LlmError).message).toBe(INVALID_KEY_CHAR_MESSAGE)
    expect((err as LlmError).message).not.toMatch(/ByteString|8212/)
  })
})
