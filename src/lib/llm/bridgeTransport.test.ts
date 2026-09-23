/**
 * bridgeTransport.test.ts — inference routed through the LOCAL BRIDGE.
 *
 * The bridge is the one transport whose failure mode is a policy question
 * rather than a wire-format question: the user chose to spend a subscription
 * they already pay for, so a bridge that stops answering must NOT quietly
 * become a billed API call. Several tests below exist only to pin that.
 *
 * Everything else is the usual transport contract — error classification,
 * abort vs timeout, the concurrency gate, transient retry, honest usage — held
 * to the same standard as the vendor adapters in transports.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  llmComplete,
  llmCompleteWithUsage,
  llmStream,
  llmStreamWithUsage,
  llmJsonWithRepair,
  llmTestConnection,
  LlmError,
  BRIDGE_JSON_INSTRUCTION,
  BRIDGE_NOT_PAIRED_MESSAGE,
  BRIDGE_UNREACHABLE_MESSAGE,
  CANCELLED_MESSAGE,
  TIMED_OUT_MESSAGE,
  bridgeLastStreamMode,
  _resetBridgeStreamModeForTest,
} from './llm'
import { llmToolLoop } from './llmToolLoop'
import { setTransientRetryPolicyForTests } from './transientRetry'
import { setAiProvider, setAiModel, setBridgeModel, setDeepseekKey, getSettings } from '../settings/settings'
import { BRIDGE_STORAGE_KEY } from '../bridge/storage'
import { BRIDGE_START_COMMAND } from '../bridge/install'
import { MAX_INFLIGHT_LLM_CALLS } from './concurrencyGate'

const TOKEN = 'pairing-token-0000000000000000000000000000'
const PORT = 7321

/** Pair a bridge the way the settings section does: a localStorage record. */
function pairBridge(port = PORT): void {
  localStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify({ token: TOKEN, port }))
}

function useBridge(cli: 'claude' | 'codex' = 'claude'): void {
  pairBridge()
  setAiProvider('bridge')
  setAiModel(cli)
}

function inferBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, cli: 'claude', text: 'the answer', truncated: false, durationMs: 42, ...overrides }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * A fetch mock that builds a FRESH Response per call.
 *
 * `mockResolvedValue(new Response(...))` hands every call the same object, and
 * a Response body can only be read once — so the second attempt of any retry
 * or repair path fails with "Body has already been read" and the test measures
 * the fixture instead of the transport.
 */
function respondWith(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(async () => jsonResponse(body, status))
}

function errorResponse(error: string, status: number, message = 'something went wrong'): Response {
  return jsonResponse({ ok: false, error, message }, status)
}

/** The parsed body of the Nth fetch call. */
function sentBody(fetchMock: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[index]![1] as RequestInit).body as string)
}

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>, index = 0): Record<string, string> {
  return (fetchMock.mock.calls[index]![1] as RequestInit).headers as Record<string, string>
}

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
  setTransientRetryPolicyForTests({ maxRetries: 0 })
})

afterEach(() => {
  setTransientRetryPolicyForTests(null)
  vi.useRealTimers()
})

// ===========================================================================
// The request
// ===========================================================================

describe('bridge transport — the request', () => {
  it('POSTs /v1/infer on the PAIRED port, bearer-authenticated, with no cookies', async () => {
    useBridge()
    pairBridge(9001)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(inferBody()))
    vi.stubGlobal('fetch', fetchMock)

    await llmComplete({ system: 'S', user: 'U' })

    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:9001/v1/infer')
    // 127.0.0.1, never `localhost`: the two are not the same origin, and the
    // bridge's CORS allowlist and Host guard are both pinned to the literal.
    expect(sentHeaders(fetchMock)['Authorization']).toBe(`Bearer ${TOKEN}`)
    expect((fetchMock.mock.calls[0]![1] as RequestInit).credentials).toBe('omit')
  })

  it('names the CLI from the selected model, and carries prompt + system', async () => {
    useBridge('codex')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(inferBody({ cli: 'codex' })))
    vi.stubGlobal('fetch', fetchMock)

    await llmComplete({ system: 'be terse', user: 'review this' })

    expect(sentBody(fetchMock)).toMatchObject({ cli: 'codex', prompt: 'review this', system: 'be terse' })
  })

  // -------------------------------------------------------------------------
  // Model selection. `aiModel` for the bridge names the CLI (`claude`/`codex`)
  // — a process, not a model — so which MODEL that process runs is a separate
  // setting. Before it existed, nothing ever sent `--model` and the user got
  // their CLI's configured default with no way to choose.
  // -------------------------------------------------------------------------
  it('sends the configured bridge model so the CLI gets a --model flag', async () => {
    useBridge()
    setBridgeModel('opus')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(inferBody()))
    vi.stubGlobal('fetch', fetchMock)

    await llmComplete({ system: 'S', user: 'U' })

    expect(sentBody(fetchMock)['model']).toBe('opus')
  })

  it('sends NO model field when none is configured — the CLI keeps its default', async () => {
    useBridge()
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(inferBody()))
    vi.stubGlobal('fetch', fetchMock)

    await llmComplete({ system: 'S', user: 'U' })

    // Absent, not empty: an empty string would make the bridge build
    // `--model ''` and the CLI would reject every call.
    expect(sentBody(fetchMock)).not.toHaveProperty('model')
  })

  it('keeps the CLI and the model independent', async () => {
    useBridge('codex')
    setBridgeModel('gpt-5')
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(inferBody({ cli: 'codex' })))
    vi.stubGlobal('fetch', fetchMock)

    await llmComplete({ system: 'S', user: 'U' })

    expect(sentBody(fetchMock)).toMatchObject({ cli: 'codex', model: 'gpt-5' })
  })

  it('sends a timeout the bridge can enforce, so both ends give up together', async () => {
    useBridge()
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(inferBody()))
    vi.stubGlobal('fetch', fetchMock)

    await llmComplete({ system: 'S', user: 'U', timeoutMs: 90_000 })

    expect(sentBody(fetchMock)['timeoutMs']).toBe(90_000)
  })

  it('never sends a command, argv, cwd or environment — only a CLI id', async () => {
    useBridge()
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(inferBody()))
    vi.stubGlobal('fetch', fetchMock)

    await llmComplete({ system: 'S', user: 'U' })

    const body = sentBody(fetchMock)
    expect(Object.keys(body).sort()).toEqual(['cli', 'prompt', 'system', 'timeoutMs'])
  })
})

// ===========================================================================
// JSON discipline — the shared ladder, not a second path
// ===========================================================================

describe('bridge transport — JSON', () => {
  it('asks for JSON by INSTRUCTION, because a CLI has no JSON mode', async () => {
    useBridge()
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(inferBody({ text: '{"a":1}' })))
    vi.stubGlobal('fetch', fetchMock)

    await llmJsonWithRepair({ system: 'S', user: 'U' }, (v) => v as { a: number })

    expect(sentBody(fetchMock)['system']).toBe(`S\n\n${BRIDGE_JSON_INSTRUCTION}`)
  })

  it.each([
    ['a bare object', '{"verdict":"ok"}'],
    ['a fenced block', '```json\n{"verdict":"ok"}\n```'],
    ['prose around it', 'Here is the result:\n\n{"verdict":"ok"}\n\nHope that helps!'],
    ['a trailing comma', '{"verdict":"ok",}'],
  ])('salvages %s through the EXISTING extraction ladder — no second JSON path', async (_label, text) => {
    useBridge()
    vi.stubGlobal('fetch', respondWith(inferBody({ text })))

    const { verdict } = await llmJsonWithRepair({ system: 'S', user: 'U' }, (v) => v as { verdict: string })
    expect(verdict).toBe('ok')
  })

  it('retries with the repair prompt when the first answer is unusable, then succeeds', async () => {
    useBridge()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(inferBody({ text: 'I cannot do that.' })))
      .mockResolvedValueOnce(jsonResponse(inferBody({ text: '{"verdict":"ok"}' })))
    vi.stubGlobal('fetch', fetchMock)

    const { verdict } = await llmJsonWithRepair({ system: 'S', user: 'U' }, (v) => v as { verdict: string })
    expect(verdict).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('raises invalid-output when even the repair attempt is unusable', async () => {
    useBridge()
    vi.stubGlobal('fetch', respondWith(inferBody({ text: 'still no' })))

    await expect(
      llmJsonWithRepair({ system: 'S', user: 'U' }, (v) => v as unknown),
    ).rejects.toMatchObject({ kind: 'invalid-output' })
  })

  it('carries `truncated` through, so the repair ladder raises the cap instead of echoing a cut body', async () => {
    useBridge()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(inferBody({ text: '{"verdict":"o', truncated: true })))
      .mockResolvedValueOnce(jsonResponse(inferBody({ text: '{"verdict":"ok"}' })))
    vi.stubGlobal('fetch', fetchMock)

    await llmJsonWithRepair({ system: 'S', user: 'U' }, (v) => v as { verdict: string })

    // The truncation branch must NOT echo the cut-off body back into the prompt
    // (that is how one overflow became two). It asks for concision instead.
    expect(String(sentBody(fetchMock, 1)['prompt'])).not.toContain('{"verdict":"o')
  })
})

// ===========================================================================
// Usage — honest, or absent
// ===========================================================================

describe('bridge transport — usage', () => {
  it('reports token counts when the CLI reported them', async () => {
    useBridge()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(inferBody({ usage: { inputTokens: 445, outputTokens: 15 } }))),
    )

    const { usage } = await llmCompleteWithUsage({ system: 'S', user: 'U' })
    expect(usage).toEqual({ prompt_tokens: 445, completion_tokens: 15, total_tokens: 460 })
  })

  it('leaves usage UNDEFINED when the CLI reported none — never a zero that reads as free', async () => {
    useBridge('codex')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(inferBody({ cli: 'codex' }))))

    const result = await llmCompleteWithUsage({ system: 'S', user: 'U' })
    expect(result.usage).toBeUndefined()
    expect(result.content).toBe('the answer')
  })

  it('ignores a half-reported usage pair rather than inventing the missing half', async () => {
    useBridge()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(inferBody({ usage: { inputTokens: 445 } }))),
    )

    expect((await llmCompleteWithUsage({ system: 'S', user: 'U' })).usage).toBeUndefined()
  })

  it('omits usage when the caller did not ask for it', async () => {
    useBridge()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(inferBody({ usage: { inputTokens: 1, outputTokens: 2 } }))),
    )
    expect(await llmComplete({ system: 'S', user: 'U' })).toBe('the answer')
  })
})

// ===========================================================================
// Failure — classification, and NO silent paid fallback
// ===========================================================================

describe('bridge transport — failures', () => {
  it('fails with an actionable message when no bridge was ever paired', async () => {
    setAiProvider('bridge')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(llmComplete({ system: 'S', user: 'U' })).rejects.toMatchObject({
      kind: 'no-key',
      message: BRIDGE_NOT_PAIRED_MESSAGE,
    })
    // Not one byte goes anywhere: there is nothing to call.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // The error line is an INSTRUCTION, so it must name the command the user
  // actually ran. Since #239 that is the downloaded release bundle, not the
  // checkout-only `pnpm bridge` (still offered in Settings as the
  // build-it-yourself fallback, but never as the thing to run mid-review).
  it('tells the user to start the bridge the way Settings told them to install it', () => {
    expect(BRIDGE_UNREACHABLE_MESSAGE).toContain(BRIDGE_START_COMMAND)
    expect(BRIDGE_UNREACHABLE_MESSAGE).not.toContain('pnpm bridge')
    // Still an error line, not documentation.
    expect(BRIDGE_UNREACHABLE_MESSAGE.length).toBeLessThan(200)
  })

  it('fails HONESTLY when the bridge stops answering mid-review — no silent paid fallback', async () => {
    useBridge()
    // A DeepSeek key IS configured. A quiet fallback to it would spend the
    // user's money on a run they chose to put on their subscription.
    setDeepseekKey('sk-deepseek-key')
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(llmComplete({ system: 'S', user: 'U' })).rejects.toMatchObject({
      kind: 'network',
      message: BRIDGE_UNREACHABLE_MESSAGE,
    })
    // ONE call, to the bridge. Never a second one to a vendor.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]![0])).toContain('127.0.0.1')
    expect(getSettings().deepseekKey).toBe('sk-deepseek-key')
  })

  it.each([
    ['unauthorized', 401, 'auth', /pairing token/i],
    ['cli-unavailable', 503, 'no-key', /not installed/i],
    ['timeout', 504, 'timeout', /budget/i],
    ['cli-failed', 502, 'server', /exited/i],
    ['not-implemented', 501, 'server', /too old/i],
    ['forbidden-origin', 403, 'auth', /origin/i],
  ] as const)('maps a %s answer onto an LlmError the UI can act on', async (code, status, kind, copy) => {
    useBridge()
    const message = {
      unauthorized: 'A valid pairing token is required.',
      'cli-unavailable': "The claude CLI is not installed on this machine's PATH.",
      timeout: 'The claude CLI did not finish within the 120000 ms budget and was stopped.',
      'cli-failed': 'The claude CLI exited with code 1.',
      'not-implemented': '/v1/infer is reserved.',
      'forbidden-origin': 'This origin is not allowed.',
    }[code]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(code, status, message)))

    const err = await llmComplete({ system: 'S', user: 'U' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe(kind)
    expect((err as LlmError).message).toMatch(copy)
  })

  it('survives an error code it does not know — protocol codes are additive', async () => {
    useBridge()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: 'from-a-newer-bridge', message: 'a new failure' }, 502)),
    )

    await expect(llmComplete({ system: 'S', user: 'U' })).rejects.toMatchObject({
      kind: 'server',
      message: 'a new failure',
    })
  })

  it('rejects a malformed 200 rather than passing garbage into a task', async () => {
    useBridge()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true, cli: 'claude' })))

    await expect(llmComplete({ system: 'S', user: 'U' })).rejects.toMatchObject({ kind: 'server' })
  })
})

// ===========================================================================
// Abort vs timeout (#233 / #234) — the distinction must survive
// ===========================================================================

describe('bridge transport — cancellation and timeouts', () => {
  it('a caller cancellation is `aborted`, never blamed on the network', async () => {
    useBridge()
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        controller.abort()
        return Promise.reject(
          Object.assign(new DOMException('The user aborted a request.', 'AbortError'), {
            signal: init.signal,
          }),
        )
      }),
    )

    const err = await llmComplete({ system: 'S', user: 'U', signal: controller.signal }).catch(
      (e: unknown) => e,
    )
    expect((err as LlmError).kind).toBe('aborted')
    // Never the engine's own "The user aborted a request." — the user did not.
    expect((err as LlmError).message).toBe(CANCELLED_MESSAGE)
  })

  it("our own request window firing is a `timeout`, not a cancellation", async () => {
    useBridge()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError')),
    )

    await expect(llmComplete({ system: 'S', user: 'U', timeoutMs: 10 })).rejects.toMatchObject({
      kind: 'timeout',
    })
  })

  it('a BRIDGE-side timeout (the CLI was killed) is also a `timeout`', async () => {
    useBridge()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errorResponse('timeout', 504, 'The claude CLI did not finish within the budget.')),
    )

    await expect(llmComplete({ system: 'S', user: 'U' })).rejects.toMatchObject({ kind: 'timeout' })
  })
})

// ===========================================================================
// Shared plumbing — the gate and transient retry apply here too
// ===========================================================================

describe('bridge transport — gate and retry', () => {
  it('holds a per-provider concurrency slot, so a fan-out cannot stampede one CLI', async () => {
    useBridge()
    let inFlight = 0
    let peak = 0
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 1))
        inFlight -= 1
        return jsonResponse(inferBody())
      }),
    )

    const calls = Array.from({ length: MAX_INFLIGHT_LLM_CALLS + 4 }, () =>
      llmComplete({ system: 'S', user: 'U' }),
    )
    await Promise.all(calls)

    expect(peak).toBeLessThanOrEqual(MAX_INFLIGHT_LLM_CALLS)
  })

  it('retries a transient bridge failure when the retry policy allows it', async () => {
    useBridge()
    setTransientRetryPolicyForTests({ maxRetries: 1, baseDelayMs: 0 })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse('cli-failed', 502, 'The claude CLI exited with code 1.'))
      .mockResolvedValueOnce(jsonResponse(inferBody()))
    vi.stubGlobal('fetch', fetchMock)

    expect(await llmComplete({ system: 'S', user: 'U' })).toBe('the answer')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a 503 cli-unavailable — installing a CLI is not something waiting fixes', async () => {
    useBridge()
    setTransientRetryPolicyForTests({ maxRetries: 2, baseDelayMs: 0 })
    const fetchMock = respondWith({ ok: false, error: 'cli-unavailable', message: 'not installed' }, 503)
    vi.stubGlobal('fetch', fetchMock)

    await expect(llmComplete({ system: 'S', user: 'U' })).rejects.toMatchObject({ kind: 'no-key' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// Streaming — POST /v1/infer/stream, NDJSON
//
// The properties that matter are the ones #234 taught this repo the hard way:
// every read of the body has to be inside the classification boundary, and a
// stream that ends badly must never look like a short answer.
// ===========================================================================

/** One NDJSON line, terminator included. */
function ndjson(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`
}

/**
 * An NDJSON Response whose body yields `chunks` one `reader.read()` at a time,
 * so a test can assert that deltas reach the consumer BETWEEN reads rather
 * than all at the end.
 */
function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[i]!))
      i += 1
    },
  })
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/x-ndjson' },
  })
}

/** The usual happy sequence: start, three deltas, done. */
function happyStream(text = 'Hello, world', usage?: Record<string, number>): string[] {
  return [
    ndjson({ type: 'start', cli: 'claude', streaming: true }),
    ndjson({ type: 'delta', text: text.slice(0, 5) }),
    ndjson({ type: 'delta', text: text.slice(5, 8) }),
    ndjson({ type: 'delta', text: text.slice(8) }),
    ndjson({ type: 'done', text, truncated: false, durationMs: 42, ...(usage ? { usage } : {}) }),
  ]
}

/** A fetch mock that answers the STREAM route and 404s everything else. */
function streamFetch(chunks: string[], status = 200): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(async (url: string) => {
    if (String(url).includes('/v1/infer/stream')) return streamResponse(chunks, status)
    throw new Error(`unexpected fetch: ${url}`)
  })
}

describe('bridge transport — streaming', () => {
  beforeEach(() => {
    _resetBridgeStreamModeForTest()
  })

  it('POSTs the STREAM route on the paired port, bearer-authenticated, no cookies', async () => {
    useBridge()
    pairBridge(9100)
    const fetchMock = streamFetch(happyStream())
    vi.stubGlobal('fetch', fetchMock)

    await llmStream({ system: 'S', user: 'U' }, () => {})

    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:9100/v1/infer/stream')
    expect(sentHeaders(fetchMock)['Authorization']).toBe(`Bearer ${TOKEN}`)
    expect((fetchMock.mock.calls[0]![1] as RequestInit).credentials).toBe('omit')
    // Still a CLI id and a prompt on the body — never a command, argv or cwd.
    expect(Object.keys(sentBody(fetchMock)).sort()).toEqual(['cli', 'prompt', 'system', 'timeoutMs'])
  })

  it('sends the configured model on the STREAM route too', async () => {
    // Both routes must pick the same model, or the same review would be
    // answered by a different one depending only on whether the CLI happened
    // to support partial output.
    useBridge()
    setBridgeModel('sonnet')
    const fetchMock = streamFetch(happyStream())
    vi.stubGlobal('fetch', fetchMock)

    await llmStream({ system: 'S', user: 'U' }, () => {})

    expect(sentBody(fetchMock)['model']).toBe('sonnet')
  })

  it('sends no model on the STREAM route when none is configured', async () => {
    useBridge()
    const fetchMock = streamFetch(happyStream())
    vi.stubGlobal('fetch', fetchMock)

    await llmStream({ system: 'S', user: 'U' }, () => {})

    expect(sentBody(fetchMock)).not.toHaveProperty('model')
  })

  it('DELIVERS DELTAS INCREMENTALLY — the consumer sees them before the answer ends', async () => {
    useBridge()
    vi.stubGlobal('fetch', streamFetch(happyStream('Hello, world')))

    const deltas: string[] = []
    const content = await llmStream({ system: 'S', user: 'U' }, (d) => deltas.push(d))

    // Three separate deltas, in order — not one blob at the end. This is the
    // whole point of the route.
    expect(deltas).toEqual(['Hello', ', w', 'orld'])
    expect(content).toBe('Hello, world')
  })

  it('a delta reaches the consumer BEFORE the stream is finished being read', async () => {
    useBridge()
    const seenAt: number[] = []
    let reads = 0
    const encoder = new TextEncoder()
    const chunks = happyStream('Hello, world')
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads >= chunks.length) {
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(chunks[reads]!))
        reads += 1
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } })),
    )

    await llmStream({ system: 'S', user: 'U' }, () => seenAt.push(reads))

    // The first delta was observed while chunks were STILL UNREAD, and each
    // later one after strictly more reads. A buffered implementation would
    // report the same (final) read count for every delta.
    expect(seenAt).toHaveLength(3)
    expect(seenAt[0]!).toBeLessThan(chunks.length)
    expect(seenAt[0]!).toBeLessThan(seenAt[1]!)
    expect(seenAt[1]!).toBeLessThan(seenAt[2]!)
  })

  it('uses done.text as the final answer — the CLI’s own verdict, not our concatenation', async () => {
    useBridge()
    vi.stubGlobal(
      'fetch',
      streamFetch([
        ndjson({ type: 'start', cli: 'claude', streaming: true }),
        ndjson({ type: 'delta', text: 'partial' }),
        ndjson({ type: 'done', text: 'the complete answer', truncated: false, durationMs: 1 }),
      ]),
    )
    const content = await llmStream({ system: 'S', user: 'U' }, () => {})
    expect(content).toBe('the complete answer')
  })

  it('falls back on the accumulated deltas when done carries no text', async () => {
    useBridge()
    vi.stubGlobal(
      'fetch',
      streamFetch([
        ndjson({ type: 'delta', text: 'all ' }),
        ndjson({ type: 'delta', text: 'of it' }),
        ndjson({ type: 'done', text: '', truncated: true, durationMs: 1 }),
      ]),
    )
    expect(await llmStream({ system: 'S', user: 'U' }, () => {})).toBe('all of it')
  })

  it('emits nothing for an empty answer rather than a blank delta', async () => {
    useBridge()
    vi.stubGlobal(
      'fetch',
      streamFetch([
        ndjson({ type: 'start', cli: 'claude', streaming: true }),
        ndjson({ type: 'delta', text: '' }),
        ndjson({ type: 'done', text: '', truncated: false, durationMs: 1 }),
      ]),
    )
    const deltas: string[] = []
    await llmStream({ system: 'S', user: 'U' }, (d) => deltas.push(d))
    expect(deltas).toEqual([])
  })

  it('reports usage when the CLI reported it, and omits it otherwise', async () => {
    useBridge()
    vi.stubGlobal('fetch', streamFetch(happyStream('Hello, world', { inputTokens: 10, outputTokens: 4 })))
    const withUsage = await llmStreamWithUsage({ system: 'S', user: 'U' }, () => {})
    expect(withUsage.usage).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 })

    vi.stubGlobal('fetch', streamFetch(happyStream('Hello, world')))
    const without = await llmStreamWithUsage({ system: 'S', user: 'U' }, () => {})
    expect(without.usage).toBeUndefined()
  })

  it('ignores a HALF-reported usage pair rather than inventing the missing half', async () => {
    useBridge()
    vi.stubGlobal(
      'fetch',
      streamFetch([
        ndjson({ type: 'done', text: 'x', truncated: false, durationMs: 1, usage: { inputTokens: 10 } }),
      ]),
    )
    const { usage } = await llmStreamWithUsage({ system: 'S', user: 'U' }, () => {})
    expect(usage).toBeUndefined()
  })

  it('skips an event type it does not know — stream events are additive within v1', async () => {
    useBridge()
    vi.stubGlobal(
      'fetch',
      streamFetch([
        ndjson({ type: 'start', cli: 'claude', streaming: true }),
        ndjson({ type: 'progress', percent: 40 }),
        ndjson({ type: 'delta', text: 'still fine' }),
        '\n',
        ndjson({ type: 'done', text: 'still fine', truncated: false, durationMs: 1 }),
      ]),
    )
    expect(await llmStream({ system: 'S', user: 'U' }, () => {})).toBe('still fine')
  })

  it('reassembles an event split across two reads', async () => {
    useBridge()
    const line = ndjson({ type: 'done', text: 'reassembled', truncated: false, durationMs: 1 })
    vi.stubGlobal('fetch', streamFetch([line.slice(0, 12), line.slice(12)]))
    expect(await llmStream({ system: 'S', user: 'U' }, () => {})).toBe('reassembled')
  })
})

// ---------------------------------------------------------------------------
// Failures — never a short answer, never a paid fallback
// ---------------------------------------------------------------------------

describe('bridge transport — streaming failures', () => {
  beforeEach(() => {
    _resetBridgeStreamModeForTest()
  })

  it('a stream that ends WITHOUT done is a failure, not a short answer', async () => {
    useBridge()
    vi.stubGlobal(
      'fetch',
      streamFetch([
        ndjson({ type: 'start', cli: 'claude', streaming: true }),
        ndjson({ type: 'delta', text: 'half an ans' }),
      ]),
    )
    await expect(llmStream({ system: 'S', user: 'U' }, () => {})).rejects.toMatchObject({
      kind: 'server',
      message: expect.stringMatching(/ended the stream before the answer was finished/i),
    })
  })

  // A real bridge keys this `code` (verified live); `error` is the alias every
  // other bridge error body uses. Both must classify, or a failure arrives at
  // the panel unclassified.
  it.each([
    ['code', 'code'],
    ['error', 'error'],
  ])(
    'a mid-stream error event keyed by `%s` classifies by its CODE, exactly as the status would',
    async (_label, field) => {
      useBridge()
      vi.stubGlobal(
        'fetch',
        streamFetch([
          ndjson({ type: 'start', cli: 'claude', streaming: true }),
          ndjson({ type: 'delta', text: 'started' }),
          ndjson({ type: 'error', [field]: 'timeout', message: 'The claude CLI did not finish in time.' }),
        ]),
      )
      await expect(llmStream({ system: 'S', user: 'U' }, () => {})).rejects.toMatchObject({
        kind: 'timeout',
        message: 'The claude CLI did not finish in time.',
      })
    },
  )

  it('a mid-stream cli-failed does NOT carry a retry status — a retry would re-emit the deltas', async () => {
    useBridge()
    setTransientRetryPolicyForTests({ maxRetries: 2 })
    const fetchMock = streamFetch([
      ndjson({ type: 'start', cli: 'claude', streaming: true }),
      ndjson({ type: 'delta', text: 'the opening of the answer' }),
      ndjson({ type: 'error', error: 'cli-failed', message: 'The claude CLI exited with code 1.' }),
    ])
    vi.stubGlobal('fetch', fetchMock)

    const deltas: string[] = []
    await expect(llmStream({ system: 'S', user: 'U' }, (d) => deltas.push(d))).rejects.toMatchObject({
      kind: 'server',
      status: undefined,
    })
    // ONE attempt, ONE copy of the opening. A retried stream would have shown
    // the consumer the same text twice.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(deltas).toEqual(['the opening of the answer'])
  })

  it('an error BEFORE any delta keeps the ordinary retry decision — nothing to double-emit', async () => {
    useBridge()
    setTransientRetryPolicyForTests({ maxRetries: 1 })
    const fetchMock = vi.fn().mockImplementation(async () =>
      streamResponse([
        ndjson({ type: 'start', cli: 'claude', streaming: true }),
        ndjson({ type: 'error', error: 'cli-failed', message: 'The claude CLI exited with code 1.' }),
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(llmStream({ system: 'S', user: 'U' }, () => {})).rejects.toMatchObject({ kind: 'server' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('an unknown error code falls back on the message rather than crashing', async () => {
    useBridge()
    vi.stubGlobal(
      'fetch',
      streamFetch([ndjson({ type: 'error', error: 'quantum-flux', message: 'Something new went wrong.' })]),
    )
    await expect(llmStream({ system: 'S', user: 'U' }, () => {})).rejects.toMatchObject({
      kind: 'server',
      message: 'Something new went wrong.',
    })
  })

  it('a bridge that stopped answering fails HONESTLY — no silent paid fallback', async () => {
    useBridge()
    setDeepseekKey('sk-deepseek-key')
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(llmStream({ system: 'S', user: 'U' }, () => {})).rejects.toMatchObject({
      kind: 'network',
      message: BRIDGE_UNREACHABLE_MESSAGE,
    })
    // Exactly one call, to loopback. Nothing reached a metered provider.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]![0])).toContain('127.0.0.1')
  })

  it('a mid-stream failure never falls back to the configured API key either', async () => {
    useBridge()
    setDeepseekKey('sk-deepseek-key')
    const fetchMock = streamFetch([
      ndjson({ type: 'delta', text: 'started' }),
      ndjson({ type: 'error', error: 'cli-failed', message: 'boom' }),
    ])
    vi.stubGlobal('fetch', fetchMock)

    await expect(llmStream({ system: 'S', user: 'U' }, () => {})).rejects.toThrow()
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain('127.0.0.1')
    }
  })

  it('an unpaired bridge is `no-key`, with the pairing instruction', async () => {
    setAiProvider('bridge')
    setAiModel('claude')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(llmStream({ system: 'S', user: 'U' }, () => {})).rejects.toMatchObject({
      kind: 'no-key',
      message: BRIDGE_NOT_PAIRED_MESSAGE,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a non-2xx that is not 404 is classified from its body, before any body read', async () => {
    useBridge()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse('cli-unavailable', 503)))
    await expect(llmStream({ system: 'S', user: 'U' }, () => {})).rejects.toMatchObject({ kind: 'no-key' })
  })
})

// ---------------------------------------------------------------------------
// #233/#234 CLASSIFICATION PARITY — the regression this PR is likeliest to
// reintroduce.
//
// `fetch()` resolves when the HEADERS arrive. The body streams afterwards, so
// a window that fires mid-answer rejects `reader.read()`, not the fetch — and
// Blink reports that as a plain AbortError. A body read left OUTSIDE the
// mapped try/catch therefore escapes unclassified and reaches the panel with
// the engine's own "The user aborted a request." text intact. That is exactly
// the bug #234 fixed, and streaming is where it lived.
// ---------------------------------------------------------------------------

/**
 * A Response whose body read REJECTS after `before` chunks, with `err`.
 * The rejection is the thing under test: it must come back classified.
 */
function rejectingStreamResponse(before: string[], err: unknown, delayMs = 0): Response {
  const encoder = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i < before.length) {
        controller.enqueue(encoder.encode(before[i]!))
        i += 1
        return
      }
      // `delayMs` lets a test put the rejection AFTER our own request window
      // has expired, which is the case Blink reports as a plain AbortError.
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      controller.error(err)
    },
  })
  return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } })
}

function domError(name: string): DOMException {
  return new DOMException(`engine text for ${name}`, name)
}

describe('bridge transport — stream-read classification parity (#233/#234)', () => {
  beforeEach(() => {
    _resetBridgeStreamModeForTest()
  })

  it('A STREAM-READ ABORT IS `aborted`, WITH NEUTRAL COPY — never the engine’s "user aborted" text', async () => {
    useBridge()
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        // The caller cancels once the response is in flight, so the failure
        // lands on reader.read() rather than on the fetch itself.
        queueMicrotask(() => controller.abort())
        return rejectingStreamResponse(
          [ndjson({ type: 'start', cli: 'claude', streaming: true })],
          domError('AbortError'),
        )
      }),
    )

    const err = await llmStream({ system: 'S', user: 'U', signal: controller.signal }, () => {}).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('aborted')
    expect((err as LlmError).message).toBe(CANCELLED_MESSAGE)
    // THE REGRESSION: the engine's own wording must never reach the panel.
    expect((err as LlmError).message).not.toMatch(/user aborted|engine text/i)
  })

  it('A STREAM-READ ABORT WHILE OUR OWN WINDOW HAS FIRED IS `timeout`, not a cancellation', async () => {
    useBridge()
    // Blink reports a window-aborted body read as a plain AbortError, so
    // reading err.name alone would call a genuine timeout a cancellation and
    // quietly drop the panel to a calm state. The timeout SIGNAL is what tells
    // the truth, and this pins that it is consulted on the READ path too.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        rejectingStreamResponse([ndjson({ type: 'delta', text: 'started' })], domError('AbortError'), 40),
      ),
    )

    const err = await llmStream({ system: 'S', user: 'U', timeoutMs: 5 }, () => {}).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('timeout')
    expect((err as LlmError).message).toBe(TIMED_OUT_MESSAGE)
  })

  it('A STREAM-READ TimeoutError IS `timeout`, by the spec’d discriminant', async () => {
    useBridge()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        rejectingStreamResponse([ndjson({ type: 'delta', text: 'x' })], domError('TimeoutError')),
      ),
    )
    const err = await llmStream({ system: 'S', user: 'U' }, () => {}).catch((e: unknown) => e)
    expect((err as LlmError).kind).toBe('timeout')
  })

  it('ANY OTHER stream-read rejection is `network` — classified, never raw', async () => {
    useBridge()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        rejectingStreamResponse(
          [ndjson({ type: 'delta', text: 'x' })],
          new TypeError('network error while reading body'),
        ),
      ),
    )
    const err = await llmStream({ system: 'S', user: 'U' }, () => {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('network')
  })

  it('an LlmError raised INSIDE the read loop is not re-classified as a network failure', async () => {
    useBridge()
    vi.stubGlobal(
      'fetch',
      streamFetch([ndjson({ type: 'error', error: 'timeout', message: 'the CLI was too slow' })]),
    )
    const err = await llmStream({ system: 'S', user: 'U' }, () => {}).catch((e: unknown) => e)
    // Re-mapping it would turn a precise `timeout` into a generic `network`.
    expect((err as LlmError).kind).toBe('timeout')
  })

  it('a caller cancellation before the headers arrive is still `aborted`', async () => {
    useBridge()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(domError('AbortError')))
    const err = await llmStream({ system: 'S', user: 'U' }, () => {}).catch((e: unknown) => e)
    expect((err as LlmError).kind).toBe('aborted')
    expect((err as LlmError).message).toBe(CANCELLED_MESSAGE)
  })

  it('a BRIDGE-side timeout event carries the bridge’s message, still classified `timeout`', async () => {
    useBridge()
    vi.stubGlobal(
      'fetch',
      streamFetch([
        ndjson({
          type: 'error',
          error: 'timeout',
          message: 'The claude CLI did not finish within the 120000 ms budget and was stopped.',
        }),
      ]),
    )
    const err = await llmStream({ system: 'S', user: 'U' }, () => {}).catch((e: unknown) => e)
    expect((err as LlmError).kind).toBe('timeout')
    expect((err as LlmError).message).toContain('120000 ms budget')
  })
})

// ---------------------------------------------------------------------------
// The fallback: an older bridge with no streaming route
// ---------------------------------------------------------------------------

describe('bridge transport — an older bridge with no /v1/infer/stream', () => {
  beforeEach(() => {
    _resetBridgeStreamModeForTest()
  })

  /** 404 the stream route (an older bridge), answer the one-shot route. */
  function olderBridgeFetch(body: Record<string, unknown> = inferBody()): ReturnType<typeof vi.fn> {
    return vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/v1/infer/stream')) {
        return jsonResponse({ ok: false, error: 'not-found', message: 'No route POST /v1/infer/stream' }, 404)
      }
      return jsonResponse(body)
    })
  }

  it('falls back to the ONE-SHOT route transparently, and still answers', async () => {
    useBridge()
    const fetchMock = olderBridgeFetch(inferBody({ text: 'a full paragraph' }))
    vi.stubGlobal('fetch', fetchMock)

    const deltas: string[] = []
    const content = await llmStream({ system: 'S', user: 'U' }, (d) => deltas.push(d))

    expect(content).toBe('a full paragraph')
    // One delta at the end — the pre-streaming behaviour, unchanged. Emitting
    // none would leave a delta-rendered panel permanently blank.
    expect(deltas).toEqual(['a full paragraph'])
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/v1/infer/stream')
    expect(String(fetchMock.mock.calls[1]![0])).toMatch(/\/v1\/infer$/)
  })

  it('NEVER CLAIMS TO HAVE STREAMED — the app can say so if the user asks', async () => {
    useBridge()
    vi.stubGlobal('fetch', olderBridgeFetch())
    await llmStream({ system: 'S', user: 'U' }, () => {})
    expect(bridgeLastStreamMode()).toBe('no-route')
  })

  it('records `streamed` when the CLI really did type out', async () => {
    useBridge()
    vi.stubGlobal('fetch', streamFetch(happyStream()))
    await llmStream({ system: 'S', user: 'U' }, () => {})
    expect(bridgeLastStreamMode()).toBe('streamed')
  })

  it('records `cli-one-shot` when the bridge streams but the CLI cannot (codex)', async () => {
    useBridge('codex')
    vi.stubGlobal(
      'fetch',
      streamFetch([
        ndjson({ type: 'start', cli: 'codex', streaming: false }),
        ndjson({ type: 'delta', text: 'the whole answer at once' }),
        ndjson({ type: 'done', text: 'the whole answer at once', truncated: false, durationMs: 9 }),
      ]),
    )
    const deltas: string[] = []
    await llmStream({ system: 'S', user: 'U' }, (d) => deltas.push(d))
    expect(bridgeLastStreamMode()).toBe('cli-one-shot')
    // Honest: ONE delta, because that is genuinely how it arrived.
    expect(deltas).toEqual(['the whole answer at once'])
  })

  it('the fallback still refuses to spend the API key when the one-shot route ALSO fails', async () => {
    useBridge()
    setDeepseekKey('sk-deepseek-key')
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/v1/infer/stream')) {
        return jsonResponse({ ok: false, error: 'not-found', message: 'no' }, 404)
      }
      return errorResponse('cli-failed', 502, 'The claude CLI exited with code 1.')
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(llmStream({ system: 'S', user: 'U' }, () => {})).rejects.toMatchObject({ kind: 'server' })
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain('127.0.0.1')
    }
  })
})

// ===========================================================================
// The tool loop stays off the bridge
// ===========================================================================

describe('bridge transport — the agentic loop', () => {
  it('refuses the tool loop with an explanation, rather than half-driving an agent', async () => {
    useBridge()
    vi.stubGlobal('fetch', vi.fn())

    const err = await llmToolLoop({
      system: 'S',
      user: 'U',
      tools: [],
      executeTool: async () => ({ ok: true, content: '' }),
    }).catch((e: unknown) => e)

    expect((err as LlmError).kind).toBe('server')
    expect((err as LlmError).message).toMatch(/already an agent/i)
  })
})

// ===========================================================================
// The connection test
// ===========================================================================

describe('bridge transport — llmTestConnection', () => {
  it('does a real round-trip through the bridge into the CLI', async () => {
    pairBridge()
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(inferBody({ text: 'ok' })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(llmTestConnection('bridge')).resolves.toBeUndefined()
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`http://127.0.0.1:${PORT}/v1/infer`)
    expect(sentBody(fetchMock)['cli']).toBe('claude')
  })

  it('tests the CLI the caller named, not just the default', async () => {
    pairBridge()
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(inferBody({ cli: 'codex', text: 'ok' })))
    vi.stubGlobal('fetch', fetchMock)

    await llmTestConnection('bridge', 'codex')
    expect(sentBody(fetchMock)['cli']).toBe('codex')
  })

  it('surfaces a missing CLI as a failed test rather than a false green', async () => {
    pairBridge()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse('cli-unavailable', 503, 'not installed')))

    await expect(llmTestConnection('bridge')).rejects.toMatchObject({ kind: 'no-key' })
  })
})
