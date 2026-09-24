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
      class="btn ask-box-send"
      onclick={() => void submit()}
      disabled={!canSubmit}
      aria-busy={loading}
      data-testid="ask-box-send"
    >{loading ? 'Asking…' : 'Ask'}</button>
    {#if onclose}
      <button type="button" class="btn btn-quiet ask-box-close" onclick={() => onclose?.()}>Close</button>
    {/if}
  </div>

  {#if streaming || answer || error}
    <div class="ask-box-answer-wrap" aria-live="polite">
      {#if error}
        <div class="ask-box-error" role="alert" data-testid="ask-box-error">{error}</div>
      {:else if streaming && !answer}
        <div class="ai-card">
          <span class="ai-card-tag">AI</span>
          <div class="ai-card-body ask-box-streaming" data-testid="ask-box-streaming">Thinking<span class="ask-box-cursor" aria-hidden="true"></span></div>
        </div>
      {:else if streaming}
        <div class="ai-card">
          <span class="ai-card-tag">AI</span>
          <div class="ai-card-body ask-box-streaming" data-testid="ask-box-answer">{answer}<span class="ask-box-cursor" aria-hidden="true"></span></div>
        </div>
      {:else}
        <div class="ai-card">
          <span class="ai-card-tag">AI</span>
          <div class="ai-card-body" data-testid="ask-box-answer">
            <MarkdownView source={answer} />
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .ask-box {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--border-subtle);
    /* Chrome is UI text. This box drops into a finding card that sits on the
       monospace diff surface, so without this the question and the answer both
       inherit the code face. */
    font-family: var(--font-ui);
  }

  .ask-box-input {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    line-height: 1.5;
    padding: var(--space-2) var(--space-3);
    border-radius: 6px;
    border: 1px solid var(--border-control);
    background: var(--surface);
    color: var(--text);
  }

  .ask-box-input::placeholder { color: var(--text-muted); }

  .ask-box-input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .ask-box-actions {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }

  /*
   * TERTIARY (p.52-53): Close is dismissive and must not read as a peer of Ask.
   * Ask keeps .btn's outlined secondary box; Close drops the fill and the rim.
   */
  .btn-quiet {
    background: none;
    border-color: transparent;
    color: var(--text-secondary);
    text-decoration: underline;
    text-underline-offset: 3px;
    text-decoration-thickness: 1px;
  }

  .btn-quiet:hover:not(:disabled) {
    background: none;
    border-color: transparent;
    color: var(--text);
  }

  .ask-box-answer-wrap {
    max-height: 20rem;
    overflow-y: auto;
  }

  /* Same AI-output card as DraftThread and AskAi — one treatment across all
     three Ask surfaces rather than three near-identical ones. */
  .ai-card {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--hairline);
    border-left: 2px solid var(--accent);
    border-radius: 6px;
    background: var(--surface);
    box-shadow: var(--elevation-1);
  }

  /* 600: the AI tag is emphasis — it marks provenance and must be noticeable. */
  .ai-card-tag {
    display: block;
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
    margin-bottom: var(--space-1);
  }

  .ai-card-body {
    font-family: var(--font-prose);
    font-size: var(--text-sm);
    line-height: 1.6;
    max-width: var(--measure-prose);
    color: var(--text);
    word-break: break-word;
  }

  .ai-card-body :global(p:first-child) { margin-top: 0; }
  .ai-card-body :global(p:last-child) { margin-bottom: 0; }
  /* A2: code keeps the code face and sets its own measure. */
  .ai-card-body :global(code),
  .ai-card-body :global(pre) { font-family: var(--font-mono); }
  .ai-card-body :global(code) {
    font-size: var(--text-xs);
    background: var(--surface-sunken);
    padding: 0.125rem var(--space-1);
    border-radius: 3px;
  }
  .ai-card-body :global(pre) {
    background: var(--surface-sunken);
    padding: var(--space-2);
    border-radius: 4px;
    overflow-x: auto;
    max-width: none;
  }
  .ai-card-body :global(pre code) { background: none; padding: 0; }

  .ask-box-streaming {
    /* Colour, not opacity — a receded ink that still clears the floor (B5). */
    color: var(--text-secondary);
    white-space: pre-wrap;
  }

  .ask-box-error {
    color: var(--legend-removed-color, #cf222e);
    font-size: var(--text-xs);
  }

  .ask-box-cursor {
    display: inline-block;
    width: 5px;
    height: 0.85em;
    background: currentColor;
    animation: ask-box-blink 1s step-end infinite;
    vertical-align: text-bottom;
    margin-left: 2px;
  }

  @keyframes ask-box-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ask-box-cursor { animation: none; }
  }
</style>
