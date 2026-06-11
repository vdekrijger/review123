<script lang="ts">
  /**
   * UnderstandStep — summarizes the PR with a tighter, collapsible layout.
   *
   * Layout (top→bottom):
   *  1. Compact verdict strip (pill + CI counts) — click to expand evidence + notAnalyzed
   *  2. Summary card (AI summary rendered as markdown)
   *  3. Original PR description (collapsed by default, superseded by summary)
   *  4. Diagrams (open by default, collapsible)
   *
   * Security: summary uses {@html renderMarkdown()} — the ONLY acceptable use of
   * {@html} in this codebase, following the CommentEditor precedent.
   * renderMarkdown() runs marked → DOMPurify and is the single sanitization boundary.
   */
  import CiSummary from './CiSummary.svelte'
  import AiPanel from './AiPanel.svelte'
  import DiagramPanel from './DiagramPanel.svelte'
  import { renderMarkdown } from '../lib/markdown/render'
  import { stripReadingOrder } from '../lib/ai/tasks'
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

  // Derive the stripped, display-ready summary text
  const summaryText = $derived.by(() => {
    if (run.summary.status === 'done' || run.summary.status === 'streaming') {
      const raw = run.summary.value as string
      // While streaming, keep plain text (cheap); on done, strip the reading-order block
      return run.summary.status === 'done' ? stripReadingOrder(raw) : raw
    }
    return ''
  })

  // Rendered markdown — only computed when done (re-rendering per delta is wasteful)
  const summaryHtml = $derived(
    run.summary.status === 'done' ? renderMarkdown(summaryText) : ''
  )
</script>

<div class="understand-step">

  <!-- 1. Compact verdict + CI strip -->
  <section class="verdict-strip">
    <AiPanel title="Verdict" state={run.verdict} onretry={() => run.retry('verdict')}>
      {#if run.verdict.status === 'done'}
        {@const verdict = run.verdict.value as VerdictResult}
        <details class="verdict-expander">
          <summary class="verdict-summary-line">
            <span class="verdict-level level-{verdict.level}" aria-label="Verdict: {verdict.level}">
              {verdict.level}
            </span>
            <span class="ci-counts">
              <CiSummary {ci} error={ciError} />
            </span>
          </summary>
          <!-- Evidence + notAnalyzed inside the expander -->
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
        </details>
      {:else}
        <!-- Verdict loading: show CI inline -->
        <div class="verdict-loading-row">
          <CiSummary {ci} error={ciError} />
        </div>
      {/if}
    </AiPanel>
  </section>

  <!-- 2. Summary card (main read) -->
  <section class="ai-section summary-section">
    <h3 class="ai-section-title">Summary</h3>
    <AiPanel title="Summary" state={run.summary} onretry={() => run.retry('summary')}>
      {#if run.summary.status === 'streaming'}
        <!-- While streaming: plain text (cheap) -->
        <pre class="prose">{summaryText}</pre>
      {:else if run.summary.status === 'done'}
        <!-- Done: rendered markdown — sanitization via renderMarkdown() -->
        <!-- {@html} is acceptable ONLY with renderMarkdown() output (CommentEditor precedent) -->
        <div class="prose-md">{@html summaryHtml}</div>
      {/if}
    </AiPanel>
  </section>

  <!-- 3. PR description (collapsed — AI summary supersedes it) -->
  <details class="pr-description-details">
    <summary>Original PR description</summary>
    <div class="pr-description-body">
      <p>{meta.body ?? 'No description.'}</p>
    </div>
  </details>

  <!-- 4. Diagrams (open by default, collapsible) -->
  <details class="ai-section diagrams-details" open>
    <summary class="ai-section-title collapsible-title">Diagrams</summary>
    <AiPanel title="Diagrams" state={run.diagrams} onretry={() => run.retry('diagrams')}>
      {#if run.diagrams.status === 'done'}
        <DiagramPanel result={run.diagrams.value as GraphResult} panelState="idle" />
      {/if}
    </AiPanel>
  </details>

</div>

<style>
  .understand-step {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* ---- Verdict strip ---- */

  .verdict-strip {
    border-bottom: 1px solid #8882;
    padding-bottom: 0.75rem;
  }

  .verdict-expander > summary {
    list-style: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .verdict-expander > summary::-webkit-details-marker { display: none; }

  .verdict-summary-line {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .ci-counts {
    font-size: 0.85rem;
    opacity: 0.85;
  }

  .verdict-loading-row {
    display: flex;
    align-items: center;
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
    margin: 0.5rem 0 0 0;
    padding-left: 1.5em;
    font-size: 0.9rem;
  }

  .not-analyzed {
    margin-top: 0.5rem;
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
    font-family: var(--font-mono);
    opacity: 0.8;
  }

  /* ---- Summary section ---- */

  .ai-section {
    border-top: 1px solid #8882;
    padding-top: 0.75rem;
  }

  .summary-section {
    border-top: none;
  }

  .ai-section-title {
    margin: 0 0 0.5rem;
    font-size: 1rem;
    font-weight: 600;
  }

  .collapsible-title {
    cursor: pointer;
    user-select: none;
  }

  .prose {
    font-family: inherit;
    white-space: pre-wrap;
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.6;
    max-width: 72ch;
  }

  /* Normalize rendered markdown in the summary card */
  .prose-md {
    font-size: 0.9rem;
    line-height: 1.6;
    max-width: 72ch;
  }

  .prose-md :global(h1),
  .prose-md :global(h2),
  .prose-md :global(h3),
  .prose-md :global(h4) {
    margin: 0.75em 0 0.25em;
    font-size: 1em;
    font-weight: 600;
  }

  .prose-md :global(p) { margin: 0 0 0.5em; }
  .prose-md :global(p:last-child) { margin-bottom: 0; }
  .prose-md :global(ul),
  .prose-md :global(ol) { margin: 0 0 0.5em; padding-left: 1.5em; }
  .prose-md :global(li) { margin: 0.15em 0; }
  .prose-md :global(pre) { background: #8882; padding: 0.5rem; border-radius: 4px; overflow-x: auto; }
  .prose-md :global(code) { font-size: 0.85em; background: #8881; padding: 0.1em 0.3em; border-radius: 3px; }
  .prose-md :global(pre code) { background: none; padding: 0; }

  /* ---- PR description (collapsed) ---- */

  .pr-description-details {
    border-top: 1px solid #8882;
    padding-top: 0.5rem;
  }

  .pr-description-details > summary {
    cursor: pointer;
    font-size: 0.85rem;
    opacity: 0.7;
    font-weight: 500;
    list-style: none;
    user-select: none;
  }

  .pr-description-details > summary::-webkit-details-marker { display: none; }

  .pr-description-body {
    padding-top: 0.5rem;
  }

  .pr-description-body p {
    margin: 0;
    white-space: pre-wrap;
    font-size: 0.9rem;
    max-width: 72ch;
  }

  /* ---- Diagrams (collapsible) ---- */

  .diagrams-details {
    border-top: 1px solid #8882;
    padding-top: 0.5rem;
  }

  .diagrams-details > summary {
    list-style: none;
  }

  .diagrams-details > summary::-webkit-details-marker { display: none; }
</style>
