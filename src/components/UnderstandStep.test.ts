import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import UnderstandStep from './UnderstandStep.svelte'
import type { AiRun } from '../lib/ai/run.svelte'
import type { VerdictResult, AttentionResult } from '../lib/ai/schemas'
import type { PrMeta, PrFile } from '../lib/github/types'

// Mock mermaid for MarkdownView (used by the component)
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg/>' }),
  },
}))

const meta: PrMeta = {
  title: 'Test PR',
  state: 'open',
  merged: false,
  body: 'PR desc\n## Heading',
  baseSha: 'base',
  headSha: 'head',
  private: false,
  changedFiles: 2,
}

const files: PrFile[] = [
  { filename: 'src/a.ts', status: 'modified', additions: 10, deletions: 5 },
  { filename: 'src/b.ts', status: 'added', additions: 20, deletions: 0 },
]

function makeRun(overrides: Partial<AiRun>): AiRun {
  return {
    summary: { status: 'idle' },
    attention: { status: 'idle' },
    diagrams: { status: 'idle' },
    verdict: { status: 'idle' },
    start: async () => {},
    retry: async () => {},
    ...overrides,
  }
}

/** Open all <details> elements so their content is queryable. */
function openAllDetails() {
  document.querySelectorAll('details').forEach((d) => { d.open = true })
}

// ---------------------------------------------------------------------------
// EC-15c/d — notAnalyzed shown/hidden
// ---------------------------------------------------------------------------

describe('UnderstandStep verdict notAnalyzed (EC-15c/d)', () => {
  it('hides notAnalyzed section when empty', () => {
    const verdict: VerdictResult = {
      level: 'behavior-preserved',
      evidence: ['clean'],
      notAnalyzed: [],
    }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(screen.queryByText('Not analyzed')).not.toBeInTheDocument()
  })

  it('shows notAnalyzed section when non-empty', () => {
    const verdict: VerdictResult = {
      level: 'minor-changes',
      evidence: ['e1'],
      notAnalyzed: ['skipped.ts'],
    }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(screen.getByText('Not analyzed')).toBeInTheDocument()
    expect(screen.getByText('skipped.ts')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Glance card — verdict pill
// ---------------------------------------------------------------------------

describe('UnderstandStep glance card — verdict pill', () => {
  it('shows verdict pill in glance card when verdict is done', () => {
    const verdict: VerdictResult = {
      level: 'minor-changes',
      evidence: [],
      notAnalyzed: [],
    }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    const { container } = render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run },
    })
    expect(container.querySelector('.verdict-level')).not.toBeNull()
    expect(container.querySelector('.verdict-level')?.textContent).toContain('minor-changes')
  })

  it('shows loading pill while verdict is loading', () => {
    const run = makeRun({ verdict: { status: 'loading' } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    expect(screen.getByLabelText(/verdict loading/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Glance card — file/line counts
// ---------------------------------------------------------------------------

describe('UnderstandStep glance card — file/line counts', () => {
  it('shows file count', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    expect(screen.getByText(/2 files/i)).toBeInTheDocument()
  })

  it('shows total additions from files', () => {
    const { container } = render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run: makeRun({}) },
    })
    // +30 total additions
    expect(container.textContent).toContain('+30')
  })

  it('shows total deletions from files', () => {
    const { container } = render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run: makeRun({}) },
    })
    // −5 total deletions
    expect(container.textContent).toContain('−5')
  })
})

// ---------------------------------------------------------------------------
// Glance card — TL;DR
// ---------------------------------------------------------------------------

describe('UnderstandStep glance card — TL;DR', () => {
  it('shows first sentence of stripped summary as TL;DR', () => {
    const summaryWithOrder =
      'This PR adds caching. More detail here.\n\n===READING-ORDER===\nsrc/a.ts\n===END==='
    const run = makeRun({ summary: { status: 'done', value: summaryWithOrder } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    expect(screen.getByText('This PR adds caching.')).toBeInTheDocument()
  })

  it('shows streaming text (clamped) while streaming', () => {
    const run = makeRun({ summary: { status: 'streaming', value: 'Streaming summary text' } })
    const { container } = render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run },
    })
    expect(container.querySelector('.tldr-streaming')).not.toBeNull()
  })

  it('shows "Add a DeepSeek key" link for no-key status', () => {
    const run = makeRun({ summary: { status: 'no-key' } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    expect(screen.getByText(/Add a DeepSeek key/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Glance card — hotspot chips (EC-06h)
// ---------------------------------------------------------------------------

describe('UnderstandStep glance card — hotspot chips', () => {
  it('shows top-3 high/medium hotspot chips', () => {
    const attention: AttentionResult = {
      readingOrder: [],
      hotspots: [
        { path: 'src/a.ts', reason: 'Critical change', level: 'high' },
        { path: 'src/b.ts', reason: 'Medium risk', level: 'medium' },
        { path: 'src/c.ts', reason: 'Also medium', level: 'medium' },
        { path: 'src/d.ts', reason: 'Low concern', level: 'low' },
      ],
      testFlags: [],
    }
    const run = makeRun({ attention: { status: 'done', value: attention } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    const chips = document.querySelectorAll('.hotspot-chip')
    expect(chips.length).toBe(3)
  })

  it('calls onhotspot when chip is clicked', async () => {
    const onhotspot = vi.fn()
    const attention: AttentionResult = {
      readingOrder: [],
      hotspots: [{ path: 'src/a.ts', reason: 'Risk', level: 'high' }],
      testFlags: [],
    }
    const run = makeRun({ attention: { status: 'done', value: attention } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run, onhotspot } })
    const chip = document.querySelector('.hotspot-chip') as HTMLButtonElement
    chip?.click()
    expect(onhotspot).toHaveBeenCalledWith('src/a.ts')
  })
})

// ---------------------------------------------------------------------------
// Glance card — mini churn chart
// ---------------------------------------------------------------------------

describe('UnderstandStep glance card — churn chart', () => {
  it('shows churn chart rows for files', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const rows = document.querySelectorAll('.churn-row')
    expect(rows.length).toBe(2)
  })

  it('each churn row has aria-label', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const rows = document.querySelectorAll('.churn-row[aria-label]')
    expect(rows.length).toBe(2)
  })

  it('calls onhotspot when churn row clicked', () => {
    const onhotspot = vi.fn()
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}), onhotspot } })
    const firstRow = document.querySelector('.churn-row') as HTMLButtonElement
    firstRow?.click()
    expect(onhotspot).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Detail panels — all collapsed by default
// ---------------------------------------------------------------------------

describe('UnderstandStep detail panels', () => {
  it('all detail panels are collapsed by default', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const details = document.querySelectorAll('details')
    details.forEach((d) => {
      expect(d.open).toBe(false)
    })
  })

  it('PR description is inside a collapsed <details> with "Original PR description" summary', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const prDetails = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/original pr description/i)
    )
    expect(prDetails).not.toBeUndefined()
    expect((prDetails as HTMLDetailsElement).open).toBe(false)
  })

  it('PR description renders ## heading as h2 when opened (MarkdownView)', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const prDetails = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/original pr description/i)
    ) as HTMLDetailsElement
    prDetails.open = true
    expect(prDetails.querySelector('h2')).not.toBeNull()
  })

  it('diagrams panel is a <details> with "Diagrams" summary', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const diagramsDetails = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/diagrams/i)
    )
    expect(diagramsDetails).not.toBeUndefined()
  })

  it('done-state summary renders markdown when "Full summary" panel opened', () => {
    const summaryWithHeading = '## What\nThis PR adds caching.\n\n===READING-ORDER===\nsrc/a.ts\n===END==='
    const run = makeRun({ summary: { status: 'done', value: summaryWithHeading } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(container.querySelector('h2')).not.toBeNull()
  })

  it('done-state summary: <script> is stripped (XSS)', () => {
    const summaryWithScript = 'Good PR. <script>alert(1)<\/script>'
    const run = makeRun({ summary: { status: 'done', value: summaryWithScript } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(container.querySelector('script')).toBeNull()
  })

  it('done-state summary: strips reading-order sentinel from display', () => {
    const summaryWithOrder = 'This PR refactors routing.\n\n===READING-ORDER===\nsrc/router.ts\nsrc/app.ts\n===END==='
    const run = makeRun({ summary: { status: 'done', value: summaryWithOrder } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(container.textContent).not.toContain('===READING-ORDER===')
    expect(container.textContent).not.toContain('src/router.ts')
    expect(container.textContent).toContain('This PR refactors routing.')
  })
})

// ---------------------------------------------------------------------------
// Panel states via AiPanel (still shown in collapsed panels)
// ---------------------------------------------------------------------------

describe('UnderstandStep panel states via AiPanel', () => {
  it('shows Retry button on summary error', () => {
    const run = makeRun({ summary: { status: 'error', error: 'something went wrong' } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('shows "AI analysis declined" for declined status', () => {
    const run = makeRun({ summary: { status: 'declined' } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(screen.getByText(/AI analysis declined/i)).toBeInTheDocument()
  })
})
