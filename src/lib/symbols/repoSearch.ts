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
import {
  groundingIsLocal,
  noteGroundingFailure,
  readLocalFiles,
  searchLocalPaths,
} from '../bridge/grounding'
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
  /**
   * Force the source instead of asking `groundingIsLocal(headSha)`. Tests only
   * — production always lets the one seam decide.
   */
  forceSource?: 'local' | 'provider'
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
 * is unavailable: not on a review route (e.g. the demo), or no head SHA known.
 *
 * The provider's `searchCodePaths` is no longer the only way to answer: a
 * local bridge whose head MATCHES this PR can search the working tree instead.
 * So the action is offered when EITHER source can answer — which is also what
 * gives a GitLab/Bitbucket user (and a signed-out GitHub user, whose
 * `/search/code` needs auth) repo search for the first time.
 */
export function currentRepoSearchContext(headSha: string | undefined): RepoSearchContext | null {
  if (!headSha) return null
  const route = router.route
  if (route.name !== 'review') return null
  const provider = providerFor(route.provider)
  if (typeof provider.searchCodePaths !== 'function' && !groundingIsLocal(headSha)) return null
  return { provider: provider as RepoSearchProvider, repo: { owner: route.owner, repo: route.repo }, headSha }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Same cap as the Tier 1 index (symbolIndex.ts MAX_FULL_CONTENT_LINES): a
 * fetched file larger than this many lines is skipped, not scanned.
 *
 * Unchanged by local grounding on purpose — it is a main-thread PARSE budget,
 * not a transfer budget. See the comment at its use site.
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

/** Is this search answered from the working tree rather than the provider? */
function useLocal(ctx: RepoSearchContext): boolean {
  if (ctx.forceSource) return ctx.forceSource === 'local'
  return groundingIsLocal(ctx.headSha)
}

async function doSearch(symbol: string, ctx: RepoSearchContext): Promise<RepoSearchOutcome> {
  const exclude = ctx.excludePaths ?? registeredSymbolFilenames()
  const local = useLocal(ctx)

  // STEP 1 — candidate paths. Locally this is a real content search over the
  // checked-out tree; through the provider it is a default-branch index that
  // step 2 then has to self-correct against the PR's head.
  let rawPaths: string[]
  try {
    rawPaths = local ? await searchLocalPaths(symbol) : await ctx.provider.searchCodePaths(ctx.repo, symbol)
  } catch (err) {
    if (!local) throw err
    // The bridge went away mid-search. Latch it so nothing else waits on it,
    // and retry through the provider rather than telling the user "no results"
    // for a symbol that may well have plenty.
    noteGroundingFailure(ctx.headSha)
    rawPaths = await ctx.provider.searchCodePaths(ctx.repo, symbol)
  }
  const paths = rawPaths.filter((p) => !exclude.has(p)).slice(0, MAX_RESULT_FILES)

  // STEP 2 — read each candidate. Locally that is ONE batched call against a
  // tree we have already proven is at this PR's head; through the provider it
  // is one GET per file at the head SHA. null content (moved/deleted at head)
  // drops out either way.
  const fetched: { path: string; text: string }[] = []
  let skipped = 0
  const take = (path: string, text: string | null): void => {
    if (text === null) {
      skipped++
      return
    }
    // Size cap: a giant generated file is skipped rather than stalling the UI.
    //
    // DELIBERATELY NOT RELAXED FOR LOCAL FILES. It is tempting — local reads
    // are free and instant — but this cap has never been about fetch cost. It
    // bounds how many lines buildSymbolIndex parses ON THE MAIN THREAD, and a
    // 200k-line generated file freezes the UI for exactly as long whether it
    // arrived over HTTPS or off an SSD. Raising it because the bytes got
    // cheaper would trade a real user-visible stall for nothing.
    if (text.split('\n').length > MAX_FILE_LINES) {
      skipped++
      return
    }
    fetched.push({ path, text })
  }

  let readLocally = local
  if (local) {
    try {
      const contents = await readLocalFiles(ctx.headSha, paths)
      for (const path of paths) take(path, contents.get(path) ?? null)
    } catch {
      noteGroundingFailure(ctx.headSha)
      readLocally = false
    }
  }
  if (!readLocally) {
    for (let i = 0; i < paths.length; i += FETCH_BATCH) {
      const batch = paths.slice(i, i + FETCH_BATCH)
      const results = await Promise.all(
        batch.map(async (path) => ({ path, text: await ctx.provider.getFileAtRef(ctx.repo, path, ctx.headSha) })),
      )
      for (const r of results) take(r.path, r.text)
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
