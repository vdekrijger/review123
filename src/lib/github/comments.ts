import { ghFetchPage } from './client'
import type { PrRef } from './parse'

export interface PrComment {
  id: number
  author: string
  authorAvatar: string | null
  body: string
  createdAt: string
  path: string | null
  line: number | null
  side: 'LEFT' | 'RIGHT' | null
  inReplyTo: number | null
  /**
   * Provider-specific thread handle needed to post a reply.
   * GitLab: discussion id. GitHub: not needed (reply uses the root comment id).
   */
  threadId?: string
}

export interface RawReviewComment {
  id: number
  user: { login: string; avatar_url: string | null }
  body: string
  created_at: string
  path: string
  line: number | null
  side: 'LEFT' | 'RIGHT'
  in_reply_to_id: number | null
}

export function mapReviewComment(r: RawReviewComment): PrComment {
  return {
    id: r.id,
    author: r.user.login,
    authorAvatar: r.user.avatar_url,
    body: r.body,
    createdAt: r.created_at,
    path: r.path,
    line: r.line,
    side: r.side,
    inReplyTo: r.in_reply_to_id,
  }
}

interface RawIssueComment {
  id: number
  user: { login: string; avatar_url: string | null }
  body: string
  created_at: string
}

const MAX_PAGES = 5

async function fetchAllPages<T>(startPath: string): Promise<T[]> {
  const all: T[] = []
  let path: string | null = startPath
  let pages = 0
  while (path !== null && pages < MAX_PAGES) {
    const { body, next }: { body: T[]; next: string | null } = await ghFetchPage<T[]>(path)
    all.push(...body)
    path = next
    pages++
  }
  return all
}

export async function getPrComments(ref: PrRef): Promise<PrComment[]> {
  const { owner, repo, number } = ref

  const reviewRaw = await fetchAllPages<RawReviewComment>(
    `/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`,
  )
  const issueRaw = await fetchAllPages<RawIssueComment>(
    `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
  )

  const reviewComments: PrComment[] = reviewRaw.map(mapReviewComment)

  const issueComments: PrComment[] = issueRaw.map((r) => ({
    id: r.id,
    author: r.user.login,
    authorAvatar: r.user.avatar_url,
    body: r.body,
    createdAt: r.created_at,
    path: null,
    line: null,
    side: null,
    inReplyTo: null,
  }))

  const all = [...reviewComments, ...issueComments]
  all.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return all
}
