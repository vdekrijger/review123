import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import VerdictPanel from './VerdictPanel.svelte'
import type { AiRun } from '../../lib/ai/run.svelte'
import type { VerdictResult } from '../../lib/ai/schemas'

// Mock mermaid (MarkdownView)
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

describe('VerdictPanel', () => {
  it('shows no-key message when verdict status is no-key', () => {
    render(VerdictPanel, { props: { run: makeRun({ verdict: { status: 'no-key' } }) } })
    expect(screen.getByText(/Add a DeepSeek key/i)).toBeInTheDocument()
  })

  it('renders evidence items', () => {
    const verdict: VerdictResult = {
      level: 'minor-changes',
      evidence: ['Change in src/foo.ts: no side effects'],
      notAnalyzed: [],
    }
    render(VerdictPanel, {
      props: { run: makeRun({ verdict: { status: 'done', value: verdict } }) },
    })
    expect(screen.getByText(/no side effects/i)).toBeInTheDocument()
  })

  it('shows notAnalyzed paths when non-empty', () => {
    const verdict: VerdictResult = {
      level: 'significant-changes',
      evidence: [],
      notAnalyzed: ['src/skipped.ts'],
    }
    render(VerdictPanel, {
      props: { run: makeRun({ verdict: { status: 'done', value: verdict } }) },
    })
    expect(screen.getByText('Not analyzed')).toBeInTheDocument()
    expect(screen.getByText('src/skipped.ts')).toBeInTheDocument()
  })

  it('hides notAnalyzed section when empty', () => {
    const verdict: VerdictResult = {
      level: 'behavior-preserved',
      evidence: ['all good'],
      notAnalyzed: [],
    }
    render(VerdictPanel, {
      props: { run: makeRun({ verdict: { status: 'done', value: verdict } }) },
    })
    expect(screen.queryByText('Not analyzed')).not.toBeInTheDocument()
  })

  it('calls onhotspot when evidence path chip is clicked', async () => {
    const onhotspot = vi.fn()
    const verdict: VerdictResult = {
      level: 'minor-changes',
      evidence: ['src/bar.ts: minor refactor'],
      notAnalyzed: [],
    }
    render(VerdictPanel, {
      props: { run: makeRun({ verdict: { status: 'done', value: verdict } }), onhotspot },
    })
    const chip = screen.getByRole('button', { name: /Jump to src\/bar\.ts/i })
    chip.click()
    expect(onhotspot).toHaveBeenCalledWith('src/bar.ts')
  })
})
