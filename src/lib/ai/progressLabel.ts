/**
 * src/lib/ai/progressLabel.ts — humanized, HONEST status-line labels per AI task.
 *
 * Part of the unified AI-progress treatment: every AI surface shows the same
 * shape — a one-line status while pending, then (deep mode) an activity log,
 * then a content-shaped skeleton. This module is the single source of truth for
 * the status-line copy so the labels stay consistent everywhere they appear
 * (the four panels, the at-a-glance card, the skill reviewers, story, coach,
 * mining, ask).
 *
 * The label is HONEST: the task IS running — this is not fabricated progress.
 */

/** Every AI task that drives a status line. */
export type AiProgressTask =
  | 'summary'
  | 'attention'
  | 'diagrams'
  | 'tests'
  | 'alternatives'
  | 'verdict'
  | 'story'
  | 'coach'
  | 'mining'
  | 'ask'
  | 'skill'

const STATIC_LABELS: Record<Exclude<AiProgressTask, 'skill'>, string> = {
  summary: 'Summarizing the change…',
  attention: 'Finding what needs attention…',
  diagrams: 'Mapping the change impact…',
  tests: 'Mapping tests to code…',
  alternatives: 'Weighing alternatives…',
  verdict: 'Forming a verdict…',
  story: 'Ordering the walkthrough…',
  coach: 'Coaching your comments…',
  mining: 'Reading your past reviews…',
  ask: 'Thinking…',
}

/**
 * Humanized status line for a pending AI task.
 *
 * For 'skill' the reviewer's name personalises the line ("Running {name}…");
 * pass the reviewer name as the second argument. All other tasks ignore it.
 */
export function aiProgressLabel(task: AiProgressTask, name?: string): string {
  if (task === 'skill') {
    const who = name?.trim()
    return who ? `Running ${who}…` : 'Running reviewer…'
  }
  return STATIC_LABELS[task]
}
