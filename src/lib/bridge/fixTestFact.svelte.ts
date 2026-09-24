/**
 * src/lib/bridge/fixTestFact.svelte.ts — the ONE place the app's only real test
 * signal is published, so two surfaces can read the same fact.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The readiness grade (#281) weights its `tests` check highest, on the stated
 * principle that it is the only input where the code was actually EXECUTED — a
 * change must not reach the top band on model output alone. But that check read
 * `not-run` forever, because the only real test outcome this app holds is the
 * bridge fix loop's, and that lived inside AgentFixPanel's component state.
 *
 * So the panel publishes it here and Review.svelte reads it here. This module
 * does no storage, no bridge calls and no grading: it holds one fact, keyed on
 * the commit the review is about, and the rule for deriving it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THE FACT IS, AND WHAT IT IS NOT
 *
 * The bridge runs the repository's test command inside a SCRATCH WORKTREE made
 * from this PR's head, with the agent's proposed fix applied. So a pass here is
 * evidence that a test command ran and came back green on this PR's code plus a
 * change nobody has taken yet — NOT that the PR as it stands is green.
 *
 * That distinction is carried in the `command` string, which is what the grade
 * prints in its parenthetical: "on the agent's fix commit 1a2b3c4". It reads as
 * a scope rather than as a claim about the PR, which is the whole point. (A
 * cleaner home for it would be `ReadinessTestFact.detail`, but `testsCheck`
 * drops `detail` on the `passed` branch; noted rather than worked around.)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * STALE GREEN IS WORSE THAN NO GREEN
 *
 * A test run belongs to the commit it ran against. Two rules enforce that:
 *
 *   1. the fact is DERIVED from the commits the panel is currently holding —
 *      one per finding, latest round wins — so a round-2 commit that replaces a
 *      round-1 commit takes its test outcome with it;
 *   2. it is stored under the PR head it was produced for, and read back only
 *      for that same head. A PR that advanced mid-review reads `not-run` again
 *      rather than inheriting a grade from code that is no longer there.
 *
 * `failed` and `not-run` stay different facts throughout: one says a runner
 * executed the code and it came back red, the other says nothing executed it.
 * Collapsing them would turn a red run into an absence.
 */

import type { BridgeFixChange, BridgeFixTestStatus } from './protocol'

/** Mirrors `ReadinessTestStatus` (src/lib/ai/readiness.ts) without importing it. */
export type FixTestStatus = 'passed' | 'failed' | 'skipped' | 'not-run'

/** Mirrors `ReadinessTestFact`. Structural, so the grade stays unaware of us. */
export interface FixTestFact {
  status: FixTestStatus
  command?: string
  detail?: string
}

/** Nothing executed this code. The honest default, and the reset value. */
export const NO_FIX_TEST_FACT: FixTestFact = { status: 'not-run' }

function short(sha: string): string {
  return sha.slice(0, 7)
}

/**
 * Where a run happened, as a scope rather than a claim.
 *
 * Named commits while there are few enough to name; a count past that. Either
 * way it says "the agent's fix commit", never "this pull request".
 */
function scopeOf(command: string, changes: readonly BridgeFixChange[]): string {
  const where =
    changes.length === 1
      ? `on the agent's fix commit ${short(changes[0]!.commit)}`
      : `across the agent's ${changes.length} fix commits`
  return command === '' ? where : `${command} — ${where}`
}

/**
 * The fact, derived from the commits the panel is holding right now.
 *
 * The order is the contract, and it is deliberately pessimistic — every step
 * that is not an unambiguous green wins over one that is:
 *
 *   1. no commits at all              → not-run
 *   2. any commit's tests FAILED      → failed
 *   3. any run that produced no verdict (timed out, unrunnable, skipped by the
 *      bridge)                        → skipped
 *   4. at least one commit passed and none of the above → passed
 *   5. commits, but no test run at all → not-run
 *
 * 2 before 4 because one red commit among five green ones is a red run, and the
 * grade's job is to report the weakest link rather than the average. 3 before 4
 * for the same reason: a suite that did not finish has no verdict to add.
 */
export function fixTestFactFor(changes: readonly BridgeFixChange[]): FixTestFact {
  if (changes.length === 0) return NO_FIX_TEST_FACT

  const withTests = changes.filter((c) => c.tests !== null)
  const statusOf = (c: BridgeFixChange): BridgeFixTestStatus | null => c.tests?.status ?? null

  const failed = withTests.filter((c) => statusOf(c) === 'failed')
  if (failed.length > 0) {
    const first = failed[0]!
    return {
      status: 'failed',
      command: scopeOf(first.tests?.command ?? '', failed),
      detail:
        failed.length === 1
          ? 'It ran in the bridge’s scratch worktree, on this PR’s head with the agent’s change applied.'
          : `${failed.length} of the agent’s commits came back red in the bridge’s scratch worktree.`,
    }
  }

  const inconclusive = withTests.filter((c) => {
    const s = statusOf(c)
    return s === 'timeout' || s === 'unrunnable' || s === 'skipped'
  })
  if (inconclusive.length > 0) {
    const first = inconclusive[0]!
    const status = statusOf(first)
    return {
      status: 'skipped',
      command: scopeOf(first.tests?.command ?? '', inconclusive),
      detail:
        status === 'timeout'
          ? 'The test command did not finish in time and was stopped, so it reached no verdict.'
          : status === 'unrunnable'
            ? `The bridge found nothing runnable to run.${first.tests?.detail ? ` ${first.tests.detail}` : ''}`
            : `The bridge did not run them.${first.tests?.detail ? ` ${first.tests.detail}` : ''}`,
    }
  }

  const passed = withTests.filter((c) => statusOf(c) === 'passed')
  if (passed.length > 0) {
    return { status: 'passed', command: scopeOf(passed[0]!.tests?.command ?? '', passed) }
  }

  // Commits, but nothing ran. Not a skip the bridge reported — simply no run.
  return NO_FIX_TEST_FACT
}

// ---------------------------------------------------------------------------
// The holder
// ---------------------------------------------------------------------------

/**
 * A BOX, not a bare value: a module-level `$state` union cannot be reassigned
 * from outside the module. Same idiom as `prContext` in runPr.svelte.ts.
 */
const box = $state<{ value: { headSha: string; fact: FixTestFact } | null }>({ value: null })

/**
 * Publish what the fix loop's tests said. `null` clears it.
 *
 * The panel is the only caller. It republishes on every round, so the fact is
 * always the one belonging to the commits currently on screen.
 */
export function noteFixTestFact(headSha: string, fact: FixTestFact | null): void {
  box.value = fact === null ? null : { headSha, fact }
}

/**
 * The fact for `prHead`, or `not-run`.
 *
 * KEYED ON THE HEAD SHA ON PURPOSE, the same way `prCheckoutContext` is: a
 * grade must never be able to count a green run that belongs to the pull
 * request the user was looking at a moment ago.
 */
export function currentFixTestFact(prHead: string): FixTestFact {
  const value = box.value
  if (value === null) return NO_FIX_TEST_FACT
  return value.headSha.toLowerCase() === prHead.toLowerCase() ? value.fact : NO_FIX_TEST_FACT
}

/** FOR TESTS ONLY: forget the published fact. */
export function _resetFixTestFactForTest(): void {
  box.value = null
}
