<script lang="ts">
  /**
   * SecretInput — masked key/token field with a show/hide eye toggle.
   *
   * Shared by AiModelsSection (per-provider API keys) and ProvidersSection
   * (PAT/token fields). Masked (type=password) by default; the inline eye
   * button reveals the plain text for visual verification of pasted keys.
   * The value is never logged or sent anywhere by this component — the
   * toggle only flips the input's type attribute locally.
   *
   * The input's type is dynamic, so the value is wired manually (oninput)
   * instead of bind:value, which requires a static type attribute.
   */
  interface Props {
    value: string
    placeholder?: string
    /** Optional explicit accessible name for the input (else the wrapping label applies). */
    ariaLabel?: string
  }

  let { value = $bindable(), placeholder, ariaLabel }: Props = $props()

  let revealed = $state(false)
  const toggleLabel = $derived(revealed ? 'Hide key' : 'Show key')
</script>

<span class="secret-input">
  <input
    type={revealed ? 'text' : 'password'}
    {value}
    oninput={(e) => (value = e.currentTarget.value)}
    autocomplete="off"
    spellcheck="false"
    {placeholder}
    aria-label={ariaLabel}
  />
  <button
    type="button"
    class="reveal-toggle"
    aria-label={toggleLabel}
    aria-pressed={revealed}
    title={toggleLabel}
    onclick={() => (revealed = !revealed)}
  >
    {#if revealed}
      <!-- eye-off icon -->
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
        <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
        <line x1="1" y1="1" x2="23" y2="23" />
      </svg>
    {:else}
      <!-- eye icon -->
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    {/if}
  </button>
</span>

<style>
  /* Inline-flex row: the input keeps the global primitive chrome; the eye
     button overlays the right edge so the row reads as ONE field. */
  .secret-input {
    position: relative;
    display: flex;
    align-items: center;
    width: 100%;
  }

  .secret-input input {
    flex: 1;
    width: 100%;
    /* room for the eye button */
    padding-right: 2.1rem;
  }

  .reveal-toggle {
    position: absolute;
    right: 0.3rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.6rem;
    height: 1.6rem;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    transition: color 150ms ease, background-color 150ms ease;
  }

  .reveal-toggle:hover {
    background: var(--surface-raised);
    color: var(--text);
  }

  .reveal-toggle:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--accent-subtle);
    color: var(--accent);
  }

  /* Revealed state: the accent marks the field as currently unmasked. */
  .reveal-toggle[aria-pressed='true'] {
    color: var(--accent);
  }
</style>
