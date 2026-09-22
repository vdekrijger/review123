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
} from './llm'
import { llmToolLoop } from './llmToolLoop'
import { setTransientRetryPolicyForTests } from './transientRetry'
import { setAiProvider, setAiModel, setDeepseekKey, getSettings } from '../settings/settings'
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
// Streaming — the deferred-streaming decision, made visible
// ===========================================================================

describe('bridge transport — streaming', () => {
  it('delivers the whole answer as ONE delta (there is no streaming route yet)', async () => {
    useBridge()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(inferBody({ text: 'a full paragraph' }))))

    const deltas: string[] = []
    const content = await llmStream({ system: 'S', user: 'U' }, (d) => deltas.push(d))

    expect(content).toBe('a full paragraph')
    // The UX consequence, pinned: one chunk at the end, not a typing effect.
    expect(deltas).toEqual(['a full paragraph'])
  })

  it('emits nothing for an empty answer rather than a blank delta', async () => {
    useBridge()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(inferBody({ text: '' }))))

    const deltas: string[] = []
    await llmStream({ system: 'S', user: 'U' }, (d) => deltas.push(d))
    expect(deltas).toEqual([])
  })

  it('reports usage on the streaming path too, when the CLI reported it', async () => {
    useBridge()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(inferBody({ usage: { inputTokens: 10, outputTokens: 4 } }))),
    )

    const { usage } = await llmStreamWithUsage({ system: 'S', user: 'U' }, () => {})
    expect(usage).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 })
  })

  it('propagates a bridge failure to a streaming caller, again with no paid fallback', async () => {
    useBridge()
    setDeepseekKey('sk-deepseek-key')
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(llmStream({ system: 'S', user: 'U' }, () => {})).rejects.toMatchObject({
      kind: 'network',
      message: BRIDGE_UNREACHABLE_MESSAGE,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
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
