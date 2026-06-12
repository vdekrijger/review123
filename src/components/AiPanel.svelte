<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { PanelStatus } from '../lib/ai/run.svelte'
  import Skeleton from './Skeleton.svelte'
  import { settingsState } from '../lib/settings/settingsState.svelte'
  import { getProvider } from '../lib/llm/providers'
  import { navigate } from '../lib/router/router.svelte'

  interface Props {
    title: string
    state: { status: PanelStatus; error?: string }
    onretry: () => void
    /** Shape of the pending skeleton — content-shaped per section. */
    skeletonVariant?: 'text' | 'block' | 'cards'
    /** Line count for the text skeleton variant. */
    skeletonLines?: number
    children?: Snippet
  }

  let { title, state, onretry, skeletonVariant = 'text', skeletonLines = 3, children }: Props = $props()

  // Name the ACTIVE provider in the no-key hint (Plan F) — reactive via settingsState.
  const providerName = $derived(
    getProvider(settingsState.current.aiProvider)?.displayName ?? 'provider',
  )
  // "an Anthropic key" vs "a DeepSeek key"
  const article = $derived(/^[aeiou]/i.test(providerName) ? 'an' : 'a')

  function goToSettings(e: MouseEvent) {
    e.preventDefault()
    sessionStorage.setItem('review123:settingsReturnTo', location.pathname)
    navigate('/settings')
  }
</script>

{#if state.status === 'idle' || state.status === 'loading'}
  <!-- 'idle' counts as pending: the run hasn't signalled 'loading' yet
       (consent gate / context packing / cache check are all async), so the
       skeleton must be there from the FIRST render — no blank gap. -->
  <div class="ai-panel-loading" aria-busy="true">
    <Skeleton variant={skeletonVariant} lines={skeletonLines} />
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
  <div class="ai-panel-streaming">
    <span class="spinner" aria-hidden="true"></span>
    <span class="sr-only">Streaming…</span>
    {@render children?.()}
  </div>
{:else if state.status === 'done'}
  {@render children?.()}
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

  .ai-panel-streaming {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .spinner {
    display: inline-block;
    width: 0.9em;
    height: 0.9em;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    vertical-align: middle;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
