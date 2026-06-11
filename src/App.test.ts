import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import App from './App.svelte'

// Stub analytics so posthog.capture doesn't fire during tests
vi.mock('./lib/analytics/analytics', () => ({
  initAnalytics: vi.fn(),
  track: vi.fn(),
  _setCaptureForTest: vi.fn(),
}))

function makePrResponse(title: string) {
  return {
    title,
    state: 'open',
    merged: false,
    body: null,
    base: { sha: 'b1', repo: { private: false } },
    head: { sha: 'h1' },
    changed_files: 0,
  }
}

// Returns a fresh Response each call so body can be read multiple times
function makeFetchStub() {
  return vi.fn((url: string) => {
    // Both PRs return empty file lists to avoid canvas-dependent FileDiff rendering in jsdom
    if (url.includes('/files')) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
    }
    if (url.includes('/pulls/1')) {
      return Promise.resolve(new Response(JSON.stringify(makePrResponse('PR-ONE')), { status: 200 }))
    }
    if (url.includes('/pulls/2')) {
      return Promise.resolve(new Response(JSON.stringify(makePrResponse('PR-TWO')), { status: 200 }))
    }
    return Promise.resolve(new Response('{}', { status: 404 }))
  })
}

describe('App review→review navigation', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('shows the new PR title after navigating from one PR to another', async () => {
    history.replaceState(null, '', '/review/a/b/1')
    vi.stubGlobal('fetch', makeFetchStub())

    render(App)

    // First PR title appears
    expect(await screen.findByText(/PR-ONE/)).toBeTruthy()

    // Navigate to PR-2
    history.pushState(null, '', '/review/a/b/2')
    window.dispatchEvent(new PopStateEvent('popstate'))

    // Second PR title should appear
    expect(await screen.findByText(/PR-TWO/)).toBeTruthy()
  })

  it('resets step to 1 when navigating to a different PR (requires {#key} remount)', async () => {
    // This test specifically validates the {#key} block: without it, the `step`
    // $state defined inside Review.svelte would persist across navigation.
    history.replaceState(null, '', '/review/a/b/1')
    vi.stubGlobal('fetch', makeFetchStub())

    const user = userEvent.setup()
    render(App)

    // Wait for PR-ONE to load
    await screen.findByText(/PR-ONE/)

    // Navigate to step 2 ("Inspect") on PR-1
    await user.click(screen.getByRole('button', { name: /2.*Inspect/i }))

    // The "2 · Inspect" button should now be the active step
    const inspectBtn = screen.getByRole('button', { name: /2.*Inspect/i })
    expect(inspectBtn).toHaveAttribute('aria-current', 'step')

    // Navigate to PR-2 via history API
    history.pushState(null, '', '/review/a/b/2')
    window.dispatchEvent(new PopStateEvent('popstate'))

    // PR-TWO should appear
    await screen.findByText(/PR-TWO/)

    // Step must have been reset to 1 (i.e., the Review component remounted via {#key})
    const understandBtn = screen.getByRole('button', { name: /1.*Understand/i })
    expect(understandBtn).toHaveAttribute('aria-current', 'step')
  })
})
