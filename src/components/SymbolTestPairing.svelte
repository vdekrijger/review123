<script lang="ts">
  /**
   * SymbolTestPairing (Plan I) — inline, collapsible "Tested by <test>" affordance
   * shown beneath a changed function's diff in Story mode.
   *
   * Collapsed by default: shows the changed symbol, the leading test's title (or
   * file when untitled), a confidence label ("likely" for referenced-only pairs),
   * and a count when >1 test. Expanding reveals a read-only snippet of THAT test
   * block, sliced from the already-fetched test-file content (no re-fetch, no
   * FileDiff per snippet). Renders nothing when there is no paired test.
   */
  import type { SymbolTestPairing } from '../lib/diff/symbolTests'
  import { track } from '../lib/analytics/analytics'

  let {
    pairing,
    testContents,
  }: {
    pairing: SymbolTestPairing
    /** path → full (after) test-file content, for slicing the test block. */
    testContents: Map<string, string>
  } = $props()

  let expanded = $state(false)

  const lead = $derived(pairing.tests[0])
  const count = $derived(pairing.tests.length)
  // A pairing is only "named"-strength when its leading (best) test is named.
  const likely = $derived(lead.confidence !== 'named')

  const label = $derived(lead.title ? `\`${lead.title}\`` : lead.testFile)

  function snippetFor(testFile: string, range: { start: number; end: number }): string {
    const content = testContents.get(testFile)
    if (!content) return ''
    const lines = content.split('\n')
    const start = Math.max(1, range.start)
    const end = Math.min(lines.length, range.end)
    if (end < start) return ''
    return lines.slice(start - 1, end).join('\n')
  }

  function toggle(): void {
    expanded = !expanded
    if (expanded) track('symbol_test_expanded', { confidence: lead.confidence })
  }
</script>

<div class="sym-test" data-symbol={pairing.symbol}>
  <button
    type="button"
    class="sym-test-toggle"
    aria-expanded={expanded}
    onclick={toggle}
  >
    <span class="sym-test-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
    <span class="sym-test-text">
      Tested by <span class="sym-test-title">{label}</span>
      {#if likely}<span class="sym-test-likely">likely</span>{/if}
    </span>
    {#if count > 1}<span class="sym-test-count">{count} tests</span>{/if}
  </button>

  {#if expanded}
    <div class="sym-test-body">
      {#each pairing.tests as t (t.testFile + ':' + t.lineRange.start)}
        {@const snippet = snippetFor(t.testFile, t.lineRange)}
        <div class="sym-test-snippet">
          <div class="sym-test-snippet-head">
            <span class="sym-test-file">{t.testFile}</span>
            {#if t.confidence !== 'named'}<span class="sym-test-likely">likely</span>{/if}
          </div>
          {#if snippet}
            <pre class="sym-test-pre"><code>{snippet}{#if t.truncated}{'\n… (truncated)'}{/if}</code></pre>
          {:else}
            <p class="sym-test-empty">Test content unavailable for inline preview.</p>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .sym-test {
    border: 1px solid var(--border-subtle);
    border-radius: 5px;
    background: var(--surface-raised);
    margin-top: 0.35rem;
    overflow: hidden;
  }

  .sym-test-toggle {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    width: 100%;
    padding: 0.3rem 0.6rem;
    background: transparent;
    border: none;
    color: inherit;
    font-size: 0.78rem;
    cursor: pointer;
    text-align: left;
  }
  .sym-test-toggle:hover { background: var(--surface-hover, rgba(127, 127, 127, 0.08)); }

  .sym-test-caret {
    color: var(--text-muted);
    font-size: 0.7rem;
    width: 0.8rem;
    flex-shrink: 0;
  }

  .sym-test-text { flex: 1; }

  .sym-test-title {
    font-family: var(--mono, ui-monospace, monospace);
    color: var(--legend-changed-color);
  }

  .sym-test-likely {
    font-size: 0.62rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    border: 1px solid var(--border-subtle);
    border-radius: 3px;
    padding: 0.02rem 0.3rem;
    margin-left: 0.35rem;
  }

  .sym-test-count {
    font-size: 0.68rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .sym-test-body {
    border-top: 1px solid var(--border-subtle);
    padding: 0.4rem 0.6rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .sym-test-snippet-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.68rem;
    color: var(--text-muted);
    margin-bottom: 0.25rem;
  }

  .sym-test-file { font-family: var(--mono, ui-monospace, monospace); }

  .sym-test-pre {
    margin: 0;
    padding: 0.5rem 0.65rem;
    overflow-x: auto;
    background: var(--surface-sunken, var(--surface-raised));
    border: 1px solid var(--hairline);
    border-radius: 4px;
    font-size: 0.78rem;
    line-height: 1.45;
  }
  .sym-test-pre code {
    font-family: var(--mono, ui-monospace, monospace);
    white-space: pre;
  }

  .sym-test-empty {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-muted);
    font-style: italic;
  }
</style>
