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
    story: { status: 'idle' },
    riskJudge: { status: 'idle' },
    skillReviews: [],
    totalUsage: undefined,
    verdictModels: [],
    modelPerformance: [],
    modelCostBreakdown: [],
    start: async () => {},
    retry: async () => {},
    coach: async () => ({ error: 'no-key' }),
    ask: async () => ({ ok: false, error: 'no-key' }),
    runSkillReviews: async () => {},
    retrySkill: async () => {},
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

// ---------------------------------------------------------------------------
// Markdown rendering — tradeoffs and rationale are AI text fields
// ---------------------------------------------------------------------------

describe('AlternativesPanel — markdown in tradeoffs and rationale', () => {
  it('tradeoffs with backticks renders a <code> element', () => {
    const result: AlternativesResult = {
      problem: 'Caching strategy.',
      alternatives: [
        {
          approach: 'Use Redis',
          tradeoffs: 'Requires `REDIS_URL` env var to be set',
          assessment: 'alternative-is-better',
          rationale: 'More scalable.',
        },
      ],
    }
    const { container } = render(AlternativesPanel, {
      props: { run: makeRun({ alternatives: { status: 'done', value: result } }) },
    })
    const codeEl = container.querySelector('.alternative-tradeoffs code')
    expect(codeEl).not.toBeNull()
    expect(codeEl!.textContent).toBe('REDIS_URL')
  })

  it('approach TITLE with backticks renders a <code> element (not literal backticks)', () => {
    const result: AlternativesResult = {
      problem: 'Caching strategy.',
      alternatives: [
        {
          approach: 'Execute the query inline by calling `calculate_for_query`',
          tradeoffs: 'External dependency.',
          assessment: 'alternative-is-better',
          rationale: 'More scalable.',
        },
      ],
    }
    const { container } = render(AlternativesPanel, {
      props: { run: makeRun({ alternatives: { status: 'done', value: result } }) },
    })
    const codeEl = container.querySelector('.alternative-approach code')
    expect(codeEl).not.toBeNull()
    expect(codeEl!.textContent).toBe('calculate_for_query')
    // The literal backticks must NOT appear as text
    expect(container.querySelector('.alternative-approach')!.textContent).not.toContain('`')
  })

  it('rationale with backticks renders a <code> element', () => {
    const result: AlternativesResult = {
      problem: 'Caching strategy.',
      alternatives: [
        {
          approach: 'Use Redis',
          tradeoffs: 'External dependency.',
          assessment: 'alternative-is-better',
          rationale: 'The `cache.get` API is more ergonomic.',
        },
      ],
    }
    const { container } = render(AlternativesPanel, {
      props: { run: makeRun({ alternatives: { status: 'done', value: result } }) },
    })
    const codeEl = container.querySelector('.alternative-rationale code')
    expect(codeEl).not.toBeNull()
    expect(codeEl!.textContent).toBe('cache.get')
  })
})

describe('AlternativesPanel — pending skeleton (card-shaped)', () => {
  it('shows TWO card-shaped skeleton blocks when alternatives is idle (pending, no blank gap)', () => {
    const { container } = render(AlternativesPanel, { props: { run: makeRun({}) } })
    expect(container.querySelectorAll('.ai-panel-loading .skeleton-card')).toHaveLength(2)
  })

  it('shows the card skeleton when alternatives is loading', () => {
    const { container } = render(AlternativesPanel, {
      props: { run: makeRun({ alternatives: { status: 'loading' } }) },
    })
    expect(container.querySelectorAll('.ai-panel-loading .skeleton-card')).toHaveLength(2)
  })
})
