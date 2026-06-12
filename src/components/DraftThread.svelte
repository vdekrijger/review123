<script lang="ts">
  /**
   * DraftThread — inline thread widget for a single line comment.
   *
   * Shows an existing draft body (rendered via renderMarkdown) with Edit/Delete buttons,
   * or a CommentEditor in edit/new mode.
   *
   * Single editor surface: typing then clicking "Leave comment" saves as draft (the Save
   * flow), "Ask AI" sends the SAME textarea text as a question (streams the answer below,
   * textarea stays for follow-ups), Cancel closes.
   *
   * Keyboard: Ctrl/Cmd+Enter = Leave comment (Save).
   *
   * Gating: when askDisabledReason is set, the Ask AI button is shown but disabled
   * (the hint text is displayed below the textarea).
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
     * Optional Ask AI function — when provided the "Ask AI" action button appears.
     * Signature mirrors AiRun.ask but also accepts a focus param.
     */
    askFn?: ((q: string, onDelta: (t: string) => void, focus?: AskFocus) => Promise<{ ok: true; answer: string } | { ok: false; error: string }>) | null
    /**
     * Optional disabled reason for Ask AI gating (e.g. "No API key configured.").
     * When set, the Ask AI button is shown but disabled and the hint is displayed.
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
  // Ask AI state (unified with the comment editor surface)
  // ---------------------------------------------------------------------------

  let askLoading = $state(false)
  let conversation = $state<ConversationEntry[]>([])

  const hasAskFn = $derived(askFn !== null && askFn !== undefined)
  const askDisabled = $derived(!!askDisabledReason || askLoading || !editorValue.trim())

  const focus = $derived<AskFocus>({ path, line, excerpt })

  async function submitAsk(q: string) {
    if (!q.trim() || askLoading || !askFn) return

    const trimmed = q.trim()
    // NOTE: textarea stays filled (editorValue not cleared) so user can follow-up
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

  function handleAskClick() {
    void submitAsk(editorValue)
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
  </div>

  {#if editing}
    <!-- Single editor surface for comment + ask AI -->
    <CommentEditor
      value={editorValue}
      onchange={(v) => (editorValue = v)}
      onsubmit={handleSave}
    />

    <!-- AI conversation: streamed answers appear below textarea -->
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

    <!-- Ask disabled hint -->
    {#if askDisabledReason}
      <p class="ask-inline-hint" data-testid="ask-disabled-hint">{askDisabledReason}</p>
    {/if}

    <!-- Bottom action row: Leave comment | [Ask AI] | Cancel -->
    <div class="thread-actions">
      <button
        type="button"
        class="btn btn-primary"
        onclick={handleSave}
        disabled={!editorValue.trim()}
      >Leave comment</button>
      {#if hasAskFn}
        <button
          type="button"
          class="btn btn-ask"
          onclick={handleAskClick}
          disabled={askDisabled}
          aria-busy={askLoading}
        >Ask AI</button>
      {/if}
      <button type="button" class="btn" onclick={handleCancel}>Cancel</button>
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
    flex-wrap: wrap;
  }

  /* Ask AI inline conversation panel */
  .ask-inline-conversation {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    max-height: 240px;
    overflow-y: auto;
    margin-top: 0.4rem;
  }

  .ask-inline-hint {
    font-size: 0.78rem;
    opacity: 0.6;
    margin: 0.25rem 0 0;
    font-style: italic;
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

  .btn-ask {
    border: 1px solid #8884;
    background: none;
    border-radius: 4px;
    padding: 0.25rem 0.7rem;
    cursor: pointer;
    font-size: 0.85rem;
    font-family: inherit;
    color: inherit;
    transition: background 0.1s;
  }

  .btn-ask:hover:not(:disabled) {
    background: #8881;
    border-color: #8887;
  }

  .btn-ask:disabled {
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
