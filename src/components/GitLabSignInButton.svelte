<script lang="ts">
  /**
   * GitLabSignInButton — "Sign in with GitLab" button.
   *
   * Gated by VITE_GITLAB_CLIENT_ID (same pattern as GitHub's gate on VITE_GITHUB_CLIENT_ID).
   * Only rendered when the env var is set at build time.
   *
   * Props:
   *   onclick  - Handler fired when the button is clicked (sync or async).
   *   label    - Button text (default: "Sign in with GitLab").
   *   compact  - When true, collapses to an icon-only chip below 700px
   *              (for the navbar); the accessible name is preserved.
   *
   * Style: GitLab brand — #FC6D26 orange, white text, GitLab Tanuki SVG mark,
   * 6px radius, 8px 16px padding, font-weight 500.
   * EXCEPTION: #FC6D26 / #E24329 are GitLab brand-intentional — do not convert to CSS vars.
   */

  const clientId =
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GITLAB_CLIENT_ID) || ''

  interface Props {
    onclick: () => void | Promise<void>
    label?: string
    compact?: boolean
  }

  let { onclick, label = 'Sign in with GitLab', compact = false }: Props = $props()
</script>

{#if clientId}
  <button type="button" class="gl-signin-btn" class:compact aria-label={label} {onclick}>
    <!-- GitLab Tanuki mark — simplified SVG, viewBox 0 0 24 24 -->
    <svg
      class="gl-mark"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fill="currentColor"
        d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 0 1 4.82 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0 1 18.6 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.51 1.22 3.78a.84.84 0 0 1-.3.94z"
      />
    </svg>
    <span class="btn-label">{label}</span>
  </button>
{/if}

<style>
  .gl-signin-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    background: #FC6D26;
    color: #fff;
    border: 1px solid transparent;
    border-radius: 6px;
    font-size: 0.95rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
    white-space: nowrap;
  }

  .gl-signin-btn:hover {
    background: #E24329;
  }

  /* Subtle border for dark-on-dark contexts */
  :global([data-theme='dark']) .gl-signin-btn {
    border-color: rgba(255, 255, 255, 0.15);
  }

  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme])) .gl-signin-btn {
      border-color: rgba(255, 255, 255, 0.15);
    }
  }

  .gl-mark {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
  }

  /* Compact mode (navbar): icon-only chip on narrow screens */
  @media (max-width: 700px) {
    .gl-signin-btn.compact {
      padding: 8px 10px;
    }
    .gl-signin-btn.compact .btn-label {
      display: none;
    }
  }
</style>
