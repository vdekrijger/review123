/**
 * commentThreads — group flat PrComment lists into review threads.
 *
 * GitHub review comments carry `in_reply_to_id` (mapped to PrComment.inReplyTo)
 * pointing at the thread's root comment. GitLab discussions are mapped the same
 * way by the gitlab provider (first note = root, later notes reply to it, with
 * `threadId` carrying the discussion id needed for reply posting).
 *
 * Grouping rules:
 *   - A comment with inReplyTo === null is a thread root.
 *   - Replies attach to the thread containing the comment they reference —
 *     replies-to-replies collapse into the root's thread (GitHub flattens
 *     threads the same way).
 *   - Orphan replies (parent not in the list) become standalone single-comment
 *     threads so nothing is silently dropped.
 *   - Roots keep input order; replies within a thread are sorted by createdAt.
 */

import type { PrComment } from './comments'

export interface CommentThread {
  root: PrComment
  replies: PrComment[]
}

export function groupThreads(comments: PrComment[]): CommentThread[] {
  const threads: CommentThread[] = []
  /** comment id → thread that contains it (root or reply) */
  const threadByCommentId = new Map<number, CommentThread>()

  // Pass 1: roots, in input order
  for (const c of comments) {
    if (c.inReplyTo === null) {
      const thread: CommentThread = { root: c, replies: [] }
      threads.push(thread)
      threadByCommentId.set(c.id, thread)
    }
  }

  // Pass 2: replies — attach to the thread of the referenced comment.
  // Repeat until stable so replies-to-replies resolve regardless of input order.
  const pending = comments.filter((c) => c.inReplyTo !== null)
  let madeProgress = true
  while (pending.length > 0 && madeProgress) {
    madeProgress = false
    for (let i = pending.length - 1; i >= 0; i--) {
      const c = pending[i]
      const parentThread = threadByCommentId.get(c.inReplyTo!)
      if (parentThread) {
        parentThread.replies.push(c)
        threadByCommentId.set(c.id, parentThread)
        pending.splice(i, 1)
        madeProgress = true
      }
    }
  }

  // Pass 3: orphans (parent never found) become standalone threads
  for (const c of pending) {
    const thread: CommentThread = { root: c, replies: [] }
    threads.push(thread)
    threadByCommentId.set(c.id, thread)
  }

  // Replies within a thread in chronological order
  for (const t of threads) {
    t.replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  return threads
}

/** All comments of a thread in display order: root first, then replies. */
export function threadComments(thread: CommentThread): PrComment[] {
  return [thread.root, ...thread.replies]
}
