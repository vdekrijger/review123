/**
 * src/lib/eval/mock.ts — scripted LLM stub for the eval harness (--mock mode).
 *
 * The mock returns a fixed JSON string per taskKey ("verdict" | "attention" |
 * `skill:<name>` | `tests:<name>`) from a responses map. This makes the
 * harness's scoring + matching path DETERMINISTIC so it can be unit-tested and
 * run in CI without a network or API key.
 *
 * HONESTY: --mock validates the harness MECHANICS, not model quality. The mock
 * responses are authored alongside each golden case to represent a plausible
 * model output (e.g. a good run that catches the real bug and avoids the noise),
 * so the metrics demonstrate the scoring works end to end.
 */

import type { CompleteFn } from './harness'

/** Map of taskKey → raw assistant response (JSON string). */
export type MockResponses = Record<string, string>

/**
 * Build a CompleteFn that returns scripted responses. Unknown taskKeys fall
 * back to a per-task EMPTY-but-valid response so a missing script never crashes
 * the run (it just contributes no findings — visible as a recall miss).
 */
export function mockComplete(responses: MockResponses): CompleteFn {
  return async ({ taskKey }) => {
    if (taskKey in responses) return responses[taskKey]
    return emptyResponseFor(taskKey)
  }
}

/** A valid, finding-free response for the given task — the "silent" answer. */
export function emptyResponseFor(taskKey: string): string {
  if (taskKey === 'verdict') {
    return JSON.stringify({ level: 'behavior-preserved', evidence: [], notAnalyzed: [] })
  }
  if (taskKey === 'attention') {
    return JSON.stringify({ readingOrder: [], hotspots: [], testFlags: [] })
  }
  // The implementation pass and the separate TESTS pass (#237) both return a
  // SkillReviewResult, so both need the same silent shape. Without this the
  // tests pass fell back to '{}', which the validator REJECTS — an unscripted
  // tests pass would have looked like a malformed model rather than a quiet one.
  for (const prefix of ['skill:', 'tests:']) {
    if (taskKey.startsWith(prefix)) {
      return JSON.stringify({ skillName: taskKey.slice(prefix.length), findings: [] })
    }
  }
  return '{}'
}
