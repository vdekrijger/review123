<script lang="ts">
  /**
   * GitHubSignInButton — official-style "Sign in with GitHub" button.
   *
   * Props:
   *   onclick  - Handler fired when the button is clicked (sync or async).
   *   label    - Button text (default: "Sign in with GitHub").
   *   compact  - When true, collapses to an icon-only chip below 700px
   *              (for the navbar); the accessible name is preserved.
   *
   * Style: GitHub brand button — dark #24292f background, white text, Octocat
   * mark inline SVG, 6px radius, 8px 16px padding, font-weight 500.
   * In dark contexts, a subtle border (#444c56) prevents dark-on-dark invisibility.
   *
   * EXCEPTION: #24292f is GitHub brand-intentional — do not convert to CSS vars.
   */

  interface Props {
    onclick: () => void | Promise<void>
    label?: string
    compact?: boolean
  }

  let { onclick, label = 'Sign in with GitHub', compact = false }: Props = $props()
</script>

<button type="button" class="gh-signin-btn" class:compact aria-label={label} {onclick}>
  <!-- Official GitHub Octocat mark — viewBox 0 0 16 16 -->
  <svg
    class="gh-mark"
    viewBox="0 0 16 16"
    aria-hidden="true"
    focusable="false"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      fill="currentColor"
      d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
         0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
         -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66
         .07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15
         -.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27
         .68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12
         .51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48
         0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
    />
  </svg>
  <span class="btn-label">{label}</span>
</button>

<style>
  .gh-signin-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    background: #24292f;
    color: #fff;
    border: 1px solid transparent;
    border-radius: 6px;
    font-size: 0.95rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
    white-space: nowrap;
  }

  .gh-signin-btn:hover {
    background: #2f363d;
  }

  /* Subtle border for dark-on-dark contexts */
  :global([data-theme='dark']) .gh-signin-btn {
    border-color: #444c56;
  }

  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme])) .gh-signin-btn {
      border-color: #444c56;
    }
  }

  .gh-mark {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
  }

  /* Compact mode (navbar): icon-only chip on narrow screens */
  @media (max-width: 700px) {
    .gh-signin-btn.compact {
      padding: 8px 10px;
    }
    .gh-signin-btn.compact .btn-label {
      display: none;
    }
  }
</style>
