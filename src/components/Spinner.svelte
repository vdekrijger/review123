<script lang="ts">
  /**
   * Spinner — the ONE inline spinner token.
   *
   * Used only for genuine inline micro-cases where a full AiProgress block does
   * not fit: the Test-connection button, the queue Refresh button, the "Run my
   * reviewers" / "Analyze my comments" / "Coach my comments" buttons. Every
   * divergent bespoke spinner (.run-spinner, .mine-spinner, .refresh-spinner,
   * .spinner-sm, .chip-spinner, …) collapses onto this single themed token.
   *
   * Themed via currentColor + --text/--text-muted so it works in both light and
   * dark, and respects prefers-reduced-motion.
   */
  interface Props {
    /** em-relative size; defaults to a button-inline 0.8em. */
    size?: string
  }
  let { size = '0.8em' }: Props = $props()
</script>

<span class="ui-spinner" aria-hidden="true" style="--ui-spinner-size: {size}"></span>

<style>
  .ui-spinner {
    display: inline-block;
    width: var(--ui-spinner-size, 0.8em);
    height: var(--ui-spinner-size, 0.8em);
    border: 2px solid var(--text-muted, currentColor);
    border-top-color: var(--text, currentColor);
    border-radius: 50%;
    animation: ui-spin 0.7s linear infinite;
    flex-shrink: 0;
    vertical-align: middle;
  }

  @keyframes ui-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ui-spinner {
      animation: none;
    }
  }
</style>
