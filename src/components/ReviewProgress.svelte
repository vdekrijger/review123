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
    /* --topbar-h, NOT --topbar-height: this read was misspelled from the day it
       was written, so it silently used the 48px fallback for its whole life
       (a var() typo is invalid-at-computed-value-time, never a build error).
       Measured in the built app: --topbar-h resolves to 41.25px (2.75rem at
       the :root 15px font-size) and the header's own rect is 41.25px, while
       the misspelled read resolved to its 48px fallback — so this rule parked
       the bar 6.75px BELOW the topbar it is meant to sit directly under.

       WHAT THAT COST IN PRACTICE: nothing yet, and the reason is worth knowing
       before someone "verifies the fix" by looking for a moved pixel. This
       rule is on the STANDALONE variant, and the app's only call site
       (Review.svelte) passes `inline`, so the standalone branch has no
       renderer today — it is a supported, unit-tested default (`inline=false`)
       that nothing currently mounts. The 6.75px was therefore latent, not
       visible: two independent reasons this was inert, and fixing the spelling
       removes the one that would have bitten silently the moment the variant
       came back. The fallback matches the peer reads in ContextRail,
       PreviewPanel, FileDiff and SettingsPage. */
    top: var(--topbar-h, 2.75rem);
    left: 0;
    right: 0;
    z-index: var(--z-progress);
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
