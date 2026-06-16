<script lang="ts">
  /**
   * ReviewCostPanel — the consolidated "Review cost & model performance" panel
   * on Step 3 (Verdict).
   *
   * One place for the WHOLE review's cost + per-model performance:
   *   1. an aggregate headline (total tokens, + $ when showTokenCost is on),
   *   2. the per-model breakdown (verdict generator/verifiers AND every reviewer's
   *      models, aggregated) via the shared ModelBreakdownTable.
   *
   * Replaces the old verdict-only "Models used" table — which was blank on an
   * evidence-free verdict even though the verdict ran and cost tokens. The
   * per-reviewer per-model tables on Step 2 are unaffected. Display-only.
   */
  import { settingsState } from '../lib/settings/settingsState.svelte'
  import { formatUsageLabel } from '../lib/ai/tokenCost'
  import ModelBreakdownTable from './ModelBreakdownTable.svelte'
  import type { VerdictModelBreakdown } from '../lib/ai/run.svelte'
  import type { LlmUsage } from '../lib/llm/llm'

  interface Props {
    /** Aggregated per-model rows for the whole review (generators first). */
    modelPerformance: VerdictModelBreakdown[]
    /** Sum of every task's captured usage for this review. */
    totalUsage: LlmUsage | undefined
  }

  let { modelPerformance, totalUsage }: Props = $props()

  const showCost = $derived(settingsState.current.showTokenCost)
  // Total token label, only when the opt-in cost toggle is on (mirrors
  // UnderstandStep). Null → no headline (don't fabricate).
  const totalUsageLabel = $derived(showCost ? formatUsageLabel(totalUsage) : null)
</script>

{#if modelPerformance.length > 0 || totalUsageLabel}
  <section class="review-cost" aria-label="Review cost and model performance">
    {#if totalUsageLabel}
      <p class="review-cost-total" aria-label="Total token usage for this review">
        This review used {totalUsageLabel} total
      </p>
    {/if}
    <ModelBreakdownTable models={modelPerformance} {showCost} title="Model performance" compact />
  </section>
{/if}

<style>
  .review-cost {
    margin: 1rem 0;
  }
  .review-cost-total {
    margin: 0 0 0.4rem;
    font-size: 0.82rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
