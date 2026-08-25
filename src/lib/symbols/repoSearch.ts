/**
 * src/lib/symbols/repoSearch.ts — Repo-wide symbol search (Tier 2 symbol
 * navigation, behind the popover's on-demand "Search repo" action).
 *
 * Tier 1's index only sees the PR's own files, so its honest answer for
 * anything else is "not in the changed files". This module finds call points
 * OUTSIDE the PR's files:
 *
 *   1. SEARCH  — ask the provider's code-search API for files mentioning the
 *                symbol (GitHub /search/code; capped at ~10 paths). The
 *                provider's search index covers the DEFAULT branch, not the
 *                PR's head — which is why step 2 exists.
 *   2. FETCH   — get each result file's real content AT THE PR'S HEAD SHA
 *                (getFileAtRef — the same fetch that powers context
 *                expansion). Files already in the PR are excluded (Tier 1
 *                covers them); files deleted/moved at head return null and
 *                drop out — the default-branch index self-corrects here.
 *   3. INDEX   — run the existing heuristic symbol index over the fetched
 *                contents and return real {path, line, snippet} hits,
 *                definitions included (a found definition upgrades the
 *                popover's "not in the changed files" state).
 *
 * On-demand only (GitHub allows ~10 code searches/min) with a per
 * symbol+repo+headSha in-memory cache; concurrent clicks share one in-flight
 * promise; failures are NOT cached so "try again in a minute" actually works.
 *
 * Context plumbing: FileDiff can't thread the provider/ref through props
 * without touching files owned by other work streams, so
 * currentRepoSearchContext() derives the PR ref from the router's route state
 * (the same source Review.svelte uses) + the provider registry, and takes the
 * head SHA from FileDiff's existing currentHeadSha prop. Capability is
 * detected by method presence (searchCodePaths — the getMyQueue pattern):
 * providers without it (GitLab/Bitbucket today) simply don't show the action.
 */

import { track } from '../analytics/analytics'
import { GithubApiError } from '../github/types'
import { providerFor } from '../provider/registry'
import type { ReviewProvider } from '../provider/types'
import { router } from '../router/router.svelte'
import { buildSymbolIndex, type SymbolDefinition, type SymbolReference, type SymbolSource } from './symbolIndex'
import { registeredSymbolFilenames } from './symbolSources'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The slice of a provider repo search needs (structural — easy to fake). */
export type RepoSearchProvider = Pick<ReviewProvider, 'getFileAtRef'> & {
  searchCodePaths: NonNullable<ReviewProvider['searchCodePaths']>
}

export interface RepoSearchContext {
  provider: RepoSearchProvider
  repo: { owner: string; repo: string }
  /** The PR's head SHA — every result file is fetched at this ref. */
  headSha: string
  /**
   * Paths to exclude from results (the PR's own files — Tier 1 already lists
   * their call points). Defaults to the currently registered symbol sources.
   */
  excludePaths?: Set<string>
}

export type RepoSearchOutcome =
  | {
      ok: true
      /** Definitions found in repo files (upgrade the popover's def section). */
      definitions: SymbolDefinition[]
      /** References in repo files — {path (file), line, snippet}; side 'new'. */
      references: SymbolReference[]
      /** How many result files were fetched and scanned at the head SHA. */
      filesScanned: number
      /** Files skipped: gone at head SHA (moved/deleted) or over the size cap. */
      filesSkipped: number
      /**
       * Full head-SHA contents of each scanned file, keyed by path — the
       * popover's definition peek reads a repo definition's body from here
       * (the SAME text the definitions above were indexed from). Optional so
       * hand-built outcomes (tests, older callers) stay valid.
       */
      contentsByPath?: ReadonlyMap<string, string>
    }
  | { ok: false; message: string }

// ---------------------------------------------------------------------------
// Capability / context detection
// ---------------------------------------------------------------------------

/**
 * Build the search context for the CURRENT review, or null when repo search
 * is unavailable: not on a review route (e.g. the demo), no head SHA known,
 * or the provider doesn't implement searchCodePaths (GitLab/Bitbucket today).
 * The popover shows the "Search repo" action only when this is non-null.
 */
export function currentRepoSearchContext(headSha: string | undefined): RepoSearchContext | null {
  if (!headSha) return null
  const route = router.route
  if (route.name !== 'review') return null
  const provider = providerFor(route.provider)
  if (typeof provider.searchCodePaths !== 'function') return null
  return { provider: provider as RepoSearchProvider, repo: { owner: route.owner, repo: route.repo }, headSha }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Same cap as the Tier 1 index (symbolIndex.ts MAX_FULL_CONTENT_LINES): a
 * fetched file larger than this many lines is skipped, not scanned.
 */
const MAX_FILE_LINES = 20_000

/** Max result files fetched per search (the provider also caps its results). */
const MAX_RESULT_FILES = 10

/** Contents fetches run in small batches (same politeness as fetchContents). */
const FETCH_BATCH = 4

/** User-facing message for rate-limited / restricted code search (403/422/429). */
export const REPO_SEARCH_RATE_LIMIT_MESSAGE = 'Code search rate-limited — try again in a minute.'

/** Analytics outcome for a failed search (the non-'success' enum values). */
type RepoSearchFailureKind = 'rate_limited' | 'unauthorized' | 'error'

function classifyFailure(err: unknown): { kind: RepoSearchFailureKind; message: string } {
  if (err instanceof GithubApiError) {
    const d = err.detail
    if (
      d.kind === 'rate-limited' ||
      d.kind === 'forbidden' ||
      d.kind === 'unprocessable' ||
      (d.kind === 'server' && d.status === 429)
    ) {
      return { kind: 'rate_limited', message: REPO_SEARCH_RATE_LIMIT_MESSAGE }
    }
    if (d.kind === 'unauthorized') return { kind: 'unauthorized', message: 'Code search requires a signed-in GitHub token.' }
  }
  return { kind: 'error', message: 'Repo search failed — try again.' }
}

async function doSearch(symbol: string, ctx: RepoSearchContext): Promise<RepoSearchOutcome> {
  const exclude = ctx.excludePaths ?? registeredSymbolFilenames()
  const rawPaths = await ctx.provider.searchCodePaths(ctx.repo, symbol)
  const paths = rawPaths.filter((p) => !exclude.has(p)).slice(0, MAX_RESULT_FILES)

  // Fetch each result file at the PR's HEAD SHA in small batches. null content
  // (file moved/deleted at head) drops out — the default-branch search index
  // self-corrects against the PR's real tree.
  const fetched: { path: string; text: string }[] = []
  let skipped = 0
  for (let i = 0; i < paths.length; i += FETCH_BATCH) {
    const batch = paths.slice(i, i + FETCH_BATCH)
    const results = await Promise.all(
      batch.map(async (path) => ({ path, text: await ctx.provider.getFileAtRef(ctx.repo, path, ctx.headSha) })),
    )
    for (const r of results) {
      if (r.text === null) {
        skipped++
        continue
      }
      // Same size cap as the Tier 1 index — a giant generated file is skipped.
      if (r.text.split('\n').length > MAX_FILE_LINES) {
        skipped++
        continue
      }
      fetched.push({ path: r.path, text: r.text })
    }
  }

  // Run the EXISTING heuristic index over the fetched head-SHA contents. Each
  // file enters as unchanged full contents (no patch), so every hit carries
  // side 'new' and inDiff false — these files aren't in the diff view.
  const sources: SymbolSource[] = fetched.map((f) => ({
    filename: f.path,
    status: 'unchanged',
    contents: { before: null, after: f.text },
  }))
  const index = buildSymbolIndex(sources)
  return {
    ok: true,
    definitions: index.definitionsOf(symbol),
    references: index.referencesOf(symbol),
    filesScanned: fetched.length,
    filesSkipped: skipped,
    contentsByPath: new Map(fetched.map((f) => [f.path, f.text])),
  }
}

// ---------------------------------------------------------------------------
// Cache (per symbol + repo + headSha; failures evicted so retry works)
//
// Deliberately NOT invalidated when a tree-sitter grammar finishes loading
// (unlike symbolSources' Tier 1 cache): a repo search runs on an explicit
// click, which in practice happens well after the grammars — kicked off when
// the review's first file mounted — have loaded, so results are almost always
// syntax-aware already. Re-searching would burn the ~10/min code-search quota
// for a marginal accuracy delta; the existing eviction-on-failure retry path
// is enough.
// ---------------------------------------------------------------------------

const cache = new Map<string, Promise<RepoSearchOutcome>>()

/**
 * Search the repo for call points of `symbol` outside the PR's files.
 * Cached per symbol+repo+headSha: re-clicks are free, and two concurrent
 * clicks share a single in-flight promise. A failed search is evicted from
 * the cache so the user can retry. Never throws — errors come back as
 * `{ ok: false, message }` ready for the popover.
 */
export async function searchRepoForSymbol(symbol: string, ctx: RepoSearchContext): Promise<RepoSearchOutcome> {
  const key = `${ctx.repo.owner}/${ctx.repo.repo}@${ctx.headSha}:${symbol}`
  const inFlight = cache.get(key)
  // Cache hit (settled result OR a concurrent click joining the in-flight
  // promise): NO analytics — nothing ran and no quota was spent. The
  // symbol_repo_searched event counts REAL searches only, so its volume maps
  // 1:1 onto code-search API usage.
  if (inFlight) return inFlight
  const startedAt = Date.now()
  let failureKind: RepoSearchFailureKind = 'error'
  const promise = doSearch(symbol, ctx).catch((err): RepoSearchOutcome => {
    const failure = classifyFailure(err)
    failureKind = failure.kind
    return { ok: false, message: failure.message }
  })
  cache.set(key, promise)
  const outcome = await promise
  if (!outcome.ok) cache.delete(key)
  // Fired only by the call that STARTED the search (the cache-miss path above
  // returns early), once it settles. Counts/enums/duration only — never the
  // symbol, paths, or snippets (see the allowlist in analytics.ts).
  if (outcome.ok) {
    track('symbol_repo_searched', {
      outcome: 'success',
      definitions: outcome.definitions.length,
      references: outcome.references.length,
      files_scanned: outcome.filesScanned,
      files_skipped: outcome.filesSkipped,
      duration_ms: Date.now() - startedAt,
    })
  } else {
    track('symbol_repo_searched', { outcome: failureKind, duration_ms: Date.now() - startedAt })
  }
  return outcome
}

/** Test-only: clear the search cache. */
export function _resetRepoSearchCacheForTest(): void {
  cache.clear()
}
