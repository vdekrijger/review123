import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import UnderstandStep from './UnderstandStep.svelte'
import type { AiRun } from '../lib/ai/run.svelte'
import type { VerdictResult } from '../lib/ai/schemas'
import type { PrMeta } from '../lib/github/types'

const meta: PrMeta = {
  title: 'Test PR',
  state: 'open',
  merged: false,
  body: 'PR desc',
  baseSha: 'base',
  headSha: 'head',
  private: false,
  changedFiles: 1,
}

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

/** Open all <details> elements so their content is queryable in tests. */
function openAllDetails() {
  document.querySelectorAll('details').forEach((d) => { d.open = true })
}

describe('UnderstandStep verdict notAnalyzed (EC-15c/d)', () => {
  it('hides notAnalyzed section when empty', () => {
    const verdict: VerdictResult = { level: 'behavior-preserved', evidence: ['clean'], notAnalyzed: [] }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    render(UnderstandStep, { props: { meta, ci: null, ciError: false, run } })
    openAllDetails()
    expect(screen.queryByText('Not analyzed')).not.toBeInTheDocument()
  })

  it('shows notAnalyzed section when non-empty', () => {
    const verdict: VerdictResult = { level: 'minor-changes', evidence: ['e1'], notAnalyzed: ['skipped.ts'] }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    render(UnderstandStep, { props: { meta, ci: null, ciError: false, run } })
    openAllDetails()
    expect(screen.getByText('Not analyzed')).toBeInTheDocument()
    expect(screen.getByText('skipped.ts')).toBeInTheDocument()
  })
})

describe('UnderstandStep panel states via AiPanel', () => {
  it('shows "Add a DeepSeek key in Settings" for no-key status', () => {
    const run = makeRun({ summary: { status: 'no-key' } })
    render(UnderstandStep, { props: { meta, ci: null, ciError: false, run } })
    expect(screen.getByText(/Add a DeepSeek key/i)).toBeInTheDocument()
  })

  it('shows "AI analysis declined" for declined status', () => {
    const run = makeRun({ summary: { status: 'declined' } })
    render(UnderstandStep, { props: { meta, ci: null, ciError: false, run } })
    expect(screen.getByText(/AI analysis declined/i)).toBeInTheDocument()
  })

  it('shows Retry button on error', () => {
    const run = makeRun({ summary: { status: 'error', error: 'something went wrong' } })
    render(UnderstandStep, { props: { meta, ci: null, ciError: false, run } })
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })
})

describe('UnderstandStep summary markdown rendering', () => {
  it('done-state summary containing ## Heading renders an h2 element', () => {
    const summaryWithHeading = '## What\nThis PR adds caching.\n\nSuggested reading order:\nsrc/a.ts'
    const run = makeRun({ summary: { status: 'done', value: summaryWithHeading } })
    const { container } = render(UnderstandStep, { props: { meta, ci: null, ciError: false, run } })
    // The "## What" heading should render as h2 (after reading order stripped)
    expect(container.querySelector('h2')).not.toBeNull()
  })

  it('done-state summary: <script> is stripped (XSS)', () => {
    const summaryWithScript = 'Good PR. <script>alert(1)<\/script>'
    const run = makeRun({ summary: { status: 'done', value: summaryWithScript } })
    const { container } = render(UnderstandStep, { props: { meta, ci: null, ciError: false, run } })
    expect(container.querySelector('script')).toBeNull()
  })

  it('streaming-state summary renders as plain text (not markdown)', () => {
    const streamingText = '## What\nThis PR adds a feature'
    const run = makeRun({ summary: { status: 'streaming', value: streamingText } })
    const { container } = render(UnderstandStep, { props: { meta, ci: null, ciError: false, run } })
    // Should use <pre> for streaming (plain text), not render h2
    expect(container.querySelector('pre.prose')).not.toBeNull()
    // No h2 in streaming mode
    expect(container.querySelector('h2')).toBeNull()
  })

  it('done-state strips reading-order section from display', () => {
    const summaryWithOrder = 'This PR refactors routing.\n\nSuggested reading order:\nsrc/router.ts\nsrc/app.ts'
    const run = makeRun({ summary: { status: 'done', value: summaryWithOrder } })
    const { container } = render(UnderstandStep, { props: { meta, ci: null, ciError: false, run } })
    expect(container.textContent).not.toContain('Suggested reading order')
    expect(container.textContent).not.toContain('src/router.ts')
    expect(container.textContent).toContain('This PR refactors routing.')
  })
})

describe('UnderstandStep layout structure', () => {
  it('PR description is inside a collapsed <details> element', () => {
    render(UnderstandStep, { props: { meta, ci: null, ciError: false, run: makeRun({}) } })
    const prDetails = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/original pr description/i)
    )
    expect(prDetails).not.toBeUndefined()
    expect((prDetails as HTMLDetailsElement).open).toBe(false)
  })

  it('diagrams section is inside a <details> that is open by default', () => {
    render(UnderstandStep, { props: { meta, ci: null, ciError: false, run: makeRun({}) } })
    const diagramsDetails = Array.from(document.querySelectorAll('details')).find(
      (d) => d.querySelector('summary')?.textContent?.match(/diagrams/i)
    )
    expect(diagramsDetails).not.toBeUndefined()
    expect((diagramsDetails as HTMLDetailsElement).open).toBe(true)
  })
})
