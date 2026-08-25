<script lang="ts">
  /**
   * IntentPanel — intent-vs-implementation check (Understand step).
   *
   * Renders the intent task's result:
   *   • skipped (no meaningful PR description) → a calm zero-token line:
   *     "No stated intent to check — the PR description is empty."
   *   • aligned (no unfulfilled promises, no unrequested changes) → ONE green
   *     line "Implementation matches the stated intent (N intents verified)"
   *     with the verified intents behind a quiet collapsed disclosure.
   *   • drift → grouped lists in signal order: UNFULFILLED first (highest
   *     signal — promised but missing), then NOTABLE unrequested, then MINOR
   *     unrequested collapsed; the verified intents follow, collapsed.
   *
   * Evidence links reuse the onhotspot jump (#203 risk-snippet idiom): click a
   * path → jump to that file's diff in the Inspect step.
   */
  import AiPanel from '../AiPanel.svelte'
  import MarkdownView from '../MarkdownView.svelte'
  import type { AiRun } from '../../lib/ai/run.svelte'
  import type { IntentCheckResult } from '../../lib/ai/schemas'

  interface Props {
    run: AiRun
    /** Called when an evidence/path link is clicked (jump to file in Inspect). */
    onhotspot?: (path: string) => void
  }

  let { run, onhotspot }: Props = $props()

  const intent = $derived(
    run.intent.status === 'done' ? (run.intent.value as IntentCheckResult) : null
  )

  const intentTextById = $derived.by(() => {
    const m = new Map<string, string>()
    for (const i of intent?.intents ?? []) m.set(i.id, i.text)
    return m
  })

  const notable = $derived((intent?.unrequested ?? []).filter((u) => u.significance === 'notable'))
  const minor = $derived((intent?.unrequested ?? []).filter((u) => u.significance === 'minor'))
  const unfulfilled = $derived(intent?.unfulfilled ?? [])
  const matched = $derived(intent?.matched ?? [])

  /** Aligned = nothing promised is missing AND nothing unexpected changed. */
  const aligned = $derived(
    intent !== null && unfulfilled.length === 0 && notable.length === 0 && minor.length === 0
  )
</script>

{#if run.intent.status === 'skipped'}
  <!-- Zero-token skip: null/blank/template-noise-only description. Calm, not
       an error — there simply is no stated intent to verify against. -->
  <p class="intent-skipped">No stated intent to check — the PR description is empty.</p>
{:else}
  <AiPanel title="Intent check" task="intent" state={run.intent} skeletonVariant="cards" onretry={() => run.retry('intent')}>
    {#if intent}
      {#if intent.intents.length === 0}
        <p class="intent-empty">No concrete promises found in the PR description — nothing to verify against.</p>
      {:else if aligned}
        <p class="intent-aligned">
          <span class="intent-aligned-check" aria-hidden="true">✓</span>
          Implementation matches the stated intent ({matched.length} intent{matched.length === 1 ? '' : 's'} verified)
        </p>
      {:else}
        {#if unfulfilled.length > 0}
          <p class="intent-group-heading intent-heading-unfulfilled">Unfulfilled — promised in the description, not found in the diff:</p>
          <ul class="intent-list" data-group="unfulfilled">
            {#each unfulfilled as u, i (`${u.intentId}:${i}`)}
              <li class="intent-item">
                <span class="intent-icon intent-icon-unfulfilled" aria-hidden="true">✗</span>
                <span class="intent-item-body">
                  <span class="intent-item-text"><MarkdownView source={intentTextById.get(u.intentId) ?? u.intentId} /></span>
                  <span class="intent-item-note"><MarkdownView source={u.note} /></span>
                </span>
              </li>
            {/each}
          </ul>
        {/if}
        {#if notable.length > 0}
          <p class="intent-group-heading intent-heading-unrequested">Unrequested — notable changes the description never asked for:</p>
          <ul class="intent-list" data-group="notable">
            {#each notable as u, i (`${u.description}:${i}`)}
              <li class="intent-item">
                <span class="intent-icon intent-icon-unrequested" aria-hidden="true">⚠</span>
                <span class="intent-item-body">
                  <span class="intent-item-text"><MarkdownView source={u.description} /></span>
                  {#if u.paths.length > 0}
                    <span class="intent-paths">
                      {#each u.paths as p (p)}
                        <button
                          type="button"
                          class="intent-path-link"
                          onclick={() => onhotspot?.(p)}
                          title="Open {p} in the diff"
                        >{p}</button>
                      {/each}
                    </span>
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
        {/if}
        {#if minor.length > 0}
          <details class="intent-minor" data-group="minor">
            <summary class="intent-minor-summary">{minor.length} minor unrequested change{minor.length === 1 ? '' : 's'} (formatting, churn, ride-alongs)</summary>
            <ul class="intent-list">
              {#each minor as u, i (`${u.description}:${i}`)}
                <li class="intent-item">
                  <span class="intent-icon intent-icon-minor" aria-hidden="true">·</span>
                  <span class="intent-item-body">
                    <span class="intent-item-text"><MarkdownView source={u.description} /></span>
                    {#if u.paths.length > 0}
                      <span class="intent-paths">
                        {#each u.paths as p (p)}
                          <button
                            type="button"
                            class="intent-path-link"
                            onclick={() => onhotspot?.(p)}
                            title="Open {p} in the diff"
                          >{p}</button>
                        {/each}
                      </span>
                    {/if}
                  </span>
                </li>
              {/each}
            </ul>
          </details>
        {/if}
      {/if}

      {#if matched.length > 0}
        <!-- The verified intents + their evidence, kept quiet (collapsed) so
             the drift groups above stay the headline. Open by default only in
             the aligned state, mirroring the tests-covered idiom. -->
        <details class="intent-matched" open={aligned}>
          <summary class="intent-matched-summary">
            <span class="intent-matched-check" aria-hidden="true">✓</span>
            {matched.length} intent{matched.length === 1 ? '' : 's'} verified
          </summary>
          <ul class="intent-list intent-matched-list">
            {#each matched as m, i (`${m.intentId}:${i}`)}
              <li class="intent-item">
                <span class="intent-item-body">
                  <span class="intent-item-text"><MarkdownView source={intentTextById.get(m.intentId) ?? m.intentId} /></span>
                  <span class="intent-item-note"><MarkdownView source={m.note} /></span>
                  {#if m.evidence.length > 0}
                    <span class="intent-paths">
                      {#each m.evidence as ev, k (`${ev.path}:${ev.line ?? ''}:${k}`)}
                        <button
                          type="button"
                          class="intent-path-link"
                          onclick={() => onhotspot?.(ev.path)}
                          title="Open {ev.path} in the diff"
                        >{ev.path}{ev.line != null ? `:${ev.line}` : ''}</button>
                      {/each}
                    </span>
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    {/if}
  </AiPanel>
{/if}

<style>
  .intent-skipped,
  .intent-empty {
    margin: 0;
    font-size: 0.88rem;
    font-style: italic;
    opacity: 0.6;
    padding: 0.4rem 0;
  }

  /* --- Aligned: one green line --- */
  .intent-aligned {
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.92rem;
    font-weight: 500;
    color: var(--legend-added-color);
  }

  .intent-aligned-check {
    font-weight: 700;
  }

  /* --- Group headings (drift state) --- */
  .intent-group-heading {
    margin: 0 0 0.4rem;
    font-size: 0.92rem;
    font-weight: 700;
  }

  .intent-group-heading + .intent-list {
    margin-bottom: 0.75rem;
  }

  .intent-heading-unfulfilled {
    color: var(--legend-removed-color);
  }

  .intent-heading-unrequested {
    color: var(--legend-changed-color);
  }

  /* --- Item lists --- */
  .intent-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .intent-item {
    display: flex;
    align-items: flex-start;
    gap: 0.45rem;
    padding: 0.3rem 0;
    font-size: 0.9rem;
    line-height: 1.45;
  }

  .intent-icon {
    flex-shrink: 0;
    font-weight: 700;
  }

  .intent-icon-unfulfilled { color: var(--legend-removed-color); }
  .intent-icon-unrequested { color: var(--legend-changed-color); }
  .intent-icon-minor { opacity: 0.5; }

  .intent-item-body {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .intent-item-note {
    font-size: 0.82rem;
    opacity: 0.65;
  }

  /* MarkdownView inside items: inline-level, no block margins */
  .intent-item-text :global(.markdown-view),
  .intent-item-note :global(.markdown-view) {
    font-size: inherit;
    line-height: inherit;
    display: inline;
  }

  .intent-item-text :global(p),
  .intent-item-note :global(p) {
    margin: 0;
  }

  /* --- Evidence / path links (jump to the file's diff) --- */
  .intent-paths {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .intent-path-link {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--accent);
    font-family: var(--font-mono, monospace);
    font-size: 0.75rem;
    text-decoration: underline;
    text-underline-offset: 2px;
    text-align: left;
  }

  .intent-path-link:hover { opacity: 0.75; }

  /* --- Minor unrequested (collapsed) --- */
  .intent-minor {
    margin: 0.35rem 0 0;
  }

  .intent-minor-summary {
    cursor: pointer;
    font-size: 0.82rem;
    color: var(--text-muted);
  }

  /* --- Verified intents (quiet confirmation strip) --- */
  .intent-matched {
    margin: 0.85rem 0 0;
    padding-top: 0.6rem;
    border-top: 1px solid var(--hairline);
  }

  /* In the aligned state the matched strip directly follows the green line. */
  .intent-aligned + .intent-matched {
    margin-top: 0.6rem;
  }

  .intent-matched-summary {
    cursor: pointer;
    font-size: 0.82rem;
    font-weight: 500;
    color: var(--text-muted);
  }

  .intent-matched-check {
    color: var(--legend-added-color);
    font-weight: 700;
  }

  .intent-matched-list {
    margin-top: 0.35rem;
    padding-left: 1.2rem;
  }
</style>
