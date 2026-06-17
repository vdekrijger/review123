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
import { estimateCostUsd, getProvider, getModelDef } from '../llm/providers'

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
 * Marker prefix the per-model cost cell renders when a model carries no pricing.
 * Dollar-FIRST display means the column is never blank — an unpriced row shows
 * "$— · <tokens>" with the cell adding a "no pricing on file" tooltip.
 */
export const NO_PRICING_MARKER = '$—'

/**
 * Build the muted footer label for one task's usage. DOLLAR-FIRST: the $ is the
 * primary value, the token count is secondary, e.g.
 *   "$0.13 · 14.0k tokens"  (pricing known)
 *   "<$0.01 · 8.2k tokens"  (sub-cent, pricing known)
 *   "8.2k tokens"           (no pricing for active model — no fake $)
 * Returns null when there's no usage to show (don't fabricate).
 *
 * The active model is resolved from settings so the $ estimate tracks the
 * provider/model the user actually ran with. This drives the aggregate "This
 * review used … total" headline; the active model is priced after the catalog
 * backfill, so the token-only fallback is now rare.
 */
export function formatUsageLabel(usage: LlmUsage | undefined): string | null {
  if (!usage) return null
  const total = usage.total_tokens
  if (!Number.isFinite(total) || total <= 0) return null
  const { model } = activeLlmConfig()
  const cost = estimateCostUsd(model, usage.prompt_tokens, usage.completion_tokens)
  const tokensPart = `${formatTokens(total)} tokens`
  return cost === null ? tokensPart : `${formatCostUsd(cost)} · ${tokensPart}`
}

/**
 * Human label for a SPECIFIC provider+model's usage (Plan N per-model cost).
 * Unlike formatUsageLabel (which prices against the active model), this prices
 * against the named model so a verifier on a different model gets the right $.
 * DOLLAR-FIRST so the column leads with the $ value, e.g. "$0.13 · 14.0k tokens".
 *
 * When the model has NO pricing the dollar value is still PRIMARY but honest:
 * "$— · 14.0k tokens" — the table cell adds a "no pricing on file" tooltip so
 * the cost column is never empty. Returns null only when there's no usage to
 * show (never fabricated).
 */
export function formatModelUsageLabel(
  providerId: string,
  modelId: string,
  usage: LlmUsage | undefined,
): string | null {
  if (!usage) return null
  const total = usage.total_tokens
  if (!Number.isFinite(total) || total <= 0) return null
  const provider = getProvider(providerId as never)
  const model = provider ? getModelDef(provider, modelId) : undefined
  const cost = model ? estimateCostUsd(model, usage.prompt_tokens, usage.completion_tokens) : null
  const tokensPart = `${formatTokens(total)} tokens`
  const costPart = cost === null ? NO_PRICING_MARKER : formatCostUsd(cost)
  return `${costPart} · ${tokensPart}`
}

/**
 * Aggregate "This review used … total" label that RECONCILES with the per-model
 * rows. The plain formatUsageLabel prices ALL tokens at the ACTIVE model's rate,
 * which is WRONG when the review ran multiple models (a cheap active model made
 * the headline read far below the sum of the rows). This prices each row by ITS
 * OWN model and sums them, so the headline $ equals what you get adding the
 * table up. Token count comes from totalUsage (the reconciled total). Rows with
 * no pricing on file contribute 0 to the $ (the row itself shows "$—"), so the
 * sum is a lower bound in that rare case — honest, never fabricated.
 */
export function formatBreakdownTotalLabel(
  rows: { providerId: string; modelId: string; total?: LlmUsage }[],
  totalUsage: LlmUsage | undefined,
): string | null {
  const totalTokens = totalUsage?.total_tokens
  if (!Number.isFinite(totalTokens) || (totalTokens ?? 0) <= 0) return null
  let costSum = 0
  let anyPriced = false
  for (const r of rows) {
    if (!r.total) continue
    const provider = getProvider(r.providerId as never)
    const model = provider ? getModelDef(provider, r.modelId) : undefined
    const cost = model
      ? estimateCostUsd(model, r.total.prompt_tokens, r.total.completion_tokens)
      : null
    if (cost === null) continue
    costSum += cost
    anyPriced = true
  }
  const tokensPart = `${formatTokens(totalTokens as number)} tokens`
  return anyPriced ? `${formatCostUsd(costSum)} · ${tokensPart}` : tokensPart
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
