<script lang="ts">
  /**
   * OutcomesPanel — expected-outcomes check (Understand step).
   *
   * Renders the outcomes task's result:
   *   • numbered outcome rows, each a compact before → after pair with
   *     evidence links (onhotspot jump — the intent-panel idiom) and a
   *     DETERMINISTIC test chip: the outcome's `symbols` are resolved against
   *     the PR's changed test-file contents via matchOutcomeTests (#95
   *     machinery) — "✓ asserted by `X.test.ts`" ("(likely)" for
   *     referenced-only matches, mirroring #95's confidence language) or the
   *     honest, calm "no test asserts this outcome".
   *   • empty outcomes → "No observable behavior changes derived" (legitimate
   *     for pure refactors — calm, never an error).
   *   • withoutThis → a quiet footer line ("Without this change: …").
   *
   * The test chips render only once contentsMap is READY (non-null): before
   * the file contents arrive we make no claim about test evidence at all.
   * The join is pure client-side post-processing — no LLM involvement.
   *
   * ──────────────────────────────────────────────────────────────────────────
   * MAKING AN OUTCOME ACTIONABLE
   *
   * Each row already states a concrete before → after claim. When the pull
   * request is checked out locally AND the dev server is answering, that claim
   * is CHECKABLE right now — so each row grows a "Try it" link onto the
   * running app.
   *
   * It opens the app's ROOT, not a route derived from the outcome. Deriving a
   * route would mean the outcomes task emitting one per outcome (a prompt
   * change), and a guessed route would send the reviewer to a 404 while
   * implying the app disagreed with the claim. A link that lands somewhere
   * real and lets them navigate is honest; a guessed deep link is not.
   *
   * The state is read from the `stackState` module singleton rather than
   * threaded down — the same idiom GroundingIndicator uses for `bridgeState`.
   */
  import AiPanel from '../AiPanel.svelte'
  import MarkdownView from '../MarkdownView.svelte'
  import { matchOutcomeTests, type TestFileContent, type OutcomeTestRef } from '../../lib/ai/outcomeTests'
  import { isTestFile } from '../../lib/testFile'
  import { stackState } from '../../lib/bridge/runPr.svelte'
  import type { AiRun } from '../../lib/ai/run.svelte'
  import type { ExpectedOutcomesResult } from '../../lib/ai/schemas'
  import type { PrFile } from '../../lib/github/types'

  interface Props {
    run: AiRun
    /** The PR's changed files — the source of candidate test files. */
    files: PrFile[]
    /** Already-fetched full file contents (null = not yet fetched). */
    contentsMap: Map<string, { before: string | null; after: string | null }> | null
    /** Called when an evidence/test link is clicked (jump to file in Inspect). */
    onhotspot?: (path: string) => void
    /**
     * The PR's head sha. Without it no "Try it" link renders at all: a local
     * app serving some OTHER branch must never be offered as a way to check
     * this pull request's outcomes.
     */
    headSha?: string
  }

  let { run, files, contentsMap, onhotspot, headSha }: Props = $props()

  /**
   * The running app, but only when it is running THIS pull request. Both
   * halves are required — checked out, and answering — because either alone
   * would send the reviewer somewhere that cannot support the claim.
   */
  const localApp = $derived.by(() => {
    if (headSha === undefined || !stackState.onPrBranch(headSha)) return null
    const app = stackState.app
    return app !== null && app.reachable && app.url !== null ? app.url : null
  })

  const outcomes = $derived(
    run.outcomes.status === 'done' ? (run.outcomes.value as ExpectedOutcomesResult) : null
  )

  // Changed test files whose NEW contents are available — the deterministic
  // join's search space. Empty until contentsMap resolves.
  const testContents = $derived.by(() => {
    const out: TestFileContent[] = []
    if (!contentsMap) return out
    for (const f of files) {
      if (!isTestFile(f.filename)) continue
      const after = contentsMap.get(f.filename)?.after
      if (after) out.push({ path: f.filename, content: after })
    }
    return out
  })

  // Per-outcome test refs, aligned by index with outcomes.outcomes.
  const testRefs = $derived.by<OutcomeTestRef[][]>(() => {
    if (!outcomes) return []
    return outcomes.outcomes.map((o) => matchOutcomeTests(o.symbols, testContents))
  })

  const chipsReady = $derived(contentsMap !== null)
</script>

<AiPanel title="Expected outcomes" task="outcomes" state={run.outcomes} skeletonVariant="cards" onretry={() => run.retry('outcomes')}>
  {#if outcomes}
    {#if outcomes.outcomes.length === 0}
      <p class="outcomes-empty">No observable behavior changes derived from this diff — expected for a pure refactor or cosmetic change.</p>
    {:else}
      <ol class="outcome-list">
        {#each outcomes.outcomes as o, i (`${o.id}:${i}`)}
          <li class="outcome-item">
            <div class="outcome-ba">
              <span class="outcome-before">
                <span class="ba-label">Before</span>
                <span class="ba-text"><MarkdownView source={o.before} /></span>
              </span>
              <span class="outcome-arrow" aria-hidden="true">→</span>
              <span class="outcome-after">
                <span class="ba-label">After</span>
                <span class="ba-text"><MarkdownView source={o.after} /></span>
              </span>
            </div>
            <div class="outcome-meta">
              {#if o.evidence.length > 0}
                <span class="outcome-paths">
                  {#each o.evidence as ev, k (`${ev.path}:${ev.line ?? ''}:${k}`)}
                    <button
                      type="button"
                      class="outcome-path-link"
                      onclick={() => onhotspot?.(ev.path)}
                      title="Open {ev.path} in the diff"
                    >{ev.path}{ev.line != null ? `:${ev.line}` : ''}</button>
                  {/each}
                </span>
              {/if}
              {#if chipsReady}
                {@const refs = testRefs[i] ?? []}
                {#if refs.length > 0}
                  <span class="outcome-test-chip outcome-test-asserted" title={refs[0].title ? `Named in: ${refs[0].title}` : `${refs[0].testFile} references ${o.symbols.join(', ')}`}>
                    <span class="chip-check" aria-hidden="true">✓</span>
                    asserted by
                    <button
                      type="button"
                      class="outcome-test-link"
                      onclick={() => onhotspot?.(refs[0].testFile)}
                      title="Open {refs[0].testFile} in the diff"
                    ><code>{refs[0].testFile}</code></button>
                    {#if refs[0].confidence !== 'named'}<span class="chip-likely">(likely)</span>{/if}
                    {#if refs.length > 1}<span class="chip-more">+{refs.length - 1} more</span>{/if}
                  </span>
                {:else}
                  <span class="outcome-test-chip outcome-test-none">no test asserts this outcome</span>
                {/if}
              {/if}
              {#if localApp !== null}
                <a
                  class="outcome-try"
                  data-testid="outcome-try"
                  href={localApp}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open your local app, which is running this pull request"
                >Try it <span aria-hidden="true">↗</span></a>
              {/if}
            </div>
          </li>
        {/each}
      </ol>
    {/if}

    {#if outcomes.withoutThis.trim() !== ''}
      <p class="outcomes-without">
        <span class="without-label">Without this change:</span>
        <span class="without-text"><MarkdownView source={outcomes.withoutThis} /></span>
      </p>
    {/if}
  {/if}
</AiPanel>

<style>
  .outcomes-empty {
    margin: 0;
    font-size: 0.88rem;
    font-style: italic;
    opacity: 0.6;
    padding: 0.4rem 0;
  }

  /* --- Numbered outcome rows --- */
  .outcome-list {
    margin: 0;
    padding-left: 1.4rem;
  }

  .outcome-item {
    padding: 0.35rem 0;
    font-size: 0.9rem;
    line-height: 1.45;
  }

  .outcome-item + .outcome-item {
    border-top: 1px solid var(--hairline);
  }

  /* --- Compact before → after pair --- */
  .outcome-ba {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .outcome-before,
  .outcome-after {
    display: inline;
  }

  .ba-label {
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.55;
    margin-right: 0.3rem;
  }

  .outcome-before .ba-text {
    opacity: 0.75;
  }

  .outcome-arrow {
    opacity: 0.5;
  }

  /* MarkdownView inside rows: inline-level, no block margins */
  .ba-text :global(.markdown-view),
  .without-text :global(.markdown-view) {
    font-size: inherit;
    line-height: inherit;
    display: inline;
  }

  .ba-text :global(p),
  .without-text :global(p) {
    margin: 0;
    display: inline;
  }

  /* --- Evidence links + test chip row --- */
  .outcome-meta {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.6rem;
    margin-top: 0.2rem;
  }

  .outcome-paths {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .outcome-path-link {
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

  .outcome-path-link:hover { opacity: 0.75; }

  /* --- Deterministic test chip --- */
  .outcome-test-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.3rem;
    font-size: 0.75rem;
  }

  .outcome-test-asserted {
    color: var(--legend-added-color);
  }

  .chip-check {
    font-weight: 700;
  }

  .outcome-test-link {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: inherit;
    font-size: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .outcome-test-link code {
    font-family: var(--font-mono, monospace);
    font-size: 0.75rem;
  }

  .chip-likely,
  .chip-more {
    opacity: 0.65;
    font-style: italic;
  }

  /* Calm, not alarming: a quiet muted note, never a red warning. */
  .outcome-test-none {
    color: var(--text-muted);
    font-style: italic;
  }

  /* "Try it" — only present when the claim is actually checkable right now,
     so it can afford to be quiet rather than shouting for attention. */
  .outcome-try {
    font-size: 0.75rem;
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
    white-space: nowrap;
  }

  .outcome-try:hover,
  .outcome-try:focus-visible {
    opacity: 0.75;
  }

  /* --- "Without this change" footer --- */
  .outcomes-without {
    margin: 0.85rem 0 0;
    padding-top: 0.6rem;
    border-top: 1px solid var(--hairline);
    font-size: 0.82rem;
    color: var(--text-muted);
  }

  .without-label {
    font-weight: 600;
    margin-right: 0.3rem;
  }
</style>
