<script lang="ts">
  /**
   * DraftThread — inline thread widget for a single line comment.
   *
   * Shows an existing draft body (rendered via renderMarkdown) with Edit/Delete buttons,
   * or a CommentEditor in edit/new mode.
   *
   * TWO SURFACES, NOT ONE. The composer is what you PUBLISH; the Ask AI panel is a
   * consultation you do NOT publish. They used to share one textarea — "Ask AI" sent
   * whatever was in the comment draft as the question — so the same sentence appeared
   * both as an unsent draft and as a sent question bubble and no reader could tell
   * which it was. One input with two meanings is the bug, so the question now has its
   * own input inside the Ask AI panel and the composer is only ever the comment.
   *
   * The panel reads like every other chat surface: transcript ABOVE, composer BELOW,
   * newest exchange adjacent to the input. It sits UNDER the action row, so "Leave
   * comment" keeps its position no matter how long the conversation grows.
   *
   * Single editor surface: typing then clicking "Leave comment" saves as draft (the Save
   * flow), "Ask AI" opens/closes the consultation panel, Cancel closes.
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
   * disabled (the hint text is displayed below the action row) — same keyless handling
   * for both. Nothing else disables Ask AI: it used to be disabled whenever the composer
   * was empty, which was a dead end with no stated reason (the panel has its own input
   * now, so an empty composer is irrelevant to it).
   */
  import type { AskFocus } from '../lib/ai/tasks'
  import { renderMarkdown } from '../lib/markdown/render'
  import CommentEditor from './CommentEditor.svelte'
  import MarkdownView from './MarkdownView.svelte'
  import type { Draft } from '../lib/drafts/drafts.svelte'
  import { draftTimeLabel, draftTimeTitle } from '../lib/drafts/drafts.svelte'

  interface ConversationEntry {
    /**
     * Stable identity for the keyed #each. The key USED to be
     * `question + answer.slice(0, 20)`, which mutates on every streamed delta
     * until the answer is 20 characters long — Svelte tears the block down and
     * rebuilds it on each one — and collides outright when the same question is
     * asked twice. A monotonic id is the identity; the text is the content.
     */
    id: number
    question: string
    answer: string
    streaming: boolean
    error: string | null
  }

  /** Monotonic source for ConversationEntry.id — one counter per thread, which is
      all a keyed #each needs (keys only have to be unique within their own block). */
  let nextEntryId = 0

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
      // A different draft loaded → any in-flight/preview expansion, and the
      // consultation that belonged to the old draft, are stale.
      resetExpand()
      resetAsk()
    }
  })

  function handleSave() {
    if (editorValue.trim()) {
      onsave(editorValue)
      editing = false
      resetExpand()
      resetAsk()
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
    resetAsk()
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
  // Ask AI — a consultation panel with its OWN input, separate from the composer
  // ---------------------------------------------------------------------------

  let askLoading = $state(false)
  let conversation = $state<ConversationEntry[]>([])
  /** Is the consultation panel open? The "Ask AI" action row button toggles it. */
  let askOpen = $state(false)
  /** The QUESTION. Deliberately not `editorValue` — see the header comment. */
  let askQuestion = $state('')
  let askInputEl = $state<HTMLTextAreaElement | null>(null)
  let transcriptEl = $state<HTMLElement | null>(null)

  const hasAskFn = $derived(askFn !== null && askFn !== undefined)
  /**
   * The TOGGLE is gated only by the keyless reason — which is stated, right
   * below the row. An empty composer no longer disables it: the panel asks its
   * own question, and a control disabled for a reason it does not give is a
   * dead end (rubric p.52-53).
   */
  const askToggleDisabled = $derived(!!askDisabledReason)
  /** The SEND button inside the panel: needs a question, and one at a time. */
  const askSendDisabled = $derived(!!askDisabledReason || askLoading || !askQuestion.trim())

  const focus = $derived<AskFocus>({ path, line, excerpt })

  /** Panel id for aria-controls — unique per mounted thread. */
  const panelId = `ask-panel-${Math.random().toString(36).slice(2, 9)}`

  function resetAsk() {
    askOpen = false
    askQuestion = ''
    conversation = []
    askLoading = false
  }

  function toggleAsk() {
    askOpen = !askOpen
    if (askOpen) {
      // Keyboard-first: the panel's own input takes focus when it opens.
      queueMicrotask(() => askInputEl?.focus())
    }
  }

  /** Keep the newest exchange next to the input the way every chat surface does. */
  function scrollTranscriptToEnd() {
    const el = transcriptEl
    if (el) el.scrollTop = el.scrollHeight
  }

  async function submitAsk(q: string) {
    if (!q.trim() || askLoading || !askFn) return

    const trimmed = q.trim()
    // The QUESTION input clears on send (it has been sent); the COMPOSER is
    // never touched by asking — that separation is the whole point.
    askQuestion = ''
    askLoading = true

    const entry: ConversationEntry = { id: nextEntryId++, question: trimmed, answer: '', streaming: true, error: null }
    conversation = [...conversation, entry]
    const entryIndex = conversation.length - 1
    scrollTranscriptToEnd()

    const result = await askFn(trimmed, (delta) => {
      conversation = conversation.map((e, i) =>
        i === entryIndex ? { ...e, answer: e.answer + delta, streaming: true } : e,
      )
      scrollTranscriptToEnd()
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
    scrollTranscriptToEnd()
  }

  function handleAskSubmit() {
    void submitAsk(askQuestion)
  }

  /** Retry drops the failed turn and re-asks the same question (mirrors AskAi). */
  function retryAsk(entry: ConversationEntry) {
    const q = entry.question
    conversation = conversation.filter((e) => e.id !== entry.id)
    void submitAsk(q)
  }

  function handleAskKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      askOpen = false
      return
    }
    // Enter (or Cmd/Ctrl+Enter) sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!askSendDisabled) handleAskSubmit()
    }
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

  /**
   * Monotonic run id: resetExpand() bumps it so an in-flight expansion that
   * resolves AFTER a save/cancel/draft-switch is discarded instead of
   * resurrecting a stale preview.
   */
  let expandSeq = 0

  function resetExpand() {
    expandSeq++
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
    const seq = ++expandSeq
    expandLoading = true
    expandPreview = null
    expandStreamText = ''
    expandError = null
    expandErrorDetail = null

    const result = await expandFn(note, (delta) => {
      if (seq !== expandSeq) return
      expandStreamText += delta
    }, { path, line, side })

    // Stale run (the user saved/cancelled/switched drafts meanwhile): drop it.
    if (seq !== expandSeq) return

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
    <!--
      REGION 1 — YOUR COMMENT. Everything down to the action row is the thing
      that gets published: the composer, the expansion awaiting approval, and
      the actions that act on them. The consultation lives below, on its own.
    -->
    <CommentEditor
      value={editorValue}
      onchange={(v) => (editorValue = v)}
      onsubmit={handleSave}
    />

    <!--
      Expand: streaming state, preview panel, or inline error. It sits DIRECTLY
      under the composer because Use / Keep my note act on the composer — a
      control belongs nearer its own target than the next group (p.83, p.86).
      It used to sit below the whole transcript.
    -->
    {#if expandLoading}
      <div class="ai-card expand-preview" data-testid="expand-preview" aria-live="polite">
        <span class="ai-card-tag">AI · expanding your note…</span>
        {#if expandStreamText}
          <div class="ai-card-body expand-streaming" data-testid="expand-streaming">{expandStreamText}<span class="ask-cursor" aria-hidden="true"></span></div>
        {/if}
      </div>
    {:else if expandPreview !== null}
      <div class="ai-card expand-preview" data-testid="expand-preview">
        <span class="ai-card-tag">AI · expanded comment</span>
        <div class="ai-card-body expand-preview-body" data-testid="expand-preview-body">
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

    <!--
      Action row, ranked rather than four peers (p.52-53): ONE solid primary,
      quiet outlined secondaries for the two AI actions, and a link-styled
      tertiary for the dismissive one. It sits ABOVE the consultation panel, so
      the button you came for never drifts as the conversation grows.
    -->
    <div class="thread-actions">
      <button
        type="button"
        class="btn btn-primary"
        onclick={handleSave}
        disabled={!editorValue.trim()}
      >Leave comment</button>
      {#if expandVisible}
        <button
          type="button"
          class="btn"
          onclick={() => void submitExpand()}
          disabled={expandDisabled}
          aria-busy={expandLoading}
          data-testid="expand-btn"
          title={askDisabledReason ?? 'Expand this note into a full review comment (AI) — you approve before it replaces anything'}
        >{expandLoading ? 'Expanding…' : 'Expand'}</button>
      {/if}
      {#if hasAskFn}
        <button
          type="button"
          class="btn"
          onclick={toggleAsk}
          disabled={askToggleDisabled}
          aria-expanded={askOpen}
          aria-controls={panelId}
          data-testid="ask-toggle"
          title={askDisabledReason ?? 'Ask a question about this line — the answer is never part of your comment'}
        >Ask AI{#if conversation.length > 0 && !askOpen}&nbsp;({conversation.length}){/if}</button>
      {/if}
      <button type="button" class="btn btn-quiet" onclick={handleCancel}>Cancel</button>
    </div>

    <!-- A disabled control that does not say why is a dead end — so the one
         reason that DOES disable Ask AI and Expand is stated right here. -->
    {#if askDisabledReason}
      <p class="ask-hint" data-testid="ask-disabled-hint">{askDisabledReason}</p>
    {/if}

    <!--
      REGION 2 — THE CONSULTATION. Its own input, its own transcript, and the
      conventional reading order: history above, composer below, newest
      exchange next to the box you type in.
    -->
    {#if hasAskFn && askOpen}
      <section class="ask-panel" id={panelId} data-testid="ask-panel" aria-label="Ask AI about this line">
        <p class="ask-panel-note">Answers are never part of your comment and are not saved.</p>

        {#if conversation.length > 0}
          <div class="ask-transcript" bind:this={transcriptEl} aria-live="polite" data-testid="ask-conversation">
            {#each conversation as entry (entry.id)}
              <div class="ask-turn">
                <div class="ask-question" data-testid="ask-question">
                  <span class="turn-tag">You</span>
                  <span class="ask-question-text">{entry.question}</span>
                </div>
                {#if entry.streaming && !entry.error}
                  <div class="ai-card ask-answer">
                    <span class="ai-card-tag">AI</span>
                    <div class="ai-card-body ask-streaming">{entry.answer}<span class="ask-cursor" aria-hidden="true"></span></div>
                  </div>
                {:else if entry.error}
                  <div class="ask-error" role="alert" data-testid="ask-error">
                    <span>{entry.error}</span>
                    <button type="button" class="btn" onclick={() => retryAsk(entry)} data-testid="ask-retry">Retry</button>
                  </div>
                {:else}
                  <div class="ai-card ask-answer">
                    <span class="ai-card-tag">AI</span>
                    <div class="ai-card-body" data-testid="ask-answer">
                      <MarkdownView source={entry.answer} />
                    </div>
                    <div class="ai-card-foot">
                      <button
                        type="button"
                        class="btn btn-quiet"
                        onclick={() => copyAnswer(entry.answer)}
                        data-testid="copy-answer-btn"
                      >Copy answer</button>
                    </div>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {:else}
          <p class="ask-empty">No questions yet. Ask about this line and its diff — grounded at {path}:{line}.</p>
        {/if}

        <div class="ask-composer">
          <textarea
            bind:this={askInputEl}
            bind:value={askQuestion}
            onkeydown={handleAskKeydown}
            class="ask-input"
            rows="2"
            placeholder="Ask about this line…"
            disabled={!!askDisabledReason}
            aria-label="Ask AI a question about this line"
            data-testid="ask-question-input"
          ></textarea>
          <button
            type="button"
            class="btn ask-send"
            onclick={handleAskSubmit}
            disabled={askSendDisabled}
            aria-busy={askLoading}
            data-testid="ask-send"
          >{askLoading ? 'Asking…' : 'Ask'}</button>
        </div>
      </section>
    {/if}
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
    padding: var(--space-3);
    background: var(--surface-draft, #fffbf0);
    color: var(--text-draft, #333);
    /* Chrome — labels, chips, buttons — is UI, not code. The widget renders
       inside the monospace diff surface, so without this every word in it
       inherits IBM Plex Mono. Prose blocks opt into --font-prose below. */
    font-family: var(--font-ui);
    font-size: var(--text-sm);
  }

  .thread-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-2);
  }

  .thread-label {
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-secondary);
  }

  .ai-badge {
    font-size: var(--text-xs);
    font-weight: 600;
    line-height: 1;
    padding: 0.125rem var(--space-1);
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
    margin-left: var(--space-1);
  }

  .thread-from-commit {
    font-size: var(--text-xs);
    font-weight: 500;
    opacity: 0.75;
    padding: 0.125rem var(--space-1);
    border-radius: 999px;
    border: 1px solid var(--border-draft, #f0b44488);
    color: var(--text-muted, #b8862a);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    margin-left: auto;
  }

  .thread-time {
    font-size: var(--text-xs);
    font-weight: 500;
    opacity: 0.75;
    padding: 0.125rem var(--space-1);
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
    margin-left: var(--space-1);
  }

  /*
   * The saved comment. `.prose` supplies Newsreader; this keeps the size a step
   * down from a page-level prose block but KEEPS the measure. It used to say
   * `max-width: none`, which let a saved comment run the full width of the diff
   * — the same unbounded line the AI answer had (p.99-101).
   */
  .draft-body {
    padding: var(--space-1) 0;
    font-size: var(--text-base);
    max-width: var(--measure-prose);
  }

  /* Normalize markdown output inside the draft body */
  .draft-body :global(p) { margin: 0 0 0.5em; }
  .draft-body :global(p:last-child) { margin-bottom: 0; }
  /* A2: code keeps the code face and sets its own measure. */
  .draft-body :global(code),
  .draft-body :global(pre) { font-family: var(--font-mono); }
  .draft-body :global(pre) { background: var(--surface-sunken); padding: var(--space-2); border-radius: 4px; overflow-x: auto; max-width: none; }
  .draft-body :global(code) { font-size: 0.85em; background: var(--surface-sunken); padding: 0.1em 0.3em; border-radius: 3px; }
  .draft-body :global(pre code) { background: none; padding: 0; }

  .thread-actions {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-3);
    flex-wrap: wrap;
    align-items: center;
  }

  /*
   * TERTIARY action (p.52-53). Cancel is dismissive: it must not carry the same
   * weight as a feature action. No fill, no rim — a link-styled control at
   * secondary ink. It keeps .btn's padding and focus ring so the hit target and
   * keyboard affordance are unchanged.
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

  /* ─────────────────────────────────────────────────────────────────────────
     AI OUTPUT CARD — one treatment for every block of model-written prose in
     this widget (a streamed answer, an expansion awaiting approval).
     Four signals, not one (p.30-33): a card that a SHADOW lifts off the ground
     (p.158 — a shadow is z-position, and unlike "lighter than its ground" it
     reads the same in both themes), a 2px accent rail down its side (p.50-51,
     p.195-197), an uppercase AI tag, and the prose face at full ink. The tag
     and the rail are also the HONESTY signal: model text never renders as the
     reviewer's own words.
     ───────────────────────────────────────────────────────────────────────── */
  .ai-card {
    margin-top: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--hairline);
    border-left: 2px solid var(--accent);
    border-radius: 6px;
    background: var(--surface);
    box-shadow: var(--elevation-1);
  }

  .ai-card-tag {
    display: block;
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    font-weight: 500;
    /* p.117: all-caps runs get ~0.05em tracking. */
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
    margin-bottom: var(--space-1);
  }

  /*
   * THE ANSWER IS PROSE. Every font-family in this component used to be
   * `inherit`, and the widget renders inside the monospace diff surface — so
   * the model's sentences came out in IBM Plex Mono at whatever width the
   * container happened to be. Prose gets the prose face and the prose measure
   * (p.99-101, amendment A2); the code INSIDE it stays mono, below.
   */
  .ai-card-body {
    font-family: var(--font-prose);
    font-size: var(--text-sm);
    line-height: 1.6;
    max-width: var(--measure-prose);
    color: var(--text-draft, #333);
    word-break: break-word;
  }

  .ai-card-body :global(p:first-child) { margin-top: 0; }
  .ai-card-body :global(p:last-child) { margin-bottom: 0; }
  /* A2: code sets its own measure and keeps the code face. */
  .ai-card-body :global(code),
  .ai-card-body :global(pre) {
    font-family: var(--font-mono);
  }
  .ai-card-body :global(code) {
    font-size: 0.85em;
    background: var(--surface-sunken);
    padding: 0.1em 0.3em;
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

  .ai-card-foot {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--space-2);
  }

  /* ── Expand preview (terse-note expander) ── */

  .expand-preview-actions {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-2);
    flex-wrap: wrap;
  }

  .expand-streaming {
    white-space: pre-wrap;
  }

  .expand-error {
    /* theme-aware error red; concrete upstream detail rides on the title
       attribute (hover) */
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    color: var(--legend-removed-color, #cf222e);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    margin-top: var(--space-2);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     THE CONSULTATION PANEL — transcript above, composer below.
     It hangs BELOW the action row, so "Leave comment" cannot drift, and it is
     separated by space plus ONE hairline rather than a second box (p.206-209).
     ───────────────────────────────────────────────────────────────────────── */
  .ask-panel {
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--hairline);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .ask-panel-note,
  .ask-empty,
  .ask-hint {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    font-weight: 500;
    line-height: 1.5;
    color: var(--text-secondary);
    margin: 0;
  }

  .ask-hint {
    margin-top: var(--space-2);
  }

  .ask-transcript {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-height: 18rem;
    overflow-y: auto;
  }

  /* p.83: the space AROUND a turn exceeds the space INSIDE it, so a question
     reads as attached to its own answer rather than to the next question. */
  .ask-turn {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  /*
   * The question is SECONDARY — it is the reviewer's own words, already known.
   * Demoted on size AND colour, so 500 is the standing weight exception.
   */
  .ask-question {
    align-self: flex-end;
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    max-width: 90%;
    padding: var(--space-1) var(--space-2);
    border-radius: 8px 8px 2px 8px;
    background: var(--surface-sunken);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-secondary);
    word-break: break-word;
  }

  .turn-tag {
    flex-shrink: 0;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  .ask-streaming {
    /* Streaming is an honesty signal, not decoration: partial text must LOOK
       partial. Colour, not opacity, so it never drops below the contrast floor. */
    color: var(--text-secondary);
    white-space: pre-wrap;
  }

  .ask-cursor {
    display: inline-block;
    width: 5px;
    height: 0.85em;
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
    .ask-cursor { animation: none; }
  }

  .ask-error {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    color: var(--legend-removed-color, #cf222e);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
  }

  /* The composer sits at the BOTTOM, next to the newest exchange. */
  .ask-composer {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .ask-input {
    flex: 1 1 auto;
    min-width: 0;
    resize: vertical;
    box-sizing: border-box;
    border: 1px solid var(--border-control);
    border-radius: 6px;
    padding: var(--space-2) var(--space-3);
    /* The question is prose the reviewer writes, not code. */
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    line-height: 1.5;
    background: var(--surface);
    color: var(--text);
  }

  .ask-input::placeholder { color: var(--text-muted); }

  .ask-input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .ask-input:disabled {
    opacity: var(--disabled-opacity);
    cursor: not-allowed;
  }

  .ask-send {
    flex-shrink: 0;
  }

  /* Narrow widgets (split diff, narrow window): the composer stacks rather
     than squeezing the input to nothing. */
  @media (max-width: 40rem) {
    .ask-composer {
      flex-direction: column;
      align-items: stretch;
    }

    .ask-send {
      align-self: flex-end;
    }
  }
</style>
