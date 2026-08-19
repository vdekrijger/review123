/**
 * transientRetry — transport-level retry for TRANSIENT LLM failures.
 *
 * WHY: HTTP 429 (rate limit) and transient 5xx from providers used to be
 * TERMINAL — thrown as LlmError with no retry, no backoff, no Retry-After
 * honoring — while a single review fans out into ~49–97 LLM calls. One burst
 * over a provider's limit failed real work. This module turns transient
 * overload into latency instead of failure.
 *
 * WHAT retries: `kind === 'rate-limited'` (HTTP 429) OR an LlmError carrying
 * `status >= 500` (transient upstream 5xx). NOTHING else: other 4xx (auth,
 * invalid request), timeouts, aborts, network drops, and invalid-output are
 * rethrown untouched — retrying those wastes budget or hides real bugs.
 *
 * HOW it sleeps: the provider's `Retry-After` (parsed into
 * `LlmError.retryAfterMs` by mapHttpError) wins when present; otherwise
 * exponential backoff with FULL jitter — a uniform random delay in
 * [0, min(baseDelayMs * 2^attempt, maxSleepMs)], i.e. ceilings of ~1s, 2s, 4s
 * for the default 3 retries. Every single sleep is capped at maxSleepMs (20s).
 *
 * CRITICAL invariant: callers wrap `gateFor(provider).run(...)` INSIDE the
 * retry (retry OUTSIDE the gate), so a sleeping call holds NO concurrency
 * slot — backoff never starves other traffic of gate capacity.
 *
 * Dependency-free: no imports (the transient check is structural, matching the
 * LlmError shape, to keep this module free of import cycles with llm.ts).
 */

export interface TransientRetryPolicy {
  /** Retries AFTER the first attempt (total attempts = maxRetries + 1). */
  maxRetries: number
  /** First backoff ceiling; doubles each retry (1s → 2s → 4s). */
  baseDelayMs: number
  /** Hard cap on any single sleep — applies to Retry-After too. */
  maxSleepMs: number
}

/** The production policy: up to 3 retries, ~1s/2s/4s full-jitter, 20s cap. */
export const TRANSIENT_RETRY_POLICY: Readonly<TransientRetryPolicy> = Object.freeze({
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxSleepMs: 20_000,
})

let policyOverrides: Partial<TransientRetryPolicy> | null = null

/**
 * TEST-ONLY seam: override parts of the policy (e.g. `{ maxRetries: 0 }` so a
 * suite about error MAPPING isn't slowed by real backoff sleeps). Pass null to
 * restore the production policy. Never call from production code.
 */
export function setTransientRetryPolicyForTests(
  overrides: Partial<TransientRetryPolicy> | null,
): void {
  policyOverrides = overrides
}

// ---------------------------------------------------------------------------
// Telemetry hook — lightweight, dependency-free (Deliverable: a later PR can
// surface retry counts in tooltips/analytics without touching this layer).
// ---------------------------------------------------------------------------

export interface TransientRetryEvent {
  /** Provider whose call is being retried (when known at the call site). */
  providerId?: string
  /** 1-based retry number (1 = first retry after the initial attempt). */
  attempt: number
  /** How long this backoff sleeps before the next attempt. */
  delayMs: number
  /** The transient error that triggered the retry. */
  error: unknown
}

type TransientRetryListener = (ev: TransientRetryEvent) => void

let retryListener: TransientRetryListener | null = null
let retryCount = 0

/** Register (or clear, with null) a listener fired once per retry sleep. */
export function setOnTransientRetry(listener: TransientRetryListener | null): void {
  retryListener = listener
}

/** Process-lifetime count of transient retries performed. */
export function getTransientRetryCount(): number {
  return retryCount
}

// ---------------------------------------------------------------------------
// Transient classification
// ---------------------------------------------------------------------------

/**
 * Structural check for "worth retrying": an LlmError-shaped object whose
 * kind is 'rate-limited', or which carries an HTTP status >= 500 (populated
 * by mapHttpError/mapHttpStatus). Plain network errors, timeouts, aborts,
 * auth/4xx and invalid-output all return false.
 */
export function isTransientLlmError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { kind?: unknown; status?: unknown }
  if (typeof e.kind !== 'string') return false
  if (e.kind === 'rate-limited') return true
  return typeof e.status === 'number' && e.status >= 500
}

// ---------------------------------------------------------------------------
// The wrapper
// ---------------------------------------------------------------------------

/**
 * Abort-aware sleep. Resolves 'slept' after ms, or 'aborted' immediately if
 * the signal fires (or was already aborted) — never rejects.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<'slept' | 'aborted'> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('aborted')
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve('aborted')
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve('slept')
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Run `fn`, retrying TRANSIENT failures per TRANSIENT_RETRY_POLICY.
 *
 * `fn` must be re-invokable (each attempt is a fresh call — the transport
 * adapters build a fresh request + fresh 60s AbortSignal.timeout per call).
 * Callers put the concurrency gate INSIDE `fn` so backoff sleeps hold no slot.
 *
 * After exhaustion (or a non-transient error, or an abort during backoff) the
 * LAST error is rethrown unchanged — kind/message/status/retryAfterMs intact.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  info: { providerId?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const policy: TransientRetryPolicy = { ...TRANSIENT_RETRY_POLICY, ...policyOverrides }
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= policy.maxRetries || !isTransientLlmError(err)) throw err

      const retryAfterMs = (err as { retryAfterMs?: unknown }).retryAfterMs
      const jitterCeiling = Math.min(policy.maxSleepMs, policy.baseDelayMs * 2 ** attempt)
      const delayMs =
        typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
          ? Math.min(retryAfterMs, policy.maxSleepMs)
          : Math.round(Math.random() * jitterCeiling) // full jitter: uniform [0, ceiling]

      retryCount++
      retryListener?.({ providerId: info.providerId, attempt: attempt + 1, delayMs, error: err })

      const outcome = await sleep(delayMs, info.signal)
      // Caller aborted mid-backoff: stop retrying, surface the last real error.
      if (outcome === 'aborted') throw err
    }
  }
}
