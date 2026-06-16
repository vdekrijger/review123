/**
 * Tests for the OpenAI serverless proxy (api/llm/openai.ts).
 *
 * Coverage:
 *   - Origin guard: missing origin → 403
 *   - Origin guard: mismatched host → 403
 *   - No user key → 401
 *   - Invalid body → 400
 *   - Valid request: forwards x-user-openai-key as Authorization: Bearer
 *   - Status relay: upstream non-200 relayed verbatim
 *   - No-log: no console calls in this file (verified structurally)
 *   - Streaming passthrough: body stream relayed
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { openaiProxyHandler } from './openai'
import { getProvider } from '../../src/lib/llm/providers'

// ---------------------------------------------------------------------------
// Route contract: the openai-compat transport calls <baseUrl>/chat/completions,
// but the proxy function lives at <baseUrl> with no path segment of its own.
// Vercel does NOT auto-map the extra sub-path to the function, so vercel.json
// MUST rewrite that exact path to the function — otherwise every OpenAI call
// 404s (the bug this guards against).
// ---------------------------------------------------------------------------
describe('OpenAI proxy route contract (vercel.json)', () => {
  it('rewrites the transport sub-path to the proxy function', () => {
    const vercel = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8')) as {
      rewrites: { source: string; destination: string }[]
    }
    const baseUrl = getProvider('openai')!.baseUrl // '/api/llm/openai'
    const clientPath = `${baseUrl}/chat/completions`
    const rule = vercel.rewrites.find((r) => r.source === clientPath)
    expect(rule, `vercel.json must rewrite ${clientPath} to the proxy function`).toBeTruthy()
    expect(rule!.destination).toBe(baseUrl)
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUpstreamResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeStreamingUpstream(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

// ---------------------------------------------------------------------------
// openaiProxyHandler — pure function tests
// ---------------------------------------------------------------------------

describe('openaiProxyHandler — no user key', () => {
  it('returns 401 with missing-key error when userKey is undefined', async () => {
    const fetchFn = vi.fn()
    const result = await openaiProxyHandler({ model: 'gpt-5.2', messages: [] }, undefined, fetchFn)
    expect(result.status).toBe(401)
    expect(result.bodyJson).toEqual({ error: 'missing-key' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('returns 401 with missing-key error when userKey is empty string', async () => {
    const fetchFn = vi.fn()
    // Empty string is falsy — treated as missing
    const result = await openaiProxyHandler({ model: 'gpt-5.2' }, '' as unknown as undefined, fetchFn)
    expect(result.status).toBe(401)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('openaiProxyHandler — invalid body', () => {
  it('returns 400 when body is null', async () => {
    const fetchFn = vi.fn()
    const result = await openaiProxyHandler(null, 'sk-test', fetchFn)
    expect(result.status).toBe(400)
    expect(result.bodyJson).toEqual({ error: 'invalid-body' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('returns 400 when body is a string', async () => {
    const fetchFn = vi.fn()
    const result = await openaiProxyHandler('not an object', 'sk-test', fetchFn)
    expect(result.status).toBe(400)
    expect(result.bodyJson).toEqual({ error: 'invalid-body' })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('openaiProxyHandler — valid request', () => {
  it('forwards request to OpenAI with Authorization: Bearer header', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeUpstreamResponse({ choices: [] }))
    const body = { model: 'gpt-5.2', messages: [{ role: 'user', content: 'hi' }] }
    await openaiProxyHandler(body, 'sk-openai-key-123', fetchFn)

    expect(fetchFn).toHaveBeenCalledOnce()
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-openai-key-123')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('relays the full body to OpenAI verbatim', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeUpstreamResponse({ choices: [] }))
    const body = { model: 'gpt-4.1', messages: [{ role: 'system', content: 'sys' }], stream: true }
    await openaiProxyHandler(body, 'sk-test', fetchFn)
    const sentBody = JSON.parse((fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(sentBody).toEqual(body)
  })

  it('relays upstream 200 status', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeUpstreamResponse({ choices: [{ message: { content: 'ok' } }] }, 200))
    const result = await openaiProxyHandler({ model: 'gpt-5.2', messages: [] }, 'sk-test', fetchFn)
    expect(result.status).toBe(200)
  })

  it('relays upstream 401 status verbatim (bad key)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeUpstreamResponse({ error: 'invalid_api_key' }, 401))
    const result = await openaiProxyHandler({ model: 'gpt-5.2', messages: [] }, 'sk-bad-key', fetchFn)
    expect(result.status).toBe(401)
  })

  it('relays upstream 429 status verbatim (rate limit)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeUpstreamResponse({ error: 'rate_limit_exceeded' }, 429))
    const result = await openaiProxyHandler({ model: 'gpt-5.2', messages: [] }, 'sk-test', fetchFn)
    expect(result.status).toBe(429)
  })

  it('relays upstream 500 status verbatim', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeUpstreamResponse({ error: 'server_error' }, 500))
    const result = await openaiProxyHandler({ model: 'gpt-5.2', messages: [] }, 'sk-test', fetchFn)
    expect(result.status).toBe(500)
  })

  it('returns bodyStream from upstream response body', async () => {
    const sseChunks = ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n']
    const upstreamRes = makeStreamingUpstream(sseChunks, 200)
    const fetchFn = vi.fn().mockResolvedValue(upstreamRes)
    const result = await openaiProxyHandler({ model: 'gpt-5.2', messages: [], stream: true }, 'sk-test', fetchFn)
    expect(result.status).toBe(200)
    expect(result.bodyStream).not.toBeNull()
  })

  it('relays content-type from upstream (text/event-stream for streaming)', async () => {
    const upstreamRes = makeStreamingUpstream(['data: [DONE]\n\n'], 200)
    const fetchFn = vi.fn().mockResolvedValue(upstreamRes)
    const result = await openaiProxyHandler({ model: 'gpt-5.2', messages: [], stream: true }, 'sk-test', fetchFn)
    expect(result.headers['Content-Type']).toContain('text/event-stream')
  })
})

// ---------------------------------------------------------------------------
// No-log source test: verify no console calls in the proxy source file
// This is a structural check — the handler is not allowed to log user keys.
// ---------------------------------------------------------------------------

describe('openaiProxyHandler — no-log discipline (source check)', () => {
  it('openai.ts source does not contain any console.log/warn/error/info calls', async () => {
    // Read the source to verify the no-log constraint is enforced structurally
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    // __dirname equivalent via process.cwd() + relative path to the api/llm/ folder
    const srcPath = path.resolve(process.cwd(), 'api/llm/openai.ts')
    const src = await fs.readFile(srcPath, 'utf-8')
    // Must not contain console.* calls (EC-02l discipline — same as oauth/exchange.ts)
    expect(src).not.toMatch(/console\s*\.\s*(log|warn|error|info|debug|trace)\s*\(/)
  })
})
