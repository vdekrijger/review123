import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import SummaryPanel from './SummaryPanel.svelte'
import { createAiRun } from '../../lib/ai/run.svelte'
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
    totalUsage: undefined,
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

  it('shows the skeleton when summary is idle — pending run, no blank gap', () => {
    const { container } = render(SummaryPanel, { props: { run: makeRun({ summary: { status: 'idle' } }) } })
    expect(container.querySelector('.ai-panel-loading .skeleton-block')).not.toBeNull()
    // Summary skeleton is text-shaped: 4 lines
    expect(container.querySelectorAll('.skeleton-line')).toHaveLength(4)
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

describe('SummaryPanel — real run state machine: pending → streaming → done', () => {
  it('skeleton from first render; swaps to stream at first token; markdown on done', async () => {
    // Active provider needs a key so start() proceeds past the no-key gate
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test' }))

    let emitDelta: ((d: string) => void) | undefined
    let finishStream: (() => void) | undefined
    const llmStreamWithUsage = vi.fn().mockImplementation(
      (_prompts: unknown, onDelta: (d: string) => void) => {
        emitDelta = onDelta
        return new Promise((resolve) => {
          finishStream = () => resolve({ content: 'First token and the rest.' })
        })
      },
    )
    // Other (JSON) tasks never settle — they stay pending throughout this test
    const neverSettles = new Promise(() => {})

    const run = createAiRun(
      {
        prKey: 'test-pr-key',
        repo: 'o/r',
        isPrivate: false,
        pack: async () => ({ text: 'ctx', notAnalyzed: [], includedFiles: [], importGraph: '' }),
        ci: async () => null,
        ask: async () => true,
      },
      {
        llmStreamWithUsage: llmStreamWithUsage as never,
        llmJsonWithRepairWithUsage: vi.fn().mockReturnValue(neverSettles) as never,
        getCached: vi.fn().mockResolvedValue(null),
        setCached: vi.fn().mockResolvedValue(undefined),
        gateAi: vi.fn().mockResolvedValue(true),
        track: vi.fn(),
      },
    )

    const { container } = render(SummaryPanel, { props: { run } })

    // PENDING (idle — start() not even called yet): skeleton from frame one
    expect(container.querySelector('.ai-panel-loading .skeleton-block')).not.toBeNull()

    void run.start() // never resolves (JSON tasks pending) — intentionally not awaited

    // Still pending while consent/pack/cache settle ('loading'): skeleton stays
    await waitFor(() => expect(llmStreamWithUsage).toHaveBeenCalled())
    expect(container.querySelector('.ai-panel-loading .skeleton-block')).not.toBeNull()
    expect(container.querySelector('pre.prose')).toBeNull()

    // First token: skeleton → streaming text swap
    emitDelta!('First token')
    await waitFor(() => expect(container.querySelector('pre.prose')).not.toBeNull())
    expect(container.querySelector('pre.prose')!.textContent).toContain('First token')
    expect(container.querySelector('.ai-panel-loading')).toBeNull()

    // Stream completes: done → markdown content, no skeleton, no stream pre
    finishStream!()
    await waitFor(() =>
      expect(container.textContent).toContain('First token and the rest.'),
    )
    await waitFor(() => expect(container.querySelector('pre.prose')).toBeNull())
    expect(container.querySelector('.ai-panel-loading')).toBeNull()

    localStorage.removeItem('review123:settings')
  })
})
