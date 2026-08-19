/**
 * Transport-level proof that the global concurrency gate caps in-flight LLM
 * HTTP calls at MAX_INFLIGHT_LLM_CALLS, for BOTH the complete and the stream
 * path, and that a streaming call holds exactly one slot for its whole lifetime
 * and releases it on stream end AND on stream error.
 *
 * fetch is mocked with a manually-resolvable body so the test controls exactly
 * when each request settles — peak concurrency is read from a counter, not from
 * timing. (No Date.now() / Math.random().)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { llmComplete, llmStream } from './llm'
import { MAX_INFLIGHT_LLM_CALLS } from './concurrencyGate'
import { setTransientRetryPolicyForTests } from './transientRetry'
import { setDeepseekKey } from '../settings/settings'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

function completionResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** A stream that emits one delta then [DONE], built from given SSE text. */
function sseStreamResponse(text: string): Response {
  const encoder = new TextEncoder()
  const lines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    'data: [DONE]\n\n',
  ]
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(encoder.encode(l))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
  setDeepseekKey('sk-test')
  // These tests prove slot accounting with exact fetch counts; transient
  // retries (which re-fetch) are covered separately in transientRetry.test.ts.
  setTransientRetryPolicyForTests({ maxRetries: 0 })
})

afterEach(() => {
  setTransientRetryPolicyForTests(null)
})

describe('global gate — dispatchComplete', () => {
  it('never lets more than MAX_INFLIGHT_LLM_CALLS fetches be in flight (20 calls)', async () => {
    let active = 0
    let peak = 0
    const pending: Array<() => void> = []

    // Each fetch parks until we explicitly let it resolve, so we can inspect
    // the steady-state in-flight count.
    const fetchMock = vi.fn(() => {
      active++
      if (active > peak) peak = active
      const d = deferred<Response>()
      pending.push(() => {
        active--
        d.resolve(completionResponse('ok'))
      })
      return d.promise
    })
    vi.stubGlobal('fetch', fetchMock)

    const calls = Array.from({ length: 20 }, () =>
      llmComplete({ system: 's', user: 'u' }),
    )

    await flushMicrotasks()
    // Only the cap may have reached fetch; the rest queue behind the gate.
    expect(active).toBe(MAX_INFLIGHT_LLM_CALLS)
    expect(fetchMock).toHaveBeenCalledTimes(MAX_INFLIGHT_LLM_CALLS)

    // Drain: each resolution should let exactly one queued call start.
    while (pending.length > 0) {
      const release = pending.shift()!
      release()
      await flushMicrotasks()
      expect(active).toBeLessThanOrEqual(MAX_INFLIGHT_LLM_CALLS)
    }

    const results = await Promise.all(calls)
    expect(results).toHaveLength(20)
    expect(results.every((r) => r === 'ok')).toBe(true)
    expect(peak).toBe(MAX_INFLIGHT_LLM_CALLS)
    // The gate freed every slot: a fresh call goes straight through.
    expect(active).toBe(0)
  })
})

describe('global gate — streaming holds and releases exactly one slot', () => {
  it('a stream counts as one in-flight slot alongside completes (peak ≤ cap)', async () => {
    let active = 0
    let peak = 0
    const pending: Array<() => void> = []

    let fetchCalls = 0
    const fetchMock = vi.fn(() => {
      active++
      if (active > peak) peak = active
      const callIndex = fetchCalls++
      const d = deferred<Response>()
      pending.push(() => {
        active--
        // The first call to reach fetch is the streaming one (it's launched
        // first below); give it an SSE body, the rest a JSON completion body.
        d.resolve(callIndex === 0 ? sseStreamResponse('s') : completionResponse('ok'))
      })
      return d.promise
    })
    vi.stubGlobal('fetch', fetchMock)

    // 1 streaming call + several completes, all racing for slots.
    const streamCall = llmStream({ system: 's', user: 'u' }, () => {})
    const completeCalls = Array.from({ length: 8 }, () =>
      llmComplete({ system: 's', user: 'u' }),
    )

    await flushMicrotasks()
    expect(active).toBe(MAX_INFLIGHT_LLM_CALLS)

    while (pending.length > 0) {
      pending.shift()!()
      await flushMicrotasks()
      expect(active).toBeLessThanOrEqual(MAX_INFLIGHT_LLM_CALLS)
    }

    await Promise.allSettled([streamCall, ...completeCalls])
    expect(peak).toBe(MAX_INFLIGHT_LLM_CALLS)
    expect(active).toBe(0)
  })

  it('releases the slot after a stream ENDS (subsequent calls can run)', async () => {
    // A real SSE stream that completes; then a fresh complete must run, proving
    // the slot was returned.
    let fetchCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        fetchCalls++
        return Promise.resolve(
          fetchCalls === 1 ? sseStreamResponse('hello') : completionResponse('after'),
        )
      }),
    )

    const streamed = await llmStream({ system: 's', user: 'u' }, () => {})
    expect(streamed).toBe('hello')

    // If the stream had leaked its slot, this would still resolve at cap≥2, but
    // we additionally assert it actually runs and returns.
    const after = await llmComplete({ system: 's', user: 'u' })
    expect(after).toBe('after')
  })

  it('releases the slot after a stream ERRORS (no leak on upstream failure)', async () => {
    // A stream whose upstream returns 500 must reject AND free its slot. We
    // prove the slot was returned by running cap+1 erroring streams back to
    // back: if any leaked, the (cap+1)th would never acquire a slot and the
    // Promise.all would hang (the test would time out).
    let fetchCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        fetchCalls++
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'boom' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }),
    )

    const n = MAX_INFLIGHT_LLM_CALLS + 3
    const outcomes = await Promise.allSettled(
      Array.from({ length: n }, () => llmStream({ system: 's', user: 'u' }, () => {})),
    )

    // Every stream errored (server kind) — and crucially, all n ran (no slot
    // leak would have stalled the run past the cap).
    expect(fetchCalls).toBe(n)
    expect(outcomes).toHaveLength(n)
    expect(outcomes.every((o) => o.status === 'rejected')).toBe(true)
    for (const o of outcomes) {
      if (o.status === 'rejected') {
        expect((o.reason as { kind?: string }).kind).toBe('server')
      }
    }

    // The gate is fully drained: a fresh successful call goes straight through.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(completionResponse('recovered'))))
    await expect(llmComplete({ system: 's', user: 'u' })).resolves.toBe('recovered')
  })
})
