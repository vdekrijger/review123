<script lang="ts">
  /**
   * ReviewCostPanel — the consolidated "Review cost & model performance" panel
   * on Step 3 (Verdict).
   *
   * One place for the WHOLE review's cost + per-model performance:
   *   1. an aggregate headline (total tokens, + $ when showTokenCost is on),
   *   2. a per-model breakdown that RECONCILES with the total — each row's total
   *      sums ALL its task contributions (the ensemble verdict/reviewer cross-
   *      verify rows AND the single-pass tasks that ran on the active model), so
   *      the rows now add up to the "This review used … total" headline.
   *
   * Each model row is EXPANDABLE to a per-task drilldown (which task spent what,
   * dollar-first). The earlier flat table only showed the ensemble tasks, so the
   * rows didn't reconcile with the total; this panel fixes that.
   *
   * Driven by AiRun.modelCostBreakdown (NOT ModelBreakdownTable — the expandable
   * shape is rendered directly here; ModelBreakdownTable stays for the Step-2
   * per-reviewer tables). Display-only — no network, no analytics.
   */
  import { settingsState } from '../lib/settings/settingsState.svelte'
  import { formatUsageLabel, formatModelUsageLabel, formatBreakdownTotalLabel } from '../lib/ai/tokenCost'
  import { formatGeneratorImpact, formatVerifierImpact } from '../lib/ai/modelImpact'
  import type { ModelCostRow } from '../lib/ai/modelCostBreakdown'
  import type { LlmUsage } from '../lib/llm/llm'

  interface Props {
    /** Per-model rows reconciling with totalUsage (generators first). */
    modelCostBreakdown: ModelCostRow[]
    /** Sum of every task's captured usage for this review. */
    totalUsage: LlmUsage | undefined
  }

  let { modelCostBreakdown, totalUsage }: Props = $props()

  const showCost = $derived(settingsState.current.showTokenCost)
  // Total token label, only when the opt-in cost toggle is on (mirrors
  // UnderstandStep). Null → no headline (don't fabricate). When a per-model
  // breakdown exists, price the headline by SUMMING each row's own-model cost so
  // it RECONCILES with the table — otherwise a cheap active model made the
  // headline read far below the rows. With no breakdown, fall back to the
  // active-model estimate (single-model reviews price correctly that way).
  const totalUsageLabel = $derived(
    !showCost
      ? null
      : modelCostBreakdown.length > 0
        ? formatBreakdownTotalLabel(modelCostBreakdown, totalUsage)
        : formatUsageLabel(totalUsage),
  )

  // Session-only expand state, keyed by row identity. Collapsed by default.
  let expanded = $state<Record<string, boolean>>({})
  const rowKey = (m: ModelCostRow): string => `${m.providerId}:${m.modelId}:${m.role}`
  function toggle(key: string): void {
    expanded[key] = !expanded[key]
  }
</script>

{#if modelCostBreakdown.length > 0 || totalUsageLabel}
  <section class="review-cost" aria-label="Review cost and model performance">
    {#if totalUsageLabel}
      <p class="review-cost-total" aria-label="Total token usage for this review">
        This review used {totalUsageLabel} total
      </p>
    {/if}
    {#if modelCostBreakdown.length > 0}
      <h3 class="review-cost-heading">Model performance</h3>
      <ul class="model-rows">
        {#each modelCostBreakdown as m (rowKey(m))}
          {@const key = rowKey(m)}
          {@const open = expanded[key] ?? false}
          {@const costLabel = formatModelUsageLabel(m.providerId, m.modelId, m.total)}
          <li class="model-row">
            <button
              type="button"
              class="model-row-toggle"
              aria-expanded={open}
              onclick={() => toggle(key)}
            >
              <span class="model-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
              <span class="model-id">{m.modelId}</span>
              <span class="model-role">{m.role}</span>
              <span class="model-impact">
                {#if m.role === 'generator'}
                  {formatGeneratorImpact(m.surfaced ?? 0, m.uniqueCatch ?? 0)}
                {:else if m.impact}
                  {formatVerifierImpact(m.impact)}
                {/if}
              </span>
              {#if showCost}
                <span class="model-cost">{costLabel ?? '—'}</span>
              {/if}
            </button>
            {#if open}
              <ul class="task-rows">
                {#each m.byTask as t (t.task)}
                  <li class="task-row">
                    <span class="task-name">{t.task}</span>
                    {#if showCost}
                      <span class="task-cost"
                        >{formatModelUsageLabel(m.providerId, m.modelId, t.usage) ?? '—'}</span
                      >
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
      <p class="review-cost-legend">
        <strong>c</strong> = confirms · <strong>r</strong> = refutes ·
        <em>decisive</em> = the vote changed whether a finding surfaced ·
        <em>surfaced</em> = findings kept after cross-checking
      </p>
    {/if}
  </section>
{/if}

<style>
  .review-cost {
    margin: 1rem 0;
    padding: 0.75rem 0.85rem;
    background: var(--surface-raised);
    border: 1px solid var(--hairline);
    border-radius: 8px;
  }
  .review-cost-total {
    margin: 0 0 0.4rem;
    font-size: 0.82rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .review-cost-heading {
    margin: 0 0 0.5rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .review-cost-legend {
    margin: 0.5rem 0 0;
    font-size: 0.72rem;
    line-height: 1.5;
    color: var(--text-muted);
  }
  .review-cost-legend strong { color: var(--text); font-weight: 600; }
  .review-cost-legend em { font-style: normal; color: var(--text); }
  .model-rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .model-row {
    border-top: 1px solid var(--hairline);
  }
  .model-row:first-child {
    border-top: none;
  }
  .model-row-toggle {
    display: grid;
    grid-template-columns: 1.1rem minmax(0, auto) auto 1fr auto;
    align-items: baseline;
    gap: 0.5rem;
    width: 100%;
    padding: 0.4rem 0;
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
    color: var(--text);
    font: inherit;
    font-size: 0.8rem;
  }
  .model-row-toggle:hover {
    background: var(--surface-hover, rgba(127, 127, 127, 0.08));
  }
  .model-caret {
    color: var(--text-muted);
    font-size: 0.7rem;
  }
  .model-id {
    font-family: var(--font-mono);
    font-size: 0.76rem;
    white-space: nowrap;
  }
  .model-role {
    color: var(--text-muted);
    text-transform: capitalize;
  }
  .model-impact {
    color: var(--text);
    min-width: 0;
  }
  .model-cost {
    color: var(--text-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .task-rows {
    list-style: none;
    margin: 0 0 0.4rem;
    padding: 0 0 0 1.6rem;
  }
  .task-row {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.18rem 0;
    font-size: 0.76rem;
    color: var(--text-muted);
  }
  .task-cost {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
