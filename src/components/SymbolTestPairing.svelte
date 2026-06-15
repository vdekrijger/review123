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
  import { snippetLangForFilename, highlightSnippet } from '../lib/diff/highlightSnippet'

  let {
    pairing,
    testContents,
    prPathSet = new Set(),
    onJumpToFile = null,
  }: {
    pairing: SymbolTestPairing
    /** path → full (after) test-file content, for slicing the test block. */
    testContents: Map<string, string>
    /** Set of the PR's changed-file paths, to label each test in/out of the diff. */
    prPathSet?: Set<string>
    /** Jump to a test file's story step (only called for files in the diff). */
    onJumpToFile?: ((path: string) => void) | null
  } = $props()

  let expanded = $state(false)

  /** Whether a paired test file is part of THIS PR's changed files. */
  function inThisPr(testFile: string): boolean {
    return prPathSet.has(testFile)
  }

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
        {@const isInPr = inThisPr(t.testFile)}
        <div class="sym-test-snippet">
          <div class="sym-test-snippet-head">
            {#if isInPr && onJumpToFile}
              <!-- In the PR diff → clickable path that jumps to its story step. -->
              <button
                type="button"
                class="sym-test-file sym-test-jump"
                onclick={() => onJumpToFile?.(t.testFile)}
              >{t.testFile}</button>
              <span class="sym-test-chip sym-test-chip-pr">in this PR</span>
            {:else}
              <span class="sym-test-file">{t.testFile}</span>
              <span class="sym-test-chip sym-test-chip-existing">existing test</span>
            {/if}
            {#if t.confidence !== 'named'}<span class="sym-test-likely">likely</span>{/if}
          </div>
          {#if snippet}
            {#await highlightSnippet(snippet, snippetLangForFilename(t.testFile))}
              <pre class="sym-test-pre"><code>{snippet}{#if t.truncated}{'\n… (truncated)'}{/if}</code></pre>
            {:then highlighted}
              <pre class="sym-test-pre"><code>{@html highlighted}{#if t.truncated}{'\n… (truncated)'}{/if}</code></pre>
            {/await}
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

  /* Clickable path for a test that IS in this PR's diff (jumps to its step). */
  .sym-test-jump {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .sym-test-jump:hover { color: var(--accent); filter: brightness(1.15); }

  .sym-test-chip {
    font-size: 0.62rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-radius: 3px;
    padding: 0.02rem 0.32rem;
    border: 1px solid var(--border-subtle);
  }
  /* "in this PR" — accent chip so it reads as part of the review. */
  .sym-test-chip-pr {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-subtle);
  }
  /* "existing test" — muted chip so it reads as reference context. */
  .sym-test-chip-existing {
    color: var(--text-muted);
    background: var(--surface-raised);
  }

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

  /* ---------------------------------------------------------------------------
   * Syntax-highlight token colors for the inline snippet.
   *
   * Same engine as the diff (highlight.js → `hljs-*` span classes). The diff
   * viewer scopes its own token colors to its wrapper, so we re-declare the
   * GitHub prettylights palette here, scoped to the snippet. Defaults are the
   * DARK palette (the app's base theme); a light override mirrors how app.css
   * themes — explicit [data-theme='light'] plus the auto prefers-color-scheme
   * case — so tokens stay readable on the snippet background in BOTH themes.
   * ------------------------------------------------------------------------- */
  .sym-test-pre :global(.hljs-doctag),
  .sym-test-pre :global(.hljs-keyword),
  .sym-test-pre :global(.hljs-meta .hljs-keyword),
  .sym-test-pre :global(.hljs-template-tag),
  .sym-test-pre :global(.hljs-template-variable),
  .sym-test-pre :global(.hljs-type),
  .sym-test-pre :global(.hljs-variable.language_) { color: #ff7b72; }
  .sym-test-pre :global(.hljs-title),
  .sym-test-pre :global(.hljs-title.class_),
  .sym-test-pre :global(.hljs-title.function_) { color: #d2a8ff; }
  .sym-test-pre :global(.hljs-attr),
  .sym-test-pre :global(.hljs-attribute),
  .sym-test-pre :global(.hljs-literal),
  .sym-test-pre :global(.hljs-meta),
  .sym-test-pre :global(.hljs-number),
  .sym-test-pre :global(.hljs-operator),
  .sym-test-pre :global(.hljs-variable),
  .sym-test-pre :global(.hljs-selector-attr),
  .sym-test-pre :global(.hljs-selector-class),
  .sym-test-pre :global(.hljs-selector-id) { color: #79c0ff; }
  .sym-test-pre :global(.hljs-regexp),
  .sym-test-pre :global(.hljs-string),
  .sym-test-pre :global(.hljs-meta .hljs-string) { color: #a5d6ff; }
  .sym-test-pre :global(.hljs-built_in),
  .sym-test-pre :global(.hljs-symbol) { color: #ffa657; }
  .sym-test-pre :global(.hljs-comment),
  .sym-test-pre :global(.hljs-code),
  .sym-test-pre :global(.hljs-formula) { color: #8b949e; }
  .sym-test-pre :global(.hljs-name),
  .sym-test-pre :global(.hljs-quote),
  .sym-test-pre :global(.hljs-selector-tag),
  .sym-test-pre :global(.hljs-selector-pseudo) { color: #7ee787; }
  .sym-test-pre :global(.hljs-emphasis) { font-style: italic; }
  .sym-test-pre :global(.hljs-strong) { font-weight: bold; }

  /* Light palette (GitHub light) — explicit theme + auto preference. */
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-doctag),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-keyword),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-meta .hljs-keyword),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-template-tag),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-template-variable),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-type),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-variable.language_) { color: #d73a49; }
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-title),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-title.class_),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-title.function_) { color: #6f42c1; }
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-attr),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-attribute),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-literal),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-meta),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-number),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-operator),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-variable),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-selector-attr),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-selector-class),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-selector-id) { color: #005cc5; }
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-regexp),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-string),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-meta .hljs-string) { color: #032f62; }
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-built_in),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-symbol) { color: #e36209; }
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-comment),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-code),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-formula) { color: #6a737d; }
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-name),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-quote),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-selector-tag),
  :global(:root[data-theme='light']) .sym-test-pre :global(.hljs-selector-pseudo) { color: #22863a; }

  @media (prefers-color-scheme: light) {
    :global(:root:not([data-theme])) .sym-test-pre :global(.hljs-doctag),
    :global(:root:not([data-theme])) .sym-test-pre :global(.hljs-keyword),
    :global(:root:not([data-theme])) .sym-test-pre :global(.hljs-type),
    :global(:root:not([data-theme])) .sym-test-pre :global(.hljs-variable.language_) { color: #d73a49; }
    :global(:root:not([data-theme])) .sym-test-pre :global(.hljs-title),
    :global(:root:not([data-theme])) .sym-test-pre :global(.hljs-title.function_) { color: #6f42c1; }
    :global(:root:not([data-theme])) .sym-test-pre :global(.hljs-attr),
    :global(:root:not([data-theme])) .sym-test-pre :global(.hljs-literal),
    :global(:root:not([data-theme])) .sym-test-pre :global(.hljs-number),
    :global(:root:not([data-theme])) .sym-test-pre :global(.hljs-selector-id) { color: #005cc5; }
    :global(:root:not([data-theme])) .sym-test-pre :global(.hljs-regexp),
    :global(:root:not([data-theme])) .sym-test-pre :global(.hljs-string) { color: #032f62; }
    :global(:root:not([data-theme])) .sym-test-pre :global(.hljs-built_in),
    :global(:root:not([data-theme])) .sym-test-pre :global(.hljs-symbol) { color: #e36209; }
    :global(:root:not([data-theme])) .sym-test-pre :global(.hljs-comment) { color: #6a737d; }
    :global(:root:not([data-theme])) .sym-test-pre :global(.hljs-name),
    :global(:root:not([data-theme])) .sym-test-pre :global(.hljs-selector-tag),
    :global(:root:not([data-theme])) .sym-test-pre :global(.hljs-selector-pseudo) { color: #22863a; }
  }

  .sym-test-empty {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-muted);
    font-style: italic;
  }
</style>
