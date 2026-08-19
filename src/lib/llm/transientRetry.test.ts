/**
 * transientRetry tests — transient 429/5xx become latency, not failure.
 *
 * Coverage:
 *   - parseRetryAfterMs: delta-seconds + http-date forms, absent/garbage
 *   - mapHttpError populates LlmError.status / LlmError.retryAfterMs
 *   - retry policy through the PUBLIC llmComplete path (mock fetch):
 *       429 with Retry-After (delta + date) sleeps exactly that long
 *       429 without header → exponential + full jitter within bounds
 *       503 retried; 400/401/timeout NOT retried
 *       exhaustion rethrows the LAST LlmError unchanged (kind/message/status)
 *   - the gate slot is RELEASED during backoff sleeps
 *   - per-provider gates: provider A saturated does not block provider B
 *
 * All timing uses vi.useFakeTimers — no real sleeps.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { llmComplete, llmJsonWithRepairFor, parseRetryAfterMs, LlmError } from './llm'
import type { ProviderConfig } from './llm'
import {
  withTransientRetry,
  isTransientLlmError,
  setOnTransientRetry,
  getTransientRetryCount,
  setTransientRetryPolicyForTests,
  TRANSIENT_RETRY_POLICY,
} from './transientRetry'
import type { TransientRetryEvent } from './transientRetry'
import { gateFor, MAX_INFLIGHT_LLM_CALLS } from './concurrencyGate'
import { getProvider, getModelDef } from './providers'
import { setDeepseekKey } from '../settings/settings'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function completionResponse(content: string): Response {
  return makeJsonResponse({ choices: [{ message: { content } }] })
}

async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.useFakeTimers()
  setDeepseekKey('sk-test')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  setOnTransientRetry(null)
  setTransientRetryPolicyForTests(null)
})

// ---------------------------------------------------------------------------
// parseRetryAfterMs
// ---------------------------------------------------------------------------

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000)
    expect(parseRetryAfterMs(' 2 ')).toBe(2_000)
    expect(parseRetryAfterMs('0')).toBe(0)
  })

  it('parses an http-date relative to now', () => {
    const now = Date.parse('2026-08-19T12:00:00.000Z')
    expect(parseRetryAfterMs('Wed, 19 Aug 2026 12:00:03 GMT', now)).toBe(3_000)
  })

  it('clamps a past http-date to 0', () => {
    const now = Date.parse('2026-08-19T12:00:00.000Z')
    expect(parseRetryAfterMs('Wed, 19 Aug 2026 11:59:00 GMT', now)).toBe(0)
  })

  it('returns undefined for absent or unparseable values', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined()
    expect(parseRetryAfterMs('')).toBeUndefined()
    expect(parseRetryAfterMs('soon')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// mapHttpError enrichment (via the public path)
// ---------------------------------------------------------------------------

describe('LlmError enrichment — status + retryAfterMs', () => {
  beforeEach(() => setTransientRetryPolicyForTests({ maxRetries: 0 }))

  it('429 carries status and parsed Retry-After (delta form)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeJsonResponse({}, 429, { 'Retry-After': '7' })),
    )
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({
      kind: 'rate-limited',
      status: 429,
      retryAfterMs: 7_000,
    })
  })

  it('429 without Retry-After leaves retryAfterMs undefined', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse({}, 429)))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({
      kind: 'rate-limited',
      status: 429,
      retryAfterMs: undefined,
    })
  })

  it('5xx carries its status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse({}, 503)))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({
      kind: 'server',
      status: 503,
    })
  })
})

// ---------------------------------------------------------------------------
// isTransientLlmError
// ---------------------------------------------------------------------------

describe('isTransientLlmError', () => {
  it('accepts rate-limited and status>=500; rejects everything else', () => {
    expect(isTransientLlmError(new LlmError('rate-limited', 'x'))).toBe(true)
    expect(isTransientLlmError(new LlmError('server', 'x', { status: 500 }))).toBe(true)
    expect(isTransientLlmError(new LlmError('server', 'x', { status: 503 }))).toBe(true)
    // A 'server' error WITHOUT an HTTP status (e.g. malformed 200 body) is not
    // transient — retrying a shape bug wastes budget.
    expect(isTransientLlmError(new LlmError('server', 'missing content'))).toBe(false)
    expect(isTransientLlmError(new LlmError('server', 'x', { status: 400 }))).toBe(false)
    expect(isTransientLlmError(new LlmError('auth', 'x', { status: 401 }))).toBe(false)
    expect(isTransientLlmError(new LlmError('timeout', 'x'))).toBe(false)
    expect(isTransientLlmError(new LlmError('network', 'x'))).toBe(false)
    expect(isTransientLlmError(new LlmError('invalid-output', 'x'))).toBe(false)
    expect(isTransientLlmError(new Error('plain'))).toBe(false)
    expect(isTransientLlmError(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Retry behavior through the public llmComplete path
// ---------------------------------------------------------------------------

describe('transient retry — llmComplete', () => {
  it('429 with Retry-After (delta) sleeps exactly that long, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeJsonResponse({}, 429, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(completionResponse('recovered'))
    vi.stubGlobal('fetch', fetchMock)

    const call = llmComplete({ system: 's', user: 'u' })
    // Prevent an unhandled-rejection blip if an assertion below throws first.
    call.catch(() => {})

    await flushMicrotasks()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // 1ms short of the Retry-After: still sleeping, no second fetch.
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await expect(call).resolves.toBe('recovered')
  })

  it('429 with Retry-After (http-date) sleeps until that date', async () => {
    vi.setSystemTime(new Date('2026-08-19T12:00:00.000Z'))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeJsonResponse({}, 429, { 'Retry-After': 'Wed, 19 Aug 2026 12:00:03 GMT' }),
      )
      .mockResolvedValueOnce(completionResponse('recovered'))
    vi.stubGlobal('fetch', fetchMock)

    const call = llmComplete({ system: 's', user: 'u' })
    call.catch(() => {})
    await flushMicrotasks()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await expect(call).resolves.toBe('recovered')
  })

  it('a huge Retry-After is capped at maxSleepMs (20s)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeJsonResponse({}, 429, { 'Retry-After': '600' }))
      .mockResolvedValueOnce(completionResponse('recovered'))
    vi.stubGlobal('fetch', fetchMock)

    const call = llmComplete({ system: 's', user: 'u' })
    call.catch(() => {})
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_POLICY.maxSleepMs - 1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await expect(call).resolves.toBe('recovered')
  })

  it('429 without Retry-After backs off with exponential full jitter (~1s/2s/4s ceilings)', async () => {
    // Full jitter: delay = random * ceiling. Pin random to 0.5 → 500/1000/2000.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const events: TransientRetryEvent[] = []
    setOnTransientRetry((ev) => events.push(ev))

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeJsonResponse({}, 429))
      .mockResolvedValueOnce(makeJsonResponse({}, 429))
      .mockResolvedValueOnce(makeJsonResponse({}, 429))
      .mockResolvedValueOnce(completionResponse('finally'))
    vi.stubGlobal('fetch', fetchMock)

    const call = llmComplete({ system: 's', user: 'u' })
    call.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(call).resolves.toBe('finally')

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(events.map((e) => e.delayMs)).toEqual([500, 1_000, 2_000])
    // Each delay is within the full-jitter bounds [0, base * 2^n].
    expect(events[0].delayMs).toBeLessThanOrEqual(1_000)
    expect(events[1].delayMs).toBeLessThanOrEqual(2_000)
    expect(events[2].delayMs).toBeLessThanOrEqual(4_000)
    expect(events.map((e) => e.attempt)).toEqual([1, 2, 3])
    expect(events.every((e) => e.providerId === 'deepseek')).toBe(true)
  })

  it('503 is retried and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeJsonResponse({}, 503))
      .mockResolvedValueOnce(completionResponse('back up'))
    vi.stubGlobal('fetch', fetchMock)

    const call = llmComplete({ system: 's', user: 'u' })
    call.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(call).resolves.toBe('back up')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('400 is NOT retried (single fetch)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeJsonResponse({ error: 'bad request' }, 400))
    vi.stubGlobal('fetch', fetchMock)
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({
      kind: 'server',
      status: 400,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('401 is NOT retried (single fetch)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeJsonResponse({}, 401))
    vi.stubGlobal('fetch', fetchMock)
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({
      kind: 'auth',
      status: 401,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('timeout is NOT retried (single fetch)', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({
      kind: 'timeout',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('exhaustion rethrows the LAST LlmError unchanged (kind/message/status)', async () => {
    // A fresh Response per attempt — a Response body is single-read, and
    // mapHttpError reads it on every attempt.
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        makeJsonResponse({ error: { message: 'slow down please' } }, 429, { 'Retry-After': '1' }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const call = llmComplete({ system: 's', user: 'u' })
    const expectation = expect(call).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'rate-limited',
      message: 'Rate limited (429): slow down please',
      status: 429,
      retryAfterMs: 1_000,
    })
    await vi.runAllTimersAsync()
    await expectation
    // 1 initial attempt + maxRetries retries.
    expect(fetchMock).toHaveBeenCalledTimes(1 + TRANSIENT_RETRY_POLICY.maxRetries)
  })

  it('increments the process-lifetime retry counter', async () => {
    const before = getTransientRetryCount()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeJsonResponse({}, 429, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(completionResponse('ok'))
    vi.stubGlobal('fetch', fetchMock)

    const call = llmComplete({ system: 's', user: 'u' })
    call.catch(() => {})
    await vi.runAllTimersAsync()
    await expect(call).resolves.toBe('ok')
    expect(getTransientRetryCount()).toBe(before + 1)
  })
})

// ---------------------------------------------------------------------------
// Slot release during backoff
// ---------------------------------------------------------------------------

describe('transient retry — gate interaction', () => {
  it('a backing-off call holds NO slot: other calls proceed during its sleep', async () => {
    // Saturate the provider: MAX_INFLIGHT calls all get a 429 with a long
    // Retry-After, putting all of them into backoff sleeps. If any of them
    // still held its slot, the (cap+1)th call could not reach fetch until the
    // sleeps ended. It can — proving sleep happens slot-free.
    let calls = 0
    const fetchMock = vi.fn(() => {
      calls++
      return Promise.resolve(
        calls <= MAX_INFLIGHT_LLM_CALLS
          ? makeJsonResponse({}, 429, { 'Retry-After': '10' })
          : completionResponse('through'),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const backingOff = Array.from({ length: MAX_INFLIGHT_LLM_CALLS }, () =>
      llmComplete({ system: 's', user: 'u' }),
    )
    for (const p of backingOff) p.catch(() => {})
    await flushMicrotasks()
    expect(fetchMock).toHaveBeenCalledTimes(MAX_INFLIGHT_LLM_CALLS)

    // All five are now sleeping 10s. A fresh call must get a slot IMMEDIATELY.
    const during = llmComplete({ system: 's', user: 'u' })
    await flushMicrotasks()
    expect(fetchMock).toHaveBeenCalledTimes(MAX_INFLIGHT_LLM_CALLS + 1)
    await expect(during).resolves.toBe('through')

    // Let the sleepers retry; their second attempts succeed.
    await vi.runAllTimersAsync()
    const results = await Promise.all(backingOff)
    expect(results).toEqual(Array(MAX_INFLIGHT_LLM_CALLS).fill('through'))
  })

  it('per-provider isolation: provider A saturated does not block provider B', async () => {
    // Park MAX_INFLIGHT deepseek completions on never-resolving fetches, then
    // run an anthropic verifier call (llmJsonWithRepairFor) — it must reach
    // fetch even though deepseek's gate is fully saturated.
    const parked: Array<Deferred<Response>> = []
    const fetchMock = vi.fn((url: RequestInfo | URL) => {
      const u = String(url)
      if (u.includes('anthropic')) {
        return Promise.resolve(
          makeJsonResponse({
            content: [{ type: 'text', text: '{"ok":true}' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        )
      }
      const d = deferred<Response>()
      parked.push(d)
      return d.promise
    })
    vi.stubGlobal('fetch', fetchMock)

    const deepseekCalls = Array.from({ length: MAX_INFLIGHT_LLM_CALLS }, () =>
      llmComplete({ system: 's', user: 'u' }),
    )
    for (const p of deepseekCalls) p.catch(() => {})
    await flushMicrotasks()
    expect(fetchMock).toHaveBeenCalledTimes(MAX_INFLIGHT_LLM_CALLS)
    expect(gateFor('deepseek').inFlight).toBe(MAX_INFLIGHT_LLM_CALLS)

    const anthropic = getProvider('anthropic')!
    const cfg: ProviderConfig = {
      providerId: 'anthropic',
      model: getModelDef(anthropic, anthropic.defaultModel) ?? anthropic.models[0],
      key: 'sk-ant-test',
    }
    const verifier = await llmJsonWithRepairFor(
      cfg,
      { system: 's', user: 'u' },
      (x) => (x && typeof x === 'object' ? (x as { ok: boolean }) : null),
    )
    expect(verifier.result).toEqual({ ok: true })

    // Unpark deepseek so the suite ends clean (a fresh Response per call —
    // a Response body is single-read).
    for (const d of parked) d.resolve(completionResponse('done'))
    await flushMicrotasks()
    await expect(Promise.all(deepseekCalls)).resolves.toEqual(
      Array(MAX_INFLIGHT_LLM_CALLS).fill('done'),
    )
  })
})

// ---------------------------------------------------------------------------
// withTransientRetry — direct unit tests
// ---------------------------------------------------------------------------

describe('withTransientRetry (unit)', () => {
  it('returns the first success without sleeping', async () => {
    const fn = vi.fn().mockResolvedValue(42)
    await expect(withTransientRetry(fn)).resolves.toBe(42)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('rethrows non-LlmError failures immediately', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('not an LlmError'))
    await expect(withTransientRetry(fn)).rejects.toThrow('not an LlmError')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('an abort during backoff stops retrying and rethrows the last error', async () => {
    const controller = new AbortController()
    const err = new LlmError('rate-limited', 'busy', { status: 429, retryAfterMs: 10_000 })
    const fn = vi.fn().mockRejectedValue(err)

    const call = withTransientRetry(fn, { signal: controller.signal })
    const expectation = expect(call).rejects.toBe(err)
    await flushMicrotasks()
    expect(fn).toHaveBeenCalledTimes(1)

    // Abort mid-sleep: no timer advance needed for the rejection to land.
    controller.abort()
    await expectation
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('honors a test policy override', async () => {
    setTransientRetryPolicyForTests({ maxRetries: 1, baseDelayMs: 1 })
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new LlmError('server', 'boom', { status: 500 }))
      .mockResolvedValueOnce('after one retry')
    const call = withTransientRetry(fn)
    await vi.runAllTimersAsync()
    await expect(call).resolves.toBe('after one retry')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
