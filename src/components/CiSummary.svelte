<script lang="ts">
  import type { CiSummary } from '../lib/github/checks'

  interface Props {
    ci: CiSummary | null
    error: boolean
  }

  let { ci, error }: Props = $props()
</script>

{#if error}
  <div class="ci-error" role="alert">Couldn't load CI status</div>
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
{:else if ci.failed === 0}
  <div class="ci-pass">
    All {ci.passed} check{ci.passed === 1 ? '' : 's'} passed
  </div>
{:else}
  <div class="ci-failures">
    <p class="ci-failures-summary">
      {ci.failed} check{ci.failed === 1 ? '' : 's'} failed
      {#if ci.passed > 0}· {ci.passed} passed{/if}
    </p>
    <ul class="ci-failures-list">
      {#each ci.failures as failure (failure.name)}
        <li class="ci-failure-item">
          <strong class="ci-failure-name">{failure.name}</strong>
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
{/if}

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
