/**
 * src/lib/github/updateBranch.ts — bring a PR's branch up to date with its base.
 *
 * WHY THE NATIVE ENDPOINT AND NOT THE BRIDGE. `PUT /repos/{owner}/{repo}/pulls/
 * {n}/update-branch` is the API behind GitHub's own "Update branch" button. The
 * merge happens on GitHub's servers: no checkout, no working tree, no local
 * clone, and it therefore works on a PR the user has never had on this machine —
 * which is most of the rows on a landing queue. Routing this through the local
 * bridge would have made an app-wide affordance depend on a paired machine and
 * a checked-out branch, for an operation that needs neither.
 *
 * WHAT IT CANNOT DO, said plainly rather than discovered at the 422. A real
 * merge conflict cannot be resolved server-side. GitHub answers 422 and this
 * returns `conflict`; the UI does not offer the button in that state at all
 * (the queue query already knows the PR is CONFLICTING), and the outcome exists
 * for the race where the base moves between the read and the click.
 *
 * `expectedHeadSha` is passed through as `expected_head_sha`. If someone pushed
 * to the branch after the queue read it, GitHub refuses rather than merging into
 * a head we never saw.
 */

import { ghFetch } from './client'
import { GithubApiError } from './types'
import type { PrRef } from './parse'

export type UpdateBranchFailure =
  /** 422 — the merge cannot be performed on the server (conflict, or stale head). */
  | 'conflict'
  /** 403 — the token cannot push to this branch. */
  | 'forbidden'
  /** 404 — gone, renamed, or invisible to this token. */
  | 'not-found'
  /** Anything else: rate limit, network, timeout, 5xx. */
  | 'failed'

export type UpdateBranchOutcome =
  | { ok: true; message: string }
  | { ok: false; kind: UpdateBranchFailure; message: string }

const FAILURE_MESSAGES: Record<UpdateBranchFailure, string> = {
  conflict:
    "GitHub couldn't merge the base branch in — this usually means a conflict, which has to be resolved on a checkout.",
  forbidden: "Your token can't push to this branch.",
  'not-found': "That pull request is no longer reachable with this token.",
  failed: "The update didn't go through.",
}

function classify(err: unknown): { kind: UpdateBranchFailure; message: string } {
  if (err instanceof GithubApiError) {
    const detail = err.detail
    if (detail.kind === 'unprocessable') {
      return { kind: 'conflict', message: detail.message || FAILURE_MESSAGES.conflict }
    }
    if (detail.kind === 'forbidden') {
      return { kind: 'forbidden', message: detail.message || FAILURE_MESSAGES.forbidden }
    }
    if (detail.kind === 'not-found') {
      return { kind: 'not-found', message: FAILURE_MESSAGES['not-found'] }
    }
    if (detail.kind === 'rate-limited') {
      return {
        kind: 'failed',
        message: `GitHub rate limit exceeded. Try again after ${detail.resetAt.toLocaleTimeString()}.`,
      }
    }
  }
  return { kind: 'failed', message: FAILURE_MESSAGES.failed }
}

/**
 * Merge the base branch into the PR's head branch, server-side.
 *
 * Never throws: every failure comes back as a typed outcome so the row can say
 * what happened in place instead of the page losing an unhandled rejection.
 *
 * On success GitHub creates a merge commit on the head branch, which means a NEW
 * head SHA — and therefore CI starting over. The caller re-reads the queue's
 * signals rather than assuming what the new CI state will be.
 */
export async function updateBranch(
  ref: PrRef,
  expectedHeadSha?: string | null,
): Promise<UpdateBranchOutcome> {
  const { owner, repo, number } = ref
  try {
    const body = await ghFetch<{ message?: string }>(
      `/repos/${owner}/${repo}/pulls/${number}/update-branch`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(expectedHeadSha ? { expected_head_sha: expectedHeadSha } : {}),
      },
    )
    return { ok: true, message: body?.message ?? 'Updating the branch.' }
  } catch (err) {
    return { ok: false, ...classify(err) }
  }
}
