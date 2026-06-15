/**
 * src/lib/ai/coachBatch.test.ts — pure chunking + merging for the comment coach.
 */

import { describe, it, expect } from 'vitest'
import {
  chunk,
  mergeChunkOutcomes,
  mapWithConcurrency,
  COACH_CHUNK_SIZE,
  type ChunkOutcome,
} from './coachBatch'
import type { CommentReview } from './schemas'

function review(index: number): CommentReview {
  return {
    index,
    clarity: 3,
    actionable: true,
    tone: 'ok',
    biasQuestion: null,
    suggestion: null,
    accuracy: 'consistent',
    accuracyNote: null,
    duplicate: false,
  }
}

describe('chunk', () => {
  it('splits into fixed-size chunks; last chunk may be smaller', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('20 drafts at the default chunk size produce ceil(20/size) chunks', () => {
    const drafts = Array.from({ length: 20 }, (_, i) => i)
    const chunks = chunk(drafts, COACH_CHUNK_SIZE)
    expect(chunks.length).toBe(Math.ceil(20 / COACH_CHUNK_SIZE))
    // Every draft appears exactly once, in order.
    expect(chunks.flat()).toEqual(drafts)
  })

  it('30 drafts split into multiple bounded chunks (no single giant batch)', () => {
    const drafts = Array.from({ length: 30 }, (_, i) => i)
    const chunks = chunk(drafts, COACH_CHUNK_SIZE)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(COACH_CHUNK_SIZE)
    expect(chunks.flat()).toEqual(drafts)
  })

  it('empty input yields no chunks', () => {
    expect(chunk([], 7)).toEqual([])
  })
})

describe('mergeChunkOutcomes', () => {
  it('merges 3 successful chunks (20 reviews) into one, ordered by index', () => {
    const outcomes: ChunkOutcome[] = [
      { ok: true, result: { reviews: [review(0), review(1), review(2), review(3), review(4), review(5), review(6)] } },
      { ok: true, result: { reviews: [review(7), review(8), review(9), review(10), review(11), review(12), review(13)] } },
      { ok: true, result: { reviews: [review(14), review(15), review(16), review(17), review(18), review(19)] } },
    ]
    const merged = mergeChunkOutcomes(outcomes)
    expect(merged.reviews.map((r) => r.index)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    expect(merged.failedIndices).toEqual([])
  })

  it('sorts reviews by index even when chunks complete out of order', () => {
    const outcomes: ChunkOutcome[] = [
      { ok: true, result: { reviews: [review(7), review(8)] } },
      { ok: true, result: { reviews: [review(0), review(1)] } },
    ]
    const merged = mergeChunkOutcomes(outcomes)
    expect(merged.reviews.map((r) => r.index)).toEqual([0, 1, 7, 8])
  })

  it('partial failure: surviving chunk reviews returned + failed indices accounted for', () => {
    const outcomes: ChunkOutcome[] = [
      { ok: true, result: { reviews: [review(0), review(1)] } },
      { ok: false, kind: 'rate-limited', indices: [2, 3] },
    ]
    const merged = mergeChunkOutcomes(outcomes)
    expect(merged.reviews.map((r) => r.index)).toEqual([0, 1])
    expect(merged.failedIndices).toEqual([2, 3])
    expect(merged.failureKind).toBe('rate-limited')
  })

  it('first chunk verdictCoherence is preserved across the merge', () => {
    const outcomes: ChunkOutcome[] = [
      { ok: true, result: { reviews: [review(0)], verdictCoherence: { coherent: false, note: 'mismatch' } } },
      { ok: true, result: { reviews: [review(1)] } },
    ]
    const merged = mergeChunkOutcomes(outcomes)
    expect(merged.verdictCoherence).toEqual({ coherent: false, note: 'mismatch' })
  })

  it('records the FIRST failure kind when several chunks fail', () => {
    const outcomes: ChunkOutcome[] = [
      { ok: false, kind: 'network', indices: [0, 1] },
      { ok: false, kind: 'rate-limited', indices: [2, 3] },
    ]
    const merged = mergeChunkOutcomes(outcomes)
    expect(merged.failedIndices).toEqual([0, 1, 2, 3])
    expect(merged.failureKind).toBe('network')
  })
})

describe('mapWithConcurrency', () => {
  it('preserves input order in the results', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10)
    expect(out).toEqual([10, 20, 30, 40, 50])
  })

  it('never runs more than `limit` workers at once', async () => {
    let active = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 8 }, (_, i) => i), 2, async (n) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 1))
      active--
      return n
    })
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('limit of 1 runs strictly sequentially', async () => {
    let active = 0
    let peak = 0
    await mapWithConcurrency([1, 2, 3], 1, async (n) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 1))
      active--
      return n
    })
    expect(peak).toBe(1)
  })
})
