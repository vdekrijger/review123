<script lang="ts">
  import CiSummary from './CiSummary.svelte'
  import AiPanel from './AiPanel.svelte'
  import DiagramPanel from './DiagramPanel.svelte'
  import type { PrMeta } from '../lib/github/types'
  import type { CiSummary as CiSummaryType } from '../lib/github/checks'
  import type { AiRun } from '../lib/ai/run.svelte'
  import type { GraphResult, VerdictResult } from '../lib/ai/schemas'

  interface Props {
    meta: PrMeta
    ci: CiSummaryType | null
    ciError: boolean
    run: AiRun
  }

  let { meta, ci, ciError, run }: Props = $props()
</script>

<div class="understand-step">
  <!-- PR description -->
  <section class="pr-description">
    <p>{meta.body ?? 'No description.'}</p>
  </section>

  <!-- CI status -->
  <section class="ci-section">
    <CiSummary {ci} error={ciError} />
  </section>

  <!-- Summary panel -->
  <section class="ai-section">
    <h3 class="ai-section-title">Summary</h3>
    <AiPanel title="Summary" state={run.summary} onretry={() => run.retry('summary')}>
      {#if run.summary.status === 'done' || run.summary.status === 'streaming'}
        {@const text = run.summary.value as string}
        <pre class="prose">{text}</pre>
      {/if}
    </AiPanel>
  </section>

  <!-- Diagrams panel -->
  <section class="ai-section">
    <h3 class="ai-section-title">Diagrams</h3>
    <AiPanel title="Diagrams" state={run.diagrams} onretry={() => run.retry('diagrams')}>
      {#if run.diagrams.status === 'done'}
        <DiagramPanel result={run.diagrams.value as GraphResult} panelState="idle" />
      {/if}
    </AiPanel>
  </section>

  <!-- Verdict panel -->
  <section class="ai-section">
    <h3 class="ai-section-title">Verdict</h3>
    <AiPanel title="Verdict" state={run.verdict} onretry={() => run.retry('verdict')}>
      {#if run.verdict.status === 'done'}
        {@const verdict = run.verdict.value as VerdictResult}
        <div class="verdict-result">
          <div class="verdict-level level-{verdict.level}">
            {verdict.level}
          </div>
          {#if verdict.evidence.length > 0}
            <ul class="verdict-evidence">
              {#each verdict.evidence as item}
                <li>{item}</li>
              {/each}
            </ul>
          {/if}
          {#if verdict.notAnalyzed.length > 0}
            <div class="not-analyzed">
              <h4>Not analyzed</h4>
              <ul>
                {#each verdict.notAnalyzed as path}
                  <li>{path}</li>
                {/each}
              </ul>
            </div>
          {/if}
        </div>
      {/if}
    </AiPanel>
  </section>
</div>

<style>
  .understand-step {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .pr-description p {
    margin: 0;
    white-space: pre-wrap;
  }

  .ai-section {
    border-top: 1px solid #8882;
    padding-top: 1rem;
  }

  .ai-section-title {
    margin: 0 0 0.75rem;
    font-size: 1rem;
    font-weight: 600;
  }

  .prose {
    font-family: inherit;
    white-space: pre-wrap;
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.5;
  }

  .verdict-result {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .verdict-level {
    display: inline-block;
    padding: 0.2rem 0.6rem;
    border-radius: 12px;
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid currentColor;
  }

  .verdict-level.level-behavior-preserved {
    color: #1a7f37;
    background: #1a7f3715;
  }

  .verdict-level.level-minor-changes {
    color: #9a6700;
    background: #9a670015;
  }

  .verdict-level.level-significant-changes {
    color: #cf222e;
    background: #cf222e15;
  }

  .verdict-evidence {
    margin: 0;
    padding-left: 1.5em;
    font-size: 0.9rem;
  }

  .not-analyzed {
    margin-top: 0.25rem;
  }

  .not-analyzed h4 {
    margin: 0 0 0.4rem;
    font-size: 0.9rem;
    font-weight: 600;
    opacity: 0.75;
  }

  .not-analyzed ul {
    margin: 0;
    padding-left: 1.5em;
    font-size: 0.85rem;
    font-family: monospace;
    opacity: 0.8;
  }
</style>
