import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import App from './App.svelte'
import { _resetStartedForTest } from './lib/router/router.svelte'
import { _resetAuthStateForTest } from './lib/auth/authState.svelte'
import { jsonResponse } from './test-helpers'
import { saveGithubAuth } from './lib/settings/settings'

// Stub analytics so posthog.capture doesn't fire during tests
vi.mock('./lib/analytics/analytics', () => ({
  initAnalytics: vi.fn(),
  track: vi.fn(),
  _setCaptureForTest: vi.fn(),
}))

function makePrResponse(title: string, state = 'open', merged = false) {
  return {
    title,
    state,
    merged,
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
      return Promise.resolve(jsonResponse([]))
    }
    if (url.includes('/pulls/1')) {
      return Promise.resolve(jsonResponse(makePrResponse('PR-ONE')))
    }
    if (url.includes('/pulls/2')) {
      return Promise.resolve(jsonResponse(makePrResponse('PR-TWO')))
    }
    return Promise.resolve(new Response('{}', { status: 404 }))
  })
}

describe('App topbar auth states', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetAuthStateForTest()
    _resetStartedForTest()
    history.replaceState(null, '', '/')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('signed-out with clientId: shows "Sign in with GitHub" button', () => {
    vi.stubEnv('VITE_GITHUB_CLIENT_ID', 'test_client_id')
    render(App)
    expect(screen.getByRole('button', { name: /sign in with github/i })).toBeTruthy()
  })

  it('no clientId configured: no sign-in button shown (PAT-only mode)', () => {
    vi.stubEnv('VITE_GITHUB_CLIENT_ID', '')
    render(App)
    expect(screen.queryByRole('button', { name: /sign in with github/i })).toBeNull()
  })

  it('signed in via oauth: shows "GitHub ✓" badge and sign-out button', () => {
    saveGithubAuth({ token: 'gho_TOKEN', method: 'oauth', scopes: ['public_repo'] })
    vi.stubEnv('VITE_GITHUB_CLIENT_ID', 'test_client_id')
    render(App)
    expect(screen.getByText(/GitHub ✓/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy()
  })

  it('signed in via PAT: shows "PAT ✓" badge and sign-out button', () => {
    saveGithubAuth({ token: 'ghp_PAT', method: 'pat', scopes: [] })
    render(App)
    expect(screen.getByText(/PAT ✓/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy()
  })

  it('topbar updates to "GitHub ✓" badge after saveGithubAuth called post-render (reactivity bug)', async () => {
    vi.stubEnv('VITE_GITHUB_CLIENT_ID', 'test_client_id')
    // Render while signed out
    render(App)
    expect(screen.getByRole('button', { name: /sign in with github/i })).toBeTruthy()

    // Simulate what AuthCallback does: save auth to storage (no re-render)
    saveGithubAuth({ token: 'gho_x', method: 'oauth', scopes: ['public_repo'] })

    // The topbar must update reactively — without a full page reload
    expect(await screen.findByText(/GitHub ✓/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /sign in with github/i })).toBeNull()
  })

  it('topbar reverts to sign-in button after clicking Sign out', async () => {
    vi.stubEnv('VITE_GITHUB_CLIENT_ID', 'test_client_id')
    saveGithubAuth({ token: 'gho_x', method: 'oauth', scopes: ['public_repo'] })
    const user = userEvent.setup()
    render(App)

    expect(screen.getByText(/GitHub ✓/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /sign out/i }))

    expect(await screen.findByRole('button', { name: /sign in with github/i })).toBeTruthy()
    expect(screen.queryByText(/GitHub ✓/)).toBeNull()
  })
})

describe('EC-05k: closed/merged PR renders correctly', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    _resetStartedForTest()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('EC-05k: closed/merged PR title renders without choking on closed state', async () => {
    history.replaceState(null, '', '/review/a/b/1')
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/files')) {
        return Promise.resolve(jsonResponse([]))
      }
      if (url.includes('/pulls/1')) {
        return Promise.resolve(jsonResponse(makePrResponse('CLOSED-PR', 'closed', true)))
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    }))

    render(App)

    expect(await screen.findByText(/CLOSED-PR/)).toBeTruthy()
  })
})

describe('App — Review route is lazy-loaded (bundle discipline)', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    _resetStartedForTest()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('shows the loading fallback synchronously, then the lazy Review chunk renders', async () => {
    history.replaceState(null, '', '/review/a/b/1')
    vi.stubGlobal('fetch', makeFetchStub())

    render(App)

    // Synchronously after render the dynamic import() has not resolved yet,
    // so the route-loading fallback is shown instead of the Review component.
    // This proves Review (and the vendor-diff-view chunk with the lowlight
    // highlight engine it drags in) is NOT in the entry's static import graph.
    expect(document.querySelector('.route-loading')).toBeInTheDocument()
    expect(document.querySelector('.review')).not.toBeInTheDocument()

    // Once the lazy chunk wires up, the Review route renders fully.
    expect(await screen.findByText(/PR-ONE/)).toBeTruthy()
    expect(document.querySelector('.route-loading')).not.toBeInTheDocument()
  })
})

describe('App review→review navigation', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    _resetStartedForTest()
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

  it('does not refetch or show the loading skeleton when navigating between steps of the same PR', async () => {
    // Step-only navigation (understand → inspect → verdict, incl. browser
    // back/forward) must NOT re-trigger the PR load: the component stays
    // mounted ({#key} is on PR identity only) and the load must be created
    // exactly once per mount. Regression: `load` was a $derived.by reading
    // route-derived props, so every router.route reassignment recreated it.
    history.replaceState(null, '', '/review/github/a/b/1/understand')
    const fetchStub = makeFetchStub()
    vi.stubGlobal('fetch', fetchStub)
    // The PR load = exactly one meta fetch (…/pulls/1) + one files fetch (…/pulls/1/files).
    // Other endpoints (commits, comments, check-runs) are lazy by design and not the PR load.
    const loadCalls = () =>
      fetchStub.mock.calls.filter(
        ([url]) => /\/pulls\/1$/.test(String(url)) || String(url).includes('/pulls/1/files'),
      ).length

    const user = userEvent.setup()
    render(App)

    // Wait for PR-ONE to load (skeleton gone, content rendered)
    await screen.findByText(/PR-ONE/)
    expect(loadCalls()).toBe(2) // 1× meta + 1× files from the initial load

    // Step 1 → 2 via the stepper button (uses navigate() → pushState)
    await user.click(screen.getByRole('button', { name: /2.*Inspect/i }))
    expect(screen.getByRole('button', { name: /2.*Inspect/i })).toHaveAttribute('aria-current', 'step')

    // Step 2 → 3
    await user.click(screen.getByRole('button', { name: /3.*Verdict/i }))
    expect(screen.getByRole('button', { name: /3.*Verdict/i })).toHaveAttribute('aria-current', 'step')

    // Browser back (verdict → inspect) — same path as back/forward buttons
    history.pushState(null, '', '/review/github/a/b/1/inspect')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await screen.findByText(/PR-ONE/)

    // Content must still be there instantly — never the loading skeleton
    expect(screen.queryByLabelText('Loading pull request')).toBeNull()
    expect(screen.getByText(/PR-ONE/)).toBeTruthy()

    // And crucially: zero additional PR meta/files fetches happened
    expect(loadCalls()).toBe(2) // still only the initial load
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
