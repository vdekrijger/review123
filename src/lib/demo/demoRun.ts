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

import type { AiRun, PanelState, SkillReviewEntry } from '../ai/run.svelte'
import {
  demoSummary,
  demoAttention,
  demoVerdict,
  demoTests,
  demoSkillFindings,
} from './fixture'

function done<T>(value: T): PanelState<T> {
  return { status: 'done', value }
}

/**
 * Construct the demo AiRun. Not reactive (the values never change), but it
 * structurally satisfies AiRun so the real display components render it.
 */
export function createDemoRun(): AiRun {
  const skillReviews: SkillReviewEntry[] = [
    {
      skillId: 'demo-correctness',
      name: demoSkillFindings.skillName,
      state: done(demoSkillFindings),
    },
  ]

  return {
    summary: done<string>(demoSummary),
    attention: done(demoAttention),
    // Diagrams/alternatives/story aren't part of the bundled demo fixture. Mark
    // them 'disabled' (NOT 'idle') so their panels render the compact muted
    // "enable in settings" state — never a skeleton/spinner (the demo must show
    // zero pending UI: every panel is settled).
    diagrams: { status: 'disabled' },
    verdict: done(demoVerdict),
    tests: done(demoTests),
    alternatives: { status: 'disabled' },
    story: { status: 'disabled' },
    skillReviews,
    totalUsage: undefined,
    verdictModels: [],
    modelPerformance: [],
    modelCostBreakdown: [],
    // Inert: the demo is fully pre-generated. These never touch the network.
    start: async () => {},
    retry: async () => {},
    coach: async () => ({ error: 'demo' }),
    ask: async () => ({ ok: false as const, error: 'Ask AI is disabled in the demo.' }),
    runSkillReviews: async () => {},
    retrySkill: async () => {},
  }
}
