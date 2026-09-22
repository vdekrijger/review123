<script lang="ts">
  /**
   * GroundingIndicator — where this review's code is being read from, and why.
   *
   * The bridge can make grounding free, instant and repo-wide, but only when
   * the checkout it serves is actually this PR. When it is not, the review
   * silently goes back to the provider API — and a silent fallback is exactly
   * the thing this feature must not have. A user who started a bridge and
   * believes their reviews now read the whole repo deserves to be told the
   * moment that stops being true, and told WHY, in shas they can check.
   *
   * So this renders in three states and never in a fourth:
   *   - local, clean tree  — a quiet confirmation.
   *   - local, DIRTY tree  — used, and flagged: a finding may be grounded in
   *                          code that is in no commit of this PR.
   *   - github, with a reason — but ONLY when the user has a bridge paired.
   *                          Telling someone who has never heard of the bridge
   *                          that they are "falling back" is noise, not honesty.
   */
  import { bridgeState } from '../lib/bridge/bridge.svelte'
  import { currentGrounding, describeGrounding } from '../lib/bridge/grounding'

  interface Props {
    /** The PR's head sha — the thing the bridge's head must equal. */
    headSha: string
  }

  const { headSha }: Props = $props()

  const status = $derived(currentGrounding(headSha))

  /**
   * A GitHub-grounded review is the normal, unremarkable case for everyone who
   * has never paired a bridge. The indicator appears only when there is
   * something the user did not already know: local grounding is on, or they
   * have a bridge and it is NOT being used.
   */
  const visible = $derived(status.mode === 'local' || bridgeState.paired)

  const tone = $derived(
    status.mode === 'local' ? (status.dirty ? 'warn' : 'on') : 'off',
  )

  const label = $derived(
    status.mode === 'local'
      ? status.dirty
        ? 'Local checkout (uncommitted changes)'
        : 'Local checkout'
      : 'GitHub',
  )
</script>

{#if visible}
  <p class="grounding" data-testid="grounding-indicator" data-mode={status.mode} data-reason={status.reason}>
    <span class="dot {tone}" aria-hidden="true"></span>
    <span class="label" data-testid="grounding-label">Code from: {label}</span>
    <span class="why" data-testid="grounding-why">{describeGrounding(status)}</span>
  </p>
{/if}

<style>
  .grounding {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.5rem;
    margin: 0 0 0.75rem;
    font-size: 0.78em;
    line-height: 1.5;
    color: var(--text-muted);
  }

  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    flex-shrink: 0;
    align-self: center;
    background: var(--text-muted);
    opacity: 0.45;
  }

  .dot.on {
    background: var(--accent);
    opacity: 1;
  }

  /* The repo's theme-aware "changed" amber (it flips between light and dark in
     app.css). A dirty tree is not an error, so it must not borrow the red used
     for failures — but it is not the all-clear green either. */
  .dot.warn {
    background: var(--legend-changed-color);
    opacity: 1;
  }

  .label {
    color: var(--text);
    font-weight: 500;
  }

  .why {
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>
