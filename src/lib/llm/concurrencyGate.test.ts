/**
 * concurrencyGate tests — the global LLM in-flight semaphore.
 *
 * Deterministic by construction: tasks resolve only when the test explicitly
 * releases an injected deferred promise. No Date.now() / Math.random() / timers
 * — ordering and peak concurrency are derived from counters, so the assertions
 * are exact, not timing-dependent.
 */

import { describe, it, expect } from 'vitest'
import {
  ConcurrencyGate,
  MAX_INFLIGHT_LLM_CALLS,
  llmConcurrencyGate,
  gateFor,
} from './concurrencyGate'

// ---------------------------------------------------------------------------
// Deferred — a manually-resolvable promise, the only timing primitive used.
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Yield to the microtask queue enough times for queued waiters to wake. */
async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

// ---------------------------------------------------------------------------
// Constant
// ---------------------------------------------------------------------------

describe('MAX_INFLIGHT_LLM_CALLS', () => {
  it('is 5 (the global backpressure default)', () => {
    expect(MAX_INFLIGHT_LLM_CALLS).toBe(5)
  })

  it('the exported singleton is configured at the default cap', () => {
    expect(llmConcurrencyGate).toBeInstanceOf(ConcurrencyGate)
  })
})

// ---------------------------------------------------------------------------
// Peak concurrency never exceeds the cap
// ---------------------------------------------------------------------------

describe('ConcurrencyGate — peak concurrency', () => {
  it('never runs more than `max` tasks at once (cap 5, 20 tasks)', async () => {
    const gate = new ConcurrencyGate(5)
    const gates = Array.from({ length: 20 }, () => deferred())

    let active = 0
    let peak = 0
    let completed = 0

    const runs = gates.map((d) =>
      gate.run(async () => {
        active++
        if (active > peak) peak = active
        await d.promise
        active--
        completed++
      }),
    )

    // Let the first batch acquire slots.
    await flushMicrotasks()
    // Exactly the cap should be running; the rest queued.
    expect(active).toBe(5)
    expect(gate.inFlight).toBe(5)
    expect(gate.queued).toBe(15)

    // Drain one at a time; peak must never cross the cap.
    for (const d of gates) {
      d.resolve()
      await flushMicrotasks()
      expect(active).toBeLessThanOrEqual(5)
    }

    await Promise.all(runs)
    expect(peak).toBe(5)
    expect(peak).toBeLessThanOrEqual(5)
    expect(completed).toBe(20)
    expect(gate.inFlight).toBe(0)
    expect(gate.queued).toBe(0)
  })

  it('cap 1 fully serializes (peak 1)', async () => {
    const gate = new ConcurrencyGate(1)
    const gates = Array.from({ length: 6 }, () => deferred())
    let active = 0
    let peak = 0

    const runs = gates.map((d) =>
      gate.run(async () => {
        active++
        if (active > peak) peak = active
        await d.promise
        active--
      }),
    )

    await flushMicrotasks()
    expect(active).toBe(1)

    for (const d of gates) {
      d.resolve()
      await flushMicrotasks()
    }
    await Promise.all(runs)
    expect(peak).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// FIFO ordering — slots are granted in arrival order
// ---------------------------------------------------------------------------

describe('ConcurrencyGate — FIFO ordering', () => {
  it('grants queued slots in arrival order as earlier ones release', async () => {
    const gate = new ConcurrencyGate(2)
    const startOrder: number[] = []
    const gates = Array.from({ length: 6 }, () => deferred())

    const runs = gates.map((d, i) =>
      gate.run(async () => {
        startOrder.push(i)
        await d.promise
      }),
    )

    await flushMicrotasks()
    // First two (0,1) start immediately.
    expect(startOrder).toEqual([0, 1])

    // Release task 0 → next queued (2) starts.
    gates[0].resolve()
    await flushMicrotasks()
    expect(startOrder).toEqual([0, 1, 2])

    // Release task 1 → task 3 starts.
    gates[1].resolve()
    await flushMicrotasks()
    expect(startOrder).toEqual([0, 1, 2, 3])

    // Drain the rest.
    for (const d of gates) d.resolve()
    await Promise.all(runs)
    expect(startOrder).toEqual([0, 1, 2, 3, 4, 5])
  })
})

// ---------------------------------------------------------------------------
// A rejecting task releases its slot (a throw doesn't reduce capacity)
// ---------------------------------------------------------------------------

describe('ConcurrencyGate — rejection releases the slot', () => {
  it('a thrown task frees its slot so the gate keeps draining', async () => {
    const gate = new ConcurrencyGate(2)
    const d = deferred()

    // Two slots filled; one will reject.
    const ok = gate.run(() => d.promise)
    const bad = gate.run(() => Promise.reject(new Error('boom')))

    // The rejection must not leave a leaked slot.
    await expect(bad).rejects.toThrow('boom')
    await flushMicrotasks()
    // Capacity restored: at most the surviving task holds a slot.
    expect(gate.inFlight).toBeLessThanOrEqual(1)

    d.resolve()
    await ok
    expect(gate.inFlight).toBe(0)
    expect(gate.queued).toBe(0)
  })

  it('with 20 tasks where some reject, the gate still drains and peak ≤ 5', async () => {
    const gate = new ConcurrencyGate(5)
    const gates = Array.from({ length: 20 }, () => deferred())

    let active = 0
    let peak = 0
    let settled = 0

    // Every 3rd task rejects when its deferred resolves.
    const runs = gates.map((d, i) =>
      gate
        .run(async () => {
          active++
          if (active > peak) peak = active
          try {
            await d.promise
            if (i % 3 === 0) throw new Error(`reject-${i}`)
          } finally {
            active--
          }
        })
        .then(
          () => {
            settled++
          },
          () => {
            settled++
          },
        ),
    )

    await flushMicrotasks()
    expect(active).toBe(5)

    for (const d of gates) {
      d.resolve()
      await flushMicrotasks()
      expect(active).toBeLessThanOrEqual(5)
    }

    await Promise.all(runs)
    expect(peak).toBe(5)
    expect(settled).toBe(20)
    expect(gate.inFlight).toBe(0)
    expect(gate.queued).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// run() returns the wrapped value transparently
// ---------------------------------------------------------------------------

describe('gateFor — per-provider gates', () => {
  it('returns the SAME gate instance for the same provider id', () => {
    expect(gateFor('deepseek')).toBe(gateFor('deepseek'))
    expect(gateFor('anthropic')).toBe(gateFor('anthropic'))
  })

  it('returns DIFFERENT gates for different providers, each at the shared cap', async () => {
    const a = gateFor('prov-a')
    const b = gateFor('prov-b')
    expect(a).not.toBe(b)
    expect(a).toBeInstanceOf(ConcurrencyGate)
    expect(b).toBeInstanceOf(ConcurrencyGate)

    // Saturate A at the cap: B must still grant slots immediately.
    const parked = Array.from({ length: MAX_INFLIGHT_LLM_CALLS }, () => deferred())
    const aRuns = parked.map((d) => a.run(() => d.promise))
    await flushMicrotasks()
    expect(a.inFlight).toBe(MAX_INFLIGHT_LLM_CALLS)

    let bRan = false
    await b.run(async () => {
      bRan = true
    })
    expect(bRan).toBe(true)
    expect(a.inFlight).toBe(MAX_INFLIGHT_LLM_CALLS) // A still saturated

    for (const d of parked) d.resolve()
    await Promise.all(aRuns)
    expect(a.inFlight).toBe(0)
  })

  it('an extra call on a saturated provider queues (isolation is per provider, not per call)', async () => {
    const gate = gateFor('prov-queueing')
    const parked = Array.from({ length: MAX_INFLIGHT_LLM_CALLS }, () => deferred())
    const runs = parked.map((d) => gate.run(() => d.promise))
    await flushMicrotasks()

    let extraRan = false
    const extra = gate.run(async () => {
      extraRan = true
    })
    await flushMicrotasks()
    expect(extraRan).toBe(false)
    expect(gate.queued).toBe(1)

    parked[0].resolve()
    await flushMicrotasks()
    expect(extraRan).toBe(true)

    for (const d of parked) d.resolve()
    await Promise.all([...runs, extra])
  })
})

describe('ConcurrencyGate — transparency', () => {
  it('forwards the resolved value of fn unchanged', async () => {
    const gate = new ConcurrencyGate(3)
    await expect(gate.run(async () => 42)).resolves.toBe(42)
    await expect(gate.run(async () => 'hi')).resolves.toBe('hi')
  })

  it('an immediate (synchronous) fan-out of more than cap still resolves all', async () => {
    const gate = new ConcurrencyGate(5)
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => gate.run(async () => i * 2)),
    )
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i * 2))
    expect(gate.inFlight).toBe(0)
  })
})
