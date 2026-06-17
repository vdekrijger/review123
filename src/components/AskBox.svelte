<script lang="ts">
  /**
   * AskBox — a compact, self-contained grounded Ask-AI affordance.
   *
   * A small textarea + Ask button + a single streamed, ephemeral answer rendered
   * as markdown. Mirrors DraftThread's Ask AI UX (input → streamed answer → states)
   * but stands alone so it can drop into a reviewer finding card.
   *
   * The answer is EPHEMERAL — this is Q&A, never saved as a draft.
   *
   * Wiring: the caller supplies `askFn(q, onDelta, focus?)` and an optional `focus`
   * (path/line/excerpt/finding) used to ground the answer. The caller decides what
   * the focus contains (e.g. finding text + code excerpt).
   *
   * Keyboard: Enter or Cmd/Ctrl+Enter sends; Esc closes (onclose). Empty/whitespace
   * questions never submit.
   *
   * Gating happens UPSTREAM — the caller only mounts this when an askFn exists.
   */
  import type { AskFocus } from '../lib/ai/tasks'
  import MarkdownView from './MarkdownView.svelte'

  interface Props {
    /** Streaming grounded Q&A. Mirrors AiRun.ask (+ focus). */
    askFn: (q: string, onDelta: (t: string) => void, focus?: AskFocus) => Promise<{ ok: true; answer: string } | { ok: false; error: string }>
    /** Grounding focus passed straight to askFn (path/line/excerpt/finding). */
    focus?: AskFocus
    /** Placeholder for the textarea. */
    placeholder?: string
    /** Called when the user closes the box (Esc or the Close button). */
    onclose?: () => void
  }

  let { askFn, focus = undefined, placeholder = 'Ask a follow-up about this finding…', onclose = undefined }: Props = $props()

  let question = $state('')
  let answer = $state('')
  let streaming = $state(false)
  let error = $state<string | null>(null)
  let loading = $state(false)
  let textareaEl = $state<HTMLTextAreaElement | null>(null)

  const canSubmit = $derived(!loading && question.trim().length > 0)

  // Focus the textarea on mount for keyboard-first use.
  $effect(() => {
    textareaEl?.focus()
  })

  async function submit() {
    const q = question.trim()
    if (!q || loading) return

    loading = true
    streaming = true
    error = null
    answer = ''

    const result = await askFn(q, (delta) => {
      answer += delta
    }, focus)

    if (result.ok) {
      answer = result.answer
      error = null
    } else {
      error = result.error
    }
    streaming = false
    loading = false
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onclose?.()
      return
    }
    // Enter (or Cmd/Ctrl+Enter) sends; Shift+Enter inserts a newline.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (canSubmit) void submit()
    }
  }
</script>

<div class="ask-box" data-testid="ask-box">
  <textarea
    bind:this={textareaEl}
    class="ask-box-input"
    rows="2"
    {placeholder}
    bind:value={question}
    onkeydown={handleKeydown}
    aria-label="Ask a follow-up about this finding"
    data-testid="ask-box-input"
  ></textarea>

  <div class="ask-box-actions">
    <button
      type="button"
      class="ask-box-send"
      onclick={() => void submit()}
      disabled={!canSubmit}
      aria-busy={loading}
      data-testid="ask-box-send"
    >{loading ? 'Asking…' : 'Ask'}</button>
    {#if onclose}
      <button type="button" class="ask-box-close" onclick={() => onclose?.()}>Close</button>
    {/if}
  </div>

  {#if streaming || answer || error}
    <div class="ask-box-answer-wrap" aria-live="polite">
      {#if error}
        <div class="ask-box-error" role="alert" data-testid="ask-box-error">{error}</div>
      {:else if streaming && !answer}
        <div class="ask-box-streaming" data-testid="ask-box-streaming">Thinking<span class="ask-box-cursor" aria-hidden="true"></span></div>
      {:else if streaming}
        <div class="ask-box-answer ask-box-answer-streaming" data-testid="ask-box-answer">{answer}<span class="ask-box-cursor" aria-hidden="true"></span></div>
      {:else}
        <div class="ask-box-answer" data-testid="ask-box-answer">
          <MarkdownView source={answer} />
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .ask-box {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-top: 0.4rem;
    padding-top: 0.4rem;
    border-top: 1px solid var(--border-subtle);
  }

  .ask-box-input {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    font: inherit;
    font-size: 0.8rem;
    line-height: 1.4;
    padding: 0.35rem 0.5rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background: var(--surface-raised);
    color: inherit;
  }

  .ask-box-input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .ask-box-actions {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }

  .ask-box-send {
    font-size: 0.78rem;
    padding: 0.18rem 0.6rem;
    border-radius: 4px;
    border: 1px solid var(--accent);
    background: transparent;
    color: var(--accent);
    cursor: pointer;
    font-weight: 500;
  }

  .ask-box-send:hover:not(:disabled) {
    background: var(--legend-added-bg, color-mix(in srgb, var(--accent) 12%, transparent));
  }

  .ask-box-send:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .ask-box-close {
    font-size: 0.78rem;
    padding: 0.18rem 0.55rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background: transparent;
    color: inherit;
    cursor: pointer;
    opacity: 0.7;
  }

  .ask-box-close:hover {
    opacity: 1;
    background: var(--surface-raised);
  }

  .ask-box-answer-wrap {
    font-size: 0.8rem;
    line-height: 1.45;
    max-height: 240px;
    overflow-y: auto;
    word-break: break-word;
  }

  .ask-box-streaming,
  .ask-box-answer-streaming {
    opacity: 0.85;
  }

  .ask-box-error {
    color: var(--legend-removed-color, #cf222e);
    font-size: 0.8rem;
  }

  .ask-box-cursor {
    display: inline-block;
    width: 5px;
    height: 0.85em;
    background: currentColor;
    opacity: 0.6;
    animation: ask-box-blink 1s step-end infinite;
    vertical-align: text-bottom;
    margin-left: 2px;
  }

  @keyframes ask-box-blink {
    0%, 100% { opacity: 0.6; }
    50% { opacity: 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ask-box-cursor { animation: none; }
  }

  .ask-box-answer :global(p:first-child) { margin-top: 0; }
  .ask-box-answer :global(p:last-child) { margin-bottom: 0; }
  .ask-box-answer :global(code) {
    font-size: 0.85em;
    background: var(--surface-raised);
    padding: 0.1em 0.3em;
    border-radius: 3px;
  }
  .ask-box-answer :global(pre) {
    background: var(--surface-raised);
    padding: 0.5rem;
    border-radius: 4px;
    overflow-x: auto;
  }
  .ask-box-answer :global(pre code) { background: none; padding: 0; }
</style>
