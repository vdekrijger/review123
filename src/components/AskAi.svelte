<script lang="ts">
  /**
   * AskAi — free-form question answering about the PR.
   *
   * Props:
   *   ask(q, onDelta) — delegates to run.ask(); returns {ok,answer}|{ok:false,error}
   *   disabledReason? — optional string shown as hint when AI unavailable (e.g. no key)
   *
   * Session-only — conversation is not persisted.
   */
  import MarkdownView from './MarkdownView.svelte'

  interface ConversationEntry {
    /** Stable identity for the keyed #each — the old key was
        `question + answer.slice(0, 20)`, which mutates on every streamed delta
        until the answer is 20 characters long and collides on a repeat question. */
    id: number
    question: string
    answer: string
    streaming: boolean
    error: string | null
  }

  /** Monotonic source for ConversationEntry.id. */
  let nextEntryId = 0

  interface Props {
    ask: (q: string, onDelta: (t: string) => void) => Promise<{ ok: true; answer: string } | { ok: false; error: string }>
    disabledReason?: string | null
  }

  let { ask, disabledReason = null }: Props = $props()

  let question = $state('')
  let loading = $state(false)
  let conversation = $state<ConversationEntry[]>([])
  // Track last question for retry
  let lastQuestion = $state('')

  const disabled = $derived(!!disabledReason || loading)

  async function submit(q: string) {
    if (!q.trim() || loading) return

    const trimmed = q.trim()
    lastQuestion = trimmed
    question = ''
    loading = true

    // Add a streaming placeholder entry
    const entry: ConversationEntry = { id: nextEntryId++, question: trimmed, answer: '', streaming: true, error: null }
    conversation = [...conversation, entry]
    const entryIndex = conversation.length - 1

    const result = await ask(trimmed, (delta) => {
      conversation = conversation.map((e, i) =>
        i === entryIndex ? { ...e, answer: e.answer + delta, streaming: true } : e,
      )
    })

    if (result.ok) {
      conversation = conversation.map((e, i) =>
        i === entryIndex ? { ...e, answer: result.answer, streaming: false, error: null } : e,
      )
    } else {
      conversation = conversation.map((e, i) =>
        i === entryIndex ? { ...e, streaming: false, error: result.error } : e,
      )
    }

    loading = false
  }

  function handleSubmit() {
    void submit(question)
  }

  function handleRetry() {
    // Remove last entry and re-ask the same question
    conversation = conversation.slice(0, -1)
    void submit(lastQuestion)
  }

  function handleKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }

  const lastEntry = $derived(conversation[conversation.length - 1] ?? null)
  const hasError = $derived(!!lastEntry?.error)
</script>

<details class="ask-ai-section">
  <summary class="ask-ai-summary">Ask AI about this PR</summary>

  <div class="ask-ai-body">
    {#if disabledReason}
      <p class="ask-ai-hint">{disabledReason}</p>
    {/if}

    <!-- Conversation history -->
    {#if conversation.length > 0}
      <div class="ask-ai-conversation" aria-live="polite">
        {#each conversation as entry (entry.id)}
          <div class="ask-ai-turn">
            <div class="ask-ai-question">
              <span class="turn-tag">You</span>
              <span>{entry.question}</span>
            </div>
            {#if entry.streaming && !entry.error}
              <div class="ai-card">
                <span class="ai-card-tag">AI</span>
                <div class="ai-card-body ask-ai-streaming">{entry.answer}<span class="ask-ai-cursor" aria-hidden="true"></span></div>
              </div>
            {:else if entry.error}
              <div class="ask-ai-error" role="alert">
                <span>{entry.error}</span>
                {#if entry === lastEntry}
                  <button type="button" class="btn" onclick={handleRetry}>Retry</button>
                {/if}
              </div>
            {:else}
              <div class="ai-card">
                <span class="ai-card-tag">AI</span>
                <div class="ai-card-body">
                  <MarkdownView source={entry.answer} />
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <!-- Input area -->
    <div class="ask-ai-input-area">
      <textarea
        bind:value={question}
        onkeydown={handleKeydown}
        placeholder="Ask a question about this PR…"
        rows="3"
        disabled={disabled}
        aria-label="Ask a question"
        class="ask-ai-textarea"
      ></textarea>
      <button
        type="button"
        class="btn ask-ai-submit"
        onclick={handleSubmit}
        disabled={disabled || !question.trim()}
        aria-busy={loading}
        aria-label="Ask"
      >
        {loading ? 'Asking…' : 'Ask'}
      </button>
    </div>
  </div>
</details>

<style>
  /*
   * Every colour in this component used to be a hardcoded hex or an #8884-style
   * alpha literal, which is a palette fork (A5): #cf222e is illegible on the
   * dark ground and an alpha-on-unknown-ground border cannot be measured at all.
   * All of it now points at the app's tokens, so contrast.test.ts governs it.
   */
  .ask-ai-section {
    border-bottom: 1px solid var(--hairline);
    font-family: var(--font-ui);
    font-size: var(--text-sm);
  }

  /* Marker (rotating triangle) comes from the global details > summary
     pattern in app.css — re-declaring a ::before here merges with it on the
     same pseudo-element and renders a double chevron. Only sizing below. */
  .ask-ai-summary {
    padding: var(--space-3);
    font-size: var(--text-xs);
    /* p.117: all-caps-adjacent label tracking. */
    letter-spacing: 0.05em;
    color: var(--text-secondary);
  }

  .ask-ai-body {
    padding: var(--space-2) var(--space-3) var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .ask-ai-hint {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    margin: 0;
  }

  .ask-ai-conversation {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-height: 20rem;
    overflow-y: auto;
  }

  /* p.83: more space between turns than inside one. */
  .ask-ai-turn {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .ask-ai-question {
    align-self: flex-end;
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    background: var(--surface-sunken);
    border-radius: 8px 8px 2px 8px;
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    max-width: 90%;
    word-break: break-word;
  }

  .turn-tag {
    flex-shrink: 0;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  /* Same AI-output card as DraftThread: shadow for depth that reads in both
     themes, 2px accent rail, uppercase tag, prose face at full ink. */
  .ai-card {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--hairline);
    border-left: 2px solid var(--accent);
    border-radius: 6px;
    background: var(--surface);
    box-shadow: var(--elevation-1);
  }

  /* 600: the AI tag is EMPHASIS, not a field label — it marks provenance and
     has to be noticeable. Every other label in this file is already demoted on
     size and colour, so stroke has nothing to pay back and they stay at 400. */
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

  .ask-ai-streaming {
    /* Partial text must LOOK partial — by ink, not opacity, so it cannot fall
       through the contrast floor (B5). */
    color: var(--text-secondary);
    white-space: pre-wrap;
  }

  .ask-ai-cursor {
    display: inline-block;
    width: 6px;
    height: 0.9em;
    background: currentColor;
    animation: blink 1s step-end infinite;
    vertical-align: text-bottom;
    margin-left: 2px;
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ask-ai-cursor { animation: none; }
  }

  .ask-ai-error {
    color: var(--legend-removed-color);
    font-size: var(--text-xs);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  /* Wraps on its own width rather than on a viewport breakpoint — this panel
     lives in a rail/drawer whose width the viewport does not describe. */
  .ask-ai-input-area {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .ask-ai-textarea {
    flex: 1 1 14rem;
    min-width: 12rem;
    resize: vertical;
    min-height: 4rem;
    /* D5 / SC 1.4.11: a control's boundary needs 3:1 — #8884 over an unknown
       ground was 1.3:1 and the field read as floating text. */
    border: 1px solid var(--border-control);
    border-radius: 6px;
    padding: var(--space-2) var(--space-3);
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    line-height: 1.5;
    background: var(--surface);
    color: var(--text);
    outline: none;
    box-sizing: border-box;
  }

  .ask-ai-textarea::placeholder { color: var(--text-muted); }

  .ask-ai-textarea:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .ask-ai-textarea:disabled {
    opacity: var(--disabled-opacity);
    cursor: not-allowed;
  }

  .ask-ai-submit {
    flex-shrink: 0;
  }
</style>
