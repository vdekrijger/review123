<script lang="ts">
  /**
   * DraftThread — inline thread widget for a single line comment.
   *
   * Shows an existing draft body (rendered via renderMarkdown) with Edit/Delete buttons,
   * or a CommentEditor in edit/new mode.
   *
   * Mode toggle: when askFn is provided, a tab bar at the top lets the user switch
   * between "Comment" (existing behaviour) and "Ask AI" (streams an answer inline).
   * A follow-up question keeps the same focus. A small "Copy answer" button is shown
   * under each completed answer.
   *
   * Gating: when askDisabledReason is set, the Ask AI tab is shown but disabled
   * (the hint text is displayed instead of the textarea).
   */
  import type { AskFocus } from '../lib/ai/tasks'
  import { renderMarkdown } from '../lib/markdown/render'
  import CommentEditor from './CommentEditor.svelte'
  import MarkdownView from './MarkdownView.svelte'
  import type { Draft } from '../lib/drafts/drafts.svelte'

  interface ConversationEntry {
    question: string
    answer: string
    streaming: boolean
    error: string | null
  }

  interface Props {
    /** Existing draft for this line, or null when opening a new comment */
    draft: Draft | null
    path: string
    line: number
    side: 'LEFT' | 'RIGHT'
    onsave: (body: string) => void
    ondelete: () => void
    oncancel: () => void
    /**
     * Optional Ask AI function — when provided the tab toggle appears.
     * Signature mirrors AiRun.ask but also accepts a focus param.
     */
    askFn?: ((q: string, onDelta: (t: string) => void, focus?: AskFocus) => Promise<{ ok: true; answer: string } | { ok: false; error: string }>) | null
    /**
     * Optional disabled reason for Ask AI gating (e.g. "No API key configured.").
     * When set, the Ask AI tab is shown but the textarea is replaced with this hint.
     */
    askDisabledReason?: string | null
    /**
     * Pre-computed excerpt (±6 lines of the hunk) around this line.
     * Passed as focus.excerpt to askFn.
     */
    excerpt?: string
    /**
     * For new (null) drafts: the start line of a multi-line range.
     * When provided and < line, displays "Lines {startLine}–{line}" header.
     */
    startLine?: number
  }

  let {
    draft,
    path,
    line,
    side: _side,
    onsave,
    ondelete,
    oncancel,
    askFn = null,
    askDisabledReason = null,
    excerpt = '',
    startLine,
  }: Props = $props()

  /**
   * The effective start line — either from the draft (when viewing a saved draft)
   * or from the startLine prop (when composing a new draft).
   */
  const effectiveStartLine = $derived(
    draft?.startLine != null && draft.startLine < line
      ? draft.startLine
      : (startLine != null && startLine < line ? startLine : null)
  )

  // Track the last draft identity to detect external draft changes (e.g. parent load).
  // initialized with a sentinel so the $effect always runs on first mount.
  let lastDraftKey = $state<string | undefined>(undefined)

  // edit mode and editor buffer — will be set immediately by the $effect below
  let editing = $state<boolean>(false)
  let editorValue = $state<string>('')

  // When draft changes externally (different draft loaded for same line), reset editor state.
  // On first mount, lastDraftKey is undefined, so this always runs once on mount.
  $effect(() => {
    const key = draft ? `${draft.prKey}|${draft.path}|${draft.line}|${draft.side}` : null
    if (key !== lastDraftKey) {
      lastDraftKey = key ?? undefined
      if (draft === null) {
        editing = true
        editorValue = ''
      } else {
        editing = false
        editorValue = draft.body
      }
    }
  })

  function handleSave() {
    if (editorValue.trim()) {
      onsave(editorValue)
      editing = false
    }
  }

  function handleEdit() {
    editorValue = draft?.body ?? ''
    editing = true
  }

  function handleDelete() {
    ondelete()
  }

  function handleCancel() {
    if (draft === null) {
      // New draft cancelled: close the widget
      oncancel()
    } else {
      // Existing draft: go back to view mode
      editorValue = draft.body
      editing = false
    }
  }

  // ---------------------------------------------------------------------------
  // Ask AI tab state
  // ---------------------------------------------------------------------------

  /** Active tab — 'comment' | 'ask' */
  let activeTab = $state<'comment' | 'ask'>('comment')

  let askQuestion = $state('')
  let askLoading = $state(false)
  let conversation = $state<ConversationEntry[]>([])

  const askDisabled = $derived(!!askDisabledReason || askLoading)

  const focus = $derived<AskFocus>({ path, line, excerpt })

  async function submitAsk(q: string) {
    if (!q.trim() || askLoading || !askFn) return

    const trimmed = q.trim()
    askQuestion = ''
    askLoading = true

    const entry: ConversationEntry = { question: trimmed, answer: '', streaming: true, error: null }
    conversation = [...conversation, entry]
    const entryIndex = conversation.length - 1

    const result = await askFn(trimmed, (delta) => {
      conversation = conversation.map((e, i) =>
        i === entryIndex ? { ...e, answer: e.answer + delta, streaming: true } : e,
      )
    }, focus)

    if (result.ok) {
      conversation = conversation.map((e, i) =>
        i === entryIndex ? { ...e, answer: result.answer, streaming: false, error: null } : e,
      )
    } else {
      conversation = conversation.map((e, i) =>
        i === entryIndex ? { ...e, streaming: false, error: result.error } : e,
      )
    }

    askLoading = false
  }

  function handleAskSubmit() {
    void submitAsk(askQuestion)
  }

  function handleAskKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      handleAskSubmit()
    }
  }

  function copyAnswer(answer: string) {
    void navigator.clipboard.writeText(answer)
  }
</script>

<div class="draft-thread" data-testid="draft-thread" data-line={line}>
  <div class="thread-header">
    {#if effectiveStartLine !== null}
      <span class="thread-label">Lines {effectiveStartLine}–{line}</span>
    {:else}
      <span class="thread-label">Comment at line {line}</span>
    {/if}
    {#if askFn !== null && askFn !== undefined}
      <div class="tab-bar" role="tablist" aria-label="Widget mode">
        <button
          role="tab"
          class="tab-btn"
          class:active={activeTab === 'comment'}
          aria-selected={activeTab === 'comment'}
          onclick={() => (activeTab = 'comment')}
          data-testid="tab-comment"
        >Comment</button>
        <button
          role="tab"
          class="tab-btn"
          class:active={activeTab === 'ask'}
          aria-selected={activeTab === 'ask'}
          onclick={() => (activeTab = 'ask')}
          data-testid="tab-ask-ai"
        >Ask AI</button>
      </div>
    {/if}
  </div>

  {#if activeTab === 'comment'}
    {#if editing}
      <CommentEditor
        value={editorValue}
        onchange={(v) => (editorValue = v)}
        onsubmit={handleSave}
      />
      <div class="thread-actions">
        <button type="button" class="btn btn-primary" onclick={handleSave} disabled={!editorValue.trim()}>
          Save
        </button>
        <button type="button" class="btn" onclick={handleCancel}>
          Cancel
        </button>
      </div>
    {:else if draft !== null}
      <!-- View mode: show rendered body -->
      <!-- renderMarkdown output is the only accepted use of {@html} -->
      <div class="draft-body prose">
        {@html renderMarkdown(draft.body)}
      </div>
      <div class="thread-actions">
        <button type="button" class="btn" onclick={handleEdit}>Edit</button>
        <button type="button" class="btn btn-danger" onclick={handleDelete}>Delete</button>
      </div>
    {/if}
  {:else}
    <!-- Ask AI tab -->
    <div class="ask-inline-body">
      {#if askDisabledReason}
        <p class="ask-inline-hint" data-testid="ask-disabled-hint">{askDisabledReason}</p>
      {/if}

      {#if conversation.length > 0}
        <div class="ask-inline-conversation" aria-live="polite" data-testid="ask-conversation">
          {#each conversation as entry (entry.question + entry.answer.slice(0, 20))}
            <div class="ask-inline-question">{entry.question}</div>
            {#if entry.streaming && !entry.error}
              <div class="ask-inline-answer ask-inline-streaming">{entry.answer}<span class="ask-inline-cursor" aria-hidden="true"></span></div>
            {:else if entry.error}
              <div class="ask-inline-error" role="alert">{entry.error}</div>
            {:else}
              <div class="ask-inline-answer" data-testid="ask-answer">
                <MarkdownView source={entry.answer} />
                <button
                  type="button"
                  class="ask-copy-btn"
                  onclick={() => copyAnswer(entry.answer)}
                  aria-label="Copy answer"
                  data-testid="copy-answer-btn"
                >Copy</button>
              </div>
            {/if}
          {/each}
        </div>
      {/if}

      {#if !askDisabledReason}
        <div class="ask-inline-input-area">
          <textarea
            bind:value={askQuestion}
            onkeydown={handleAskKeydown}
            placeholder="Ask about this line…"
            rows="2"
            disabled={askDisabled}
            aria-label="Ask a question about this line"
            class="ask-inline-textarea"
            data-testid="ask-textarea"
          ></textarea>
          <button
            type="button"
            class="ask-inline-submit"
            onclick={handleAskSubmit}
            disabled={askDisabled || !askQuestion.trim()}
            data-testid="ask-submit-btn"
          >Ask</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .draft-thread {
    border: 1px solid var(--border-draft, #f0b44488);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    background: var(--surface-draft, #fffbf0);
    color: var(--text-draft, #333);
    font-size: 0.9rem;
  }

  .thread-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.4rem;
  }

  .thread-label {
    font-size: 0.8rem;
    opacity: 0.7;
    font-weight: 500;
  }

  /* Tab bar */
  .tab-bar {
    display: flex;
    gap: 0;
    border: 1px solid var(--border-draft, #f0b44488);
    border-radius: 4px;
    overflow: hidden;
  }

  .tab-btn {
    background: none;
    border: none;
    padding: 0.15rem 0.55rem;
    font-size: 0.75rem;
    cursor: pointer;
    font-family: inherit;
    color: inherit;
    opacity: 0.6;
    transition: background 0.1s, opacity 0.1s;
  }

  .tab-btn:hover:not(.active) {
    background: #8881;
    opacity: 0.8;
  }

  .tab-btn.active {
    background: var(--border-draft, #f0b44488);
    opacity: 1;
    font-weight: 600;
  }

  .draft-body {
    padding: 0.25rem 0;
    font-size: 0.9rem;
    /* prose class sets font-family to Newsreader; override max-width and font-size */
    max-width: none;
    font-size: 0.9rem;
  }

  /* Normalize markdown output inside the draft body */
  .draft-body :global(p) { margin: 0 0 0.5em; }
  .draft-body :global(p:last-child) { margin-bottom: 0; }
  .draft-body :global(pre) { background: var(--surface-raised); padding: 0.5rem; border-radius: 4px; overflow-x: auto; }
  .draft-body :global(code) { font-size: 0.85em; background: var(--surface-raised); padding: 0.1em 0.3em; border-radius: 3px; }
  .draft-body :global(pre code) { background: none; padding: 0; }

  .thread-actions {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.5rem;
  }

  /* Ask AI inline panel */
  .ask-inline-body {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding-top: 0.25rem;
  }

  .ask-inline-hint {
    font-size: 0.78rem;
    opacity: 0.6;
    margin: 0;
    font-style: italic;
  }

  .ask-inline-conversation {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    max-height: 240px;
    overflow-y: auto;
  }

  .ask-inline-question {
    align-self: flex-end;
    background: #4443;
    border-radius: 8px 8px 2px 8px;
    padding: 0.25rem 0.5rem;
    font-size: 0.78rem;
    max-width: 90%;
    word-break: break-word;
  }

  .ask-inline-answer {
    font-size: 0.78rem;
    line-height: 1.45;
    word-break: break-word;
  }

  .ask-inline-streaming {
    opacity: 0.85;
  }

  .ask-inline-cursor {
    display: inline-block;
    width: 5px;
    height: 0.85em;
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

  .ask-inline-error {
    color: #cf222e;
    font-size: 0.78rem;
  }

  .ask-inline-input-area {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .ask-inline-textarea {
    width: 100%;
    resize: vertical;
    min-height: 3.5rem;
    border: 1px solid #8884;
    border-radius: 4px;
    padding: 0.35rem 0.45rem;
    font-size: 0.8rem;
    font-family: inherit;
    background: transparent;
    color: inherit;
    outline: none;
    box-sizing: border-box;
  }

  .ask-inline-textarea:focus {
    border-color: #8886;
  }

  .ask-inline-textarea:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .ask-inline-submit {
    align-self: flex-end;
    background: none;
    border: 1px solid #8884;
    border-radius: 4px;
    padding: 0.2rem 0.7rem;
    cursor: pointer;
    font-size: 0.8rem;
    font-family: inherit;
  }

  .ask-inline-submit:hover:not(:disabled) {
    border-color: #8887;
    background: #8881;
  }

  .ask-inline-submit:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .ask-copy-btn {
    background: none;
    border: 1px solid #8884;
    border-radius: 3px;
    padding: 0.1rem 0.4rem;
    cursor: pointer;
    font-size: 0.72rem;
    font-family: inherit;
    color: inherit;
    opacity: 0.6;
    display: block;
    margin-top: 0.25rem;
  }

  .ask-copy-btn:hover {
    opacity: 0.9;
    background: #8881;
  }
</style>
