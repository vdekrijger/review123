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
    pack: async () => {
      const contents = await w.getContents()
      const ci = await w.getCi()
      return packContext({ files, contents, ci, budgetTokens })
    },
    ci: () => w.getCi(),
    ask: w.ask,
    // Deep review (Plan G): verification tools wired from the active VCS
    // provider. Only used when the deep task modes are on; search is
    // capability-gated by provider method presence (GitHub-only in v1).
    deepReview: {
      getFileAtHead: (path: string) => provider.getFileAtRef({ owner, repo }, path, meta.headSha),
      getFileAtBase: (path: string) => provider.getFileAtRef({ owner, repo }, path, meta.baseSha),
      ...(provider.searchCode
        ? { searchCode: (query: string) => provider.searchCode!({ owner, repo }, query) }
        : {}),
      ...(provider.findReferences
        ? { findReferences: (symbol: string) => provider.findReferences!({ owner, repo }, symbol) }
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
