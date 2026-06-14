import { describe, it, expect, beforeEach } from 'vitest'
import { formatTokens, formatCostUsd, formatUsageLabel, addUsage } from './tokenCost'
import { estimateCostUsd } from '../llm/providers'
import { setAiProvider, setAiModel } from '../settings/settings'
import type { LlmUsage } from '../llm/llm'

function usage(p: number, c: number): LlmUsage {
  return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c }
}

describe('formatTokens (k-rounding)', () => {
  it('shows exact counts below 1000', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(840)).toBe('840')
    expect(formatTokens(999)).toBe('999')
  })

  it('rounds to one decimal k between 1k and 100k', () => {
    expect(formatTokens(1000)).toBe('1.0k')
    expect(formatTokens(1900)).toBe('1.9k')
    expect(formatTokens(8200)).toBe('8.2k')
    expect(formatTokens(8249)).toBe('8.2k')
    expect(formatTokens(8250)).toBe('8.3k')
  })

  it('uses integer k at or above 100k', () => {
    expect(formatTokens(128_000)).toBe('128k')
    expect(formatTokens(1_000_000)).toBe('1000k')
  })

  it('clamps non-finite / negative to 0', () => {
    expect(formatTokens(NaN)).toBe('0')
    expect(formatTokens(-5)).toBe('0')
  })
})

describe('formatCostUsd', () => {
  it('collapses sub-cent to <$0.01 (never reads as free)', () => {
    expect(formatCostUsd(0.004)).toBe('<$0.01')
  })

  it('formats two decimals otherwise', () => {
    expect(formatCostUsd(0.01)).toBe('$0.01')
    expect(formatCostUsd(1.234)).toBe('$1.23')
  })

  it('zero / negative → $0.00', () => {
    expect(formatCostUsd(0)).toBe('$0.00')
    expect(formatCostUsd(-1)).toBe('$0.00')
  })
})

describe('estimateCostUsd (with / without pricing)', () => {
  it('computes $ from in/out split when pricing present', () => {
    // $3/MTok in, $15/MTok out: 1M in + 1M out = $3 + $15 = $18
    const cost = estimateCostUsd({ pricing: { inputPer1M: 3, outputPer1M: 15 } }, 1_000_000, 1_000_000)
    expect(cost).toBeCloseTo(18, 6)
  })

  it('scales linearly with token counts', () => {
    const cost = estimateCostUsd({ pricing: { inputPer1M: 0.14, outputPer1M: 0.28 } }, 500_000, 250_000)
    // 0.5*0.14 + 0.25*0.28 = 0.07 + 0.07 = 0.14
    expect(cost).toBeCloseTo(0.14, 6)
  })

  it('returns null when the model carries no pricing (no fake $)', () => {
    expect(estimateCostUsd({}, 1000, 1000)).toBeNull()
  })
})

describe('formatUsageLabel (active model resolution)', () => {
  beforeEach(() => localStorage.clear())

  it('returns null for undefined / empty usage (never fabricated)', () => {
    expect(formatUsageLabel(undefined)).toBeNull()
    expect(formatUsageLabel(usage(0, 0))).toBeNull()
  })

  it('shows tokens + $ when the active model has pricing', () => {
    setAiProvider('anthropic')
    setAiModel('claude-sonnet-4-6') // $3/$15 per MTok
    // 1M in, 1M out → $18.00; total 2M tokens → "2000k"... use smaller numbers
    const label = formatUsageLabel(usage(1_000, 500))
    // 1000/1e6*3 + 500/1e6*15 = 0.003 + 0.0075 = 0.0105 → "$0.01"
    expect(label).toBe('1.5k tokens · $0.01')
  })

  it('shows tokens ONLY when the active model has no pricing', () => {
    setAiProvider('anthropic')
    setAiModel('claude-opus-4-8') // intentionally left without pricing
    const label = formatUsageLabel(usage(8_000, 200))
    expect(label).toBe('8.2k tokens')
    expect(label).not.toContain('$')
  })
})

describe('addUsage (per-review accumulation)', () => {
  it('undefined is the zero element', () => {
    expect(addUsage(undefined, undefined)).toBeUndefined()
    const u = usage(10, 5)
    expect(addUsage(undefined, u)).toEqual(u)
    expect(addUsage(u, undefined)).toEqual(u)
  })

  it('sums prompt/completion/total componentwise', () => {
    const sum = addUsage(usage(100, 40), usage(900, 360))
    expect(sum).toEqual({ prompt_tokens: 1000, completion_tokens: 400, total_tokens: 1400 })
  })

  it('accumulates across many tasks', () => {
    const tasks = [usage(1000, 200), usage(500, 100), usage(2000, 400)]
    let total: LlmUsage | undefined
    for (const t of tasks) total = addUsage(total, t)
    expect(total).toEqual({ prompt_tokens: 3500, completion_tokens: 700, total_tokens: 4200 })
  })
})
