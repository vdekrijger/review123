<script lang="ts">
  interface Props {
    lines?: number
    header?: boolean
  }

  let { lines = 3, header = false }: Props = $props()
</script>

<div class="skeleton-block" aria-hidden="true">
  {#if header}
    <div class="skeleton-header"></div>
  {/if}
  {#each { length: lines } as _, i (i)}
    <div class="skeleton-line" class:skeleton-line-short={i === lines - 1}></div>
  {/each}
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

  .skeleton-line-short {
    width: 65%;
  }

  @keyframes shimmer {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton-header,
    .skeleton-line {
      animation: none;
      opacity: 0.5;
    }
  }
</style>
