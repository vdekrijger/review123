/**
 * abort.test.ts — abort/timeout classification + timeout composition.
 *
 * The bug this file pins (user report: "I'm getting a lot of 'the user aborted
 * the request, please click to try again'" — while aborting nothing):
 *
 *   1. mapFetchError had NO AbortError branch, so an aborted fetch fell through
 *      to `new LlmError('network', err.message)` and the BROWSER's literal text
 *      ("The user aborted a request." in Blink) was rendered verbatim as the
 *      panel's errorDetail, under a "Network error — check your connection"
 *      lead and next to a Retry button. Nobody aborted anything.
 *
 *   2. Blink reports a fetch/body-stream aborted by an `AbortSignal.timeout`
 *      signal as an AbortError in several paths (notably `reader.read()` on a
 *      signal-aborted response body) rather than the spec'd TimeoutError. So
 *      the classification must ask WHICH signal fired, not just read err.name.
 *
 *   3. `signal ?? AbortSignal.timeout(...)` meant a caller-supplied signal
 *      REPLACED the per-request timeout instead of composing with it — those
 *      calls had no timeout at all and could hang forever.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  llmComplete,
  llmStream,
  mapFetchError,
  anySignal,
  manualAnySignal,
  retryWithCancellation,
  LlmError,
  CANCELLED_MESSAGE,
} from './llm'
import { llmToolLoop, TOOL_LOOP_BASE_TIMEOUT_MS } from './llmToolLoop'
import { setTransientRetryPolicyForTests } from './transientRetry'
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

function completionBody(content: string) {
  return { choices: [{ message: { content } }] }
}

/** The exact DOMException Blink throws for `controller.abort()` with no reason. */
function blinkAbortError(): DOMException {
  return new DOMException('The user aborted a request.', 'AbortError')
}

/** An already-fired timeout signal, standing in for "our 60s window elapsed". */
function firedTimeoutSignal(): AbortSignal {
  const ctrl = new AbortController()
  ctrl.abort(new DOMException('signal timed out', 'TimeoutError'))
  return ctrl.signal
}

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
  setTransientRetryPolicyForTests({ maxRetries: 0 })
})

afterEach(() => {
  setTransientRetryPolicyForTests(null)
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// mapFetchError — classification
// ---------------------------------------------------------------------------

describe('mapFetchError — abort classification', () => {
  it("an AbortError is 'aborted', NOT 'network', and never echoes the browser's user-blaming text", () => {
    try {
      mapFetchError(blinkAbortError())
      expect.unreachable('mapFetchError must throw')
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError)
      expect((err as LlmError).kind).toBe('aborted')
      expect((err as LlmError).message).toBe(CANCELLED_MESSAGE)
      expect((err as LlmError).message).not.toMatch(/user aborted/i)
    }
  })

  it("an AbortError raised while OUR timeout signal has fired is 'timeout', not 'aborted'", () => {
    try {
      mapFetchError(blinkAbortError(), firedTimeoutSignal())
      expect.unreachable('mapFetchError must throw')
    } catch (err) {
      expect((err as LlmError).kind).toBe('timeout')
      expect((err as LlmError).message).not.toMatch(/user aborted/i)
    }
  })

  it("a TimeoutError stays 'timeout' (unchanged)", () => {
    try {
      mapFetchError(new DOMException('signal timed out', 'TimeoutError'))
      expect.unreachable('mapFetchError must throw')
    } catch (err) {
      expect((err as LlmError).kind).toBe('timeout')
    }
  })

  it("a plain network TypeError stays 'network' with its message (unchanged)", () => {
    try {
      mapFetchError(new TypeError('Failed to fetch'))
      expect.unreachable('mapFetchError must throw')
    } catch (err) {
      expect((err as LlmError).kind).toBe('network')
      expect((err as LlmError).message).toBe('Failed to fetch')
    }
  })

  it("a header-char TypeError stays 'auth' (unchanged)", () => {
    try {
      mapFetchError(new TypeError("Failed to execute 'fetch' on 'Window': Invalid value"))
      expect.unreachable('mapFetchError must throw')
    } catch (err) {
      expect((err as LlmError).kind).toBe('auth')
    }
  })

  it('an unfired timeout signal does NOT turn a real abort into a timeout', () => {
    const live = AbortSignal.timeout(60_000)
    try {
      mapFetchError(blinkAbortError(), live)
      expect.unreachable('mapFetchError must throw')
    } catch (err) {
      expect((err as LlmError).kind).toBe('aborted')
    }
  })
})

// ---------------------------------------------------------------------------
// End-to-end through the transports
// ---------------------------------------------------------------------------

describe('transports — an aborted request never blames the user', () => {
  beforeEach(() => setDeepseekKey('sk-test'))

  it('llmComplete: a rejected fetch with AbortError maps to kind "aborted"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(blinkAbortError()))
    await expect(llmComplete({ system: 's', user: 'u' })).rejects.toMatchObject({
      kind: 'aborted',
    })
  })

  it('llmComplete: the message carried out of the transport has no "user aborted" text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(blinkAbortError()))
    const err = await llmComplete({ system: 's', user: 'u' }).catch((e: unknown) => e)
    expect((err as LlmError).message).not.toMatch(/user aborted/i)
  })

  it('llmStream: a body-stream read aborted MID-STREAM maps to "aborted", not "network"', async () => {
    // The real-world shape: headers arrive, then the signal fires while the SSE
    // body is being read. reader.read() rejects with a DOMException, which used
    // to fall through mapFetchError into LlmError('network', <browser text>).
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
      },
      pull() {
        throw blinkAbortError()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))
    const err = await llmStream({ system: 's', user: 'u' }, () => {}).catch((e: unknown) => e)
    expect((err as LlmError).kind).toBe('aborted')
    expect((err as LlmError).message).not.toMatch(/user aborted/i)
  })
})

// ---------------------------------------------------------------------------
// Timeout composition — a caller signal must NOT disable the timeout
// ---------------------------------------------------------------------------

describe('timeout composition — caller signal + timeout, never one OR the other', () => {
  beforeEach(() => setDeepseekKey('sk-test'))

  it('an explicit signal still builds the adapter timeout', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(completionBody('ok'))))
    const ctrl = new AbortController()
    await llmComplete({ system: 's', user: 'u', timeoutMs: 120_000, signal: ctrl.signal })
    expect(spy).toHaveBeenCalledWith(120_000)
  })

  it('the composed signal aborts when the CALLER aborts', async () => {
    const f = vi.fn().mockResolvedValue(makeJsonResponse(completionBody('ok')))
    vi.stubGlobal('fetch', f)
    const ctrl = new AbortController()
    await llmComplete({ system: 's', user: 'u', signal: ctrl.signal })
    const passed = (f.mock.calls[0] as [string, RequestInit])[1].signal as AbortSignal
    expect(passed.aborted).toBe(false)
    ctrl.abort()
    expect(passed.aborted).toBe(true)
  })

  it('the composed signal aborts when the TIMEOUT fires', async () => {
    // A 0ms window fires on the next macrotask; the composed signal must follow.
    const fired = firedTimeoutSignal()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(fired)
    const f = vi.fn().mockResolvedValue(makeJsonResponse(completionBody('ok')))
    vi.stubGlobal('fetch', f)
    const ctrl = new AbortController()
    await llmComplete({ system: 's', user: 'u', signal: ctrl.signal })
    const passed = (f.mock.calls[0] as [string, RequestInit])[1].signal as AbortSignal
    expect(passed.aborted).toBe(true)
  })

  it('no caller signal → the timeout signal is passed straight through (unchanged)', async () => {
    const fired = AbortSignal.timeout(60_000)
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(fired)
    const f = vi.fn().mockResolvedValue(makeJsonResponse(completionBody('ok')))
    vi.stubGlobal('fetch', f)
    await llmComplete({ system: 's', user: 'u' })
    const passed = (f.mock.calls[0] as [string, RequestInit])[1].signal as AbortSignal
    expect(passed).toBe(fired)
  })
})

// ---------------------------------------------------------------------------
// anySignal — the combinator and its feature-detect fallback
// ---------------------------------------------------------------------------

describe('anySignal', () => {
  it('uses the native AbortSignal.any when available', () => {
    const spy = vi.spyOn(AbortSignal, 'any')
    const a = new AbortController()
    const b = new AbortController()
    anySignal([a.signal, b.signal])
    expect(spy).toHaveBeenCalled()
  })

  it('returns the single signal unchanged when there is only one', () => {
    const a = new AbortController()
    expect(anySignal([a.signal])).toBe(a.signal)
  })

  it('falls back to the manual combinator when AbortSignal.any is missing', () => {
    const original = AbortSignal.any
    try {
      // @ts-expect-error — simulating an engine without AbortSignal.any
      delete AbortSignal.any
      const a = new AbortController()
      const b = new AbortController()
      const combined = anySignal([a.signal, b.signal])
      expect(combined.aborted).toBe(false)
      b.abort()
      expect(combined.aborted).toBe(true)
    } finally {
      AbortSignal.any = original
    }
  })
})

describe('manualAnySignal — the fallback combinator', () => {
  it('aborts when the FIRST input aborts', () => {
    const a = new AbortController()
    const b = new AbortController()
    const combined = manualAnySignal([a.signal, b.signal])
    expect(combined.aborted).toBe(false)
    a.abort()
    expect(combined.aborted).toBe(true)
  })

  it('aborts when the SECOND input aborts', () => {
    const a = new AbortController()
    const b = new AbortController()
    const combined = manualAnySignal([a.signal, b.signal])
    b.abort()
    expect(combined.aborted).toBe(true)
  })

  it('is already aborted when an input was aborted BEFORE composition', () => {
    const a = new AbortController()
    a.abort()
    const b = new AbortController()
    expect(manualAnySignal([a.signal, b.signal]).aborted).toBe(true)
  })

  it("propagates the aborting signal's reason (so a timeout stays a TimeoutError)", () => {
    const a = new AbortController()
    const timeout = new AbortController()
    const combined = manualAnySignal([a.signal, timeout.signal])
    timeout.abort(new DOMException('signal timed out', 'TimeoutError'))
    expect((combined.reason as DOMException).name).toBe('TimeoutError')
  })

  it('propagates a pre-aborted reason too', () => {
    const timeout = new AbortController()
    timeout.abort(new DOMException('signal timed out', 'TimeoutError'))
    const combined = manualAnySignal([timeout.signal, new AbortController().signal])
    expect((combined.reason as DOMException).name).toBe('TimeoutError')
  })
})

// ---------------------------------------------------------------------------
// retryWithCancellation — an abort DURING backoff is a cancellation
//
// withTransientRetry itself rethrows the LAST error when the caller aborts
// mid-backoff (transientRetry.ts:164-166) — deliberately, so its own contract
// stays "surface the real failure". That last error is typically the 429/5xx
// that triggered the backoff, which would render as "rate limited" / "server
// error" for a request the caller deliberately gave up on. The dispatchers wrap
// it so the CALLER's abort wins the classification.
// ---------------------------------------------------------------------------

describe('retryWithCancellation', () => {
  it("maps an abort during backoff to 'aborted', not the last transient error", async () => {
    setTransientRetryPolicyForTests({ maxRetries: 3, baseDelayMs: 50, maxSleepMs: 50 })
    const ctrl = new AbortController()
    const transient = new LlmError('rate-limited', 'busy', { status: 429 })
    const fn = vi.fn().mockRejectedValue(transient)

    const call = retryWithCancellation(fn, { providerId: 'deepseek', signal: ctrl.signal })
    const settled = call.catch((e: unknown) => e)
    await Promise.resolve()
    ctrl.abort()

    const err = await settled
    expect((err as LlmError).kind).toBe('aborted')
    expect((err as LlmError).message).toBe(CANCELLED_MESSAGE)
  })

  it('leaves a genuine failure untouched when the caller never aborted', async () => {
    const boom = new LlmError('server', 'upstream exploded', { status: 502 })
    const err = await retryWithCancellation(vi.fn().mockRejectedValue(boom), {
      providerId: 'deepseek',
    }).catch((e: unknown) => e)
    expect(err).toBe(boom)
  })

  it('passes successful results straight through', async () => {
    await expect(
      retryWithCancellation(async () => 'ok', { providerId: 'deepseek' }),
    ).resolves.toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// REPRO (fix/context-abort-errors): the NON-STREAMING response-body read.
//
// #233 wrapped the SSE `reader.read()` loop (llmStream) so a mid-stream abort
// classifies. It did NOT wrap the non-streaming `await res.json()` that every
// JSON adapter — and llmToolLoop's per-round postJson — performs AFTER the
// fetch() try/catch has already closed. Blink reports a body read torn down by
// an AbortSignal as a plain AbortError DOMException ("The user aborted a
// request."), so that DOMException escapes the transport UNMAPPED: it is not an
// LlmError, describeTaskError classifies it as kind 'unknown', and its raw
// engine text lands in PanelState.errorDetail — rendered verbatim in the
// reviewer chip's hover ("… — The user aborted a request. — click to retry").
// ---------------------------------------------------------------------------

/** A 200 response whose BODY read rejects the way Blink's does when aborted. */
function abortingBodyResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    pull() {
      throw blinkAbortError()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('non-streaming body read — an abort during res.json() must classify', () => {
  beforeEach(() => setDeepseekKey('sk-test'))

  it('llmComplete: an abort while the JSON body is read maps to an LlmError, not a raw DOMException', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(abortingBodyResponse()))
    const err = await llmComplete({ system: 's', user: 'u' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('aborted')
    expect((err as Error).message).not.toMatch(/user aborted/i)
  })

  it("llmComplete: our own window having fired makes it a 'timeout', not a cancellation", async () => {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(firedTimeoutSignal())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(abortingBodyResponse()))
    const err = await llmComplete({ system: 's', user: 'u' }).catch((e: unknown) => e)
    expect((err as LlmError).kind).toBe('timeout')
  })
})

// ---------------------------------------------------------------------------
// llmToolLoop — THE reported path. Deep review (#82) and grounded verification
// (#229) run every skill reviewer through this loop, and its per-round
// postJson() had the same "fetch inside the try, body read outside it" shape.
// The user's failing reviewers were the biggest ones: the largest responses
// take the longest to READ, so theirs were the body reads still in flight when
// the round window expired.
// ---------------------------------------------------------------------------

describe('llmToolLoop — the deep-review round is the path the reviewers take', () => {
  beforeEach(() => setDeepseekKey('sk-test'))

  it("an abort while a ROUND's JSON body is read maps to an LlmError, not a raw DOMException", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(abortingBodyResponse()))
    const err = await llmToolLoop({
      system: 's',
      user: 'u',
      tools: [],
      executeTool: async () => ({ ok: true, content: '' }),
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('aborted')
    expect((err as Error).message).not.toMatch(/user aborted/i)
  })

  it("a round torn down by OUR window is a 'timeout', not a cancellation", async () => {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(firedTimeoutSignal())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(abortingBodyResponse()))
    const err = await llmToolLoop({
      system: 's',
      user: 'u',
      tools: [],
      executeTool: async () => ({ ok: true, content: '' }),
    }).catch((e: unknown) => e)
    expect((err as LlmError).kind).toBe('timeout')
  })

  it('the per-round window SCALES with the prompt size instead of a flat 60s', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeJsonResponse({ choices: [{ message: { content: 'done' } }] })),
    )
    // ~150k characters is roughly 37k estimated tokens — past the large-prompt line.
    await llmToolLoop({
      system: 's',
      user: 'x'.repeat(150_000),
      tools: [],
      executeTool: async () => ({ ok: true, content: '' }),
    })
    const windows = spy.mock.calls.map((c) => c[0] as number)
    expect(Math.max(...windows)).toBeGreaterThan(TOOL_LOOP_BASE_TIMEOUT_MS)
  })
})
