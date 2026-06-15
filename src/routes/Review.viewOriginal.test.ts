/**
 * Integration tests for the "View on <Provider>" header link in Review.svelte.
 *
 * The link lives in the persistent PR header (above the Stepper) so it is
 * visible on all three steps. It is a provider-aware external link that opens
 * the original PR/MR in the provider's native UI.
 *
 * Covers:
 *  - correct href (provider.prWebUrl(ref))
 *  - target="_blank" + rel="noopener noreferrer"
 *  - provider-aware label (default github here)
 *  - fires the allowlisted 'original_pr_opened' analytics event on click
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import Review from './Review.svelte'
import { jsonResponse } from '../test-helpers'
import { track } from '../lib/analytics/analytics'
import { router, _resetStartedForTest } from '../lib/router/router.svelte'
import { _resetSettingsStateForTest } from '../lib/settings/settingsState.svelte'

vi.mock('../lib/analytics/analytics', () => ({
  track: vi.fn(),
  initAnalytics: vi.fn(),
  _setCaptureForTest: vi.fn(),
}))

vi.mock('../components/DraftThread.svelte', () => ({
  default: { name: 'DraftThread' },
}))

import 'fake-indexeddb/auto'

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
    writable: true,
  })
})

function makePrMeta(headSha = 'abc123') {
  return {
    title: 'feat(slack): add notifications',
    state: 'open',
    merged: false,
    body: null,
    base: { sha: 'base1', repo: { private: false } },
    head: { sha: headSha },
    changed_files: 0,
  }
}

function makeFetchStub(files: unknown[] = []) {
  return vi.fn((url: string) => {
    if (url.includes('/files')) return Promise.resolve(jsonResponse(files))
    return Promise.resolve(jsonResponse(makePrMeta()))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  _resetStartedForTest()
  router.route = { name: 'landing' }
  _resetSettingsStateForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Review header "View on <Provider>" link', () => {
  it('renders a provider-aware external link with correct href, target, and rel', async () => {
    vi.stubGlobal('fetch', makeFetchStub())

    render(Review, { props: { owner: 'PostHog', repo: 'posthog', number: 63251 } })

    await vi.waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument()
    })

    const link = screen.getByRole('link', { name: /view on github/i })
    expect(link).toHaveAttribute('href', 'https://github.com/PostHog/posthog/pull/63251')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    // Visible provider-aware label
    expect(link.textContent).toMatch(/View on GitHub/)
  })

  it('fires the allowlisted original_pr_opened event (provider id only) on click', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', makeFetchStub())

    render(Review, { props: { owner: 'PostHog', repo: 'posthog', number: 63251 } })

    await vi.waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument()
    })

    const trackMock = vi.mocked(track)
    trackMock.mockClear()

    const link = screen.getByRole('link', { name: /view on github/i })
    await user.click(link)

    expect(trackMock).toHaveBeenCalledWith('original_pr_opened', { provider: 'github' })
  })
})
