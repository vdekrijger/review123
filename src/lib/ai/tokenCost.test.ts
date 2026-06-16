import { describe, it, expect, beforeEach } from 'vitest'
import { formatTokens, formatCostUsd, formatUsageLabel, formatModelUsageLabel, addUsage, NO_PRICING_MARKER } from './tokenCost'
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

  it('leads with $ then tokens when the active model has pricing (dollar-first)', () => {
    setAiProvider('anthropic')
    setAiModel('claude-sonnet-4-6') // $3/$15 per MTok
    const label = formatUsageLabel(usage(1_000, 500))
    // 1000/1e6*3 + 500/1e6*15 = 0.003 + 0.0075 = 0.0105 → "$0.01"; $ comes FIRST.
    expect(label).toBe('$0.01 · 1.5k tokens')
  })

  // NOTE: every catalog model now carries pricing (2026-06-16 backfill) and
  // activeLlmConfig() falls back to the provider's (priced) defaultModel for any
  // unknown saved id, so formatUsageLabel's token-only branch is no longer
  // reachable through settings. The no-pricing path is covered directly via
  // formatModelUsageLabel below (which prices a NAMED model, not the active one).
})

describe('formatModelUsageLabel (per-model, dollar-first)', () => {
  it('returns null for undefined / empty usage (never fabricated)', () => {
    expect(formatModelUsageLabel('anthropic', 'claude-sonnet-4-6', undefined)).toBeNull()
    expect(formatModelUsageLabel('anthropic', 'claude-sonnet-4-6', usage(0, 0))).toBeNull()
  })

  it('leads with the $ then the token count when the model has pricing', () => {
    // claude-sonnet-4-6 = $3/$15 per MTok; 1000 in + 500 out = $0.0105 → "$0.01".
    const label = formatModelUsageLabel('anthropic', 'claude-sonnet-4-6', usage(1_000, 500))
    expect(label).toBe('$0.01 · 1.5k tokens')
  })

  it('collapses a sub-cent priced row to "<$0.01" (still dollar-first)', () => {
    // deepseek-v4-flash = $0.098/$0.196; tiny usage → far below a cent.
    const label = formatModelUsageLabel('deepseek', 'deepseek-v4-flash', usage(100, 50))
    expect(label).toBe('<$0.01 · 150 tokens')
  })

  it('shows the "$—" marker (never blank) when the model has no pricing', () => {
    const label = formatModelUsageLabel('anthropic', 'no-such-model', usage(8_000, 200))
    expect(label).toBe(`${NO_PRICING_MARKER} · 8.2k tokens`)
    expect(label!.startsWith(NO_PRICING_MARKER)).toBe(true)
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
