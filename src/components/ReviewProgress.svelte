<script lang="ts">
  import type { Step } from './Stepper.svelte'

  let { viewedCount, fileCount, draftCount, step }: {
    viewedCount: number
    fileCount: number
    draftCount: number
    step: Step
  } = $props()

  const percent = $derived.by(() => {
    const stepWeight = step >= 2 ? 15 : 0
    const fileWeight = fileCount > 0 ? 70 * (viewedCount / fileCount) : 0
    const step3Weight = step >= 3 ? 15 : 0
    return Math.max(0, Math.min(100, Math.round(stepWeight + fileWeight + step3Weight)))
  })
</script>

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
    {viewedCount}/{fileCount} files viewed · {draftCount} drafts
  </div>
</div>

<style>
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
</style>
