/**
 * src/lib/eval/surface.ts — the POST-GENERATION pipeline, as measurable toggles.
 *
 * WHY THIS FILE EXISTS
 *
 * Until now the eval harness scored every finding the reviewer models produced.
 * That was the whole surface in 2026-06. It is not any more: between #206 and
 * #242 the app grew a stack of passes that sit BETWEEN generation and what a
 * human actually sees —
 *
 *   generation  →  cross-model verification  →  triage (rank into tiers)
 *               →  simplify (rewrite bodies)  →  the inline surface
 *
 * Scoring the raw generation therefore measures a surface nobody looks at, and
 * a single aggregate number cannot tell the difference between "the filters
 * improved the findings" and "the filters hid them". So each stage is a FLAG
 * here, and the harness scores the same generated findings under several flag
 * combinations. The interesting comparisons are then differences, not levels:
 *
 *   - recall DOWN on 01-real-bug / 05-security  → the filters are hiding real
 *     defects (under-filtering detectors going quiet = over-aggressive gates).
 *   - noise-rate DOWN on 02-clean-pr / 03-noise-trap → the filters are doing
 *     their job (over-filtering detectors are where filtering SHOULD show up).
 *
 * Everything here is PURE and reuses the REAL app logic (`rankFindings` from
 * src/lib/ai/findingRank.ts, the real `FindingVerification` shape). Nothing in
 * this file re-implements a policy — if it did, the eval would be measuring
 * itself instead of the app.
 */

import { rankFindings, type RankableFinding } from '../ai/findingRank'
import type { AbsorbedFinding, FindingVerification } from '../ai/schemas'
import type { ProducedFinding } from './scorer'

// ---------------------------------------------------------------------------
// The enriched finding the pipeline operates on
// ---------------------------------------------------------------------------

/**
 * A produced finding plus everything the post-generation passes need. The
 * scorer only ever reads `file` / `line` / `description`; the extra fields are
 * pipeline INPUTS (severity, verification) and pipeline OUTPUTS (simpleBody)
 * that the old flat `ProducedFinding` threw away.
 */
export interface EvalFinding extends ProducedFinding {
  /** As the reviewer assigned it. Triage's primary input (#226). */
  severity: 'high' | 'medium' | 'low'
  /** 'verdict' | 'attention' | `skill:<persona>` | `tests:<persona>`. */
  taskKey: string
  /** The reviewer persona that produced it (distinct-reviewer counting). */
  reviewerName?: string
  /** Cross-model verification, attached post-generation (#228/#229 shape). */
  verification?: FindingVerification
  /** The simplify pass's plain-English rewrite of the body (#220). */
  simpleBody?: string
  /** Convergence: absorbed sibling findings from other reviewers (#206). */
  mergedFrom?: AbsorbedFinding[]
  /** Convergence: the user's own draft already made this point (#206). */
  coveredByDraft?: { path: string; line: number }
}

/** The task-key prefix the separate tests pass (#237) writes. */
export const TESTS_TASK_PREFIX = 'tests:'

/** True for a finding produced by the separate tests reviewer pass (#237). */
export function isTestsPassFinding(f: EvalFinding): boolean {
  return f.taskKey.startsWith(TESTS_TASK_PREFIX)
}

// ---------------------------------------------------------------------------
// The stage flags
// ---------------------------------------------------------------------------

/**
 * Which post-generation passes are ON for a given scoring. Every flag maps to
 * one shipped feature, so a row of the comparison table names a real PR.
 */
export interface PipelineStages {
  /**
   * Cross-model verification (Plan M, worth axis #228). ON: findings the
   * verifier panel demoted (`verification.surfaced === false`) are dropped.
   * OFF: the verification result is stripped entirely before triage, which is
   * the honest model of "verification never ran" — triage's own rules treat a
   * finding with no verification differently from one the panel refused to
   * back, and conflating those two would make this table lie.
   */
  crossVerify: boolean
  /**
   * findingRank triage (#226). ON: only the inline `primary` tier is scored —
   * the tier a human actually sees without clicking "show all". OFF: every
   * finding is scored, which is the "show all findings" escape hatch.
   */
  triage: boolean
  /**
   * The mootness gate (#228) WITHIN triage. OFF strips `worthFlagging` from
   * the verification before ranking, so the worth axis stops demoting. Only
   * meaningful when `triage` is on; isolating it is the only way to tell the
   * mootness gate's effect from the rest of triage.
   */
  mootnessGate: boolean
  /**
   * The simplify pass (#220). ON: a finding with a `simpleBody` is scored on
   * that rewrite instead of its original body. This is not cosmetic for the
   * eval — matching is fuzzy token overlap, so a rewrite that drops the
   * identifying nouns stops matching its golden label.
   */
  simplify: boolean
  /** The separate tests reviewer pass (#237). OFF drops its findings. */
  testsPass: boolean
}

/**
 * Named variants, ordered so the table reads as a pipeline being switched on
 * one stage at a time. `generate-only` reproduces what this harness measured
 * before this file existed; `app-default` is what review123 shows inline today.
 */
export interface PipelineVariant {
  key: string
  /** What the row is evidence FOR, in a few words. */
  label: string
  stages: PipelineStages
}

const OFF: PipelineStages = {
  crossVerify: false,
  triage: false,
  mootnessGate: false,
  simplify: false,
  testsPass: false,
}

export const PIPELINE_VARIANTS: readonly PipelineVariant[] = [
  { key: 'generate-only', label: 'raw generation (pre-#226 surface)', stages: { ...OFF } },
  { key: '+tests-pass', label: 'tests pass added (#237)', stages: { ...OFF, testsPass: true } },
  { key: '+verify', label: 'cross-model verification (#229)', stages: { ...OFF, crossVerify: true } },
  { key: '+triage', label: 'triage alone, unverified (#226)', stages: { ...OFF, triage: true, mootnessGate: true } },
  {
    key: 'verify+triage/moot-off',
    label: 'verify + triage, mootness gate OFF',
    stages: { ...OFF, crossVerify: true, triage: true, mootnessGate: false },
  },
  {
    key: 'verify+triage',
    label: 'verify + triage + mootness gate (#228)',
    stages: { ...OFF, crossVerify: true, triage: true, mootnessGate: true },
  },
  {
    key: 'app-default',
    label: 'everything on — the inline surface today',
    stages: { crossVerify: true, triage: true, mootnessGate: true, simplify: true, testsPass: true },
  },
  {
    key: 'app-default/show-all',
    label: 'everything on, "show all findings"',
    stages: { crossVerify: true, triage: false, mootnessGate: true, simplify: true, testsPass: true },
  },
  // Single-stage knock-outs from the app's operating point. A stage's effect at
  // the END of the pipeline is not its effect in isolation — triage barely moves
  // anything on raw findings but does a lot once verification has run — so each
  // one also gets measured by switching it OFF with everything else left on.
  {
    key: 'app-default/simplify-off',
    label: 'everything on except simplify (#220)',
    stages: { crossVerify: true, triage: true, mootnessGate: true, simplify: false, testsPass: true },
  },
  {
    key: 'app-default/moot-off',
    label: 'everything on except the mootness gate (#228)',
    stages: { crossVerify: true, triage: true, mootnessGate: false, simplify: true, testsPass: true },
  },
  {
    key: 'app-default/tests-off',
    label: 'everything on except the tests pass (#237)',
    stages: { crossVerify: true, triage: true, mootnessGate: true, simplify: true, testsPass: false },
  },
]

// ---------------------------------------------------------------------------
// The pipeline itself
// ---------------------------------------------------------------------------

/** Strip the worth axis so the mootness gate cannot fire (gate OFF). */
function withoutWorth(v: FindingVerification | undefined): FindingVerification | undefined {
  if (!v || v.worthFlagging === undefined) return v
  const { worthFlagging: _dropped, ...rest } = v
  return rest
}

/** The RankableFinding view of an eval finding (path/line/severity + signals). */
function toRankable(f: EvalFinding): RankableFinding & { __source: EvalFinding } {
  return {
    path: f.file,
    line: f.line,
    severity: f.severity,
    ...(f.verification ? { verification: f.verification } : {}),
    ...(f.mergedFrom ? { mergedFrom: f.mergedFrom } : {}),
    ...(f.coveredByDraft ? { coveredByDraft: f.coveredByDraft } : {}),
    ...(f.reviewerName !== undefined ? { reviewerName: f.reviewerName } : {}),
    __source: f,
  }
}

/**
 * Run the enriched findings through the selected post-generation stages and
 * return the flat list a human would actually be shown — which is what the
 * scorer then grades.
 *
 * Order matches the app: verification decides what survives, triage decides
 * what is inline, simplify decides what the text reads like.
 */
export function surfaceFindings(
  findings: readonly EvalFinding[],
  stages: PipelineStages,
): ProducedFinding[] {
  // 1. The separate tests pass (#237) — an additive source of findings.
  let working = stages.testsPass ? [...findings] : findings.filter((f) => !isTestsPassFinding(f))

  // 2. Cross-model verification (Plan M / #228 / #229).
  if (stages.crossVerify) {
    working = working.filter((f) => f.verification?.surfaced !== false)
  } else {
    // Verification did not run: remove its output entirely rather than letting
    // triage read votes from a pass that is switched off.
    working = working.map(({ verification: _v, ...rest }) => rest as EvalFinding)
  }

  // 3. The mootness gate (#228) is a sub-switch of triage.
  if (!stages.mootnessGate) {
    working = working.map((f) => {
      const v = withoutWorth(f.verification)
      return v === f.verification ? f : ({ ...f, ...(v ? { verification: v } : {}) } as EvalFinding)
    })
  }

  // 4. Triage (#226) — keep only what renders inline.
  let surfaced: EvalFinding[]
  if (stages.triage) {
    surfaced = rankFindings(working.map(toRankable)).primary.map((r) => r.__source)
  } else {
    surfaced = working
  }

  // 5. Simplify (#220) — score the text the card actually shows.
  return surfaced.map((f) => ({
    file: f.file,
    line: f.line,
    description: stages.simplify && f.simpleBody ? f.simpleBody : f.description,
  }))
}
