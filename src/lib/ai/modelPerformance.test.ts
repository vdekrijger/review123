/**
 * Unit: aggregateModelPerformance — the consolidated Step-3 per-model breakdown.
 *
 * Pure function: flatten all task row-sets, group by (provider, model, role),
 * sum usage + generator counts + verifier impact. A model that is a generator
 * in one task and a verifier in another yields TWO rows (role is part of the
 * key). Empty input → empty. Ordering: generators first then verifiers, each
 * sorted by providerId then modelId.
 */
import { describe, it, expect } from 'vitest'
import { aggregateModelPerformance } from './modelPerformance'
import type { VerdictModelBreakdown } from './run.svelte'

const usage = (t: number) => ({ prompt_tokens: t, completion_tokens: t, total_tokens: t })

describe('aggregateModelPerformance', () => {
  it('returns empty for empty input', () => {
    expect(aggregateModelPerformance([])).toEqual([])
    expect(aggregateModelPerformance([[], []])).toEqual([])
  })

  it('sums usage + surfaced/uniqueCatch for the same generator across row-sets', () => {
    const a: VerdictModelBreakdown[] = [
      { providerId: 'anthropic', modelId: 'opus', role: 'generator', usage: usage(100), surfaced: 3, uniqueCatch: 1 },
    ]
    const b: VerdictModelBreakdown[] = [
      { providerId: 'anthropic', modelId: 'opus', role: 'generator', usage: usage(40), surfaced: 2, uniqueCatch: 2 },
    ]
    const out = aggregateModelPerformance([a, b])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      providerId: 'anthropic',
      modelId: 'opus',
      role: 'generator',
      usage: usage(140),
      surfaced: 5,
      uniqueCatch: 3,
    })
  })

  it('sums verifier impact (confirms/refutes/uncertains/decisive) across row-sets', () => {
    const a: VerdictModelBreakdown[] = [
      { providerId: 'anthropic', modelId: 'haiku', role: 'verifier', usage: usage(10), impact: { confirms: 1, refutes: 0, uncertains: 2, decisive: 1 } },
    ]
    const b: VerdictModelBreakdown[] = [
      { providerId: 'anthropic', modelId: 'haiku', role: 'verifier', usage: usage(5), impact: { confirms: 3, refutes: 1, uncertains: 0, decisive: 2 } },
    ]
    const out = aggregateModelPerformance([a, b])
    expect(out).toHaveLength(1)
    expect(out[0].usage).toEqual(usage(15))
    expect(out[0].impact).toEqual({ confirms: 4, refutes: 1, uncertains: 2, decisive: 3 })
  })

  it('a model that is generator in one set and verifier in another yields TWO rows', () => {
    const a: VerdictModelBreakdown[] = [
      { providerId: 'anthropic', modelId: 'opus', role: 'generator', usage: usage(100), surfaced: 1 },
    ]
    const b: VerdictModelBreakdown[] = [
      { providerId: 'anthropic', modelId: 'opus', role: 'verifier', usage: usage(20), impact: { confirms: 1, refutes: 0, uncertains: 0, decisive: 0 } },
    ]
    const out = aggregateModelPerformance([a, b])
    expect(out).toHaveLength(2)
    expect(out.map((r) => r.role)).toEqual(['generator', 'verifier'])
  })

  it('orders generators first then verifiers, each sorted by provider then model', () => {
    const rows: VerdictModelBreakdown[] = [
      { providerId: 'openai', modelId: 'gpt', role: 'verifier', impact: { confirms: 0, refutes: 0, uncertains: 0, decisive: 0 } },
      { providerId: 'anthropic', modelId: 'sonnet', role: 'generator', surfaced: 0 },
      { providerId: 'anthropic', modelId: 'haiku', role: 'verifier', impact: { confirms: 0, refutes: 0, uncertains: 0, decisive: 0 } },
      { providerId: 'anthropic', modelId: 'opus', role: 'generator', surfaced: 0 },
    ]
    const out = aggregateModelPerformance([rows])
    expect(out.map((r) => `${r.role}:${r.providerId}:${r.modelId}`)).toEqual([
      'generator:anthropic:opus',
      'generator:anthropic:sonnet',
      'verifier:anthropic:haiku',
      'verifier:openai:gpt',
    ])
  })

  it('does not mutate the caller source rows', () => {
    const a: VerdictModelBreakdown[] = [
      { providerId: 'anthropic', modelId: 'opus', role: 'generator', usage: usage(100), surfaced: 3 },
    ]
    const b: VerdictModelBreakdown[] = [
      { providerId: 'anthropic', modelId: 'opus', role: 'generator', usage: usage(40), surfaced: 2 },
    ]
    aggregateModelPerformance([a, b])
    expect(a[0].surfaced).toBe(3)
    expect(a[0].usage).toEqual(usage(100))
  })
})
