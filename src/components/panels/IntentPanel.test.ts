import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import IntentPanel from './IntentPanel.svelte'
import type { AiRun } from '../../lib/ai/run.svelte'
import type { IntentCheckResult } from '../../lib/ai/schemas'

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

const ALIGNED: IntentCheckResult = {
  intents: [
    { id: 'i1', text: 'Add a token-bucket rate limiter' },
    { id: 'i2', text: 'Wire the limiter into the API client' },
  ],
  matched: [
    { intentId: 'i1', evidence: [{ path: 'src/limiter.ts', line: 12 }], note: 'The limiter lands in `src/limiter.ts`.' },
    { intentId: 'i2', evidence: [{ path: 'src/client.ts' }], note: 'The client calls it on every request.' },
  ],
  unrequested: [],
  unfulfilled: [],
}

const DRIFT: IntentCheckResult = {
  intents: [
    { id: 'i1', text: 'Add a token-bucket rate limiter' },
    { id: 'i2', text: 'Add tests for the limiter' },
  ],
  matched: [
    { intentId: 'i1', evidence: [{ path: 'src/limiter.ts', line: 12 }], note: 'The limiter lands in src/limiter.ts.' },
  ],
  unrequested: [
    { description: 'Adds a new logging dependency', paths: ['package.json'], significance: 'notable' },
    { description: 'Reformats the config module', paths: ['src/config.ts'], significance: 'minor' },
  ],
  unfulfilled: [{ intentId: 'i2', note: 'No test files changed.' }],
}

describe('IntentPanel — skipped / disabled states', () => {
  it('skipped (empty PR description) shows the calm zero-token line', () => {
    render(IntentPanel, { props: { run: makeRun({ intent: { status: 'skipped' } }) } })
    expect(
      screen.getByText('No stated intent to check — the PR description is empty.'),
    ).toBeInTheDocument()
    // Not an error, not a spinner, no settings link.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/enable in AI settings/i)).toBeNull()
  })

  it('disabled (task off in settings) shows the standard muted disabled state', () => {
    render(IntentPanel, { props: { run: makeRun({ intent: { status: 'disabled' } }) } })
    expect(screen.getByText(/enable in AI settings/i)).toBeInTheDocument()
  })

  it('error state shows the canned error + retry (AiPanel idiom)', () => {
    render(IntentPanel, {
      props: { run: makeRun({ intent: { status: 'error', error: 'Provider server error.', errorDetail: 'HTTP 500' } }) },
    })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('Provider server error.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })
})

describe('IntentPanel — aligned state', () => {
  it('renders ONE green aligned line with the verified-intent count', () => {
    const { container } = render(IntentPanel, {
      props: { run: makeRun({ intent: { status: 'done', value: ALIGNED } }) },
    })
    expect(screen.getByText(/Implementation matches the stated intent \(2 intents verified\)/)).toBeInTheDocument()
    // No drift groups render.
    expect(container.querySelector('[data-group="unfulfilled"]')).toBeNull()
    expect(container.querySelector('[data-group="notable"]')).toBeNull()
    expect(container.querySelector('[data-group="minor"]')).toBeNull()
  })

  it('lists the verified intents with their evidence (open by default when aligned)', () => {
    const { container } = render(IntentPanel, {
      props: { run: makeRun({ intent: { status: 'done', value: ALIGNED } }) },
    })
    const matchedDetails = container.querySelector('details.intent-matched')
    expect(matchedDetails).not.toBeNull()
    expect((matchedDetails as HTMLDetailsElement).open).toBe(true)
    expect(screen.getByText('Add a token-bucket rate limiter')).toBeInTheDocument()
    expect(screen.getByText('src/limiter.ts:12')).toBeInTheDocument()
  })

  it('singular grammar for one verified intent', () => {
    const one: IntentCheckResult = {
      intents: [ALIGNED.intents[0]],
      matched: [ALIGNED.matched[0]],
      unrequested: [],
      unfulfilled: [],
    }
    render(IntentPanel, { props: { run: makeRun({ intent: { status: 'done', value: one } }) } })
    expect(screen.getByText(/Implementation matches the stated intent \(1 intent verified\)/)).toBeInTheDocument()
  })

  it('a result with NO derived intents shows the honest nothing-to-verify line', () => {
    const empty: IntentCheckResult = { intents: [], matched: [], unrequested: [], unfulfilled: [] }
    render(IntentPanel, { props: { run: makeRun({ intent: { status: 'done', value: empty } }) } })
    expect(screen.getByText(/No concrete promises found in the PR description/)).toBeInTheDocument()
  })
})

describe('IntentPanel — drift state (grouped, signal-ordered)', () => {
  it('renders Unfulfilled FIRST, then Notable unrequested, then Minor collapsed', () => {
    const { container } = render(IntentPanel, {
      props: { run: makeRun({ intent: { status: 'done', value: DRIFT } }) },
    })
    const groups = [...container.querySelectorAll('[data-group]')].map((el) => el.getAttribute('data-group'))
    expect(groups).toEqual(['unfulfilled', 'notable', 'minor'])
    // No aligned line in the drift state.
    expect(screen.queryByText(/Implementation matches the stated intent/)).toBeNull()
  })

  it('unfulfilled entries show the promised intent text + the note', () => {
    render(IntentPanel, { props: { run: makeRun({ intent: { status: 'done', value: DRIFT } }) } })
    expect(screen.getByText(/Unfulfilled — promised in the description/)).toBeInTheDocument()
    expect(screen.getByText('Add tests for the limiter')).toBeInTheDocument()
    expect(screen.getByText('No test files changed.')).toBeInTheDocument()
  })

  it('minor unrequested changes are COLLAPSED by default behind a count summary', () => {
    const { container } = render(IntentPanel, {
      props: { run: makeRun({ intent: { status: 'done', value: DRIFT } }) },
    })
    const minor = container.querySelector('details[data-group="minor"]') as HTMLDetailsElement
    expect(minor).not.toBeNull()
    expect(minor.open).toBe(false)
    expect(screen.getByText(/1 minor unrequested change/)).toBeInTheDocument()
  })

  it('the verified-intents disclosure stays CLOSED in the drift state (drift is the headline)', () => {
    const { container } = render(IntentPanel, {
      props: { run: makeRun({ intent: { status: 'done', value: DRIFT } }) },
    })
    const matchedDetails = container.querySelector('details.intent-matched') as HTMLDetailsElement
    expect(matchedDetails).not.toBeNull()
    expect(matchedDetails.open).toBe(false)
  })
})

describe('IntentPanel — evidence jump (onhotspot)', () => {
  it('clicking a matched-evidence link jumps to that file', async () => {
    const onhotspot = vi.fn()
    render(IntentPanel, {
      props: { run: makeRun({ intent: { status: 'done', value: ALIGNED } }), onhotspot },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'src/limiter.ts:12' }))
    expect(onhotspot).toHaveBeenCalledWith('src/limiter.ts')
  })

  it('clicking an unrequested-change path jumps to that file', async () => {
    const onhotspot = vi.fn()
    render(IntentPanel, {
      props: { run: makeRun({ intent: { status: 'done', value: DRIFT } }), onhotspot },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'package.json' }))
    expect(onhotspot).toHaveBeenCalledWith('package.json')
  })
})
