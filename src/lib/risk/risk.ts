/**
 * src/lib/risk/risk.ts — deterministic, client-side "review effort" score.
 *
 * Pure and framework-free. Fuses signals the app ALREADY has (diff stats,
 * blast-radius impact, attention hotspots, verified reviewer findings, CI,
 * verdict, diff-computable heuristics) into an advisory low/medium/high badge
 * with a named-factor breakdown.
 *
 * Framing contract: this estimates REVIEW EFFORT / ATTENTION — how carefully a
 * human should read the change — never "defect probability". Wording in labels
 * and details must stay advisory.
 *
 * Graceful degradation: findings/attention/impact arrive asynchronously, so
 * every factor carries pending/unavailable flags and the overall level is
 * computed from whatever is available NOW; callers re-derive as data lands.
 *
 * The LLM risk judge (riskJudge input) is exactly such an async signal: its
 * 0–3 judgment enters as ONE more factor ("AI judgment") with the same
 * pending/unavailable degradation — the deterministic score never blocks on it.
 */

import type { PrFile } from '../github/types'
import type { ChangeImpact } from '../diagram/types'
import type { AttentionResult, FindingVerification, RiskJudgeResult, VerdictResult } from '../ai/schemas'
import type { CiSummary } from '../github/checks'
import { detectHeuristics, isSensitivePath, type HeuristicFlag } from './heuristics'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RiskLevel = 'low' | 'medium' | 'high'

export interface RiskFactor {
  id: string
  label: string
  /** 0 (negligible) … 3 (dominant). Meaningless when pending/unavailable. */
  score: number
  /** One-line, human-readable explanation of the score. */
  detail: string
  /** Input still in flight — the score will refine when it lands. */
  pending?: boolean
  /** Input can't be produced for this PR (e.g. no impact analysis) — NOT zero-risk. */
  unavailable?: boolean
}

/** The minimal finding shape the score needs (subset of SkillFinding). */
export interface RiskFinding {
  severity: 'high' | 'medium' | 'low'
  verification?: FindingVerification
}

export interface PrRiskInput {
  files: PrFile[]
  /** Blast-radius impact; null/undefined = not available (see impactPending). */
  impact?: ChangeImpact | null
  /** True while the impact analysis is still running. */
  impactPending?: boolean
  attention?: AttentionResult | null
  attentionPending?: boolean
  /** Reviewer findings (all reviewers, flattened), with verification. */
  findings?: RiskFinding[]
  /** True while any reviewer is still running/queued. */
  findingsPending?: boolean
  ci?: CiSummary | null
  verdictLevel?: VerdictResult['level'] | null
  verdictPending?: boolean
  /** LLM risk-judge result; null/undefined = not available (see riskJudgePending). */
  riskJudge?: RiskJudgeResult | null
  /** True while the risk-judge task is still running. */
  riskJudgePending?: boolean
}

export interface PrRisk {
  level: RiskLevel
  factors: RiskFactor[]
  /** Named AI-pattern sub-signals (rendered under "AI-pattern risks"). */
  heuristics: HeuristicFlag[]
  /** True while any factor is pending → show "refines as analysis completes". */
  pending: boolean
}

// ---------------------------------------------------------------------------
// Finding weights (shared by PR-level and file-level scores)
// ---------------------------------------------------------------------------

const SEVERITY_WEIGHT: Record<RiskFinding['severity'], number> = {
  high: 3,
  medium: 2,
  low: 1,
}

/**
 * Verification-adjusted weight of one finding.
 * - No verification ran → severity weight as-is.
 * - Demoted (surfaced: false) → counts at a quarter (much less, not zero).
 * - Verified → scaled by quorum: 0.5 + confirmedBy/polledModels, so a
 *   high-severity finding confirmed by most polled models dominates
 *   (3 × ~1.5 ≈ 4.5) while a barely-confirmed one contributes less.
 */
export function findingWeight(f: RiskFinding): number {
  const base = SEVERITY_WEIGHT[f.severity]
  const v = f.verification
  if (!v) return base
  if (!v.surfaced) return base * 0.25
  const quorum = v.polledModels > 0 ? v.confirmedBy / v.polledModels : 0
  return base * (0.5 + quorum)
}

function findingsScore(totalWeight: number): number {
  if (totalWeight <= 0) return 0
  if (totalWeight < 2) return 1
  if (totalWeight < 3.5) return 2
  return 3
}

// ---------------------------------------------------------------------------
// PR-level factors
// ---------------------------------------------------------------------------

function sizeSpreadFactor(files: PrFile[]): RiskFactor {
  const churn = files.reduce((s, f) => s + f.additions + f.deletions, 0)
  const dirs = new Set(files.map((f) => f.filename.split('/').slice(0, -1).join('/') || '.'))

  const churnScore = churn >= 1000 ? 3 : churn >= 400 ? 2 : churn >= 100 ? 1 : 0
  const spreadHigh = files.length > 15 || dirs.size > 5
  const score = Math.min(3, churnScore + (spreadHigh ? 1 : 0))

  return {
    id: 'size-spread',
    label: 'Size & spread',
    score,
    detail: `${churn} changed lines across ${files.length} file${files.length === 1 ? '' : 's'} in ${dirs.size} director${dirs.size === 1 ? 'y' : 'ies'}`,
  }
}

function blastRadiusFactor(impact: ChangeImpact | null | undefined, pending: boolean): RiskFactor {
  if (impact == null) {
    return pending
      ? { id: 'blast-radius', label: 'Blast radius', score: 0, detail: 'impact analysis still running', pending: true }
      : { id: 'blast-radius', label: 'Blast radius', score: 0, detail: 'no impact analysis for this PR — unknown, not zero', unavailable: true }
  }
  const callers = impact.callers.length
  const callees = impact.callees.length
  let score = callers > 8 ? 3 : callers >= 4 ? 2 : callers >= 1 ? 1 : 0
  if (callees > 8 && score < 3) score += 1
  return {
    id: 'blast-radius',
    label: 'Blast radius',
    score,
    detail: `${callers} upstream caller${callers === 1 ? '' : 's'} affected, ${callees} downstream dependenc${callees === 1 ? 'y' : 'ies'}`,
  }
}

function verifiedFindingsFactor(findings: RiskFinding[] | undefined, pending: boolean): RiskFactor {
  const list = findings ?? []
  const weight = list.reduce((s, f) => s + findingWeight(f), 0)
  const score = findingsScore(weight)
  const high = list.filter((f) => f.severity === 'high').length
  if (list.length === 0) {
    return pending
      ? { id: 'verified-findings', label: 'Reviewer findings', score: 0, detail: 'reviewers still running', pending: true }
      : { id: 'verified-findings', label: 'Reviewer findings', score: 0, detail: 'no reviewer findings' }
  }
  return {
    id: 'verified-findings',
    label: 'Reviewer findings',
    score,
    detail: `${list.length} finding${list.length === 1 ? '' : 's'}${high > 0 ? ` (${high} high severity)` : ''}, weighted by cross-model verification`,
    ...(pending ? { pending: true } : {}),
  }
}

function signalsFactor(
  ci: CiSummary | null | undefined,
  verdictLevel: VerdictResult['level'] | null | undefined,
  verdictPending: boolean,
  attention: AttentionResult | null | undefined,
  attentionPending: boolean,
): RiskFactor {
  const parts: string[] = []
  let score = 0
  if (ci && ci.failed > 0) {
    score += 2
    parts.push(`${ci.failed} CI check${ci.failed === 1 ? '' : 's'} failing`)
  } else if (ci && ci.total > 0) {
    parts.push('CI green')
  }
  if (verdictLevel === 'significant-changes') {
    score += 2
    parts.push('verdict: significant changes')
  } else if (verdictLevel === 'minor-changes') {
    score += 1
    parts.push('verdict: minor changes')
  } else if (verdictLevel === 'behavior-preserved') {
    parts.push('verdict: behavior preserved')
  }
  if (attention) {
    const high = attention.hotspots.filter((h) => h.level === 'high').length
    if (high >= 3) {
      score += 2
      parts.push(`${high} high-attention hotspots`)
    } else if (high >= 1) {
      score += 1
      parts.push(`${high} high-attention hotspot${high === 1 ? '' : 's'}`)
    }
  }
  const pending = (verdictPending && verdictLevel == null) || (attentionPending && attention == null)
  return {
    id: 'signals',
    label: 'CI, verdict & hotspot signals',
    score: Math.min(3, score),
    detail: parts.length > 0 ? parts.join('; ') : 'no CI, verdict or hotspot signal yet',
    ...(pending ? { pending: true } : {}),
  }
}

function aiPatternFactor(flags: HeuristicFlag[]): RiskFactor {
  const score = flags.length >= 4 ? 3 : flags.length >= 2 ? 2 : flags.length === 1 ? 1 : 0
  return {
    id: 'ai-patterns',
    label: 'AI-pattern risks',
    score,
    detail:
      flags.length === 0
        ? 'no risky diff patterns detected'
        : `${flags.length} pattern${flags.length === 1 ? '' : 's'} worth a closer look`,
  }
}

/**
 * LLM risk-judge factor ("AI judgment"). The judge's 0–3 score enters the
 * breakdown like any other factor; its one-line rationale is the detail.
 * In flight → pending (excluded from the level, like every pending factor);
 * failed/absent → unavailable (unknown is NOT zero-risk). Defensive clamp on
 * the score — the validator already normalizes, but this module stays pure
 * and makes no assumptions about its callers.
 */
function aiJudgeFactor(judge: RiskJudgeResult | null | undefined, pending: boolean): RiskFactor {
  if (judge == null) {
    return pending
      ? { id: 'ai-judge', label: 'AI judgment', score: 0, detail: 'AI judgment still running', pending: true }
      : { id: 'ai-judge', label: 'AI judgment', score: 0, detail: 'no AI judgment for this PR — unknown, not zero', unavailable: true }
  }
  const score = Math.min(3, Math.max(0, Math.round(judge.score)))
  return {
    id: 'ai-judge',
    label: 'AI judgment',
    score,
    detail: judge.rationale,
  }
}

// ---------------------------------------------------------------------------
// computePrRisk
// ---------------------------------------------------------------------------

function overallLevel(factors: RiskFactor[]): RiskLevel {
  const usable = factors.filter((f) => !f.pending && !f.unavailable)
  if (usable.length === 0) return 'low'
  const max = Math.max(...usable.map((f) => f.score))
  const avg = usable.reduce((s, f) => s + f.score, 0) / usable.length
  if (max === 3 || avg >= 2) return 'high'
  if (max === 2 || avg >= 1) return 'medium'
  return 'low'
}

export function computePrRisk(input: PrRiskInput): PrRisk {
  const heuristics = detectHeuristics(input.files)
  const factors: RiskFactor[] = [
    sizeSpreadFactor(input.files),
    blastRadiusFactor(input.impact, input.impactPending ?? false),
    verifiedFindingsFactor(input.findings, input.findingsPending ?? false),
    signalsFactor(
      input.ci,
      input.verdictLevel,
      input.verdictPending ?? false,
      input.attention,
      input.attentionPending ?? false,
    ),
    aiPatternFactor(heuristics),
    aiJudgeFactor(input.riskJudge, input.riskJudgePending ?? false),
  ]
  return {
    level: overallLevel(factors),
    factors,
    heuristics,
    pending: factors.some((f) => f.pending),
  }
}

// ---------------------------------------------------------------------------
// computeFileRisk
// ---------------------------------------------------------------------------

export interface FileRiskInput {
  file: PrFile
  /** AI attention level for this file, when the attention task has landed. */
  hotspotLevel?: 'high' | 'medium' | 'low' | null
  /** Reviewer findings ON THIS FILE, with verification. */
  findings?: RiskFinding[]
}

/**
 * Per-file review-effort level. Point-based:
 *  - churn: ≥300 → 2, ≥100 → 1
 *  - status: added (all-new code) +1; removed (deleted code) −1
 *  - hotspot: high +4 (alone → high), medium +2, low +1
 *  - findings: verification-weighted sum, capped at 4 (a confirmed
 *    high-severity finding alone → high)
 *  - security-sensitive path: +1
 * Total ≥4 → high, ≥2 → medium, else low.
 */
export function computeFileRisk(input: FileRiskInput): RiskLevel {
  const { file } = input
  let points = 0

  const churn = file.additions + file.deletions
  if (churn >= 300) points += 2
  else if (churn >= 100) points += 1

  if (file.status === 'added') points += 1
  else if (file.status === 'removed') points -= 1

  if (input.hotspotLevel === 'high') points += 4
  else if (input.hotspotLevel === 'medium') points += 2
  else if (input.hotspotLevel === 'low') points += 1

  const findingsWeight = (input.findings ?? []).reduce((s, f) => s + findingWeight(f), 0)
  points += Math.min(4, Math.round(findingsWeight))

  if (isSensitivePath(file.filename)) points += 1

  if (points >= 4) return 'high'
  if (points >= 2) return 'medium'
  return 'low'
}
