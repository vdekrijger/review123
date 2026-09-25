/**
 * src/routes/Landing.signals.test.ts — the queue row's CI, unresolved-
 * conversation and base-standing signals, and the section re-weighting.
 *
 * WHAT THIS FILE IS FOR. Three separate things that all had to be got right at
 * once, and that no single other file covers:
 *
 *   1. Every signal state renders as itself, and the FOUR different ways of
 *      having nothing to say all render as nothing. "No CI configured", "the
 *      query could not answer", "this provider has no signals at all" and "zero
 *      unresolved" are different facts with the same appearance, and the one
 *      thing none of them may look like is a pass.
 *   2. The Update control is offered ONLY where it can work, and its refusals
 *      are visible in place rather than thrown.
 *   3. "Your open PRs" leads, and the LEAD TREATMENT follows position rather
 *      than section id — which is what keeps a user with no open PRs off a page
 *      whose most prominent section is empty.
 *
 * Geometry is not here: jsdom computes no layout. e2e/queue-columns.spec.ts
 * measures that the new columns actually align.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/svelte'
import Landing from './Landing.svelte'
import * as queueModule from '../lib/provider/queue'
import * as signalsModule from '../lib/provider/queueSignals'
import * as sizesModule from '../lib/landing/queueSizes'
import { queueKey } from '../lib/provider/queue'
import type { QueueItem, QueueSignal } from '../lib/provider/types'
import { _setCaptureForTest } from '../lib/analytics/analytics'

vi.mock('../lib/router/router.svelte', () => ({ navigate: vi.fn() }))

const updateBranchMock = vi.fn()

vi.mock('../lib/provider/registry', () => ({
  PROVIDERS: new Map([
    ['github', {
      id: 'github',
      displayName: 'GitHub',
      authState: () => ({ configured: true, hint: '' }),
      getMyQueue: vi.fn(),
      getQueueSignals: vi.fn(),
      updateBranch: (...args: unknown[]) => updateBranchMock(...args),
      capabilities: { resolvedThreads: false, checks: false, suggestions: false, atomicReview: false, compare: false, commentReplies: false, selfReviewBlocked: false },
    }],
  ]),
  parseAnyUrl: vi.fn().mockReturnValue(null),
}))

function item(number: number, authorIsMe = false, repo = 'repo'): QueueItem {
  return {
    ref: { provider: 'github', owner: 'org', repo, number },
    title: `PR ${number}`,
    authorIsMe,
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
  }
}

function signal(over: Partial<QueueSignal> = {}): QueueSignal {
  return {
    ci: null,
    unresolved: null,
    threads: null,
    unresolvedTruncated: false,
    size: null,
    base: { kind: 'unknown' },
    headOid: 'sha1',
    ...over,
  }
}

/** Render with a queue and a signals map, and wait for the rows. */
async function renderQueue(items: QueueItem[], signals: Record<string, QueueSignal> = {}) {
  vi.spyOn(queueModule, 'fetchAllQueues').mockResolvedValue(items)
  vi.spyOn(signalsModule, 'fetchAllQueueSignals').mockResolvedValue(signals)
  // The REST size pass is a separate concern; keep it inert so nothing races.
  vi.spyOn(sizesModule, 'fetchMissingSizes').mockResolvedValue(undefined)
  const result = render(Landing)
  await screen.findByRole('button', { name: new RegExp(`#${items[0].ref.number}`, 'i') })
  return result
}

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  updateBranchMock.mockReset()
  queueModule._resetQueueCacheForTest()
})

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------

describe('queue row — CI state', () => {
  it.each([
    ['passing', 'CI passing'],
    ['failing', 'CI failing'],
    ['running', 'CI running'],
  ] as const)('renders %s with a named state, not colour alone', async (ci, label) => {
    const it0 = item(1)
    await renderQueue([it0], { [queueKey(it0)]: signal({ ci }) })

    const chip = await screen.findByTestId('queue-ci')
    expect(chip).toHaveAttribute('data-ci', ci)
    // The state is readable without seeing the colour: it is in the accessible
    // text and in the hover title, and the glyphs are three different shapes.
    expect(chip).toHaveAttribute('title', label)
    expect(chip.textContent).toContain(label)
  })

  it.each([
    ['a PR with no CI configured', signal({ ci: 'none' })],
    ['a PR the query could not answer for', signal({ ci: null })],
  ])('renders no CI mark for %s', async (_label, sig) => {
    const it0 = item(1)
    await renderQueue([it0], { [queueKey(it0)]: sig })
    expect(screen.queryByTestId('queue-ci')).not.toBeInTheDocument()
  })

  it('reserves the CI column even when there is no mark, so nothing reflows later', async () => {
    const it0 = item(1)
    const { container } = await renderQueue([it0], {})
    // The CELL is always present; only its contents wait on the query.
    expect(container.querySelector('.ci-cell')).not.toBeNull()
    expect(screen.queryByTestId('queue-ci')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Unresolved conversations
// ---------------------------------------------------------------------------

describe('queue row — unresolved conversations', () => {
  it('shows x/y, because the numerator alone ranks nothing', async () => {
    // "3 open" says the same thing on a review with three conversations and on
    // one with thirty. These are two different rows to open.
    const it0 = item(1)
    await renderQueue([it0], { [queueKey(it0)]: signal({ unresolved: 3, threads: 11 }) })

    const chip = await screen.findByTestId('queue-unresolved')
    expect(chip.textContent).toContain('3/11 open')
    // The word the numbers actually mean rides on the title and the accessible
    // name, where there is room to read it in full — denominator included.
    expect(chip).toHaveAttribute('title', '3 of 11 conversations unresolved')
    expect(chip.textContent).toContain('3 of 11 conversations unresolved')
  })

  it('says "conversation", singular, when the whole PR has one', async () => {
    const it0 = item(1)
    await renderQueue([it0], { [queueKey(it0)]: signal({ unresolved: 1, threads: 1 }) })
    const chip = await screen.findByTestId('queue-unresolved')
    expect(chip.textContent).toContain('1/1 open')
    expect(chip).toHaveAttribute('title', '1 of 1 conversation unresolved')
  })

  it('DROPS the fraction when the page was truncated — two floors is not a fraction', async () => {
    const it0 = item(1)
    await renderQueue([it0], {
      [queueKey(it0)]: signal({ unresolved: 100, threads: 100, unresolvedTruncated: true }),
    })
    const chip = await screen.findByTestId('queue-unresolved')
    // Not "100+/100+": both halves are floors past GitHub's page cap, and a
    // reader would do arithmetic on the slash anyway.
    expect(chip.textContent).toContain('100+ open')
    expect(chip.textContent).not.toContain('/')
    expect(chip).toHaveAttribute('title', '100+ unresolved conversations')
    expect(chip.textContent).toContain('100 or more')
  })

  it('drops the fraction when the denominator is unknown, rather than inventing one', async () => {
    const it0 = item(1)
    await renderQueue([it0], { [queueKey(it0)]: signal({ unresolved: 3, threads: null }) })
    const chip = await screen.findByTestId('queue-unresolved')
    expect(chip.textContent).toContain('3 open')
    expect(chip.textContent).not.toContain('/')
  })

  it.each([
    ['zero unresolved', signal({ unresolved: 0, threads: 4 })],
    ['an unanswerable row', signal({ unresolved: null, threads: null })],
  ])('renders nothing for %s', async (_label, sig) => {
    const it0 = item(1)
    await renderQueue([it0], { [queueKey(it0)]: sig })
    expect(screen.queryByTestId('queue-unresolved')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Base standing + Update
// ---------------------------------------------------------------------------

describe('queue row — base standing and the Update control', () => {
  it('offers Update when the PR is behind and the viewer can push', async () => {
    const it0 = item(1, true)
    await renderQueue([it0], {
      [queueKey(it0)]: signal({ base: { kind: 'behind', canUpdate: true } }),
    })
    const btn = await screen.findByTestId('queue-base')
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.textContent).toContain('Update')
  })

  it('states the PR is behind WITHOUT a button when the viewer cannot push', async () => {
    const it0 = item(1, true)
    await renderQueue([it0], {
      [queueKey(it0)]: signal({ base: { kind: 'behind', canUpdate: false } }),
    })
    const chip = await screen.findByTestId('queue-base')
    expect(chip.tagName).not.toBe('BUTTON')
    expect(chip.textContent).toContain('behind')
  })

  it('a conflict says so in words — no button that would fail', async () => {
    const it0 = item(1, true)
    await renderQueue([it0], { [queueKey(it0)]: signal({ base: { kind: 'conflicted' } }) })
    const chip = await screen.findByTestId('queue-base')
    expect(chip.tagName).not.toBe('BUTTON')
    expect(chip.textContent).toContain('conflicts')
    expect(chip.getAttribute('title')).toMatch(/can't be merged on the server/i)
  })

  it.each([
    ['up to date', signal({ base: { kind: 'current' } })],
    ['not yet judged by GitHub', signal({ base: { kind: 'unknown' } })],
  ])('renders nothing when the PR is %s', async (_label, sig) => {
    const it0 = item(1, true)
    await renderQueue([it0], { [queueKey(it0)]: sig })
    expect(screen.queryByTestId('queue-base')).not.toBeInTheDocument()
  })

  it('passes the head SHA it read, so a push in between is refused', async () => {
    const it0 = item(1, true)
    updateBranchMock.mockResolvedValue({ ok: true, message: 'Updating.' })
    await renderQueue([it0], {
      [queueKey(it0)]: signal({ base: { kind: 'behind', canUpdate: true }, headOid: 'cafe1234' }),
    })

    await fireEvent.click(screen.getByTestId('queue-base'))
    expect(updateBranchMock).toHaveBeenCalledWith(it0.ref, 'cafe1234')
  })

  it('re-reads the signals after a successful update, instead of asserting what CI will do', async () => {
    const it0 = item(1, true)
    updateBranchMock.mockResolvedValue({ ok: true, message: 'Updating.' })
    const fetchSignals = vi
      .spyOn(signalsModule, 'fetchAllQueueSignals')
      .mockResolvedValue({ [queueKey(it0)]: signal({ base: { kind: 'behind', canUpdate: true } }) })
    vi.spyOn(queueModule, 'fetchAllQueues').mockResolvedValue([it0])
    vi.spyOn(sizesModule, 'fetchMissingSizes').mockResolvedValue(undefined)

    render(Landing)
    await screen.findByTestId('queue-base')
    const before = fetchSignals.mock.calls.length

    // The merge puts a new commit on the branch, so the head SHA changes and CI
    // starts over. The row asks GitHub what happened rather than guessing.
    fetchSignals.mockResolvedValue({ [queueKey(it0)]: signal({ ci: 'running', base: { kind: 'current' } }) })
    await fireEvent.click(screen.getByTestId('queue-base'))

    expect(fetchSignals.mock.calls.length).toBeGreaterThan(before)
    const ci = await screen.findByTestId('queue-ci')
    expect(ci).toHaveAttribute('data-ci', 'running')
    expect(screen.queryByTestId('queue-base')).not.toBeInTheDocument()
  })

  it('a refusal is shown in place, with GitHub’s reason on the title, and is retryable', async () => {
    const it0 = item(1, true)
    updateBranchMock.mockResolvedValue({
      ok: false,
      kind: 'conflict',
      message: 'merge conflict between base and head',
    })
    await renderQueue([it0], {
      [queueKey(it0)]: signal({ base: { kind: 'behind', canUpdate: true } }),
    })

    await fireEvent.click(screen.getByTestId('queue-base'))

    const retry = await screen.findByTestId('queue-base')
    expect(retry.textContent).toContain('Retry')
    expect(retry).toHaveAttribute('title', 'merge conflict between base and head')
    // The failure is not only in the tooltip — it is in the accessible name too.
    expect(retry.getAttribute('aria-label')).toMatch(/failed: merge conflict/i)
  })

  it('reports only the outcome enum to analytics — never the repo or the number', async () => {
    const events: Array<{ name: string; props: Record<string, unknown> }> = []
    _setCaptureForTest((name, props) => { events.push({ name, props }) })

    const it0 = item(1, true)
    updateBranchMock.mockResolvedValue({ ok: false, kind: 'forbidden', message: 'nope' })
    await renderQueue([it0], {
      [queueKey(it0)]: signal({ base: { kind: 'behind', canUpdate: true } }),
    })
    await fireEvent.click(screen.getByTestId('queue-base'))

    const event = events.find((e) => e.name === 'queue_branch_updated')
    expect(event).toBeDefined()
    expect(event?.props).toEqual({ outcome: 'forbidden' })
    _setCaptureForTest(() => {})
  })
})

// ---------------------------------------------------------------------------
// Sizes come from the batched query
// ---------------------------------------------------------------------------

describe('queue row — sizes from the signals query', () => {
  it('draws the size chip from the batched query, with no per-row REST fetch', async () => {
    const it0 = item(1)
    const fetchMissing = vi.spyOn(sizesModule, 'fetchMissingSizes').mockResolvedValue(undefined)
    vi.spyOn(queueModule, 'fetchAllQueues').mockResolvedValue([it0])
    vi.spyOn(signalsModule, 'fetchAllQueueSignals').mockResolvedValue({
      [queueKey(it0)]: signal({ size: { additions: 216, deletions: 179 } }),
    })

    render(Landing)

    const chip = await screen.findByTestId('queue-size')
    expect(chip.textContent).toContain('+216')
    expect(chip.textContent).toContain('−179')
    // The REST pass still runs — it is what covers rows GraphQL could not
    // answer — but the primed cache leaves it nothing pending for this one.
    expect(fetchMissing.mock.calls[0][0]).toEqual([it0])
  })

  it('asks for base standing ONLY for the user’s own PRs', async () => {
    const mine = item(1, true)
    const theirs = item(2, false)
    const fetchSignals = vi.spyOn(signalsModule, 'fetchAllQueueSignals').mockResolvedValue({})
    vi.spyOn(queueModule, 'fetchAllQueues').mockResolvedValue([mine, theirs])
    vi.spyOn(sizesModule, 'fetchMissingSizes').mockResolvedValue(undefined)

    render(Landing)
    await screen.findByRole('button', { name: /#1/i })

    const [, items, mergeStateItems] = fetchSignals.mock.calls[0] as [
      unknown,
      QueueItem[],
      QueueItem[],
    ]
    expect(items).toHaveLength(2)
    // Asking about a PR the user cannot push to buys a request for something no
    // row will ever render.
    expect(mergeStateItems).toEqual([mine])
  })
})

// ---------------------------------------------------------------------------
// Section weight
// ---------------------------------------------------------------------------

describe('the queue’s centre of gravity', () => {
  it('leads with "Your open PRs", not with what is awaiting review', async () => {
    await renderQueue([item(1, false), item(2, true)])

    const titles = [...document.querySelectorAll('.queue-group-title')].map((h) => h.textContent?.trim())
    expect(titles).toEqual(['Your open PRs', 'Awaiting your review'])
  })

  it('gives the lead treatment to the first group by POSITION, not by section id', async () => {
    await renderQueue([item(1, false), item(2, true)])

    const mine = screen.getByTestId('queue-group-mine')
    const awaiting = screen.getByTestId('queue-group-awaiting')
    expect(mine.classList.contains('lead')).toBe(true)
    expect(awaiting.classList.contains('lead')).toBe(false)
  })

  it('a newcomer with no open PRs is led by a section that has rows in it', async () => {
    // The whole risk of promoting "Your open PRs" is landing somebody on a page
    // whose most prominent section is empty. There is no empty section: the
    // group is not rendered at all, and the lead treatment moves to whatever
    // actually leads.
    await renderQueue([item(1, false)])

    expect(screen.queryByTestId('queue-group-mine')).not.toBeInTheDocument()
    const awaiting = screen.getByTestId('queue-group-awaiting')
    expect(awaiting.classList.contains('lead')).toBe(true)
  })

  it('a user with only their own PRs sees exactly one group, leading', async () => {
    await renderQueue([item(1, true)])

    const titles = [...document.querySelectorAll('.queue-group-title')]
    expect(titles).toHaveLength(1)
    expect(titles[0].textContent?.trim()).toBe('Your open PRs')
    expect(titles[0].classList.contains('lead')).toBe(true)
  })

  it('keeps each group’s rows under its own heading after the reorder', async () => {
    const { container } = await renderQueue([
      item(1, false, 'theirs'),
      item(2, true, 'mine'),
    ])

    // The lists are rendered in group order, so the first list belongs to the
    // first heading. A reorder that moved the titles but not the rows would
    // pass every assertion above and be completely wrong.
    const lists = [...container.querySelectorAll('.queue-list')]
    expect(within(lists[0] as HTMLElement).getByText('#2')).toBeInTheDocument()
    expect(within(lists[1] as HTMLElement).getByText('#1')).toBeInTheDocument()
  })
})
