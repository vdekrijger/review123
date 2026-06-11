import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import AuthCallback from './AuthCallback.svelte'
import { _resetStartedForTest } from '../lib/router/router.svelte'

// Stub auth module
vi.mock('../lib/auth/auth', () => ({
  completeSignIn: vi.fn(),
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
import { track } from '../lib/analytics/analytics'
import { navigate } from '../lib/router/router.svelte'

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  vi.clearAllMocks()
  _resetStartedForTest()
  // Default location.search to empty
  Object.defineProperty(globalThis, 'location', {
    value: { pathname: '/auth/callback', search: '', origin: 'http://localhost' },
    writable: true,
    configurable: true,
  })
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

  it('state-mismatch error: renders specific message', async () => {
    vi.mocked(completeSignIn).mockResolvedValue({ ok: false, error: 'state-mismatch' })

    render(AuthCallback)

    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Sign-in session expired or invalid/)
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
