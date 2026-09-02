/**
 * requestWindow.ts — how long ONE request to a model is allowed to take.
 *
 * The window has to scale with the PROMPT, because the dominant cost of a big
 * review call is the provider ingesting it. #211 established the first step of
 * that ladder for single-pass JSON tasks (a full packed context needs more than
 * the transport's 60s default); this module makes the SAME rule available to
 * every request path — notably the deep-review tool loop, which had a flat 60s
 * per round no matter how large the conversation had grown.
 *
 * Real numbers from the report that prompted this: skill reviewers running with
 * grounded verification showed 131k–368k token rounds. A flat 60s cannot fit
 * those, so the biggest reviewers failed while the smaller ones passed.
 *
 * The caller supplies ESTIMATED tokens (context/pack.ts's estimateTokens — one
 * heuristic, one place), so this module stays free of any prompt knowledge.
 */

/**
 * Prompt size (estimated tokens) above which a request gets an extended window
 * instead of the transport's 60s default. A full packed context near the pack
 * budget takes providers well over 60s to ingest + answer.
 */
export const LARGE_PROMPT_TOKEN_THRESHOLD = 30_000

/** The first extended step — the window #211 gives every large-prompt task. */
export const LARGE_PROMPT_TIMEOUT_MS = 120_000

/**
 * Each additional whole step of this many estimated tokens adds another
 * LARGE_PROMPT_TIMEOUT_MS to the window. 100k is deliberately coarse: it keeps
 * every prompt #211 already sized (30k–100k) on exactly the 120s it had, and
 * only grows the window for the genuinely huge rounds that were failing.
 */
export const HUGE_PROMPT_TOKEN_STEP = 100_000

/**
 * Ceiling on any single request window. Past this a retry is not the answer —
 * the review is too big for the chosen model and the copy says so.
 */
export const MAX_PROMPT_TIMEOUT_MS = 300_000

/**
 * The per-request window for a prompt of `promptTokens` estimated tokens, or
 * `undefined` when the transport's own default is right (small prompts).
 *
 * Ladder: ≤30k → default · 30k–100k → 120s · +120s per additional 100k · capped
 * at MAX_PROMPT_TIMEOUT_MS.
 */
export function sizeAwareTimeoutMs(promptTokens: number): number | undefined {
  if (!(promptTokens > LARGE_PROMPT_TOKEN_THRESHOLD)) return undefined
  const extraSteps = Math.floor(promptTokens / HUGE_PROMPT_TOKEN_STEP)
  return Math.min(
    LARGE_PROMPT_TIMEOUT_MS + extraSteps * LARGE_PROMPT_TIMEOUT_MS,
    MAX_PROMPT_TIMEOUT_MS,
  )
}

/**
 * The ACTIONABLE half of a timeout message: what timed out, at what size, and
 * what the user can actually do about it. The canned lead sentence
 * (humanMessage('timeout')) says the model was slow; this says which stage and
 * names the three levers that genuinely shrink a review round.
 *
 * Carries only a stage label, a token count and a duration — never model output
 * and never code — so it is safe as analytics `reason_detail` too (the #232
 * privacy boundary).
 */
export function timeoutDetail(stage: string, windowMs: number, promptTokens: number): string {
  const seconds = Math.round(windowMs / 1000)
  const approxK = Math.round(promptTokens / 1000)
  return (
    `${stage} exceeded its ${seconds}s window at ~${approxK}k tokens of context — ` +
    'try fewer reviewers, a faster model, or turning off deep mode.'
  )
}
