import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import OutcomesPanel from './OutcomesPanel.svelte'
import type { AiRun } from '../../lib/ai/run.svelte'
import type { ExpectedOutcomesResult } from '../../lib/ai/schemas'
import type { PrFile } from '../../lib/github/types'

function makeRun(overrides: Partial<AiRun>): AiRun {
  return {
    summary: { status: 'idle' },
    attention: { status: 'idle' },
    diagrams: { status: 'idle' },
    verdict: { status: 'idle' },
    tests: { status: 'idle' },
    alternatives: { status: 'idle' },
    intent: { status: 'idle' },
    outcomes: { status: 'idle' },
    story: { status: 'idle' },
    riskJudge: { status: 'idle' },
    skillReviews: [],
    convergence: { status: 'idle' },
    simplify: { status: 'idle' },
    totalUsage: undefined,
    verdictModels: [],
    modelPerformance: [],
    modelCostBreakdown: [],
    start: async () => {},
    retry: async () => {},
    coach: async () => ({ error: 'no-key' }),
    ask: async () => ({ ok: false, error: 'no-key' }),
    expandComment: async () => ({ ok: false, error: 'no-key' }),
    runSkillReviews: async () => {},
    retrySkill: async () => {},
    ...overrides,
  }
}

const FILES: PrFile[] = [
  { filename: 'src/review.ts', status: 'modified', additions: 5, deletions: 2 },
  { filename: 'src/review.test.ts', status: 'modified', additions: 8, deletions: 0 },
]

/** Test-file content NAMING postReview in a title; anchorFallback only called. */
const TEST_CONTENT = [
  "describe('postReview', () => {",
  "  it('posts at file level', () => {",
  '    anchorFallback(x)',
  '  })',
  '})',
].join('\n')

function makeContents(): Map<string, { before: string | null; after: string | null }> {
  return new Map([
    ['src/review.ts', { before: 'old', after: 'new' }],
    ['src/review.test.ts', { before: null, after: TEST_CONTENT }],
  ])
}

const RESULT: ExpectedOutcomesResult = {
  outcomes: [
    {
      id: 'o1',
      before: 'An off-diff comment failed the whole review.',
      after: 'It posts as a file-level comment.',
      evidence: [{ path: 'src/review.ts', line: 42 }],
      symbols: ['postReview'],
    },
    {
      id: 'o2',
      before: 'Retry storms hammered the API on every failure.',
      after: 'Failures back off exponentially.',
      evidence: [{ path: 'src/review.ts' }],
      symbols: ['unmatchedBackoffThing'],
    },
  ],
  withoutThis: 'Off-diff comments keep failing the whole review.',
}

function renderDone(
  result: ExpectedOutcomesResult = RESULT,
  {
    contentsMap = makeContents() as Map<string, { before: string | null; after: string | null }> | null,
    onhotspot = undefined as ((path: string) => void) | undefined,
  } = {},
) {
  return render(OutcomesPanel, {
    props: {
      run: makeRun({ outcomes: { status: 'done', value: result } }),
      files: FILES,
      contentsMap,
      onhotspot,
    },
  })
}

describe('OutcomesPanel — states', () => {
  it('disabled (task off in settings) shows the standard muted disabled state', () => {
    render(OutcomesPanel, {
      props: { run: makeRun({ outcomes: { status: 'disabled' } }), files: FILES, contentsMap: null },
    })
    expect(screen.getByText(/enable in AI settings/i)).toBeInTheDocument()
  })

  it('error state shows the message + concrete detail and Retry wired to retry("outcomes")', async () => {
    const retry = vi.fn()
    render(OutcomesPanel, {
      props: {
        run: makeRun({ outcomes: { status: 'error', error: 'Server error.', errorDetail: 'HTTP 500: boom' }, retry }),
        files: FILES,
        contentsMap: null,
      },
    })
    expect(screen.getByText('Server error.')).toBeInTheDocument()
    expect(screen.getByText('HTTP 500: boom')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledWith('outcomes')
  })

  it('empty outcomes render the calm no-observable-changes note (never an error)', () => {
    renderDone({ outcomes: [], withoutThis: '' })
    expect(screen.getByText(/No observable behavior changes derived/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('OutcomesPanel — outcome rows', () => {
  it('renders each outcome as a numbered row with the before → after pair', () => {
    renderDone()
    expect(screen.getByText('An off-diff comment failed the whole review.')).toBeInTheDocument()
    expect(screen.getByText('It posts as a file-level comment.')).toBeInTheDocument()
    expect(screen.getByText('Retry storms hammered the API on every failure.')).toBeInTheDocument()
    expect(screen.getByText('Failures back off exponentially.')).toBeInTheDocument()
    // Numbered list semantics + the Before/After labels.
    expect(document.querySelectorAll('ol.outcome-list li')).toHaveLength(2)
    expect(screen.getAllByText('Before')).toHaveLength(2)
    expect(screen.getAllByText('After')).toHaveLength(2)
  })

  it('evidence links jump to the file via onhotspot (path with line rendered as path:line)', async () => {
    const onhotspot = vi.fn()
    renderDone(RESULT, { onhotspot })
    const link = screen.getByRole('button', { name: 'src/review.ts:42' })
    await fireEvent.click(link)
    expect(onhotspot).toHaveBeenCalledWith('src/review.ts')
  })
})

describe('OutcomesPanel — deterministic test chips', () => {
  it('an outcome whose symbol a changed test NAMES gets the asserted-by chip (no "likely")', () => {
    renderDone()
    expect(screen.getByText('asserted by')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'src/review.test.ts' })).toBeInTheDocument()
    // Named match → no likely qualifier anywhere.
    expect(screen.queryByText('(likely)')).toBeNull()
  })

  it('a referenced-only match carries the "(likely)" qualifier (#95 confidence language)', () => {
    const referencedOnly: ExpectedOutcomesResult = {
      outcomes: [{
        id: 'o1',
        before: 'b',
        after: 'a',
        evidence: [],
        symbols: ['anchorFallback'], // only CALLED in the test body, never titled
      }],
      withoutThis: '',
    }
    renderDone(referencedOnly)
    expect(screen.getByText('asserted by')).toBeInTheDocument()
    expect(screen.getByText('(likely)')).toBeInTheDocument()
  })

  it('an outcome with no matching test gets the honest, calm no-test note', () => {
    renderDone()
    expect(screen.getByText('no test asserts this outcome')).toBeInTheDocument()
    // Calm styling, not an alert.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('clicking the asserted-by test link jumps to the test file via onhotspot', async () => {
    const onhotspot = vi.fn()
    renderDone(RESULT, { onhotspot })
    await fireEvent.click(screen.getByRole('button', { name: 'src/review.test.ts' }))
    expect(onhotspot).toHaveBeenCalledWith('src/review.test.ts')
  })

  it('renders NO chips while contentsMap is still null — no claim before the contents arrive', () => {
    renderDone(RESULT, { contentsMap: null })
    expect(screen.queryByText('asserted by')).toBeNull()
    expect(screen.queryByText('no test asserts this outcome')).toBeNull()
    // The rows themselves still render.
    expect(screen.getByText('It posts as a file-level comment.')).toBeInTheDocument()
  })
})

describe('OutcomesPanel — withoutThis footer', () => {
  it('renders the quiet necessity footer when present', () => {
    renderDone()
    expect(screen.getByText('Without this change:')).toBeInTheDocument()
    expect(screen.getByText('Off-diff comments keep failing the whole review.')).toBeInTheDocument()
  })

  it('hides the footer when withoutThis is empty/blank', () => {
    renderDone({ ...RESULT, withoutThis: '   ' })
    expect(screen.queryByText('Without this change:')).toBeNull()
  })
})
