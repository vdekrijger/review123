<script lang="ts">
  import { BUILD_SHA, BUILD_TIME, commitUrl } from '../lib/buildInfo'

  // commitUrl is null for non-commit sentinels ('dev'/'test'), so those render
  // as plain muted text rather than a broken link.
  const href = commitUrl(BUILD_SHA)

  // BUILD_TIME is an ISO timestamp on real builds; under vitest it's the 'test'
  // sentinel. Render a short, locale date when it parses, else the raw value.
  function shortBuildTime(value: string): string {
    const ms = Date.parse(value)
    if (Number.isNaN(ms)) return value
    return new Date(ms).toISOString().slice(0, 10)
  }
</script>

<footer class="build-indicator">
  build
  {#if href}
    <a {href} target="_blank" rel="noopener noreferrer">{BUILD_SHA}</a>
  {:else}
    <span class="sha">{BUILD_SHA}</span>
  {/if}
  <span aria-hidden="true"> · </span>{shortBuildTime(BUILD_TIME)}
</footer>

<style>
  .build-indicator {
    /* Tiny, muted, unobtrusive — themed via the shared CSS variables so it
       reads correctly in both light and dark. */
    padding: 0.5rem 1rem;
    font-size: 0.72rem;
    line-height: 1.4;
    color: var(--text-muted);
    text-align: center;
    border-top: 1px solid var(--hairline);
    background: var(--surface);
    font-family: var(--font-mono, ui-monospace, monospace);
    letter-spacing: 0.01em;
  }
  .build-indicator a,
  .build-indicator .sha {
    color: var(--text-muted);
    text-decoration: none;
  }
  .build-indicator a:hover,
  .build-indicator a:focus-visible {
    color: var(--text);
    text-decoration: underline;
  }
</style>
