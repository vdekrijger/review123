/**
 * Review submission with modern line/side anchoring (CH-02) and double-submit guard (EC-09i).
 */
import { ghFetch } from './client'
import { GithubApiError } from './types'
import type { PrRef } from './parse'
import type { Draft } from '../drafts/drafts.svelte'

export type Verdict = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

export type SubmitOutcome =
  | { ok: true }
  | { ok: false; kind: 'unauthorized' | 'forbidden' | 'self-approve' | 'invalid-anchor' | 'other'; message: string }

// ---------------------------------------------------------------------------
// In-flight double-submit guard (EC-09i)
// ---------------------------------------------------------------------------

const inFlight = new Set<string>()

/** Reset all in-flight flags — for use in tests only. */
export function _resetInFlightForTest(): void {
  inFlight.clear()
}

// ---------------------------------------------------------------------------
// submitReview
// ---------------------------------------------------------------------------

export async function submitReview(
  ref: PrRef,
  verdict: Verdict,
  bodyText: string,
  drafts: Draft[],
  commitId: string,
): Promise<SubmitOutcome> {
  const prKey = `${ref.owner}/${ref.repo}#${ref.number}`

  // Double-submit guard
  if (inFlight.has(prKey)) {
    return { ok: false, kind: 'other', message: 'A submission is already in progress.' }
  }
  inFlight.add(prKey)

  try {
    // Build request body — modern line/side anchoring, NOT deprecated `position` (CH-02)
    const requestBody: Record<string, unknown> = {
      commit_id: commitId,
      body: bodyText,
      event: verdict,
    }

    // Omit `comments` key entirely when there are no drafts (EC-09a)
    if (drafts.length > 0) {
      requestBody.comments = drafts.map((d) => ({
        path: d.path,
        line: d.line,
        side: d.side,
        body: d.body,
      }))
    }

    await ghFetch(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })

    return { ok: true }
  } catch (err) {
    if (err instanceof GithubApiError) {
      const { detail } = err
      switch (detail.kind) {
        case 'unauthorized':
          return {
            ok: false,
            kind: 'unauthorized',
            message: 'You are not authenticated. Please sign in or add a GitHub token in Settings.',
          }
        case 'forbidden':
          return {
            ok: false,
            kind: 'forbidden',
            message: 'You do not have permission to submit a review on this pull request.',
          }
        case 'unprocessable': {
          const msg = detail.message
          if (/own pull request/i.test(msg)) {
            return { ok: false, kind: 'self-approve', message: msg }
          }
          return { ok: false, kind: 'invalid-anchor', message: msg }
        }
        case 'rate-limited':
          return {
            ok: false,
            kind: 'other',
            message: `GitHub rate limit exceeded. Resets at ${detail.resetAt.toLocaleTimeString()}.`,
          }
        case 'network':
          return { ok: false, kind: 'other', message: 'Network error — check your connection and try again.' }
        case 'server':
          return { ok: false, kind: 'other', message: `GitHub server error (HTTP ${detail.status}).` }
        default:
          return { ok: false, kind: 'other', message: err.message }
      }
    }
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { ok: false, kind: 'other', message }
  } finally {
    inFlight.delete(prKey)
  }
}
