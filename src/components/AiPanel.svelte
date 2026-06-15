<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { PanelStatus } from '../lib/ai/run.svelte'
  import AiProgress from './AiProgress.svelte'
  import type { AiProgressTask } from '../lib/ai/progressLabel'
  import { settingsState } from '../lib/settings/settingsState.svelte'
  import { getProvider } from '../lib/llm/providers'
  import { navigate } from '../lib/router/router.svelte'
  import { formatUsageLabel } from '../lib/ai/tokenCost'
  import type { LlmUsage } from '../lib/llm/llm'

  interface Props {
    title: string
    /** AI task this panel renders — drives the unified status line. */
    task: AiProgressTask
    state: { status: PanelStatus; error?: string; activity?: string[]; toolCallsUsed?: number; note?: string; usage?: LlmUsage }
    onretry: () => void
    /** Shape of the pending skeleton — content-shaped per section. */
    skeletonVariant?: 'text' | 'block' | 'cards'
    /** Line count for the text skeleton variant. */
    skeletonLines?: number
    children?: Snippet
  }

  let { title, task, state, onretry, skeletonVariant = 'text', skeletonLines = 3, children }: Props = $props()

  // Name the ACTIVE provider in the no-key hint (Plan F) — reactive via settingsState.
  const providerName = $derived(
    getProvider(settingsState.current.aiProvider)?.displayName ?? 'provider',
  )
  // "an Anthropic key" vs "a DeepSeek key"
  const article = $derived(/^[aeiou]/i.test(providerName) ? 'an' : 'a')

  // Opt-in token-usage footer (settings.showTokenCost, default OFF). Reactive
  // via settingsState. Returns null when off or when this task has no captured
  // usage — in either case nothing renders (byte-identical to the prior UI).
  const usageLabel = $derived(
    settingsState.current.showTokenCost ? formatUsageLabel(state.usage) : null,
  )

  function goToSettings(e: MouseEvent) {
    e.preventDefault()
    sessionStorage.setItem('review123:settingsReturnTo', location.pathname)
    navigate('/settings')
  }
</script>

{#if state.status === 'idle' || state.status === 'loading'}
  <!-- 'idle' counts as pending: the run hasn't signalled 'loading' yet
       (consent gate / context packing / cache check are all async), so the
       unified progress (status line + skeleton) must be there from the FIRST
       render — no blank gap. Deep-mode activity lines flow through the same
       AiProgress treatment used everywhere else. -->
  <div class="ai-panel-loading">
    <AiProgress {task} {state} {skeletonVariant} skeletonLines={skeletonLines} />
    <span class="sr-only">Loading {title}…</span>
  </div>
{:else if state.status === 'error'}
  <div class="ai-panel-error" role="alert">
    <p class="error-msg">{state.error ?? 'Something went wrong.'}</p>
    <button class="retry-btn" onclick={onretry}>Retry</button>
  </div>
{:else if state.status === 'no-key'}
  <div class="ai-panel-no-key">
    Add {article} {providerName} key in <a href="/settings" onclick={goToSettings}>Settings</a>
  </div>
{:else if state.status === 'declined'}
  <div class="ai-panel-declined">
    AI analysis declined for this private repository
  </div>
{:else if state.status === 'streaming'}
  <!-- Streaming: tokens have started → stream the content (priority 1). The
       unified AiProgress suppresses status/skeleton once streamStarted. -->
  <AiProgress {task} state={{ ...state, streamStarted: true }} {skeletonVariant} skeletonLines={skeletonLines}>
    {@render children?.()}
  </AiProgress>
{:else if state.status === 'done'}
  {@render children?.()}
  {#if state.note}
    <p class="ai-panel-note">{state.note}</p>
  {/if}
  {#if state.toolCallsUsed !== undefined && state.toolCallsUsed > 0}
    <p class="ai-deep-footer">
      Deep review: verified with {state.toolCallsUsed} tool {state.toolCallsUsed === 1 ? 'call' : 'calls'}
    </p>
  {/if}
  {#if usageLabel}
    <p class="ai-usage-footer" aria-label="Token usage">·· {usageLabel}</p>
  {/if}
{/if}

<style>
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }

  .ai-panel-loading {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem 0;
  }

  .ai-panel-error {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    padding: 0.5rem 0;
  }

  .error-msg {
    margin: 0;
    color: #cf222e;
    font-size: 0.9rem;
  }

  .retry-btn {
    font-size: 0.85rem;
    padding: 0.2rem 0.6rem;
    border-radius: 4px;
    border: 1px solid currentColor;
    background: none;
    cursor: pointer;
  }

  .ai-panel-no-key,
  .ai-panel-declined {
    font-size: 0.9rem;
    opacity: 0.75;
    padding: 0.5rem 0;
  }

  .ai-panel-note {
    margin: 0.5rem 0 0;
    font-size: 0.78rem;
    font-style: italic;
    opacity: 0.65;
  }

  .ai-deep-footer {
    margin: 0.6rem 0 0;
    padding-top: 0.4rem;
    border-top: 1px solid var(--hairline);
    font-size: 0.78rem;
    opacity: 0.65;
  }

  .ai-usage-footer {
    margin: 0.3rem 0 0;
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
    opacity: 0.5;
  }
</style>
