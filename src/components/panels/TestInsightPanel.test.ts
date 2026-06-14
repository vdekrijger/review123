import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import TestInsightPanel from './TestInsightPanel.svelte'
import type { AiRun } from '../../lib/ai/run.svelte'
import type { TestInsight } from '../../lib/ai/schemas'

// Mock mermaid (MarkdownView dependency)
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
    totalUsage: undefined,
    start: async () => {},
    retry: async () => {},
    coach: async () => ({ error: 'no-key' }),
    ask: async () => ({ ok: false, error: 'no-key' }),
    runSkillReviews: async () => {},
    ...overrides,
  }
}

describe('TestInsightPanel', () => {
  it('shows no-key message when tests status is no-key', () => {
    render(TestInsightPanel, { props: { run: makeRun({ tests: { status: 'no-key' } }) } })
    expect(screen.getByText(/Add a DeepSeek key/i)).toBeInTheDocument()
  })

  it('shows covered behaviors and gaps when done', () => {
    const tests: TestInsight = {
      covered: [{ behavior: 'saves state', test: 'save.test.ts', file: 'src/save.ts' }],
      gaps: ['deletes correctly'],
    }
    render(TestInsightPanel, {
      props: { run: makeRun({ tests: { status: 'done', value: tests } }) },
    })
    expect(screen.getByText('saves state')).toBeInTheDocument()
    expect(screen.getByText('deletes correctly')).toBeInTheDocument()
  })

  it('calls onhotspot when test file link is clicked', async () => {
    const onhotspot = vi.fn()
    const tests: TestInsight = {
      covered: [{ behavior: 'does x', test: 'x.test.ts', file: 'src/x.ts' }],
      gaps: [],
    }
    render(TestInsightPanel, {
      props: { run: makeRun({ tests: { status: 'done', value: tests } }), onhotspot },
    })
    const link = screen.getByRole('button', { name: /Jump to src\/x\.ts/i })
    link.click()
    expect(onhotspot).toHaveBeenCalledWith('src/x.ts')
  })

  it('shows empty message when no covered and no gaps', () => {
    const tests: TestInsight = { covered: [], gaps: [] }
    render(TestInsightPanel, {
      props: { run: makeRun({ tests: { status: 'done', value: tests } }) },
    })
    expect(screen.getByText(/No AI-inferred test coverage/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Markdown rendering — gap text with backticks becomes <code> element
// ---------------------------------------------------------------------------

describe('TestInsightPanel — markdown in covered behaviors and gaps', () => {
  it('gap text with backticks renders a <code> element (not raw backticks)', () => {
    const tests: TestInsight = {
      covered: [],
      gaps: ['src/foo.ts: the `handleError` function is not tested'],
    }
    const { container } = render(TestInsightPanel, {
      props: { run: makeRun({ tests: { status: 'done', value: tests } }) },
    })
    const codeEl = container.querySelector('.tests-gap-text code')
    expect(codeEl).not.toBeNull()
    expect(codeEl!.textContent).toBe('handleError')
  })

  it('covered behavior with backticks renders a <code> element', () => {
    const tests: TestInsight = {
      covered: [{ behavior: 'calls `setState` on mount', test: 'mount.test.ts', file: 'src/comp.ts' }],
      gaps: [],
    }
    const { container } = render(TestInsightPanel, {
      props: { run: makeRun({ tests: { status: 'done', value: tests } }) },
    })
    const codeEl = container.querySelector('.tests-covered-behavior code')
    expect(codeEl).not.toBeNull()
    expect(codeEl!.textContent).toBe('setState')
  })

  it('gap text without backticks renders as plain text (no spurious <code>)', () => {
    const tests: TestInsight = {
      covered: [],
      gaps: ['src/foo.ts: edge case missing'],
    }
    const { container } = render(TestInsightPanel, {
      props: { run: makeRun({ tests: { status: 'done', value: tests } }) },
    })
    expect(container.querySelector('.tests-gap-text code')).toBeNull()
  })
})

describe('TestInsightPanel — pending skeleton (card-shaped)', () => {
  it('shows TWO card-shaped skeleton blocks when tests is idle (pending, no blank gap)', () => {
    const { container } = render(TestInsightPanel, { props: { run: makeRun({}) } })
    expect(container.querySelectorAll('.ai-panel-loading .skeleton-card')).toHaveLength(2)
  })

  it('shows the card skeleton when tests is loading', () => {
    const { container } = render(TestInsightPanel, {
      props: { run: makeRun({ tests: { status: 'loading' } }) },
    })
    expect(container.querySelectorAll('.ai-panel-loading .skeleton-card')).toHaveLength(2)
  })

  it('skeleton is gone once tests is done', () => {
    const tests: TestInsight = { covered: [], gaps: [] }
    const { container } = render(TestInsightPanel, {
      props: { run: makeRun({ tests: { status: 'done', value: tests } }) },
    })
    expect(container.querySelector('.ai-panel-loading')).toBeNull()
  })
})
