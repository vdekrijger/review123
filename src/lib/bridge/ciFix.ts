/**
 * bridge/ciFix.ts — asking the local agent to do something about a red CI run.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE VOCABULARY THIS FILE IS CAREFUL WITH
 *
 * Three things are true at once at the end of a successful run, and a surface
 * that states only the first is lying by omission:
 *
 *   1. The repository's own test command failed here, then stopped failing
 *      after the agent's change. That is a real, observed fact.
 *   2. It is a fact about ONE command on ONE machine. CI is a different
 *      machine, a different environment, and usually more commands.
 *   3. Pushing makes CI run again. Whatever it then reports is a NEW RESULT,
 *      not a verdict — a green check after a change is evidence, not proof the
 *      defect is gone, and nobody has read this code yet.
 *
 * So nothing here says "fixed", "resolved" or "done", and nothing renders a
 * green check as a conclusion. The words are chosen so that a person skimming
 * the surface arrives at the right belief, not just a true one.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { classifyFetchFailure, requestSignals } from '../net/signals'
import { bridgeAvailable, bridgeCredentials } from './bridge.svelte'
import {
  FIX_REQUEST_TIMEOUT_MS,
  MAX_CI_FAILURES,
  bridgeUrl,
  parseBridgeError,
  parseCiFixResponse,
  type BridgeCiFailure,
  type BridgeCiFixRequest,
  type BridgeCiFixResponse,
  type BridgeCiReproduction,
  type BridgeCli,
} from './protocol'

export type CiFixFailureKind =
  | 'not-paired'
  | 'unreachable'
  | 'unauthorized'
  | 'write-disabled'
  | 'route-missing'
  | 'cli-unavailable'
  | 'head-unknown'
  | 'worktree-failed'
  | 'timeout'
  | 'cancelled'
  | 'bad-request'
  | 'malformed'
  | 'http'

export interface CiFixFailure {
  kind: CiFixFailureKind
  detail: string
  status?: number
}

export type CiFixRunOutcome =
  | { ok: true; response: BridgeCiFixResponse }
  | { ok: false; failure: CiFixFailure }

/** Human copy for a failure. One actionable sentence each. */
export function describeCiFixFailure(failure: CiFixFailure): string {
  switch (failure.kind) {
    case 'not-paired':
      return 'No local bridge is paired. Open Settings → Local bridge and paste the pairing token the bridge printed.'
    case 'unreachable':
      return 'The local bridge stopped answering, so the run was abandoned. Nothing was left behind in your checkout — restart the bridge and try again.'
    case 'unauthorized':
      return 'The local bridge rejected its pairing token. It mints a new one every time it starts — re-pair it in Settings → Local bridge.'
    case 'write-disabled':
      return 'The local bridge is read-only. Restart it with --allow-write to let it hand the failing job to your coding agent.'
    case 'route-missing':
      return 'This local bridge is too old to work on a failing CI run. Update it and restart — this arrived in bridge 0.4.0.'
    case 'cli-unavailable':
      return failure.detail || 'The coding agent is not on the bridge machine’s PATH. Install it, then restart the bridge.'
    case 'head-unknown':
      return (
        failure.detail ||
        'Your checkout does not have this PR’s head commit, so the bridge could not create a worktree at it. Fetch the branch and try again.'
      )
    case 'worktree-failed':
      return failure.detail || 'The bridge could not create its isolated worktree, so nothing ran. Your checkout is untouched.'
    case 'timeout':
      return 'The run took longer than the bridge’s budget and was stopped. Nothing was committed from the turn that was interrupted.'
    case 'cancelled':
      return 'The run was cancelled. Any commits the agent had already made are on the bridge’s scratch branch, and nothing was pushed.'
    case 'bad-request':
      return failure.detail || 'The bridge refused the request.'
    case 'malformed':
      return 'The local bridge returned an answer this build could not read.'
    case 'http':
      return failure.detail || `The local bridge answered with HTTP ${failure.status ?? 'an error'}.`
  }
}

function failureForStatus(status: number, code: string | null, message: string): CiFixFailure {
  const detail = message
  if (status === 401) return { kind: 'unauthorized', detail, status }
  if (status === 404) return { kind: 'route-missing', detail, status }
  if (code === 'write-disabled') return { kind: 'write-disabled', detail, status }
  if (code === 'head-unknown') return { kind: 'head-unknown', detail, status }
  if (code === 'worktree-failed') return { kind: 'worktree-failed', detail, status }
  if (code === 'cli-unavailable') return { kind: 'cli-unavailable', detail, status }
  if (code === 'timeout') return { kind: 'timeout', detail, status }
  if (code === 'bad-request') return { kind: 'bad-request', detail, status }
  if (status === 403) return { kind: 'write-disabled', detail, status }
  return { kind: 'http', detail, status }
}

export interface RunCiFixOptions {
  signal?: AbortSignal | null
  /** Lower the bridge's per-item round cap. Cannot raise it. */
  maxRounds?: number
}

/**
 * POST one failing-CI run to `/v1/ci-fix`.
 *
 * Never throws: every outcome is a CiFixRunOutcome. The failures are capped
 * here as well as at the bridge, because a caller that sent six and silently
 * got five back would show a finished surface that quietly dropped one.
 */
export async function runBridgeCiFix(
  cli: BridgeCli,
  headSha: string,
  failures: readonly BridgeCiFailure[],
  opts: RunCiFixOptions = {},
): Promise<CiFixRunOutcome> {
  const stored = bridgeCredentials()
  if (stored === null) return { ok: false, failure: { kind: 'not-paired', detail: '' } }
  if (failures.length === 0) {
    return { ok: false, failure: { kind: 'bad-request', detail: 'No failing jobs were selected.' } }
  }
  if (!bridgeAvailable('fix')) {
    return { ok: false, failure: { kind: 'write-disabled', detail: '' } }
  }

  const body: BridgeCiFixRequest = {
    cli,
    headSha,
    failures: failures.slice(0, MAX_CI_FAILURES).map((f) => ({ ...f })),
  }
  if (typeof opts.maxRounds === 'number') body.maxRounds = opts.maxRounds

  const { timeoutSignal, effectiveSignal } = requestSignals(opts.signal ?? null, FIX_REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(bridgeUrl(stored.port, '/v1/ci-fix'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${stored.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
    try {
      parsed = parseBridgeError(await response.json())
    } catch {
      /* a non-JSON body from something that is not our bridge */
    }
    return { ok: false, failure: failureForStatus(response.status, parsed.code, parsed.message) }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, failure: { kind: 'malformed', detail: '' } }
  }
  const parsed = parseCiFixResponse(payload)
  if (parsed === null) return { ok: false, failure: { kind: 'malformed', detail: '' } }
  return { ok: true, response: parsed }
}

// ---------------------------------------------------------------------------
// Saying what happened, honestly
// ---------------------------------------------------------------------------

/** The headline for the round-zero verdict. Never softened. */
export function describeReproduction(response: BridgeCiFixResponse): string {
  switch (response.reproduction) {
    case 'reproduced':
      return `The failure reproduced here: ${response.baseline?.command || 'your test command'} failed at this commit before anything was changed.`
    case 'not-reproduced':
      return `The failure did NOT reproduce here: ${response.baseline?.command || 'your test command'} passed at this commit, unchanged. No agent was started and nothing was changed.`
    case 'no-local-signal':
      return 'There was no local signal to work from: the test command could not be run here, so there was no way to watch the failure happen. No agent was started and nothing was changed.'
  }
}

/**
 * The next move when the failure did not reproduce.
 *
 * A refusal with no way forward teaches people to stop reading refusals, and
 * the way forward here is genuinely useful: the bridge runs the repo's `test`
 * script, and CI is usually red in a build, a type-check or an end-to-end
 * suite that script does not cover.
 */
export function describeNoReproductionNextStep(reproduction: BridgeCiReproduction): string | null {
  if (reproduction === 'reproduced') return null
  return 'Restart the bridge with --test-command pointing at the step that is actually red — for example `--test-command "pnpm build"` — and run this again.'
}

/**
 * Whether a push may even be offered, and why not when it may not.
 *
 * The rule is the same one the bridge enforces, restated where the button is:
 * a commit exists only when the failure was reproduced, so there is nothing to
 * push otherwise. Stated here as well so the UI explains itself instead of
 * showing a disabled button with no reason.
 */
export function pushableCommit(response: BridgeCiFixResponse): string | null {
  if (response.reproduction !== 'reproduced') return null
  return response.headCommit
}

/**
 * The line that must appear beside any local green result.
 *
 * It is the whole honesty position in one sentence, and it is deliberately not
 * conditional: it is as true of a run that went green in one round as of one
 * that scraped through on the third.
 */
export const CI_FIX_LOCAL_ONLY =
  'That is one command on your machine, not CI. Pushing makes CI run again, and whatever it reports next is a new result rather than proof the defect is gone.'

/** And the one that must appear beside any result at all. */
export const CI_FIX_NOT_REVIEWED =
  'No person has read this change yet. An agent wrote it against a failing test; that is a starting point for your review, not a substitute for it.'

/** One sentence for how a run ended, in CI's terms rather than the loop's. */
export function describeCiStop(response: BridgeCiFixResponse): string {
  const green = response.tests?.status === 'passed'
  switch (response.stopReason) {
    case 'all-addressed':
      return green
        ? 'The agent stopped when the test command stopped failing here.'
        : 'The agent stopped, and the test command did not report a failure afterwards.'
    case 'round-cap':
      return 'The agent used all its rounds and the test command was STILL failing here. The commit is kept so you can read it, but nothing about it has been shown to work.'
    case 'no-progress':
      return 'A round changed nothing the previous one had not, so the loop stopped rather than spending another turn on the same state.'
    case 'repeat-diff':
      return 'The agent went back to a state an earlier round had already produced — it was going in circles, so the loop stopped.'
    case 'budget-exhausted':
      return 'The run hit its time budget and stopped. Anything not finished was discarded rather than committed half-done.'
  }
}

/** True when the run produced something a person should read before pushing. */
export function hasUnverifiedCommit(response: BridgeCiFixResponse): boolean {
  return response.headCommit !== null && response.tests?.status !== 'passed'
}
