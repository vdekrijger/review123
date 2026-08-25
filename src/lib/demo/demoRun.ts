/**
 * src/lib/demo/demoRun.ts — a synthetic AiRun for the bundled demo PR.
 *
 * Builds a plain object satisfying the AiRun interface with every panel already
 * in the 'done' state (no spinners, no streaming) carrying the pre-generated
 * fixture values. All async methods are inert no-ops: the demo NEVER calls the
 * network or an LLM. start()/retry()/runSkillReviews()/retrySkill() do nothing
 * (the results are already 'done'); coach()/ask() resolve to a benign demo error
 * so no UI path can reach a real request.
 */

import type { AiRun, PanelState, SkillReviewEntry, VerdictModelBreakdown } from '../ai/run.svelte'
import {
  demoSummary,
  demoAttention,
  demoVerdict,
  demoTests,
  demoReviewers,
  demoModelCostBreakdown,
  demoTotalUsage,
  demoStory,
  demoGraph,
  demoRiskJudge,
} from './fixture'

function done<T>(value: T): PanelState<T> {
  return { status: 'done', value }
}

/** Slugify a reviewer name into a stable skillId for the demo run. */
function reviewerId(name: string): string {
  return 'demo-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

/**
 * Per-model performance rows for Step 3 — the SAME (model, role) identities as
 * the cost breakdown, carrying the impact readout (always shown when cross-verify
 * ran). Derived from the cost rows so the two never drift.
 */
const demoModelPerformance: VerdictModelBreakdown[] = demoModelCostBreakdown
  // Narration rows (active model running only descriptive tasks) carry no
  // finding-generation impact, so they don't appear in the performance readout.
  .filter((row): row is typeof row & { role: 'generator' | 'verifier' } => row.role !== 'narrator')
  .map((row) => ({
    providerId: row.providerId,
    modelId: row.modelId,
    role: row.role,
    ...(row.total ? { usage: row.total } : {}),
    ...(row.role === 'generator'
      ? { surfaced: row.surfaced ?? 0, uniqueCatch: row.uniqueCatch ?? 0 }
      : { impact: row.impact }),
  }))

/**
 * Construct the demo AiRun. Not reactive (the values never change), but it
 * structurally satisfies AiRun so the real display components render it.
 */
export function createDemoRun(): AiRun {
  // Several reviewer PERSONAS (Security / Performance / Pragmatic Senior /
  // Resiliency), each an already-'done' entry. This is the demo's differentiator
  // showcase: a mix of confirmed / demoted cross-verified findings, a multi-
  // generator "raised by" provenance, and one "✓ no significant issues" reviewer.
  const skillReviews: SkillReviewEntry[] = demoReviewers.map((result) => ({
    skillId: reviewerId(result.skillName),
    name: result.skillName,
    state: done(result),
  }))

  return {
    summary: done<string>(demoSummary),
    attention: done(demoAttention),
    // Diagrams ARE bundled now: a pre-'done' change-impact / blast-radius view
    // (demoGraph) so the Understand step (and ContextRail) shows the real
    // diagram instead of the muted "enable in settings" state. Alternatives
    // stay 'disabled' (NOT 'idle') so their panel renders the compact muted
    // state — never a skeleton/spinner (the demo shows zero pending UI: every
    // panel is settled). Story, likewise, is pre-'done' with the canned
    // demoStory so the Inspect step's Story|Files toggle has a real walkthrough.
    diagrams: done(demoGraph),
    verdict: done(demoVerdict),
    // LLM risk judge — pre-'done' so the Review effort breakdown shows the
    // "AI judgment" factor + risky snippets instead of an unavailable row.
    riskJudge: done(demoRiskJudge),
    tests: done(demoTests),
    alternatives: { status: 'disabled' },
    story: done(demoStory),
    skillReviews,
    // No convergence pass in the demo (the canned reviewers don't overlap) —
    // 'idle' is the honest "skipped" state and renders nothing.
    convergence: { status: 'idle' },
    simplify: { status: 'idle' },
    totalUsage: demoTotalUsage,
    verdictModels: demoModelPerformance,
    modelPerformance: demoModelPerformance,
    modelCostBreakdown: demoModelCostBreakdown,
    // Inert: the demo is fully pre-generated. These never touch the network.
    start: async () => {},
    retry: async () => {},
    coach: async () => ({ error: 'demo' }),
    ask: async () => ({ ok: false as const, error: 'Ask AI is disabled in the demo.' }),
    expandComment: async () => ({ ok: false as const, error: 'Expand is disabled in the demo.' }),
    runSkillReviews: async () => {},
    retrySkill: async () => {},
  }
}
