<script lang="ts" module>
  export type Step = 1 | 2 | 3
</script>

<script lang="ts">
  let { step, onstep }: { step: Step; onstep: (s: Step) => void } = $props()
  const labels: Record<Step, string> = { 1: 'Understand', 2: 'Inspect', 3: 'Verdict' }
</script>

<nav class="stepper" aria-label="Review steps">
  {#each ([1, 2, 3] as const) as s}
    <button
      class="step-btn"
      class:active={s === step}
      onclick={() => onstep(s)}
      aria-current={s === step ? 'step' : undefined}
    >
      {s} · {labels[s]}
    </button>
  {/each}
</nav>

<style>
  .stepper {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem 0;
  }

  .step-btn {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 0.3rem 0.5rem 0.25rem;
    cursor: pointer;
    font-family: var(--font-ui);
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-muted);
    transition: border-color 150ms ease, color 150ms ease;
  }

  .step-btn:hover {
    color: var(--text);
  }

  .step-btn.active {
    color: var(--text);
    font-weight: 600;
    border-bottom-color: var(--accent);
  }

  .step-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 3px;
  }
</style>
