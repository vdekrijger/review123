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
import { getSettings } from '../settings/settings'
import type { ReviewProvider, PrRefX, ParseResult } from './types'
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
}
