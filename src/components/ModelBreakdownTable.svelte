<script lang="ts">
  /**
   * ModelBreakdownTable — the per-model cost + impact table (Plan N).
   *
   * Shared by VerdictStep (step 3 ensemble recap) and InspectStep skill-reviewer
   * cards. Renders one row per ensemble participant: model · role · impact, with
   * a trailing cost column gated on showTokenCost. The IMPACT readout always
   * shows; the COST column is shown only when `showCost` is true. Display-only —
   * no network, no analytics, never fabricates usage (missing → "—").
   *
   * Reuse: both call sites pass the same VerdictModelBreakdown[] shape that
   * run.svelte's buildVerdictModels() produces from the crossVerify outcome.
   */
  import { formatModelUsageLabel } from '../lib/ai/tokenCost'
  import { formatGeneratorImpact, formatVerifierImpact } from '../lib/ai/modelImpact'
  import type { VerdictModelBreakdown } from '../lib/ai/run.svelte'

  interface Props {
    /** Per-model rows (generator first, then responders). Empty → renders nothing. */
    models: VerdictModelBreakdown[]
    /** Whether to show the cost column (gated on showTokenCost upstream). */
    showCost: boolean
    /** Section heading. */
    title?: string
    /** Compact variant for skill cards (smaller, tighter). */
    compact?: boolean
  }

  let { models, showCost, title = 'Models used', compact = false }: Props = $props()
</script>

{#if models.length > 0}
  <section class="model-breakdown" class:compact aria-label={title}>
    <h3>{title}</h3>
    <table class="model-table">
      <thead>
        <tr>
          <th scope="col">Model</th>
          <th scope="col">Role</th>
          <th scope="col">Impact</th>
          {#if showCost}<th scope="col" class="cost-col">Cost</th>{/if}
        </tr>
      </thead>
      <tbody>
        {#each models as m (m.providerId + ':' + m.modelId + ':' + m.role)}
          <tr>
            <td class="model-id">{m.modelId}</td>
            <td class="model-role">{m.role}</td>
            <td class="model-impact">
              {#if m.role === 'generator'}
                {formatGeneratorImpact(m.surfaced ?? 0)}
              {:else if m.impact}
                {formatVerifierImpact(m.impact)}
              {:else}
                —
              {/if}
            </td>
            {#if showCost}
              <td class="model-cost cost-col">
                {formatModelUsageLabel(m.providerId, m.modelId, m.usage) ?? '—'}
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  </section>
{/if}

<style>
  /* Plan N — per-model cost + impact table (step 3 + skill cards) */
  .model-breakdown {
    margin: 1rem 0;
    padding: 0.75rem 0.85rem;
    background: var(--surface-raised);
    border: 1px solid var(--hairline);
    border-radius: 8px;
  }
  .model-breakdown h3 {
    margin: 0 0 0.5rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .model-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }
  .model-table th {
    text-align: left;
    font-weight: 600;
    color: var(--text-muted);
    padding: 0.2rem 0.5rem 0.35rem 0;
    border-bottom: 1px solid var(--hairline);
  }
  .model-table td {
    padding: 0.3rem 0.5rem 0.3rem 0;
    color: var(--text);
    vertical-align: top;
  }
  .model-id {
    font-family: var(--font-mono);
    font-size: 0.76rem;
  }
  .model-role {
    color: var(--text-muted);
    text-transform: capitalize;
  }
  .model-impact {
    color: var(--text);
  }
  .cost-col {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .model-cost {
    color: var(--text-muted);
  }

  /* Compact variant — used on skill-reviewer cards where space is tight. */
  .model-breakdown.compact {
    margin: 0.5rem 0 0;
    padding: 0.5rem 0.6rem;
  }
  .model-breakdown.compact h3 {
    font-size: 0.7rem;
    margin: 0 0 0.35rem;
  }
  .model-breakdown.compact .model-table {
    font-size: 0.74rem;
  }
  .model-breakdown.compact .model-id {
    font-size: 0.7rem;
  }
</style>
