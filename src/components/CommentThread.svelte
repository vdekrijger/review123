<script lang="ts">
  import type { PrComment } from '../lib/github/comments'
  import MarkdownView from './MarkdownView.svelte'
  import { relativeTime } from '../lib/time'

  interface Props {
    comments: PrComment[]
  }

  let { comments }: Props = $props()

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
