<script lang="ts">
  /**
   * Skeleton — content-shaped loading placeholder.
   *
   * Variants (shape per section, AI-skeletons fix):
   *   • text  (default): N text lines of varying width (summary / verdict prose)
   *   • block: one rectangular block (diagrams)
   *   • cards: two card-shaped blocks (test coverage / alternatives)
   */
  interface Props {
    lines?: number
    header?: boolean
    variant?: 'text' | 'block' | 'cards'
  }

  let { lines = 3, header = false, variant = 'text' }: Props = $props()

  // Varying line widths so the text variant reads as prose, not a grid.
  const LINE_WIDTHS = ['100%', '86%', '94%', '68%']
</script>

<div class="skeleton-block" aria-hidden="true">
  {#if header}
    <div class="skeleton-header"></div>
  {/if}
  {#if variant === 'block'}
    <div class="skeleton-rect"></div>
  {:else if variant === 'cards'}
    {#each { length: 2 } as _, i (i)}
      <div class="skeleton-card">
        <div class="skeleton-line" style="width: 55%"></div>
        <div class="skeleton-line" style="width: 90%"></div>
      </div>
    {/each}
  {:else}
    {#each { length: lines } as _, i (i)}
      <div
        class="skeleton-line"
        class:skeleton-line-short={i === lines - 1}
        style="width: {i === lines - 1 ? '65%' : LINE_WIDTHS[i % LINE_WIDTHS.length]}"
      ></div>
    {/each}
  {/if}
</div>

<style>
  .skeleton-block {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem 0;
  }

  .skeleton-header {
    height: 1.1em;
    width: 55%;
    background: var(--surface-raised, #2a2a3e);
    border-radius: 4px;
    animation: shimmer 1.4s ease-in-out infinite;
    margin-bottom: 0.25rem;
  }

  .skeleton-line {
    height: 0.85em;
    width: 100%;
    background: var(--surface-raised, #2a2a3e);
    border-radius: 4px;
    animation: shimmer 1.4s ease-in-out infinite;
  }

  .skeleton-rect {
    height: 9rem;
    width: 100%;
    background: var(--surface-raised, #2a2a3e);
    border-radius: 6px;
    animation: shimmer 1.4s ease-in-out infinite;
  }

  .skeleton-card {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    padding: 0.65rem 0.75rem;
    border: 1px solid var(--hairline, #2a2a3e);
    border-radius: 6px;
    animation: shimmer 1.4s ease-in-out infinite;
  }

  @keyframes shimmer {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton-header,
    .skeleton-line,
    .skeleton-rect,
    .skeleton-card {
      animation: none;
      opacity: 0.5;
    }
  }
</style>
