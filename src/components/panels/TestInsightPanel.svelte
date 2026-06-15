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
    {#if tests.covered.length > 0}
      <p class="tests-ai-inferred-note">AI-inferred — not measured coverage</p>
      <ul class="tests-covered-list">
        {#each tests.covered as item (item.behavior)}
          <li class="tests-covered-item">
            <span class="tests-covered-check">✓</span>
            <span class="tests-covered-content">
              <span class="tests-covered-behavior"><MarkdownView source={item.behavior} /></span>
              <span class="tests-covered-meta">
                {item.test} ·
                <button
                  class="tests-file-link"
                  onclick={() => onhotspot?.(item.file)}
                  title="Jump to {item.file} in Inspect"
                  aria-label="Jump to {item.file}"
                >{item.file}</button>
              </span>
            </span>
          </li>
        {/each}
      </ul>
    {/if}
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
    {#if tests.covered.length === 0 && tests.gaps.length === 0}
      <p class="tests-empty">No AI-inferred test coverage data available.</p>
    {/if}
  {/if}
</AiPanel>

<style>
  .tests-ai-inferred-note {
    margin: 0 0 0.6rem;
    font-size: 0.8rem;
    opacity: 0.6;
    font-style: italic;
  }

  .tests-covered-list,
  .tests-gaps-list {
    list-style: none;
    margin: 0 0 0.75rem;
    padding: 0;
  }

  .tests-covered-item {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    padding: 0.25rem 0;
    border-bottom: 1px solid #8881;
    font-size: 0.88rem;
  }

  .tests-covered-item:last-child { border-bottom: none; }

  .tests-covered-check {
    color: var(--legend-added-color);
    font-weight: 700;
    flex-shrink: 0;
    margin-top: 0.05rem;
  }

  .tests-covered-content {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }

  .tests-covered-behavior {
    font-weight: 500;
  }

  .tests-covered-meta {
    font-size: 0.78rem;
    opacity: 0.65;
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

  .tests-gaps-heading {
    margin: 0 0 0.4rem;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--legend-changed-color);
  }

  .tests-gap-item {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    padding: 0.2rem 0;
    font-size: 0.88rem;
  }

  .tests-gap-icon {
    color: var(--legend-changed-color);
    font-weight: 700;
    flex-shrink: 0;
  }

  .tests-gap-text {
    opacity: 0.9;
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
