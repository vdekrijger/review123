import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import TestInsightPanel from './TestInsightPanel.svelte'
import type { AiRun } from '../../lib/ai/run.svelte'
import type { TestInsight } from '../../lib/ai/schemas'

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
