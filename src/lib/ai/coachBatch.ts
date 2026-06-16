/**
 * src/lib/ai/coachBatch.ts — chunking + merging for the comment coach.
 *
 * The coach used to send ONE giant LLM call: every draft (capped at 20) with
 * its per-comment code context (±6-line excerpt + ±40-line / 4000-char file
 * window) PLUS the full packed prContext. At ~30 comments that prompt blew past
 * the model's input limit and the call failed with a generic error.
 *
 * Fix: split the drafts into bounded CHUNKS and coach each chunk in its own
 * call carrying ONLY that chunk's per-comment code context. The per-comment
 * window cap already bounds each chunk, so the cap on draft count goes away.
 * Chunk results are MERGED back into one CoachResult, preserving each comment's
 * identity via its `index` (the draft's original array position) — never by
 * position within a chunk. Failed chunks are accounted for explicitly so no
 * draft is ever silently dropped.
 *
 * Pure: no LLM, no network, no analytics. The orchestrator (run.svelte.ts)
 * supplies the per-chunk LLM call via a function seam so this stays testable.
 */

import type { CoachResult, CommentReview, VerdictCoherence } from './schemas'

/** Drafts per coach LLM call. Keeps each chunk's prompt within model limits. */
export const COACH_CHUNK_SIZE = 7

/** How many chunks may be in flight at once (bounds provider rate-limits). */
export const COACH_CHUNK_CONCURRENCY = 2

/**
 * How many skill reviewers may have an LLM call in flight at once. Launching
 * every enabled reviewer at once trips provider rate limits (some reviewers
 * fail; a manual single-reviewer retry then succeeds because only one call is
 * in flight). Capping at 2 queues the rest behind a real concurrency gate.
 */
export const REVIEWER_CONCURRENCY = 2

/**
 * Split an array into fixed-size chunks (last chunk may be smaller). The
 * elements keep their identity — callers rely on each draft still carrying its
 * own `index` so the merge maps reviews back regardless of chunk boundaries.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return items.length > 0 ? [items] : []
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

/**
 * Outcome of coaching ONE chunk: either the chunk's CoachResult, or an error
 * kind plus the original draft indices that went uncoached (so the caller can
 * tell the user exactly which comments were not graded, and why).
 */
export type ChunkOutcome =
  | { ok: true; result: CoachResult }
  | { ok: false; kind: string; indices: number[] }

/**
 * A run of coach chunks merged into one shape. `reviews` is the union of every
 * successful chunk's reviews, ordered by `index`. `verdictCoherence` is the
 * first one any chunk returned (the coherence check is a run-level signal; we
 * only ask for it on the first chunk). `failedIndices` + `failureKind` describe
 * comments that could NOT be coached so the UI can show an honest note + retry.
 */
export interface MergedCoachResult {
  reviews: CommentReview[]
  verdictCoherence?: VerdictCoherence | null
  /** Original draft indices that no chunk successfully coached. */
  failedIndices: number[]
  /** The LlmError kind from the (first) failed chunk, for an honest message. */
  failureKind?: string
}

/**
 * Merge per-chunk outcomes into one result, preserving per-comment identity by
 * `index` and accounting for every failed draft. Reviews are sorted by index so
 * the UI renders them in draft order regardless of chunk completion order or
 * which chunk a comment landed in.
 */
export function mergeChunkOutcomes(outcomes: ChunkOutcome[]): MergedCoachResult {
  const reviews: CommentReview[] = []
  const failedIndices: number[] = []
  let verdictCoherence: VerdictCoherence | null | undefined
  let failureKind: string | undefined

  for (const outcome of outcomes) {
    if (outcome.ok) {
      reviews.push(...outcome.result.reviews)
      // First coherence signal wins (only the first chunk is asked for it).
      if (verdictCoherence === undefined && outcome.result.verdictCoherence !== undefined) {
        verdictCoherence = outcome.result.verdictCoherence
      }
    } else {
      failedIndices.push(...outcome.indices)
      if (failureKind === undefined) failureKind = outcome.kind
    }
  }

  reviews.sort((a, b) => a.index - b.index)
  failedIndices.sort((a, b) => a - b)

  return {
    reviews,
    ...(verdictCoherence !== undefined ? { verdictCoherence } : {}),
    failedIndices,
    ...(failureKind !== undefined ? { failureKind } : {}),
  }
}

/**
 * Run an async worker over items with bounded concurrency, preserving input
 * order in the returned results. Sequential when limit is 1; otherwise up to
 * `limit` workers run at a time — enough parallelism to be quick without
 * tripping provider rate limits on a many-chunk run.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const bound = Math.max(1, limit)

  async function runner(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  }

  const runners: Promise<void>[] = []
  for (let i = 0; i < Math.min(bound, items.length); i++) runners.push(runner())
  await Promise.all(runners)
  return results
}
