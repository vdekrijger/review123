<script lang="ts" module>
  export type Step = 1 | 2 | 3
</script>

<script lang="ts">
  let { step, onstep }: { step: Step; onstep: (s: Step) => void } = $props()
  const labels: Record<Step, string> = { 1: 'Understand', 2: 'Inspect', 3: 'Verdict' }
</script>

<nav class="stepper" aria-label="Review steps">
  {#each ([1, 2, 3] as const) as s}
    <button class:active={s === step} onclick={() => onstep(s)} aria-current={s === step ? 'step' : undefined}>
      {s} · {labels[s]}
    </button>
  {/each}
</nav>

<style>
  .stepper { display: flex; gap: 0.5rem; padding: 0.5rem 0; }
  button.active { font-weight: 700; border-bottom: 2px solid currentColor; }
</style>
