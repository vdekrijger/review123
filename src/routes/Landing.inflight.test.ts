/**
 * Landing "In-flight reviews" section — surfaces PRs with UNSUBMITTED draft
 * comments (grouped by PR identity), with resume + discard-with-confirm.
 *
 * Uses fake-indexeddb so the real drafts store seeds rows the section reads.
 */
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/svelte'
import Landing from './Landing.svelte'
import { navigate } from '../lib/router/router.svelte'
import * as queueModule from '../lib/provider/queue'
import { createDraftStore, listDraftSummaries } from '../lib/drafts/drafts.svelte'
import { addToHistory } from '../lib/history/history'

vi.mock('../lib/router/router.svelte', () => ({ navigate: vi.fn() }))

// No queue providers configured → the queue section stays hidden, isolating
// the in-flight section under test.
vi.mock('../lib/provider/registry', () => ({
  PROVIDERS: new Map([
    ['github', {
      id: 'github',
      displayName: 'GitHub',
      authState: () => ({ configured: false, hint: '' }),
      capabilities: { resolvedThreads: false, checks: false, suggestions: false, atomicReview: false, compare: false, commentReplies: false, selfReviewBlocked: false },
    }],
  ]),
  parseAnyUrl: vi.fn().mockReturnValue(null),
}))

async function seedDraft(prKey: string, path: string, line: number, body: string) {
  const store = createDraftStore(prKey) // default DB — what the section reads
  await store.load()
  await store.upsert({ path, line, side: 'RIGHT', body })
}

async function clearAllDrafts() {
  const summaries = await listDraftSummaries()
  const { clearDraftsForPr } = await import('../lib/drafts/drafts.svelte')
  for (const s of summaries) await clearDraftsForPr(s.prKey)
}

describe('Landing in-flight reviews section', () => {
  beforeEach(async () => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.mocked(navigate).mockClear()
    queueModule._resetQueueCacheForTest?.()
    await clearAllDrafts()
  })

  it('is hidden when there are no drafts', async () => {
    render(Landing)
    // Give the mount effect a tick to resolve the (empty) summaries.
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId('inflight-section')).not.toBeInTheDocument()
    expect(screen.queryByText(/In-flight reviews/i)).not.toBeInTheDocument()
  })

  it('renders a row with icon, ref, count chip, and relative time when drafts exist', async () => {
    await seedDraft('github:acme/widgets#42@sha1', 'a.ts', 1, 'first')
    await seedDraft('github:acme/widgets#42@sha1', 'a.ts', 2, 'second')

    const { container } = render(Landing)
    await screen.findByTestId('inflight-section')

    expect(screen.getByText(/In-flight reviews/i)).toBeInTheDocument()
    const row = screen.getByRole('button', { name: /Resume review of acme\/widgets#42/i })
    expect(row).toBeInTheDocument()
    expect(within(row).getByTestId('inflight-count')).toHaveTextContent('2 comments drafted')
    // Provider brand icon present
    expect(container.querySelector('.inflight-link [data-provider="github"] svg')).not.toBeNull()
  })

  it('groups multiple head-SHA variants of one PR into a single row with summed count', async () => {
    await seedDraft('github:acme/widgets#7@oldsha', 'a.ts', 1, 'on old commit')
    await seedDraft('github:acme/widgets#7@newsha', 'a.ts', 1, 'on new commit')
    await seedDraft('github:acme/widgets#7@newsha', 'a.ts', 2, 'second new')

    render(Landing)
    await screen.findByTestId('inflight-section')

    const rows = screen.getAllByRole('button', { name: /Resume review of acme\/widgets#7/i })
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByTestId('inflight-count')).toHaveTextContent('3 comments drafted')
    // Multiple shas → "from an earlier commit" hint
    expect(screen.getByText(/from an earlier commit/i)).toBeInTheDocument()
  })

  it('shows the PR title from history when available', async () => {
    addToHistory({ provider: 'github', owner: 'acme', repo: 'widgets', number: 42, title: 'Add the thing' })
    await seedDraft('github:acme/widgets#42@sha1', 'a.ts', 1, 'first')

    render(Landing)
    const section = await screen.findByTestId('inflight-section')
    expect(within(section).getByText('Add the thing')).toBeInTheDocument()
  })

  it('clicking a row resumes the review at the inspect step', async () => {
    await seedDraft('github:acme/widgets#42@sha1', 'a.ts', 1, 'first')

    render(Landing)
    const row = await screen.findByRole('button', { name: /Resume review of acme\/widgets#42/i })
    await fireEvent.click(row)

    expect(navigate).toHaveBeenCalledWith('/review/github/acme/widgets/42/inspect')
  })

  it('discard asks for confirmation, then removes the row and clears the drafts', async () => {
    await seedDraft('github:acme/widgets#42@sha1', 'a.ts', 1, 'first')
    await seedDraft('github:acme/widgets#42@sha1', 'a.ts', 2, 'second')

    render(Landing)
    await screen.findByTestId('inflight-section')

    const discardBtn = screen.getByRole('button', { name: /Discard drafts for acme\/widgets#42/i })
    await fireEvent.click(discardBtn)

    // A themed confirm dialog appears (not destroyed yet)
    const dialog = await screen.findByRole('dialog', { name: /Discard drafts/i })
    expect(within(dialog).getByText(/Discard 2 unsubmitted comments on acme\/widgets#42/i)).toBeInTheDocument()
    // Drafts still present until confirmed
    expect(await listDraftSummaries()).toHaveLength(1)

    await fireEvent.click(within(dialog).getByRole('button', { name: /^Discard$/i }))

    // Row gone, drafts cleared from IndexedDB
    await vi.waitFor(async () => {
      expect(screen.queryByTestId('inflight-section')).not.toBeInTheDocument()
    })
    expect(await listDraftSummaries()).toHaveLength(0)
  })

  it('cancelling the discard keeps the row and the drafts', async () => {
    await seedDraft('github:acme/widgets#42@sha1', 'a.ts', 1, 'first')

    render(Landing)
    await screen.findByTestId('inflight-section')

    await fireEvent.click(screen.getByRole('button', { name: /Discard drafts for acme\/widgets#42/i }))
    const dialog = await screen.findByRole('dialog', { name: /Discard drafts/i })
    await fireEvent.click(within(dialog).getByRole('button', { name: /Cancel/i }))

    expect(screen.getByTestId('inflight-section')).toBeInTheDocument()
    expect(await listDraftSummaries()).toHaveLength(1)
  })
})
