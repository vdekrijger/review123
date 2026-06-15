<script lang="ts">
  /**
   * SectionStatus — compact per-section header run-state indicator.
   *
   * Lives in a collapsible section's HEADER (the clickable <summary> row) so the
   * user can tell AT A GLANCE — even when the section is COLLAPSED — whether that
   * section's AI content is still loading or ready. It reads the SAME per-task
   * run-state that drives AiProgress (PanelStatus); it does NOT add a parallel
   * state source.
   *
   * Treatment (subtle, themed, low-noise):
   *   • idle / loading / streaming  → the unified Spinner (content still coming).
   *   • done                        → no spinner (lowest-noise "ready"); a faint
   *                                   check is rendered only for screen-reader /
   *                                   visual confirmation, kept very quiet.
   *   • no-key / declined / error   → a tiny muted dot/hint mirroring how
   *                                   AiProgress/the panels surface those (not a
   *                                   spinner — the task is not running).
   *
   * Accessibility: an aria-live="polite" span announces "<title> ready" / errors
   * once, without spam. The visual glyphs are aria-hidden so the live text is the
   * single source of the announcement.
   *
   * Non-AI (synchronous) sections must NOT render this — pass status only for
   * AI-backed sections.
   */
  import Spinner from '../Spinner.svelte'
  import type { PanelStatus } from '../../lib/ai/run.svelte'

  interface Props {
    /** The AI task's run-state status (from the AiRun PanelState). */
    status: PanelStatus
    /** Section title — used only for the aria-live announcement ("<title> ready"). */
    title: string
  }

  let { status, title }: Props = $props()

  // Pending = the task is (or will be) running. 'idle' is the queued-before-loading
  // window the run signals before 'loading' — treat it as pending so the spinner
  // shows immediately rather than popping in late.
  const pending = $derived(
    status === 'idle' || status === 'loading' || status === 'streaming'
  )
  const ready = $derived(status === 'done')
  const problem = $derived(
    status === 'no-key' || status === 'declined' || status === 'error'
  )

  // One quiet polite announcement per state. Empty while pending (the spinner is
  // visual; no need to announce "loading" repeatedly).
  const liveText = $derived(
    ready ? `${title} ready`
      : status === 'error' ? `${title} unavailable`
      : status === 'no-key' ? `${title} needs an API key`
      : status === 'declined' ? `${title} declined`
      : ''
  )
</script>

<span class="section-status" class:is-problem={problem}>
  {#if pending}
    <Spinner size="0.8em" />
  {:else if ready}
    <span class="section-status-ready" aria-hidden="true">✓</span>
  {:else if problem}
    <span class="section-status-hint" aria-hidden="true">·</span>
  {/if}
  <span class="section-status-live" aria-live="polite">{liveText}</span>
</span>

<style>
  .section-status {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    /* Subtle by default — the spinner/check inherit currentColor via the token. */
    opacity: 0.7;
  }

  .section-status-ready {
    font-size: 0.85em;
    line-height: 1;
    color: var(--legend-added-color, currentColor);
    opacity: 0.55;
  }

  .is-problem {
    opacity: 0.85;
  }

  .section-status-hint {
    font-size: 1em;
    line-height: 1;
    color: var(--text-muted, currentColor);
  }

  /* Visually-hidden live region: announced by SRs, invisible on screen. */
  .section-status-live {
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
</style>
