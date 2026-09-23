/**
 * src/lib/ai/findingRank.ts — deterministic finding triage (Plan: finding-triage).
 *
 * With many reviewer skills enabled a review drowns in findings, most of them
 * weak (failed cross-model verification, low severity, already covered by the
 * user's own draft). The ensemble already HAS the trust data — this module makes
 * the machine USE it: every line-bearing finding is ranked into one of two tiers,
 *
 *   PRIMARY   — renders inline in the diff, exactly as before,
 *   SECONDARY — collapses into a per-file "N more findings" group,
 *
 * so the reviewer reads the strong findings first and opts INTO the rest instead
 * of decoding per-card metadata. Purely deterministic — no LLM, no prompt, no
 * cache-version change. The quantitative philosophy follows `findingWeight`
 * (src/lib/risk/risk.ts): severity × verification quorum, demoted findings count
 * much less; convergence (independent cross-reviewer agreement) ranks UP.
 *
 * Pure ranking + a tiny localStorage persistence helper for the global
 * "Show all" escape hatch (the sortPref.ts idiom).
 */

import type { FindingVerification, AbsorbedFinding } from './schemas'
import { findingWeight } from '../risk/risk'
import { verifierVotesCanDemote } from './crossVerify'

// ---------------------------------------------------------------------------
// Tier rules — named constants with rationale
// ---------------------------------------------------------------------------

/**
 * A finding counts as MAJORITY-VERIFIED when at least half of all polled models
 * cast an explicit CONFIRM (confirmedBy/polledModels ≥ 0.5). This is stricter
 * than crossVerify's surface threshold (which credits `uncertain` votes 0.5):
 * for inline placement we require real agreement, not the absence of dissent —
 * a chorus of "uncertain" should not promote a finding, merely not bury it.
 */
export const MAJORITY_QUORUM = 0.5

/**
 * A finding counts as CONVERGENT when ≥2 DISTINCT reviewers independently
 * described the same underlying issue (the convergence pass merged them:
 * `mergedFrom` carries the absorbed siblings). Independent agreement is a
 * strong signal even without cross-model verification.
 */
export const CONVERGENT_MIN_REVIEWERS = 2

/**
 * Absolute inline budget per review: at most this many PRIMARY findings render
 * inline. Overflow spills the lowest-ranked primaries into the collapsed tier —
 * but NEVER a high-severity finding (highs always render inline, even past the
 * budget). ~8 keeps a big multi-reviewer run readable in one pass.
 */
export const INLINE_PRIMARY_BUDGET = 8

/**
 * Rank-weight bonus per ADDITIONAL converged reviewer (beyond the first), used
 * only for ordering/budget-spill. Scaled to the findingWeight range (severity
 * 1–3 × verification 0.25–1.5): one extra agreeing reviewer is worth about half
 * a severity step, capped so convergence alone can't dwarf severity.
 */
export const CONVERGENCE_WEIGHT_BONUS = 0.5

/** Cap on the total convergence bonus (three or more extra reviewers). */
export const CONVERGENCE_WEIGHT_BONUS_MAX = 1.5

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/** The minimal finding shape ranking needs (subset of SkillFinding + context). */
export interface RankableFinding {
  path: string
  line: number | null
  severity: 'high' | 'medium' | 'low'
  /** Cross-model verification; absent/polled=0 → verification never ran. */
  verification?: FindingVerification
  /** Convergence: absorbed sibling findings (other reviewers). */
  mergedFrom?: AbsorbedFinding[]
  /** Convergence: same point as the user's own draft → always secondary. */
  coveredByDraft?: { path: string; line: number }
  /**
   * The name of the reviewer that produced this finding. Used to count DISTINCT
   * reviewers in a converged cluster (a same-reviewer merge is dedup, not
   * independent agreement). Optional: when absent, every mergedFrom reviewer
   * counts as distinct (upper bound — the common case, since applyConvergence
   * absorbs across reviewers).
   */
  reviewerName?: string
}

export interface RankedFindings<T extends RankableFinding> {
  /** Inline tier, strongest first (deterministic). */
  primary: T[]
  /** Collapsed tier, in file/line order (deterministic). */
  secondary: T[]
}

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

/** True when verification actually ran (a real multi-model poll happened). */
export function verificationRan(v: FindingVerification | undefined): boolean {
  return !!v && v.polledModels > 0
}

/**
 * Majority-verified: verification ran, the engine SURFACED the finding, and at
 * least MAJORITY_QUORUM of the polled models explicitly confirmed. A demoted
 * finding (surfaced=false) is never majority-verified — the engine already
 * decided the votes don't carry it (including the absence-claim floor).
 */
export function isMajorityVerified(v: FindingVerification | undefined): boolean {
  if (!v || v.polledModels <= 0 || !v.surfaced) return false
  return v.confirmedBy / v.polledModels >= MAJORITY_QUORUM
}

/**
 * Number of DISTINCT reviewers that converged on this finding: its own reviewer
 * plus every distinct OTHER reviewer in `mergedFrom`. Without `reviewerName`
 * every absorbed reviewer counts as distinct (upper bound).
 */
export function convergedReviewerCount(f: RankableFinding): number {
  if (!f.mergedFrom || f.mergedFrom.length === 0) return 1
  const others = new Set<string>()
  for (const m of f.mergedFrom) {
    if (f.reviewerName !== undefined && m.reviewer === f.reviewerName) continue
    others.add(m.reviewer)
  }
  return 1 + others.size
}

/** True when ≥ CONVERGENT_MIN_REVIEWERS distinct reviewers flagged this issue. */
export function isConvergent(f: RankableFinding): boolean {
  return convergedReviewerCount(f) >= CONVERGENT_MIN_REVIEWERS
}

/**
 * How many models RAISED this finding, as opposed to verifying it. Both
 * aggregators (`aggregateFinding`, `aggregateMultiRaiser`) stamp `raised: true`
 * on every raiser row of `perModel`.
 *
 * Floor of 1: a verification with no raiser row is either a pre-#250 cached
 * result (Plan M aggregation was always single-raiser) or a test fixture that
 * did not bother to build `perModel`. Assuming ONE raiser is the conservative
 * reading — it is the smallest legal raiser count, and it is what makes the
 * derived verifier count `polled − raisers` an UPPER bound. Over-counting
 * raisers would understate verifiers and wrongly call a live poll degenerate;
 * the floor cannot do that.
 */
export function raiserCount(v: FindingVerification): number {
  const rows = Array.isArray(v.perModel) ? v.perModel : []
  let raised = 0
  for (const m of rows) if (m.raised === true) raised += 1
  return Math.max(1, raised)
}

/**
 * UNANIMOUSLY VERIFIED on the reality axis: verification ran, the engine
 * surfaced the finding, EVERY polled model cast a confirm
 * (`confirmedBy === polledModels`), AND the poll was capable of demoting it in
 * the first place.
 *
 * That last clause is the whole point of reusing `verifierVotesCanDemote`
 * (crossVerify.ts, #253): the surface threshold is `score >= polled / 2`, so
 * with `verifiers <= raisers` a finding surfaces however the verifiers vote and
 * a "unanimous" tally is DECORATIVE — nobody could have disagreed to any
 * effect. Promoting on a decorative poll would be promoting on nothing.
 *
 * Behaviour with one generator, by verifier count:
 *
 *   verifiers | polled | unanimous tally | canDemote(1, V) | unanimously verified
 *   ----------|--------|-----------------|-----------------|---------------------
 *   0         | 1      | 1/1             | false           | NO  (no poll at all)
 *   1         | 2      | 2/2             | false           | NO  (degenerate poll)
 *   2         | 3      | 3/3             | true            | YES
 *   3         | 4      | 4/4             | true            | YES
 *
 * So the rule is inert on the one-verifier setups #253 showed cannot vote, and
 * live from two verifiers up. Multi-raiser polls scale the same way: three
 * raisers need four verifiers before their unanimity means anything.
 */
export function isUnanimouslyVerified(v: FindingVerification | undefined): boolean {
  if (!v || !isMajorityVerified(v)) return false
  if (v.confirmedBy < v.polledModels) return false
  const raisers = raiserCount(v)
  return verifierVotesCanDemote(raisers, v.polledModels - raisers)
}

/**
 * The strongest signal this system produces: a finding a non-degenerate panel
 * confirmed UNANIMOUSLY on the reality axis AND explicitly judged worth
 * flagging on the worth axis. Both axes must be positive:
 *
 *   - reality: `isUnanimouslyVerified` (see above),
 *   - worth:   `worthFlagging === true`, EXPLICITLY. Absent worth data (old
 *     caches, verifiers predating the axis) is silence, and this predicate
 *     promotes only on positive evidence — the mirror of `isJudgedMoot`, which
 *     demotes only on positive evidence. Silence changes nothing either way.
 */
export function isUnanimouslyBacked(v: FindingVerification | undefined): boolean {
  return isUnanimouslyVerified(v) && v?.worthFlagging === true
}

/**
 * Judged MOOT by verification (the mootness gate): verification ran and the
 * panel's aggregate worth judgment came back false — real or not, a majority
 * of the polled models judged this not worth a busy reviewer's time. Absent
 * worth data (old cached findings, verifiers predating the worth axis) →
 * false: no signal, never demote on silence.
 */
export function isJudgedMoot(v: FindingVerification | undefined): boolean {
  return !!v && v.polledModels > 0 && v.worthFlagging === false
}

/**
 * The label for the moot demotion — the secondary-tier reason shown on a card
 * the panel judged not worth attention. One definition, shared by the card
 * chip and any copy that names the reason.
 */
export const MOOT_SECONDARY_LABEL = 'judged minor by verification'

// ---------------------------------------------------------------------------
// Tier decision
// ---------------------------------------------------------------------------

/**
 * The tier rules (before the budget):
 *
 *   coveredByDraft        → SECONDARY, always — the user already made the point;
 *                           strength is irrelevant (the #206 collapsed treatment
 *                           composes with the group).
 *   judged moot           → SECONDARY for ANY severity — the whole point of the
 *                           mootness gate is trusting it (a real-but-moot point
 *                           still costs attention). ONE carve-out: a HIGH that
 *                           is ALSO majority-verified-real stays inline —
 *                           hiding a high the panel confirmed real would be
 *                           triage malpractice.
 *   high severity         → PRIMARY otherwise — never hide a non-moot high,
 *                           even one demoted on the reality axis.
 *   medium severity       → PRIMARY when majority-verified, OR convergent, OR
 *                           verification never ran (single-model setups are NOT
 *                           punished: severity is the only signal there, and
 *                           medium+ has always rendered inline).
 *                           Weak/failed verification without convergence →
 *                           SECONDARY (the verifiers looked and didn't back it).
 *   low severity          → PRIMARY with convergence AND a non-negative
 *                           verification signal (majority-verified, or never
 *                           ran) — OR, without convergence, when the panel
 *                           UNANIMOUSLY backed it on both axes
 *                           (`isUnanimouslyBacked`). Otherwise SECONDARY: a
 *                           lone low finding — or a low the verifiers demoted —
 *                           is exactly the noise this pass collapses.
 *
 * The unanimity carve-out for LOW (follow-up to the #254 measurement) exists
 * because the eval measured this rule eating a real defect. `eval/BASELINE.md`
 * Measurement 2, run 2: `08-quiet-low` line 13 — a `catch` that silently
 * discards its error — was confirmed 3/3 `surfaced=true` `worthFlagging=true`,
 * i.e. every model that looked at it said it was real AND worth a reviewer's
 * time, and it was collapsed anyway because one reviewer had typed "low".
 * Severity is ONE reviewer's opinion; unanimous cross-model agreement is the
 * strongest evidence the ensemble produces, and the same measurement found
 * verification to be the only stage reliably reducing noise. Letting the weak
 * signal overrule the strong one was backwards. This carve-out is the narrowest
 * that fixes it: unanimous (not majority), both axes positive (not one), and
 * only where the poll could actually have gone the other way.
 *
 * Moot-demotion matrix (worth axis × severity × reality axis):
 *
 *   severity | majority-moot | majority-verified-real | tier
 *   ---------|---------------|------------------------|--------------------
 *   high     | no / no data  | (any)                  | primary (unchanged)
 *   high     | yes           | yes                    | primary (real high wins)
 *   high     | yes           | no                     | secondary
 *   med/low  | yes           | (any)                  | secondary (trust the gate)
 *   med/low  | no / no data  | (any)                  | pre-gate rules above
 *
 * Old cached findings carry no worth data → isJudgedMoot is false → the whole
 * matrix degrades to the pre-gate behavior.
 */
export function findingTier(f: RankableFinding): 'primary' | 'secondary' {
  if (f.coveredByDraft) return 'secondary'

  const moot = isJudgedMoot(f.verification)
  if (f.severity === 'high') {
    // Mootness-gate carve-out: a moot high stays inline ONLY when the panel
    // also confirmed it real (majority-verified). A moot high without that
    // backing trusts the gate and collapses like everything else.
    if (moot && !isMajorityVerified(f.verification)) return 'secondary'
    return 'primary'
  }
  if (moot) return 'secondary'

  const ran = verificationRan(f.verification)
  const majority = isMajorityVerified(f.verification)
  const convergent = isConvergent(f)

  if (f.severity === 'medium') {
    if (!ran) return 'primary'
    return majority || convergent ? 'primary' : 'secondary'
  }

  // low
  if (!convergent) return isUnanimouslyBacked(f.verification) ? 'primary' : 'secondary'
  if (!ran) return 'primary'
  return majority ? 'primary' : 'secondary'
}

// ---------------------------------------------------------------------------
// Ordering — deterministic, consistent with findingWeight
// ---------------------------------------------------------------------------

/**
 * Rank weight for ordering/budget-spill: the risk module's verification-adjusted
 * `findingWeight` (severity × quorum, demoted ×0.25) plus a bounded convergence
 * bonus. Higher = stronger = keeps its inline slot longer.
 */
export function rankWeight(f: RankableFinding): number {
  const extraReviewers = convergedReviewerCount(f) - 1
  const bonus = Math.min(CONVERGENCE_WEIGHT_BONUS_MAX, extraReviewers * CONVERGENCE_WEIGHT_BONUS)
  return findingWeight({ severity: f.severity, verification: f.verification }) + bonus
}

const SEVERITY_RANK: Record<RankableFinding['severity'], number> = { high: 3, medium: 2, low: 1 }

/** Line key for ordering: null (file-level) sorts after every numbered line. */
function lineKey(line: number | null): number {
  return line === null ? Number.MAX_SAFE_INTEGER : line
}

/** Strongest first; ties broken by severity, then path asc, then line asc. */
export function compareRank(a: RankableFinding, b: RankableFinding): number {
  const dw = rankWeight(b) - rankWeight(a)
  if (dw !== 0) return dw
  const ds = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
  if (ds !== 0) return ds
  if (a.path !== b.path) return a.path < b.path ? -1 : 1
  return lineKey(a.line) - lineKey(b.line)
}

/** File/line reading order for the collapsed groups (path asc, line asc). */
function compareLocation(a: RankableFinding, b: RankableFinding): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1
  const dl = lineKey(a.line) - lineKey(b.line)
  if (dl !== 0) return dl
  return compareRank(a, b)
}

// ---------------------------------------------------------------------------
// rankFindings — tiers + budget
// ---------------------------------------------------------------------------

/**
 * Rank a review's findings into {primary, secondary}. Pure + deterministic:
 * the same input always produces the same tiers and orders.
 *
 * Budget: when the tier rules would put more than INLINE_PRIMARY_BUDGET
 * findings inline, the LOWEST-ranked non-high primaries spill into secondary
 * until the budget holds. High-severity findings never spill — if a review has
 * more than the budget in highs alone, they ALL stay inline (hiding a high to
 * honor a display budget would be triage malpractice).
 *
 * Output order: `primary` strongest-first (compareRank), `secondary` in
 * file/line reading order (the collapsed groups list top-to-bottom of a file).
 */
export function rankFindings<T extends RankableFinding>(findings: T[]): RankedFindings<T> {
  const primary: T[] = []
  const secondary: T[] = []
  for (const f of findings) {
    if (findingTier(f) === 'primary') primary.push(f)
    else secondary.push(f)
  }

  primary.sort(compareRank)

  // Budget spill: highs are untouchable; the rest keep the remaining slots in
  // rank order (primary is already sorted strongest-first, so the spilled ones
  // are exactly the weakest non-highs).
  const highs = primary.filter((f) => f.severity === 'high')
  if (primary.length > INLINE_PRIMARY_BUDGET && primary.length > highs.length) {
    const slots = Math.max(0, INLINE_PRIMARY_BUDGET - highs.length)
    const rest = primary.filter((f) => f.severity !== 'high')
    const spilled = rest.slice(slots)
    const keep = new Set<T>(rest.slice(0, slots))
    const kept = primary.filter((f) => f.severity === 'high' || keep.has(f))
    secondary.push(...spilled)
    primary.length = 0
    primary.push(...kept)
  }

  secondary.sort(compareLocation)
  return { primary, secondary }
}

// ---------------------------------------------------------------------------
// "Show all" persistence — per-browser UI state (sortPref.ts idiom)
// ---------------------------------------------------------------------------

const SHOW_ALL_KEY = 'review123:findings-show-all'

/** Whether the global "Show all findings" escape hatch is on. Default false. */
export function getFindingsShowAll(): boolean {
  try {
    const raw = localStorage.getItem(SHOW_ALL_KEY)
    if (!raw) return false
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
    return (parsed as Record<string, unknown>)['showAll'] === true
  } catch {
    return false
  }
}

/** Persist the "Show all findings" choice. */
export function setFindingsShowAll(showAll: boolean): void {
  try {
    localStorage.setItem(SHOW_ALL_KEY, JSON.stringify({ showAll }))
  } catch {
    // localStorage unavailable — silently ignore
  }
}
