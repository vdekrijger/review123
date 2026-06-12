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

  .comment-item {
    border-left: 3px solid #8883;
    padding: 0.4rem 0.6rem;
    border-radius: 0 4px 4px 0;
    background: #8880;
  }

  .comment-item.reply {
    margin-left: 1.5rem;
    border-left-color: #8885;
  }

  .comment-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.25rem;
    font-size: 0.82rem;
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
    background: #6b7280;
    color: #fff;
    font-size: 0.75rem;
    font-weight: 600;
    flex-shrink: 0;
    text-transform: uppercase;
  }

  .comment-author {
    font-weight: 600;
  }

  .comment-time {
    opacity: 0.55;
    margin-left: auto;
    white-space: nowrap;
  }

  .comment-body {
    font-size: 0.88rem;
  }
</style>
