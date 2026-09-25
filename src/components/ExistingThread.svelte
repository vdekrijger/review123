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
   * - Bodies pass through presentCommentBody first — see § THE BULK, below.
   */
  import type { PrComment } from '../lib/github/comments'
  import type { CommentThread as Thread } from '../lib/github/commentThreads'
  import { threadComments } from '../lib/github/commentThreads'
  import type { ReplyOutcome } from '../lib/github/replies'
  import CommentThread from './CommentThread.svelte'
  import CommentEditor from './CommentEditor.svelte'
  import { track } from '../lib/analytics/analytics'
  import { presentCommentBody } from '../lib/guide/botCommentBody'
  import { isReviewBotAuthor } from '../lib/bridge/botComments'

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

  // ---- THE BULK: what a revealed bot comment costs to show ----------------
  //
  // Hiding bot comments is the default, not the only state. In the screenshot
  // that prompted the filter, each posthog[bot] comment cost ~200px TO SHOW
  // NOTHING: its whole body was four collapsed <details> — "Issue
  // description", "Why we think it's a valid issue", "Suggested fix", "Prompt
  // to fix with AI (copy-paste)". Four disclosure rows conveying a title.
  //
  // src/lib/guide/botCommentBody.ts does two narrow things about it, on the
  // markdown SOURCE, before it reaches the existing renderMarkdown → marked →
  // DOMPurify boundary. Nothing here interprets the text or weakens that
  // boundary: a bot comment is still untrusted third-party data, rendered
  // exactly as it was, minus one redundant section and with one <details>
  // starting open. See that module's header for why the matching is as narrow
  // as it is — this is somebody else's markdown.
  //
  // The AI-prompt drop is gated on the author being a review bot, reusing the
  // SAME isReviewBotAuthor the filter and the fixing panel use. Opening a
  // shut-by-default first section is not, because a person whose body is four
  // collapsed <details> has the identical problem and nothing is removed.
  const presented = $derived(
    threadComments(thread).map((c) => {
      const out = presentCommentBody(c.body, isReviewBotAuthor(c.author))
      return { comment: out.body === c.body ? c : { ...c, body: out.body }, stripped: out.stripped }
    }),
  )

  const comments = $derived(presented.map((p) => p.comment))

  /** How many comments here lost their copy-paste AI prompt. Stated, never silent. */
  const promptSectionsHidden = $derived(presented.filter((p) => p.stripped).length)

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

  /** The handful of HTML entities that actually show up in PR comment bodies. */
  const ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    '#39': "'",
    '#x27': "'",
  }

  /**
   * Markup → plain text, for the one-line resolved summary ONLY.
   *
   * This is deliberately NOT renderMarkdown: the summary is a recap, not a
   * rendered comment, and it must stay a single line of prose. It strips the
   * markup a comment body can OPEN with so the snippet reads as words —
   * review-bot comments in particular start with a badge image or a link
   * (`[![P1](https://…)](…)`, `<a href="#"><img alt="P1" src="…">`), which
   * used to be what the reader saw instead of the comment.
   *
   * Image alt text is KEPT: for `![P1](url)` the alt IS the content, and it is
   * the conventional plain-text rendering of an image.
   */
  function toPlainText(body: string): string {
    return (
      body
        // HTML comments (often a bot's machine-readable marker) and code fences
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/```[^\n]*/g, ' ')
        // ![alt](src) and <img alt="…"> → the alt text
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<img\b[^>]*?\balt\s*=\s*"([^"]*)"[^>]*>/gi, '$1')
        .replace(/<img\b[^>]*?\balt\s*=\s*'([^']*)'[^>]*>/gi, '$1')
        // [text](href) → the link text
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        // every remaining tag (a real tag only — `a < b` must survive)
        .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
        // emphasis / strike / inline code markers. Paired forms only, so a
        // bare identifier like DEBOUNCE_MS keeps its underscores.
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*\n]+)\*/g, '$1')
        .replace(/~~([^~]+)~~/g, '$1')
        .replace(/`+/g, '')
        // line-leading markup: headings, block quotes, list bullets
        .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
        .replace(/^[ \t]*>[ \t]?/gm, '')
        .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, '')
        // entities last, so a decoded `<` is never mistaken for a tag
        .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
        .replace(/\s+/g, ' ')
        .trim()
    )
  }

  /**
   * Truncates body to ~60 chars for the resolved summary line.
   *
   * Order matters: markup is stripped BEFORE the slice, so the 60 characters
   * are 60 characters of CONTENT. Slicing the raw body first spent the whole
   * budget on `<a href="#"><img alt="P1" src="https://greptile-static-asset…`.
   */
  function truncateBody(body: string, maxLen = 60): string {
    const text = toPlainText(body)
    return text.length > maxLen ? text.slice(0, maxLen) + '…' : text
  }
</script>

{#snippet threadBody()}
  <CommentThread {comments} />

  <!-- Nothing is hidden silently, a section of somebody's comment least of
       all. One line per thread, in the same muted register as the reply hint,
       saying what went and why it is not a loss. -->
  {#if promptSectionsHidden > 0}
    <p class="prompt-section-note" data-testid="bot-prompt-section-hidden">
      Copy-paste AI prompt hidden — this app sends the comment itself to the fixing agent.
    </p>
  {/if}

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

  /*
   * The global editorial rule `details > summary` (src/app.css) sets
   * text-transform: uppercase + letter-spacing on EVERY summary, and both
   * properties inherit into the children. That is right for a summary that is
   * a LABEL; this one also carries a sentence of somebody's comment, and
   * uppercasing prose destroys word shape — the snippet rendered as
   * "VDEKRIJGER: THERE IS NO CENTRALISED HELPER WE COULD USE FOR THIS? E.G. I…".
   * The same rule's font-weight: 600 set the whole sentence semibold for the
   * same reason. So reset all three here and re-apply them on .resolved-label
   * alone, which IS a label. Class selectors (+ Svelte's scoping class) outrank
   * the two type selectors in `details > summary`, so app.css stays untouched.
   */
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
    text-transform: none;
    letter-spacing: normal;
    font-weight: 400;
  }

  .resolved-summary::-webkit-details-marker {
    display: none;
  }

  .resolved-check {
    color: var(--accent);
    font-size: 0.85rem;
    flex-shrink: 0;
  }

  /* The one part of the summary that IS a label — keeps the editorial caps. */
  .resolved-label {
    font-weight: 600;
    color: var(--text-muted);
    flex-shrink: 0;
    text-transform: uppercase;
    letter-spacing: 0.04em;
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

  /*
   * THE SAME GLOBAL RULE, LEAKING SOMEWHERE ELSE.
   *
   * `details > summary` in src/app.css is the EDITORIAL pattern: uppercase,
   * letter-spaced, weight 600 — right for a summary that is a label of ours.
   * .resolved-summary above resets all three because it also carries a
   * sentence of somebody's comment. A bot comment body is FULL of <details>,
   * and its section labels are the author's words, not our chrome.
   *
   * CommentThread already resets text-transform and letter-spacing on
   * `.comment-body details summary`. It does NOT reset font-weight, so the
   * global 600 was still landing on every disclosure a comment contains —
   * "Issue description", "Suggested fix" and whatever prose a summary carries
   * with them, all set semibold against the author's intent, and semibold at
   * --text-sm inside a 0.9rem body reads as a heading the author never wrote.
   *
   * So: 400 here, and the summary's editorial padding tightened to one scale
   * step, because four of these stacked is a third of the height the
   * screenshot complained about. Scoped to the thread wrappers this component
   * owns — a class selector plus Svelte's scoping class outranks the two type
   * selectors in app.css, so app.css and CommentThread stay untouched.
   */
  .existing-thread :global(.comment-body details > summary),
  .thread-content :global(.comment-body details > summary) {
    font-weight: 400;
    text-transform: none;
    letter-spacing: normal;
    padding: var(--space-1) 0;
  }

  /* An opened first section should not sit flush against its own label. */
  .existing-thread :global(.comment-body details[open] > summary),
  .thread-content :global(.comment-body details[open] > summary) {
    margin-bottom: var(--space-1);
  }

  /* ---- Reply affordance ---- */
  .reply-actions {
    display: flex;
    gap: 0.4rem;
  }

  /*
   * QUIETER THAN A BUTTON, LOUDER THAN NOTHING.
   *
   * One of these sits under EVERY comment, so on the screenshot's thread the
   * repeated bordered box was chrome competing with the findings it was meant
   * to sit beneath — a filled outline repeated four times reads as the loudest
   * thing on the block. It loses the border and the background and becomes a
   * text affordance: --text-xs (one step down, and a token rather than the old
   * hand-picked 0.78rem) in --text-muted, the same register the reply hint and
   * the comment header already occupy.
   *
   * It does NOT take the --chrome-muted-opacity treatment the ⋯ menu button
   * uses. That is right for pure chrome revealed on hover; this is an ACTION,
   * and an action a reader cannot see is not quiet, it is missing. Full
   * opacity, underline on hover/focus so it still reads as clickable.
   */
  .reply-open-btn {
    padding: var(--space-1) 0;
    border: 0;
    border-radius: 0;
    background: none;
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-muted);
    cursor: pointer;
  }

  .reply-open-btn:hover,
  .reply-open-btn:focus-visible {
    color: var(--text);
    text-decoration: underline;
  }

  /* The receipt for a dropped copy-paste AI prompt. Same ink and size as the
     reply hint: it is a note about the comment, not part of it. */
  .prompt-section-note {
    margin: 0;
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-style: italic;
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
