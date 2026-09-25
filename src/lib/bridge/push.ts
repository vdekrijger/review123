/**
 * bridge/push.ts — asking the local bridge to move one remote branch forward.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE CONFIRMATION IS THE PRODUCT HERE, not the request.
 *
 * Everything else this app asks a bridge for is undoable by the person who
 * asked: a scratch worktree can be deleted, a checkout can be restored, a
 * commit that never left the machine can be dropped. A push is not like that.
 * Once it lands, everyone who can see the repository can see it, CI may start,
 * and a colleague may pull it. No affordance in this app takes it back.
 *
 * So this module's job is not to make pushing easy. It is to make sure that
 * what the user agreed to and what the bridge does are provably the same
 * thing:
 *
 *   - `describePushPlan` renders the WHOLE move in one sentence — the remote,
 *     the branch, the commit it is at now and the commit it will be at — and
 *     that is the sentence the confirmation shows. Not "Push?".
 *   - The request carries `expectedRemoteSha`, so a branch that moved between
 *     the confirmation and the click is REFUSED by the bridge rather than
 *     pushed over. The user is asked again, about the new situation.
 *   - The response echoes both shas, and `describePushResult` restates them.
 *     A person who confirmed "from a1b2c3 to d4e5f6" can check that is what
 *     happened, rather than taking a green tick's word for it.
 *
 * WHAT THIS MODULE REFUSES TO OFFER. There is no force, no retry, no "push
 * anyway", and no batching. Those are not missing features; each of them is a
 * way for one confirmation to authorise more than one act.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { classifyFetchFailure, requestSignals } from '../net/signals'
import { bridgeAvailable, bridgeCredentials } from './bridge.svelte'
import {
  DEFAULT_PUSH_REMOTE,
  PUSH_REQUEST_TIMEOUT_MS,
  bridgeUrl,
  parseBridgeError,
  parsePushResponse,
  type BridgePushRequest,
  type BridgePushResponse,
} from './protocol'

/**
 * Every way a push can fail to happen, as one named thing each.
 *
 * Deliberately NOT collapsed into "it didn't work". Half of these are answered
 * by a different action (fetch, commit your work, look again, ask an admin) and
 * a user who is told only that something failed will either give up or retry
 * blindly — and blind retry is the wrong instinct for the one operation here
 * that can already have half happened.
 */
export type PushFailureKind =
  | 'not-paired'
  | 'unreachable'
  | 'unauthorized'
  | 'push-disabled'
  | 'route-missing'
  | 'protected-branch'
  | 'default-branch-unknown'
  | 'remote-unknown'
  | 'branch-missing'
  | 'commit-unknown'
  | 'tree-dirty'
  | 'remote-moved'
  | 'not-fast-forward'
  | 'nothing-to-push'
  | 'remote-unreachable'
  | 'push-rejected'
  | 'push-failed'
  | 'timeout'
  | 'cancelled'
  | 'bad-request'
  | 'malformed'
  | 'http'

export interface PushFailure {
  kind: PushFailureKind
  /** The bridge's own sentence, when it sent one. Never invented. */
  detail: string
  status?: number
  /** On `tree-dirty`: what the bridge said is in the way. */
  dirtyPaths?: string[]
  dirtyCount?: number
}

export type PushRunOutcome =
  | { ok: true; response: BridgePushResponse }
  | { ok: false; failure: PushFailure }

/**
 * Human copy for a failure. One actionable sentence each, and the bridge's own
 * words preferred wherever it sent them — it knows things this layer does not,
 * like which hook declined.
 */
export function describePushFailure(failure: PushFailure): string {
  switch (failure.kind) {
    case 'not-paired':
      return 'No local bridge is paired. Open Settings → Local bridge and paste the pairing token the bridge printed.'
    case 'unreachable':
      return 'The local bridge stopped answering before the push was sent. Nothing left your machine — restart the bridge and look at the branch again.'
    case 'unauthorized':
      return 'The local bridge rejected its pairing token. It mints a new one every time it starts — re-pair it in Settings → Local bridge.'
    case 'push-disabled':
      return (
        failure.detail ||
        'This bridge may not write to a remote. Restart it with --allow-push to let it move this branch forward. Neither --allow-write nor --allow-checkout enables that: those change things on your machine, and a push cannot be undone.'
      )
    case 'route-missing':
      return 'This local bridge is too old to push. Update it and restart — the push capability arrived in bridge 0.4.0.'
    case 'protected-branch':
      return failure.detail || 'The bridge will not push to that branch.'
    case 'default-branch-unknown':
      return (
        failure.detail ||
        "The bridge could not establish which branch the remote treats as its default, so it could not prove this is not it, and refused rather than guess."
      )
    case 'remote-unknown':
      return failure.detail || 'Your checkout has no remote by that name, so there was nothing to push to.'
    case 'branch-missing':
      return (
        failure.detail ||
        'That branch does not exist on the remote. The bridge only moves branches that are already there — creating one is a separate act it does not perform.'
      )
    case 'commit-unknown':
      return failure.detail || 'That commit is not in your checkout, so there was nothing there to push.'
    case 'tree-dirty':
      return (
        failure.detail ||
        'Your checkout has uncommitted changes. The bridge will not push from a repository whose working tree does not match what would be sent — commit or stash them, then try again.'
      )
    case 'remote-moved':
      return (
        failure.detail ||
        'The branch moved on the remote since this push was planned, so nothing was sent. Look at it again and decide afresh.'
      )
    case 'not-fast-forward':
      return (
        failure.detail ||
        'That push would not be a fast-forward — commits on the remote would stop being reachable. The bridge has no way to force a push, so it refused.'
      )
    case 'nothing-to-push':
      return failure.detail || 'The remote branch is already at that commit. Nothing was sent.'
    case 'remote-unreachable':
      return failure.detail || 'The bridge could not reach the remote, so nothing was pushed.'
    case 'push-rejected':
      return failure.detail || 'The remote refused the push.'
    case 'push-failed':
      return (
        failure.detail ||
        'The bridge could not complete the push. Check the branch on the remote before trying again — it will not retry on its own.'
      )
    case 'timeout':
      // The honest sentence. A push that timed out on this side may still have
      // landed on the other, and telling someone to "just try again" would be
      // advice given without knowing.
      return 'The push took longer than this app waits, so the outcome is not known here. Check the branch on the remote before trying again — nothing is retried automatically.'
    case 'cancelled':
      return 'The push was cancelled before it finished. Check the branch on the remote before trying again.'
    case 'bad-request':
      return failure.detail || 'The bridge refused the request.'
    case 'malformed':
      return 'The local bridge returned an answer this build could not read, so the outcome is not known here. Check the branch on the remote.'
    case 'http':
      return failure.detail || `The local bridge answered with HTTP ${failure.status ?? 'an error'}.`
  }
}

/** The bridge's error codes, as this layer's named failures. */
const CODE_TO_KIND: Record<string, PushFailureKind> = {
  'push-disabled': 'push-disabled',
  'protected-branch': 'protected-branch',
  'default-branch-unknown': 'default-branch-unknown',
  'remote-unknown': 'remote-unknown',
  'branch-missing': 'branch-missing',
  'commit-unknown': 'commit-unknown',
  'tree-dirty': 'tree-dirty',
  'remote-moved': 'remote-moved',
  'not-fast-forward': 'not-fast-forward',
  'nothing-to-push': 'nothing-to-push',
  'remote-unreachable': 'remote-unreachable',
  'push-rejected': 'push-rejected',
  'push-failed': 'push-failed',
  'bad-request': 'bad-request',
  timeout: 'timeout',
}

/** Map a non-2xx bridge response onto a named failure. */
export function pushFailureForStatus(status: number, code: string | null, message: string): PushFailure {
  const detail = message
  if (status === 401) return { kind: 'unauthorized', detail, status }
  if (status === 404 && code === null) return { kind: 'route-missing', detail, status }
  const mapped = code === null ? undefined : CODE_TO_KIND[code]
  if (mapped !== undefined) return { kind: mapped, detail, status }
  if (status === 404) return { kind: 'route-missing', detail, status }
  // A 403 with no code we recognise is still an authorisation refusal — the
  // bridge uses it for origin and host too, and `detail` says which.
  if (status === 403) return { kind: 'push-disabled', detail, status }
  return { kind: 'http', detail, status }
}

/**
 * The whole move, in one sentence, for the confirmation the user reads.
 *
 * It names four things because four things can each be wrong: the remote, the
 * branch, where it is now and where it will be. A confirmation that said "Push
 * 1 commit?" would be asking about the least important of them.
 */
export function describePushPlan(plan: BridgePushRequest, commits: number | null): string {
  const count =
    commits === null ? 'commits' : commits === 1 ? '1 commit' : `${commits} commits`
  return `Move ${plan.remote}/${plan.branch} forward by ${count}, from ${short(plan.expectedRemoteSha)} to ${short(plan.sha)}.`
}

/**
 * What the confirmation says about consequences, verbatim, every time.
 *
 * Not softened and not shortened on repeat pushes. The second push is exactly
 * as irreversible as the first, and a dialog that got quieter with familiarity
 * would be optimising for the wrong thing.
 */
export const PUSH_CONSEQUENCE =
  'This is the only thing review123 does that leaves your machine, and it cannot be undone. Everyone who can see the repository will see these commits, and CI may start on them.'

/**
 * The guarantees the bridge actually enforces, said plainly next to the button.
 *
 * The last line is there because the user asked for "only branches of pull
 * requests you authored", and the honest answer is that the bridge cannot know
 * that. Saying so in the confirmation is better than implying a check that
 * does not exist.
 */
export const PUSH_GUARANTEES: readonly string[] = [
  'Fast-forward only — a push that would make any commit unreachable is refused.',
  'There is no force: the bridge has no way to express one.',
  "Never the remote's default branch, and never a branch that is not already there.",
  'The bridge cannot check who authored this pull request — it has no GitHub account — so it does not claim to.',
]

/** What actually happened, restated in the terms the user confirmed. */
export function describePushResult(response: BridgePushResponse): string {
  const count = response.commits === 1 ? '1 commit' : `${response.commits} commits`
  return `${response.remote}/${response.branch} moved from ${short(response.before)} to ${short(response.after)} — ${count}.`
}

/**
 * And what it does NOT mean.
 *
 * A push is a fact about a branch. It is not a fact about CI, and the gap
 * between the two is exactly where "the check went green so it must be fixed"
 * comes from. CI re-running produces a new result; a new result is a new fact,
 * not a verdict on whether the defect is gone.
 */
export const PUSH_NOT_A_VERDICT =
  'CI will run again on these commits. Whatever it reports is a new result, not proof the defect is gone — and nobody has reviewed this code yet.'

function short(sha: string): string {
  return sha.slice(0, 12)
}

export interface RunPushOptions {
  /** Caller cancellation. Composed with the request budget, never replacing it. */
  signal?: AbortSignal | null
}

/**
 * POST one push to the bridge. ONE.
 *
 * Never throws: every outcome is a PushRunOutcome, so a caller can never turn
 * a missing bridge into an unhandled rejection. And never retries — not on a
 * timeout, not on a network error, not on a 5xx. A push that may have half
 * happened must be looked at by a person, not attempted again by a loop.
 */
export async function runBridgePush(
  plan: BridgePushRequest,
  opts: RunPushOptions = {},
): Promise<PushRunOutcome> {
  const stored = bridgeCredentials()
  if (stored === null) return { ok: false, failure: { kind: 'not-paired', detail: '' } }

  // Checked here as well as at the bridge. The bridge's 403 is the real gate;
  // this one means a user whose bridge has no push grant is told so without a
  // request being made at all, which is the right shape for a capability the
  // UI should not have offered in the first place.
  if (!bridgeAvailable('push')) {
    return { ok: false, failure: { kind: 'push-disabled', detail: '' } }
  }

  const { timeoutSignal, effectiveSignal } = requestSignals(opts.signal ?? null, PUSH_REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(bridgeUrl(stored.port, '/v1/push'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${stored.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(plan),
      credentials: 'omit',
      cache: 'no-store',
      signal: effectiveSignal,
    })
  } catch (err) {
    const classified = classifyFetchFailure(err, timeoutSignal)
    if (classified === 'timeout') return { ok: false, failure: { kind: 'timeout', detail: '' } }
    if (classified === 'cancelled') return { ok: false, failure: { kind: 'cancelled', detail: '' } }
    return { ok: false, failure: { kind: 'unreachable', detail: '' } }
  }

  if (!response.ok) {
    let parsed: { code: string | null; message: string } = { code: null, message: '' }
    let body: unknown = null
    try {
      body = await response.json()
      parsed = parseBridgeError(body)
    } catch {
      /* a non-JSON body from something that is not our bridge */
    }
    const failure = pushFailureForStatus(response.status, parsed.code, parsed.message)
    // `tree-dirty` carries evidence. A refusal that names the files is one the
    // user can act on in seconds; one that does not is a puzzle.
    if (failure.kind === 'tree-dirty' && typeof body === 'object' && body !== null) {
      const raw = body as Record<string, unknown>
      if (Array.isArray(raw['dirtyPaths'])) {
        failure.dirtyPaths = raw['dirtyPaths'].filter((p): p is string => typeof p === 'string').slice(0, 100)
      }
      if (typeof raw['dirtyCount'] === 'number') failure.dirtyCount = raw['dirtyCount']
    }
    return { ok: false, failure }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, failure: { kind: 'malformed', detail: '' } }
  }
  const parsed = parsePushResponse(payload)
  if (parsed === null) return { ok: false, failure: { kind: 'malformed', detail: '' } }
  return { ok: true, response: parsed }
}

export { DEFAULT_PUSH_REMOTE }
