<script lang="ts">
  /**
   * AiProgress — the ONE unified AI pending/streaming treatment.
   *
   * Every AI surface (the four panels, the at-a-glance card, skill reviewers,
   * story, coach, mining, ask) renders progress through this component so they
   * all behave identically. Priority order, highest first:
   *
   *   1. Streaming + tokens started → stream the content (children), nothing else.
   *   2. Otherwise a status line (always, while pending) — an honest one-liner
   *      describing what THIS task is doing (aiProgressLabel).
   *   3. + an activity log beneath the status line when the task emits activity
   *      lines (deep-mode tool lines) — the "loved" treatment, now consistent.
   *   4. + a content-shaped skeleton beneath (the existing Skeleton variants)
   *      until content arrives.
   *
   * NEVER a bare skeleton that later layers a spinner on; NEVER a spinner with
   * no context. Accessibility: the region is aria-busy while pending and the
   * status/activity area is aria-live="polite" so screen readers announce
   * progress without spamming.
   */
  import type { Snippet } from 'svelte'
  import Skeleton from './Skeleton.svelte'
  import { aiProgressLabel, type AiProgressTask } from '../lib/ai/progressLabel'

  interface ProgressState {
    status: string
    /** Deep-mode humanized tool-activity lines. */
    activity?: string[]
    /** True once streaming tokens have begun arriving (suppresses status/skeleton). */
    streamStarted?: boolean
  }

  interface Props {
    task: AiProgressTask
    state: ProgressState
    /** Reviewer name for the 'skill' task status line ("Running {name}…"). */
    name?: string
    /** Shape of the pending skeleton — content-shaped per section. */
    skeletonVariant?: 'text' | 'block' | 'cards'
    /** Line count for the text skeleton variant. */
    skeletonLines?: number
    /** Render the content-shaped skeleton. Off for compact inline surfaces. */
    skeleton?: boolean
    /** Streaming content (rendered only once streamStarted). */
    children?: Snippet
  }

  let {
    task,
    state,
    name,
    skeletonVariant = 'text',
    skeletonLines = 3,
    skeleton = true,
    children,
  }: Props = $props()

  const label = $derived(aiProgressLabel(task, name))
  // Tokens stream only when the task is in 'streaming' AND has signalled the
  // first delta. Until then we keep the honest status line + skeleton.
  const isStreaming = $derived(state.status === 'streaming' && state.streamStarted === true)
  const hasActivity = $derived((state.activity?.length ?? 0) > 0)
</script>

{#if isStreaming}
  <div class="ai-progress-streaming">
    {@render children?.()}
  </div>
{:else}
  <div class="ai-progress" aria-busy="true">
    <div class="ai-progress-head" role="status" aria-live="polite">
      <p class="ai-status-line">{label}</p>
      {#if hasActivity}
        <ul class="ai-activity-log" aria-label="Activity">
          {#each state.activity as line, i (i)}
            <li>{line}</li>
          {/each}
        </ul>
      {/if}
    </div>
    {#if skeleton}
      <Skeleton variant={skeletonVariant} lines={skeletonLines} />
    {/if}
  </div>
{/if}

<style>
  .ai-progress {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem 0;
  }

  .ai-progress-head {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .ai-status-line {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-muted, #9a9890);
    display: flex;
    align-items: center;
  }

  /* Honest activity affordance: a soft pulsing dot before the status text. */
  .ai-status-line::before {
    content: '';
    display: inline-block;
    width: 0.45em;
    height: 0.45em;
    margin-right: 0.5em;
    border-radius: 50%;
    background: var(--accent, currentColor);
    animation: ai-progress-pulse 1.2s ease-in-out infinite;
    flex-shrink: 0;
  }

  .ai-activity-log {
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 0.78rem;
    font-family: var(--font-mono, monospace);
    color: var(--text-muted, #9a9890);
    opacity: 0.8;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .ai-progress-streaming {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  @keyframes ai-progress-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.35; transform: scale(0.7); }
  }

  @media (prefers-reduced-motion: reduce) {
    .ai-status-line::before {
      animation: none;
    }
  }
</style>
