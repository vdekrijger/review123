/**
 * StandingRulesSection.test.ts — the standing-rules settings surface.
 *
 * What is actually load-bearing here, and therefore what is tested:
 *   - the cost is shown BEFORE any call, and the call happens only on a click;
 *   - where the distillation ran is stated, never implied;
 *   - accept / edit / reject are per-rule, persisted, and undoable;
 *   - a rejected rule is not re-proposed;
 *   - the export carries exactly the accepted rules, and nothing writes a file.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import StandingRulesSection from './StandingRulesSection.svelte'
import { _setCaptureForTest } from '../../lib/analytics/analytics'
import { setAiProvider, setDeepseekKey } from '../../lib/settings/settings'
import {
  STANDING_RULES_KEY,
  STANDING_RULE_DECISIONS_KEY,
  loadDecisions,
  ruleId,
  type StandingRulesRecord,
} from '../../lib/skills/standingRulesStore'

// The bridge's live state is behind probe-only getters; this narrow fake is
// the "nothing is paired" default, flipped per-test where the local route
// matters. Same seam as standingRules.test.ts.
const fakeBridge = { clis: [] as string[], inferReady: false, token: null as string | null }
vi.mock('../../lib/bridge/bridge.svelte', () => ({
  bridgeAvailable: (cap: string) => cap === 'infer' && fakeBridge.inferReady,
  bridgeInferenceClis: () => fakeBridge.clis,
  bridgeCredentials: () => (fakeBridge.token ? { token: fakeBridge.token, port: 7321 } : null),
}))

// The corpus harvest is a provider call + an IndexedDB cursor; both are
// exercised in standingRulesCorpus.test.ts. Here it is a seam.
const corpusResult = {
  ok: true as const,
  corpus: {
    reviewComments: Array.from({ length: 20 }, (_, i) => `comment ${i}`),
    dismissals: [{ pattern: 'missing jsdoc', reason: 'not-worth' as const }],
    drafts: ['Pull this into a constant.'],
    acceptedFindings: [],
  },
  counts: { reviewComments: 20, dismissals: 1, drafts: 1, acceptedFindings: 0 },
  commentsError: undefined as string | undefined,
}
const collectCorpusMock = vi.fn(async () => corpusResult)
vi.mock('../../lib/skills/standingRulesCorpus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/skills/standingRulesCorpus')>()
  return { ...actual, collectCorpus: () => collectCorpusMock() }
})

// The LLM call.
const distillMock = vi.fn()
vi.mock('../../lib/skills/standingRules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/skills/standingRules')>()
  return { ...actual, distillStandingRules: (...args: unknown[]) => distillMock(...args) }
})

const RULES = [
  {
    rule: 'Put domain logic in the domain module, never in a route handler.',
    kind: 'do' as const,
    occurrences: 5,
    evidence: [{ source: 'review-comment' as const, excerpt: 'this belongs in the domain layer' }],
  },
  {
    rule: 'Do not flag missing JSDoc on internal helpers.',
    kind: 'avoid' as const,
    occurrences: 3,
    evidence: [{ source: 'dismissal' as const, excerpt: 'missing jsdoc on an internal helper' }],
  },
]

function seedRecord(overrides: Partial<StandingRulesRecord> = {}): StandingRulesRecord {
  const record: StandingRulesRecord = {
    promptVersion: 1,
    distilledAt: Date.parse('2026-09-22T10:00:00Z'),
    source: 'bridge',
    sourceLabel: 'Claude Code on this machine',
    counts: { reviewComments: 20, dismissals: 1, drafts: 1, acceptedFindings: 0 },
    rules: RULES,
    ...overrides,
  }
  localStorage.setItem(STANDING_RULES_KEY, JSON.stringify(record))
  return record
}

let events: { event: string; props: Record<string, unknown> }[]

beforeEach(() => {
  localStorage.clear()
  fakeBridge.clis = []
  fakeBridge.inferReady = false
  fakeBridge.token = null
  corpusResult.commentsError = undefined
  corpusResult.counts = { reviewComments: 20, dismissals: 1, drafts: 1, acceptedFindings: 0 }
  collectCorpusMock.mockClear()
  distillMock.mockReset()
  distillMock.mockResolvedValue({ ok: true, rules: RULES, source: 'api', sourceLabel: 'DeepSeek' })
  events = []
  _setCaptureForTest((event, props) => events.push({ event, props }))
  setAiProvider('deepseek')
  setDeepseekKey('sk-test')
})

// ---------------------------------------------------------------------------
// Framing + routing
// ---------------------------------------------------------------------------

describe('framing', () => {
  it('renders as a settings region', () => {
    render(StandingRulesSection)
    expect(screen.getByRole('region', { name: /standing rules/i })).toBeInTheDocument()
  })

  it('states the propose-never-apply promise up front', () => {
    render(StandingRulesSection)
    expect(screen.getByTestId('standing-rules-section')).toHaveTextContent(
      /Nothing is written to any file on your machine/i,
    )
  })

  it('says it will go to the API provider when no bridge can infer, and names it', () => {
    render(StandingRulesSection)
    expect(screen.getByTestId('standing-rules-route')).toHaveTextContent(/DeepSeek/)
    expect(screen.getByTestId('standing-rules-route')).toHaveTextContent(/over the API/i)
  })

  it('says it will stay LOCAL when a bridge can run it', () => {
    fakeBridge.clis = ['claude']
    fakeBridge.inferReady = true
    fakeBridge.token = 'tok'
    render(StandingRulesSection)
    expect(screen.getByTestId('standing-rules-route')).toHaveTextContent(/Claude Code on this machine/)
    expect(screen.getByTestId('standing-rules-route')).toHaveTextContent(/never leave this machine/i)
  })

  it('says what is missing when neither route is available', () => {
    localStorage.clear()
    render(StandingRulesSection)
    expect(screen.getByTestId('standing-rules-route')).toHaveTextContent(/No local bridge is paired/i)
  })
})

// ---------------------------------------------------------------------------
// Cost honesty
// ---------------------------------------------------------------------------

describe('cost preview', () => {
  it('runs NOTHING on mount — no harvest, no LLM call', () => {
    render(StandingRulesSection)
    expect(collectCorpusMock).not.toHaveBeenCalled()
    expect(distillMock).not.toHaveBeenCalled()
  })

  it('shows the counts and a token estimate before any distillation', async () => {
    render(StandingRulesSection)
    await userEvent.click(screen.getByRole('button', { name: /check what's there/i }))
    const cost = await screen.findByTestId('standing-rules-cost')
    expect(cost).toHaveTextContent('20 review comments')
    expect(cost).toHaveTextContent('1 dismissals')
    expect(cost).toHaveTextContent(/input tokens/)
    expect(distillMock).not.toHaveBeenCalled()
  })

  it('the distillation only happens on an EXPLICIT second click', async () => {
    render(StandingRulesSection)
    await userEvent.click(screen.getByRole('button', { name: /check what's there/i }))
    await screen.findByTestId('standing-rules-cost')
    await userEvent.click(screen.getByRole('button', { name: /distil rules/i }))
    await waitFor(() => expect(distillMock).toHaveBeenCalledTimes(1))
  })

  it('an EMPTY corpus says so plainly and blocks the run', async () => {
    corpusResult.counts = { reviewComments: 0, dismissals: 0, drafts: 0, acceptedFindings: 0 }
    render(StandingRulesSection)
    await userEvent.click(screen.getByRole('button', { name: /check what's there/i }))
    expect(await screen.findByTestId('standing-rules-blocked')).toHaveTextContent(/Nothing to distil yet/i)
    expect(screen.getByRole('button', { name: /distil rules/i })).toBeDisabled()
  })

  it('a THIN corpus reports the count instead of inventing rules', async () => {
    corpusResult.counts = { reviewComments: 4, dismissals: 0, drafts: 0, acceptedFindings: 0 }
    render(StandingRulesSection)
    await userEvent.click(screen.getByRole('button', { name: /check what's there/i }))
    expect(await screen.findByTestId('standing-rules-blocked')).toHaveTextContent(
      /Not enough signal yet — 4 comments/,
    )
    expect(screen.getByRole('button', { name: /distil rules/i })).toBeDisabled()
  })

  it('surfaces a partial harvest rather than pretending the history was complete', async () => {
    corpusResult.commentsError = 'API rate limit exceeded'
    render(StandingRulesSection)
    await userEvent.click(screen.getByRole('button', { name: /check what's there/i }))
    expect(await screen.findByTestId('standing-rules-partial')).toHaveTextContent('API rate limit exceeded')
  })
})

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

describe('running the distillation', () => {
  async function runIt() {
    render(StandingRulesSection)
    await userEvent.click(screen.getByRole('button', { name: /check what's there/i }))
    await screen.findByTestId('standing-rules-cost')
    await userEvent.click(screen.getByRole('button', { name: /distil rules/i }))
    return screen.findByTestId('standing-rules-result')
  }

  it('renders both kinds under headings that read differently', async () => {
    await runIt()
    expect(screen.getByTestId('standing-rules-group-do')).toHaveTextContent(/keep asking for/i)
    expect(screen.getByTestId('standing-rules-group-avoid')).toHaveTextContent(/keep rejecting/i)
  })

  it('attaches the evidence — the count AND the excerpts', async () => {
    await runIt()
    const cards = screen.getAllByTestId('standing-rule')
    expect(within(cards[0]).getByTestId('standing-rule-evidence')).toHaveTextContent(/Seen 5 times/)
    expect(cards[0]).toHaveTextContent('this belongs in the domain layer')
    expect(cards[0]).toHaveTextContent('review comment')
  })

  it('states WHERE it ran on the stored result', async () => {
    distillMock.mockResolvedValue({ ok: true, rules: RULES, source: 'bridge', sourceLabel: 'Claude Code on this machine' })
    await runIt()
    const prov = screen.getByTestId('standing-rules-provenance')
    expect(prov).toHaveTextContent('Claude Code on this machine')
    expect(prov).toHaveTextContent('(on this machine)')
  })

  it('caches the result — a reload renders it without re-running', async () => {
    seedRecord()
    render(StandingRulesSection)
    expect(screen.getByTestId('standing-rules-result')).toBeInTheDocument()
    expect(distillMock).not.toHaveBeenCalled()
    // And the re-run affordance is there once the corpus is re-counted.
    await userEvent.click(screen.getByRole('button', { name: /check what's there/i }))
    expect(await screen.findByRole('button', { name: /re-run/i })).toBeInTheDocument()
  })

  it('flags a stored result the current prompt would no longer produce', () => {
    seedRecord({ promptVersion: 0 })
    render(StandingRulesSection)
    expect(screen.getByTestId('standing-rules-provenance')).toHaveTextContent(/prompt has changed since/i)
  })

  it('surfaces a failure without claiming a silent fallback happened', async () => {
    distillMock.mockResolvedValue({
      ok: false,
      source: 'bridge',
      sourceLabel: 'Claude Code on this machine',
      error: 'The local bridge is not responding. It did not fall back to a paid provider.',
    })
    render(StandingRulesSection)
    await userEvent.click(screen.getByRole('button', { name: /check what's there/i }))
    await screen.findByTestId('standing-rules-cost')
    await userEvent.click(screen.getByRole('button', { name: /distil rules/i }))
    expect(await screen.findByTestId('standing-rules-error')).toHaveTextContent(/did not fall back/i)
  })

  it('reports counts and the source to analytics — and never a rule or an excerpt', async () => {
    await runIt()
    const event = events.find((e) => e.event === 'standing_rules_distilled')
    expect(event?.props).toMatchObject({
      outcome: 'done',
      source: 'api',
      rules: 2,
      do: 1,
      avoid: 1,
      comments: 20,
      dismissals: 1,
      drafts: 1,
    })
    const payload = JSON.stringify(event?.props)
    expect(payload).not.toContain('domain module')
    expect(payload).not.toContain('this belongs in the domain layer')
  })
})

// ---------------------------------------------------------------------------
// Per-rule decisions
// ---------------------------------------------------------------------------

describe('accept / edit / reject', () => {
  function firstCard() {
    return screen.getAllByTestId('standing-rule')[0]
  }

  it('accepting ONE rule marks only that one, and persists', async () => {
    seedRecord()
    render(StandingRulesSection)
    await userEvent.click(within(firstCard()).getByRole('button', { name: /accept rule/i }))
    expect(within(firstCard()).getByTestId('standing-rule-decided')).toHaveTextContent('Accepted')
    expect(loadDecisions()[ruleId(RULES[0].rule)].status).toBe('accepted')
    // The second rule is untouched.
    expect(screen.getAllByTestId('standing-rule')[1]).toHaveAttribute('data-decision', 'undecided')
  })

  it('editing rewrites the rule and marks it edited', async () => {
    seedRecord()
    render(StandingRulesSection)
    await userEvent.click(within(firstCard()).getByRole('button', { name: /edit rule/i }))
    const box = screen.getByRole('textbox', { name: /edit rule/i })
    await userEvent.clear(box)
    await userEvent.type(box, 'My sharper wording.')
    await userEvent.click(screen.getByRole('button', { name: /save & accept/i }))
    expect(firstCard()).toHaveTextContent('My sharper wording.')
    expect(within(firstCard()).getByTestId('standing-rule-decided')).toHaveTextContent('Accepted (edited)')
  })

  it('rejecting a rule removes it from the proposals and remembers it', async () => {
    seedRecord()
    render(StandingRulesSection)
    await userEvent.click(within(firstCard()).getByRole('button', { name: /reject rule/i }))
    await waitFor(() => expect(screen.getAllByTestId('standing-rule')).toHaveLength(1))
    expect(screen.getByTestId('standing-rules-rejections')).toHaveTextContent(/1 rejected rule/)
    expect(loadDecisions()[ruleId(RULES[0].rule)].status).toBe('rejected')
  })

  it('a RE-RUN does not re-propose a rejected rule', async () => {
    localStorage.setItem(
      STANDING_RULE_DECISIONS_KEY,
      JSON.stringify({
        [ruleId(RULES[0].rule)]: { status: 'rejected', text: RULES[0].rule, kind: 'do', edited: false, decidedAt: 1 },
      }),
    )
    render(StandingRulesSection)
    await userEvent.click(screen.getByRole('button', { name: /check what's there/i }))
    await screen.findByTestId('standing-rules-cost')
    await userEvent.click(screen.getByRole('button', { name: /distil rules/i }))
    await screen.findByTestId('standing-rules-result')
    const texts = screen.getAllByTestId('standing-rule').map((el) => el.textContent ?? '')
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('Do not flag missing JSDoc')
  })

  it('an accepted decision can be undone', async () => {
    seedRecord()
    render(StandingRulesSection)
    await userEvent.click(within(firstCard()).getByRole('button', { name: /accept rule/i }))
    await userEvent.click(within(firstCard()).getByRole('button', { name: /undo/i }))
    expect(firstCard()).toHaveAttribute('data-decision', 'undecided')
    expect(loadDecisions()[ruleId(RULES[0].rule)]).toBeUndefined()
  })

  it('rejections can be forgotten wholesale — the ledger is clearable (#230 precedent)', async () => {
    seedRecord()
    render(StandingRulesSection)
    await userEvent.click(within(firstCard()).getByRole('button', { name: /reject rule/i }))
    await userEvent.click(screen.getByRole('button', { name: /forget them/i }))
    await waitFor(() => expect(screen.getAllByTestId('standing-rule')).toHaveLength(2))
    expect(loadDecisions()).toEqual({})
  })

  it('tracks each decision as an enum + a boolean, never the rule text', async () => {
    seedRecord()
    render(StandingRulesSection)
    await userEvent.click(within(firstCard()).getByRole('button', { name: /accept rule/i }))
    const event = events.find((e) => e.event === 'standing_rules_decided')
    expect(event?.props).toEqual({ decision: 'accepted', kind: 'do', edited: false })
  })
})

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe('export', () => {
  it('copies exactly the ACCEPTED rules, and nothing else', async () => {
    seedRecord()
    const copyFn = vi.fn(async (_text: string) => {})
    render(StandingRulesSection, { props: { copyFn } })
    const cards = screen.getAllByTestId('standing-rule')
    await userEvent.click(within(cards[0]).getByRole('button', { name: /accept rule/i }))
    await userEvent.click(within(screen.getAllByTestId('standing-rule')[1]).getByRole('button', { name: /reject rule/i }))
    await userEvent.click(screen.getByRole('button', { name: /copy to clipboard/i }))

    const text = copyFn.mock.calls[0][0] as string
    expect(text).toContain('## Standing rules')
    expect(text).toContain('- Put domain logic in the domain module, never in a route handler.')
    expect(text).not.toContain('Do not flag missing JSDoc')
    expect(await screen.findByTestId('standing-rules-exported')).toHaveTextContent(/copied/i)
  })

  it('downloads the same text as a .md — and hands it to a seam, never to a filesystem', async () => {
    seedRecord()
    const downloadFn = vi.fn((_filename: string, _text: string) => {})
    render(StandingRulesSection, { props: { downloadFn } })
    await userEvent.click(within(screen.getAllByTestId('standing-rule')[0]).getByRole('button', { name: /accept rule/i }))
    await userEvent.click(screen.getByRole('button', { name: /download \.md/i }))
    expect(downloadFn).toHaveBeenCalledWith('standing-rules.md', expect.stringContaining('## Standing rules'))
  })

  it('carries the one-line provenance header', async () => {
    seedRecord()
    const copyFn = vi.fn(async (_text: string) => {})
    render(StandingRulesSection, { props: { copyFn } })
    await userEvent.click(within(screen.getAllByTestId('standing-rule')[0]).getByRole('button', { name: /accept rule/i }))
    await userEvent.click(screen.getByRole('button', { name: /copy to clipboard/i }))
    expect(copyFn.mock.calls[0][0]).toContain('_Distilled by review123 on 2026-09-22')
  })

  it('is disabled until at least one rule is accepted', async () => {
    seedRecord()
    render(StandingRulesSection)
    expect(screen.getByRole('button', { name: /copy to clipboard/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /download \.md/i })).toBeDisabled()
    await userEvent.click(within(screen.getAllByTestId('standing-rule')[0]).getByRole('button', { name: /accept rule/i }))
    expect(screen.getByRole('button', { name: /copy to clipboard/i })).toBeEnabled()
  })

  it('says so instead of failing silently when the clipboard is unavailable', async () => {
    seedRecord()
    const copyFn = vi.fn(async (_text: string) => {
      throw new Error('denied')
    })
    render(StandingRulesSection, { props: { copyFn } })
    await userEvent.click(within(screen.getAllByTestId('standing-rule')[0]).getByRole('button', { name: /accept rule/i }))
    await userEvent.click(screen.getByRole('button', { name: /copy to clipboard/i }))
    expect(await screen.findByTestId('standing-rules-exported')).toHaveTextContent(/use Download instead/i)
  })

  it('tracks the method and the count only', async () => {
    seedRecord()
    const downloadFn = vi.fn((_filename: string, _text: string) => {})
    render(StandingRulesSection, { props: { downloadFn } })
    await userEvent.click(within(screen.getAllByTestId('standing-rule')[0]).getByRole('button', { name: /accept rule/i }))
    await userEvent.click(screen.getByRole('button', { name: /download \.md/i }))
    expect(events.find((e) => e.event === 'standing_rules_exported')?.props).toEqual({
      method: 'download',
      rules: 1,
    })
  })

  it('discarding the distillation clears the stored record', async () => {
    seedRecord()
    render(StandingRulesSection)
    await userEvent.click(screen.getByRole('button', { name: /discard distillation/i }))
    await waitFor(() => expect(screen.queryByTestId('standing-rules-result')).not.toBeInTheDocument())
    expect(localStorage.getItem(STANDING_RULES_KEY)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Cancelling a run
//
// The distillation is ONE call that takes minutes over the bridge. A stop that
// only hides the spinner is not a stop, and a stop that costs the user the
// rules they already accepted is worse than none.
// ---------------------------------------------------------------------------

describe('cancelling a run', () => {
  /**
   * A distillation that never settles on its own — the real shape of the
   * problem. It resolves as CANCELLED if (and only if) its signal aborts, the
   * way the module classifies an aborted transport.
   */
  function hangingRun() {
    const signals: (AbortSignal | undefined)[] = []
    distillMock.mockImplementation((_corpus: unknown, _route: unknown, _deps: unknown, signal?: AbortSignal) => {
      signals.push(signal)
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () =>
          resolve({ ok: false, cancelled: true, source: 'api', sourceLabel: 'DeepSeek' }),
        )
      })
    })
    return signals
  }

  async function startRun() {
    await userEvent.click(screen.getByRole('button', { name: /check what's there/i }))
    await screen.findByTestId('standing-rules-cost')
    await userEvent.click(screen.getByRole('button', { name: /distil rules|re-run/i }))
    return screen.findByTestId('standing-rules-cancel')
  }

  function cancelButton() {
    return screen.queryByRole('button', { name: /cancel the distillation/i })
  }

  it('offers no Cancel while nothing is running', async () => {
    render(StandingRulesSection)
    expect(cancelButton()).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /check what's there/i }))
    await screen.findByTestId('standing-rules-cost')
    expect(cancelButton()).not.toBeInTheDocument()
  })

  it('offers no Cancel once the run has finished', async () => {
    render(StandingRulesSection)
    await userEvent.click(screen.getByRole('button', { name: /check what's there/i }))
    await screen.findByTestId('standing-rules-cost')
    await userEvent.click(screen.getByRole('button', { name: /distil rules/i }))
    await screen.findByTestId('standing-rules-result')
    expect(cancelButton()).not.toBeInTheDocument()
  })

  it('shows a Cancel while the run is in flight, and ABORTS the call when pressed', async () => {
    const signals = hangingRun()
    render(StandingRulesSection)
    await startRun()
    expect(signals[0]?.aborted).toBe(false)

    await userEvent.click(cancelButton() as HTMLElement)
    // The signal handed to the distillation really fired — the request is torn
    // down, not merely ignored.
    expect(signals[0]?.aborted).toBe(true)
    await waitFor(() => expect(cancelButton()).not.toBeInTheDocument())
  })

  it('is operable from the keyboard, like every other control here', async () => {
    const signals = hangingRun()
    render(StandingRulesSection)
    const button = await startRun()
    button.focus()
    expect(button).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(signals[0]?.aborted).toBe(true)
  })

  it('lands on a CALM state — no error chip, no alert, no blame', async () => {
    hangingRun()
    render(StandingRulesSection)
    await startRun()
    await userEvent.click(cancelButton() as HTMLElement)

    const note = await screen.findByTestId('standing-rules-cancelled')
    expect(note).toHaveTextContent(/cancelled before it finished/i)
    expect(screen.queryByTestId('standing-rules-error')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // Never the engine's own text, which blames a user who stopped their own run.
    expect(note).not.toHaveTextContent(/user aborted/i)
  })

  it('says honestly that the bridge cannot stop the CLI it started', async () => {
    fakeBridge.clis = ['claude']
    fakeBridge.inferReady = true
    fakeBridge.token = 'tok'
    distillMock.mockImplementation((_c: unknown, _r: unknown, _d: unknown, signal?: AbortSignal) => {
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () =>
          resolve({ ok: false, cancelled: true, source: 'bridge', sourceLabel: 'Claude Code on this machine' }),
        )
      })
    })
    render(StandingRulesSection)
    await startRun()
    await userEvent.click(cancelButton() as HTMLElement)
    expect(await screen.findByTestId('standing-rules-cancelled')).toHaveTextContent(
      /keeps running until it finishes/i,
    )
  })

  it('leaves the previous distillation AND its decisions exactly as they were', async () => {
    seedRecord()
    hangingRun()
    render(StandingRulesSection)
    await userEvent.click(within(screen.getAllByTestId('standing-rule')[0]).getByRole('button', { name: /accept rule/i }))
    const storedBefore = localStorage.getItem(STANDING_RULES_KEY)
    const decisionsBefore = localStorage.getItem(STANDING_RULE_DECISIONS_KEY)

    await startRun()
    await userEvent.click(cancelButton() as HTMLElement)
    await screen.findByTestId('standing-rules-cancelled')

    expect(screen.getByTestId('standing-rules-result')).toBeInTheDocument()
    expect(screen.getAllByTestId('standing-rule')).toHaveLength(2)
    expect(within(screen.getAllByTestId('standing-rule')[0]).getByTestId('standing-rule-decided')).toHaveTextContent(
      /accepted/i,
    )
    expect(localStorage.getItem(STANDING_RULES_KEY)).toBe(storedBefore)
    expect(localStorage.getItem(STANDING_RULE_DECISIONS_KEY)).toBe(decisionsBefore)
  })

  it('reports the cancel as an OUTCOME, never as a failure, and still sends no rule text', async () => {
    hangingRun()
    render(StandingRulesSection)
    await startRun()
    await userEvent.click(cancelButton() as HTMLElement)
    await screen.findByTestId('standing-rules-cancelled')

    const distilled = events.filter((e) => e.event === 'standing_rules_distilled')
    expect(distilled).toHaveLength(1)
    expect(distilled[0].props).toMatchObject({
      outcome: 'cancelled',
      source: 'api',
      comments: 20,
      dismissals: 1,
      drafts: 1,
    })
    // No rule counts: there are no rules. And nothing that could carry content.
    expect(distilled[0].props).not.toHaveProperty('rules')
    expect(distilled[0].props).not.toHaveProperty('do')
    expect(JSON.stringify(distilled[0].props)).not.toContain('domain module')
    // And no failure event of any kind was emitted.
    expect(events.map((e) => e.event)).not.toContain('ai_task_failed')
  })

  it('re-runs immediately afterwards — no stuck spinner, no stale cancel note', async () => {
    hangingRun()
    render(StandingRulesSection)
    await startRun()
    await userEvent.click(cancelButton() as HTMLElement)
    await screen.findByTestId('standing-rules-cancelled')

    distillMock.mockReset()
    distillMock.mockResolvedValue({ ok: true, rules: RULES, source: 'api', sourceLabel: 'DeepSeek' })
    await userEvent.click(screen.getByRole('button', { name: /distil rules/i }))

    await screen.findByTestId('standing-rules-result')
    expect(screen.queryByTestId('standing-rules-cancelled')).not.toBeInTheDocument()
    expect(cancelButton()).not.toBeInTheDocument()
    expect(screen.getAllByTestId('standing-rule')).toHaveLength(2)
  })

  it('a late outcome from a cancelled run can never write over the calm state', async () => {
    // The abort races the answer: the provider may already have replied. The
    // user stopped the run, so that answer is not theirs to be shown.
    const late: { settle: ((v: unknown) => void) | null } = { settle: null }
    distillMock.mockImplementation(
      () => new Promise((resolve) => (late.settle = resolve as (v: unknown) => void)),
    )
    render(StandingRulesSection)
    await startRun()
    await userEvent.click(cancelButton() as HTMLElement)
    await screen.findByTestId('standing-rules-cancelled')

    late.settle?.({ ok: true, rules: RULES, source: 'api', sourceLabel: 'DeepSeek' })
    await waitFor(() => expect(screen.getByTestId('standing-rules-cancelled')).toBeInTheDocument())
    expect(screen.queryByTestId('standing-rules-result')).not.toBeInTheDocument()
    expect(localStorage.getItem(STANDING_RULES_KEY)).toBeNull()
  })
})
