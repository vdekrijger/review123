import { describe, it, expect } from 'vitest'
import { aiProgressLabel, type AiProgressTask } from './progressLabel'

describe('aiProgressLabel — honest per-task status lines', () => {
  it.each<[Exclude<AiProgressTask, 'skill'>, string]>([
    ['summary', 'Summarizing the change…'],
    ['attention', 'Finding what needs attention…'],
    ['diagrams', 'Tracing the execution path…'],
    ['tests', 'Mapping tests to code…'],
    ['alternatives', 'Weighing alternatives…'],
    ['verdict', 'Forming a verdict…'],
    ['story', 'Ordering the walkthrough…'],
    ['coach', 'Coaching your comments…'],
    ['mining', 'Reading your past reviews…'],
    ['ask', 'Thinking…'],
  ])('maps %s → %s', (task, expected) => {
    expect(aiProgressLabel(task)).toBe(expected)
  })

  it('personalises the skill label with the reviewer name', () => {
    expect(aiProgressLabel('skill', 'Security Reviewer')).toBe('Running Security Reviewer…')
  })

  it('falls back to a generic skill label when no name is given', () => {
    expect(aiProgressLabel('skill')).toBe('Running reviewer…')
    expect(aiProgressLabel('skill', '  ')).toBe('Running reviewer…')
  })

  it('every label ends with an ellipsis (consistent in-progress affordance)', () => {
    const tasks: AiProgressTask[] = [
      'summary', 'attention', 'diagrams', 'tests', 'alternatives',
      'verdict', 'story', 'coach', 'mining', 'ask', 'skill',
    ]
    for (const t of tasks) expect(aiProgressLabel(t, 'X')).toMatch(/…$/)
  })
})
