/**
 * concurrencyGate — a global, transport-level backpressure semaphore.
 *
 * WHY: A single review fans out into dozens of concurrent LLM HTTP calls —
 * the task calls (summary, attention, diagrams, tests, alternatives, verdict,
 * story), N reviewer calls, per-finding cross-model verification calls (often
 * across multiple providers), and deep-mode tool-loop rounds. There IS a
 * per-reviewer cap (REVIEWER_CONCURRENCY in coachBatch.ts) and per-task deep
 * budgets, but NO single cap across ALL of those layers. On big PRs they fire
 * together and trip provider rate limits, failing the review.
 *
 * This module provides PER-PROVIDER async semaphores that EVERY real LLM HTTP
 * request funnels through (wired into dispatchComplete / dispatchStream /
 * dispatchCompleteFor in llm.ts and postJson in llmToolLoop.ts — the
 * chokepoints all calls pass through). No matter how many tasks / reviewers /
 * verifiers / tool-loops run, at most MAX_INFLIGHT_LLM_CALLS requests are in
 * flight at once PER PROVIDER; the rest queue FIFO and start as slots free.
 * Per-provider (not one global gate) because the fan-out is provider-blind:
 * with a single global gate all 5 slots could dogpile ONE provider while the
 * others sat idle. It sits UNDERNEATH the existing reviewer queue — both
 * coexist (the reviewer queue still bounds reviewer fan-out; this bounds the
 * actual wire traffic per provider).
 *
 * IMPORTANT: gates are module-level and cached in a Map keyed by provider id,
 * so they are shared across ALL callers/tasks/reviewers — NOT per-task gates.
 * `gateFor(id)` anywhere returns the same instance for the same provider.
 *
 * The implementation is dependency-free and deterministic: a counter of active
 * slots plus a FIFO queue of waiters. No Date.now()/Math.random()/timers.
 */

/**
 * Backpressure knob: the maximum number of LLM HTTP requests allowed in
 * flight at once PER PROVIDER. Tuned low (5) so a big-PR fan-out can't
 * trip provider rate limits. A single named constant — no settings UI.
 *
 * (This was originally one global cap; it is now per-provider via gateFor()
 * so one saturated/slow provider can't starve the others — cross-model
 * verifier calls to provider B proceed while provider A is dogpiled.)
 */
export const MAX_INFLIGHT_LLM_CALLS = 5

/**
 * A FIFO counting semaphore. `run(fn)` acquires a slot, awaits `fn()`, and
 * releases the slot in a `finally` — so a REJECTING `fn` still frees its slot
 * (a throw never reduces capacity). Calls past the cap queue and start in
 * arrival order as slots free.
 */
export class ConcurrencyGate {
  private active = 0
  /** FIFO queue of resolvers; each resolves when a slot is granted. */
  private readonly waiters: Array<() => void> = []

  constructor(private readonly max: number) {}

  /** Slots currently held (running). Exposed for tests/observability. */
  get inFlight(): number {
    return this.active
  }

  /** Callers parked waiting for a slot. Exposed for tests/observability. */
  get queued(): number {
    return this.waiters.length
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active++
        resolve()
      })
    })
  }

  private release(): void {
    this.active--
    // Wake the oldest waiter (FIFO). It re-increments `active` itself so the
    // count never dips below the work actually about to run.
    const next = this.waiters.shift()
    if (next) next()
  }

  /**
   * Run `fn` under the gate: acquire a slot, await the result, release the slot
   * on success OR error. The slot is held for the ENTIRE duration of the
   * returned promise — for a streaming call whose promise resolves only after
   * the stream is fully consumed (or rejects on error/abort), that means the
   * slot is held for the whole stream lifetime and released exactly once.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

// ---------------------------------------------------------------------------
// Per-provider gates
// ---------------------------------------------------------------------------

/** One lazily-created gate per provider id, each capped at the shared knob. */
const providerGates = new Map<string, ConcurrencyGate>()

/**
 * The per-provider gate accessor — the production chokepoint. Every real LLM
 * HTTP request runs under `gateFor(provider.id).run(...)` (wired in llm.ts
 * dispatchers + llmToolLoop's postJson). Gates are created lazily and cached
 * for the process lifetime, so all callers hitting the same provider share
 * ONE gate; different providers are isolated (A saturated ≠ B blocked).
 */
export function gateFor(providerId: string): ConcurrencyGate {
  let gate = providerGates.get(providerId)
  if (!gate) {
    gate = new ConcurrencyGate(MAX_INFLIGHT_LLM_CALLS)
    providerGates.set(providerId, gate)
  }
  return gate
}

/**
 * LEGACY back-compat export: the former global singleton. Production traffic
 * now routes through `gateFor(providerId)` (per-provider); this instance is
 * kept only so existing imports keep compiling/behaving. Do not wire new
 * traffic through it.
 */
export const llmConcurrencyGate = new ConcurrencyGate(MAX_INFLIGHT_LLM_CALLS)
