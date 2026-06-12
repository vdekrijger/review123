import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import AlternativesPanel from './AlternativesPanel.svelte'
import type { AiRun } from '../../lib/ai/run.svelte'
import type { AlternativesResult } from '../../lib/ai/schemas'

function makeRun(overrides: Partial<AiRun>): AiRun {
  return {
    summary: { status: 'idle' },
    attention: { status: 'idle' },
    diagrams: { status: 'idle' },
    verdict: { status: 'idle' },
    tests: { status: 'idle' },
    alternatives: { status: 'idle' },
    skillReviews: [],
    start: async () => {},
    retry: async () => {},
    coach: async () => ({ error: 'no-key' }),
    ask: async () => ({ ok: false, error: 'no-key' }),
    runSkillReviews: async () => {},
    ...overrides,
  }
}

describe('AlternativesPanel', () => {
  it('shows no-key message when alternatives status is no-key', () => {
    render(AlternativesPanel, { props: { run: makeRun({ alternatives: { status: 'no-key' } }) } })
    expect(screen.getByText(/Add a DeepSeek key/i)).toBeInTheDocument()
  })

  it('shows problem statement and alternative cards', () => {
    const result: AlternativesResult = {
      problem: 'How to handle caching?',
      alternatives: [
        {
          approach: 'Use Redis',
          tradeoffs: 'External dependency',
          assessment: 'alternative-is-better',
          rationale: 'More scalable',
        },
      ],
    }
    render(AlternativesPanel, {
      props: { run: makeRun({ alternatives: { status: 'done', value: result } }) },
    })
    expect(screen.getByText('How to handle caching?')).toBeInTheDocument()
    expect(screen.getByText('Use Redis')).toBeInTheDocument()
    expect(screen.getByText(/Worth considering/i)).toBeInTheDocument()
  })

  it('shows empty message when no alternatives', () => {
    const result: AlternativesResult = {
      problem: 'Problem statement',
      alternatives: [],
    }
    render(AlternativesPanel, {
      props: { run: makeRun({ alternatives: { status: 'done', value: result } }) },
    })
    expect(screen.getByText(/No meaningfully different alternatives/i)).toBeInTheDocument()
  })
})
