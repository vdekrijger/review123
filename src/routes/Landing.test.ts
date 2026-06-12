import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import Landing from './Landing.svelte'
import { navigate } from '../lib/router/router.svelte'
import * as queueModule from '../lib/provider/queue'
import type { QueueItem } from '../lib/provider/types'
import { addToHistory, clearHistory } from '../lib/history/history'
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
