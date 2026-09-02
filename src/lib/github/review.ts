/**
 * Review submission with modern line/side anchoring (CH-02) and double-submit guard (EC-09i).
 *
 * Off-diff re-routing: GitHub rejects any line-anchored review comment whose
 * line is not part of the diff hunks, and the atomic create-review POST fails
 * WHOLE on one bad anchor (422) — losing the valid comments too. The line
 * restriction is a hard API limitation, so submitReview splits drafts up
 * front (splitDraftsByAnchor) and walks a routing ladder that never drops
 * user text:
 *
 *   1. Review POST carries ONLY the anchorable (`inline`) comments.
 *      (Doc-verified: the create-review `comments[]` does NOT accept
 *      `subject_type: "file"` entries — file-level comments cannot ride in
 *      the single POST.)
 *   2. Each off-diff draft is then posted as a FILE-LEVEL review comment:
 *      POST /pulls/{n}/comments with `subject_type: "file"`, the body
 *      prefixed with the intended line ("**Re: line N** …").
 *   3. Any file-level failure is folded into the review body under a marked
 *      section via PUT /pulls/{n}/reviews/{review_id} (update-review).
 *   4. Resilience net: if the main review POST still 422s (stale patch vs
 *      server state), GitHub's error payload is parsed for the offending
 *      comment(s); identified offenders are re-routed to the off-diff path
 *      and the POST retried ONCE. Unidentifiable → one retry with ALL line
 *      comments folded into the review body.
 */
import { ghFetch } from './client'
import { GithubApiError, type GithubError } from './types'
import { apiTimeoutMessage, REQUEST_CANCELLED_MESSAGE } from '../net/signals'
import type { PrRef } from './parse'
import type { Draft } from '../drafts/drafts.svelte'
import { outgoingCommentBody } from '../drafts/drafts.svelte'
import {
  splitDraftsByAnchor,
  offDiffCommentBody,
  foldOffDiffIntoBody,
  type PatchFile,
} from './anchorSplit'

export type Verdict = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

/**
 * How each drafted comment was actually posted — drives the honest post-submit
 * readout ("K posted inline · M posted as file comments · J folded into the
 * review body").
 */
export interface SubmitBreakdown {
  /** Posted as line-anchored review comments (the normal path). */
  inline: number
  /** Posted as file-level comments / position-less notes (line not in diff). */
  fileLevel: number
  /** Folded into the review body's marked section (last-resort fallback). */
  bodyFolded: number
}

export type SubmitOutcome =
  | { ok: true; posted?: SubmitBreakdown }
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
// 422 offender identification (resilience net)
// ---------------------------------------------------------------------------

/**
 * Best-effort parse of GitHub's 422 payload to find WHICH inline comments the
 * server rejected. GitHub identifies the offender when it can:
 *   - "comments[3]" style index references in message/errors,
 *   - error entries carrying a `path` field.
 * Returns the identified inline-draft indexes; empty when unidentifiable.
 */
function identifyOffenderIndexes(
  detail: Extract<GithubError, { kind: 'unprocessable' }>,
  inline: readonly Draft[],
): Set<number> {
  const offenders = new Set<number>()
  let combined = detail.message
  try {
    combined += ' ' + JSON.stringify(detail.errors ?? [])
  } catch { /* unserializable errors — message alone */ }

  // Pattern 1: explicit comments[i] index references
  for (const m of combined.matchAll(/comments\[(\d+)\]/g)) {
    const i = Number(m[1])
    if (i >= 0 && i < inline.length) offenders.add(i)
  }

  // Pattern 2: error entries naming a path — re-route every draft on that path
  for (const e of detail.errors ?? []) {
    const path = (e as { path?: unknown } | null)?.path
    if (typeof path === 'string') {
      inline.forEach((d, i) => {
        if (d.path === path) offenders.add(i)
      })
    }
  }

  return offenders
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
  /**
   * The PR's changed files (patch text) — the client-side truth for the
   * inline/off-diff split. Empty/omitted → no split (legacy behavior); the
   * 422 resilience net still applies.
   */
  files: readonly PatchFile[] = [],
): Promise<SubmitOutcome> {
  const prKey = `${ref.owner}/${ref.repo}#${ref.number}`

  // Double-submit guard
  if (inFlight.has(prKey)) {
    return { ok: false, kind: 'other', message: 'A submission is already in progress.' }
  }
  inFlight.add(prKey)

  const reviewsPath = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`
  const commentsPath = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`

  /** POST the review — modern line/side anchoring, NOT deprecated `position` (CH-02). */
  function postReview(inlineDrafts: readonly Draft[], body: string): Promise<{ id: number }> {
    const requestBody: Record<string, unknown> = {
      commit_id: commitId,
      body,
      event: verdict,
    }
    // Omit `comments` key entirely when there are no inline drafts (EC-09a)
    if (inlineDrafts.length > 0) {
      requestBody.comments = inlineDrafts.map((d) => ({
        path: d.path,
        line: d.line,
        side: d.side,
        body: outgoingCommentBody(d),
        ...(d.startLine != null && d.startLine < d.line
          ? { start_line: d.startLine, start_side: d.side }
          : {}),
      }))
    }
    return ghFetch<{ id: number }>(reviewsPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
  }

  try {
    let { inline, offDiff } = splitDraftsByAnchor(drafts, files)
    let currentBody = bodyText
    let bodyFolded = 0

    // ---- 1. Review POST (inline comments only) + one-shot 422 retry -------
    let reviewId: number
    try {
      reviewId = (await postReview(inline, currentBody)).id
    } catch (err) {
      const retriable =
        err instanceof GithubApiError &&
        err.detail.kind === 'unprocessable' &&
        !/own pull request/i.test(err.detail.message) &&
        inline.length > 0
      if (!retriable) throw err

      const offenders = identifyOffenderIndexes(
        (err as GithubApiError).detail as Extract<GithubError, { kind: 'unprocessable' }>,
        inline,
      )
      if (offenders.size > 0) {
        // Re-route the identified offenders to the off-diff path; retry ONCE.
        offDiff = [...offDiff, ...inline.filter((_, i) => offenders.has(i))]
        inline = inline.filter((_, i) => !offenders.has(i))
      } else {
        // Unidentifiable: nothing is provably inline anymore — fold ALL line
        // comments into the review body and retry ONCE with no anchors.
        currentBody = foldOffDiffIntoBody(
          currentBody,
          inline.map((d) => ({ draft: d, outgoingBody: outgoingCommentBody(d) })),
        )
        bodyFolded += inline.length
        inline = []
      }
      // Second failure propagates to the outer mapping — capped at one retry.
      reviewId = (await postReview(inline, currentBody)).id
    }

    // ---- 2. Off-diff drafts → file-level review comments -------------------
    let fileLevel = 0
    const fileFailures: Draft[] = []
    for (const d of offDiff) {
      try {
        await ghFetch(commentsPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: offDiffCommentBody(d, outgoingCommentBody(d)),
            commit_id: commitId,
            path: d.path,
            subject_type: 'file',
          }),
        })
        fileLevel++
      } catch {
        fileFailures.push(d)
      }
    }

    // ---- 3. File-level failures → fold into the review body (PUT) ---------
    if (fileFailures.length > 0) {
      try {
        currentBody = foldOffDiffIntoBody(
          currentBody,
          fileFailures.map((d) => ({ draft: d, outgoingBody: outgoingCommentBody(d) })),
        )
        await ghFetch(`${reviewsPath}/${reviewId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: currentBody }),
        })
        bodyFolded += fileFailures.length
      } catch {
        // Even the body fold failed — the review itself IS posted, but these
        // comments are nowhere. Report honestly; drafts are kept (not cleared)
        // so no text is lost.
        const list = fileFailures.map((d) => `${d.path}:${d.line}`).join(', ')
        return {
          ok: false,
          kind: 'other',
          message: `Your review was posted, but ${fileFailures.length} comment(s) on lines outside the diff could not be posted (${list}). They remain in your drafts — you can post them on GitHub directly.`,
        }
      }
    }

    return { ok: true, posted: { inline: inline.length, fileLevel, bodyFolded } }
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
        case 'forbidden': {
          const verbatimMsg = detail.message || 'You do not have permission to submit a review on this pull request.'
          const patGuidance = ' If you can review this PR in your browser, the repository\'s organization likely restricts OAuth apps. Use a fine-grained PAT instead (Settings → Advanced) — those are not subject to org OAuth-app policies. Org admins can also approve this app.'
          return {
            ok: false,
            kind: 'forbidden',
            message: verbatimMsg + patGuidance,
          }
        }
        case 'unprocessable': {
          const msg = detail.message
          if (/own pull request/i.test(msg)) {
            // Belt and braces: the Verdict step gates own-PR verdicts up front,
            // but gating can miss (e.g. PAT user differs from the resolved viewer).
            return {
              ok: false,
              kind: 'self-approve',
              message: "GitHub doesn't allow approving or requesting changes on your own pull request — switch the verdict to Comment to post your feedback.",
            }
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
        case 'timeout':
          return { ok: false, kind: 'other', message: apiTimeoutMessage('GitHub', detail.afterMs) }
        case 'cancelled':
          return { ok: false, kind: 'other', message: REQUEST_CANCELLED_MESSAGE }
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
