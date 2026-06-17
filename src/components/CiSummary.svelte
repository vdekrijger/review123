<script lang="ts">
  import type { CiSummary } from '../lib/github/checks'

  interface Props {
    ci: CiSummary | null
    error: boolean
    /**
     * Re-read CI status without a page reload. Covers BOTH the loaded states
     * (the user re-ran CI on GitHub and wants the fresh result) and the error
     * state (a Retry after "Couldn't load CI status"). The tool can only RE-READ
     * status — it can't trigger GitHub to re-run a check (that needs the Actions
     * re-run API + write scopes); the per-check GitHub links cover re-running.
     */
    onRefreshCi?: () => void
    /** True while a refresh is in flight — disables the control + shows progress. */
    refreshing?: boolean
  }

  let { ci, error, onRefreshCi, refreshing = false }: Props = $props()
</script>

{#if error}
  <div class="ci-error" role="alert">
    <span>Couldn't load CI status</span>
    {#if onRefreshCi}
      <button
        type="button"
        class="ci-refresh-btn"
        onclick={onRefreshCi}
        disabled={refreshing}
        aria-label="Retry loading CI status"
      >
        {refreshing ? 'Retrying…' : 'Retry'}
      </button>
    {/if}
  </div>
{:else if ci === null}
  <div class="ci-loading" aria-busy="true">
    <span class="skeleton"></span>
    <span class="sr-only">Loading CI status…</span>
  </div>
{:else if ci.total === 0}
  <div class="ci-none">No CI configured</div>
{:else if ci.pending > 0}
  <div class="ci-pending">
    CI pending — {ci.pending} check{ci.pending === 1 ? '' : 's'} running
    {#if ci.passed > 0}
      · {ci.passed} passed
    {/if}
    {#if ci.failed > 0}
      · {ci.failed} failed
    {/if}
  </div>
  {@render refreshControl()}
{:else if ci.failed === 0}
  <div class="ci-pass">
    All {ci.passed} check{ci.passed === 1 ? '' : 's'} passed
  </div>
  {@render refreshControl()}
{:else}
  <div class="ci-failures">
    <p class="ci-failures-summary">
      {ci.failed} check{ci.failed === 1 ? '' : 's'} failed
      {#if ci.passed > 0}· {ci.passed} passed{/if}
    </p>
    <ul class="ci-failures-list">
      {#each ci.failures as failure (failure.name)}
        <li class="ci-failure-item">
          {#if failure.url}
            <a
              class="ci-failure-name ci-failure-link"
              href={failure.url}
              target="_blank"
              rel="noopener noreferrer"
            >{failure.name}<span class="ci-failure-ext" aria-hidden="true"> ↗</span></a>
          {:else}
            <strong class="ci-failure-name">{failure.name}</strong>
          {/if}
          {#if failure.annotations.length > 0}
            <ul class="ci-annotations">
              {#each failure.annotations as annotation}
                <li class="ci-annotation">{annotation}</li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
  {@render refreshControl()}
{/if}

{#snippet refreshControl()}
  {#if onRefreshCi}
    <div class="ci-refresh-row">
      <button
        type="button"
        class="ci-refresh-btn"
        onclick={onRefreshCi}
        disabled={refreshing}
        aria-label="Refresh CI status"
      >
        {refreshing ? 'Refreshing…' : 'Refresh CI status'}
      </button>
    </div>
  {/if}
{/snippet}

<style>
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }

  .skeleton {
    display: inline-block;
    width: 160px;
    height: 1em;
    background: var(--surface-raised);
    border-radius: 4px;
    animation: pulse 1.4s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .ci-pass {
    color: var(--legend-added-color);
  }

  .ci-pending {
    color: var(--legend-changed-color);
  }

  .ci-failures-summary {
    color: var(--legend-removed-color);
    margin: 0 0 0.5em;
  }

  .ci-failures-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .ci-failure-item {
    margin-bottom: 0.75em;
  }

  .ci-failure-name {
    display: block;
  }

  .ci-failure-link {
    color: var(--legend-removed-color);
    text-decoration: underline;
    font-weight: 600;
    width: fit-content;
  }

  .ci-failure-link:hover {
    text-decoration: none;
  }

  .ci-failure-ext {
    font-size: 0.85em;
    opacity: 0.7;
  }

  /* Error state: message + Retry on one row */
  .ci-error {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    color: var(--legend-removed-color);
  }

  .ci-refresh-row {
    margin-top: 0.6rem;
  }

  .ci-refresh-btn {
    background: none;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--text-muted);
    padding: 0.2rem 0.55rem;
    transition: background 0.1s, color 0.1s;
  }

  .ci-refresh-btn:hover:not(:disabled) {
    background: #8881;
    color: var(--text);
  }

  .ci-refresh-btn:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .ci-annotations {
    list-style: disc;
    padding-left: 1.5em;
    margin: 0.25em 0 0;
  }

  .ci-annotation {
    font-family: var(--font-mono);
    font-size: 0.85em;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
