<script lang="ts">
  import AiPanel from '../AiPanel.svelte'
  import MarkdownView from '../MarkdownView.svelte'
  import type { AiRun } from '../../lib/ai/run.svelte'
  import type { AlternativesResult } from '../../lib/ai/schemas'

  interface Props {
    run: AiRun
  }

  let { run }: Props = $props()

  const alternatives = $derived(
    run.alternatives.status === 'done' ? (run.alternatives.value as AlternativesResult) : null
  )
</script>

<AiPanel title="Alternative approaches (AI)" state={run.alternatives} onretry={() => run.retry('alternatives')}>
  {#if alternatives}
    <p class="alternatives-problem">{alternatives.problem}</p>
    {#if alternatives.alternatives.length === 0}
      <p class="alternatives-empty">No meaningfully different alternatives identified — the PR's approach appears to be the natural choice.</p>
    {:else}
      <div class="alternatives-list">
        {#each alternatives.alternatives as alt (alt.approach)}
          <div class="alternative-card">
            <p class="alternative-approach">{alt.approach}</p>
            <p class="alternative-tradeoffs"><MarkdownView source={alt.tradeoffs} /></p>
            <span
              class="assessment-chip assessment-{alt.assessment}"
              aria-label="Assessment: {alt.assessment}"
            >
              {#if alt.assessment === 'pr-is-better'}PR's approach is better
              {:else if alt.assessment === 'comparable'}Comparable
              {:else if alt.assessment === 'alternative-is-better'}Worth considering
              {:else}Different goals
              {/if}
            </span>
            <p class="alternative-rationale"><MarkdownView source={alt.rationale} /></p>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</AiPanel>

<style>
  .alternatives-problem {
    margin: 0 0 0.75rem;
    font-size: 0.9rem;
    font-weight: 500;
    line-height: 1.45;
  }

  .alternatives-empty {
    margin: 0;
    font-size: 0.88rem;
    opacity: 0.6;
    font-style: italic;
  }

  .alternatives-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .alternative-card {
    padding: 0.65rem 0.75rem;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    background: var(--surface);
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .alternative-approach {
    margin: 0;
    font-size: 0.9rem;
    font-weight: 600;
    line-height: 1.4;
  }

  .alternative-tradeoffs {
    margin: 0;
    font-size: 0.875rem;
    opacity: 0.85;
    line-height: 1.45;
  }

  .assessment-chip {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 8px;
    font-size: 0.78rem;
    font-weight: 600;
    border: 1px solid currentColor;
    align-self: flex-start;
  }

  .assessment-chip.assessment-pr-is-better {
    color: var(--legend-added-color);
    background: var(--legend-added-bg);
    border-color: var(--legend-added-border);
  }

  .assessment-chip.assessment-comparable {
    color: var(--text-muted);
    background: var(--surface-raised);
  }

  .assessment-chip.assessment-alternative-is-better {
    color: var(--legend-changed-color);
    background: var(--legend-changed-bg);
    border-color: var(--legend-changed-border);
  }

  .assessment-chip.assessment-different-goals {
    color: var(--text-muted);
    background: var(--surface-raised);
  }

  .alternative-rationale {
    margin: 0;
    font-size: 0.8rem;
    opacity: 0.65;
    font-style: italic;
    line-height: 1.4;
  }

  /* MarkdownView inside tradeoffs/rationale: no block margins */
  .alternative-tradeoffs :global(.markdown-view),
  .alternative-rationale :global(.markdown-view) {
    font-size: inherit;
    line-height: inherit;
  }

  .alternative-tradeoffs :global(p),
  .alternative-rationale :global(p) {
    margin: 0;
  }
</style>
