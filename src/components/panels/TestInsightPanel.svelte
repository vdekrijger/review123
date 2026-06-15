<script lang="ts">
  import AiPanel from '../AiPanel.svelte'
  import MarkdownView from '../MarkdownView.svelte'
  import type { AiRun } from '../../lib/ai/run.svelte'
  import type { TestInsight } from '../../lib/ai/schemas'

  interface Props {
    run: AiRun
    /** Called when a file link is clicked (jump to file in Inspect step). */
    onhotspot?: (path: string) => void
    /** Ref for programmatic open (UnderstandStep glance chip). */
    detailsEl?: HTMLDetailsElement
  }

  let { run, onhotspot, detailsEl = $bindable() }: Props = $props()

  const tests = $derived(
    run.tests.status === 'done' ? (run.tests.value as TestInsight) : null
  )

  // --- Test gap grouping (ai-quality-round2) ---
  // Regex: gap starts with a file path (word chars, @, dots, hyphens, slashes,
  // with a dot-extension), followed by an optional colon and space.
  const GAP_PATH_RE = /^([\w@./-]+\.[\w]+):?\s*/

  interface GapGroup {
    file: string | null  // null → "General" bucket
    items: string[]      // gap text with the path prefix stripped
  }

  const gapGroups = $derived.by((): GapGroup[] => {
    if (!tests) return []
    const map = new Map<string, string[]>()
    const GENERAL = '\x00general'
    for (const gap of tests.gaps) {
      const m = gap.match(GAP_PATH_RE)
      if (m) {
        const file = m[1]
        const rest = gap.slice(m[0].length).trim() || gap
        const key = file === 'General' ? GENERAL : file
        if (!map.has(key)) map.set(key, [])
        map.get(key)!.push(rest)
      } else {
        if (!map.has(GENERAL)) map.set(GENERAL, [])
        map.get(GENERAL)!.push(gap)
      }
    }
    const result: GapGroup[] = []
    for (const [key, items] of map) {
      result.push({ file: key === GENERAL ? null : key, items })
    }
    return result
  })
</script>

<AiPanel title="Test coverage (AI-inferred)" task="tests" state={run.tests} skeletonVariant="cards" onretry={() => run.retry('tests')}>
  {#if tests}
    {#if tests.gaps.length > 0}
      <p class="tests-gaps-heading">AI-inferred gaps — behaviors changed without test coverage:</p>
      {#each gapGroups as group (group.file ?? 'General')}
        {#if group.file}
          <button
            class="tests-gap-file-header"
            onclick={() => onhotspot?.(group.file!)}
            title="Jump to {group.file} in Inspect"
            aria-label="Jump to {group.file}"
          >{group.file}</button>
        {:else}
          <p class="tests-gap-file-header tests-gap-general-header" aria-label="Jump to General">General</p>
        {/if}
        <ul class="tests-gaps-list tests-gaps-group-list">
          {#each group.items as item (item)}
            <li class="tests-gap-item">
              <span class="tests-gap-icon">⚠</span>
              <span class="tests-gap-text"><MarkdownView source={item} /></span>
            </li>
          {/each}
        </ul>
      {/each}
    {/if}
    {#if tests.covered.length > 0}
      <details class="tests-covered" open={tests.gaps.length === 0}>
        <summary class="tests-covered-summary">
          <span class="tests-covered-check">✓</span>
          {tests.covered.length}
          {tests.covered.length === 1 ? 'behavior' : 'behaviors'} covered
          <span class="tests-covered-note">· AI-inferred, not measured</span>
        </summary>
        <ul class="tests-covered-list">
          {#each tests.covered as item (item.behavior)}
            <li
              class="tests-covered-item tests-covered-item--compact"
              title="{item.test} — {item.file}"
            >
              <span class="tests-covered-behavior"><MarkdownView source={item.behavior} /></span>
              <button
                class="tests-file-link tests-file-link--compact"
                onclick={() => onhotspot?.(item.file)}
                title="Jump to {item.file} in Inspect ({item.test})"
                aria-label="Jump to {item.file}"
              >{item.file}</button>
            </li>
          {/each}
        </ul>
      </details>
    {/if}
    {#if tests.covered.length === 0 && tests.gaps.length === 0}
      <p class="tests-empty">No AI-inferred test coverage data available.</p>
    {/if}
  {/if}
</AiPanel>

<style>
  .tests-gaps-list {
    list-style: none;
    margin: 0 0 0.75rem;
    padding: 0;
  }

  /* --- Covered (compacted, recessive confirmation strip) --- */
  .tests-covered {
    margin: 0.85rem 0 0;
    padding-top: 0.6rem;
    border-top: 1px solid var(--hairline);
  }

  .tests-covered-summary {
    gap: 0.35rem;
    padding: 0;
    font-size: 0.82rem;
    font-weight: 500;
    text-transform: none;
    letter-spacing: normal;
    color: var(--text-muted);
  }

  .tests-covered-note {
    font-style: italic;
    opacity: 0.7;
  }

  .tests-covered-list {
    list-style: none;
    margin: 0.35rem 0 0;
    padding: 0 0 0 1.2rem;
  }

  .tests-covered-check {
    color: var(--legend-added-color);
    font-weight: 700;
    flex-shrink: 0;
  }

  .tests-covered-item--compact {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.08rem 0;
    font-size: 0.8rem;
    color: var(--text-muted);
    line-height: 1.35;
  }

  .tests-covered-behavior {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 auto;
  }

  .tests-file-link {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--accent);
    font-size: inherit;
    font-family: var(--font-mono, monospace);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .tests-file-link:hover { opacity: 0.75; }

  /* Compact file link: muted + truncated, surfaces fully on hover */
  .tests-file-link--compact {
    flex-shrink: 0;
    max-width: 9rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.55;
    font-size: 0.72rem;
    text-decoration: none;
  }

  .tests-file-link--compact:hover {
    opacity: 1;
    text-decoration: underline;
  }

  /* --- Gaps (prominent, the actionable part) --- */
  .tests-gaps-heading {
    margin: 0 0 0.5rem;
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--legend-changed-color);
  }

  .tests-gap-item {
    display: flex;
    align-items: flex-start;
    gap: 0.45rem;
    padding: 0.3rem 0;
    font-size: 0.9rem;
    line-height: 1.45;
  }

  .tests-gap-icon {
    color: var(--legend-changed-color);
    font-weight: 700;
    flex-shrink: 0;
  }

  .tests-gap-text {
    opacity: 1;
  }

  /* MarkdownView inside gap/behavior: inline-level, no block margins */
  .tests-gap-text :global(.markdown-view),
  .tests-covered-behavior :global(.markdown-view) {
    font-size: inherit;
    line-height: inherit;
    display: inline;
  }

  .tests-gap-text :global(p),
  .tests-covered-behavior :global(p) {
    margin: 0;
  }

  .tests-gap-file-header {
    display: inline-flex;
    align-items: center;
    margin: 0.5rem 0 0.2rem;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    background: var(--surface-raised);
    border: 1px solid var(--hairline);
    font-family: var(--font-mono, monospace);
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--accent);
    cursor: pointer;
    text-decoration: none;
    transition: background 100ms;
    white-space: nowrap;
  }

  .tests-gap-file-header:hover {
    background: var(--accent-subtle);
    border-color: var(--accent);
  }

  .tests-gap-general-header {
    cursor: default;
    color: var(--text-muted);
  }

  .tests-gap-general-header:hover {
    background: var(--surface-raised);
    border-color: var(--hairline);
  }

  .tests-gaps-group-list {
    margin-left: 0.75rem;
  }

  .tests-empty {
    margin: 0;
    font-size: 0.88rem;
    opacity: 0.6;
    font-style: italic;
  }
</style>
