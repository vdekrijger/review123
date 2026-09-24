/**
 * bridge/fixLoop.ts — the browser half of the agent fix loop.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 *
 * "Get out of the way of the agent-to-agent conversation." A review finding
 * that has a concrete, mechanical fix does not need a human to relay it: the
 * reviewer already knows what is wrong AND what to do, and the user already has
 * a coding agent on this machine. So the finding goes straight over the bridge,
 * the agent fixes it in isolation, and what comes back is the thing worth a
 * person's attention — a commit, its intent, its diff, and whether the tests
 * still pass.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * THE ROUTING RULE (not invented here — it is #228's gate, used as a gate)
 *
 * Every finding carries either a concrete `suggestedFix` or an explicit
 * "No clean fix — <tradeoff>". That distinction already separates the two
 * kinds of finding perfectly:
 *
 *   concrete fix          → mechanical. An agent can do it. ELIGIBLE.
 *   "No clean fix — …"    → a tradeoff the author must weigh. STAYS HUMAN.
 *
 * Plus the triage tier (#226): only PRIMARY findings are eligible by default.
 * A finding the ranking collapsed is, by construction, not worth spending an
 * agent run and a slice of the user's subscription on.
 *
 * EVERY REFUSAL IS A NAMED REASON, never a bare boolean — the discipline
 * `decideGrounding` established in #242. The UI must never have to reconstruct
 * "why can't I do this?" from a false.
 */

import { classifyFetchFailure, requestSignals } from '../net/signals'
import { bridgeAvailable, bridgeCredentials, bridgeInferenceClis, bridgeState } from './bridge.svelte'
import {
  FIX_REQUEST_TIMEOUT_MS,
  MAX_FIX_FINDINGS,
  bridgeUrl,
  parseBridgeError,
  parseFixResponse,
  type BridgeCli,
  type BridgeFixChange,
  type BridgeFixFinding,
  type BridgeFixRequest,
  type BridgeFixResponse,
  type BridgeFixSkip,
  type BridgeFixStopReason,
  type BridgeFixTestOutcome,
} from './protocol'

// ---------------------------------------------------------------------------
// Eligibility — which findings may be sent at all
// ---------------------------------------------------------------------------

/**
 * Why a finding is (or is not) eligible for the agent.
 *
 * - `eligible`      — a concrete fix, in the primary tier. Send it.
 * - `no-fix`        — no `suggestedFix` at all (an old cached result, or a
 *                     model that ignored the requirement). Nothing to hand an
 *                     agent; the human still gets the finding.
 * - `no-clean-fix`  — the honest "No clean fix — <tradeoff>" form. This is a
 *                     JUDGMENT CALL and it is never auto-sent. Automating a
 *                     tradeoff is how you lose the tradeoff.
 * - `secondary`     — collapsed by triage. Not worth an agent run by default;
 *                     the user can still send it by hand from the card.
 */
export type FixEligibility = 'eligible' | 'no-fix' | 'no-clean-fix' | 'secondary'

/** The minimal finding shape eligibility needs. */
export interface FixCandidate {
  suggestedFix?: string
  /** Triage tier from `rankFindings` (#226). */
  tier?: 'primary' | 'secondary'
}

/**
 * The "no clean fix" form, as the skill-review prompt specifies it: the fix
 * STARTS with that phrase and then names the tradeoff. Anchored at the start on
 * purpose — a fix that merely mentions the words mid-sentence ("there is no
 * clean fix for the legacy path, so guard the new one") is still a
 * prescription, and refusing it would silently shrink the eligible set.
 */
const NO_CLEAN_FIX_RE = /^\s*\**\s*no clean fix\b/i

/** Is this text a concrete prescription, or the honest tradeoff form? */
export function isConcreteFix(suggestedFix: string | undefined): boolean {
  if (typeof suggestedFix !== 'string') return false
  const trimmed = suggestedFix.trim()
  if (trimmed === '') return false
  return !NO_CLEAN_FIX_RE.test(trimmed)
}

/** THE ROUTING RULE, as a pure function. Every branch is a named reason. */
export function fixEligibility(finding: FixCandidate): FixEligibility {
  if (typeof finding.suggestedFix !== 'string' || finding.suggestedFix.trim() === '') return 'no-fix'
  if (!isConcreteFix(finding.suggestedFix)) return 'no-clean-fix'
  if (finding.tier === 'secondary') return 'secondary'
  return 'eligible'
}

/** One honest sentence per reason, for a tooltip beside the disabled action. */
export function describeFixEligibility(reason: FixEligibility): string {
  switch (reason) {
    case 'eligible':
      return 'Send this to your local coding agent. It fixes it in a scratch worktree and hands back a commit to review.'
    case 'no-fix':
      return 'This finding carries no concrete fix, so there is nothing to hand an agent.'
    case 'no-clean-fix':
      return 'The reviewer found no clean fix, only a tradeoff. That is a judgment call, so it stays with you.'
    case 'secondary':
      return 'Collapsed findings are not sent automatically. Open the card to send this one on its own.'
  }
}

// ---------------------------------------------------------------------------
// Readiness — whether the affordance may be offered at all
// ---------------------------------------------------------------------------

/**
 * Why the fix loop is (or is not) available right now.
 *
 * - `ready`          — paired, write-enabled, a CLI detected, and the checkout
 *                      is sitting on this PR's head.
 * - `no-bridge`      — nothing paired, or it is not running. The ordinary case.
 * - `write-disabled` — connected, but the bridge is read-only. Only the person
 *                      at the terminal can change that, with `--allow-write`.
 * - `no-cli`         — write-enabled, but no coding agent on PATH to run.
 * - `no-repo-state`  — its root is not a git repository (or git did not answer).
 * - `head-mismatch`  — the checkout is on a different commit. Fixing a PR's
 *                      findings against another branch's code would produce a
 *                      diff nobody asked for.
 */
export type FixReadinessReason =
  | 'ready'
  | 'no-bridge'
  | 'write-disabled'
  | 'no-cli'
  | 'no-repo-state'
  | 'head-mismatch'

export interface FixReadiness {
  ready: boolean
  reason: FixReadinessReason
  /** The CLI that would run, when ready. Null otherwise. */
  cli: BridgeCli | null
  /** The bridge's branch, for the mismatch sentence. Null when unknown. */
  branch: string | null
  /** The bridge's head sha, or null when there is no repo state. */
  bridgeHead: string | null
}

/** What `decideFixReadiness` needs to know. Injected so the rule stays pure. */
export interface FixSnapshot {
  connected: boolean
  /** `capabilities.fix` — the bridge's `--allow-write` flag. */
  writeEnabled: boolean
  /** `capabilities.inference` — CLIs detected on PATH. */
  clis: string[]
  git: { head: string; branch: string | null; dirty: boolean } | null
}

/**
 * Which CLI to drive. `claude` first when both are present — it is the one
 * whose write-mode invocation this repo has actually verified end to end
 * (bridge/README.md § 7); `codex` is supported and is the fallback.
 */
export function preferredFixCli(clis: readonly string[]): BridgeCli | null {
  if (clis.includes('claude')) return 'claude'
  if (clis.includes('codex')) return 'codex'
  return null
}

/**
 * THE READINESS RULE, as a pure function over a snapshot.
 *
 * The head comparison is the same one `decideGrounding` makes, and for the same
 * reason: the scratch worktree is created from the PR's head, so a checkout
 * that does not contain that commit cannot produce a fix for this PR. A DIRTY
 * tree is fine — the worktree is made from the COMMIT, not from the tree, so
 * the user's uncommitted work is neither used nor endangered.
 */
export function decideFixReadiness(snapshot: FixSnapshot, prHead: string): FixReadiness {
  const base = {
    cli: null,
    branch: snapshot.git?.branch ?? null,
    bridgeHead: snapshot.git?.head ?? null,
  }
  if (!snapshot.connected) return { ...base, ready: false, reason: 'no-bridge' }
  if (!snapshot.writeEnabled) return { ...base, ready: false, reason: 'write-disabled' }

  const cli = preferredFixCli(snapshot.clis)
  if (cli === null) return { ...base, ready: false, reason: 'no-cli' }
  if (snapshot.git === null) return { ...base, ready: false, reason: 'no-repo-state' }
  if (snapshot.git.head.toLowerCase() !== prHead.toLowerCase()) {
    return { ...base, ready: false, reason: 'head-mismatch' }
  }
  return { ...base, ready: true, reason: 'ready', cli }
}

/** First 7 characters of a sha, the way every git UI shows one. */
function short(sha: string | null): string {
  return sha === null ? 'unknown' : sha.slice(0, 7)
}

/** One honest sentence for the UI. Never hedges, never invents a cause. */
export function describeFixReadiness(readiness: FixReadiness, prHead: string): string {
  switch (readiness.reason) {
    case 'ready':
      return `Findings with a concrete fix can go straight to ${readiness.cli} in an isolated worktree. Your checkout is never touched.`
    case 'no-bridge':
      return 'Pair a local bridge to hand findings to your own coding agent.'
    case 'write-disabled':
      return 'The paired bridge is read-only. Restart it with --allow-write to let it hand findings to your coding agent — and update it first if it does not recognise the flag.'
    case 'no-cli':
      return 'The paired bridge found no claude or codex CLI on its PATH, so there is no agent to run.'
    case 'no-repo-state':
      return 'The paired bridge is not serving a git repository, so it cannot create the isolated worktree a fix needs.'
    case 'head-mismatch':
      // Names both commits and what each one IS — which is on disk, which was
      // reviewed. It no longer ends with "check it out": the panel offers that
      // as an action when the bridge may do it, and says which flag grants it
      // when it may not. An instruction with nothing to click was the whole
      // complaint.
      return `Your checkout is on ${readiness.branch ?? 'another branch'} at ${short(readiness.bridgeHead)}; these findings were reviewed at ${short(prHead)}. Fixing them here would produce a diff against code they do not describe.`
  }
}

/** The live readiness, read from the connected bridge. */
export function currentFixReadiness(prHead: string): FixReadiness {
  return decideFixReadiness(
    {
      connected: bridgeState.status === 'connected',
      writeEnabled: bridgeAvailable('fix'),
      clis: bridgeInferenceClis(),
      git: bridgeState.git,
    },
    prHead,
  )
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Why a fix run failed OUTRIGHT (as opposed to a per-finding skip, which is a
 * result, not a failure). Every value maps to a different thing the user can
 * do about it — there is deliberately no generic "something went wrong".
 */
export type FixFailureKind =
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

export interface FixFailure {
  kind: FixFailureKind
  /** The bridge's own sentence, when it sent one. Never invented. */
  detail: string
  status?: number
}

export type FixRunOutcome = { ok: true; response: BridgeFixResponse } | { ok: false; failure: FixFailure }

/** Human copy for a failure. One actionable sentence each. */
export function describeFixFailure(failure: FixFailure): string {
  switch (failure.kind) {
    case 'not-paired':
      return 'No local bridge is paired. Open Settings → Local bridge and paste the pairing token the bridge printed.'
    case 'unreachable':
      return 'The local bridge stopped answering, so the run was abandoned. Nothing was left behind in your checkout — restart the bridge and try again.'
    case 'unauthorized':
      return 'The local bridge rejected its pairing token. It mints a new one every time it starts — re-pair it in Settings → Local bridge.'
    case 'write-disabled':
      return 'The local bridge is read-only. Restart it with --allow-write to let it hand findings to your coding agent.'
    case 'route-missing':
      return 'This local bridge is too old to run the fix loop. Update it and restart.'
    case 'cli-unavailable':
      return failure.detail || 'The coding agent is not on the bridge machine’s PATH. Install it, then restart the bridge.'
    case 'head-unknown':
      return failure.detail || 'Your checkout does not have this PR’s head commit, so the bridge could not create a worktree at it. Fetch the branch and try again.'
    case 'worktree-failed':
      return failure.detail || 'The bridge could not create its isolated worktree, so nothing ran. Your checkout is untouched.'
    case 'timeout':
      return 'The fix run took longer than the bridge’s budget and was stopped. Send fewer findings, or run them one at a time.'
    case 'cancelled':
      return 'The fix run was cancelled. Any commits the agent had already made are on the bridge’s scratch branch.'
    case 'bad-request':
      return failure.detail || 'The bridge refused the request.'
    case 'malformed':
      return 'The local bridge returned an answer this build could not read.'
    case 'http':
      return failure.detail || `The local bridge answered with HTTP ${failure.status ?? 'an error'}.`
  }
}

/** Map a non-2xx bridge response onto a named failure. */
function failureForStatus(status: number, code: string | null, message: string): FixFailure {
  const detail = message
  if (status === 401) return { kind: 'unauthorized', detail, status }
  if (status === 404) return { kind: 'route-missing', detail, status }
  if (code === 'write-disabled') return { kind: 'write-disabled', detail, status }
  if (code === 'head-unknown') return { kind: 'head-unknown', detail, status }
  if (code === 'worktree-failed') return { kind: 'worktree-failed', detail, status }
  if (code === 'cli-unavailable') return { kind: 'cli-unavailable', detail, status }
  if (code === 'timeout') return { kind: 'timeout', detail, status }
  if (code === 'bad-request') return { kind: 'bad-request', detail, status }
  // 403 with no recognised code is still an authorisation refusal; the bridge
  // uses it for origin and host as well, and `detail` says which.
  if (status === 403) return { kind: 'write-disabled', detail, status }
  return { kind: 'http', detail, status }
}

export interface RunFixOptions {
  /** Caller cancellation. Composed with the request budget, never replacing it. */
  signal?: AbortSignal | null
  /** Lower the bridge's per-finding round cap. Cannot raise it. */
  maxRounds?: number
}

/**
 * POST one batch of findings to `/v1/fix`.
 *
 * Never throws: every outcome is a FixRunOutcome, so a caller can never turn a
 * missing bridge into an unhandled rejection. The findings are capped HERE as
 * well as at the bridge, because a caller that sent eleven and silently got ten
 * back would show the user a finished surface that quietly dropped one.
 */
export async function runBridgeFix(
  cli: BridgeCli,
  headSha: string,
  findings: readonly BridgeFixFinding[],
  opts: RunFixOptions = {},
): Promise<FixRunOutcome> {
  const stored = bridgeCredentials()
  if (stored === null) return { ok: false, failure: { kind: 'not-paired', detail: '' } }
  if (findings.length === 0) {
    return { ok: false, failure: { kind: 'bad-request', detail: 'No findings were selected.' } }
  }
  if (findings.length > MAX_FIX_FINDINGS) {
    return {
      ok: false,
      failure: {
        kind: 'bad-request',
        detail: `The bridge accepts at most ${MAX_FIX_FINDINGS} findings per run. Send them in smaller batches.`,
      },
    }
  }

  const body: BridgeFixRequest = { cli, headSha, findings: [...findings] }
  if (typeof opts.maxRounds === 'number') body.maxRounds = opts.maxRounds

  const { timeoutSignal, effectiveSignal } = requestSignals(opts.signal ?? null, FIX_REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(bridgeUrl(stored.port, '/v1/fix'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${stored.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      signal: effectiveSignal,
    })
  } catch (err) {
    // A user cancellation and a dead bridge are DIFFERENT things to say, so
    // the shared classifier is used for its answer rather than for its side
    // effect (the mistake #233/#234 fixed).
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
  const parsed = parseFixResponse(payload)
  if (parsed === null) return { ok: false, failure: { kind: 'malformed', detail: '' } }
  return { ok: true, response: parsed }
}

// ---------------------------------------------------------------------------
// Rendering the result honestly
// ---------------------------------------------------------------------------

/** One sentence for why a finding produced no commit. */
export function describeFixSkip(skip: BridgeFixSkip): string {
  switch (skip.reason) {
    case 'refused':
      return skip.detail || 'The agent judged this finding wrong and changed nothing.'
    case 'no-change':
      return skip.detail || 'The agent reported a fix but changed nothing, so there is nothing to review.'
    case 'agent-failed':
      return skip.detail || 'The agent could not complete this finding.'
    case 'timeout':
      return skip.detail || 'The agent ran out of time on this finding and was stopped.'
    case 'forbidden-path':
      return skip.detail || 'This finding points outside the repository, so it was never sent.'
    case 'budget':
      return skip.detail || 'The run’s time budget was spent before this finding got a turn.'
  }
}

/** A short label for the skip reason — the chip beside the sentence. */
export function fixSkipLabel(reason: BridgeFixSkip['reason']): string {
  switch (reason) {
    case 'refused':
      return 'agent disagreed'
    case 'no-change':
      return 'no change'
    case 'agent-failed':
      return 'agent failed'
    case 'timeout':
      return 'timed out'
    case 'forbidden-path':
      return 'outside the repo'
    case 'budget':
      return 'out of time'
  }
}

/** One sentence for why the loop stopped. Reported, never reconstructed. */
export function describeFixStop(reason: BridgeFixStopReason, rounds: number): string {
  switch (reason) {
    case 'all-addressed':
      return rounds > 1
        ? `Finished in ${rounds} rounds — the agent repaired its own change before handing it back.`
        : 'Finished in one round.'
    case 'round-cap':
      return `Stopped at the ${rounds}-round cap with the tests still failing. The commit is here anyway, red — read it before you take it.`
    case 'no-progress':
      return 'Stopped early: a round changed nothing the previous one had not. Another turn would produce the same nothing.'
    case 'repeat-diff':
      return 'Stopped early: the agent went back to a state it had already produced. It was oscillating, not converging.'
    case 'budget-exhausted':
      return 'Stopped: the run’s time budget was spent. What finished is here; the rest were not attempted.'
  }
}

/** One sentence for a test outcome, honest about every non-green status. */
export function describeFixTests(tests: BridgeFixTestOutcome | null): string {
  if (tests === null) return 'No tests were run for this change.'
  switch (tests.status) {
    case 'passed':
      return `${tests.command || 'The test command'} passed.`
    case 'failed':
      return `${tests.command || 'The test command'} FAILED after this change.`
    case 'unrunnable':
      return `Tests could not run: ${tests.detail || 'no runnable test command was found'}.`
    case 'timeout':
      return `${tests.command || 'The test command'} did not finish in time and was stopped.`
    case 'skipped':
      return `Tests were not run: ${tests.detail || 'the bridge skipped them'}.`
  }
}

/** The short chip label for a test outcome. */
export function fixTestLabel(tests: BridgeFixTestOutcome | null): string {
  if (tests === null) return 'no tests'
  switch (tests.status) {
    case 'passed':
      return 'tests passed'
    case 'failed':
      return 'tests failed'
    case 'unrunnable':
      return 'tests unrunnable'
    case 'timeout':
      return 'tests timed out'
    case 'skipped':
      return 'tests skipped'
  }
}

/**
 * The command a user runs to take the changes they approved.
 *
 * This is the ONLY way a fix reaches the user's own branch, and it is entirely
 * theirs to run: the bridge never applies anything outside its scratch
 * worktree. `git cherry-pick` works because the scratch branch lives in their
 * repository, so every returned sha is already in their object store.
 */
export function cherryPickCommand(changes: readonly BridgeFixChange[]): string {
  if (changes.length === 0) return ''
  return `git cherry-pick ${changes.map((c) => c.commit.slice(0, 12)).join(' ')}`
}
