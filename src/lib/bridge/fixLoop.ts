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
import { stopReasonOutranksVerification } from '../ai/fixVerify'
import {
  BRIDGE_CLIS,
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
  /**
   * The user's stored CLI choice, or null for "no preference". Injected like
   * every other input here so the rule stays pure and testable without storage.
   */
  preferredCli?: BridgeCli | null
}

/**
 * WHICH CLI DRIVES THE FIX — a preference, not a fact.
 *
 * The rule used to be a hard-coded ranking: `claude` over `codex` whenever both
 * were present. It produced a button reading "Send 4 to claude" for a user who
 * had never chosen claude and had no way to say otherwise — a preference they
 * never set, presented as a fact. People run several agents deliberately.
 *
 * So the ranking is now the DEFAULT, not the answer. `preferred` is the user's
 * stored choice, and it wins whenever it names a CLI the bridge actually
 * detected. When it names one that is ABSENT (uninstalled since, or a different
 * machine) the ranking answers instead: refusing to run because of a stale
 * preference would be worse than running the other one, and every label here
 * names the CLI that will actually run.
 *
 * The ranking itself is unchanged: `claude` first, because it is the one whose
 * write-mode invocation this repo has verified end to end (bridge/README.md
 * § 7); `codex` is supported and is the fallback.
 */
export function preferredFixCli(
  clis: readonly string[],
  preferred: BridgeCli | null = null,
): BridgeCli | null {
  if (preferred !== null && clis.includes(preferred)) return preferred
  if (clis.includes('claude')) return 'claude'
  if (clis.includes('codex')) return 'codex'
  return null
}

/**
 * The CLIs the user could choose between, in the ranking's order.
 *
 * SHORTER THAN TWO MEANS THERE IS NO CHOICE, and the panel renders no picker.
 * One detected CLI is not a decision anybody gets to make; offering it as one
 * would invent a fork that does not exist.
 */
export function fixCliChoices(clis: readonly string[]): BridgeCli[] {
  return BRIDGE_CLIS.filter((c) => clis.includes(c))
}

/**
 * Where the choice is remembered: per-browser, in localStorage.
 *
 * Storage: `review123:fix-cli`
 * Schema:  { cli: 'claude' | 'codex' }
 * Default: ABSENT — and absent reads as "no preference", which lands on the
 *          ranking above. Nothing changes for anyone who never touches it.
 *
 * Deliberately NOT a settings.ts field — the same reasoning as
 * src/lib/guide/hunkAttentionPref.svelte.ts and
 * src/lib/guide/resolvedThreadsPref.svelte.ts. WHICH coding agent is installed
 * is a property of this MACHINE, and settings are meant to travel with the
 * user. A preference that followed them to a laptop without codex on it would
 * be a preference for a CLI that is not there.
 */
export const FIX_CLI_PREF_KEY = 'review123:fix-cli'

/** The stored choice, or null when none is stored (or storage is unreadable). */
export function readFixCliPref(): BridgeCli | null {
  try {
    const raw = localStorage.getItem(FIX_CLI_PREF_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const cli: unknown = (parsed as Record<string, unknown>)['cli']
    return BRIDGE_CLIS.find((c) => c === cli) ?? null
  } catch {
    return null
  }
}

/** Persist the choice. `null` clears it back to the ranking's default. */
export function writeFixCliPref(cli: BridgeCli | null): void {
  try {
    if (cli === null) localStorage.removeItem(FIX_CLI_PREF_KEY)
    else localStorage.setItem(FIX_CLI_PREF_KEY, JSON.stringify({ cli }))
  } catch {
    // Storage denied (private window, blocked site data). The choice still
    // drives this session from the panel's own state.
  }
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

  const cli = preferredFixCli(snapshot.clis, snapshot.preferredCli ?? null)
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
      preferredCli: readFixCliPref(),
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

// ---------------------------------------------------------------------------
// Skips worth sending again — and the ones that are answers
// ---------------------------------------------------------------------------

/**
 * A SKIP IS NOT ONE THING, and #280 was right to refuse to sweep them all into
 * the "still open" button. They split cleanly on a single question: did the
 * finding get a real answer?
 *
 *   refused        — YES. The agent read the finding and disagreed. That is the
 *                    thing it was asked to do when a finding is wrong; sending
 *                    it again asks the same question of the same reader.
 *   no-change      — YES, of a sort. It reported a fix and produced nothing.
 *                    Whatever that is, another turn produces it again.
 *   forbidden-path — YES, structurally. The finding points outside the
 *                    repository and will point outside it next time too.
 *   agent-failed   — NO. The CLI fell over.
 *   timeout        — NO. It was stopped mid-thought.
 *   budget         — NO. It never got a turn at all.
 *
 * Only the second group is worth a retry, and it gets its OWN action with its
 * OWN count rather than being folded into the verification's "still open".
 */
export function skipIsRetryable(reason: BridgeFixSkip['reason']): boolean {
  return reason === 'agent-failed' || reason === 'timeout' || reason === 'budget'
}

/** The skips that never got a real answer, in the order they came back. */
export function retryableSkips(skips: readonly BridgeFixSkip[]): BridgeFixSkip[] {
  return skips.filter((s) => skipIsRetryable(s.reason))
}

/** The sentence beside the retry action. Names WHY they are not refusals. */
export function describeRetryableSkips(count: number): string {
  return count === 1
    ? 'One finding never got a real answer — the agent failed, ran out of time, or never got a turn. That is not a refusal, so it is worth sending again.'
    : `${count} findings never got a real answer — the agent failed, ran out of time, or never got a turn. Those are not refusals, so they are worth sending again.`
}

// ---------------------------------------------------------------------------
// The bounded loop
// ---------------------------------------------------------------------------

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE STOP CONDITION IS A BUDGET, NOT A PROMISE.
 *
 * #280 deliberately shipped ONE verification round and a button the user
 * clicked themselves, because looping on reviewer judgment terminates on an
 * oracle that does not hold still: this repo's own eval scored the same defect
 * 1/3, 3/3, 2/3 and 1/3 across runs on identical code. A quiet round is a
 * SAMPLE, not a fixed point, and "loop until no findings" would be a promise
 * the measurement says cannot be kept.
 *
 * So the loop exists, and it is bounded by things that are actually knowable:
 * how many rounds, how much spend, whether anything was produced, and whether
 * it is repeating itself. It stops on whichever of those comes first and SAYS
 * WHICH — in the same plain register `describeFixStop` uses for the bridge's
 * own inner loop.
 *
 * What it never says: fixed, resolved, done, clean, or anything with a green
 * check on it. Five quiet rounds are still five samples nobody has read.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** How many outer rounds, at most. Small on purpose: see the block above. */
export const FIX_LOOP_ROUND_CAP = 3

/**
 * The spend ceiling, in verification model calls across the WHOLE loop.
 *
 * This is the token/cost budget in the only currency this app actually spends
 * and can count. The fix itself runs on the user's CLI subscription and the
 * bridge reports no token counts, so pretending to meter it would be inventing
 * a number; the re-read is ours, it is metered, and it is what makes another
 * round cost anything here at all.
 */
export const FIX_LOOP_VERIFY_CALL_BUDGET = 24

/** The wall-clock ceiling for the whole loop. A fix round is minutes long. */
export const FIX_LOOP_WALL_BUDGET_MS = 20 * 60_000

export interface FixLoopBudget {
  /** Outer rounds, at most. */
  maxRounds: number
  /** Verification model calls across the whole loop, at most. */
  maxVerifyCalls: number
  /** Wall clock for the whole loop, ms. */
  maxWallMs: number
}

export const DEFAULT_FIX_LOOP_BUDGET: FixLoopBudget = {
  maxRounds: FIX_LOOP_ROUND_CAP,
  maxVerifyCalls: FIX_LOOP_VERIFY_CALL_BUDGET,
  maxWallMs: FIX_LOOP_WALL_BUDGET_MS,
}

/**
 * Why the OUTER loop stopped. Every value is a different thing to tell the
 * user, and none of them means "it is fixed".
 */
export type FixLoopStopReason =
  | 'quiet'
  | 'no-new-commit'
  | 'repeat-outcome'
  | 'round-cap'
  | 'budget-spent'
  | 'stopped-by-user'
  | 'run-failed'

/** What one completed outer round did. Recorded, never reconstructed. */
export interface FixLoopRound {
  /** 1-based. */
  round: number
  /** Finding ids sent this round. */
  sent: readonly string[]
  /** Commit shas the agent handed back this round. */
  commits: readonly string[]
  /** Finding ids the re-read left open after this round. */
  stillOpen: readonly string[]
  /** Verification model calls this round spent. */
  verifyCalls: number
}

/** Everything the stop rule may look at. Injected, so the rule stays pure. */
export interface FixLoopProgress {
  rounds: readonly FixLoopRound[]
  /** Wall clock since the loop started, ms. */
  elapsedMs: number
  /** The user pressed stop. */
  interrupted: boolean
  /** The last dispatch failed outright (the transport, not a per-finding skip). */
  failed: boolean
}

/**
 * Two rounds "repeat" when they leave EXACTLY the same findings open.
 *
 * Not the commits: an agent that rewrites the same file differently every turn
 * and leaves the same complaints standing is oscillating, and comparing shas
 * would let it do that forever.
 */
function outcomeSignature(round: FixLoopRound): string {
  return [...round.stillOpen].sort().join(',')
}

/**
 * Should another round run? `null` means yes; anything else is why not.
 *
 * THE ORDER IS THE CONTRACT, because more than one condition can hold at the
 * same moment and the user gets told one sentence. It runs most-specific
 * first, and a stop the user or the transport caused outranks everything:
 *
 *   1. run-failed      — a round could not run at all. Nothing else applies.
 *   2. stopped-by-user — they asked. Never overridden by a budget.
 *   3. quiet           — nothing is still open, so there is nothing to send.
 *   4. no-new-commit   — the round produced nothing; another asks for the same.
 *   5. repeat-outcome  — the round left what the previous one left.
 *   6. round-cap       — the configured number of rounds is used up.
 *   7. budget-spent    — the call budget or the wall clock is used up.
 *
 * 6 before 7 because the round cap is the limit the user chose and can see
 * counting down, and saying "out of rounds" when a round was in fact available
 * would be wrong; when both are spent the cap is the one they set.
 */
export function decideFixLoopStop(
  progress: FixLoopProgress,
  budget: FixLoopBudget = DEFAULT_FIX_LOOP_BUDGET,
): FixLoopStopReason | null {
  if (progress.failed) return 'run-failed'
  if (progress.interrupted) return 'stopped-by-user'

  const rounds = progress.rounds
  const last = rounds[rounds.length - 1]
  if (last === undefined) return null

  if (last.stillOpen.length === 0) return 'quiet'
  if (last.commits.length === 0) return 'no-new-commit'

  const prev = rounds[rounds.length - 2]
  if (prev !== undefined && outcomeSignature(prev) === outcomeSignature(last)) return 'repeat-outcome'

  if (rounds.length >= budget.maxRounds) return 'round-cap'

  const spent = rounds.reduce((n, r) => n + r.verifyCalls, 0)
  if (spent >= budget.maxVerifyCalls || progress.elapsedMs >= budget.maxWallMs) return 'budget-spent'

  return null
}

/**
 * One sentence for why the loop stopped — `describeFixStop`'s register, for the
 * outer loop. Reports what happened and what it does NOT mean.
 */
export function describeFixLoopStop(
  reason: FixLoopStopReason,
  rounds: number,
  stillOpen: number,
): string {
  const turns = `${rounds} ${rounds === 1 ? 'round' : 'rounds'}`
  const open = `${stillOpen} ${stillOpen === 1 ? 'finding' : 'findings'}`
  switch (reason) {
    case 'quiet':
      return `Stopped after ${turns}: the last re-read left nothing still open. A quiet round is one sample of a reviewer's judgment, not a verdict on the code.`
    case 'no-new-commit':
      return `Stopped after ${turns}: a round produced no commit at all, so another turn would ask the same agent the same question for the same nothing. ${open} still open.`
    case 'repeat-outcome':
      return `Stopped after ${turns}: a round left exactly the findings the one before it left. It was repeating itself rather than converging. ${open} still open.`
    case 'round-cap':
      return `Stopped at the ${rounds}-round cap with ${open} still open. The cap is a budget this loop spends, not a judgment that the rest cannot be fixed.`
    case 'budget-spent':
      return `Stopped after ${turns}: this loop's budget for re-read calls and wall clock is spent, with ${open} still open. What landed is below; the rest were not attempted.`
    case 'stopped-by-user':
      return `You stopped this after ${turns}. Everything the agent had already committed is below and stays on the scratch branch — nothing was thrown away.`
    case 'run-failed':
      return `Stopped after ${turns}: a round could not run. The reason is above; whatever earlier rounds committed is still below.`
  }
}

/**
 * THE INNER LOOP'S VERDICT SURVIVES THE OUTER ONE.
 *
 * `round-cap` from bridge/src/fix.ts means the commit came back with the tests
 * RED. `no-progress` and `repeat-diff` mean the agent was stuck or oscillating
 * on that finding. Those are facts about a commit, and running four more outer
 * rounds over OTHER findings does not touch them — a red commit is still red
 * after five rounds.
 *
 * So the loop counts them and the panel states them, next to the stop sentence,
 * for as long as the commit is on screen. `stopReasonOutranksVerification` is
 * the same predicate the per-change re-read uses (src/lib/ai/fixVerify.ts), so
 * there is exactly one definition of "the re-read may not soften this".
 */
export function unsoftenedChanges(changes: readonly BridgeFixChange[]): BridgeFixChange[] {
  return changes.filter((c) => stopReasonOutranksVerification(c.stopReason))
}

/** The banner over a loop that produced commits the re-read may not soften. */
export function describeUnsoftenedChanges(count: number): string | null {
  if (count <= 0) return null
  return count === 1
    ? 'One commit below came back at the agent’s own round cap, stuck, or oscillating. More rounds of re-reading do not change that; read that commit before you take it.'
    : `${count} commits below came back at the agent’s own round cap, stuck, or oscillating. More rounds of re-reading do not change that; read them before you take them.`
}

/**
 * THE LINE THE PANEL MUST NEVER LET A QUIET LOOP ERASE.
 *
 * This whole surface is step 3 of the user's own workflow — a debris-clearing
 * pass that runs BEFORE they read the code at step 4. A loop that ran five
 * rounds and went quiet has cleared debris. It has not reviewed anything.
 */
export const FIX_LOOP_NOT_REVIEWED =
  'No person has read any of this yet. This loop clears debris before your own review; it does not replace it.'
