/**
 * src/routes/Landing.signedOut.test.ts — "Your review queue" visibility gate.
 *
 * Separate file from Landing.test.ts because the registry mock differs: here
 * each provider's authState() reads the REAL settings store, so tests can
 * drive the signed-out → signed-in transition through actual settings saves
 * (which is exactly what the Settings page does) and assert the section
 * appears reactively without a remount.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import Landing from './Landing.svelte'
import { navigate } from '../lib/router/router.svelte'
import * as queueModule from '../lib/provider/queue'
import { addToHistory } from '../lib/history/history'
import { saveGithubAuth, setGitlabToken } from '../lib/settings/settings'
import { _resetSettingsStateForTest } from '../lib/settings/settingsState.svelte'

vi.mock('../lib/router/router.svelte', () => ({
  navigate: vi.fn(),
}))

// Registry mock whose authState() reflects the real settings store — flipping
// auth via settings saves must re-render the landing page (reactive gate).
vi.mock('../lib/provider/registry', async () => {
  const { getSettings } = await import('../lib/settings/settings')
  const CAPS = {
    resolvedThreads: false,
    checks: false,
    suggestions: false,
    atomicReview: false,
    compare: false,
    commentReplies: false,
    selfReviewBlocked: false,
  }
  return {
    PROVIDERS: new Map([
      ['github', {
        id: 'github',
        displayName: 'GitHub',
        authState: () => ({ configured: getSettings().githubAuth !== null, hint: '' }),
        getMyQueue: vi.fn(async () => []),
        capabilities: CAPS,
      }],
      ['gitlab', {
        id: 'gitlab',
        displayName: 'GitLab',
        authState: () => ({ configured: getSettings().gitlabToken !== null, hint: '' }),
        getMyQueue: vi.fn(async () => []),
        capabilities: CAPS,
      }],
    ]),
    parseAnyUrl: vi.fn().mockReturnValue(null),
  }
})

describe('Landing queue section — hidden when no provider is authenticated', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetSettingsStateForTest()
    queueModule._resetQueueCacheForTest()
  })

  it('renders no queue section at all (header included) when signed out everywhere', () => {
    const { container } = render(Landing)

    expect(screen.queryByText(/your review queue/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /refresh queue/i })).not.toBeInTheDocument()
    expect(container.querySelector('.queue-section')).toBeNull()
    // The old signed-out hint is gone too
    expect(screen.queryByText(/sign in to see your queue/i)).not.toBeInTheDocument()
  })

  it('recent reviews still renders for signed-out users', () => {
    addToHistory({ owner: 'alice', repo: 'widgets', number: 42, title: 'Add feature' })
    render(Landing)

    expect(screen.queryByText(/your review queue/i)).not.toBeInTheDocument()
    expect(screen.getByText(/recent reviews/i)).toBeInTheDocument()
    expect(screen.getByText(/alice\/widgets#42/)).toBeInTheDocument()
  })

  it('queue section appears reactively when GitHub auth is saved (no remount)', async () => {
    render(Landing)
    expect(screen.queryByText(/your review queue/i)).not.toBeInTheDocument()

    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })

    await screen.findByText(/your review queue/i)
    await screen.findByText(/no prs in your queue/i)
  })

  it('queue section appears reactively when only GitLab auth is configured', async () => {
    render(Landing)
    expect(screen.queryByText(/your review queue/i)).not.toBeInTheDocument()

    setGitlabToken('glpat_test')

    await screen.findByText(/your review queue/i)
  })

  it('section renders from the start when auth already exists at mount', async () => {
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })

    render(Landing)
    await screen.findByText(/your review queue/i)
    await screen.findByText(/no prs in your queue/i)
  })
})

describe('Landing — "Try a live demo" CTA', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetSettingsStateForTest()
    queueModule._resetQueueCacheForTest()
    vi.mocked(navigate).mockClear()
  })

  it('shows the demo CTA as an emphasized button when nothing is configured', () => {
    render(Landing)
    // Cold-start (no auth, no LLM key) → primary button, with the sub-line.
    expect(
      screen.getByRole('button', { name: /try a live demo — no setup needed/i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/no api key or sign‑in required/i)).toBeInTheDocument()
  })

  it('navigates to /demo when the CTA is clicked', async () => {
    render(Landing)
    await fireEvent.click(
      screen.getByRole('button', { name: /try a live demo — no setup needed/i }),
    )
    expect(vi.mocked(navigate)).toHaveBeenCalledWith('/demo')
  })

  it('demotes the demo CTA to a quiet link once auth is configured', async () => {
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })
    render(Landing)
    // No longer the primary button…
    expect(
      screen.queryByRole('button', { name: /try a live demo — no setup needed/i }),
    ).not.toBeInTheDocument()
    // …but still available as a link to /demo.
    const link = screen.getByRole('link', { name: /try a live demo — no setup needed/i })
    await fireEvent.click(link)
    expect(vi.mocked(navigate)).toHaveBeenCalledWith('/demo')
  })
})
