<script lang="ts">
  import type { Step } from './Stepper.svelte'

  let { viewedCount, fileCount, draftCount = 0, step, percent = 0, inline = false }: {
    viewedCount: number
    fileCount: number
    /** @deprecated No longer used in label; kept for API compat during migration. */
    draftCount?: number
    step: Step
    /** Scroll percent (0–100) computed by the parent for step 2. */
    percent?: number
    /** When true, renders a compact inline variant for the sticky footer. */
    inline?: boolean
  } = $props()

  // Step gate: only show on step 2 (Inspect)
  const showBar = $derived(step === 2)
</script>

{#if showBar}
  {#if inline}
    <!-- Compact inline variant for sticky footer -->
    <div
      class="review-progress-inline"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemax={100}
      aria-label="Review progress: {percent}%"
    >
      <span class="progress-pct">{percent}% · {viewedCount}/{fileCount} viewed</span>
      <div class="progress-track-inline" aria-hidden="true">
        <div class="progress-fill-inline" style="width: {percent}%"></div>
      </div>
    </div>
  {:else}
    <!-- Standalone full-width variant -->
    <div
      class="review-progress"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemax={100}
      aria-label="Review progress: {percent}%"
    >
      <div class="progress-track">
        <div class="progress-fill" style="width: {percent}%"></div>
      </div>
      <div class="progress-label">
        {percent}% · {viewedCount}/{fileCount} viewed
      </div>
    </div>
  {/if}
{/if}

<style>
  /* ── Standalone variant ── */
  .review-progress {
    position: fixed;
    top: var(--topbar-height, 48px);
    left: 0;
    right: 0;
    z-index: 90;
  }

  .progress-track {
    height: 3px;
    width: 100%;
    background: var(--border-subtle, #3a4060);
    position: relative;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent, #4a90d0);
    transition: width 0.3s ease;
  }

  .progress-label {
    position: absolute;
    top: 3px;
    right: 1rem;
    background: var(--surface-raised, #1a1a2e);
    border: 1px solid var(--border-subtle, #3a4060);
    border-radius: 4px;
    padding: 0.25rem 0.5rem;
    font-size: 0.78rem;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease;
    color: var(--text-muted, #8090a0);
  }

  .review-progress:hover .progress-label,
  .review-progress:focus-within .progress-label {
    opacity: 1;
  }

  /* ── Compact inline variant for sticky footer ── */
  .review-progress-inline {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex: 1;
    min-width: 0;
  }

  .progress-pct {
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--text-muted, #9a9890);
    white-space: nowrap;
    font-family: var(--font-ui);
  }

  .progress-track-inline {
    flex: 1;
    height: 6px;
    background: var(--hairline, #2e333b);
    border-radius: 3px;
    overflow: hidden;
    min-width: 0;
  }

  .progress-fill-inline {
    height: 100%;
    background: var(--accent, #4db6a0);
    border-radius: 3px;
    transition: width 0.3s ease;
  }
</style>
