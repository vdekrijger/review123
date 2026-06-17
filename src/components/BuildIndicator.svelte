<script lang="ts">
  import { BUILD_SHA, BUILD_TIME, commitUrl, repoUrl } from '../lib/buildInfo'

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
  <span class="build-meta">
    build
    {#if href}
      <a class="commit-link" {href} target="_blank" rel="noopener noreferrer">{BUILD_SHA}</a>
    {:else}
      <span class="sha">{BUILD_SHA}</span>
    {/if}
    <span aria-hidden="true"> · </span>{shortBuildTime(BUILD_TIME)}
  </span>

  <!-- Source link, pinned bottom-right, next to the build provenance. -->
  <a
    class="gh-link"
    href={repoUrl}
    target="_blank"
    rel="noopener noreferrer"
    aria-label="Review 1-2-3 source on GitHub"
  >
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
    <span class="gh-label">GitHub</span>
  </a>
</footer>

<style>
  .build-indicator {
    /* Tiny, muted, unobtrusive — themed via the shared CSS variables so it
       reads correctly in both light and dark. The build provenance stays
       centered; the GitHub source link is pinned to the bottom-right. */
    position: relative;
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

  /* GitHub source link — pinned to the right edge, vertically centered. */
  .gh-link {
    position: absolute;
    right: 1rem;
    top: 50%;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .gh-link:hover,
  .gh-link:focus-visible {
    text-decoration: none;
  }
  .gh-link svg {
    display: block;
  }

  /* Drop the text label on narrow viewports so the icon never collides with
     the centered build text — the aria-label keeps it accessible. */
  @media (max-width: 30rem) {
    .gh-label {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
  }
</style>
