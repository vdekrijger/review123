import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/svelte'
import DiagramsSection from './DiagramsSection.svelte'
import type { AiRun } from '../../lib/ai/run.svelte'
import type { GraphResult } from '../../lib/ai/schemas'

// Mock mermaid (DiagramPanel dependency)
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg/>' }),
  },
}))

function makeRun(overrides: Partial<AiRun>): AiRun {
  return {
    summary: { status: 'idle' },
    attention: { status: 'idle' },
    diagrams: { status: 'idle' },
    verdict: { status: 'idle' },
    tests: { status: 'idle' },
    alternatives: { status: 'idle' },
    story: { status: 'idle' },
    skillReviews: [],
    totalUsage: undefined,
    verdictModels: [],
    modelPerformance: [],
    start: async () => {},
    retry: async () => {},
    coach: async () => ({ error: 'no-key' }),
    ask: async () => ({ ok: false, error: 'no-key' }),
    runSkillReviews: async () => {},
    retrySkill: async () => {},
    ...overrides,
  }
}

describe('DiagramsSection — pending skeleton (block-shaped)', () => {
  it('shows ONE rectangular block skeleton when diagrams is idle (pending)', () => {
    const { container } = render(DiagramsSection, { props: { run: makeRun({}) } })
    expect(container.querySelectorAll('.ai-panel-loading .skeleton-rect')).toHaveLength(1)
    expect(container.querySelector('.skeleton-line')).toBeNull()
  })

  it('shows the block skeleton when diagrams is loading', () => {
    const { container } = render(DiagramsSection, {
      props: { run: makeRun({ diagrams: { status: 'loading' } }) },
    })
    expect(container.querySelector('.ai-panel-loading .skeleton-rect')).not.toBeNull()
  })

  it('replaces the skeleton with DiagramPanel content when done', () => {
    const result: GraphResult = {
      kind: 'flow',
      before: { nodes: [{ id: 'a', label: 'A' }], edges: [] },
      after: {
        nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        edges: [{ from: 'a', to: 'b' }],
      },
    }
    const { container } = render(DiagramsSection, {
      props: { run: makeRun({ diagrams: { status: 'done', value: result } }) },
    })
    expect(container.querySelector('.ai-panel-loading')).toBeNull()
    expect(container.querySelector('.skeleton-rect')).toBeNull()
  })

  it('shows the error state (not a skeleton) when diagrams errored', () => {
    const { container } = render(DiagramsSection, {
      props: { run: makeRun({ diagrams: { status: 'error', error: 'boom' } }) },
    })
    expect(container.querySelector('.ai-panel-error')).not.toBeNull()
    expect(container.querySelector('.ai-panel-loading')).toBeNull()
  })
})
