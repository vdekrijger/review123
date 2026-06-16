import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import UnderstandStep from './UnderstandStep.svelte'
import type { AiRun } from '../lib/ai/run.svelte'
import type { VerdictResult, AttentionResult, TestInsight } from '../lib/ai/schemas'
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
  authorLogin: null,
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

  it('shows the unified verdict status line while verdict is loading', () => {
    const run = makeRun({ verdict: { status: 'loading' } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    // Unified per-task status copy from aiProgressLabel('verdict') — appears in
    // the compact glance pill (and, consistently, in the Verdict detail panel).
    const pill = container.querySelector('.glance-loading-pill')
    expect(pill).not.toBeNull()
    expect(pill!.textContent).toMatch(/forming a verdict…/i)
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

  it('done-state TL;DR with backticks renders a <code> element (not raw backticks)', () => {
    const summaryWithCode =
      'This PR updates `handleError`. More details here.\n\n===READING-ORDER===\nsrc/a.ts\n===END==='
    const run = makeRun({ summary: { status: 'done', value: summaryWithCode } })
    const { container } = render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run },
    })
    const tldrRow = container.querySelector('.glance-row-tldr')
    expect(tldrRow).not.toBeNull()
    const codeEl = tldrRow!.querySelector('code')
    expect(codeEl).not.toBeNull()
    expect(codeEl!.textContent).toBe('handleError')
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
    // Only check the top-level detail panels (.detail-panel), not inner <details>
    // inside sub-components like FileTree (which opens directory nodes by default).
    const panels = document.querySelectorAll('.detail-panel')
    panels.forEach((d) => {
      expect((d as HTMLDetailsElement).open).toBe(false)
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
      (d) => d.querySelector('summary')?.textContent?.match(/execution flow/i)
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

// ---------------------------------------------------------------------------
// Tests chip — glance card Row 1 (D2)
// ---------------------------------------------------------------------------

const sampleTests: TestInsight = {
  covered: [
    { behavior: 'renders correctly', test: 'it renders', file: 'src/a.test.ts' },
    { behavior: 'handles errors', test: 'it throws', file: 'src/b.test.ts' },
  ],
  gaps: ['edge case not covered'],
}

describe('UnderstandStep glance card — tests chip', () => {
  it('renders tests chip with covered count when tests is done', () => {
    const run = makeRun({ tests: { status: 'done', value: sampleTests } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    expect(container.querySelector('.tests-chip')).not.toBeNull()
    expect(container.querySelector('.tests-chip-covered')?.textContent).toContain('2 behaviors tested')
  })

  it('renders gaps chip in amber when gaps > 0', () => {
    const run = makeRun({ tests: { status: 'done', value: sampleTests } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    const gapsChip = container.querySelector('.tests-chip-gaps')
    expect(gapsChip).not.toBeNull()
    expect(gapsChip?.textContent).toContain('1 gaps')
  })

  it('does not render gaps chip when gaps is empty', () => {
    const noGapTests: TestInsight = { covered: sampleTests.covered, gaps: [] }
    const run = makeRun({ tests: { status: 'done', value: noGapTests } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    expect(container.querySelector('.tests-chip-gaps')).toBeNull()
  })

  it('shows inline loading indicator while tests is loading', () => {
    const run = makeRun({ tests: { status: 'loading' } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    // Tests chip should not appear
    expect(container.querySelector('.tests-chip')).toBeNull()
    // Loading indicator should appear
    const loadingEls = container.querySelectorAll('.glance-loading-inline')
    expect(loadingEls.length).toBeGreaterThan(0)
  })

  it('does not show tests chip when tests is idle', () => {
    const run = makeRun({ tests: { status: 'idle' } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    expect(container.querySelector('.tests-chip')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Test coverage panel — checklist rows, file link, AI-inferred wording (D2)
// ---------------------------------------------------------------------------

describe('UnderstandStep test coverage panel', () => {
  it('renders "Test coverage (AI-inferred)" panel summary', () => {
    const run = makeRun({ tests: { status: 'idle' } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    const testPanel = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/test coverage.*ai-inferred/i)
    )
    expect(testPanel).not.toBeUndefined()
  })

  it('panel is collapsed by default', () => {
    const run = makeRun({ tests: { status: 'done', value: sampleTests } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    const testPanel = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/test coverage.*ai-inferred/i)
    ) as HTMLDetailsElement
    expect(testPanel.open).toBe(false)
  })

  it('renders compact covered rows: behavior visible, test name in row tooltip', () => {
    const run = makeRun({ tests: { status: 'done', value: sampleTests } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    // Behavior title stays visible
    expect(screen.getByText('renders correctly')).toBeInTheDocument()
    // Test name is de-emphasized into the compact row's title tooltip (not a full line)
    const compactRow = document.querySelector('.tests-covered-item--compact') as HTMLElement
    expect(compactRow).not.toBeNull()
    expect(compactRow.getAttribute('title')).toContain('it renders')
  })

  it('renders a compact covered summary count', () => {
    const run = makeRun({ tests: { status: 'done', value: sampleTests } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(screen.getByText(/2\s+behaviors?\s+covered/i)).toBeInTheDocument()
  })

  it('renders file as a button in covered rows', () => {
    const run = makeRun({ tests: { status: 'done', value: sampleTests } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    const fileLinks = document.querySelectorAll('.tests-file-link')
    expect(fileLinks.length).toBe(2)
    expect(fileLinks[0].textContent).toContain('src/a.test.ts')
  })

  it('calls onhotspot with file path when file link is clicked', () => {
    const onhotspot = vi.fn()
    const run = makeRun({ tests: { status: 'done', value: sampleTests } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run, onhotspot } })
    openAllDetails()
    const firstFileLink = document.querySelector('.tests-file-link') as HTMLButtonElement
    firstFileLink?.click()
    expect(onhotspot).toHaveBeenCalledWith('src/a.test.ts')
  })

  it('renders gaps as warning rows', () => {
    const run = makeRun({ tests: { status: 'done', value: sampleTests } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(screen.getByText('edge case not covered')).toBeInTheDocument()
    const gapIcons = document.querySelectorAll('.tests-gap-icon')
    expect(gapIcons.length).toBe(1)
  })

  it('uses "AI-inferred" wording in panel (EC-13d)', () => {
    const run = makeRun({ tests: { status: 'done', value: sampleTests } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(container.textContent?.toLowerCase()).toContain('ai-inferred')
  })

  it('error state shows Retry button that calls run.retry("tests")', () => {
    const retryFn = vi.fn()
    const run = makeRun({ tests: { status: 'error', error: 'tests failed' }, retry: retryFn })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    // Find the retry button inside the tests panel
    const testPanel = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/test coverage.*ai-inferred/i)
    ) as HTMLDetailsElement
    const retryBtn = testPanel?.querySelector('button.retry-btn') as HTMLButtonElement
    expect(retryBtn).not.toBeNull()
    retryBtn?.click()
    expect(retryFn).toHaveBeenCalledWith('tests')
  })
})

// ---------------------------------------------------------------------------
// Alternatives panel (Plan F)
// ---------------------------------------------------------------------------

import type { AlternativesResult } from '../lib/ai/schemas'

const sampleAlternatives: AlternativesResult = {
  problem: 'The PR adds a global singleton cache without request isolation.',
  alternatives: [
    {
      approach: 'Use a WeakMap keyed by request context for per-request isolation.',
      tradeoffs: 'Better isolation at the cost of more boilerplate.',
      assessment: 'alternative-is-better',
      rationale: 'Avoids shared state leaks across concurrent requests.',
    },
    {
      approach: 'Keep singleton but add a reset() for tests.',
      tradeoffs: 'Minimal change but still global state.',
      assessment: 'pr-is-better',
      rationale: 'Simple enough for the current use case.',
    },
    {
      approach: 'Use a module-level cache with a different goals scope.',
      tradeoffs: 'Solves a different problem entirely.',
      assessment: 'different-goals',
      rationale: 'Addresses service-level caching not request-level.',
    },
  ],
}

describe('UnderstandStep alternatives panel', () => {
  it('renders "Alternative approaches (AI)" panel summary', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const altPanel = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/alternative approaches.*ai/i)
    )
    expect(altPanel).not.toBeUndefined()
  })

  it('panel is collapsed by default', () => {
    const run = makeRun({ alternatives: { status: 'done', value: sampleAlternatives } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    const altPanel = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/alternative approaches.*ai/i)
    ) as HTMLDetailsElement
    expect(altPanel.open).toBe(false)
  })

  it('renders problem statement when open', () => {
    const run = makeRun({ alternatives: { status: 'done', value: sampleAlternatives } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(screen.getByText(sampleAlternatives.problem)).toBeInTheDocument()
  })

  it('renders one card per alternative', () => {
    const run = makeRun({ alternatives: { status: 'done', value: sampleAlternatives } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    const cards = container.querySelectorAll('.alternative-card')
    expect(cards.length).toBe(3)
  })

  it('renders assessment chip for pr-is-better with green class', () => {
    const prBetterOnly: AlternativesResult = {
      problem: 'A problem.',
      alternatives: [
        { approach: 'Use a function.', tradeoffs: 'Cleaner but verbose.', assessment: 'pr-is-better', rationale: 'Simple is better.' },
      ],
    }
    const run = makeRun({ alternatives: { status: 'done', value: prBetterOnly } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    const chip = container.querySelector('.assessment-chip.assessment-pr-is-better')
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toContain("PR's approach is better")
  })

  it('renders assessment chip for comparable with muted class', () => {
    const comparableOnly: AlternativesResult = {
      problem: 'A problem.',
      alternatives: [
        { approach: 'Similar alt.', tradeoffs: 'Same tradeoffs.', assessment: 'comparable', rationale: 'Either works.' },
      ],
    }
    const run = makeRun({ alternatives: { status: 'done', value: comparableOnly } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    const chip = container.querySelector('.assessment-chip.assessment-comparable')
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toContain('Comparable')
  })

  it('renders assessment chip for alternative-is-better with amber class', () => {
    const worthConsidering: AlternativesResult = {
      problem: 'A problem.',
      alternatives: [
        { approach: 'Better alt.', tradeoffs: 'Better tradeoffs.', assessment: 'alternative-is-better', rationale: 'Clearly better.' },
      ],
    }
    const run = makeRun({ alternatives: { status: 'done', value: worthConsidering } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    const chip = container.querySelector('.assessment-chip.assessment-alternative-is-better')
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toContain('Worth considering')
  })

  it('renders assessment chip for different-goals with blue class', () => {
    const diffGoals: AlternativesResult = {
      problem: 'A problem.',
      alternatives: [
        { approach: 'Different scope.', tradeoffs: 'Different goals.', assessment: 'different-goals', rationale: 'Solves another problem.' },
      ],
    }
    const run = makeRun({ alternatives: { status: 'done', value: diffGoals } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    const chip = container.querySelector('.assessment-chip.assessment-different-goals')
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toContain('Different goals')
  })

  it('shows glance chip only when any alternative has assessment alternative-is-better', () => {
    const run = makeRun({ alternatives: { status: 'done', value: sampleAlternatives } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    // sampleAlternatives has one 'alternative-is-better'
    const glanceChip = container.querySelector('.alternatives-glance-chip')
    expect(glanceChip).not.toBeNull()
  })

  it('does not show glance chip when no alternative-is-better assessment', () => {
    const prBetterOnly: AlternativesResult = {
      problem: 'A problem.',
      alternatives: [
        { approach: 'Use a function.', tradeoffs: 'Cleaner.', assessment: 'pr-is-better', rationale: 'Simple is better.' },
        { approach: 'Use a class.', tradeoffs: 'More OOP.', assessment: 'comparable', rationale: 'Either works.' },
      ],
    }
    const run = makeRun({ alternatives: { status: 'done', value: prBetterOnly } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    const glanceChip = container.querySelector('.alternatives-glance-chip')
    expect(glanceChip).toBeNull()
  })

  it('does not show glance chip when alternatives is idle', () => {
    const run = makeRun({ alternatives: { status: 'idle' } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    const glanceChip = container.querySelector('.alternatives-glance-chip')
    expect(glanceChip).toBeNull()
  })

  it('error state shows Retry button that calls run.retry("alternatives")', () => {
    const retryFn = vi.fn()
    const run = makeRun({ alternatives: { status: 'error', error: 'alternatives failed' }, retry: retryFn })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    const altPanel = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/alternative approaches.*ai/i)
    ) as HTMLDetailsElement
    const retryBtn = altPanel?.querySelector('button.retry-btn') as HTMLButtonElement
    expect(retryBtn).not.toBeNull()
    retryBtn?.click()
    expect(retryFn).toHaveBeenCalledWith('alternatives')
  })

  it('shows empty state when alternatives array is empty', () => {
    const emptyAlts: AlternativesResult = {
      problem: 'The approach is straightforward.',
      alternatives: [],
    }
    const run = makeRun({ alternatives: { status: 'done', value: emptyAlts } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(screen.getByText(/no meaningfully different alternatives/i)).toBeInTheDocument()
  })

  it('renders rationale text for each alternative', () => {
    const run = makeRun({ alternatives: { status: 'done', value: sampleAlternatives } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(screen.getByText('Avoids shared state leaks across concurrent requests.')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Fix: alternative card titles must render FULL approach text (no truncation)
// Regression: approach containing "e.g." was cut off at first period
// ---------------------------------------------------------------------------

describe('UnderstandStep alternatives panel — full approach text (no truncation)', () => {
  it('renders the full approach text including text after a period', () => {
    const withPeriod: AlternativesResult = {
      problem: 'A problem.',
      alternatives: [
        {
          approach: 'Use a context object to make the edit mode transition instantaneous (e.g. via a flag).',
          tradeoffs: 'Tradeoffs here.',
          assessment: 'pr-is-better',
          rationale: 'Simple is better.',
        },
      ],
    }
    const run = makeRun({ alternatives: { status: 'done', value: withPeriod } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    // The full text must be visible — not truncated at the first period
    expect(
      screen.getByText(
        'Use a context object to make the edit mode transition instantaneous (e.g. via a flag).'
      )
    ).toBeInTheDocument()
  })

  it('does NOT show a truncated version (split at first period) of the approach', () => {
    const withPeriod: AlternativesResult = {
      problem: 'A problem.',
      alternatives: [
        {
          approach: 'Use a context object to make the edit mode transition instantaneous (e.g. via a flag).',
          tradeoffs: 'Tradeoffs here.',
          assessment: 'pr-is-better',
          rationale: 'Simple is better.',
        },
      ],
    }
    const run = makeRun({ alternatives: { status: 'done', value: withPeriod } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    // The truncated version "Use a context object to make the edit mode transition instantaneous (e."
    // must NOT appear as the card heading
    const cards = document.querySelectorAll('.alternative-card .alternative-approach')
    expect(cards.length).toBe(1)
    expect(cards[0].textContent).not.toBe('Use a context object to make the edit mode transition instantaneous (e.')
  })

  it('approach with no period renders its full text', () => {
    const noPeriod: AlternativesResult = {
      problem: 'A problem.',
      alternatives: [
        {
          approach: 'Extract logic into a separate module for better testability',
          tradeoffs: 'Tradeoffs.',
          assessment: 'comparable',
          rationale: 'Either works.',
        },
      ],
    }
    const run = makeRun({ alternatives: { status: 'done', value: noPeriod } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(
      screen.getByText('Extract logic into a separate module for better testability')
    ).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Verdict evidence panel — MarkdownView, path chips, clamping + expand
// ---------------------------------------------------------------------------

describe('UnderstandStep verdict evidence panel', () => {
  it('renders evidence items with MarkdownView (code spans become <code>)', () => {
    const verdict: VerdictResult = {
      level: 'behavior-preserved',
      evidence: ['The `getCache` function works correctly'],
      notAnalyzed: [],
    }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    const { container } = render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run },
    })
    openAllDetails()
    // MarkdownView renders backtick-wrapped text as <code> elements
    const codeEl = container.querySelector('.evidence-text code')
    expect(codeEl).not.toBeNull()
    expect(codeEl!.textContent).toBe('getCache')
  })

  it('renders a path chip when evidence item contains a recognizable path', () => {
    const verdict: VerdictResult = {
      level: 'minor-changes',
      evidence: ['src/lib/cache.ts: the cache correctly handles expiry'],
      notAnalyzed: [],
    }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run },
    })
    openAllDetails()
    const chip = screen.getByRole('button', { name: /jump to src\/lib\/cache\.ts/i })
    expect(chip).toBeInTheDocument()
    expect(chip.textContent).toContain('src/lib/cache.ts')
  })

  it('path chip click calls onhotspot with the path', async () => {
    const user = userEvent.setup()
    const onhotspot = vi.fn()
    const verdict: VerdictResult = {
      level: 'minor-changes',
      evidence: ['src/lib/cache.ts: handles edge case'],
      notAnalyzed: [],
    }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run, onhotspot },
    })
    openAllDetails()
    const chip = screen.getByRole('button', { name: /jump to src\/lib\/cache\.ts/i })
    await user.click(chip)
    expect(onhotspot).toHaveBeenCalledWith('src/lib/cache.ts')
  })

  it('does not render a path chip when evidence item has no file path', () => {
    const verdict: VerdictResult = {
      level: 'behavior-preserved',
      evidence: ['All public APIs are unchanged'],
      notAnalyzed: [],
    }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    const { container } = render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run },
    })
    openAllDetails()
    expect(container.querySelector('.evidence-path-chip')).toBeNull()
  })

  it('clamps to first 5 evidence items by default', () => {
    const verdict: VerdictResult = {
      level: 'behavior-preserved',
      evidence: ['item 1', 'item 2', 'item 3', 'item 4', 'item 5', 'item 6', 'item 7'],
      notAnalyzed: [],
    }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run },
    })
    openAllDetails()
    // item 6 and 7 should not be visible
    expect(screen.queryByText('item 6')).not.toBeInTheDocument()
    expect(screen.queryByText('item 7')).not.toBeInTheDocument()
    // item 5 should be visible
    expect(screen.getByText('item 5')).toBeInTheDocument()
  })

  it('shows "Show all N" expander button when more than 5 items', () => {
    const verdict: VerdictResult = {
      level: 'behavior-preserved',
      evidence: Array.from({ length: 7 }, (_, i) => `item ${i + 1}`),
      notAnalyzed: [],
    }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run },
    })
    openAllDetails()
    const expander = screen.getByRole('button', { name: /show all 7/i })
    expect(expander).toBeInTheDocument()
  })

  it('expands to show all items when "Show all N" is clicked', async () => {
    const user = userEvent.setup()
    const verdict: VerdictResult = {
      level: 'behavior-preserved',
      evidence: Array.from({ length: 7 }, (_, i) => `item ${i + 1}`),
      notAnalyzed: [],
    }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run },
    })
    openAllDetails()
    const expander = screen.getByRole('button', { name: /show all 7/i })
    await user.click(expander)
    // All items now visible
    expect(screen.getByText('item 6')).toBeInTheDocument()
    expect(screen.getByText('item 7')).toBeInTheDocument()
    // Button now says "Show less"
    expect(screen.getByRole('button', { name: /show less/i })).toBeInTheDocument()
  })

  it('does not show expander when 5 or fewer evidence items', () => {
    const verdict: VerdictResult = {
      level: 'behavior-preserved',
      evidence: ['item 1', 'item 2', 'item 3'],
      notAnalyzed: [],
    }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run },
    })
    openAllDetails()
    expect(screen.queryByRole('button', { name: /show all/i })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Test coverage panel — per-file grouping (ai-quality-round2)
// gaps with file-path prefix render ONE header per file;
// gaps without path prefix go in a General bucket.
// ---------------------------------------------------------------------------

describe('UnderstandStep test coverage panel — per-file gap grouping', () => {
  it('renders one group header per unique file in gaps', () => {
    const groupedTests: TestInsight = {
      covered: [],
      gaps: [
        'src/lib/cache.ts: cache expiry not tested',
        'src/lib/cache.ts: concurrent access not tested',
        'src/routes/Review.svelte: retry on error not tested',
      ],
    }
    const run = makeRun({ tests: { status: 'done', value: groupedTests } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    const headers = container.querySelectorAll('.tests-gap-file-header')
    // Should have exactly 2 unique file headers
    expect(headers.length).toBe(2)
  })

  it('each group header shows the file path without repeating it in entries', () => {
    const groupedTests: TestInsight = {
      covered: [],
      gaps: [
        'src/lib/cache.ts: cache expiry not tested',
        'src/lib/cache.ts: concurrent access not tested',
      ],
    }
    const run = makeRun({ tests: { status: 'done', value: groupedTests } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    const headers = container.querySelectorAll('.tests-gap-file-header')
    expect(headers.length).toBe(1)
    expect(headers[0].textContent).toContain('src/lib/cache.ts')
    // Entries under the header should NOT re-include the full path
    const items = container.querySelectorAll('.tests-gap-item')
    // Both items should exist
    expect(items.length).toBe(2)
  })

  it('gaps without file path prefix go into General bucket', () => {
    const mixedTests: TestInsight = {
      covered: [],
      gaps: [
        'src/foo.ts: some file-specific gap',
        'General behavior not covered anywhere',
      ],
    }
    const run = makeRun({ tests: { status: 'done', value: mixedTests } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    // Should have file header for src/foo.ts
    const headers = container.querySelectorAll('.tests-gap-file-header')
    expect(headers.length).toBeGreaterThanOrEqual(1)
    // Should have a General bucket header
    const generalHeader = Array.from(headers).find(h => h.textContent?.match(/general/i))
    expect(generalHeader).not.toBeUndefined()
  })

  it('file header is clickable and calls onhotspot with the file path', () => {
    const onhotspot = vi.fn()
    const groupedTests: TestInsight = {
      covered: [],
      gaps: ['src/lib/cache.ts: missing test'],
    }
    const run = makeRun({ tests: { status: 'done', value: groupedTests } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run, onhotspot } })
    openAllDetails()
    const header = container.querySelector('.tests-gap-file-header') as HTMLElement
    header?.click()
    expect(onhotspot).toHaveBeenCalledWith('src/lib/cache.ts')
  })

  it('ungrouped gaps (no path prefix) still render gap text', () => {
    const generalGaps: TestInsight = {
      covered: [],
      gaps: ['Some general gap with no file prefix'],
    }
    const run = makeRun({ tests: { status: 'done', value: generalGaps } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    expect(screen.getByText('Some general gap with no file prefix')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Registry order: summary + diagrams appear ABOVE file-structure
// ---------------------------------------------------------------------------

describe('UnderstandStep — registry section order', () => {
  it('Full summary panel appears before Changed files in DOM order', () => {
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const panels = Array.from(container.querySelectorAll('.detail-panel'))
    const summaryIdx = panels.findIndex((p) => p.querySelector('summary')?.textContent?.match(/full summary/i))
    const fileStructureIdx = panels.findIndex((p) => p.querySelector('summary')?.textContent?.match(/changed files.*structure/i))
    expect(summaryIdx).toBeGreaterThanOrEqual(0)
    expect(fileStructureIdx).toBeGreaterThan(summaryIdx)
  })

  it('Diagrams panel appears before Changed files in DOM order', () => {
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const panels = Array.from(container.querySelectorAll('.detail-panel'))
    const diagramsIdx = panels.findIndex((p) => p.querySelector('summary')?.textContent?.match(/execution flow/i))
    const fileStructureIdx = panels.findIndex((p) => p.querySelector('summary')?.textContent?.match(/changed files.*structure/i))
    expect(diagramsIdx).toBeGreaterThanOrEqual(0)
    expect(fileStructureIdx).toBeGreaterThan(diagramsIdx)
  })

  it('panel order is: summary, diagrams, file-structure, test-insight, alternatives, verdict-evidence, ci-details, pr-description', () => {
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const summaries = Array.from(container.querySelectorAll('.detail-panel summary'))
    const texts = summaries.map((s) => s.textContent?.toLowerCase() ?? '')
    const orderedKeywords = ['summary', 'execution flow', 'changed files', 'test coverage', 'alternative', 'verdict', 'ci details', 'pr description']
    let lastIdx = -1
    for (const keyword of orderedKeywords) {
      const idx = texts.findIndex((t, i) => i > lastIdx && t.includes(keyword))
      expect(idx).toBeGreaterThan(lastIdx)
      lastIdx = idx
    }
  })
})

// ---------------------------------------------------------------------------
// Verdict evidence layout: chip stacked above prose (no flex row)
// ---------------------------------------------------------------------------

describe('UnderstandStep verdict evidence layout — chip stacked above prose', () => {
  it('verdict-evidence-row has display:block (not flex)', () => {
    const verdict: VerdictResult = {
      level: 'minor-changes',
      evidence: ['src/lib/cache.ts: the cache handles expiry'],
      notAnalyzed: [],
    }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    const row = container.querySelector('.verdict-evidence-row') as HTMLElement
    expect(row).not.toBeNull()
    // CSS computed style won't work in jsdom, but we can assert the class exists
    // and that there is no inline flex style
    expect(row.style.display).not.toBe('flex')
  })

  it('evidence-path-chip is an inline-block element inside the row', () => {
    const verdict: VerdictResult = {
      level: 'minor-changes',
      evidence: ['src/lib/cache.ts: the cache handles expiry'],
      notAnalyzed: [],
    }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    const chip = container.querySelector('.evidence-path-chip') as HTMLElement
    expect(chip).not.toBeNull()
    // Chip must not be set to flex via inline style
    expect(chip.style.display).not.toBe('flex')
  })

  it('evidence-text renders as a sibling to the chip (not a flex child)', () => {
    const verdict: VerdictResult = {
      level: 'behavior-preserved',
      evidence: ['src/a.ts: clean implementation'],
      notAnalyzed: [],
    }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    const { container } = render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    openAllDetails()
    const row = container.querySelector('.verdict-evidence-row')
    const chip = row?.querySelector('.evidence-path-chip')
    const text = row?.querySelector('.evidence-text')
    // Both exist inside the row
    expect(chip).not.toBeNull()
    expect(text).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// File structure section (new: collapsed <details> with mini FileTree)
// ---------------------------------------------------------------------------

describe('UnderstandStep — file structure section', () => {
  it('renders a "Changed files — structure" collapsed details section', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const structurePanel = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/changed files.*structure/i)
    )
    expect(structurePanel).not.toBeUndefined()
    // Must be collapsed by default
    expect((structurePanel as HTMLDetailsElement).open).toBe(false)
  })

  it('renders file tree nodes inside the structure section when opened', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const structurePanel = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/changed files.*structure/i)
    ) as HTMLDetailsElement
    structurePanel.open = true
    // FileTree renders file names as buttons
    expect(structurePanel.querySelector('.file-btn')).not.toBeNull()
  })

  it('file tree in structure section shows both files', () => {
    const { container } = render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run: makeRun({}) },
    })
    const structurePanel = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/changed files.*structure/i)
    ) as HTMLDetailsElement
    structurePanel.open = true
    // Both files from the `files` fixture should appear as buttons
    const fileBtns = structurePanel.querySelectorAll('.file-btn')
    expect(fileBtns.length).toBe(2)
  })

  it('selecting a file node in structure section calls onhotspot with the path', async () => {
    const onhotspot = vi.fn()
    render(UnderstandStep, {
      props: { meta, files, ci: null, ciError: false, run: makeRun({}), onhotspot },
    })
    const structurePanel = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/changed files.*structure/i)
    ) as HTMLDetailsElement
    structurePanel.open = true

    const firstFileBtn = structurePanel.querySelector('.file-btn') as HTMLButtonElement
    firstFileBtn?.click()
    expect(onhotspot).toHaveBeenCalled()
  })

  it('structure section shows hotspot dots when attention is done', () => {
    const attention: AttentionResult = {
      readingOrder: [],
      hotspots: [{ path: 'src/a.ts', reason: 'Critical change', level: 'high' }],
      testFlags: [],
    }
    const run = makeRun({ attention: { status: 'done', value: attention } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    const structurePanel = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/changed files.*structure/i)
    ) as HTMLDetailsElement
    structurePanel.open = true

    // FileTree renders hotspot dots as .hotspot-dot elements
    const dot = structurePanel.querySelector('.hotspot-dot.level-high')
    expect(dot).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Expand all / Collapse all — one bulk toggle (feat/expand-all-section-status)
// ---------------------------------------------------------------------------

describe('UnderstandStep — expand all / collapse all', () => {
  function pagePanels() {
    return Array.from(document.querySelectorAll('.detail-panel')) as HTMLDetailsElement[]
  }

  it('renders an Expand all button when sections are collapsed (default)', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const btn = screen.getByRole('button', { name: /expand all sections/i })
    expect(btn).toBeInTheDocument()
    expect(btn.textContent).toMatch(/expand all/i)
    // Not all expanded → aria-pressed false
    expect(btn.getAttribute('aria-pressed')).toBe('false')
  })

  it('clicking Expand all opens every page section and flips the label to Collapse all', async () => {
    const user = userEvent.setup()
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    // Default: all collapsed
    expect(pagePanels().every((d) => !d.open)).toBe(true)

    await user.click(screen.getByRole('button', { name: /expand all sections/i }))

    // Every page section now open
    expect(pagePanels().every((d) => d.open)).toBe(true)
    // Label flips to "Collapse all" and aria-pressed true
    const btn = screen.getByRole('button', { name: /collapse all sections/i })
    expect(btn.textContent).toMatch(/collapse all/i)
    expect(btn.getAttribute('aria-pressed')).toBe('true')
  })

  it('clicking Collapse all (when all open) closes every section and flips back to Expand all', async () => {
    const user = userEvent.setup()
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    // Open them all first
    await user.click(screen.getByRole('button', { name: /expand all sections/i }))
    expect(pagePanels().every((d) => d.open)).toBe(true)
    // Now collapse all
    await user.click(screen.getByRole('button', { name: /collapse all sections/i }))
    expect(pagePanels().every((d) => !d.open)).toBe(true)
    expect(screen.getByRole('button', { name: /expand all sections/i })).toBeInTheDocument()
  })

  it('individual section toggle still works after Expand all (close one, button reverts to Expand all)', async () => {
    const user = userEvent.setup()
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    await user.click(screen.getByRole('button', { name: /expand all sections/i }))
    expect(pagePanels().every((d) => d.open)).toBe(true)

    // Close exactly one section by toggling its <details> open programmatically
    // (mirrors a user clicking that section's summary). The bulk label must
    // revert to "Expand all" because not all are open anymore.
    const first = pagePanels()[0]
    first.open = false
    first.dispatchEvent(new Event('toggle', { bubbles: true }))

    // Button label derives from "all expanded" → now false. Svelte flushes the
    // bind:open → openState sync on a microtask, so wait for the label to flip.
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: /expand all sections/i })).toBeInTheDocument()
    )

    // And clicking Expand all re-opens the one we closed (en masse set still works)
    await user.click(screen.getByRole('button', { name: /expand all sections/i }))
    expect(pagePanels().every((d) => d.open)).toBe(true)
  })

  it('individual section can be opened on its own without Expand all', async () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    const panels = pagePanels()
    expect(panels.every((d) => !d.open)).toBe(true)
    // Open just one
    panels[0].open = true
    panels[0].dispatchEvent(new Event('toggle'))
    // Only that one is open; button stays "Expand all"
    expect(panels[0].open).toBe(true)
    expect(panels.slice(1).every((d) => !d.open)).toBe(true)
    expect(screen.getByRole('button', { name: /expand all sections/i })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Per-section header status indicator (feat/expand-all-section-status)
// AI-backed section headers show a spinner while pending, a ready cue when
// done, and a muted hint for no-key/error. Synchronous sections show neither.
// The indicator lives in the header so it's visible even when collapsed.
// ---------------------------------------------------------------------------

describe('UnderstandStep — per-section header status indicator', () => {
  function summaryHeaderOf(match: RegExp): HTMLElement {
    const details = Array.from(document.querySelectorAll('.detail-panel')).find(
      (d) => d.querySelector('.detail-summary-title')?.textContent?.match(match)
    ) as HTMLDetailsElement
    return details.querySelector('.detail-summary') as HTMLElement
  }

  it('shows a spinner in the Full summary header while the summary task is loading (even though section is collapsed)', () => {
    const run = makeRun({ summary: { status: 'loading' } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    const header = summaryHeaderOf(/full summary/i)
    // Section is collapsed by default but the header indicator is still present
    const panel = header.closest('details') as HTMLDetailsElement
    expect(panel.open).toBe(false)
    expect(header.querySelector('.ui-spinner')).not.toBeNull()
  })

  it('shows a spinner while the task is still idle (queued)', () => {
    const run = makeRun({ verdict: { status: 'idle' } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    const header = summaryHeaderOf(/why this verdict/i)
    expect(header.querySelector('.ui-spinner')).not.toBeNull()
  })

  it('shows a ready cue (no spinner) in the header when the task is done', () => {
    const verdict: VerdictResult = { level: 'behavior-preserved', evidence: ['ok'], notAnalyzed: [] }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    const header = summaryHeaderOf(/why this verdict/i)
    expect(header.querySelector('.ui-spinner')).toBeNull()
    expect(header.querySelector('.section-status-ready')).not.toBeNull()
    // Polite live region announces readiness
    const live = header.querySelector('.section-status-live')
    expect(live?.textContent).toMatch(/ready/i)
  })

  it('shows a muted hint (no spinner) for no-key status', () => {
    const run = makeRun({ summary: { status: 'no-key' } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    const header = summaryHeaderOf(/full summary/i)
    expect(header.querySelector('.ui-spinner')).toBeNull()
    expect(header.querySelector('.section-status-hint')).not.toBeNull()
  })

  it('shows a muted hint (no spinner) for error status', () => {
    const run = makeRun({ tests: { status: 'error', error: 'boom' } })
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    const header = summaryHeaderOf(/test coverage/i)
    expect(header.querySelector('.ui-spinner')).toBeNull()
    expect(header.querySelector('.section-status-hint')).not.toBeNull()
  })

  it('synchronous sections (CI details, PR description, Changed files) show NO status indicator in the header', () => {
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun({}) } })
    for (const match of [/ci details/i, /original pr description/i, /changed files/i]) {
      const header = summaryHeaderOf(match)
      expect(header.querySelector('.section-status')).toBeNull()
    }
  })

  it('AI sections (summary, diagrams, tests, alternatives, verdict) each render a status indicator', () => {
    const run = makeRun({})
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run } })
    for (const match of [/full summary/i, /execution flow/i, /test coverage/i, /alternative approaches/i, /why this verdict/i]) {
      const header = summaryHeaderOf(match)
      expect(header.querySelector('.section-status')).not.toBeNull()
    }
  })
})
