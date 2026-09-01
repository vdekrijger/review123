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
    /** The task's canned error sentence (PanelState.error) — hover detail on the error dot. */
    error?: string
    /** The concrete upstream failure detail (PanelState.errorDetail) — appended to the hover. */
    errorDetail?: string
  }

  let { status, title, error, errorDetail }: Props = $props()

  // Hover/tooltip text for the error dot: the canned sentence plus the concrete
  // upstream detail, when present. Only for 'error' — no-key/declined already
  // read clearly from their own panel states.
  const errorTooltip = $derived(
    status === 'error' ? [error, errorDetail].filter(Boolean).join(' — ') : ''
  )

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
  // Plan J: a task turned OFF in settings — a quiet muted "off" indicator
  // (not a spinner, not an error), mirroring the disabled section body.
  const disabled = $derived(status === 'disabled')
  // Intent check only: the task deliberately did not run because there was
  // nothing to check (empty PR description) — a quiet muted "n/a" indicator,
  // distinct from "off" (a user setting) and never an error.
  const skipped = $derived(status === 'skipped')
  // The task's request was cancelled (not failed): a quiet muted indicator in
  // the same family as "off"/"n/a" — never the problem dot, which reads as an
  // error the user has to act on.
  const cancelled = $derived(status === 'cancelled')

  // One quiet polite announcement per state. Empty while pending (the spinner is
  // visual; no need to announce "loading" repeatedly).
  const liveText = $derived(
    ready ? `${title} ready`
      : status === 'error' ? `${title} unavailable`
      : status === 'no-key' ? `${title} needs an API key`
      : status === 'declined' ? `${title} declined`
      : disabled ? `${title} disabled`
      : skipped ? `${title} skipped — nothing to check`
      : cancelled ? `${title} cancelled`
      : ''
  )
</script>

<span
  class="section-status"
  class:is-problem={problem}
  class:is-disabled={disabled || skipped || cancelled}
  class:has-error-detail={errorTooltip !== ''}
  title={errorTooltip !== '' ? errorTooltip : undefined}
  aria-label={errorTooltip !== '' ? `${title} unavailable: ${errorTooltip}` : undefined}
>
  {#if pending}
    <Spinner size="0.8em" />
  {:else if ready}
    <span class="section-status-ready" aria-hidden="true">✓</span>
  {:else if disabled}
    <span class="section-status-off" aria-hidden="true">off</span>
  {:else if skipped}
    <span class="section-status-off" aria-hidden="true">n/a</span>
  {:else if cancelled}
    <span class="section-status-off" aria-hidden="true">—</span>
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

  /* Error dot with a concrete failure reason on hover — invite the hover. */
  .has-error-detail {
    cursor: help;
  }

  .section-status-hint {
    font-size: 1em;
    line-height: 1;
    color: var(--text-muted, currentColor);
  }

  .is-disabled {
    opacity: 0.6;
  }

  .section-status-off {
    font-size: 0.68em;
    line-height: 1;
    text-transform: uppercase;
    letter-spacing: 0.04em;
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
