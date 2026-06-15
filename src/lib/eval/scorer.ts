/**
 * src/lib/eval/scorer.ts — eval-harness scoring logic.
 *
 * Pure, dependency-free matching + metric computation for the AI-review eval
 * harness (see eval/README.md). Lives under src/lib so it runs under the normal
 * `pnpm test` (vitest include = src/**); the CLI runner (eval/run-eval.ts)
 * imports from here.
 *
 * The harness reduces every AI review task (skill review, verdict, attention)
 * to a flat list of {file, line, description} findings. A golden case labels
 * the findings a good reviewer SHOULD flag (KNOWN-REAL) and the ones it should
 * NOT flag (KNOWN-NOISE). The scorer matches produced findings against those
 * labels by file + line proximity and fuzzy description overlap, then reports
 * precision / recall / noise-rate / finding-count.
 *
 * IMPORTANT (honesty): this file scores whatever findings it is handed. In
 * --mock mode the findings come from a scripted stub, so these metrics validate
 * the HARNESS MECHANICS, not model quality. Only --live mode measures the model.
 */

import { findingsMatch } from '../ai/findingMatch'

// ---------------------------------------------------------------------------
// Finding shapes
// ---------------------------------------------------------------------------

/** A finding produced by a review task, normalized to file + line + text. */
export interface ProducedFinding {
  file: string
  /** 1-based line, or null for a file-level finding. */
  line: number | null
  description: string
}

/** A hand-labeled expectation entry in a golden case's expected.json. */
export interface ExpectedFinding {
  file: string
  /** 1-based line, or null for a file-level expectation. */
  line: number | null
  /** Short human description of the expected (or to-be-avoided) finding. */
  description: string
}

/**
 * A finding label in the capture-tool's expected.json `findings` array.
 * `UNLABELED` means the user has not yet resolved the entry — the scorer SKIPS
 * it (it counts toward neither real nor noise) so a half-labeled case never
 * scores garbage.
 */
export type ExpectedLabel = 'real' | 'noise' | 'UNLABELED'

/** A labeled entry in the capture-tool's expected.json `findings` array. */
export interface LabeledFinding extends ExpectedFinding {
  label: ExpectedLabel
}

/** Tuning knobs for the matcher. Defaults documented in DEFAULT_MATCH_CONFIG. */
export interface MatchConfig {
  /** A produced finding matches an expectation if |Δline| ≤ this many lines. */
  lineTolerance: number
  /** Minimum token-overlap (Jaccard, 0–1) required for a description match. */
  descOverlapThreshold: number
}

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  lineTolerance: 3,
  descOverlapThreshold: 0.12,
}

// ---------------------------------------------------------------------------
// Description fuzzy overlap + single-pair match predicate
//
// The matching definition lives in src/lib/ai/findingMatch.ts (shared with
// Plan O multi-generator dedup so there is ONE notion of "same finding"). These
// re-exports/wrappers keep scorer.ts's public surface stable.
// ---------------------------------------------------------------------------

export { tokenize, descOverlap } from '../ai/findingMatch'

/**
 * Does a produced finding match an expectation? Delegates to the shared
 * `findingsMatch` predicate (file exact + line proximity + fuzzy description
 * overlap). A description match is REQUIRED so a same-line finding about a
 * different concern does not spuriously count.
 */
export function isMatch(
  produced: ProducedFinding,
  expected: ExpectedFinding,
  config: MatchConfig = DEFAULT_MATCH_CONFIG,
): boolean {
  return findingsMatch(produced, expected, config)
}

// ---------------------------------------------------------------------------
// Case scoring
// ---------------------------------------------------------------------------

export interface CaseExpectation {
  /** Findings a good reviewer SHOULD flag. */
  real: ExpectedFinding[]
  /** Findings a good reviewer should NOT flag (style nits, moot, unchanged code). */
  noise: ExpectedFinding[]
}

/**
 * The two shapes an expected.json may take:
 * - legacy/hand-authored: `{ real: [...], noise: [...] }`
 * - capture-tool: `{ findings: [{ ..., label: "real" | "noise" | "UNLABELED" }] }`
 */
export type RawExpectation =
  | { real?: ExpectedFinding[]; noise?: ExpectedFinding[] }
  | { findings: LabeledFinding[] }

/**
 * Normalize either expected.json shape into a `{ real, noise }` CaseExpectation.
 *
 * For the capture-tool's labeled `findings` array, `UNLABELED` entries are
 * SKIPPED entirely — they count toward neither real nor noise, so a partially
 * labeled case scores only on the entries the user has actually resolved (its
 * recall/noise-rate stay meaningful instead of being polluted by unresolved
 * findings).
 */
export function normalizeExpectation(raw: RawExpectation): CaseExpectation {
  if ('findings' in raw && Array.isArray(raw.findings)) {
    const real: ExpectedFinding[] = []
    const noise: ExpectedFinding[] = []
    for (const f of raw.findings) {
      const entry: ExpectedFinding = { file: f.file, line: f.line, description: f.description }
      if (f.label === 'real') real.push(entry)
      else if (f.label === 'noise') noise.push(entry)
      // 'UNLABELED' (or any unrecognized label) → skipped on purpose.
    }
    return { real, noise }
  }
  const legacy = raw as { real?: ExpectedFinding[]; noise?: ExpectedFinding[] }
  return { real: legacy.real ?? [], noise: legacy.noise ?? [] }
}

export interface CaseScore {
  caseName: string
  /** Count of produced findings (all of them, including unmatched). */
  produced: number
  /** KNOWN-REAL items matched by at least one produced finding. */
  realCaught: number
  realTotal: number
  /** KNOWN-NOISE items matched by at least one produced finding (these are bad). */
  noiseFlagged: number
  noiseTotal: number
  /**
   * Produced findings that matched NEITHER a real NOR a noise expectation.
   * On a clean golden case these are spurious; on a partially-labeled case they
   * may be legitimately un-labeled. Reported but not penalized by gates.
   */
  unmatched: number
  /** realCaught / realTotal (1 when realTotal === 0). */
  recall: number
  /** realCaught / (realCaught + noiseFlagged + unmatched) i.e. of flagged, fraction real. */
  precision: number
  /** noiseFlagged / noiseTotal (0 when noiseTotal === 0). */
  noiseRate: number
}

/**
 * Score a single golden case: match every produced finding against the case's
 * real + noise expectations and compute the per-case metrics.
 *
 * An expectation counts as "caught"/"flagged" if ANY produced finding matches
 * it (many-produced-to-one-expected is fine). A produced finding is "matched"
 * if it matches ANY expectation (real or noise).
 */
export function scoreCase(
  caseName: string,
  produced: ProducedFinding[],
  expectation: CaseExpectation,
  config: MatchConfig = DEFAULT_MATCH_CONFIG,
): CaseScore {
  const realCaught = expectation.real.filter((exp) =>
    produced.some((p) => isMatch(p, exp, config)),
  ).length

  const noiseFlagged = expectation.noise.filter((exp) =>
    produced.some((p) => isMatch(p, exp, config)),
  ).length

  const unmatched = produced.filter(
    (p) =>
      !expectation.real.some((exp) => isMatch(p, exp, config)) &&
      !expectation.noise.some((exp) => isMatch(p, exp, config)),
  ).length

  const realTotal = expectation.real.length
  const noiseTotal = expectation.noise.length

  const recall = realTotal === 0 ? 1 : realCaught / realTotal
  const flaggedTotal = realCaught + noiseFlagged + unmatched
  const precision = flaggedTotal === 0 ? 1 : realCaught / flaggedTotal
  const noiseRate = noiseTotal === 0 ? 0 : noiseFlagged / noiseTotal

  return {
    caseName,
    produced: produced.length,
    realCaught,
    realTotal,
    noiseFlagged,
    noiseTotal,
    unmatched,
    recall,
    precision,
    noiseRate,
  }
}

// ---------------------------------------------------------------------------
// Aggregate scoring
// ---------------------------------------------------------------------------

export interface AggregateScore {
  cases: CaseScore[]
  /** Micro-averaged across all cases (sum of counts, not mean of ratios). */
  recall: number
  precision: number
  noiseRate: number
  totalProduced: number
  realTotal: number
  realCaught: number
  noiseTotal: number
  noiseFlagged: number
}

/** Micro-average the per-case scores into one aggregate. */
export function aggregate(cases: CaseScore[]): AggregateScore {
  const realCaught = sum(cases, (c) => c.realCaught)
  const realTotal = sum(cases, (c) => c.realTotal)
  const noiseFlagged = sum(cases, (c) => c.noiseFlagged)
  const noiseTotal = sum(cases, (c) => c.noiseTotal)
  const unmatched = sum(cases, (c) => c.unmatched)
  const totalProduced = sum(cases, (c) => c.produced)

  const recall = realTotal === 0 ? 1 : realCaught / realTotal
  const flaggedTotal = realCaught + noiseFlagged + unmatched
  const precision = flaggedTotal === 0 ? 1 : realCaught / flaggedTotal
  const noiseRate = noiseTotal === 0 ? 0 : noiseFlagged / noiseTotal

  return {
    cases,
    recall,
    precision,
    noiseRate,
    totalProduced,
    realTotal,
    realCaught,
    noiseTotal,
    noiseFlagged,
  }
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((acc, item) => acc + pick(item), 0)
}

// ---------------------------------------------------------------------------
// Gate thresholds
// ---------------------------------------------------------------------------

export interface GateThresholds {
  /** Fail if aggregate recall is BELOW this (0–1). */
  minRecall: number
  /** Fail if aggregate noise-rate is ABOVE this (0–1). */
  maxNoiseRate: number
}

export const DEFAULT_GATES: GateThresholds = {
  minRecall: 0.5,
  maxNoiseRate: 0.25,
}

export interface GateResult {
  passed: boolean
  reasons: string[]
}

/** Evaluate an aggregate score against the gate thresholds. */
export function evaluateGates(
  agg: AggregateScore,
  gates: GateThresholds = DEFAULT_GATES,
): GateResult {
  const reasons: string[] = []
  if (agg.recall < gates.minRecall) {
    reasons.push(
      `recall ${pct(agg.recall)} is below the minimum ${pct(gates.minRecall)}`,
    )
  }
  if (agg.noiseRate > gates.maxNoiseRate) {
    reasons.push(
      `noise-rate ${pct(agg.noiseRate)} exceeds the maximum ${pct(gates.maxNoiseRate)}`,
    )
  }
  return { passed: reasons.length === 0, reasons }
}

/** Format a 0–1 ratio as a whole-number percentage string. */
export function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}
