import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import SummaryPanel from './SummaryPanel.svelte'
import type { AiRun } from '../../lib/ai/run.svelte'

// Mock mermaid (required for MarkdownView transitively)
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
    skillReviews: [],
    start: async () => {},
    retry: async () => {},
    coach: async () => ({ error: 'no-key' }),
    ask: async () => ({ ok: false, error: 'no-key' }),
    runSkillReviews: async () => {},
    ...overrides,
  }
}

describe('SummaryPanel', () => {
  it('shows loading skeleton when summary is loading', () => {
    const { container } = render(SummaryPanel, { props: { run: makeRun({ summary: { status: 'loading' } }) } })
    expect(container.querySelector('.ai-panel-loading')).not.toBeNull()
  })

  it('shows no-key notice when no API key', () => {
    render(SummaryPanel, { props: { run: makeRun({ summary: { status: 'no-key' } }) } })
    expect(screen.getByText(/Add a DeepSeek key/i)).toBeInTheDocument()
  })

  it('renders streaming summary in a pre', () => {
    const { container } = render(SummaryPanel, {
      props: { run: makeRun({ summary: { status: 'streaming', value: 'Streaming...' } }) },
    })
    expect(container.querySelector('pre.prose')).not.toBeNull()
  })

  it('renders done summary via MarkdownView (strips reading order)', () => {
    const value = 'Done summary.\n===READING-ORDER===\nfile.ts\n===END==='
    render(SummaryPanel, {
      props: { run: makeRun({ summary: { status: 'done', value } }) },
    })
    expect(screen.getByText(/Done summary/i)).toBeInTheDocument()
    // Reading order stripped
    expect(screen.queryByText(/READING-ORDER/)).not.toBeInTheDocument()
  })
})
