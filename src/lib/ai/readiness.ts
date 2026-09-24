/**
 * src/lib/ai/readiness.ts — THE READINESS BASIS.
 *
 * The workflow this serves has a step 3 that reads "pass over the review skills
 * until they are satisfied and grade the code as production ready", a step 4
 * that is the human reading the code, and a step 8 that is the team's review.
 * Until now the app produced findings and nothing else, so the only signal a
 * user had at step 3 was the ABSENCE OF COMPLAINTS — which is precisely the
 * signal this repo has measured to be unreliable. `eval/BASELINE.md` scored the
 * same real defect `1/3`, `3/3`, `2/3` and `1/3` across four runs on identical
 * code (Measurement 3, "why the carve-out did not fire"). Silence is not
 * evidence.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ONE RULE: NO MODEL PRODUCES THIS GRADE.
 *
 * A model-written letter grade is one more opinion carrying exactly the same
 * variance as the findings it claims to summarise, dressed up as a conclusion.
 * So this module adds no prompt, no task, no PROMPT_VERSIONS entry and no
 * network call. It is a pure function over facts the app ALREADY HOLDS:
 *
 *   which reviewers ran, out of how many are configured, and which did not;
 *   whether cross-model verification could vote at all, or one model did both
 *     jobs (crossVerify.ts's degenerate-poll arithmetic);
 *   the findings, by tier and by verification agreement (findingRank.ts);
 *   whether a real test run happened and passed;
 *   how much of the diff was actually put in front of a reviewer;
 *   whether the code was read from a checkout at the PR head or from an API;
 *   whether a human explicitly approved the implementation, and against which
 *     commit.
 *
 * Every one of those is NAMED, COUNTED and RENDERED next to the grade, because
 * a grade nobody can audit is worth less than no grade at all. The reader is
 * meant to be able to disagree with it — including with the weights, which is
 * why they are exported constants with a stated rationale rather than magic
 * numbers buried in a switch.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SECOND RULE: SAY WHAT IT DID NOT CHECK.
 *
 * `READINESS_DISCLAIMER` plus the computed `notChecked` list are not
 * boilerplate; they are half the feature. "Production ready" is a claim about a
 * SYSTEM. This only ever saw a diff. The vocabulary is chosen so the output can
 * only be read as a statement about how much CHECKING happened — "Barely
 * checked", never "D−" — because a letter has a schoolroom finality that facts
 * about a diff cannot support, and because a letter invites a reader to skip
 * step 4. The user grades readiness. This reports the basis.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * REPRODUCIBILITY.
 *
 * Same facts in, same report out, every time: no `Date.now()`, no `Math.random`,
 * no locale-sensitive comparison, no floating-point banding (the band is decided
 * by integer cross-multiplication, not by a rounded percentage). Pinned by
 * `readiness.test.ts`.
 */

import type { FindingVerification } from './schemas'
import {
  findingTier,
  isMajorityVerified,
  isUnanimouslyBacked,
  raiserCount,
  rankFindings,
  verificationRan,
  type RankableFinding,
} from './findingRank'
import { verifierVotesCanDemote } from './crossVerify'
// TYPE-ONLY: erased at build, so this module stays pure and framework-free at
// runtime even though the phase store it names is a runes module (the triage.ts
// idiom).
import type { ReviewPhase } from '../guide/phase.svelte'

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * How much of a basis this review pass established. Deliberately NOT a letter:
 * `A`/`F` carry a finality that facts about a diff cannot support, and a letter
 * grade on code invites the reader to stop reading. Every label below is a
 * statement about the ACT of checking, not about the artifact — "Barely
 * checked" can only be read as a deficiency of process, which is exactly what
 * it is.
 */
export type ReadinessBand = 'broad' | 'partial' | 'thin' | 'minimal' | 'none'

/** The words shown. One per band, and the only place they are spelled. */
export const READINESS_BAND_LABEL: Record<ReadinessBand, string> = {
  broad: 'Broadly checked',
  partial: 'Partly checked',
  thin: 'Thinly checked',
  minimal: 'Barely checked',
  none: 'Not checked',
}

/**
 * THE DISCLAIMER, stated once, in full, and never softened.
 *
 * It follows the register `fixVerify.ts` set for weak evidence
 * (`FIX_VERIFY_EVIDENCE_CAVEAT`): name the limit concretely instead of
 * hand-waving at "AI can be wrong". The case-specific half — which reviewers
 * did not run, whether a human has signed anything off — is computed per review
 * into `ReadinessReport.notChecked` and rendered alongside this.
 */
export const READINESS_DISCLAIMER =
  'Nothing here ran the code. No runtime behaviour was observed, no integration, migration or deploy was exercised, and nothing outside this diff was read except where a reviewer went looking. “Production ready” is a claim about a system; this pass only ever saw a diff, so it cannot make that claim and neither can a reader who has only read this. The grade above measures how much checking happened — not whether the change is safe to ship.'

// ---------------------------------------------------------------------------
// The checks, and what each is worth
// ---------------------------------------------------------------------------

/** The seven facts the grade is computed from. Order is the display order. */
export type ReadinessCheckId =
  | 'reviewers'
  | 'verification'
  | 'findings'
  | 'tests'
  | 'coverage'
  | 'grounding'
  | 'approval'

export const READINESS_CHECK_IDS: readonly ReadinessCheckId[] = [
  'reviewers',
  'verification',
  'findings',
  'tests',
  'coverage',
  'grounding',
  'approval',
]

/** Every check scores 0, 1 or 2 — met, partly met, unmet. */
export const CHECK_MAX_POINTS = 2

/**
 * What each check is worth, and why. These are the numbers a reader is most
 * likely to want to argue with, so they are here, named, rather than inlined.
 *
 *   tests (3)      — the ONLY input that involves the code being executed. A
 *                    pass where nothing ran must not be able to reach the top
 *                    band on reviewer opinion alone, and this weight is what
 *                    makes that arithmetically true (see the test that pins it).
 *   reviewers (2)  — the breadth of the panel. Phase scope (#275) means a
 *                    tests-phase pass can run three reviewers out of eleven;
 *                    a grade that hid that would be lying by omission.
 *   verification (2) — whether anything could have disagreed. A single-model
 *                    panel's "agreement" is not agreement.
 *   findings (2)   — what is still standing, by tier.
 *   coverage (2)   — how much of the diff was actually put in front of anyone.
 *   approval (2)   — the only HUMAN signal in the whole computation.
 *   grounding (1)  — half a step, because reading from the provider API is the
 *                    ordinary, supported configuration rather than a defect;
 *                    reading a real checkout at the PR head is simply better
 *                    evidence, and a grade that ignored the difference would
 *                    flatter the common case.
 */
export const READINESS_CHECK_WEIGHT: Record<ReadinessCheckId, number> = {
  reviewers: 2,
  verification: 2,
  findings: 2,
  tests: 3,
  coverage: 2,
  grounding: 1,
  approval: 2,
}

/** Total achievable score — every check met, at its weight. */
export const READINESS_MAX_SCORE = READINESS_CHECK_IDS.reduce(
  (sum, id) => sum + READINESS_CHECK_WEIGHT[id] * CHECK_MAX_POINTS,
  0,
)

/**
 * Band floors, as PERCENTAGES of `READINESS_MAX_SCORE`, strongest first.
 * Compared by integer cross-multiplication so no rounding decides a band.
 *
 * `broad` sits at 80 deliberately: with `tests` weighted 3, a review where
 * nothing executed the code tops out at 25/28 = 89%… and then also has to have
 * every other check met, which no real single-model run does. The pinned test
 * `a pass with no test run cannot reach the top band` states the intent
 * directly rather than trusting this comment.
 */
export const READINESS_BAND_FLOORS: readonly { band: ReadinessBand; minPercent: number }[] = [
  { band: 'broad', minPercent: 80 },
  { band: 'partial', minPercent: 60 },
  { band: 'thin', minPercent: 35 },
  { band: 'minimal', minPercent: 1 },
  { band: 'none', minPercent: 0 },
]

/** A reviewer panel counts as fully run when this share of the configured set ran. */
export const REVIEWERS_MET_SHARE = 0.8

/** Diff coverage counts as met at this share of changed files, partial at the next. */
export const COVERAGE_MET_SHARE = 0.9
export const COVERAGE_PARTIAL_SHARE = 0.5

/** How many names a `notChecked` sentence spells before it says "and N more". */
export const NOT_CHECKED_NAME_LIMIT = 8

// ---------------------------------------------------------------------------
// Facts — the input, all of it stated, none of it inferred by a model
// ---------------------------------------------------------------------------

/** What actually happened to the tests, as opposed to what a model thinks of them. */
export type ReadinessTestStatus = 'passed' | 'failed' | 'skipped' | 'not-run'

export interface ReadinessTestFact {
  status: ReadinessTestStatus
  /** The command that ran, when one did. Shown verbatim; never invented. */
  command?: string
  /** Why it was skipped / how it failed, in the runner's own words. */
  detail?: string
}

export interface ReadinessReviewerFact {
  /** Reviewer names that returned a result in this review, in run order. */
  ran: readonly string[]
  /** Every reviewer configured to run in AT LEAST ONE phase. The denominator. */
  configured: readonly string[]
  /** Configured reviewers with no result here — scoped out, errored, or never dispatched. */
  didNotRun: readonly string[]
  /** The subset of `didNotRun` that ran and failed. */
  errored: readonly string[]
}

export interface ReadinessVerificationFact {
  /** Verifier models the panel resolves to. 0 = one model did both jobs. */
  configuredVerifiers: number
  /** Verification polls actually held (findings carrying a real poll). */
  pollsHeld: number
  /**
   * Polls whose verifiers could have changed the outcome at all
   * (`verifierVotesCanDemote`). A poll where they could not is decorative:
   * with one raiser and one verifier `score >= polled / 2` holds however the
   * verifier votes, so its "agreement" corroborates nothing.
   */
  pollsThatCouldDemote: number
}

export interface ReadinessFindingFact {
  total: number
  /** Inline tier after `rankFindings` — the findings a reader is shown first. */
  primary: number
  /** Collapsed tier. */
  secondary: number
  /** Primary-tier findings at high severity. */
  highPrimary: number
  /** Confirmed unanimously, on both axes, by a panel that could have disagreed. */
  unanimouslyBacked: number
  /** Majority-verified on the reality axis. */
  majorityVerified: number
  /** Findings no poll ever looked at. */
  neverVerified: number
}

export interface ReadinessCoverageFact {
  changedFiles: number
  /** Changed files put in front of at least one reviewer in this pass. */
  reviewedFiles: number
  /** The rest, by path — phase-scoped out, budget-trimmed, or binary. */
  notSent: readonly string[]
}

export interface ReadinessGroundingFact {
  /** True when the models read a checkout sitting at this PR's head. */
  local: boolean
  /** Local, but the tree has uncommitted changes. */
  dirty: boolean
  /** `describeGrounding`'s sentence, passed through verbatim. */
  description: string
}

export interface ReadinessApprovalFact {
  approved: boolean
  /** Approved, but commits landed since — the sign-off covers older code. */
  stale: boolean
  phase: ReviewPhase
  /** The head the approval was recorded against, when known. */
  approvedAtSha?: string
}

/** Everything the grade is computed from. Nothing else may enter the arithmetic. */
export interface ReadinessFacts {
  reviewers: ReadinessReviewerFact
  verification: ReadinessVerificationFact
  findings: ReadinessFindingFact
  tests: ReadinessTestFact
  coverage: ReadinessCoverageFact
  grounding: ReadinessGroundingFact
  approval: ReadinessApprovalFact
}

// ---------------------------------------------------------------------------
// Report — the output
// ---------------------------------------------------------------------------

export type ReadinessCheckState = 'met' | 'partial' | 'unmet'

export interface ReadinessCheck {
  id: ReadinessCheckId
  /** Short row label. */
  label: string
  points: number
  max: number
  weight: number
  state: ReadinessCheckState
  /** The counted fact, in words. Always names numbers. */
  detail: string
  /** Present when the check is not met: the short phrase the headline uses. */
  shortfall?: string
}

export interface ReadinessReport {
  band: ReadinessBand
  /** `READINESS_BAND_LABEL[band]`, carried so callers need not re-look-it-up. */
  label: string
  score: number
  max: number
  /** Rounded, for display only — the band is decided on the exact ratio. */
  percent: number
  checks: ReadinessCheck[]
  /**
   * WHY the band is what it is — the weakest links, named, without the label
   * in front of it. Carried separately so a UI can typeset the band and the
   * reason differently without slicing the sentence back apart.
   */
  reason: string
  /** `label` + `reason`, for callers that want the whole sentence. */
  headline: string
  /** The case-specific half of the disclaimer: what THIS pass did not check. */
  notChecked: string[]
}

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

/** "a, b and c" — deterministic, no locale rules. */
function andList(items: readonly string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** Name up to NOT_CHECKED_NAME_LIMIT items, then say how many are left. */
function nameSome(items: readonly string[]): string {
  if (items.length <= NOT_CHECKED_NAME_LIMIT) return andList(items)
  const shown = items.slice(0, NOT_CHECKED_NAME_LIMIT)
  return `${shown.join(', ')} and ${items.length - NOT_CHECKED_NAME_LIMIT} more`
}

function stateOf(points: number): ReadinessCheckState {
  if (points >= CHECK_MAX_POINTS) return 'met'
  return points > 0 ? 'partial' : 'unmet'
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

function reviewersCheck(f: ReadinessReviewerFact): Omit<ReadinessCheck, 'id' | 'max' | 'weight' | 'state'> {
  const ran = f.ran.length
  const configured = f.configured.length
  const detail =
    configured === 0
      ? 'No reviewer is configured. Nothing was asked to look at this.'
      : `${ran} of ${configured} configured ${plural(configured, 'reviewer', 'reviewers')} produced a result${
          f.errored.length > 0 ? `; ${f.errored.length} failed` : ''
        }.`

  if (configured === 0 || ran === 0) {
    return { label: 'Reviewers', points: 0, detail, shortfall: 'no reviewer produced a result' }
  }
  if (ran >= configured * REVIEWERS_MET_SHARE) {
    return { label: 'Reviewers', points: 2, detail }
  }
  return {
    label: 'Reviewers',
    points: 1,
    detail,
    shortfall: `${configured - ran} of ${configured} ${plural(configured - ran, 'reviewer', 'reviewers')} did not run`,
  }
}

function verificationCheck(
  f: ReadinessVerificationFact,
): Omit<ReadinessCheck, 'id' | 'max' | 'weight' | 'state'> {
  // No poll was ever held: fall back to what the panel is CONFIGURED to do,
  // which is the same arithmetic one step earlier.
  if (f.pollsHeld === 0) {
    if (f.configuredVerifiers === 0) {
      return {
        label: 'Cross-model verification',
        points: 0,
        detail: 'One model did both jobs — no second model was configured to check its work.',
        shortfall: 'nothing could disagree with the model that looked',
      }
    }
    if (!verifierVotesCanDemote(1, f.configuredVerifiers)) {
      return {
        label: 'Cross-model verification',
        points: 1,
        detail: `${f.configuredVerifiers} verifier configured, which cannot change any outcome: one raiser against one verifier surfaces the finding however the verifier votes.`,
        shortfall: 'the single verifier could not have changed any outcome',
      }
    }
    return {
      label: 'Cross-model verification',
      points: 2,
      detail: `${f.configuredVerifiers} verifiers configured — enough for a poll that can go either way. No finding needed one.`,
    }
  }

  const held = f.pollsHeld
  const live = f.pollsThatCouldDemote
  if (live === 0) {
    return {
      label: 'Cross-model verification',
      points: 1,
      detail: `${held} ${plural(held, 'poll was', 'polls were')} held and none of them could change an outcome: with as many raisers as verifiers a finding surfaces however the verifiers vote.`,
      shortfall: 'every verification poll was decorative',
    }
  }
  if (live < held) {
    return {
      label: 'Cross-model verification',
      points: 1,
      detail: `${live} of ${held} verification polls could have gone the other way; the rest were decorative (verifiers could not outvote the raisers).`,
      shortfall: `${held - live} of ${held} verification polls could not have changed anything`,
    }
  }
  return {
    label: 'Cross-model verification',
    points: 2,
    detail: `${held} verification ${plural(held, 'poll', 'polls')} held, all of them able to go either way.`,
  }
}

function findingsCheck(
  f: ReadinessFindingFact,
  anyReviewerRan: boolean,
): Omit<ReadinessCheck, 'id' | 'max' | 'weight' | 'state'> {
  if (!anyReviewerRan) {
    return {
      label: 'Findings standing',
      points: 0,
      detail: 'No reviewer produced a result, so "no findings" is not evidence of anything.',
      shortfall: 'nothing looked, so the silence means nothing',
    }
  }

  const evidence =
    f.total === 0
      ? 'No reviewer raised anything.'
      : `${f.total} ${plural(f.total, 'finding', 'findings')}: ${f.primary} shown first, ${f.secondary} collapsed. ${f.unanimouslyBacked} backed unanimously by a panel that could have disagreed, ${f.majorityVerified} majority-verified, ${f.neverVerified} never verified by anyone.`

  if (f.highPrimary > 0) {
    return {
      label: 'Findings standing',
      points: 0,
      detail: evidence,
      shortfall: `${f.highPrimary} high-severity ${plural(f.highPrimary, 'finding is', 'findings are')} still standing`,
    }
  }
  if (f.primary > 0) {
    return {
      label: 'Findings standing',
      points: 1,
      detail: evidence,
      shortfall: `${f.primary} ${plural(f.primary, 'finding is', 'findings are')} still standing`,
    }
  }
  return { label: 'Findings standing', points: 2, detail: evidence }
}

function testsCheck(f: ReadinessTestFact): Omit<ReadinessCheck, 'id' | 'max' | 'weight' | 'state'> {
  const where = f.command ? ` (${f.command})` : ''
  switch (f.status) {
    case 'passed':
      return { label: 'Tests', points: 2, detail: `A test run${where} passed on this code.` }
    case 'failed':
      return {
        label: 'Tests',
        points: 0,
        detail: `A test run${where} FAILED on this code.${f.detail ? ` ${f.detail}` : ''}`,
        shortfall: 'the recorded test run failed',
      }
    case 'skipped':
      return {
        label: 'Tests',
        points: 0,
        detail: `Tests were skipped.${f.detail ? ` ${f.detail}` : ''}`,
        shortfall: 'the tests were skipped',
      }
    case 'not-run':
      return {
        label: 'Tests',
        points: 0,
        detail: 'No test run is recorded for this change. Nothing here executed the code.',
        shortfall: 'no test run is recorded',
      }
  }
}

function coverageCheck(
  f: ReadinessCoverageFact,
): Omit<ReadinessCheck, 'id' | 'max' | 'weight' | 'state'> {
  if (f.changedFiles === 0) {
    return { label: 'Diff covered', points: 0, detail: 'No changed files were loaded.', shortfall: 'no diff was read' }
  }
  const missed = f.changedFiles - f.reviewedFiles
  const detail = `${f.reviewedFiles} of ${f.changedFiles} changed ${plural(f.changedFiles, 'file was', 'files were')} put in front of a reviewer${
    missed > 0 ? `; ${missed} ${plural(missed, 'was', 'were')} not` : ''
  }.`
  if (f.reviewedFiles >= f.changedFiles * COVERAGE_MET_SHARE) {
    return { label: 'Diff covered', points: 2, detail }
  }
  if (f.reviewedFiles >= f.changedFiles * COVERAGE_PARTIAL_SHARE) {
    return {
      label: 'Diff covered',
      points: 1,
      detail,
      shortfall: `${missed} of ${f.changedFiles} changed files were never reviewed`,
    }
  }
  return {
    label: 'Diff covered',
    points: 0,
    detail,
    shortfall: `${missed} of ${f.changedFiles} changed files were never reviewed`,
  }
}

function groundingCheck(
  f: ReadinessGroundingFact,
): Omit<ReadinessCheck, 'id' | 'max' | 'weight' | 'state'> {
  if (f.local && !f.dirty) {
    return { label: 'Code read from', points: 2, detail: f.description }
  }
  if (f.local) {
    return {
      label: 'Code read from',
      points: 1,
      detail: f.description,
      shortfall: 'the checkout that was read has uncommitted changes',
    }
  }
  return {
    label: 'Code read from',
    points: 1,
    detail: f.description,
    shortfall: 'no checkout at this PR’s head was read',
  }
}

function approvalCheck(
  f: ReadinessApprovalFact,
): Omit<ReadinessCheck, 'id' | 'max' | 'weight' | 'state'> {
  if (!f.approved) {
    return {
      label: 'Human sign-off',
      points: 0,
      detail: `Nobody has approved the implementation here; the review is in the ${f.phase} phase.`,
      shortfall: 'no human has signed the implementation off',
    }
  }
  if (f.stale) {
    return {
      label: 'Human sign-off',
      points: 1,
      detail: `The implementation was approved against ${f.approvedAtSha ? shortSha(f.approvedAtSha) : 'an earlier commit'}, and commits have landed since.`,
      shortfall: 'the implementation sign-off is for older code',
    }
  }
  return {
    label: 'Human sign-off',
    points: 2,
    detail: `You approved the implementation${f.approvedAtSha ? ` at ${shortSha(f.approvedAtSha)}` : ''}.`,
  }
}

/** First 7 characters of a sha, the way every git UI shows one. */
function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

// ---------------------------------------------------------------------------
// gradeReadiness — the whole computation
// ---------------------------------------------------------------------------

/** Decide the band by integer cross-multiplication: no rounding picks a band. */
export function bandFor(score: number, max: number): ReadinessBand {
  if (max <= 0 || score <= 0) return 'none'
  for (const floor of READINESS_BAND_FLOORS) {
    if (score * 100 >= floor.minPercent * max) return floor.band
  }
  return 'none'
}

/**
 * Compute the readiness basis from stated facts. Pure, total and reproducible:
 * the same facts always produce the same report, down to the sentences.
 */
export function gradeReadiness(facts: ReadinessFacts): ReadinessReport {
  const anyReviewerRan = facts.reviewers.ran.length > 0

  const raw: Record<ReadinessCheckId, Omit<ReadinessCheck, 'id' | 'max' | 'weight' | 'state'>> = {
    reviewers: reviewersCheck(facts.reviewers),
    verification: verificationCheck(facts.verification),
    findings: findingsCheck(facts.findings, anyReviewerRan),
    tests: testsCheck(facts.tests),
    coverage: coverageCheck(facts.coverage),
    grounding: groundingCheck(facts.grounding),
    approval: approvalCheck(facts.approval),
  }

  const checks: ReadinessCheck[] = READINESS_CHECK_IDS.map((id) => {
    const weight = READINESS_CHECK_WEIGHT[id]
    const base = raw[id]
    return {
      id,
      label: base.label,
      points: base.points,
      max: CHECK_MAX_POINTS,
      weight,
      state: stateOf(base.points),
      detail: base.detail,
      ...(base.shortfall ? { shortfall: base.shortfall } : {}),
    }
  })

  const score = checks.reduce((sum, c) => sum + c.points * c.weight, 0)
  const max = READINESS_MAX_SCORE
  const band = bandFor(score, max)
  const label = READINESS_BAND_LABEL[band]

  // The headline names the WEAKEST links first (unmet before partial, then by
  // weight, then by display order) so the sentence says why, not just what.
  const shortfalls = checks
    .filter((c) => c.shortfall)
    .sort((a, b) => {
      if (a.state !== b.state) return a.state === 'unmet' ? -1 : 1
      if (a.weight !== b.weight) return b.weight - a.weight
      return READINESS_CHECK_IDS.indexOf(a.id) - READINESS_CHECK_IDS.indexOf(b.id)
    })
    .map((c) => c.shortfall as string)

  const reason =
    shortfalls.length === 0
      ? 'every check this app can make came back positive.'
      : `${andList(shortfalls.slice(0, 3))}.`

  return {
    band,
    label,
    score,
    max,
    percent: Math.round((score * 100) / max),
    checks,
    reason,
    headline: `${label} — ${reason}`,
    notChecked: notCheckedLines(facts),
  }
}

/**
 * The case-specific half of the disclaimer: what THIS pass, with THESE facts,
 * did not check. Deterministic order (the check order), and every line names
 * something concrete — never "results may vary".
 */
export function notCheckedLines(facts: ReadinessFacts): string[] {
  const lines: string[] = []

  if (facts.reviewers.didNotRun.length > 0) {
    const n = facts.reviewers.didNotRun.length
    lines.push(
      `${n} configured ${plural(n, 'reviewer', 'reviewers')} did not run and said nothing about this change: ${nameSome(facts.reviewers.didNotRun)}.`,
    )
  }
  if (facts.reviewers.errored.length > 0) {
    lines.push(
      `${facts.reviewers.errored.length} ${plural(facts.reviewers.errored.length, 'reviewer', 'reviewers')} failed rather than finishing: ${nameSome(facts.reviewers.errored)}.`,
    )
  }
  if (facts.verification.configuredVerifiers === 0 && facts.verification.pollsHeld === 0) {
    lines.push(
      'Only one model looked, and it checked its own work. A single-model panel’s agreement is not agreement.',
    )
  } else if (facts.verification.pollsHeld > facts.verification.pollsThatCouldDemote) {
    lines.push(
      'Some verification polls could not have changed their finding’s fate however the verifiers voted, so their agreement corroborates nothing.',
    )
  }
  if (facts.tests.status !== 'passed') {
    lines.push(
      facts.tests.status === 'failed'
        ? 'The recorded test run failed, and nothing here re-ran it.'
        : 'No passing test run is recorded, so nothing here observed the code actually working.',
    )
  }
  const missed = facts.coverage.changedFiles - facts.coverage.reviewedFiles
  if (missed > 0 && facts.coverage.notSent.length > 0) {
    lines.push(
      `${missed} changed ${plural(missed, 'file was', 'files were')} never put in front of a reviewer: ${nameSome(facts.coverage.notSent)}.`,
    )
  } else if (missed > 0) {
    lines.push(`${missed} changed ${plural(missed, 'file was', 'files were')} never put in front of a reviewer.`)
  }
  if (!facts.grounding.local) {
    lines.push(
      'The code was read from the provider’s API rather than a checkout at this PR’s head, so nothing outside the diff was opened.',
    )
  } else if (facts.grounding.dirty) {
    lines.push(
      'The checkout that was read has uncommitted changes, so a finding may be grounded in code that is in no commit of this PR.',
    )
  }
  if (!facts.approval.approved) {
    lines.push('No human has read and approved this implementation here yet.')
  } else if (facts.approval.stale) {
    lines.push('The human sign-off on record was made against an earlier commit than this one.')
  }

  return lines
}

// ---------------------------------------------------------------------------
// collectReadinessFacts — turn what the app holds into stated facts
// ---------------------------------------------------------------------------

/** One reviewer's outcome, as the run store knows it. */
export interface ReviewerOutcome {
  name: string
  /** True when the reviewer returned a result (however empty). */
  done: boolean
  /** True when it failed instead of finishing. */
  errored: boolean
  /** Its findings, already convergence-merged by the caller when a merge exists. */
  findings: readonly RankableFinding[]
}

export interface ReadinessCollectInput {
  /** Every reviewer entry from BOTH passes, in run order. */
  reviewers: readonly ReviewerOutcome[]
  /** Names of every reviewer configured to run in at least one phase. */
  configuredReviewerNames: readonly string[]
  /** Verifier models the panel resolves to right now. */
  configuredVerifiers: number
  /** Every changed path in the PR. */
  changedFilePaths: readonly string[]
  /** Changed paths no reviewer was given in this pass. */
  filesNotSent: readonly string[]
  grounding: ReadinessGroundingFact
  approval: ReadinessApprovalFact
  tests: ReadinessTestFact
}

/**
 * Count the facts. Pure — every module-level read (which skills exist, which
 * verifiers resolve, where grounding landed, what the phase store says) happens
 * in the caller, so this stays testable without storage, a bridge or a network.
 *
 * The finding counts use the SAME ranking the diff uses (`rankFindings`), so
 * "shown first" in the grade means exactly what "shown first" means on screen.
 */
export function collectReadinessFacts(input: ReadinessCollectInput): ReadinessFacts {
  const ran = input.reviewers.filter((r) => r.done).map((r) => r.name)
  const errored = input.reviewers.filter((r) => r.errored).map((r) => r.name)
  const ranSet = new Set(ran)
  const didNotRun = [
    ...input.configuredReviewerNames.filter((n) => !ranSet.has(n)),
    // A reviewer that errored is not configured-but-silent, it is failed — but
    // it also did not run, and the disclaimer must say so either way.
    ...errored.filter((n) => !input.configuredReviewerNames.includes(n)),
  ]

  const allFindings: RankableFinding[] = []
  for (const r of input.reviewers) {
    if (!r.done) continue
    for (const f of r.findings) allFindings.push(f)
  }

  const lineBearing = allFindings.filter((f) => f.line !== null)
  const ranked = rankFindings(lineBearing)
  const highPrimary = ranked.primary.filter((f) => f.severity === 'high').length
  // File-level findings carry no inline tier; they are counted in the total and
  // tiered by the same rule so the numbers still add up.
  const fileLevel = allFindings.filter((f) => f.line === null)
  const fileLevelPrimary = fileLevel.filter((f) => findingTier(f) === 'primary')

  let pollsHeld = 0
  let pollsThatCouldDemote = 0
  let unanimouslyBacked = 0
  let majorityVerified = 0
  let neverVerified = 0
  for (const f of allFindings) {
    const v: FindingVerification | undefined = f.verification
    if (!verificationRan(v) || !v) {
      neverVerified += 1
      continue
    }
    pollsHeld += 1
    const raisers = raiserCount(v)
    if (verifierVotesCanDemote(raisers, v.polledModels - raisers)) pollsThatCouldDemote += 1
    if (isUnanimouslyBacked(v)) unanimouslyBacked += 1
    if (isMajorityVerified(v)) majorityVerified += 1
  }

  const notSent = [...new Set(input.filesNotSent)].sort()
  const changedFiles = input.changedFilePaths.length
  const changedSet = new Set(input.changedFilePaths)
  const missed = notSent.filter((p) => changedSet.has(p)).length

  return {
    reviewers: {
      ran,
      configured: [...input.configuredReviewerNames],
      didNotRun,
      errored,
    },
    verification: {
      configuredVerifiers: input.configuredVerifiers,
      pollsHeld,
      pollsThatCouldDemote,
    },
    findings: {
      total: allFindings.length,
      primary: ranked.primary.length + fileLevelPrimary.length,
      secondary: ranked.secondary.length + (fileLevel.length - fileLevelPrimary.length),
      highPrimary: highPrimary + fileLevelPrimary.filter((f) => f.severity === 'high').length,
      unanimouslyBacked,
      majorityVerified,
      neverVerified,
    },
    tests: input.tests,
    coverage: {
      changedFiles,
      reviewedFiles: Math.max(0, changedFiles - missed),
      notSent: notSent.filter((p) => changedSet.has(p)),
    },
    grounding: input.grounding,
    approval: input.approval,
  }
}
