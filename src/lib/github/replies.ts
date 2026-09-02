/**
 * replies — post a reply to an existing GitHub review-comment thread.
 *
 * Uses POST /repos/{owner}/{repo}/pulls/{number}/comments/{comment_id}/replies
 * (the dedicated reply endpoint — same effect as POSTing with in_reply_to,
 * but without needing commit/path/line positioning fields).
 *
 * Unlike draft comments (queued and submitted atomically with the review),
 * replies to existing threads post IMMEDIATELY — they are conversation, not
 * part of the verdict.
 */

import { ghFetch } from './client'
import { GithubApiError } from './types'
import { apiTimeoutMessage, REQUEST_CANCELLED_MESSAGE } from '../net/signals'
import type { PrRef } from './parse'
import { mapReviewComment, type PrComment, type RawReviewComment } from './comments'

export type ReplyOutcome =
  | { ok: true; comment: PrComment }
  | { ok: false; message: string }

export async function replyToReviewComment(
  ref: PrRef,
  rootCommentId: number,
  body: string,
): Promise<ReplyOutcome> {
  const { owner, repo, number } = ref
  try {
    const raw = await ghFetch<RawReviewComment>(
      `/repos/${owner}/${repo}/pulls/${number}/comments/${rootCommentId}/replies`,
      { method: 'POST', body: JSON.stringify({ body }) },
    )
    return { ok: true, comment: mapReviewComment(raw) }
  } catch (err) {
    return { ok: false, message: mapReplyError(err) }
  }
}

function mapReplyError(err: unknown): string {
  if (err instanceof GithubApiError) {
    const d = err.detail
    switch (d.kind) {
      case 'unauthorized':
        return 'Not authenticated — add a GitHub token in Settings to reply.'
      case 'forbidden':
        return d.message ?? 'You do not have permission to comment on this PR.'
      case 'not-found':
        return 'Comment not found — it may have been deleted.'
      case 'rate-limited':
        return `GitHub rate limit exceeded. Resets at ${d.resetAt.toLocaleTimeString()}.`
      case 'unprocessable':
        return d.message
      case 'network':
        return 'Network error — check your connection and try again.'
      case 'timeout':
        return apiTimeoutMessage('GitHub', d.afterMs)
      case 'cancelled':
        return REQUEST_CANCELLED_MESSAGE
      case 'server':
        return `GitHub server error (HTTP ${d.status}).`
    }
  }
  return err instanceof Error ? err.message : 'Failed to post reply.'
}
