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
import { GithubApiError } from '../github/types'
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
// Viewer identity (shared by getViewerLogin and the mining helpers)
// ---------------------------------------------------------------------------

async function fetchViewerLogin(): Promise<string | null> {
  const user = await ghFetch<{ login?: string }>('/user')
  return user.login ?? null
}

// ---------------------------------------------------------------------------
// Mining helpers (account- and repo-scoped review comment harvesting)
// ---------------------------------------------------------------------------

// Inline (not imported from mineSkill) to avoid a circular dependency.
function stripLongFences(body: string): string {
  return body.replace(/```[^\n]*\n([\s\S]*?)```/g, (match, inner: string) => {
    const lines = inner.split('\n')
    if (lines.length > 10) return ''
    return match
  })
}

/** Re-throw rate-limit API errors as a clear, user-facing Error. */
function throwIfRateLimited(err: unknown): void {
  if (err instanceof GithubApiError && err.detail.kind === 'rate-limited') {
    throw new Error(
      `GitHub rate limit exceeded. Try again after ${err.detail.resetAt.toLocaleTimeString()}.`,
    )
  }
}

interface RawMineComment {
  user: { login: string }
  body: string
}

/** Repo-scoped mining: recent review comments on one repo, filtered to `login`. */
async function getRepoScopedReviewComments(
  repo: { owner: string; repo: string },
  cap: number,
): Promise<string[]> {
  // Step 1: resolve authenticated login (shared viewer-identity code path)
  const login = await fetchViewerLogin()
  if (login == null) return []

  // Step 2: fetch up to 3 pages of PR review comments
  const MINE_PAGES = 3
  const allComments: RawMineComment[] = []
  for (let page = 1; page <= MINE_PAGES; page++) {
    const path = `/repos/${repo.owner}/${repo.repo}/pulls/comments?sort=created&direction=desc&per_page=100&page=${page}`
    const raw = await ghFetch<RawMineComment[]>(path)
    if (!Array.isArray(raw) || raw.length === 0) break
    allComments.push(...raw)
  }

  // Step 3: filter by author, cap, strip long fences
  return allComments
    .filter(c => c.user?.login === login)
    .slice(0, cap)
    .map(c => stripLongFences(c.body).trim())
    .filter(body => body.length > 0)
}

/** Max PRs harvested in account-scoped mining (rate-limit budget: ~32 requests). */
const MINE_MAX_PRS = 30
/** PR comment fetches run in small batches to stay polite on the API. */
const MINE_PR_BATCH = 5

/**
 * Account-scoped mining: search PRs the authenticated user commented on
 * (across all repos), then pull that user's review comments from each.
 */
async function getAccountScopedReviewComments(cap: number): Promise<string[]> {
  interface GhSearchItem {
    number: number
    repository_url: string
  }

  let login: string
  let items: GhSearchItem[]
  try {
    // Resolve authenticated login via the shared viewer-identity code path.
    const viewer = await fetchViewerLogin()
    if (viewer == null) return []
    login = viewer
    const q = encodeURIComponent(`type:pr commenter:${login}`)
    const res = await ghFetch<{ items?: GhSearchItem[] }>(
      `/search/issues?q=${q}&sort=updated&order=desc&per_page=${MINE_MAX_PRS}`,
    )
    items = (res.items ?? []).slice(0, MINE_MAX_PRS)
  } catch (err) {
    throwIfRateLimited(err)
    throw err
  }

  // Resolve owner/repo from each search item's repository_url
  const prs: Array<{ owner: string; repo: string; number: number }> = []
  for (const item of items) {
    const match = item.repository_url.match(/\/repos\/([^/]+)\/([^/]+)$/)
    if (!match) continue
    prs.push({ owner: match[1], repo: match[2], number: item.number })
  }

  // Fetch the user's review comments per PR in small batches
  const bodies: string[] = []
  for (let i = 0; i < prs.length && bodies.length < cap; i += MINE_PR_BATCH) {
    const batch = prs.slice(i, i + MINE_PR_BATCH)
    const results = await Promise.all(
      batch.map(async (pr) => {
        try {
          return await ghFetch<RawMineComment[]>(
            `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments?per_page=100`,
          )
        } catch (err) {
          throwIfRateLimited(err)
          return [] // other per-PR failures are non-fatal — use what we have
        }
      }),
    )
    for (const raw of results) {
      if (!Array.isArray(raw)) continue
      for (const c of raw) {
        if (bodies.length >= cap) break
        if (c.user?.login !== login) continue
        const body = stripLongFences(c.body).trim()
        if (body.length > 0) bodies.push(body)
      }
    }
  }

  return bodies
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
    selfReviewBlocked: true, // 422 "Can not approve your own pull request"
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

  // Plan G deep review: repo-scoped code search via GitHub's code-search API.
  // Requires auth (GitHub rejects unauthenticated /search/code); errors
  // propagate as GithubApiError and are converted to tool-result errors by
  // the deep-review toolkit. text-match media type yields code fragments.
  async searchCode(repo: { owner: string; repo: string }, query: string): Promise<string> {
    const q = encodeURIComponent(`${query} repo:${repo.owner}/${repo.repo}`)
    const data = await ghFetch<{
      total_count: number
      items: {
        path: string
        text_matches?: { fragment?: string }[]
      }[]
    }>(`/search/code?q=${q}&per_page=10`, {
      headers: { Accept: 'application/vnd.github.text-match+json' },
    })
    if (!data.items || data.items.length === 0) return 'No matches found.'
    const lines: string[] = [`${data.total_count} match(es); showing up to 10:`]
    for (const item of data.items) {
      lines.push(`## ${item.path}`)
      for (const m of item.text_matches ?? []) {
        if (m.fragment) lines.push(m.fragment)
      }
    }
    return lines.join('\n')
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

  getMyReviewComments(
    repo: { owner: string; repo: string },
    cap: number,
  ): Promise<string[]> {
    return getRepoScopedReviewComments(repo, cap)
  },

  getMyAccountReviewComments(
    cap: number,
    repoFilter?: { owner: string; repo: string },
  ): Promise<string[]> {
    if (repoFilter) return getRepoScopedReviewComments(repoFilter, cap)
    return getAccountScopedReviewComments(cap)
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

  getViewerLogin(): Promise<string | null> {
    return fetchViewerLogin()
  },
}
