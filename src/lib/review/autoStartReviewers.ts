/**
 * Pure gating predicate for the early skill-reviewer auto-start (opt-out).
 *
 * Review.svelte's auto-start $effect calls this once per loaded PR, REGARDLESS
 * of the current step, so the reviewers kick off while the user is still on the
 * Understand step. Extracted as a pure function so the gating can be unit-tested
 * without mounting the heavy Review component.
 *
 * Returns true ONLY when every condition holds:
 *   - the auto-run setting is on (opt-out, default true)
 *   - the AI run exists and the PR load is ready
 *   - the active provider has a key
 *   - the 'skills' task mode is not 'off'
 *   - at least one reviewer skill is enabled
 *   - reviewers have NOT already been auto-started for this PR identity
 *
 * The caller owns the one-shot guard: it passes the PR identity it last started
 * for (`alreadyStartedFor`) and the current identity (`prId`); a mismatch (incl.
 * a fresh null guard) lets a new PR auto-start, while a match blocks re-triggers
 * on step navigation / re-renders.
 */
export function shouldAutoStartReviewers(args: {
  autoRunReviewers: boolean
  aiRunReady: boolean
  loadReady: boolean
  hasKey: boolean
  skillsMode: string
  enabledSkillCount: number
  alreadyStartedFor: string | null
  prId: string
}): boolean {
  return (
    args.autoRunReviewers &&
    args.aiRunReady &&
    args.loadReady &&
    args.hasKey &&
    args.skillsMode !== 'off' &&
    args.enabledSkillCount > 0 &&
    args.alreadyStartedFor !== args.prId
  )
}
