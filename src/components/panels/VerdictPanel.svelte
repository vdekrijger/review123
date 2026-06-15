<script lang="ts">
  import AiPanel from '../AiPanel.svelte'
  import MarkdownView from '../MarkdownView.svelte'
  import type { AiRun } from '../../lib/ai/run.svelte'
  import type { VerdictResult } from '../../lib/ai/schemas'

  interface Props {
    run: AiRun
    /** Called when an evidence path chip is clicked. */
    onhotspot?: (path: string) => void
  }

  let { run, onhotspot }: Props = $props()

  const verdict = $derived(
    run.verdict.status === 'done' ? (run.verdict.value as VerdictResult) : null
  )

  // Clamping + expand
  const EVIDENCE_CLAMP = 5
  let evidenceExpanded = $state(false)

  // Parse an evidence item into an optional leading path chip + remaining text.
  const PATH_RE = /[\w@./-]+\.[\w]+/

  interface EvidenceRow {
    path: string | null
    text: string
  }

  function parseEvidenceItem(item: string): EvidenceRow {
    const m = item.match(PATH_RE)
    if (!m) return { path: null, text: item }
    const path = m[0]
    const rest = item.slice(0, m.index).trimEnd() + item.slice(m.index! + path.length)
    const text = rest.replace(/^[-–—:\s]+/, '').trimStart()
    return { path, text: text || item }
  }
</script>

<AiPanel title="Verdict" task="verdict" state={run.verdict} onretry={() => run.retry('verdict')}>
  {#if verdict}
    <p class="verdict-explainer">The specific observations the AI based the behavior verdict on — each row cites what changed and where.</p>
    {#if verdict.evidence.length > 0}
      {@const visibleEvidence = evidenceExpanded
        ? verdict.evidence
        : verdict.evidence.slice(0, EVIDENCE_CLAMP)}
      <ul class="verdict-evidence">
        {#each visibleEvidence as item (item)}
          {@const row = parseEvidenceItem(item)}
          <li class="verdict-evidence-row">
            {#if row.path}
              <button
                class="evidence-path-chip"
                onclick={() => onhotspot?.(row.path!)}
                title="Jump to {row.path}"
                aria-label="Jump to {row.path}"
              >{row.path}</button>
            {/if}
            <span class="evidence-text">
              <MarkdownView source={row.text} />
            </span>
          </li>
        {/each}
      </ul>
      {#if verdict.evidence.length > EVIDENCE_CLAMP}
        <button
          class="evidence-expander"
          onclick={() => { evidenceExpanded = !evidenceExpanded }}
          aria-expanded={evidenceExpanded}
        >
          {evidenceExpanded
            ? 'Show less'
            : `Show all ${verdict.evidence.length}`}
        </button>
      {/if}
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
  {/if}
</AiPanel>

<style>
  .verdict-explainer {
    margin: 0 0 0.6rem;
    font-size: 0.8rem;
    opacity: 0.55;
    font-style: italic;
    line-height: 1.4;
  }

  .verdict-evidence {
    margin: 0 0 0.5rem 0;
    padding-left: 0;
    list-style: none;
    font-size: 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .verdict-evidence-row {
    display: block;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--hairline);
  }

  .verdict-evidence-row:last-child {
    border-bottom: none;
  }

  .evidence-path-chip {
    display: inline-block;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    background: var(--surface-raised);
    border: 1px solid var(--hairline);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--accent);
    cursor: pointer;
    white-space: nowrap;
    text-decoration: none;
    transition: background 100ms;
    margin-bottom: 0.25rem;
  }

  .evidence-path-chip:hover {
    background: var(--accent-subtle);
    border-color: var(--accent);
  }

  .evidence-text {
    display: block;
    font-family: var(--font-prose);
    font-size: 0.9rem;
    line-height: 1.5;
    width: 100%;
  }

  /* MarkdownView inside evidence-text: inline, no block margins */
  .evidence-text :global(.markdown-view) {
    font-size: inherit;
    line-height: inherit;
  }

  .evidence-text :global(p) {
    margin: 0;
  }

  .evidence-text :global(code) {
    font-size: 0.85em;
    background: var(--surface-raised);
    padding: 0.1em 0.3em;
    border-radius: 3px;
  }

  .evidence-expander {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.82rem;
    color: var(--accent);
    padding: 0.2rem 0;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .evidence-expander:hover {
    opacity: 0.75;
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
    font-family: var(--font-mono, monospace);
    opacity: 0.8;
  }
</style>
