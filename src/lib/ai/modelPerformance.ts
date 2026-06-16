/**
 * src/lib/ai/modelPerformance.ts — aggregate per-model cost + performance.
 *
 * The consolidated "Review cost & model performance" panel (Step 3) shows ONE
 * per-model breakdown for the WHOLE review: the verdict task's generator +
 * verifiers AND every skill reviewer's generators + verifiers, summed by model.
 *
 * `aggregateModelPerformance` is a pure function: it flattens all the per-task
 * `VerdictModelBreakdown[]` row-sets and groups by (providerId, modelId, role),
 * summing token usage and impact. The SAME model can legitimately appear twice
 * (e.g. generator in one task, verifier in another) — those are two distinct
 * rows because `role` is part of the key. Display-only; never fabricates usage.
 */
import { addUsage } from './tokenCost'
import type { VerdictModelBreakdown } from './run.svelte'

/**
 * Aggregate per-model cost + impact across every task's row-set.
 *
 * Groups by `${providerId}:${modelId}:${role}`, summing:
 *   - `usage` (via addUsage — undefined acts as the zero element)
 *   - generators: `surfaced`, `uniqueCatch`
 *   - verifiers: `impact.{confirms,refutes,uncertains,decisive}`
 *
 * Stable order: all generators first then verifiers, each sorted by providerId
 * then modelId. Empty input → empty output.
 */
export function aggregateModelPerformance(
  rowSets: VerdictModelBreakdown[][],
): VerdictModelBreakdown[] {
  const byKey = new Map<string, VerdictModelBreakdown>()

  for (const rows of rowSets) {
    for (const row of rows) {
      const key = `${row.providerId}:${row.modelId}:${row.role}`
      const existing = byKey.get(key)
      if (!existing) {
        // Clone so we never mutate the caller's source rows.
        byKey.set(key, {
          providerId: row.providerId,
          modelId: row.modelId,
          role: row.role,
          ...(row.usage ? { usage: row.usage } : {}),
          ...(row.role === 'generator'
            ? { surfaced: row.surfaced ?? 0, uniqueCatch: row.uniqueCatch ?? 0 }
            : {
                impact: {
                  confirms: row.impact?.confirms ?? 0,
                  refutes: row.impact?.refutes ?? 0,
                  uncertains: row.impact?.uncertains ?? 0,
                  decisive: row.impact?.decisive ?? 0,
                },
              }),
        })
        continue
      }

      existing.usage = addUsage(existing.usage, row.usage)
      if (row.role === 'generator') {
        existing.surfaced = (existing.surfaced ?? 0) + (row.surfaced ?? 0)
        existing.uniqueCatch = (existing.uniqueCatch ?? 0) + (row.uniqueCatch ?? 0)
      } else if (existing.impact) {
        existing.impact.confirms += row.impact?.confirms ?? 0
        existing.impact.refutes += row.impact?.refutes ?? 0
        existing.impact.uncertains += row.impact?.uncertains ?? 0
        existing.impact.decisive += row.impact?.decisive ?? 0
      }
    }
  }

  const roleRank = (r: VerdictModelBreakdown['role']) => (r === 'generator' ? 0 : 1)
  return [...byKey.values()].sort(
    (a, b) =>
      roleRank(a.role) - roleRank(b.role) ||
      a.providerId.localeCompare(b.providerId) ||
      a.modelId.localeCompare(b.modelId),
  )
}
