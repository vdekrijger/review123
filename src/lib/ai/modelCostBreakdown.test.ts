/**
 * Unit: buildModelCostBreakdown — the per-model cost breakdown that RECONCILES
 * with the review total.
 *
 * Pure function: group a flat CostContribution[] by (provider, model, role),
 * sum usage + impact, and keep a per-task drilldown (byTask). The headline
 * invariant: Σ row totals === Σ input usage (no task dropped/double-counted).
 */
import { describe, it, expect } from 'vitest'
import { buildModelCostBreakdown, type CostContribution } from './modelCostBreakdown'
import type { LlmUsage } from '../llm/llm'

const usage = (t: number): LlmUsage => ({ prompt_tokens: t, completion_tokens: t, total_tokens: t })

function sumTotals(rows: { total?: LlmUsage }[]): number {
  return rows.reduce((acc, r) => acc + (r.total?.total_tokens ?? 0), 0)
}
function sumInputs(cs: CostContribution[]): number {
  return cs.reduce((acc, c) => acc + (c.usage?.total_tokens ?? 0), 0)
}

describe('buildModelCostBreakdown', () => {
  it('returns empty for empty input', () => {
    expect(buildModelCostBreakdown([])).toEqual([])
  })

  it('groups by (provider, model, role) and sums usage', () => {
    const cs: CostContribution[] = [
      { providerId: 'anthropic', modelId: 'opus', role: 'generator', task: 'Verdict', usage: usage(100) },
      { providerId: 'anthropic', modelId: 'opus', role: 'generator', task: 'Summary', usage: usage(40) },
    ]
    const out = buildModelCostBreakdown(cs)
    expect(out).toHaveLength(1)
    expect(out[0].total).toEqual(usage(140))
  })

  it('captures byTask per distinct task in insertion order', () => {
    const cs: CostContribution[] = [
      { providerId: 'anthropic', modelId: 'opus', role: 'generator', task: 'Verdict', usage: usage(100) },
      { providerId: 'anthropic', modelId: 'opus', role: 'generator', task: 'Summary', usage: usage(40) },
      { providerId: 'anthropic', modelId: 'opus', role: 'generator', task: 'Tests', usage: usage(10) },
    ]
    const out = buildModelCostBreakdown(cs)
    expect(out[0].byTask.map((t) => t.task)).toEqual(['Verdict', 'Summary', 'Tests'])
    expect(out[0].byTask[0].usage).toEqual(usage(100))
  })

  it('merges a repeated task for one model into a single byTask entry (summed)', () => {
    const cs: CostContribution[] = [
      { providerId: 'anthropic', modelId: 'opus', role: 'generator', task: 'Verdict', usage: usage(100) },
      { providerId: 'anthropic', modelId: 'opus', role: 'generator', task: 'Verdict', usage: usage(20) },
    ]
    const out = buildModelCostBreakdown(cs)
    expect(out[0].byTask).toHaveLength(1)
    expect(out[0].byTask[0].usage).toEqual(usage(120))
  })

  it('sums generator surfaced/uniqueCatch and verifier impact', () => {
    const cs: CostContribution[] = [
      { providerId: 'a', modelId: 'opus', role: 'generator', task: 'Verdict', surfaced: 3, uniqueCatch: 1 },
      { providerId: 'a', modelId: 'opus', role: 'generator', task: 'Reviewer: X', surfaced: 2, uniqueCatch: 0 },
      { providerId: 'a', modelId: 'haiku', role: 'verifier', task: 'Verdict', impact: { confirms: 1, refutes: 1, uncertains: 0, decisive: 1 } },
      { providerId: 'a', modelId: 'haiku', role: 'verifier', task: 'Reviewer: X', impact: { confirms: 2, refutes: 0, uncertains: 1, decisive: 0 } },
    ]
    const out = buildModelCostBreakdown(cs)
    const gen = out.find((r) => r.role === 'generator')!
    const ver = out.find((r) => r.role === 'verifier')!
    expect(gen.surfaced).toBe(5)
    expect(gen.uniqueCatch).toBe(1)
    expect(ver.impact).toEqual({ confirms: 3, refutes: 1, uncertains: 1, decisive: 1 })
  })

  it('orders generators before verifiers, then by provider/model', () => {
    const cs: CostContribution[] = [
      { providerId: 'openai', modelId: 'gpt', role: 'verifier', task: 'Verdict' },
      { providerId: 'anthropic', modelId: 'opus', role: 'generator', task: 'Verdict' },
      { providerId: 'anthropic', modelId: 'haiku', role: 'verifier', task: 'Verdict' },
      { providerId: 'anthropic', modelId: 'sonnet', role: 'generator', task: 'Verdict' },
    ]
    const out = buildModelCostBreakdown(cs)
    expect(out.map((r) => `${r.modelId}:${r.role}`)).toEqual([
      'opus:generator',
      'sonnet:generator',
      'haiku:verifier',
      'gpt:verifier',
    ])
  })

  it('RECONCILES: Σ row totals === Σ input usage', () => {
    const cs: CostContribution[] = [
      { providerId: 'anthropic', modelId: 'opus', role: 'generator', task: 'Verdict', usage: usage(150) },
      { providerId: 'anthropic', modelId: 'opus', role: 'generator', task: 'Summary', usage: usage(60) },
      { providerId: 'anthropic', modelId: 'opus', role: 'generator', task: 'Tests', usage: usage(30) },
      { providerId: 'anthropic', modelId: 'haiku', role: 'verifier', task: 'Verdict', usage: usage(40) },
      { providerId: 'openai', modelId: 'gpt', role: 'generator', task: 'Reviewer: Y', usage: usage(20) },
    ]
    const out = buildModelCostBreakdown(cs)
    expect(sumTotals(out)).toBe(sumInputs(cs))
    expect(sumTotals(out)).toBe(300)
  })

  it('treats a contribution with no usage as zero (still appears in byTask)', () => {
    const cs: CostContribution[] = [
      { providerId: 'a', modelId: 'opus', role: 'generator', task: 'Summary' },
    ]
    const out = buildModelCostBreakdown(cs)
    expect(out[0].total).toBeUndefined()
    expect(out[0].byTask).toEqual([{ task: 'Summary' }])
  })
})
