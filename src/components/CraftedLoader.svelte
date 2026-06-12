<script lang="ts">
  import { onMount } from 'svelte'

  const CAPTIONS = [
    'Fetching pull request…',
    'Reading the diffs…',
    'Mapping changed files…',
    'Almost there…',
  ]

  const CAPTION_INTERVAL_MS = 1600

  let captionIndex = $state(0)
  let reducedMotion = $state(false)

  onMount(() => {
    // Detect prefers-reduced-motion
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
      reducedMotion = mql.matches
    }

    // Caption rotation interval — cleanup on unmount
    const interval = setInterval(() => {
      captionIndex = (captionIndex + 1) % CAPTIONS.length
    }, CAPTION_INTERVAL_MS)

    return () => clearInterval(interval)
  })
</script>

<div class="crafted-loader" class:reduced-motion={reducedMotion} aria-label="Loading pull request">
  <!-- Diff-bars mark: three SVG bars matching the favicon design -->
  <svg
    class="loader-bars-mark"
    viewBox="0 0 64 64"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    width="56"
    height="56"
  >
    <!-- Background rounded square -->
    <rect width="64" height="64" rx="14" fill="var(--surface-raised, #14161a)" />
    <!-- Bar 1: red/removed — shimmer with stagger delay 0 -->
    <rect
      class="bar bar-1"
      class:shimmer={!reducedMotion}
      x="13" y="14" width="22" height="7.5" rx="3.75"
      fill="#e0697a"
    />
    <!-- Bar 2: green/added — shimmer with stagger delay 1 -->
    <rect
      class="bar bar-2"
      class:shimmer={!reducedMotion}
      x="13" y="27.5" width="34" height="7.5" rx="3.75"
      fill="#58b96b"
    />
    <!-- Bar 3: teal/context — shimmer with stagger delay 2 -->
    <rect
      class="bar bar-3"
      class:shimmer={!reducedMotion}
      x="13" y="41" width="27" height="7.5" rx="3.75"
      fill="#4db6a0"
    />
  </svg>

  <!-- Rotating caption with aria-live for screen readers -->
  <p class="loader-caption" aria-live="polite" aria-atomic="true">
    {CAPTIONS[captionIndex]}
  </p>

  <!-- Ghost page structure at reduced opacity (decorative, hidden from a11y tree) -->
  <div class="loader-ghost" aria-hidden="true">
    <!-- Ghost glance card -->
    <div class="loader-ghost-card">
      <div class="ghost-line ghost-line-short"></div>
      <div class="ghost-line ghost-line-medium"></div>
      <div class="ghost-line ghost-line-long"></div>
    </div>
    <!-- Ghost file rows -->
    <div class="loader-ghost-file-row">
      <div class="ghost-file-icon"></div>
      <div class="ghost-line ghost-line-medium"></div>
    </div>
    <div class="loader-ghost-file-row">
      <div class="ghost-file-icon"></div>
      <div class="ghost-line ghost-line-long"></div>
    </div>
    <div class="loader-ghost-file-row">
      <div class="ghost-file-icon"></div>
      <div class="ghost-line ghost-line-short"></div>
    </div>
  </div>
</div>

<style>
  /* Centered composition — the loader is the hero of the loading experience */
  .crafted-loader {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1.25rem;
    padding: 3rem 1rem 2rem;
    min-height: 300px;
  }

  /* --- Diff-bars mark animation --- */
  .bar {
    transform-origin: center;
  }

  /* Sequential shimmer: each bar fades in/out offset by 0.4s */
  .bar.shimmer.bar-1 {
    animation: bar-shimmer 1.6s ease-in-out infinite;
    animation-delay: 0s;
  }

  .bar.shimmer.bar-2 {
    animation: bar-shimmer 1.6s ease-in-out infinite;
    animation-delay: 0.4s;
  }

  .bar.shimmer.bar-3 {
    animation: bar-shimmer 1.6s ease-in-out infinite;
    animation-delay: 0.8s;
  }

  @keyframes bar-shimmer {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  /* --- Caption --- */
  .loader-caption {
    font-size: 0.9rem;
    color: var(--text-muted, #8899aa);
    text-align: center;
    margin: 0;
    min-height: 1.4em; /* prevent layout shift on caption change */
    transition: opacity 0.2s;
  }

  /* --- Ghost page structure --- */
  .loader-ghost {
    width: 100%;
    max-width: 36rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    opacity: 0.18;
    pointer-events: none;
    margin-top: 0.5rem;
  }

  .loader-ghost-card {
    background: var(--surface-raised, #1e2030);
    border: 1px solid var(--border-subtle, #2a3040);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .loader-ghost-file-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.5rem;
    background: var(--surface-raised, #1e2030);
    border: 1px solid var(--border-subtle, #2a3040);
    border-radius: 4px;
  }

  .ghost-file-icon {
    width: 14px;
    height: 14px;
    border-radius: 2px;
    background: var(--surface-hover, #2a3040);
    flex-shrink: 0;
  }

  .ghost-line {
    height: 0.7em;
    border-radius: 3px;
    background: var(--surface-hover, #2a3040);
  }

  .ghost-line-short  { width: 35%; }
  .ghost-line-medium { width: 55%; }
  .ghost-line-long   { width: 80%; }

  /* --- Reduced motion: disable all animations, keep static text --- */
  .reduced-motion .bar {
    animation: none !important;
    opacity: 1;
  }

  .reduced-motion .loader-ghost {
    opacity: 0.15;
  }
</style>
