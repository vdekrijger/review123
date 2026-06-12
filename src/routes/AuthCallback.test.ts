import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import AuthCallback from './AuthCallback.svelte'
import { _resetStartedForTest } from '../lib/router/router.svelte'
import {
  GITHUB_OAUTH_SESSION_KEY,
  GITLAB_OAUTH_SESSION_KEY,
} from '../lib/auth/oauthKeys'

// Stub auth modules (the completers). The dispatcher (oauthFlow) is REAL and
// reads sessionStorage — the tests below exercise the actual dispatch logic.
vi.mock('../lib/auth/auth', () => ({
  completeSignIn: vi.fn(),
}))

vi.mock('../lib/auth/gitlabAuth', () => ({
  completeGitlabSignIn: vi.fn(),
}))

// Stub analytics
vi.mock('../lib/analytics/analytics', () => ({
  track: vi.fn(),
  initAnalytics: vi.fn(),
  _setCaptureForTest: vi.fn(),
}))

// Stub router navigate
vi.mock('../lib/router/router.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/router/router.svelte')>()
  return {
    ...actual,
    navigate: vi.fn(),
  }
})

import { completeSignIn } from '../lib/auth/auth'
import { completeGitlabSignIn } from '../lib/auth/gitlabAuth'
import { track } from '../lib/analytics/analytics'
import { navigate } from '../lib/router/router.svelte'

function setCallbackUrl(search: string) {
  Object.defineProperty(globalThis, 'location', {
    value: { pathname: '/auth/callback', search, origin: 'http://localhost' },
    writable: true,
    configurable: true,
  })
}

function seedGithubSession(state = 'gh-state') {
  sessionStorage.setItem(
    GITHUB_OAUTH_SESSION_KEY,
    JSON.stringify({ state, verifier: 'gh-verifier', scope: 'public_repo' }),
  )
}

function seedGitlabSession(state = 'gl-state') {
  sessionStorage.setItem(
    GITLAB_OAUTH_SESSION_KEY,
    JSON.stringify({ state, verifier: 'gl-verifier', provider: 'gitlab' }),
  )
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  vi.clearAllMocks()
  _resetStartedForTest()
  // Default: a pending GitHub session whose state matches the callback URL
  seedGithubSession('gh-state')
  setCallbackUrl('?code=c123&state=gh-state')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AuthCallback', () => {
  it('success path: tracks signed_in and navigates to / by default', async () => {
    vi.mocked(completeSignIn).mockResolvedValue({ ok: true })

    render(AuthCallback)

    // Wait for async onMount
    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/')
    })
    expect(track).toHaveBeenCalledWith('signed_in', { method: 'oauth' })
  })

  it('success path: navigates to returnTo path when sessionStorage is set', async () => {
    sessionStorage.setItem('review123:returnTo', '/review/a/b/42')
    vi.mocked(completeSignIn).mockResolvedValue({ ok: true })

    render(AuthCallback)

    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/review/a/b/42')
    })
    expect(sessionStorage.getItem('review123:returnTo')).toBeNull()
  })

  it('state-mismatch error: renders a message naming GitHub (the attempted provider)', async () => {
    vi.mocked(completeSignIn).mockResolvedValue({ ok: false, error: 'state-mismatch' })

    render(AuthCallback)

    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /GitHub sign-in session expired or invalid/,
      )
    })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('denied error: renders cancellation message', async () => {
    vi.mocked(completeSignIn).mockResolvedValue({ ok: false, error: 'denied' })

    render(AuthCallback)

    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/cancelled/)
    })
  })

  it('exchange-failed error: renders token exchange message', async () => {
    vi.mocked(completeSignIn).mockResolvedValue({ ok: false, error: 'exchange-failed' })

    render(AuthCallback)

    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/token exchange/)
    })
  })

  it('error path: renders a link home', async () => {
    vi.mocked(completeSignIn).mockResolvedValue({ ok: false, error: 'no-verifier' })

    render(AuthCallback)

    await vi.waitFor(() => {
      expect(screen.getByRole('link', { name: /go home/i })).toBeTruthy()
    })
  })
})

// ---------------------------------------------------------------------------
// Callback dispatch — regression for the settings-initiated GitHub sign-in
// failing with a GITLAB error: dispatch must follow the flow that was actually
// started (state-nonce match), never "a gitlab key exists".
// ---------------------------------------------------------------------------

describe('AuthCallback dispatch', () => {
  it('github-pending: calls the GitHub completer, not the GitLab one', async () => {
    vi.mocked(completeSignIn).mockResolvedValue({ ok: true })

    render(AuthCallback)

    await vi.waitFor(() => {
      expect(completeSignIn).toHaveBeenCalledOnce()
    })
    expect(completeGitlabSignIn).not.toHaveBeenCalled()
  })

  it('gitlab-pending: calls the GitLab completer, not the GitHub one', async () => {
    sessionStorage.clear()
    seedGitlabSession('gl-state')
    setCallbackUrl('?code=c123&state=gl-state')
    vi.mocked(completeGitlabSignIn).mockResolvedValue({ ok: true })

    render(AuthCallback)

    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/')
    })
    expect(completeGitlabSignIn).toHaveBeenCalledOnce()
    expect(completeSignIn).not.toHaveBeenCalled()
  })

  it('STALE gitlab session + fresh github flow: dispatches to GitHub (the bug)', async () => {
    // A GitLab attempt was abandoned earlier (e.g. redirect-URI rejection),
    // leaving its pending session behind; then the user signed in with GitHub.
    seedGitlabSession('stale-gitlab-state')
    seedGithubSession('fresh-github-state')
    setCallbackUrl('?code=c123&state=fresh-github-state')
    vi.mocked(completeSignIn).mockResolvedValue({ ok: true })

    render(AuthCallback)

    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/')
    })
    expect(completeSignIn).toHaveBeenCalledOnce()
    expect(completeGitlabSignIn).not.toHaveBeenCalled()
  })

  it('STALE gitlab session + fresh github flow that fails: error copy names GitHub, not GitLab', async () => {
    seedGitlabSession('stale-gitlab-state')
    seedGithubSession('fresh-github-state')
    setCallbackUrl('?code=c123&state=fresh-github-state')
    vi.mocked(completeSignIn).mockResolvedValue({ ok: false, error: 'exchange-failed' })

    render(AuthCallback)

    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/GitHub sign-in failed/)
    })
    expect(screen.getByRole('alert').textContent).not.toMatch(/GitLab/)
  })

  it('STALE github session + fresh gitlab flow: dispatches to GitLab', async () => {
    sessionStorage.clear()
    seedGithubSession('stale-github-state')
    seedGitlabSession('fresh-gitlab-state')
    setCallbackUrl('?code=c123&state=fresh-gitlab-state')
    vi.mocked(completeGitlabSignIn).mockResolvedValue({ ok: true })

    render(AuthCallback)

    await vi.waitFor(() => {
      expect(completeGitlabSignIn).toHaveBeenCalledOnce()
    })
    expect(completeSignIn).not.toHaveBeenCalled()
  })

  it('gitlab flow failure: error copy names GitLab', async () => {
    sessionStorage.clear()
    seedGitlabSession('gl-state')
    setCallbackUrl('?code=c123&state=gl-state')
    vi.mocked(completeGitlabSignIn).mockResolvedValue({ ok: false, error: 'state-mismatch' })

    render(AuthCallback)

    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /GitLab sign-in session expired or invalid/,
      )
    })
  })

  it('nothing pending: provider-agnostic error, neither completer called, leftovers cleared', async () => {
    sessionStorage.clear()
    setCallbackUrl('?code=c123&state=unknown')

    render(AuthCallback)

    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /Sign-in session expired or invalid/,
      )
    })
    // Never blame a provider we cannot identify
    expect(screen.getByRole('alert').textContent).not.toMatch(/GitHub|GitLab/)
    expect(completeSignIn).not.toHaveBeenCalled()
    expect(completeGitlabSignIn).not.toHaveBeenCalled()
  })

  it('both pending but state matches neither: ambiguous → provider-agnostic error and both sessions cleared', async () => {
    seedGithubSession('a')
    seedGitlabSession('b')
    setCallbackUrl('?code=c123&state=zzz')

    render(AuthCallback)

    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /Sign-in session expired or invalid/,
      )
    })
    // Stale pending state must not survive to poison the NEXT sign-in
    expect(sessionStorage.getItem(GITHUB_OAUTH_SESSION_KEY)).toBeNull()
    expect(sessionStorage.getItem(GITLAB_OAUTH_SESSION_KEY)).toBeNull()
  })
})
