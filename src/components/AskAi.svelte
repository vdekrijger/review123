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
    question: string
    answer: string
    streaming: boolean
    error: string | null
  }

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
    const entry: ConversationEntry = { question: trimmed, answer: '', streaming: true, error: null }
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
        {#each conversation as entry (entry.question + entry.answer.slice(0, 20))}
          <div class="ask-ai-question">{entry.question}</div>
          {#if entry.streaming && !entry.error}
            <div class="ask-ai-answer ask-ai-streaming">{entry.answer}<span class="ask-ai-cursor" aria-hidden="true"></span></div>
          {:else if entry.error}
            <div class="ask-ai-error" role="alert">
              {entry.error}
              {#if entry === lastEntry}
                <button class="ask-ai-retry-btn" onclick={handleRetry}>Retry</button>
              {/if}
            </div>
          {:else}
            <div class="ask-ai-answer">
              <MarkdownView source={entry.answer} />
            </div>
          {/if}
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
        class="ask-ai-submit"
        onclick={handleSubmit}
        disabled={disabled || !question.trim()}
        aria-label="Ask"
      >
        Ask
      </button>
    </div>
  </div>
</details>

<style>
  .ask-ai-section {
    border-bottom: 1px solid #4441;
    font-size: 0.82rem;
  }

  /* Marker (rotating triangle) comes from the global details > summary
     pattern in app.css — re-declaring a ::before here merges with it on the
     same pseudo-element and renders a double chevron. Only sizing below. */
  .ask-ai-summary {
    padding: 0.6rem 0.75rem;
    font-size: 0.75rem;
    letter-spacing: 0.05em;
    opacity: 0.7;
  }

  .ask-ai-body {
    padding: 0.5rem 0.75rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .ask-ai-hint {
    font-size: 0.78rem;
    opacity: 0.6;
    margin: 0;
    font-style: italic;
  }

  .ask-ai-conversation {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    max-height: 320px;
    overflow-y: auto;
  }

  .ask-ai-question {
    align-self: flex-end;
    background: #4443;
    border-radius: 8px 8px 2px 8px;
    padding: 0.35rem 0.6rem;
    font-size: 0.8rem;
    max-width: 90%;
    word-break: break-word;
  }

  .ask-ai-answer {
    font-size: 0.8rem;
    line-height: 1.45;
    padding: 0 0.1rem;
    word-break: break-word;
  }

  .ask-ai-streaming {
    opacity: 0.85;
  }

  .ask-ai-cursor {
    display: inline-block;
    width: 6px;
    height: 0.9em;
    background: currentColor;
    opacity: 0.6;
    animation: blink 1s step-end infinite;
    vertical-align: text-bottom;
    margin-left: 2px;
  }

  @keyframes blink {
    0%, 100% { opacity: 0.6; }
    50% { opacity: 0; }
  }

  .ask-ai-error {
    color: #cf222e;
    font-size: 0.78rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .ask-ai-retry-btn {
    background: none;
    border: 1px solid currentColor;
    border-radius: 4px;
    padding: 0.15rem 0.5rem;
    cursor: pointer;
    font-size: 0.75rem;
    color: inherit;
    flex-shrink: 0;
  }

  .ask-ai-retry-btn:hover {
    background: #cf222e22;
  }

  .ask-ai-input-area {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .ask-ai-textarea {
    width: 100%;
    resize: vertical;
    min-height: 5rem;
    border: 1px solid #8884;
    border-radius: 4px;
    padding: 0.4rem 0.5rem;
    font-size: 0.82rem;
    font-family: inherit;
    background: transparent;
    color: inherit;
    outline: none;
    box-sizing: border-box;
  }

  .ask-ai-textarea:focus {
    border-color: #8886;
  }

  .ask-ai-textarea:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .ask-ai-submit {
    align-self: flex-end;
    background: none;
    border: 1px solid #8884;
    border-radius: 4px;
    padding: 0.3rem 0.9rem;
    cursor: pointer;
    font-size: 0.82rem;
    font-family: inherit;
  }

  .ask-ai-submit:hover:not(:disabled) {
    border-color: #8887;
    background: #8881;
  }

  .ask-ai-submit:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
