/**
 * src/lib/provider/types.ts — canonical provider interface for Review 1-2-3.
 *
 * Every VCS provider (GitHub, GitLab, Bitbucket, …) must implement ReviewProvider.
 * The canonical model types (PrMeta, PrFile, etc.) are imported from the existing
 * github lib and re-exported here so the rest of the app imports from one place.
 */

// Re-export canonical model types from existing github lib
export type { PrMeta, PrFile } from '../github/types'
export type { CiSummary } from '../github/checks'
export type { PrComment } from '../github/comments'
export type { PrCommit } from '../github/commits'
export type { Verdict, SubmitOutcome } from '../github/review'
export type { ReplyOutcome } from '../github/replies'

import type { PrMeta, PrFile } from '../github/types'
import type { CiSummary } from '../github/checks'
import type { PrComment } from '../github/comments'
import type { PrCommit } from '../github/commits'
import type { Verdict, SubmitOutcome } from '../github/review'
import type { ReplyOutcome } from '../github/replies'
import type { Draft } from '../drafts/drafts.svelte'

// ---------------------------------------------------------------------------
// PrRefX — provider-qualified PR reference
// ---------------------------------------------------------------------------

export interface PrRefX {
  provider: 'github' | 'gitlab' | 'bitbucket'
  owner: string
  repo: string
  number: number
}

// ---------------------------------------------------------------------------
// Queue types
// ---------------------------------------------------------------------------

export interface QueueItem {
  ref: PrRefX
  title: string
  /** true when the current user is the author (not awaiting their review) */
  authorIsMe: boolean
  /** ISO 8601 timestamp */
  updatedAt: string
}

// ---------------------------------------------------------------------------
// ParseResult — result of parseUrl
// ---------------------------------------------------------------------------

export type ParseResult =
  | { ok: true; value: PrRefX }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Provider capabilities
// ---------------------------------------------------------------------------

export interface ProviderCapabilities {
  /** Provider supports resolved thread markers */
  resolvedThreads: boolean
  /** Provider supports CI/checks */
  checks: boolean
  /** Provider supports inline review comment suggestions */
  suggestions: boolean
  /** Provider supports submitting a review as a single atomic operation */
  atomicReview: boolean
  /** Provider supports commit comparison */
  compare: boolean
  /**
   * Provider supports replying to an existing comment thread (immediate post,
   * not part of the queued review). When true the provider must implement
   * replyToThread().
   */
  commentReplies: boolean
  /**
   * Provider rejects review verdicts (approve / request changes) on the
   * viewer's own PR. GitHub: 422 "Can not approve your own pull request".
   * Bitbucket Cloud: rejects self-approval. GitLab: governed by project
   * settings (often allowed) → false, errors surface at submit time.
   */
  selfReviewBlocked: boolean
}

// ---------------------------------------------------------------------------
// ReviewProvider — the interface every provider must implement
// ---------------------------------------------------------------------------

export interface ReviewProvider {
  id: 'github' | 'gitlab' | 'bitbucket'
  displayName: string

  /** Parse a URL or short-form string into a PrRefX, or return an error. */
  parseUrl(input: string): ParseResult

  /** Fetch PR metadata (title, state, SHAs, …) */
  getPrMeta(ref: PrRefX): Promise<PrMeta>

  /** Fetch the list of changed files for a PR */
  getPrFiles(ref: PrRefX): Promise<PrFile[]>

  /**
   * Fetch the raw content of a file at a specific git ref.
   * Returns null when the file does not exist at that ref.
   */
  getFileAtRef(repo: { owner: string; repo: string }, path: string, ref: string): Promise<string | null>

  /** Fetch CI / checks summary */
  getCiSummary(ref: PrRefX, headSha: string): Promise<CiSummary>

  /** Fetch all review and issue comments on a PR */
  getComments(ref: PrRefX): Promise<PrComment[]>

  /**
   * Return the set of comment databaseIds that belong to resolved review threads.
   * Returns an empty Set when the provider does not support resolved threads or
   * when there is no auth token.
   */
  getResolvedCommentIds(ref: PrRefX): Promise<Set<number>>

  /** Fetch the commit list for a PR */
  getCommits(ref: PrRefX): Promise<PrCommit[]>

  /** Compare two commits and return the list of changed files */
  compareCommits(repo: { owner: string; repo: string }, base: string, head: string): Promise<PrFile[]>

  /** Submit a review with the given verdict, body, and inline comment drafts */
  submitReview(
    ref: PrRefX,
    verdict: Verdict,
    body: string,
    drafts: Draft[],
    commitId: string,
  ): Promise<SubmitOutcome>

  /** Whether the provider has a token configured and what hint to show */
  authState(): { configured: boolean; hint: string }

  capabilities: ProviderCapabilities

  /**
   * Return a provider-flavoured suggestion fence for the given source lines.
   * GitHub: ```suggestion ... ```
   * GitLab: ```suggestion:-0+0 ... ```
   *
   * Optional — only present when capabilities.suggestions is true.
   * Callers check capabilities.suggestions before using this method.
   */
  suggestionFence?(lines: string[]): string

  /**
   * Fetch the authenticated user's own review comment bodies from the given repo.
   * Returns comment bodies only (not metadata); code fences > 10 lines are stripped.
   * Capped at 150 comments total.
   *
   * Optional — only present for providers that support personal review mining.
   * Callers must check whether the method exists before calling it.
   * When absent, the UI should explain "not available for <Provider> yet".
   */
  getMyReviewComments?(
    repo: { owner: string; repo: string },
    cap: number,
  ): Promise<string[]>

  /**
   * Post a reply to an existing comment thread. Posts IMMEDIATELY (unlike
   * drafts, which are queued and submitted with the review).
   *
   * `root` is the thread's root comment: GitHub uses root.id for the
   * /replies endpoint; GitLab uses root.threadId (the discussion id).
   *
   * Optional — only present when capabilities.commentReplies is true.
   * Returns a typed Result; never throws.
   */
  replyToThread?(ref: PrRefX, root: PrComment, body: string): Promise<ReplyOutcome>

  /**
   * Fetch the authenticated user's recent review comment bodies ACROSS repos
   * (account-scoped). The provider resolves the authenticated identity itself
   * (GitHub: GET /user → login; GitLab: GET /user → username) and gathers that
   * user's recent PR/MR review comments. Returns comment bodies only (not
   * metadata); code fences > 10 lines are stripped. Capped at `cap` comments.
   *
   * When `repoFilter` is provided, the search is narrowed to that single
   * repository (delegates to the repo-scoped path).
   *
   * Optional — method presence implies capability (same pattern as getMyQueue).
   * When absent, the UI should explain "not available for <Provider> yet".
   */
  getMyAccountReviewComments?(
    cap: number,
    repoFilter?: { owner: string; repo: string },
  ): Promise<string[]>

  /**
   * Search code in a repository (Plan G deep review tool). Returns a compact
   * plain-text result list (path + matched fragments) suitable for feeding
   * back to an LLM as a tool result. Throws on API errors (auth, rate limit) —
   * the deep-review toolkit converts those into tool-result errors.
   *
   * Optional — capability by method presence (GitHub-only in v1; GitLab has a
   * search API too but is not wired yet, Bitbucket has none usable here).
   * When absent, the deep-review tool list simply omits search_code.
   */
  searchCode?(repo: { owner: string; repo: string }, query: string): Promise<string>

  /**
   * Return open PRs/MRs in the current user's review queue.
   * - authorIsMe=false → awaiting this user's review (reviewer-requested)
   * - authorIsMe=true  → authored by this user (open PRs)
   * Capability implied by method presence.
   * Returns [] when unauthenticated.
   */
  getMyQueue?(): Promise<QueueItem[]>

  /**
   * Resolve the authenticated viewer's provider-canonical identity — the same
   * identifier space as PrMeta.authorLogin (GitHub login, GitLab username,
   * Bitbucket account UUID). Returns null when it cannot be determined.
   *
   * Optional — callers should go through resolveViewerLogin() in viewer.ts,
   * which checks auth and caches the result per session.
   */
  getViewerLogin?(): Promise<string | null>
}
