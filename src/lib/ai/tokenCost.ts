/**
 * tokenCost.ts — formatting helpers for the OPTIONAL "Show token usage"
 * power-user display (settings.showTokenCost, default OFF).
 *
 * Pure + display-only: every value here is derived from usage the LLM
 * transport layer already captured (LlmUsage). Nothing here makes a network
 * call or emits analytics — when the toggle is off, none of this renders.
 */

import type { LlmUsage } from '../llm/llm'
import { activeLlmConfig } from '../llm/config'
import { estimateCostUsd } from '../llm/providers'

/**
 * Round a raw token count to a short human label:
 *   < 1000      → exact ("840")
 *   1000-99_999 → one decimal "k" ("8.2k", "1.0k")
 *   >= 100_000  → integer "k" ("128k")
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1000) return String(Math.round(n))
  const k = n / 1000
  if (k < 100) return `${k.toFixed(1)}k`
  return `${Math.round(k)}k`
}

/**
 * Format a USD cost. Sub-cent costs collapse to "<$0.01" so a tiny request
 * never reads as "$0.00" (which looks like "free"). Otherwise two decimals.
 */
export function formatCostUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

/**
 * Build the muted footer label for one task's usage, e.g.
 *   "8.2k tokens · $0.01"  (pricing known)
 *   "8.2k tokens"          (no pricing for active model)
 * Returns null when there's no usage to show (don't fabricate).
 *
 * The active model is resolved from settings so the $ estimate tracks the
 * provider/model the user actually ran with.
 */
export function formatUsageLabel(usage: LlmUsage | undefined): string | null {
  if (!usage) return null
  const total = usage.total_tokens
  if (!Number.isFinite(total) || total <= 0) return null
  const { model } = activeLlmConfig()
  const cost = estimateCostUsd(model, usage.prompt_tokens, usage.completion_tokens)
  const tokensPart = `${formatTokens(total)} tokens`
  return cost === null ? tokensPart : `${tokensPart} · ${formatCostUsd(cost)}`
}

/** Add two optional usage records; undefined acts as the zero element. */
export function addUsage(
  a: LlmUsage | undefined,
  b: LlmUsage | undefined,
): LlmUsage | undefined {
  if (!a) return b
  if (!b) return a
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  }
}
