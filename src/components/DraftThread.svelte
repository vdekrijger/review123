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
   * Expand (terse-note expander): "Expand" appears next to Ask AI when the composer has
   * text. It streams an LLM-expanded version of the note into a PREVIEW panel with
   * [Use] [Keep my note] — the composer text is never replaced without approval. "Use"
   * puts the expanded text into the (still editable) composer; "Keep my note" (or Esc)
   * dismisses the preview untouched. NOTE: the spec'd separate "Edit" action collapses
   * into "Use" here — the composer is a single always-editable surface, so "use then
   * edit" and "edit" are the same action.
   *
   * Keyboard: Ctrl/Cmd+Enter = Leave comment (Save). Esc with the expand preview open =
   * Keep my note.
   *
   * Gating: when askDisabledReason is set, the Ask AI and Expand buttons are shown but
   * disabled (the hint text is displayed below the textarea) — same keyless handling
   * for both.
   */
  import type { AskFocus } from '../lib/ai/tasks'
  import { renderMarkdown } from '../lib/markdown/render'
  import CommentEditor from './CommentEditor.svelte'
  import MarkdownView from './MarkdownView.svelte'
  import type { Draft } from '../lib/drafts/drafts.svelte'
  import { draftTimeLabel, draftTimeTitle } from '../lib/drafts/drafts.svelte'

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
     * Optional terse-note expander — when provided the "Expand" action button
     * appears while the composer has text. Mirrors AiRun.expandComment: streams
     * the expanded comment via onDelta, grounded at this comment's anchor.
     */
    expandFn?: ((note: string, onDelta: (t: string) => void, focus: { path: string; line: number; side: 'LEFT' | 'RIGHT' }) => Promise<{ ok: true; comment: string } | { ok: false; error: string; errorDetail?: string }>) | null
    /**
     * Optional disabled reason for Ask AI gating (e.g. "No API key configured.").
     * When set, the Ask AI button is shown but disabled and the hint is displayed.
     * Gates the Expand button the same way (both need the same BYO key).
     */
    askDisabledReason?: string | null
    /**
     * The PR's CURRENT head sha. When the draft was made on a DIFFERENT commit
     * (`draft.headSha` set and ≠ this), a small "from commit abc1234" note is
     * shown so the reviewer understands a draft carried over from an earlier
     * commit (it may sit in the unanchored fallback block if its line moved).
     */
    currentHeadSha?: string
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
    side,
    onsave,
    ondelete,
    oncancel,
    askFn = null,
    expandFn = null,
    askDisabledReason = null,
    excerpt = '',
    startLine,
    currentHeadSha = undefined,
  }: Props = $props()

  /**
   * Short source-commit label when this draft was made on a commit OTHER than
   * the PR's current head (e.g. it was carried over after the author pushed).
   * null when same-commit, unknown, or composing a new draft.
   */
  const fromCommit = $derived(
    draft?.headSha && currentHeadSha && draft.headSha !== currentHeadSha
      ? draft.headSha.slice(0, 7)
      : null
  )

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
    // Identity includes the ordinal n: multiple DraftThreads can coexist at the
    // same line (one per draft) — each instance tracks ITS draft, and a body
    // edit (same key) must not reset the editor state.
    const key = draft ? `${draft.prKey}|${draft.path}|${draft.line}|${draft.side}|${draft.n ?? 0}` : null
    if (key !== lastDraftKey) {
      lastDraftKey = key ?? undefined
      if (draft === null) {
        editing = true
        editorValue = ''
      } else {
        editing = false
        editorValue = draft.body
      }
      // A different draft loaded → any in-flight/preview expansion is stale.
      resetExpand()
    }
  })

  function handleSave() {
    if (editorValue.trim()) {
      onsave(editorValue)
      editing = false
      resetExpand()
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
    resetExpand()
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

  // ---------------------------------------------------------------------------
  // Expand — terse note → full review comment (preview, user-approved)
  // ---------------------------------------------------------------------------

  let expandLoading = $state(false)
  /** Completed expansion awaiting the user's Use / Keep-my-note decision. */
  let expandPreview = $state<string | null>(null)
  /** Text streamed so far while an expansion is in flight. */
  let expandStreamText = $state('')
  let expandError = $state<string | null>(null)
  /** Concrete upstream failure detail — surfaced on hover (errorDetail idiom). */
  let expandErrorDetail = $state<string | null>(null)

  const hasExpandFn = $derived(expandFn !== null && expandFn !== undefined)
  // Visible only when the composer has a note to expand; disabled while running
  // or when keyless (same askDisabledReason gate as Ask AI).
  const expandVisible = $derived(hasExpandFn && editorValue.trim().length > 0)
  const expandDisabled = $derived(!!askDisabledReason || expandLoading)

  function resetExpand() {
    expandLoading = false
    expandPreview = null
    expandStreamText = ''
    expandError = null
    expandErrorDetail = null
  }

  async function submitExpand() {
    const note = editorValue.trim()
    if (!note || expandLoading || !expandFn) return

    // Composer text is PRESERVED — the result goes to the preview panel only.
    expandLoading = true
    expandPreview = null
    expandStreamText = ''
    expandError = null
    expandErrorDetail = null

    const result = await expandFn(note, (delta) => {
      expandStreamText += delta
    }, { path, line, side })

    if (result.ok) {
      expandPreview = result.comment
    } else {
      expandError = result.error
      expandErrorDetail = result.errorDetail ?? null
    }
    expandStreamText = ''
    expandLoading = false
  }

  /** Use: expanded text replaces the composer content — still editable before Save. */
  function useExpanded() {
    if (expandPreview !== null) {
      editorValue = expandPreview
    }
    resetExpand()
  }

  /** Keep my note: dismiss the preview; the composer is untouched. */
  function keepMyNote() {
    resetExpand()
  }

  /** Esc with the preview (or an expand error) open = Keep my note. */
  function handleExpandWindowKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return
    if (expandPreview === null && expandError === null) return
    e.stopPropagation()
    keepMyNote()
  }
</script>

<svelte:window onkeydown={handleExpandWindowKeydown} />

<div class="draft-thread" data-testid="draft-thread" data-line={line}>
  <div class="thread-header">
    {#if effectiveStartLine !== null}
      <span class="thread-label">Lines {effectiveStartLine}–{line}</span>
    {:else}
      <span class="thread-label">Comment at line {line}</span>
    {/if}
    {#if draft?.aiAuthored}
      <span
        class="ai-badge"
        data-testid="draft-ai-badge"
        title={`Suggested by an AI reviewer (${draft.aiReviewer ?? 'AI reviewer'})`}
        aria-label={`Suggested by an AI reviewer: ${draft.aiReviewer ?? 'AI reviewer'}`}
      >🤖 AI</span>
    {/if}
    {#if fromCommit}
      <span class="thread-from-commit" data-testid="draft-from-commit" title="This draft was made on an earlier commit of this PR">from commit {fromCommit}</span>
    {/if}
    {#if draft !== null && !editing}
      <!-- View-mode creation-time chip: relative age, exact datetime on hover;
           "earlier session" for drafts that predate the createdAt field. -->
      <span
        class="thread-time"
        data-testid="draft-created-at"
        title={draftTimeTitle(draft.createdAt)}
      >{draftTimeLabel(draft.createdAt)}</span>
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

    <!-- Expand: streaming/loading state, preview panel, or inline error -->
    {#if expandLoading}
      <div class="expand-preview" data-testid="expand-preview" aria-live="polite">
        <div class="expand-preview-label">Expanding your note…</div>
        {#if expandStreamText}
          <div class="expand-streaming" data-testid="expand-streaming">{expandStreamText}<span class="ask-inline-cursor" aria-hidden="true"></span></div>
        {/if}
      </div>
    {:else if expandPreview !== null}
      <div class="expand-preview" data-testid="expand-preview">
        <div class="expand-preview-label">Expanded comment</div>
        <div class="expand-preview-body" data-testid="expand-preview-body">
          <MarkdownView source={expandPreview} />
        </div>
        <div class="expand-preview-actions">
          <button type="button" class="btn btn-primary" onclick={useExpanded} data-testid="expand-use">Use</button>
          <button type="button" class="btn" onclick={keepMyNote} data-testid="expand-keep">Keep my note</button>
        </div>
      </div>
    {:else if expandError}
      <!-- Calm inline error: concrete upstream detail on hover (errorDetail idiom);
           the composer is untouched and Retry re-runs with the same note. -->
      <div class="expand-error" role="alert" title={expandErrorDetail ?? undefined} data-testid="expand-error">
        <span>{expandError}</span>
        <button type="button" class="btn" onclick={() => void submitExpand()} data-testid="expand-retry">Retry</button>
      </div>
    {/if}

    <!-- Ask disabled hint -->
    {#if askDisabledReason}
      <p class="ask-inline-hint" data-testid="ask-disabled-hint">{askDisabledReason}</p>
    {/if}

    <!-- Bottom action row: Leave comment | [Ask AI] | [Expand] | Cancel -->
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
      {#if expandVisible}
        <button
          type="button"
          class="btn btn-ask"
          onclick={() => void submitExpand()}
          disabled={expandDisabled}
          aria-busy={expandLoading}
          data-testid="expand-btn"
          title="Expand this note into a full review comment (AI) — you approve before it replaces anything"
        >{expandLoading ? 'Expanding…' : 'Expand'}</button>
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

  .ai-badge {
    font-size: 0.72rem;
    font-weight: 600;
    line-height: 1;
    padding: 0.12rem 0.4rem;
    border-radius: 999px;
    border: 1px solid var(--border-draft, #f0b44488);
    background: var(--surface-raised, #fff6df);
    color: var(--text-muted, #b8862a);
    white-space: nowrap;
    margin-left: auto;
    cursor: help;
  }

  /* When the AI badge is present it already claimed the auto margin; keep a small
     gap before the from-commit chip instead of a second auto push. */
  .ai-badge + .thread-from-commit {
    margin-left: 0.4rem;
  }

  .thread-from-commit {
    font-size: 0.72rem;
    font-weight: 500;
    opacity: 0.75;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    border: 1px solid var(--border-draft, #f0b44488);
    color: var(--text-muted, #b8862a);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    margin-left: auto;
  }

  .thread-time {
    font-size: 0.72rem;
    font-weight: 500;
    opacity: 0.75;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    border: 1px solid var(--border-draft, #f0b44488);
    color: var(--text-muted, #b8862a);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    margin-left: auto;
    cursor: help;
  }

  /* Any earlier chip already claimed the auto margin — keep a small gap only. */
  .ai-badge ~ .thread-time,
  .thread-from-commit ~ .thread-time {
    margin-left: 0.4rem;
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
    /* theme-aware error red (was hardcoded #cf222e — unreadable on dark surfaces) */
    color: var(--legend-removed-color, #cf222e);
    font-size: 0.78rem;
  }

  /* Expand preview panel (terse-note expander) */
  .expand-preview {
    margin-top: 0.4rem;
    padding: 0.4rem 0.55rem;
    border: 1px solid #8884;
    border-radius: 6px;
    background: var(--surface-raised, #fff6df);
  }

  .expand-preview-label {
    font-size: 0.72rem;
    font-weight: 600;
    opacity: 0.65;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    margin-bottom: 0.25rem;
  }

  .expand-preview-body {
    font-size: 0.85rem;
    line-height: 1.45;
    word-break: break-word;
  }

  .expand-preview-body :global(p:first-child) { margin-top: 0; }
  .expand-preview-body :global(p:last-child) { margin-bottom: 0; }
  .expand-preview-body :global(code) { font-size: 0.85em; background: var(--surface, #fff); padding: 0.1em 0.3em; border-radius: 3px; }
  .expand-preview-body :global(pre) { background: var(--surface, #fff); padding: 0.5rem; border-radius: 4px; overflow-x: auto; }
  .expand-preview-body :global(pre code) { background: none; padding: 0; }

  .expand-preview-actions {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.4rem;
    flex-wrap: wrap;
  }

  .expand-streaming {
    font-size: 0.85rem;
    line-height: 1.45;
    word-break: break-word;
    opacity: 0.85;
    white-space: pre-wrap;
  }

  .expand-error {
    /* same theme-aware error red as the ask inline error; concrete upstream
       detail rides on the title attribute (hover) */
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    color: var(--legend-removed-color, #cf222e);
    font-size: 0.78rem;
    margin-top: 0.4rem;
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
