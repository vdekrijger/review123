/**
 * Tests for src/lib/auth/gitlabAuth.ts
 *
 * Coverage:
 *   - beginGitlabSignIn: URL shape, PKCE params, sessionStorage, state randomness
 *   - completeGitlabSignIn: state validation, denial, missing-code, no-verifier,
 *     exchange success/failure, refresh token stored, sessionStorage cleanup
 *   - resolveGitlabToken: OAuth-first, expiry fallback to PAT, PAT fallback
 *   - signOutGitlab
 *   - state payload encoding (provider='gitlab' in sessionStorage)
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  beginGitlabSignIn,
  completeGitlabSignIn,
  resolveGitlabToken,
  signOutGitlab,
} from './gitlabAuth'
import { getSettings, saveGitlabOAuth, setGitlabToken } from '../settings/settings'

// Test env has VITE_GITLAB_CLIENT_ID set in vitest.config.ts (or we stub import.meta.env)
// Set both VITE_GITHUB_CLIENT_ID (existing) and VITE_GITLAB_CLIENT_ID
vi.stubEnv('VITE_GITLAB_CLIENT_ID', 'test_gitlab_client_id')

Object.defineProperty(globalThis, 'location', {
  value: { origin: 'https://app.example.com', hostname: 'app.example.com' },
  writable: true,
  configurable: true,
})

const SESSION_KEY = 'review123:gitlab-oauth'

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  vi.unstubAllGlobals()
  // Re-stub after unstubAllGlobals so the client id env stays set
  vi.stubEnv('VITE_GITLAB_CLIENT_ID', 'test_gitlab_client_id')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// beginGitlabSignIn
// ---------------------------------------------------------------------------

describe('beginGitlabSignIn', () => {
  it('returns a GitLab authorize URL with required params', async () => {
    const url = await beginGitlabSignIn('gitlab.com')
    expect(url).toContain('https://gitlab.com/oauth/authorize')
    expect(url).toContain('client_id=test_gitlab_client_id')
    expect(url).toContain('response_type=code')
    expect(url).toContain('scope=api')
    expect(url).toContain('code_challenge_method=S256')
    expect(url).toContain('code_challenge=')
    expect(url).toContain('state=')
    expect(url).toContain(encodeURIComponent('https://app.example.com/auth/callback'))
  })

  it('uses gitlabHost from settings when host is not provided', async () => {
    // Default gitlabHost is 'gitlab.com'
    const url = await beginGitlabSignIn()
    expect(url).toContain('https://gitlab.com/oauth/authorize')
  })

  it('uses the provided host override', async () => {
    const url = await beginGitlabSignIn('gitlab.mycompany.com')
    expect(url).toContain('https://gitlab.mycompany.com/oauth/authorize')
  })

  it('stores provider=gitlab, state, and verifier in sessionStorage', async () => {
    await beginGitlabSignIn('gitlab.com')
    const raw = sessionStorage.getItem(SESSION_KEY)
    expect(raw).not.toBeNull()
    const stored = JSON.parse(raw!)
    expect(stored).toHaveProperty('provider', 'gitlab')
    expect(stored).toHaveProperty('state')
    expect(stored).toHaveProperty('verifier')
    expect(stored.state.length).toBeGreaterThan(0)
    expect(stored.verifier.length).toBeGreaterThanOrEqual(43)
  })

  it('generates a different state every call', async () => {
    await beginGitlabSignIn('gitlab.com')
    const s1 = JSON.parse(sessionStorage.getItem(SESSION_KEY)!).state
    await beginGitlabSignIn('gitlab.com')
    const s2 = JSON.parse(sessionStorage.getItem(SESSION_KEY)!).state
    expect(s1).not.toBe(s2)
  })

  it('throws when VITE_GITLAB_CLIENT_ID is not set', async () => {
    vi.stubEnv('VITE_GITLAB_CLIENT_ID', '')
    await expect(beginGitlabSignIn('gitlab.com')).rejects.toThrow('VITE_GITLAB_CLIENT_ID')
  })
})

// ---------------------------------------------------------------------------
// completeGitlabSignIn
// ---------------------------------------------------------------------------

describe('completeGitlabSignIn', () => {
  async function setupValidSession(host = 'gitlab.com') {
    await beginGitlabSignIn(host)
    return JSON.parse(sessionStorage.getItem(SESSION_KEY)!) as {
      state: string
      verifier: string
      provider: string
    }
  }

  it('returns state-mismatch when state does not match', async () => {
    await setupValidSession()
    const params = new URLSearchParams({ code: 'abc', state: 'WRONG_STATE' })
    const result = await completeGitlabSignIn(params)
    expect(result).toEqual({ ok: false, error: 'state-mismatch' })
  })

  it('returns state-mismatch when no session exists', async () => {
    const params = new URLSearchParams({ code: 'abc', state: 'anystate' })
    const result = await completeGitlabSignIn(params)
    expect(result.ok).toBe(false)
    expect(['state-mismatch', 'no-verifier']).toContain((result as { ok: false; error: string }).error)
  })

  it('returns denied when error=access_denied', async () => {
    const stored = await setupValidSession()
    const params = new URLSearchParams({ error: 'access_denied', state: stored.state })
    const result = await completeGitlabSignIn(params)
    expect(result).toEqual({ ok: false, error: 'denied' })
  })

  it('returns missing-code when code is absent', async () => {
    const stored = await setupValidSession()
    const params = new URLSearchParams({ state: stored.state })
    const result = await completeGitlabSignIn(params)
    expect(result).toEqual({ ok: false, error: 'missing-code' })
  })

  it('returns no-verifier when session has no verifier field', async () => {
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ state: 'mystate', provider: 'gitlab' }),
    )
    const params = new URLSearchParams({ code: 'abc', state: 'mystate' })
    const result = await completeGitlabSignIn(params)
    expect(result).toEqual({ ok: false, error: 'no-verifier' })
  })

  it('returns exchange-failed on network error during token exchange', async () => {
    const stored = await setupValidSession()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const params = new URLSearchParams({ code: 'abc', state: stored.state })
    const result = await completeGitlabSignIn(params)
    expect(result).toEqual({ ok: false, error: 'exchange-failed' })
  })

  it('returns exchange-failed on non-200 from GitLab token endpoint', async () => {
    const stored = await setupValidSession()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    }))
    const params = new URLSearchParams({ code: 'abc', state: stored.state })
    const result = await completeGitlabSignIn(params)
    expect(result).toEqual({ ok: false, error: 'exchange-failed' })
  })

  it('returns exchange-failed when body has error field', async () => {
    const stored = await setupValidSession()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: 'invalid_client' }),
    }))
    const params = new URLSearchParams({ code: 'abc', state: stored.state })
    const result = await completeGitlabSignIn(params)
    expect(result).toEqual({ ok: false, error: 'exchange-failed' })
  })

  it('returns exchange-failed when access_token is missing', async () => {
    const stored = await setupValidSession()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ refresh_token: 'rt_abc', expires_in: 7200 }),
    }))
    const params = new URLSearchParams({ code: 'abc', state: stored.state })
    const result = await completeGitlabSignIn(params)
    expect(result).toEqual({ ok: false, error: 'exchange-failed' })
  })

  it('returns exchange-failed when refresh_token is missing', async () => {
    const stored = await setupValidSession()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'at_abc', expires_in: 7200 }),
    }))
    const params = new URLSearchParams({ code: 'abc', state: stored.state })
    const result = await completeGitlabSignIn(params)
    expect(result).toEqual({ ok: false, error: 'exchange-failed' })
  })

  it('success: stores token bundle in settings with correct shape', async () => {
    const stored = await setupValidSession()
    const nowBefore = Date.now()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'glOAT-abc123',
        refresh_token: 'glORT-xyz',
        token_type: 'Bearer',
        expires_in: 7200,
      }),
    }))
    const params = new URLSearchParams({ code: 'abc', state: stored.state })
    const result = await completeGitlabSignIn(params)
    expect(result).toEqual({ ok: true })

    const settings = getSettings()
    expect(settings.gitlabOAuth).not.toBeNull()
    expect(settings.gitlabOAuth!.token).toBe('glOAT-abc123')
    expect(settings.gitlabOAuth!.refreshToken).toBe('glORT-xyz')
    // expiresAt should be approximately now + 7200 * 1000 ms
    expect(settings.gitlabOAuth!.expiresAt).toBeGreaterThanOrEqual(nowBefore + 7200_000)
  })

  it('success: sends correct PKCE fields in the token request (no client_secret)', async () => {
    const stored = await setupValidSession('gitlab.com')
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'glOAT-abc',
        refresh_token: 'glORT-abc',
        expires_in: 7200,
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const params = new URLSearchParams({ code: 'mycode', state: stored.state })
    await completeGitlabSignIn(params)

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://gitlab.com/oauth/token')
    const body = JSON.parse(init.body)
    expect(body.client_id).toBe('test_gitlab_client_id')
    expect(body.code).toBe('mycode')
    expect(body.grant_type).toBe('authorization_code')
    expect(body.code_verifier).toBe(stored.verifier)
    // No client_secret should be present (public client)
    expect(body).not.toHaveProperty('client_secret')
  })

  it('clears sessionStorage after success', async () => {
    const stored = await setupValidSession()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'glOAT',
        refresh_token: 'glORT',
        expires_in: 7200,
      }),
    }))
    const params = new URLSearchParams({ code: 'abc', state: stored.state })
    await completeGitlabSignIn(params)
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('clears sessionStorage even on exchange failure', async () => {
    const stored = await setupValidSession()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    }))
    const params = new URLSearchParams({ code: 'abc', state: stored.state })
    await completeGitlabSignIn(params)
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Callback dispatch (which provider's completer handles /auth/callback) is
// covered by oauthFlow.test.ts → resolvePendingProvider.
// ---------------------------------------------------------------------------
// resolveGitlabToken
// ---------------------------------------------------------------------------

describe('resolveGitlabToken', () => {
  it('returns OAuth token when present and not expired', () => {
    saveGitlabOAuth({
      token: 'glOAT-valid',
      refreshToken: 'glORT',
      expiresAt: Date.now() + 3_600_000, // 1h in the future
    })
    expect(resolveGitlabToken()).toBe('glOAT-valid')
  })

  it('falls back to PAT when OAuth token is expired', () => {
    saveGitlabOAuth({
      token: 'glOAT-expired',
      refreshToken: 'glORT',
      expiresAt: Date.now() - 1000, // expired
    })
    setGitlabToken('glpat-fallback')
    expect(resolveGitlabToken()).toBe('glpat-fallback')
  })

  it('returns PAT when no OAuth is configured', () => {
    setGitlabToken('glpat-only')
    expect(resolveGitlabToken()).toBe('glpat-only')
  })

  it('returns null when neither OAuth nor PAT is configured', () => {
    expect(resolveGitlabToken()).toBeNull()
  })

  it('returns OAuth token even when PAT is also set (OAuth takes priority)', () => {
    saveGitlabOAuth({
      token: 'glOAT-priority',
      refreshToken: 'glORT',
      expiresAt: Date.now() + 3_600_000,
    })
    setGitlabToken('glpat-also-set')
    // OAuth wins
    expect(resolveGitlabToken()).toBe('glOAT-priority')
  })

  it('returns null when OAuth is expired and no PAT is configured', () => {
    saveGitlabOAuth({
      token: 'glOAT-expired',
      refreshToken: 'glORT',
      expiresAt: Date.now() - 1000,
    })
    expect(resolveGitlabToken()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// signOutGitlab
// ---------------------------------------------------------------------------

describe('signOutGitlab', () => {
  it('clears gitlabOAuth from settings', () => {
    saveGitlabOAuth({
      token: 'glOAT',
      refreshToken: 'glORT',
      expiresAt: Date.now() + 3_600_000,
    })
    signOutGitlab()
    expect(getSettings().gitlabOAuth).toBeNull()
  })

  it('does not affect gitlabToken (PAT)', () => {
    setGitlabToken('glpat-abc')
    saveGitlabOAuth({
      token: 'glOAT',
      refreshToken: 'glORT',
      expiresAt: Date.now() + 3_600_000,
    })
    signOutGitlab()
    expect(getSettings().gitlabToken).toBe('glpat-abc')
  })
})

// ---------------------------------------------------------------------------
// State payload — provider dispatch safety
// ---------------------------------------------------------------------------

describe('state payload encoding', () => {
  it('sessionStorage entry has provider=gitlab (for AuthCallback dispatch)', async () => {
    await beginGitlabSignIn('gitlab.com')
    const raw = sessionStorage.getItem(SESSION_KEY)
    const parsed = JSON.parse(raw!) as { provider: string }
    expect(parsed.provider).toBe('gitlab')
  })

  it('GitHub sessionStorage key is different from GitLab (no cross-contamination)', async () => {
    // The GitHub flow uses 'review123:oauth'; GitLab uses 'review123:gitlab-oauth'
    sessionStorage.setItem('review123:oauth', JSON.stringify({ state: 'gh-state', provider: 'github' }))
    await beginGitlabSignIn('gitlab.com')
    // Both keys present independently
    expect(sessionStorage.getItem('review123:oauth')).not.toBeNull()
    expect(sessionStorage.getItem(SESSION_KEY)).not.toBeNull()
    // Each has the right provider
    const ghSession = JSON.parse(sessionStorage.getItem('review123:oauth')!)
    const glSession = JSON.parse(sessionStorage.getItem(SESSION_KEY)!)
    expect(ghSession.provider).toBe('github')
    expect(glSession.provider).toBe('gitlab')
  })
})
