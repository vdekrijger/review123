/**
 * src/lib/ai/runInput.ts — the shared AiRunInput builder (the prepare-ahead seam).
 *
 * The Review route and the headless prepare-ahead path (prepare.svelte.ts) must
 * execute the SAME task pipeline against the SAME caches. The task pipeline
 * already lives in ONE place (createAiRun); what used to be duplicated-by-
 * necessity was the INPUT construction embedded in Review.svelte — prKey
 * format, pack() wiring, deep-review tool source, coach/verify code context.
 * This module extracts that construction so both callers build byte-identical
 * inputs:
 *
 *   Review.svelte  — passes its memoized loaders + the consent dialog.
 *   prepare.svelte — passes its own memoized loaders + a headless ask (deny).
 *
 * Because prKey, task segments, and prompt versions are identical, every cache
 * entry the prepare path writes is a warm hit for the route's run — no second
 * orchestration exists.
 */

import { LLM_CONFIG } from '../llm/config'
import { packContext } from '../context/pack'
import type { HeadContentReader, PackScope } from '../context/pack'
import {
  findLocalReferences,
  groundingIsLocal,
  noteGroundingFailure,
  readLocalFile,
  readLocalFiles,
  searchLocalCode,
} from '../bridge/grounding'
import { filesForPhase } from '../guide/phase.svelte'
import { buildCoachCodeContext } from './coachContext'
import type { AiRunInput } from './run.svelte'
import type { PrMeta, PrFile } from '../github/types'
import type { CiSummary } from '../github/checks'
import type { ReviewProvider } from '../provider/types'
import type { Draft } from '../drafts/drafts.svelte'

/** File contents map shape shared by pack() and the code-context builders. */
export type ContentsMap = Map<string, { before: string | null; after: string | null }>

/**
 * The AI cache identity for one PR at one head SHA:
 * "<providerId>:<owner>/<repo>#<number>@<headSha>". Every task cache key is
 * derived from this, so the prepare path and the Review route MUST build it
 * through this one function (a formatting drift would silently cold-start
 * every "prepared" PR).
 */
export function aiPrKey(
  providerId: string,
  owner: string,
  repo: string,
  number: number,
  headSha: string,
): string {
  return `${providerId}:${owner}/${repo}#${number}@${headSha}`
}

/** Context-pack token budget — the route's long-standing formula, extracted. */
export function aiBudgetTokens(): number {
  return LLM_CONFIG.contextWindowTokens - LLM_CONFIG.maxOutputTokens - 2000
}

/**
 * The files one PackScope packs (#237 — phase-scoped reviewers).
 *
 * - 'all' (and undefined) returns the CALLER'S OWN ARRAY, untouched. That
 *   identity is the guarantee that every task still packing 'all' — summary,
 *   attention, diagrams, story, verdict, alternatives, intent, outcomes,
 *   riskJudge, ask, coach — gets a byte-identical context and cache key.
 * - 'implementation' returns the non-test files, via the SAME
 *   `filesForPhase`/`isTestFile` partition the Implementation review phase
 *   shows (lib/guide/phase.svelte) — deliberately never a second heuristic.
 *
 * TEST-ONLY PRs fall back to the full list: a PR whose every file is a test has
 * no implementation side, and handing the reviewers an EMPTY context would be
 * strictly worse than the unscoped behaviour. There is nothing to defer there —
 * the phase bar doesn't even engage (InspectStep's `phaseApplies`).
 */
export function scopeFilesForPack(files: PrFile[], scope: PackScope | undefined): PrFile[] {
  if (scope !== 'implementation') return files
  const implementation = filesForPhase(files, 'implementation')
  return implementation.length > 0 ? implementation : files
}

// ---------------------------------------------------------------------------
// Local grounding (the bridge) — decided ONCE per read, never cached
// ---------------------------------------------------------------------------

/**
 * The HEAD-side content reader for `fetchContents`, or undefined when local
 * grounding is not live for this PR.
 *
 * `groundingIsLocal` is re-asked at CALL time, not at wiring time: a bridge
 * can be started, stopped, or moved to another branch while a review page is
 * open, and a decision frozen at mount would keep claiming local long after
 * the checkout moved. Every failure latches through `noteGroundingFailure`, so
 * one dead bridge does not cost every later read a 20 s timeout.
 */
export function localHeadReader(headSha: string): HeadContentReader | undefined {
  if (!groundingIsLocal(headSha)) return undefined
  return async (paths) => {
    try {
      return await readLocalFiles(headSha, paths)
    } catch (err) {
      noteGroundingFailure(headSha)
      throw err
    }
  }
}

/**
 * Wrap one local tool call so a mid-review bridge failure is a FALLBACK, never
 * a dead review: the failure is latched and `fallback` (the provider) answers.
 */
async function localOrProvider<T>(
  headSha: string,
  local: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  if (!groundingIsLocal(headSha)) return fallback()
  try {
    return await local()
  } catch {
    noteGroundingFailure(headSha)
    return fallback()
  }
}

/**
 * Everything a caller wires up to run the AI pipeline for one PR.
 * The getters are the caller's own memoized fetchers — the builder never
 * fetches anything itself, so both callers keep full control over caching,
 * sharing (the route shares contents with InspectStep), and error handling.
 */
export interface AiRunWiring {
  providerId: string
  /** The active VCS provider — supplies the deep-review verification tools. */
  provider: ReviewProvider
  owner: string
  repo: string
  number: number
  meta: PrMeta
  files: PrFile[]
  /** Memoized file-contents fetch (route: getContents; prepare: its own memo). */
  getContents: () => Promise<ContentsMap>
  /**
   * The contents map ONCE RESOLVED, else null — the coach/verify code-context
   * builders read it synchronously (best-effort: null just means no wider
   * file window yet). The route passes its reactive contentsMap; prepare
   * passes a closure over its own resolved map.
   */
  contentsNow: () => ContentsMap | null
  /** Memoized CI summary fetch (never throws — resolve null on failure). */
  getCi: () => Promise<CiSummary | null>
  /** Consent ask (route: the consent dialog; prepare: headless deny). */
  ask: () => Promise<boolean>
  /** Current draft comments for the convergence pass. Optional (prepare omits it). */
  drafts?: () => Draft[]
}

/**
 * Build the AiRunInput exactly as the Review route always has. Behavior is
 * pinned by the full existing suite: prKey format, pack() composition (contents
 * + CI + budget), the deep-review tool source (capability-gated searchCode /
 * findReferences), and the coach/verify code-context wiring are all unchanged —
 * only relocated.
 */
export function buildAiRunInput(w: AiRunWiring): AiRunInput {
  const { providerId, provider, owner, repo, number, meta, files } = w
  const budgetTokens = aiBudgetTokens()
  return {
    prKey: aiPrKey(providerId, owner, repo, number, meta.headSha),
    repo: `${owner}/${repo}`,
    isPrivate: meta.private,
    // PR title + body — the stated intent the intent check verifies the diff
    // against (skip-when-empty handled inside the run).
    meta: { title: meta.title, body: meta.body },
    // Scope-aware pack (#237). Called with no argument — or 'all' — this is the
    // byte-identical pack the route has always built; 'implementation' narrows
    // the file list (contents, CI and budget are unchanged) so the automatic
    // reviewer pass reads only the code under review. The run memoizes PER
    // SCOPE, so switching review phase never re-packs.
    pack: async (scope?: PackScope) => {
      const contents = await w.getContents()
      const ci = await w.getCi()
      return packContext({ files: scopeFilesForPack(files, scope), contents, ci, budgetTokens })
    },
    ci: () => w.getCi(),
    ask: w.ask,
    // Deep review (Plan G): verification tools wired from the active VCS
    // provider. Only used when the deep task modes are on; search is
    // capability-gated by provider method presence (GitHub-only in v1).
    //
    // GROUNDING SOURCE (the bridge): read_file and the two search tools prefer
    // the user's own checkout when its head matches this PR's, and fall back to
    // the provider otherwise — or mid-call, if the bridge goes away. Only the
    // HEAD ref can be served locally: the base commit is not checked out, so
    // read_file_at_base stays on the provider unconditionally.
    //
    // search_code and find_references are offered whenever EITHER source can
    // answer. That matters for a signed-out user: GitHub's /search/code needs
    // auth, so before this the tools simply did not exist for them; with a
    // matching local checkout they do.
    deepReview: {
      // Decided ONCE, at input-build time, purely to pick the fetch-bytes
      // budget (deepReview.ts fetchBudgetFor). The per-CALL routing below
      // re-asks `groundingIsLocal` every time, so a bridge that dies mid-run
      // still falls back — this flag only ever costs a slightly generous
      // budget, never a wrong source.
      local: groundingIsLocal(meta.headSha),
      getFileAtHead: (path: string) =>
        localOrProvider(
          meta.headSha,
          () => readLocalFile(meta.headSha, path),
          () => provider.getFileAtRef({ owner, repo }, path, meta.headSha),
        ),
      getFileAtBase: (path: string) => provider.getFileAtRef({ owner, repo }, path, meta.baseSha),
      ...(provider.searchCode || groundingIsLocal(meta.headSha)
        ? {
            searchCode: (query: string) =>
              localOrProvider(
                meta.headSha,
                () => searchLocalCode(query),
                () =>
                  provider.searchCode
                    ? provider.searchCode({ owner, repo }, query)
                    : Promise.resolve('Code search is not available for this provider.'),
              ),
          }
        : {}),
      ...(provider.findReferences || groundingIsLocal(meta.headSha)
        ? {
            findReferences: (symbol: string) =>
              localOrProvider(
                meta.headSha,
                () => findLocalReferences(symbol),
                () =>
                  provider.findReferences
                    ? provider.findReferences({ owner, repo }, symbol)
                    : Promise.resolve('Reference search is not available for this provider.'),
              ),
          }
        : {}),
    },
    // Per-comment code context for the coach (v16): the actual code at each
    // commented file:line — hunk excerpt + a wider window from the file
    // contents once fetched. Lets the coach verify rather than default to
    // "cannot verify against the diff".
    coachCodeContext: (drafts) => buildCoachCodeContext(drafts, files, w.contentsNow()),
    // Per-finding code context for cross-model verification (Plan M): the
    // actual code at each finding's file:line so verifier models judge
    // against real code. Same source as the coach context above.
    verifyCodeContext: (anchors) => buildCoachCodeContext(anchors, files, w.contentsNow()),
    // Current draft comments for the finding-convergence pass: findings that
    // make the same point as the user's own draft render "covered by your
    // comment" instead of duplicating it. Read at pass time (post-reviewers).
    ...(w.drafts ? { drafts: w.drafts } : {}),
  }
}
