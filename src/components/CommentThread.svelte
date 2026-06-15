<script lang="ts">
  import type { PrComment } from '../lib/github/comments'
  import MarkdownView from './MarkdownView.svelte'
  import { relativeTime } from '../lib/time'
  import { track } from '../lib/analytics/analytics'

  interface Props {
    comments: PrComment[]
  }

  let { comments }: Props = $props()

  // ---- Per-comment actions menu ----
  // Only one menu is open at a time; keyed by comment id.
  let openMenuId = $state<number | null>(null)
  // Comment id currently showing the transient "Copied ✓" confirmation.
  let copiedId = $state<number | null>(null)
  let copiedTimer: ReturnType<typeof setTimeout> | undefined

  function toggleMenu(id: number) {
    openMenuId = openMenuId === id ? null : id
  }

  function closeMenu() {
    openMenuId = null
  }

  /** Build a markdown blockquote of the comment for pasting into a reply. */
  function quoteOf(comment: PrComment): string {
    const attribution = `> @${comment.author} wrote:`
    const quoted = comment.body
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    const parts = [attribution, quoted]
    if (comment.url) parts.push(`>\n> ${comment.url}`)
    return parts.join('\n')
  }

  async function copyToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  function flashCopied(id: number) {
    copiedId = id
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      if (copiedId === id) copiedId = null
    }, 2000)
  }

  async function copyLink(comment: PrComment) {
    if (!comment.url) return
    const ok = await copyToClipboard(comment.url)
    closeMenu()
    if (ok) {
      flashCopied(comment.id)
      // Analytics: ids-only choke-point event — carries NOTHING.
      track('comment_link_copied')
    }
  }

  async function quoteReply(comment: PrComment) {
    await copyToClipboard(quoteOf(comment))
    closeMenu()
    flashCopied(comment.id)
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && openMenuId !== null) {
      closeMenu()
    }
  }

  function onWindowClick(e: MouseEvent) {
    if (openMenuId === null) return
    const target = e.target as HTMLElement | null
    // Ignore clicks inside the open menu / its trigger (they self-handle).
    if (target && target.closest('[data-comment-menu]')) return
    closeMenu()
  }


  // Build ordered thread: top-level comments in order, each followed by replies
  const orderedComments = $derived.by(() => {
    const topLevel = comments.filter((c) => c.inReplyTo === null)
    const repliesMap = new Map<number, PrComment[]>()
    for (const c of comments) {
      if (c.inReplyTo !== null) {
        const arr = repliesMap.get(c.inReplyTo) ?? []
        arr.push(c)
        repliesMap.set(c.inReplyTo, arr)
      }
    }
    const result: { comment: PrComment; isReply: boolean }[] = []
    for (const top of topLevel) {
      result.push({ comment: top, isReply: false })
      const replies = repliesMap.get(top.id) ?? []
      for (const reply of replies) {
        result.push({ comment: reply, isReply: true })
      }
    }
    // Also include orphan replies (reply to unknown parent) at the end
    for (const c of comments) {
      if (c.inReplyTo !== null && !topLevel.some((t) => t.id === c.inReplyTo)) {
        result.push({ comment: c, isReply: true })
      }
    }
    return result
  })
</script>

<svelte:window onkeydown={onWindowKeydown} onclick={onWindowClick} />

<div class="comment-thread">
  {#each orderedComments as { comment, isReply } (comment.id)}
    <div class="comment-item" class:reply={isReply}>
      <div class="comment-header">
        {#if comment.authorAvatar}
          <img
            class="avatar"
            src={comment.authorAvatar}
            alt={comment.author}
            width="20"
            height="20"
            loading="lazy"
          />
        {:else}
          <span class="avatar-initial" aria-hidden="true">
            {comment.author.slice(0, 1).toLowerCase()}
          </span>
        {/if}
        <span class="comment-author">{comment.author}</span>
        <span class="comment-time">{relativeTime(comment.createdAt)}</span>

        <div class="comment-menu" data-comment-menu>
          <button
            type="button"
            class="comment-menu-btn"
            aria-label="Comment actions"
            aria-haspopup="menu"
            aria-expanded={openMenuId === comment.id}
            onclick={(e) => {
              e.stopPropagation()
              toggleMenu(comment.id)
            }}
          >
            <span aria-hidden="true">⋯</span>
          </button>

          {#if openMenuId === comment.id}
            <div class="comment-menu-popover" role="menu" aria-label="Comment actions">
              {#if comment.url}
                <button
                  type="button"
                  role="menuitem"
                  class="comment-menu-item"
                  onclick={(e) => {
                    e.stopPropagation()
                    copyLink(comment)
                  }}
                >
                  Copy link to comment
                </button>
              {/if}
              <button
                type="button"
                role="menuitem"
                class="comment-menu-item"
                onclick={(e) => {
                  e.stopPropagation()
                  quoteReply(comment)
                }}
              >
                Quote reply
              </button>
            </div>
          {/if}
        </div>

        {#if copiedId === comment.id}
          <span class="comment-copied" role="status" aria-live="polite">Copied ✓</span>
        {/if}
      </div>
      <div class="comment-body">
        <MarkdownView source={comment.body} />
      </div>
    </div>
  {/each}
</div>

<style>
  .comment-thread {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* Thread uses a left rail (2px subtle border) not a filled block */
  .comment-item {
    border-left: 2px solid var(--border-subtle, var(--hairline));
    padding: 0.4rem 0.75rem;
    border-radius: 0 4px 4px 0;
    background: var(--surface);
    max-width: 80ch;
  }

  .comment-item.reply {
    margin-left: 1.5rem;
    border-left-color: var(--hairline);
  }

  .comment-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.25rem;
    font-size: 12px;
    color: var(--text-muted);
  }

  .avatar {
    border-radius: 50%;
    display: block;
    flex-shrink: 0;
  }

  .avatar-initial {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--text-muted);
    color: var(--surface);
    font-size: 0.75rem;
    font-weight: 600;
    flex-shrink: 0;
    text-transform: uppercase;
  }

  .comment-author {
    font-weight: 600;
    color: var(--text);
  }

  .comment-time {
    opacity: 0.55;
    margin-left: auto;
    white-space: nowrap;
  }

  /* ---- Per-comment actions menu ---- */
  .comment-menu {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
  }

  .comment-menu-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4rem;
    height: 1.4rem;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    /* Unobtrusive: muted by default, revealed on hover/focus of the item */
    opacity: 0.45;
    transition: opacity 0.12s ease, background 0.12s ease;
  }

  .comment-item:hover .comment-menu-btn,
  .comment-menu-btn:hover,
  .comment-menu-btn:focus-visible,
  .comment-menu-btn[aria-expanded='true'] {
    opacity: 1;
    background: var(--surface-raised);
  }

  .comment-menu-popover {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 20;
    min-width: 11rem;
    display: flex;
    flex-direction: column;
    padding: 0.25rem;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    background: var(--surface);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
  }

  .comment-menu-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.35rem 0.55rem;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    font-size: 0.8rem;
    cursor: pointer;
    white-space: nowrap;
  }

  .comment-menu-item:hover,
  .comment-menu-item:focus-visible {
    background: var(--surface-raised);
  }

  .comment-copied {
    font-size: 0.72rem;
    color: var(--accent, var(--text-muted));
    white-space: nowrap;
    flex-shrink: 0;
  }

  .comment-body {
    font-family: var(--font-prose);
    font-size: 0.9rem;
    line-height: 1.5;
    overflow-wrap: break-word;
  }

  /* Prose code blocks inside comments */
  .comment-body :global(pre) {
    background: var(--surface-raised);
    border: 1px solid var(--hairline);
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 12.5px;
  }

  .comment-body :global(code) {
    font-family: var(--font-mono);
    font-size: 0.85em;
    background: var(--surface-raised);
    padding: 0.1em 0.3em;
    border-radius: 3px;
  }

  .comment-body :global(pre code) {
    background: none;
    padding: 0;
    font-size: inherit;
  }

  /* <details> inside comment bodies — styled like our collapsible primitives but smaller */
  .comment-body :global(details) {
    border: 1px solid var(--hairline);
    border-radius: 4px;
    padding: 0.25rem 0.5rem;
    margin: 0.4rem 0;
    font-size: 0.88em;
  }

  .comment-body :global(details summary) {
    cursor: pointer;
    color: var(--text-muted);
    font-size: 0.88em;
    text-transform: none;
    letter-spacing: normal;
  }

  /* Tables inside comment bodies */
  .comment-body :global(table) {
    border-collapse: collapse;
    font-size: 0.85em;
    max-width: 100%;
    overflow-x: auto;
    display: block;
  }

  .comment-body :global(th),
  .comment-body :global(td) {
    border: 1px solid var(--hairline);
    padding: 0.25rem 0.5rem;
    text-align: left;
  }

  .comment-body :global(th) {
    background: var(--surface-raised);
    font-weight: 600;
  }

  /* Images and long links */
  .comment-body :global(img) {
    max-width: 100%;
    height: auto;
  }

  .comment-body :global(a) {
    overflow-wrap: break-word;
    word-break: break-all;
  }
</style>
