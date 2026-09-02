/**
 * net/signals.ts — abort-signal composition and fetch-failure classification,
 * shared by EVERY fetching layer (the LLM transports and the three VCS API
 * clients).
 *
 * It lives here rather than in llm/llm.ts because the same two bugs existed on
 * both sides of the codebase and one fix has to serve both:
 *
 *   1. `init.signal ?? AbortSignal.timeout(...)` — a caller-supplied signal
 *      REPLACED the request timeout, so any call that passed one had no timeout
 *      at all and could hang forever. #233 fixed this in the LLM adapters;
 *      ghFetch / glFetch / bbFetch still had it.
 *   2. `catch { throw ...{ kind: 'network' } }` — an aborted or timed-out fetch
 *      was reported as a connectivity problem ("Check your connection"), which
 *      is simply untrue and gives the user nothing to act on.
 *
 * llm/llm.ts re-exports anySignal / manualAnySignal so its own public surface
 * is unchanged.
 */

/**
 * Combine abort signals WITHOUT `AbortSignal.any` — the feature-detect
 * fallback. Propagates the winning signal's `reason` so a timeout stays a
 * TimeoutError (which is what lets the classifiers tell a timeout from a
 * cancellation).
 */
export function manualAnySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  const already = signals.find((s) => s.aborted)
  if (already) {
    controller.abort(already.reason)
    return controller.signal
  }
  for (const s of signals) {
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true })
  }
  return controller.signal
}

/**
 * One signal that fires when ANY of `signals` fires. Uses the native
 * `AbortSignal.any` where available (widely supported) and falls back to
 * manualAnySignal otherwise.
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1) return signals[0]!
  const native = (AbortSignal as { any?: (list: AbortSignal[]) => AbortSignal }).any
  if (typeof native === 'function') return native.call(AbortSignal, signals)
  return manualAnySignal(signals)
}

/**
 * The per-request cancellation pair: our timeout signal (kept separately so the
 * classifier can ask whether IT fired) and the signal actually handed to fetch
 * — the caller's signal COMPOSED with the timeout, never one instead of the
 * other.
 */
export function requestSignals(
  callerSignal: AbortSignal | undefined | null,
  timeoutMs: number,
): { timeoutSignal: AbortSignal; effectiveSignal: AbortSignal } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return {
    timeoutSignal,
    effectiveSignal: callerSignal ? anySignal([callerSignal, timeoutSignal]) : timeoutSignal,
  }
}

/** True for the DOMException an aborted fetch / body-stream read rejects with. */
export function isAbortException(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === 'AbortError'
  // Not every environment routes abort rejections through a real DOMException
  // (test doubles, some polyfills) — the `name` discriminant is the contract.
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
}

/** True for the DOMException an `AbortSignal.timeout` firing rejects with, per spec. */
export function isTimeoutException(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === 'TimeoutError'
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'TimeoutError'
}

/**
 * What actually went wrong with a failed fetch (or a failed read of its body).
 *
 * `timeoutSignal` is OUR window for the call that threw. It matters because
 * engines are inconsistent: the spec says a fetch aborted by an
 * `AbortSignal.timeout` rejects with the signal's reason (a TimeoutError), but
 * Blink reports several paths — most importantly any read of a signal-aborted
 * response body — as a plain AbortError. Reading `err.name` alone would
 * therefore call a genuine timeout a cancellation. So when an AbortError
 * arrives and our own window has fired, the timeout wins.
 */
export function classifyFetchFailure(
  err: unknown,
  timeoutSignal?: AbortSignal,
): 'timeout' | 'cancelled' | 'network' {
  if (isTimeoutException(err)) return 'timeout'
  if (isAbortException(err)) return timeoutSignal?.aborted ? 'timeout' : 'cancelled'
  return 'network'
}

// ---------------------------------------------------------------------------
// User-visible copy for the two new kinds — ONE source, so GitHub, GitLab and
// Bitbucket all say the same honest thing.
// ---------------------------------------------------------------------------

/**
 * Names the host, the window it blew, and the one thing worth doing. Not
 * "check your connection": the connection was fine, the host was slow.
 */
export function apiTimeoutMessage(host: string, afterMs: number): string {
  return `${host} didn't respond within ${Math.round(afterMs / 1000)}s. It may be under load — try again in a moment.`
}

/**
 * A cancellation is not a failure. Deliberately says nothing about the USER
 * aborting anything: the reported bug was the browser's own "The user aborted a
 * request." being shown to someone who cancelled nothing.
 */
export const REQUEST_CANCELLED_MESSAGE = 'The request was cancelled before it finished.'
