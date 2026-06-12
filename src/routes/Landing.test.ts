import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import Landing from './Landing.svelte'
import { navigate } from '../lib/router/router.svelte'
import * as queueModule from '../lib/provider/queue'
import type { QueueItem } from '../lib/provider/types'
import { addToHistory, clearHistory } from '../lib/history/history'
import { setSectionCollapsed } from '../lib/landing/collapse'
import { _setCaptureForTest } from '../lib/analytics/analytics'
import userEvent from '@testing-library/user-event'

// Mock navigate — all navigation checks use vi.mocked(navigate) calls
vi.mock('../lib/router/router.svelte', () => ({
  navigate: vi.fn(),
}))

// Mock the registry so we control which providers are present
vi.mock('../lib/provider/registry', () => ({
  PROVIDERS: new Map([
    ['github', {
      id: 'github',
      displayName: 'GitHub',
      authState: () => ({ configured: true, hint: '' }),
      getMyQueue: vi.fn(),
      capabilities: { resolvedThreads: false, checks: false, suggestions: false, atomicReview: false, compare: false, selfReviewBlocked: false },
    }],
  ]),
  parseAnyUrl: vi.fn().mockReturnValue(null),
}))

function makeItem(provider: 'github' | 'gitlab', owner: string, repo: string, number: number, title: string, authorIsMe: boolean): QueueItem {
  return {
    ref: { provider, owner, repo, number },
    title,
    authorIsMe,
    updatedAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
  }
}

describe('Landing queue section', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    queueModule._resetQueueCacheForTest()
  })

  it('shows loading state while fetching', async () => {
    // fetchAllQueues never resolves during this test
    vi.spyOn(queueModule, 'fetchAllQueues').mockReturnValue(new Promise(() => {}))

    render(Landing)
    expect(screen.getByText(/Loading your queue/i)).toBeTruthy()
  })

  it('shows skeleton rows while the initial fetch is in flight', () => {
    vi.spyOn(queueModule, 'fetchAllQueues').mockReturnValue(new Promise(() => {}))

    render(Landing)
    const skeleton = screen.getByTestId('queue-skeleton')
    expect(skeleton).toBeInTheDocument()
    expect(skeleton).toHaveAttribute('aria-busy', 'true')
  })

  it('replaces skeletons with rows when the fetch resolves', async () => {
    let resolveFetch!: (items: QueueItem[]) => void
    vi.spyOn(queueModule, 'fetchAllQueues').mockReturnValue(
      new Promise<QueueItem[]>((resolve) => { resolveFetch = resolve }),
    )

    render(Landing)
    expect(screen.getByTestId('queue-skeleton')).toBeInTheDocument()

    resolveFetch([makeItem('github', 'org', 'repo', 5, 'Resolved PR', false)])
    await screen.findByText(/org\/repo#5/i)
    expect(screen.queryByTestId('queue-skeleton')).not.toBeInTheDocument()
  })

  it('replaces skeletons with the empty state when the fetch resolves empty', async () => {
    let resolveFetch!: (items: QueueItem[]) => void
    vi.spyOn(queueModule, 'fetchAllQueues').mockReturnValue(
      new Promise<QueueItem[]>((resolve) => { resolveFetch = resolve }),
    )

    render(Landing)
    expect(screen.getByTestId('queue-skeleton')).toBeInTheDocument()

    resolveFetch([])
    await screen.findByText(/No PRs in your queue/i)
    expect(screen.queryByTestId('queue-skeleton')).not.toBeInTheDocument()
  })

  it('refresh keeps existing rows visible but dimmed, with the refresh button disabled', async () => {
    const item = makeItem('github', 'org', 'repo', 9, 'Existing PR', false)
    let resolveRefresh!: (items: QueueItem[]) => void
    vi.spyOn(queueModule, 'fetchAllQueues')
      .mockResolvedValueOnce([item])
      .mockReturnValueOnce(new Promise<QueueItem[]>((resolve) => { resolveRefresh = resolve }))

    render(Landing)
    await screen.findByText(/org\/repo#9/i)

    const refreshBtn = screen.getByRole('button', { name: /refresh queue/i })
    await fireEvent.click(refreshBtn)

    // Rows stay visible (no skeleton swap), dimmed while in flight
    expect(screen.getByText(/org\/repo#9/i)).toBeInTheDocument()
    expect(screen.queryByTestId('queue-skeleton')).not.toBeInTheDocument()
    const rows = screen.getByTestId('queue-rows')
    expect(rows).toHaveAttribute('aria-busy', 'true')
    expect(rows.classList.contains('refreshing')).toBe(true)
    expect(refreshBtn).toBeDisabled()

    resolveRefresh([makeItem('github', 'org', 'repo', 10, 'Fresh PR', false)])
    await screen.findByText(/org\/repo#10/i)
    expect(screen.getByTestId('queue-rows')).toHaveAttribute('aria-busy', 'false')
    expect(refreshBtn).not.toBeDisabled()
  })

  it('refresh from the empty state shows skeletons (no rows to keep)', async () => {
    vi.spyOn(queueModule, 'fetchAllQueues')
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(new Promise<QueueItem[]>(() => {}))

    render(Landing)
    await screen.findByText(/No PRs in your queue/i)

    await fireEvent.click(screen.getByRole('button', { name: /refresh queue/i }))
    expect(screen.getByTestId('queue-skeleton')).toBeInTheDocument()
    expect(screen.queryByText(/No PRs in your queue/i)).not.toBeInTheDocument()
  })

  it('shows queue items grouped by awaiting/authored', async () => {
    const reviewItem = makeItem('github', 'org', 'repo', 1, 'PR for review', false)
    const authorItem = makeItem('github', 'org', 'repo', 2, 'My PR', true)

    vi.spyOn(queueModule, 'fetchAllQueues').mockResolvedValue([reviewItem, authorItem])

    render(Landing)

    // Wait for async fetch to complete
    await screen.findByText(/Awaiting your review/i)
    expect(screen.getByText(/Your open PRs/i)).toBeTruthy()
    expect(screen.getByText(/org\/repo#1/i)).toBeTruthy()
    expect(screen.getByText(/org\/repo#2/i)).toBeTruthy()
  })

  it('clicking a queue row navigates to the review route', async () => {
    const item = makeItem('github', 'org', 'repo', 42, 'My PR', false)
    vi.spyOn(queueModule, 'fetchAllQueues').mockResolvedValue([item])

    render(Landing)
    const btn = await screen.findByRole('button', { name: /org\/repo#42/i })
    fireEvent.click(btn)

    expect(navigate).toHaveBeenCalledWith('/review/github/org/repo/42')
  })

  it('shows empty state when queue is empty', async () => {
    vi.spyOn(queueModule, 'fetchAllQueues').mockResolvedValue([])

    render(Landing)
    await screen.findByText(/No PRs in your queue/i)
  })
})

describe('Landing queue provider icons + per-repo grouping', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.mocked(navigate).mockClear()
    queueModule._resetQueueCacheForTest()
  })

  it('renders a provider brand icon instead of the "GH" text chip', async () => {
    const item = makeItem('github', 'org', 'repo', 1, 'PR for review', false)
    vi.spyOn(queueModule, 'fetchAllQueues').mockResolvedValue([item])

    const { container } = render(Landing)
    await screen.findByText(/Awaiting your review/i)

    expect(screen.queryByText('GH')).not.toBeInTheDocument()
    const icon = container.querySelector('.queue-link [data-provider="github"] svg')
    expect(icon).not.toBeNull()
    expect(icon!.getAttribute('aria-hidden')).toBe('true')
  })

  it('single-repo list stays flat: full owner/repo#number per row, no repo header', async () => {
    const items = [
      makeItem('github', 'org', 'repo', 1, 'First', false),
      makeItem('github', 'org', 'repo', 2, 'Second', false),
    ]
    vi.spyOn(queueModule, 'fetchAllQueues').mockResolvedValue(items)

    const { container } = render(Landing)
    await screen.findByText(/Awaiting your review/i)

    expect(container.querySelector('.repo-group-header')).toBeNull()
    expect(screen.getByText(/org\/repo#1/)).toBeInTheDocument()
    expect(screen.getByText(/org\/repo#2/)).toBeInTheDocument()
  })

  it('multi-repo list groups rows under compact repo headers with #number · title rows', async () => {
    const items = [
      makeItem('github', 'org', 'alpha', 1, 'Alpha PR', false),
      makeItem('github', 'org', 'beta', 2, 'Beta PR', false),
      makeItem('github', 'org', 'alpha', 3, 'Alpha second', false),
    ]
    vi.spyOn(queueModule, 'fetchAllQueues').mockResolvedValue(items)

    const { container } = render(Landing)
    await screen.findByText(/Awaiting your review/i)

    // Repo headers with icon + owner/repo
    const headers = [...container.querySelectorAll('.repo-group-header')]
    expect(headers).toHaveLength(2)
    expect(headers[0].textContent).toContain('org/alpha')
    expect(headers[1].textContent).toContain('org/beta')
    expect(headers[0].querySelector('[data-provider="github"] svg')).not.toBeNull()

    // Rows show just #number (owner/repo lives in the header, not the row text)
    expect(screen.getByText('#1')).toBeInTheDocument()
    expect(screen.getByText('#2')).toBeInTheDocument()
    expect(screen.getByText('#3')).toBeInTheDocument()
    expect(screen.queryByText(/org\/alpha#1/)).not.toBeInTheDocument()
  })

  it('grouped rows keep the full accessible name and still navigate on click', async () => {
    const items = [
      makeItem('github', 'org', 'alpha', 1, 'Alpha PR', false),
      makeItem('gitlab', 'grp', 'beta', 2, 'Beta MR', false),
    ]
    vi.spyOn(queueModule, 'fetchAllQueues').mockResolvedValue(items)

    render(Landing)
    await screen.findByText(/Awaiting your review/i)

    const btn = screen.getByRole('button', { name: /grp\/beta#2/i })
    fireEvent.click(btn)
    expect(navigate).toHaveBeenCalledWith('/review/gitlab/grp/beta/2')
  })

  it('grouping is computed per list: awaiting grouped while open PRs stay flat', async () => {
    const items = [
      makeItem('github', 'org', 'alpha', 1, 'Alpha PR', false),
      makeItem('github', 'org', 'beta', 2, 'Beta PR', false),
      makeItem('github', 'org', 'mine', 3, 'My PR', true),
    ]
    vi.spyOn(queueModule, 'fetchAllQueues').mockResolvedValue(items)

    const { container } = render(Landing)
    await screen.findByText(/Your open PRs/i)

    // Awaiting list (2 repos) grouped; my-open-PRs list (1 repo) flat
    expect(container.querySelectorAll('.repo-group-header')).toHaveLength(2)
    expect(screen.getByText(/org\/mine#3/)).toBeInTheDocument()
  })
})

describe('Landing recent reviews provider icons (flat, no grouping)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(navigate).mockClear()
    vi.spyOn(queueModule, 'fetchAllQueues').mockResolvedValue([])
    queueModule._resetQueueCacheForTest()
  })

  it('each history row gets a provider icon; multi-repo history stays flat', () => {
    addToHistory({ owner: 'alice', repo: 'widgets', number: 42, title: 'Add feature' })
    addToHistory({ owner: 'bob', repo: 'gadgets', number: 7, title: 'Fix bug', provider: 'gitlab' })

    const { container } = render(Landing)

    // Flat: no repo group headers in recents, full ref text per row
    expect(container.querySelector('.recent-reviews .repo-group-header')).toBeNull()
    expect(screen.getByText(/alice\/widgets#42/)).toBeInTheDocument()
    expect(screen.getByText(/bob\/gadgets#7/)).toBeInTheDocument()

    // Icon per row; provider defaults to github when entry has no provider
    const icons = container.querySelectorAll('.recent-link [data-provider]')
    expect(icons).toHaveLength(2)
    expect(container.querySelector('.recent-link [data-provider="gitlab"]')).not.toBeNull()
    expect(container.querySelector('.recent-link [data-provider="github"]')).not.toBeNull()
  })
})

describe('Landing', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(navigate).mockClear()
    // Provide a non-pending queue so it doesn't block other tests
    vi.spyOn(queueModule, 'fetchAllQueues').mockResolvedValue([])
    queueModule._resetQueueCacheForTest()
  })

  it('EC-01b: empty submit shows "enter a PR URL", no navigation', async () => {
    render(Landing)
    await userEvent.click(screen.getByRole('button', { name: /^review$/i }))
    expect(screen.getByRole('alert')).toHaveTextContent(/enter a github, gitlab, or bitbucket pull request url/i)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('EC-01i: non-PR URL shows specific message', async () => {
    render(Landing)
    await userEvent.type(screen.getByRole('textbox'), 'https://github.com/just-an-owner')
    await userEvent.click(screen.getByRole('button', { name: /^review$/i }))
    expect(screen.getByRole('alert')).toHaveTextContent(/does not look like a pull request url/i)
  })

  it('description copy and placeholder mention github and gitlab; description also mentions bitbucket', () => {
    render(Landing)
    const input = screen.getByRole('textbox')
    expect(input).toHaveAttribute('placeholder', expect.stringMatching(/github/i))
    expect(input).toHaveAttribute('placeholder', expect.stringMatching(/gitlab/i))
    // The description paragraph (not placeholder) mentions all three providers
    expect(screen.getByText(/github.*gitlab.*bitbucket/i)).toBeInTheDocument()
  })
})

describe('Landing recent reviews', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(navigate).mockClear()
    vi.spyOn(queueModule, 'fetchAllQueues').mockResolvedValue([])
    queueModule._resetQueueCacheForTest()
  })

  it('does not render "Recent reviews" section when history is empty', () => {
    render(Landing)
    expect(screen.queryByText(/recent reviews/i)).not.toBeInTheDocument()
  })

  it('renders "Recent reviews" when history contains entries', () => {
    addToHistory({ owner: 'alice', repo: 'widgets', number: 42, title: 'Add feature' })
    render(Landing)
    expect(screen.getByText(/recent reviews/i)).toBeInTheDocument()
  })

  it('renders history entry as owner/repo#number — title', () => {
    addToHistory({ owner: 'alice', repo: 'widgets', number: 42, title: 'Add feature' })
    render(Landing)
    expect(screen.getByText(/alice\/widgets#42/)).toBeInTheDocument()
    expect(screen.getByText('Add feature')).toBeInTheDocument()
  })

  it('clicking a history entry navigates to the provider-qualified review route', async () => {
    addToHistory({ owner: 'alice', repo: 'widgets', number: 42, title: 'Add feature' })
    render(Landing)
    // Click the button for the PR
    const btn = screen.getByRole('button', { name: /alice\/widgets#42/i })
    await userEvent.click(btn)
    expect(navigate).toHaveBeenCalledWith('/review/github/alice/widgets/42')
  })

  it('Clear button removes history entries from the UI', async () => {
    addToHistory({ owner: 'alice', repo: 'widgets', number: 42, title: 'Add feature' })
    render(Landing)
    expect(screen.getByText(/alice\/widgets#42/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /clear history/i }))
    expect(screen.queryByText(/recent reviews/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/alice\/widgets#42/)).not.toBeInTheDocument()
  })

  it('renders multiple history entries', () => {
    addToHistory({ owner: 'a', repo: 'r', number: 1, title: 'First PR' })
    addToHistory({ owner: 'b', repo: 's', number: 2, title: 'Second PR' })
    render(Landing)
    expect(screen.getByText(/a\/r#1/)).toBeInTheDocument()
    expect(screen.getByText(/b\/s#2/)).toBeInTheDocument()
  })

  it('gitlab history entry navigates to /review/gitlab route', async () => {
    addToHistory({ owner: 'mygroup', repo: 'myproject', number: 7, title: 'MR title', provider: 'gitlab' })
    render(Landing)
    const btn = screen.getByRole('button', { name: /mygroup\/myproject#7/i })
    await userEvent.click(btn)
    expect(navigate).toHaveBeenCalledWith('/review/gitlab/mygroup/myproject/7')
  })
})

describe('Landing collapsible sections', () => {
  const capture = vi.fn()

  beforeEach(() => {
    localStorage.clear()
    clearHistory()
    vi.mocked(navigate).mockClear()
    vi.spyOn(queueModule, 'fetchAllQueues').mockResolvedValue([])
    queueModule._resetQueueCacheForTest()
    capture.mockClear()
    _setCaptureForTest(capture)
  })

  it('queue section header is a toggle button, expanded by default', async () => {
    render(Landing)
    const toggle = screen.getByRole('button', { name: /your review queue/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await screen.findByText(/no prs in your queue/i)
  })

  it('clicking the queue header collapses the queue body', async () => {
    render(Landing)
    await screen.findByText(/no prs in your queue/i)
    await userEvent.click(screen.getByRole('button', { name: /your review queue/i }))
    expect(screen.getByRole('button', { name: /your review queue/i })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/no prs in your queue/i)).not.toBeInTheDocument()
  })

  it('clicking a collapsed queue header expands it again', async () => {
    render(Landing)
    await screen.findByText(/no prs in your queue/i)
    const toggle = screen.getByRole('button', { name: /your review queue/i })
    await userEvent.click(toggle)
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/no prs in your queue/i)).toBeInTheDocument()
  })

  it('queue collapsed state persists to localStorage and is restored on mount', async () => {
    const first = render(Landing)
    await screen.findByText(/no prs in your queue/i)
    await userEvent.click(screen.getByRole('button', { name: /your review queue/i }))
    first.unmount()

    render(Landing)
    const toggle = screen.getByRole('button', { name: /your review queue/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/no prs in your queue/i)).not.toBeInTheDocument()
  })

  it('recent reviews header is a toggle button, expanded by default', () => {
    addToHistory({ owner: 'alice', repo: 'widgets', number: 42, title: 'Add feature' })
    render(Landing)
    const toggle = screen.getByRole('button', { name: /recent reviews/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/alice\/widgets#42/)).toBeInTheDocument()
  })

  it('clicking the recent header collapses the history list', async () => {
    addToHistory({ owner: 'alice', repo: 'widgets', number: 42, title: 'Add feature' })
    render(Landing)
    await userEvent.click(screen.getByRole('button', { name: /recent reviews/i }))
    expect(screen.getByRole('button', { name: /recent reviews/i })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/alice\/widgets#42/)).not.toBeInTheDocument()
  })

  it('recent collapsed state is restored on mount', async () => {
    addToHistory({ owner: 'alice', repo: 'widgets', number: 42, title: 'Add feature' })
    setSectionCollapsed('recent', true)
    render(Landing)
    expect(screen.getByRole('button', { name: /recent reviews/i })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/alice\/widgets#42/)).not.toBeInTheDocument()
  })

  it('sections collapse independently', async () => {
    addToHistory({ owner: 'alice', repo: 'widgets', number: 42, title: 'Add feature' })
    render(Landing)
    await screen.findByText(/no prs in your queue/i)
    await userEvent.click(screen.getByRole('button', { name: /your review queue/i }))
    // queue collapsed, recent still expanded
    expect(screen.queryByText(/no prs in your queue/i)).not.toBeInTheDocument()
    expect(screen.getByText(/alice\/widgets#42/)).toBeInTheDocument()
  })

  it('toggle is keyboard accessible (Enter activates)', async () => {
    render(Landing)
    await screen.findByText(/no prs in your queue/i)
    const toggle = screen.getByRole('button', { name: /your review queue/i })
    toggle.focus()
    await userEvent.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('expanding a section emits section_expanded with id + landing surface only', async () => {
    render(Landing)
    await screen.findByText(/no prs in your queue/i)
    const toggle = screen.getByRole('button', { name: /your review queue/i })
    await userEvent.click(toggle) // collapse — no event
    expect(capture).not.toHaveBeenCalled()
    await userEvent.click(toggle) // expand — event
    expect(capture).toHaveBeenCalledWith('section_expanded', { section: 'queue', surface: 'landing' })
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('expanding recent emits section_expanded with section:recent', async () => {
    addToHistory({ owner: 'alice', repo: 'widgets', number: 42, title: 'Add feature' })
    render(Landing)
    const toggle = screen.getByRole('button', { name: /recent reviews/i })
    await userEvent.click(toggle)
    await userEvent.click(toggle)
    expect(capture).toHaveBeenCalledWith('section_expanded', { section: 'recent', surface: 'landing' })
  })

  it('Refresh button does not toggle the queue collapse state', async () => {
    render(Landing)
    await screen.findByText(/no prs in your queue/i)
    await userEvent.click(screen.getByRole('button', { name: /refresh queue/i }))
    expect(screen.getByRole('button', { name: /your review queue/i })).toHaveAttribute('aria-expanded', 'true')
    await screen.findByText(/no prs in your queue/i)
  })
})
