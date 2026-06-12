/**
 * src/lib/provider/github.ts — GitHub ReviewProvider adapter.
 *
 * This is a THIN adapter: all methods delegate verbatim to the existing
 * lib/github functions. Zero business logic lives here.
 *
 * NOTE: fetchContents in lib/context/pack.ts directly imports getFileAtRef
 * from lib/github/api. For Task 1 (GitHub-only), this is fine because this
 * adapter delegates to the same function. When non-GitHub providers are added
 * in a future task, pack.ts fetchContents will be updated to accept a fetcher
 * parameter so it can be routed through the provider.
 */

import { parsePrUrl } from '../github/parse'
import { getPrMeta, getPrFiles, getFileAtRef } from '../github/api'
import { getCiSummary } from '../github/checks'
import { getPrComments } from '../github/comments'
import { getResolvedCommentIds } from '../github/threads'
import { getPrCommits } from '../github/commits'
import { compareCommits } from '../github/compare'
import { submitReview } from '../github/review'
import { replyToReviewComment, type ReplyOutcome } from '../github/replies'
import { ghFetch } from '../github/client'
import { getSettings } from '../settings/settings'
import type { ReviewProvider, PrRefX, ParseResult, QueueItem } from './types'
import type { PrMeta, PrFile } from '../github/types'
import type { CiSummary } from '../github/checks'
import type { PrComment } from '../github/comments'
import type { PrCommit } from '../github/commits'
import type { Verdict, SubmitOutcome } from '../github/review'
import type { Draft } from '../drafts/drafts.svelte'

// ---------------------------------------------------------------------------
// Adapter: convert PrRefX → PrRef (drop the provider field)
// ---------------------------------------------------------------------------

function toRef(ref: PrRefX): { owner: string; repo: string; number: number } {
  return { owner: ref.owner, repo: ref.repo, number: ref.number }
}

// ---------------------------------------------------------------------------
// GitHub ReviewProvider implementation
// ---------------------------------------------------------------------------

export const githubProvider: ReviewProvider = {
  id: 'github',
  displayName: 'GitHub',

  capabilities: {
    resolvedThreads: true,
    checks: true,
    suggestions: true,
    atomicReview: true,
    compare: true,
    commentReplies: true,
  },

  parseUrl(input: string): ParseResult {
    const result = parsePrUrl(input)
    if (!result.ok) {
      return { ok: false, error: result.error }
    }
    return {
      ok: true,
      value: {
        provider: 'github',
        owner: result.value.owner,
        repo: result.value.repo,
        number: result.value.number,
      },
    }
  },

  getPrMeta(ref: PrRefX): Promise<PrMeta> {
    return getPrMeta(toRef(ref))
  },

  getPrFiles(ref: PrRefX): Promise<PrFile[]> {
    return getPrFiles(toRef(ref))
  },

  getFileAtRef(repo: { owner: string; repo: string }, path: string, ref: string): Promise<string | null> {
    return getFileAtRef(repo, path, ref)
  },

  getCiSummary(ref: PrRefX, headSha: string): Promise<CiSummary> {
    return getCiSummary(toRef(ref), headSha)
  },

  getComments(ref: PrRefX): Promise<PrComment[]> {
    return getPrComments(toRef(ref))
  },

  getResolvedCommentIds(ref: PrRefX): Promise<Set<number>> {
    return getResolvedCommentIds(toRef(ref))
  },

  getCommits(ref: PrRefX): Promise<PrCommit[]> {
    return getPrCommits(toRef(ref))
  },

  compareCommits(repo: { owner: string; repo: string }, base: string, head: string): Promise<PrFile[]> {
    return compareCommits(repo, base, head)
  },

  submitReview(
    ref: PrRefX,
    verdict: Verdict,
    body: string,
    drafts: Draft[],
    commitId: string,
  ): Promise<SubmitOutcome> {
    return submitReview(toRef(ref), verdict, body, drafts, commitId)
  },

  replyToThread(ref: PrRefX, root: PrComment, body: string): Promise<ReplyOutcome> {
    return replyToReviewComment(toRef(ref), root.id, body)
  },

  authState(): { configured: boolean; hint: string } {
    const auth = getSettings().githubAuth
    if (auth) {
      return { configured: true, hint: `GitHub token configured (${auth.method})` }
    }
    return { configured: false, hint: 'No GitHub token configured. Add one in Settings.' }
  },

  suggestionFence(lines: string[]): string {
    return `\`\`\`suggestion\n${lines.join('\n')}\n\`\`\``
  },

  async getMyReviewComments(
    repo: { owner: string; repo: string },
    cap: number,
  ): Promise<string[]> {
    // Inline stripLongFences to avoid circular dependency with mineSkill module
    function stripLongFences(body: string): string {
      return body.replace(/```[^\n]*\n([\s\S]*?)```/g, (match, inner: string) => {
        const lines = inner.split('\n')
        if (lines.length > 10) return ''
        return match
      })
    }

    // Step 1: resolve authenticated login
    const user = await ghFetch<{ login: string }>('/user')
    const login = user.login

    // Step 2: fetch up to 3 pages of PR review comments
    const MINE_PAGES = 3
    const allComments: Array<{ user: { login: string }; body: string }> = []
    for (let page = 1; page <= MINE_PAGES; page++) {
      const path = `/repos/${repo.owner}/${repo.repo}/pulls/comments?sort=created&direction=desc&per_page=100&page=${page}`
      const raw = await ghFetch<Array<{ user: { login: string }; body: string }>>(path)
      if (!Array.isArray(raw) || raw.length === 0) break
      allComments.push(...raw)
    }

    // Step 3: filter by author, cap, strip long fences
    return allComments
      .filter(c => c.user?.login === login)
      .slice(0, cap)
      .map(c => stripLongFences(c.body).trim())
      .filter(body => body.length > 0)
  },

  async getMyQueue(): Promise<QueueItem[]> {
    const auth = getSettings().githubAuth
    if (!auth) return []

    interface GhSearchItem {
      number: number
      title: string
      updated_at: string
      repository_url: string
    }

    interface GhSearchResponse {
      items: GhSearchItem[]
    }

    function parseRepoUrl(repositoryUrl: string): { owner: string; repo: string } | null {
      const match = repositoryUrl.match(/\/repos\/([^/]+)\/([^/]+)$/)
      if (!match) return null
      return { owner: match[1], repo: match[2] }
    }

    async function query(q: string): Promise<GhSearchItem[]> {
      try {
        const res = await ghFetch<GhSearchResponse>(
          `/search/issues?q=${encodeURIComponent(q)}&per_page=20`,
        )
        return res.items ?? []
      } catch {
        return []
      }
    }

    const [reviewItems, authorItems] = await Promise.all([
      query('type:pr state:open review-requested:@me'),
      query('type:pr state:open author:@me'),
    ])

    // Build a deduplicated map keyed by "owner/repo#number"
    const seen = new Map<string, QueueItem>()

    for (const item of reviewItems) {
      const repo = parseRepoUrl(item.repository_url)
      if (!repo) continue
      const key = `${repo.owner}/${repo.repo}#${item.number}`
      seen.set(key, {
        ref: { provider: 'github', owner: repo.owner, repo: repo.repo, number: item.number },
        title: item.title,
        authorIsMe: false,
        updatedAt: item.updated_at,
      })
    }

    for (const item of authorItems) {
      const repo = parseRepoUrl(item.repository_url)
      if (!repo) continue
      const key = `${repo.owner}/${repo.repo}#${item.number}`
      // Only add if not already in map (review-requested takes precedence over authored)
      if (!seen.has(key)) {
        seen.set(key, {
          ref: { provider: 'github', owner: repo.owner, repo: repo.repo, number: item.number },
          title: item.title,
          authorIsMe: true,
          updatedAt: item.updated_at,
        })
      }
    }

    return [...seen.values()]
  },
}
