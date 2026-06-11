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

describe('UnderstandStep verdict notAnalyzed (EC-15c/d)', () => {
  it('hides notAnalyzed section when empty', () => {
    const verdict: VerdictResult = { level: 'behavior-preserved', evidence: ['clean'], notAnalyzed: [] }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    render(UnderstandStep, { props: { meta, ci: null, ciError: false, run } })
    expect(screen.queryByText('Not analyzed')).not.toBeInTheDocument()
  })

  it('shows notAnalyzed section when non-empty', () => {
    const verdict: VerdictResult = { level: 'minor-changes', evidence: ['e1'], notAnalyzed: ['skipped.ts'] }
    const run = makeRun({ verdict: { status: 'done', value: verdict } })
    render(UnderstandStep, { props: { meta, ci: null, ciError: false, run } })
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
