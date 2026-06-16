/**
 * src/lib/ai/modelCostBreakdown.ts — per-model cost breakdown that RECONCILES
 * with the review total.
 *
 * The Step-3 "Model performance" panel must account for EVERY token the review
 * spent. The earlier `modelPerformance` aggregate only covered the ensemble
 * tasks (verdict + reviewers' cross-verify) — the single-pass tasks (summary,
 * hotspots, diagrams, tests, alternatives, story, coach) ran on the active model
 * and weren't shown, so the rows didn't sum to the aggregate total.
 *
 * This module groups a flat list of per-(model, role, task) CONTRIBUTIONS into
 * one ModelCostRow per (model, role), summing usage + impact and keeping a
 * per-task drilldown. It is pure + deterministic; the caller (run.svelte) is
 * responsible for emitting contributions that cover every task exactly once, so
 * that Σ row totals === totalUsage. Display-only — no network, no analytics.
 */

import { addUsage } from './tokenCost'
import type { LlmUsage } from '../llm/llm'

/**
 * One (model, role)'s spend on ONE task. The caller emits these so that, summed,
 * they account for every task's usage exactly once (no drops, no double-count).
 */
export interface CostContribution {
  providerId: string
  modelId: string
  role: 'generator' | 'verifier'
  /** Human task label, e.g. 'Summary', 'Verdict', 'Reviewer: Security'. */
  task: string
  /** Token usage this (model, role) spent on this task, when captured. */
  usage?: LlmUsage
  /** Generator: findings that survived verification (surfaced). */
  surfaced?: number
  /** Generator (fusion 'generate' mode): findings only this model raised. */
  uniqueCatch?: number
  /** Verifier impact (confirms/refutes/uncertains/decisive). */
  impact?: { confirms: number; refutes: number; uncertains: number; decisive: number }
}

/** A model's per-task drilldown entry. */
export interface ModelCostTask {
  task: string
  usage?: LlmUsage
}

/**
 * One row in the breakdown: a (model, role) with its TOTAL usage across all the
 * tasks it touched, its summed impact, and the per-task drilldown (`byTask`).
 */
export interface ModelCostRow {
  providerId: string
  modelId: string
  role: 'generator' | 'verifier'
  /** Sum of this row's contributions' usage. undefined when none had usage. */
  total?: LlmUsage
  /** Generator: summed surfaced findings. */
  surfaced?: number
  /** Generator: summed unique catches. */
  uniqueCatch?: number
  /** Verifier: summed impact. */
  impact?: { confirms: number; refutes: number; uncertains: number; decisive: number }
  /** Per-task drilldown, one entry per distinct task, in insertion order. */
  byTask: ModelCostTask[]
}

/**
 * Build the per-model cost breakdown from a flat contribution list.
 *
 * Groups by `${providerId}:${modelId}:${role}`. For each group:
 *   - `total` = Σ contributions' usage (addUsage; undefined acts as zero),
 *   - generators sum `surfaced` / `uniqueCatch`,
 *   - verifiers sum `impact.*`,
 *   - `byTask` collects one entry per distinct task (a model that touched the
 *     same task twice — shouldn't happen given the caller's design, but kept
 *     robust — merges into one entry with summed usage), in insertion order.
 *
 * Stable order: all generators first then verifiers, each by providerId then
 * modelId (matches aggregateModelPerformance). Empty input → empty output.
 */
export function buildModelCostBreakdown(
  contributions: CostContribution[],
): ModelCostRow[] {
  const byKey = new Map<string, ModelCostRow>()
  // Track per-row task index so a repeated task merges instead of duplicating.
  const taskIndexByRow = new Map<string, Map<string, number>>()

  for (const c of contributions) {
    const key = `${c.providerId}:${c.modelId}:${c.role}`
    let row = byKey.get(key)
    if (!row) {
      row = {
        providerId: c.providerId,
        modelId: c.modelId,
        role: c.role,
        byTask: [],
        ...(c.role === 'generator'
          ? { surfaced: 0, uniqueCatch: 0 }
          : { impact: { confirms: 0, refutes: 0, uncertains: 0, decisive: 0 } }),
      }
      byKey.set(key, row)
      taskIndexByRow.set(key, new Map())
    }

    row.total = addUsage(row.total, c.usage)
    if (c.role === 'generator') {
      row.surfaced = (row.surfaced ?? 0) + (c.surfaced ?? 0)
      row.uniqueCatch = (row.uniqueCatch ?? 0) + (c.uniqueCatch ?? 0)
    } else if (row.impact) {
      row.impact.confirms += c.impact?.confirms ?? 0
      row.impact.refutes += c.impact?.refutes ?? 0
      row.impact.uncertains += c.impact?.uncertains ?? 0
      row.impact.decisive += c.impact?.decisive ?? 0
    }

    const taskIndex = taskIndexByRow.get(key)!
    const existingTaskPos = taskIndex.get(c.task)
    if (existingTaskPos === undefined) {
      taskIndex.set(c.task, row.byTask.length)
      row.byTask.push({ task: c.task, ...(c.usage ? { usage: c.usage } : {}) })
    } else {
      const entry = row.byTask[existingTaskPos]
      entry.usage = addUsage(entry.usage, c.usage)
    }
  }

  const roleRank = (r: ModelCostRow['role']) => (r === 'generator' ? 0 : 1)
  return [...byKey.values()].sort(
    (a, b) =>
      roleRank(a.role) - roleRank(b.role) ||
      a.providerId.localeCompare(b.providerId) ||
      a.modelId.localeCompare(b.modelId),
  )
}
