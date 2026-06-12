import { describe, it, expect, vi, beforeEach } from 'vitest'
import { llmComplete, llmCompleteWithUsage, llmStream, llmStreamWithUsage, llmJsonWithRepair, llmJsonWithRepairWithUsage, LlmError } from './llm'
import { setDeepseekKey } from '../settings/settings'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Build a ReadableStream that delivers a sequence of string chunks. */
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

/** Minimal SSE event wrapping a delta content string. */
function sseEvent(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

const DONE_LINE = 'data: [DONE]\n\n'

/** A successful complete response body. */
function completionBody(content: string) {
  return { choices: [{ message: { content } }] }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// llmComplete — no-key short-circuit
// ---------------------------------------------------------------------------

describe('llmComplete — no-key', () => {
  it('throws LlmError("no-key") without calling fetch when no deepseekKey', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(llmComplete({ system: 'sys', user: 'usr' })).rejects.toMatchObject({
      kind: 'no-key',
    })
    expect(f).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// llmComplete — HTTP status mappings
// ---------------------------------------------------------------------------

describe('llmComplete — status mappings', () => {
  beforeEach(() => {
    setDeepseekKey('sk-test')
  })

  it('returns content on 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(completionBody('hello'))))
    const result = await llmComplete({ system: 'sys', user: 'usr' })
    expect(result).toBe('hello')
  })

  it('posts to the correct URL with auth header', async () => {
    const f = vi.fn().mockResolvedValue(makeJsonResponse(completionBody('ok')))
    vi.stubGlobal('fetch', f)
    await llmComplete({ system: 'sys', user: 'usr' })
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-test')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('includes response_format when json:true', async () => {
    const f = vi.fn().mockResolvedValue(makeJsonResponse(completionBody('{}')))
    vi.stubGlobal('fetch', f)
    await llmComplete({ system: 'sys', user: 'usr', json: true })
    const body = JSON.parse((f.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('omits response_format when json is not set', async () => {
    const f = vi.fn().mockResolvedValue(makeJsonResponse(completionBody('text')))
    vi.stubGlobal('fetch', f)
    await llmComplete({ system: 'sys', user: 'usr' })
    const body = JSON.parse((f.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.response_format).toBeUndefined()
  })

  it('sends model and messages with correct roles', async () => {
    const f = vi.fn().mockResolvedValue(makeJsonResponse(completionBody('ok')))
    vi.stubGlobal('fetch', f)
    await llmComplete({ system: 'the-system', user: 'the-user' })
    const body = JSON.parse((f.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.model).toBe('deepseek-v4-flash')
    expect(body.messages).toEqual([
      { role: 'system', content: 'the-system' },
      { role: 'user', content: 'the-user' },
    ])
  })

  it('maps 401 → LlmError("auth")', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse({}, 401)))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps 429 → LlmError("rate-limited")', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse({}, 429)))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'rate-limited' })
  })

  it('maps 500 → LlmError("server")', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse({}, 500)))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'server' })
  })

  it('maps 503 → LlmError("server")', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse({}, 503)))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'server' })
  })

  it('maps network rejection → LlmError("network")', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed')))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'network' })
  })

  it('maps DOMException TimeoutError → LlmError("timeout")', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('t', 'TimeoutError')))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('throws LlmError("server") when choices[0].message.content is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse({ choices: [] })))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'server' })
  })

  it('throws LlmError("server") when choices[0].message.content is null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse({ choices: [{ message: { content: null } }] })))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'server' })
  })
})

// ---------------------------------------------------------------------------
// llmComplete — custom signal passthrough
// ---------------------------------------------------------------------------

describe('llmComplete — signal passthrough', () => {
  it('passes a caller-supplied signal to fetch', async () => {
    setDeepseekKey('sk-x')
    const f = vi.fn().mockResolvedValue(makeJsonResponse(completionBody('ok')))
    vi.stubGlobal('fetch', f)
    const ctrl = new AbortController()
    await llmComplete({ system: 's', user: 'u', signal: ctrl.signal })
    const init = (f.mock.calls[0] as [string, RequestInit])[1]
    expect(init.signal).toBe(ctrl.signal)
  })
})

// ---------------------------------------------------------------------------
// LlmError class
// ---------------------------------------------------------------------------

describe('LlmError', () => {
  it('is an instance of Error with a kind discriminant', () => {
    const err = new LlmError('auth', 'bad token')
    expect(err).toBeInstanceOf(Error)
    expect(err.kind).toBe('auth')
    expect(err.message).toBe('bad token')
  })

  it('has a default message when none is provided', () => {
    const err = new LlmError('no-key')
    expect(err.kind).toBe('no-key')
  })
})

// ---------------------------------------------------------------------------
// llmStream — SSE parsing
// ---------------------------------------------------------------------------

describe('llmStream — basic flow', () => {
  beforeEach(() => {
    setDeepseekKey('sk-test')
  })

  it('no-key throws without calling fetch', async () => {
    localStorage.clear()
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(llmStream({ system: 's', user: 'u' }, () => {})).rejects.toMatchObject({ kind: 'no-key' })
    expect(f).not.toHaveBeenCalled()
  })

  it('returns accumulated text and calls onDelta for each non-empty content delta', async () => {
    const chunks = [
      sseEvent('Hello'),
      sseEvent(' world'),
      DONE_LINE,
    ]
    const streamBody = makeStream(chunks)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(streamBody, { status: 200 })))

    const deltas: string[] = []
    const result = await llmStream({ system: 's', user: 'u' }, (d) => deltas.push(d))
    expect(result).toBe('Hello world')
    expect(deltas).toEqual(['Hello', ' world'])
  })

  it('sends stream:true in the request body', async () => {
    const chunks = [sseEvent('hi'), DONE_LINE]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 })))
    const f = vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 }))
    vi.stubGlobal('fetch', f)
    await llmStream({ system: 's', user: 'u' }, () => {})
    const body = JSON.parse((f.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.stream).toBe(true)
  })

  it('skips empty content deltas and does not call onDelta for them', async () => {
    const emptyDelta = `data: ${JSON.stringify({ choices: [{ delta: { content: '' } }] })}\n\n`
    const chunks = [
      emptyDelta,
      sseEvent('real'),
      DONE_LINE,
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 })))
    const deltas: string[] = []
    const result = await llmStream({ system: 's', user: 'u' }, (d) => deltas.push(d))
    expect(result).toBe('real')
    expect(deltas).toEqual(['real'])
  })

  it('skips SSE events with no choices[0].delta.content field', async () => {
    const eventNoContent = `data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\n`
    const chunks = [eventNoContent, sseEvent('hi'), DONE_LINE]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 })))
    const deltas: string[] = []
    const result = await llmStream({ system: 's', user: 'u' }, (d) => deltas.push(d))
    expect(result).toBe('hi')
    expect(deltas).toEqual(['hi'])
  })

  it('handles HTTP error status via LlmError (not stream path)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })))
    await expect(llmStream({ system: 's', user: 'u' }, () => {})).rejects.toMatchObject({ kind: 'rate-limited' })
  })
})

// ---------------------------------------------------------------------------
// llmStream — SSE `data:` without trailing space (nit fix regression test)
// ---------------------------------------------------------------------------

describe('llmStream — data: without trailing space', () => {
  beforeEach(() => {
    setDeepseekKey('sk-test')
  })

  it('accepts data: with no space between colon and payload', async () => {
    // Build a raw SSE line with no space after "data:"
    const payload = JSON.stringify({ choices: [{ delta: { content: 'nospace' } }] })
    const noSpaceLine = `data:${payload}\n\n`
    const chunks = [noSpaceLine, DONE_LINE]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 })))

    const deltas: string[] = []
    const result = await llmStream({ system: 's', user: 'u' }, (d) => deltas.push(d))
    expect(result).toBe('nospace')
    expect(deltas).toEqual(['nospace'])
  })
})

// ---------------------------------------------------------------------------
// llmStream — SSE chunk boundary (delta split across two chunks)
// ---------------------------------------------------------------------------

describe('llmStream — SSE buffering across chunk boundaries', () => {
  beforeEach(() => {
    setDeepseekKey('sk-test')
  })

  it('correctly accumulates when a data: line is split across two decoder chunks', async () => {
    // Build one SSE event and split it in the middle of the data: line
    const event = sseEvent('splitcontent')
    // Split after 'data: {' — mid-JSON
    const mid = Math.floor(event.length / 2)
    const part1 = event.slice(0, mid)
    const part2 = event.slice(mid)

    const chunks = [part1, part2, DONE_LINE]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 })))

    const deltas: string[] = []
    const result = await llmStream({ system: 's', user: 'u' }, (d) => deltas.push(d))
    expect(result).toBe('splitcontent')
    expect(deltas).toEqual(['splitcontent'])
  })

  it('handles multiple events split across chunks', async () => {
    // Two events, split so that chunk 1 has: full event1 + start of event2; chunk 2 has: rest of event2
    const e1 = sseEvent('A')
    const e2 = sseEvent('B')
    const combined = e1 + e2
    // Split 3 chars into e2
    const splitPoint = e1.length + 3
    const chunk1 = combined.slice(0, splitPoint)
    const chunk2 = combined.slice(splitPoint) + DONE_LINE

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream([chunk1, chunk2]), { status: 200 })))
    const deltas: string[] = []
    const result = await llmStream({ system: 's', user: 'u' }, (d) => deltas.push(d))
    expect(result).toBe('AB')
    expect(deltas).toEqual(['A', 'B'])
  })
})

// ---------------------------------------------------------------------------
// llmStream — premature stream end (no [DONE]) → throws LlmError('network')
// ---------------------------------------------------------------------------

describe('llmStream — premature end', () => {
  beforeEach(() => {
    setDeepseekKey('sk-test')
  })

  it('throws LlmError("network") when stream closes without [DONE]', async () => {
    const chunks = [sseEvent('partial')]  // no DONE_LINE
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 })))

    const deltas: string[] = []
    await expect(
      llmStream({ system: 's', user: 'u' }, (d) => deltas.push(d))
    ).rejects.toMatchObject({ kind: 'network' })

    // onDelta was still called for the partial content
    expect(deltas).toEqual(['partial'])
  })
})

// ---------------------------------------------------------------------------
// llmStream — timeout / network error
// ---------------------------------------------------------------------------

describe('llmStream — error propagation', () => {
  beforeEach(() => {
    setDeepseekKey('sk-test')
  })

  it('maps fetch rejection to LlmError("network")', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network fail')))
    await expect(llmStream({ system: 's', user: 'u' }, () => {})).rejects.toMatchObject({ kind: 'network' })
  })

  it('maps DOMException TimeoutError to LlmError("timeout")', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timeout', 'TimeoutError')))
    await expect(llmStream({ system: 's', user: 'u' }, () => {})).rejects.toMatchObject({ kind: 'timeout' })
  })
})

// ---------------------------------------------------------------------------
// llmJsonWithRepair
// ---------------------------------------------------------------------------

describe('llmJsonWithRepair', () => {
  beforeEach(() => {
    setDeepseekKey('sk-test')
  })

  it('returns parsed value when first response is valid JSON and passes validator', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(completionBody('{"x":1}'))))
    const result = await llmJsonWithRepair({ system: 's', user: 'u' }, (x) => {
      const obj = x as Record<string, unknown>
      return typeof obj.x === 'number' ? obj : null
    })
    expect(result).toEqual({ x: 1 })
  })

  it('calls fetch exactly once on first-attempt success', async () => {
    const f = vi.fn().mockResolvedValue(makeJsonResponse(completionBody('{"ok":true}')))
    vi.stubGlobal('fetch', f)
    await llmJsonWithRepair({ system: 's', user: 'u' }, (x) => x)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('retries once when first response has invalid JSON, succeeds on second', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(makeJsonResponse(completionBody('not-json')))
      .mockResolvedValueOnce(makeJsonResponse(completionBody('{"repaired":true}')))
    vi.stubGlobal('fetch', f)
    const result = await llmJsonWithRepair({ system: 's', user: 'u' }, (x) => x)
    expect(result).toEqual({ repaired: true })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('second request contains the parse error text and previous output', async () => {
    const badOutput = 'not-json'
    const f = vi.fn()
      .mockResolvedValueOnce(makeJsonResponse(completionBody(badOutput)))
      .mockResolvedValueOnce(makeJsonResponse(completionBody('{"fixed":1}')))
    vi.stubGlobal('fetch', f)
    await llmJsonWithRepair({ system: 's', user: 'u' }, (x) => x)

    const secondBody = JSON.parse((f.mock.calls[1] as [string, RequestInit])[1].body as string)
    const userMsg: string = secondBody.messages.find((m: {role:string}) => m.role === 'user').content
    expect(userMsg).toContain('previous output was invalid')
    expect(userMsg).toContain(badOutput)
  })

  it('retries once when validator returns null (parseable JSON, wrong shape), succeeds', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(makeJsonResponse(completionBody('{"wrong":true}')))
      .mockResolvedValueOnce(makeJsonResponse(completionBody('{"x":42}')))
    vi.stubGlobal('fetch', f)
    const result = await llmJsonWithRepair({ system: 's', user: 'u' }, (x) => {
      const obj = x as Record<string, unknown>
      return typeof obj.x === 'number' ? obj : null
    })
    expect(result).toEqual({ x: 42 })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('second request includes the validator-null error context', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(makeJsonResponse(completionBody('{"wrong":"shape"}')))
      .mockResolvedValueOnce(makeJsonResponse(completionBody('{"x":1}')))
    vi.stubGlobal('fetch', f)
    await llmJsonWithRepair({ system: 's', user: 'u' }, (x) => {
      const obj = x as Record<string, unknown>
      return typeof obj.x === 'number' ? obj : null
    })
    const secondBody = JSON.parse((f.mock.calls[1] as [string, RequestInit])[1].body as string)
    const userMsg: string = secondBody.messages.find((m: {role:string}) => m.role === 'user').content
    expect(userMsg).toContain('previous output was invalid')
    expect(userMsg).toContain('{"wrong":"shape"}')
  })

  it('throws LlmError("invalid-output") when both attempts fail JSON parse', async () => {
    // Each call must get a fresh Response (body can only be read once)
    const f = vi.fn()
      .mockResolvedValueOnce(makeJsonResponse(completionBody('bad')))
      .mockResolvedValueOnce(makeJsonResponse(completionBody('bad')))
    vi.stubGlobal('fetch', f)
    await expect(
      llmJsonWithRepair({ system: 's', user: 'u' }, (x) => x)
    ).rejects.toMatchObject({ kind: 'invalid-output' })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('throws LlmError("invalid-output") when both attempts fail validator', async () => {
    // Each call must get a fresh Response (body can only be read once)
    const f = vi.fn()
      .mockResolvedValueOnce(makeJsonResponse(completionBody('{"bad":true}')))
      .mockResolvedValueOnce(makeJsonResponse(completionBody('{"bad":true}')))
    vi.stubGlobal('fetch', f)
    await expect(
      llmJsonWithRepair({ system: 's', user: 'u' }, (_x) => null)
    ).rejects.toMatchObject({ kind: 'invalid-output' })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('no-key short-circuits before any fetch', async () => {
    localStorage.clear()
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(
      llmJsonWithRepair({ system: 's', user: 'u' }, (x) => x)
    ).rejects.toMatchObject({ kind: 'no-key' })
    expect(f).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// llmCompleteWithUsage — returns { content, usage }
// ---------------------------------------------------------------------------

describe('llmCompleteWithUsage — usage parsing', () => {
  beforeEach(() => {
    setDeepseekKey('sk-test')
  })

  it('returns content and usage when response includes usage', async () => {
    const body = {
      choices: [{ message: { content: 'hello' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(body)))
    const result = await llmCompleteWithUsage({ system: 'sys', user: 'usr' })
    expect(result.content).toBe('hello')
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
  })

  it('returns usage as undefined when usage is absent from response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(completionBody('hi'))))
    const result = await llmCompleteWithUsage({ system: 'sys', user: 'usr' })
    expect(result.content).toBe('hi')
    expect(result.usage).toBeUndefined()
  })

  it('still throws on HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse({}, 401)))
    await expect(llmCompleteWithUsage({ system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'auth' })
  })
})

// ---------------------------------------------------------------------------
// llmStreamWithUsage — parses usage from final SSE chunk
// ---------------------------------------------------------------------------

describe('llmStreamWithUsage — usage parsing from final SSE chunk', () => {
  beforeEach(() => {
    setDeepseekKey('sk-test')
  })

  it('returns accumulated content and usage from final chunk', async () => {
    const usageChunk = `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`
    const chunks = [sseEvent('Hello'), sseEvent(' world'), usageChunk, DONE_LINE]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 })))

    const deltas: string[] = []
    const result = await llmStreamWithUsage({ system: 's', user: 'u' }, (d) => deltas.push(d))
    expect(result.content).toBe('Hello world')
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
    expect(deltas).toEqual(['Hello', ' world'])
  })

  it('returns usage as undefined when no usage chunk present', async () => {
    const chunks = [sseEvent('hi'), DONE_LINE]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 })))

    const result = await llmStreamWithUsage({ system: 's', user: 'u' }, () => {})
    expect(result.content).toBe('hi')
    expect(result.usage).toBeUndefined()
  })

  it('sends stream_options: { include_usage: true } in request body', async () => {
    const chunks = [sseEvent('ok'), DONE_LINE]
    const f = vi.fn().mockResolvedValue(new Response(makeStream(chunks), { status: 200 }))
    vi.stubGlobal('fetch', f)
    await llmStreamWithUsage({ system: 's', user: 'u' }, () => {})
    const body = JSON.parse((f.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('still throws on HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })))
    await expect(llmStreamWithUsage({ system: 's', user: 'u' }, () => {})).rejects.toMatchObject({ kind: 'rate-limited' })
  })
})

// ---------------------------------------------------------------------------
// llmJsonWithRepairWithUsage
// ---------------------------------------------------------------------------

describe('llmJsonWithRepairWithUsage — returns usage from first attempt', () => {
  beforeEach(() => {
    setDeepseekKey('sk-test')
  })

  it('returns result and usage on first-attempt success', async () => {
    const body = {
      choices: [{ message: { content: '{"x":1}' } }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(body)))
    const { result, usage } = await llmJsonWithRepairWithUsage({ system: 's', user: 'u' }, (x) => x)
    expect(result).toEqual({ x: 1 })
    expect(usage).toEqual({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 })
  })

  it('returns usage from first attempt even when repair retry needed', async () => {
    const firstBody = {
      choices: [{ message: { content: 'bad-json' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }
    const secondBody = { choices: [{ message: { content: '{"ok":true}' } }] }
    const f = vi.fn()
      .mockResolvedValueOnce(makeJsonResponse(firstBody))
      .mockResolvedValueOnce(makeJsonResponse(secondBody))
    vi.stubGlobal('fetch', f)
    const { result, usage } = await llmJsonWithRepairWithUsage({ system: 's', user: 'u' }, (x) => x)
    expect(result).toEqual({ ok: true })
    expect(usage?.total_tokens).toBe(12)
  })

  it('returns usage as undefined when absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(completionBody('{"x":1}'))))
    const { usage } = await llmJsonWithRepairWithUsage({ system: 's', user: 'u' }, (x) => x)
    expect(usage).toBeUndefined()
  })
})
