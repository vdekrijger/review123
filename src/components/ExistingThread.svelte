<script lang="ts">
  /**
   * ExistingThread — one existing PR comment thread (root + replies).
   *
   * - Renders the thread via CommentThread (root + indented replies).
   * - Resolved threads collapse into a <details> with a ✓ Resolved summary
   *   (same behavior/classes as before — e2e depends on them).
   * - When onReply is provided, shows a "Reply (posts now)" affordance:
   *   replies to an existing thread post IMMEDIATELY (they are conversation,
   *   not part of the queued review verdict). The button copy is deliberately
   *   honest about this — drafts say "Leave comment", replies say "posts now".
   * - Optimistic insert: the reply body appears in the thread as a pending
   *   entry while the POST is in flight; on failure it is removed and the
   *   error is surfaced with the editor content kept for retry.
   */
  import type { PrComment } from '../lib/github/comments'
  import type { CommentThread as Thread } from '../lib/github/commentThreads'
  import { threadComments } from '../lib/github/commentThreads'
  import type { ReplyOutcome } from '../lib/github/replies'
  import CommentThread from './CommentThread.svelte'
  import CommentEditor from './CommentEditor.svelte'
  import { track } from '../lib/analytics/analytics'

  interface Props {
    thread: Thread
    /** Whether this thread is resolved (collapses into a summary) */
    resolved?: boolean
    /**
     * DI seam for posting a reply to this thread. When null/undefined the
     * Reply affordance is hidden (provider lacks commentReplies capability).
     * Must return a typed Result — never throw.
     */
    onReply?: ((root: PrComment, body: string) => Promise<ReplyOutcome>) | null
  }

  let { thread, resolved = false, onReply = null }: Props = $props()

  const comments = $derived(threadComments(thread))

  // ---- Reply state ----
  let replying = $state(false)
  let replyValue = $state('')
  let posting = $state(false)
  let replyError = $state<string | null>(null)
  /** Optimistic pending reply body shown in the thread while posting */
  let pendingBody = $state<string | null>(null)

  function openReply() {
    replying = true
    replyError = null
  }

  function cancelReply() {
    replying = false
    replyValue = ''
    replyError = null
  }

  async function submitReply() {
    const body = replyValue.trim()
    if (!body || posting || !onReply) return
    posting = true
    replyError = null
    pendingBody = body // optimistic insert — visible in the thread right away

    const result = await onReply(thread.root, body)

    posting = false
    pendingBody = null // success: canonical comment arrives via props; failure: remove
    track('reply_posted', { ok: result.ok })
    if (result.ok) {
      replyValue = ''
      replying = false
    } else {
      // Error surfacing: keep the editor open with the text so the user can retry
      replyError = result.message
    }
  }

  /** Truncates body to ~60 chars for the resolved summary line */
  function truncateBody(body: string, maxLen = 60): string {
    const oneLine = body.replace(/\s+/g, ' ').trim()
    return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '…' : oneLine
  }
</script>

{#snippet threadBody()}
  <CommentThread {comments} />

  {#if pendingBody !== null}
    <div class="reply-pending" data-testid="reply-pending" role="status">
      <span class="reply-pending-spinner" aria-hidden="true"></span>
      <div class="reply-pending-body">{pendingBody}</div>
      <span class="reply-pending-label">Posting…</span>
    </div>
  {/if}

  {#if onReply}
    {#if replying}
      <div class="reply-editor" data-testid="reply-editor">
        <CommentEditor
          value={replyValue}
          onchange={(v) => (replyValue = v)}
          onsubmit={submitReply}
        />
        {#if replyError}
          <p class="reply-error" role="alert" data-testid="reply-error">{replyError}</p>
        {/if}
        <p class="reply-hint">Posts immediately to the PR — not part of your queued review.</p>
        <div class="reply-actions">
          <button
            type="button"
            class="btn btn-primary"
            onclick={submitReply}
            disabled={!replyValue.trim() || posting}
            aria-busy={posting}
          >{posting ? 'Posting…' : 'Reply (posts now)'}</button>
          <button type="button" class="btn" onclick={cancelReply} disabled={posting}>Cancel</button>
        </div>
      </div>
    {:else}
      <div class="reply-actions">
        <button type="button" class="btn reply-open-btn" onclick={openReply}>Reply (posts now)</button>
      </div>
    {/if}
  {/if}
{/snippet}

{#if resolved}
  <details class="resolved-thread">
    <summary class="resolved-summary">
      <span class="resolved-check" aria-hidden="true">✓</span>
      <span class="resolved-label">Resolved</span>
      <span class="resolved-snippet">{thread.root.author}: {truncateBody(thread.root.body)}</span>
    </summary>
    <div class="thread-content">
      {@render threadBody()}
    </div>
  </details>
{:else}
  <div class="existing-thread" data-testid="existing-thread">
    {@render threadBody()}
  </div>
{/if}

<style>
  .existing-thread,
  .thread-content {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  /* Resolved thread — collapsed <details> (classes preserved for e2e) */
  .resolved-thread {
    border: 1px solid var(--hairline);
    border-radius: 4px;
    overflow: hidden;
  }

  .resolved-summary {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    font-size: 0.8rem;
    color: var(--text-muted);
    background: var(--surface-raised);
    list-style: none;
    user-select: none;
  }

  .resolved-summary::-webkit-details-marker {
    display: none;
  }

  .resolved-check {
    color: var(--accent);
    font-size: 0.85rem;
    flex-shrink: 0;
  }

  .resolved-label {
    font-weight: 600;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .resolved-snippet {
    opacity: 0.7;
    font-size: 0.78rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .resolved-thread[open] > .thread-content {
    padding: 0.4rem;
  }

  /* ---- Reply affordance ---- */
  .reply-actions {
    display: flex;
    gap: 0.4rem;
  }

  .reply-open-btn {
    font-size: 0.78rem;
    padding: 0.18rem 0.55rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle, var(--hairline));
    background: transparent;
    color: inherit;
    cursor: pointer;
    opacity: 0.85;
  }

  .reply-open-btn:hover {
    opacity: 1;
    background: var(--surface-raised);
  }

  .reply-editor {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .reply-hint {
    margin: 0;
    font-size: 0.75rem;
    opacity: 0.6;
    font-style: italic;
  }

  .reply-error {
    margin: 0;
    font-size: 0.8rem;
    color: var(--legend-removed-color, #cf222e);
  }

  /* ---- Optimistic pending reply ---- */
  .reply-pending {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    border-left: 2px solid var(--border-subtle, var(--hairline));
    margin-left: 1.5rem;
    padding: 0.4rem 0.75rem;
    border-radius: 0 4px 4px 0;
    background: var(--surface);
    opacity: 0.75;
    font-size: 0.9rem;
  }

  .reply-pending-body {
    flex: 1;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }

  .reply-pending-label {
    font-size: 0.75rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .reply-pending-spinner {
    display: inline-block;
    width: 0.7em;
    height: 0.7em;
    margin-top: 0.25em;
    border: 2px solid var(--text-muted);
    border-top-color: transparent;
    border-radius: 50%;
    animation: reply-spin 0.6s linear infinite;
    flex-shrink: 0;
  }

  @keyframes reply-spin {
    to { transform: rotate(360deg); }
  }
</style>
