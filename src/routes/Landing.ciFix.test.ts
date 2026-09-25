/**
 * src/routes/Landing.ciFix.test.ts — mounting CiFixPanel from a queue row.
 *
 * WHAT THIS FILE IS FOR. #288 shipped CiFixPanel with nothing rendering it, so
 * everything about WHEN it appears was unwritten. Three claims, and none of
 * them is visible anywhere else:
 *
 *   1. THE OFFER IS NARROWER THAN "THE ROW IS RED". The flow ends in a push to
 *      the pull request's head branch, so it is offered on the user's OWN
 *      GitHub PRs and on nothing else — never in "Awaiting your review", never
 *      on a provider whose push target this app refuses to guess at, and never
 *      when the paired bridge could not run it anyway. Every one of those is a
 *      way the bridge would refuse AFTER the user had decided.
 *
 *   2. THE PANEL'S `ci` IS A REAL CiSummary, FETCHED ON DEMAND. The row's own
 *      signal is a rollup STATE and carries no failure list. The summary is
 *      fetched when a panel is opened — for that row, once — and never on
 *      render. e2e/queue-signals.spec.ts counts the actual network; this pins
 *      the call itself, including the head sha it is asked about.
 *
 *   3. `null` IS NEVER PASSED THROUGH. CiFixPanel renders nothing when it has
 *      no failures, and on a row the queue has already marked red, nothing
 *      reads as green. A summary that could not be read and a summary that
 *      named no failing job are different facts and each gets its own sentence.
 *
 * Geometry is not here (jsdom computes no layout); the bridge round trip is not
 * here either — e2e/queue-ci-fix.spec.ts drives a stubbed bridge end to end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import Landing from './Landing.svelte'
import * as queueModule from '../lib/provider/queue'
import * as signalsModule from '../lib/provider/queueSignals'
import * as sizesModule from '../lib/landing/queueSizes'
import { queueKey } from '../lib/provider/queue'
import type { CiSummary, QueueItem, QueueSignal } from '../lib/provider/types'
import type { FixReadiness } from '../lib/bridge/fixLoop'

vi.mock('../lib/router/router.svelte', () => ({ navigate: vi.fn() }))

/**
 * The bridge's readiness is injected rather than assembled out of a fake
 * bridge state: the RULE is `decideFixReadiness`'s and already has its own
 * tests, and what this file is about is which rows consult it. Both Landing and
 * CiFixPanel read through this same seam, so the panel that opens agrees with
 * the control that opened it.
 */
const READY: FixReadiness = {
  ready: true,
  reason: 'ready',
  cli: 'claude',
  branch: 'feat/thing',
  bridgeHead: 'sha101',
}
let readiness: FixReadiness = READY

vi.mock('../lib/bridge/fixLoop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/bridge/fixLoop')>()
  return { ...actual, currentFixReadiness: () => readiness }
})

const getCiSummaryMock = vi.fn()

vi.mock('../lib/provider/registry', () => ({
  PROVIDERS: new Map([
    ['github', {
      id: 'github',
      displayName: 'GitHub',
      authState: () => ({ configured: true, hint: '' }),
      getMyQueue: vi.fn(),
      getQueueSignals: vi.fn(),
      getCiSummary: (...args: unknown[]) => getCiSummaryMock(...args),
      capabilities: { resolvedThreads: false, checks: true, suggestions: false, atomicReview: false, compare: false, commentReplies: false, selfReviewBlocked: false },
    }],
    ['gitlab', {
      id: 'gitlab',
      displayName: 'GitLab',
      authState: () => ({ configured: true, hint: '' }),
      getMyQueue: vi.fn(),
      getQueueSignals: vi.fn(),
      getCiSummary: (...args: unknown[]) => getCiSummaryMock(...args),
      capabilities: { resolvedThreads: false, checks: true, suggestions: false, atomicReview: false, compare: false, commentReplies: false, selfReviewBlocked: false },
    }],
  ]),
  parseAnyUrl: vi.fn().mockReturnValue(null),
}))

function item(
  number: number,
  over: { mine?: boolean; provider?: 'github' | 'gitlab' } = {},
): QueueItem {
  return {
    ref: { provider: over.provider ?? 'github', owner: 'org', repo: 'repo', number },
    title: `PR ${number}`,
    authorIsMe: over.mine ?? true,
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
  }
}

function signal(over: Partial<QueueSignal> = {}): QueueSignal {
  return {
    ci: 'failing',
    unresolved: null,
    unresolvedTruncated: false,
    size: null,
    base: { kind: 'unknown' },
    headOid: 'sha101',
    ...over,
  }
}

function summary(over: Partial<CiSummary> = {}): CiSummary {
  return {
    total: 4,
    passed: 3,
    failed: 1,
    pending: 0,
    failures: [{ name: 'unit (node 22)', annotations: ['src/a.ts:3 expected 1 to be 2'], url: 'https://github.com/x' }],
    ...over,
  }
}

async function renderQueue(items: QueueItem[], signals: Record<string, QueueSignal>) {
  vi.spyOn(queueModule, 'fetchAllQueues').mockResolvedValue(items)
  vi.spyOn(signalsModule, 'fetchAllQueueSignals').mockResolvedValue(signals)
  vi.spyOn(sizesModule, 'fetchMissingSizes').mockResolvedValue(undefined)
  const result = render(Landing)
  await screen.findByRole('button', { name: new RegExp(`#${items[0].ref.number}`, 'i') })
  return result
}

/** One red PR of the user's own, with a bridge ready at its head. */
async function renderOneRedRow(over: Partial<QueueSignal> = {}) {
  const only = item(101)
  return renderQueue([only], { [queueKey(only)]: signal(over) })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  readiness = READY
  getCiSummaryMock.mockResolvedValue(summary())
  localStorage.setItem(
    'review123:settings',
    JSON.stringify({ githubAuth: { token: 't', method: 'pat', scopes: [] }, deepseekKey: 'sk-x', aiProvider: 'deepseek' }),
  )
})

// ---------------------------------------------------------------------------
// Who gets the offer
// ---------------------------------------------------------------------------

describe('Landing — who is offered the CI-fix panel', () => {
  it('offers it on the user’s own failing GitHub PR when the bridge is ready at that commit', async () => {
    await renderOneRedRow()
    const control = await screen.findByTestId('queue-ci-fix')
    expect(control).toHaveTextContent('Fix CI')
    // A toggle, tied to the region it opens — not a link to somewhere else.
    expect(control).toHaveAttribute('aria-expanded', 'false')
    expect(control.getAttribute('aria-controls')).toBeTruthy()
  })

  it('never offers it on someone else’s PR — the flow ends in a push to the head branch', async () => {
    const theirs = item(201, { mine: false })
    await renderQueue([theirs], { [queueKey(theirs)]: signal() })
    expect(screen.queryByTestId('queue-ci-fix')).toBeNull()
  })

  it('never offers it on a provider whose push target this app will not guess', async () => {
    const gl = item(301, { provider: 'gitlab' })
    await renderQueue([gl], { [queueKey(gl)]: signal() })
    expect(screen.queryByTestId('queue-ci-fix')).toBeNull()
  })

  it.each([
    ['passing', { ci: 'passing' as const }],
    ['running', { ci: 'running' as const }],
    ['no checks configured', { ci: 'none' as const }],
    ['the query could not answer', { ci: null }],
  ])('never offers it when CI is %s', async (_label, over) => {
    await renderOneRedRow(over)
    expect(screen.queryByTestId('queue-ci-fix')).toBeNull()
  })

  it('never offers it without a head sha — there is nothing to build the worktree from', async () => {
    await renderOneRedRow({ headOid: null })
    expect(screen.queryByTestId('queue-ci-fix')).toBeNull()
  })

  it.each([
    ['no bridge is paired', 'no-bridge'],
    ['the bridge may not write', 'write-disabled'],
    ['the checkout is on another commit', 'head-mismatch'],
  ] as const)('never offers it when %s', async (_label, reason) => {
    readiness = { ...READY, ready: false, reason, cli: null }
    await renderOneRedRow()
    expect(screen.queryByTestId('queue-ci-fix')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The actions column reserves room for two controls, or for neither
// ---------------------------------------------------------------------------

describe('Landing — the actions column', () => {
  it('widens for the whole list as soon as one row can offer the control', async () => {
    const { container } = await renderOneRedRow()
    await screen.findByTestId('queue-ci-fix')
    expect(container.querySelector('.queue-list.ci-fix-column')).not.toBeNull()
  })

  it('stays at its old measure when no row can — nobody pays for a bridge they do not have', async () => {
    readiness = { ...READY, ready: false, reason: 'no-bridge', cli: null }
    const { container } = await renderOneRedRow()
    expect(container.querySelector('.queue-list')).not.toBeNull()
    expect(container.querySelector('.queue-list.ci-fix-column')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Where the CiSummary comes from, and what one render costs
// ---------------------------------------------------------------------------

describe('Landing — the CI summary is fetched on demand', () => {
  it('fetches nothing on render, however red the queue is', async () => {
    const a = item(101)
    const b = item(102)
    const c = item(103)
    await renderQueue([a, b, c], {
      [queueKey(a)]: signal({ headOid: 'sha101' }),
      [queueKey(b)]: signal({ headOid: 'sha102' }),
      [queueKey(c)]: signal({ headOid: 'sha103' }),
    })
    expect(await screen.findAllByTestId('queue-ci-fix')).toHaveLength(3)
    expect(getCiSummaryMock).not.toHaveBeenCalled()
  })

  it('fetches exactly one summary, for the opened row’s head sha, and mounts the panel with it', async () => {
    const a = item(101)
    const b = item(102)
    await renderQueue([a, b], {
      [queueKey(a)]: signal({ headOid: 'sha101' }),
      [queueKey(b)]: signal({ headOid: 'sha102' }),
    })

    await fireEvent.click((await screen.findAllByTestId('queue-ci-fix'))[1])

    expect(getCiSummaryMock).toHaveBeenCalledTimes(1)
    expect(getCiSummaryMock).toHaveBeenCalledWith(b.ref, 'sha102')

    // The panel got the real failure list, not the rollup word.
    expect(await screen.findByTestId('ci-fix-panel')).toBeInTheDocument()
    expect(screen.getByTestId('ci-fix-job-count')).toHaveTextContent('1 job failed')
  })

  it('closes on a second click, taking the summary with it', async () => {
    await renderOneRedRow()
    const control = await screen.findByTestId('queue-ci-fix')

    await fireEvent.click(control)
    expect(await screen.findByTestId('ci-fix-panel')).toBeInTheDocument()
    expect(control).toHaveAttribute('aria-expanded', 'true')
    expect(control).toHaveTextContent('Hide CI')

    await fireEvent.click(control)
    expect(screen.queryByTestId('ci-fix-panel')).toBeNull()
    expect(screen.queryByTestId('queue-ci-fix-row')).toBeNull()
    expect(control).toHaveAttribute('aria-expanded', 'false')
    expect(getCiSummaryMock).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// The two ways of having no failure list, neither of which is green
// ---------------------------------------------------------------------------

describe('Landing — a summary the provider could not answer', () => {
  it('says the checks could not be read, and renders no panel', async () => {
    getCiSummaryMock.mockRejectedValue(new Error('403'))
    await renderOneRedRow()
    await fireEvent.click(await screen.findByTestId('queue-ci-fix'))

    const note = await screen.findByTestId('queue-ci-fix-unreadable')
    expect(note).toHaveTextContent('could not read this pull request’s checks')
    // The one thing it must not read as.
    expect(note).toHaveTextContent('not a passing result')
    expect(screen.queryByTestId('ci-fix-panel')).toBeNull()
  })

  it('distinguishes "no failing check run named" from "could not read", and still renders no panel', async () => {
    getCiSummaryMock.mockResolvedValue(summary({ failed: 0, failures: [] }))
    await renderOneRedRow()
    await fireEvent.click(await screen.findByTestId('queue-ci-fix'))

    const note = await screen.findByTestId('queue-ci-fix-unreadable')
    expect(note).toHaveTextContent('named no failing check run')
    expect(note).toHaveTextContent('not a passing result')
    expect(screen.queryByTestId('ci-fix-panel')).toBeNull()
  })

  it('the row still says CI is failing while the panel says it cannot name the job', async () => {
    getCiSummaryMock.mockResolvedValue(summary({ failed: 0, failures: [] }))
    await renderOneRedRow()
    await fireEvent.click(await screen.findByTestId('queue-ci-fix'))
    await screen.findByTestId('queue-ci-fix-unreadable')
    expect(screen.getByTestId('queue-ci')).toHaveAttribute('data-ci', 'failing')
  })
})
