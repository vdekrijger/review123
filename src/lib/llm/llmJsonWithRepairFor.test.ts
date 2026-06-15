import { describe, it, expect, vi, beforeEach } from 'vitest'
import { llmJsonWithRepairFor, type ProviderConfig } from './llm'
import { getModelDef, getProvider } from './providers'

function cfg(providerId: 'openai' | 'anthropic' | 'gemini' | 'deepseek'): ProviderConfig {
  const provider = getProvider(providerId)!
  return { providerId, model: getModelDef(provider, provider.defaultModel)!, key: `verifier-key-${providerId}` }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

interface Shape {
  ok: boolean
}
function validate(x: unknown): Shape | null {
  if (typeof x === 'object' && x !== null && typeof (x as Record<string, unknown>).ok === 'boolean') {
    return x as Shape
  }
  return null
}

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('llmJsonWithRepairFor — routes to the SPECIFIED provider transport with its own key', () => {
  it('openai-compat (deepseek): uses the passed key and chat/completions endpoint', async () => {
    const f = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    )
    vi.stubGlobal('fetch', f)

    const { result, usage } = await llmJsonWithRepairFor(cfg('deepseek'), { system: 's', user: 'u' }, validate)
    expect(result).toEqual({ ok: true })
    expect(usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })

    const [url, init] = f.mock.calls[0]
    expect(String(url)).toContain('/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer verifier-key-deepseek')
  })

  it('openai goes through the proxy baseUrl and forwards x-user-openai-key', async () => {
    const f = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }),
    )
    vi.stubGlobal('fetch', f)

    await llmJsonWithRepairFor(cfg('openai'), { system: 's', user: 'u' }, validate)
    const [url, init] = f.mock.calls[0]
    expect(String(url)).toContain('/api/llm/openai/chat/completions')
    expect((init.headers as Record<string, string>)['x-user-openai-key']).toBe('verifier-key-openai')
  })

  it('anthropic: uses x-api-key with the passed verifier key on /v1/messages', async () => {
    const f = vi.fn().mockResolvedValue(
      jsonResponse({ content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }),
    )
    vi.stubGlobal('fetch', f)

    await llmJsonWithRepairFor(cfg('anthropic'), { system: 's', user: 'u' }, validate)
    const [url, init] = f.mock.calls[0]
    expect(String(url)).toContain('/v1/messages')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('verifier-key-anthropic')
  })

  it('gemini: uses x-goog-api-key with the passed verifier key on :generateContent', async () => {
    const f = vi.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ok: true }) }] } }] }),
    )
    vi.stubGlobal('fetch', f)

    await llmJsonWithRepairFor(cfg('gemini'), { system: 's', user: 'u' }, validate)
    const [url, init] = f.mock.calls[0]
    expect(String(url)).toContain(':generateContent')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('verifier-key-gemini')
  })

  it('does NOT read the active provider key from settings (settings untouched)', async () => {
    // No keys saved at all — the explicit cfg key must be used regardless.
    const f = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }),
    )
    vi.stubGlobal('fetch', f)
    const { result } = await llmJsonWithRepairFor(cfg('deepseek'), { system: 's', user: 'u' }, validate)
    expect(result).toEqual({ ok: true })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('repairs once on invalid JSON, then succeeds', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'not json' } }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }))
    vi.stubGlobal('fetch', f)
    const { result } = await llmJsonWithRepairFor(cfg('deepseek'), { system: 's', user: 'u' }, validate)
    expect(result).toEqual({ ok: true })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('throws invalid-output after a failed repair retry', async () => {
    const f = vi.fn().mockImplementation(async () =>
      jsonResponse({ choices: [{ message: { content: 'still bad' } }] }),
    )
    vi.stubGlobal('fetch', f)
    await expect(
      llmJsonWithRepairFor(cfg('deepseek'), { system: 's', user: 'u' }, validate),
    ).rejects.toMatchObject({ kind: 'invalid-output' })
  })
})
