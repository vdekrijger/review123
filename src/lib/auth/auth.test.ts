import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { beginSignIn, completeSignIn, needsScopeUpgrade, signOut } from './auth'

// Override location.origin for tests (jsdom default is 'http://localhost')
Object.defineProperty(globalThis, 'location', {
  value: { origin: 'https://app.example.com', hostname: 'app.example.com' },
  writable: true,
  configurable: true,
})

// Helper: reset sessionStorage and settings between tests
beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('beginSignIn', () => {
  it('returns a GitHub authorize URL', async () => {
    const url = await beginSignIn('public_repo')
    expect(url).toContain('https://github.com/login/oauth/authorize')
    expect(url).toContain('client_id=test_client_id')
    expect(url).toContain('redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback')
    expect(url).toContain('scope=public_repo')
    expect(url).toContain('code_challenge_method=S256')
    expect(url).toContain('code_challenge=')
    expect(url).toContain('state=')
  })

  it('stores state and verifier in sessionStorage', async () => {
    await beginSignIn('repo')
    const raw = sessionStorage.getItem('review123:oauth')
    expect(raw).not.toBeNull()
    const stored = JSON.parse(raw!)
    expect(stored).toHaveProperty('state')
    expect(stored).toHaveProperty('verifier')
    expect(stored).toHaveProperty('scope', 'repo')
    expect(stored.state.length).toBeGreaterThan(0)
    expect(stored.verifier.length).toBeGreaterThanOrEqual(43)
  })

  it('generates a different state every call', async () => {
    await beginSignIn('public_repo')
    const s1 = JSON.parse(sessionStorage.getItem('review123:oauth')!).state
    await beginSignIn('public_repo')
    const s2 = JSON.parse(sessionStorage.getItem('review123:oauth')!).state
    expect(s1).not.toBe(s2)
  })
})

describe('completeSignIn', () => {
  async function setupValidSession(scope = 'public_repo') {
    const url = await beginSignIn(scope as 'public_repo' | 'repo')
    const stored = JSON.parse(sessionStorage.getItem('review123:oauth')!)
    return stored
  }

  it('EC-02d: returns state-mismatch when state does not match', async () => {
    await setupValidSession()
    const params = new URLSearchParams({ code: 'abc', state: 'WRONG_STATE' })
    const result = await completeSignIn(params)
    expect(result).toEqual({ ok: false, error: 'state-mismatch' })
  })

  it('EC-02a: returns missing-code when code is absent', async () => {
    const stored = await setupValidSession()
    const params = new URLSearchParams({ state: stored.state })
    const result = await completeSignIn(params)
    expect(result).toEqual({ ok: false, error: 'missing-code' })
  })

  it('EC-02b: returns denied when error=access_denied', async () => {
    const stored = await setupValidSession()
    const params = new URLSearchParams({ error: 'access_denied', state: stored.state })
    const result = await completeSignIn(params)
    expect(result).toEqual({ ok: false, error: 'denied' })
  })

  it('EC-02c: returns no-verifier when sessionStorage has no entry', async () => {
    // Put a state in but no verifier (simulate incomplete session)
    sessionStorage.setItem('review123:oauth', JSON.stringify({ state: 'mystate', scope: 'public_repo' }))
    const params = new URLSearchParams({ code: 'abc', state: 'mystate' })
    const result = await completeSignIn(params)
    expect(result).toEqual({ ok: false, error: 'no-verifier' })
  })

  it('EC-02c: returns no-verifier when sessionStorage is empty (no prior beginSignIn)', async () => {
    const params = new URLSearchParams({ code: 'abc', state: 'somestate' })
    const result = await completeSignIn(params)
    // state mismatch takes priority over no-verifier when no session at all
    expect(result.ok).toBe(false)
    expect(['state-mismatch', 'no-verifier']).toContain((result as { ok: false; error: string }).error)
  })

  it('EC-02e: returns exchange-failed on non-200 from exchange endpoint', async () => {
    const stored = await setupValidSession()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }))
    const params = new URLSearchParams({ code: 'abc', state: stored.state })
    const result = await completeSignIn(params)
    expect(result).toEqual({ ok: false, error: 'exchange-failed' })
  })

  it('EC-02k: returns exchange-failed when body has error field', async () => {
    const stored = await setupValidSession()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: 'bad_verification_code' }),
    }))
    const params = new URLSearchParams({ code: 'abc', state: stored.state })
    const result = await completeSignIn(params)
    expect(result).toEqual({ ok: false, error: 'exchange-failed' })
  })

  it('EC-02e: returns exchange-failed when access_token missing from body', async () => {
    const stored = await setupValidSession()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ scope: 'public_repo' }),
    }))
    const params = new URLSearchParams({ code: 'abc', state: stored.state })
    const result = await completeSignIn(params)
    expect(result).toEqual({ ok: false, error: 'exchange-failed' })
  })

  it('success path: stores token in githubAuth with oauth method', async () => {
    const stored = await setupValidSession('public_repo')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'gho_TOKEN123', scope: 'public_repo' }),
    }))
    const params = new URLSearchParams({ code: 'abc', state: stored.state })
    const result = await completeSignIn(params)
    expect(result).toEqual({ ok: true })
    const { getSettings } = await import('../settings/settings')
    expect(getSettings().githubAuth).toEqual({
      token: 'gho_TOKEN123',
      method: 'oauth',
      scopes: ['public_repo'],
    })
  })

  it('success path: clears sessionStorage after completion', async () => {
    const stored = await setupValidSession('public_repo')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'gho_TOKEN123', scope: 'public_repo' }),
    }))
    const params = new URLSearchParams({ code: 'abc', state: stored.state })
    await completeSignIn(params)
    expect(sessionStorage.getItem('review123:oauth')).toBeNull()
  })

  it('failed exchange: sessionStorage entry is cleared even when exchange fails', async () => {
    const stored = await setupValidSession('public_repo')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }))
    const params = new URLSearchParams({ code: 'abc', state: stored.state })
    const result = await completeSignIn(params)
    expect(result).toEqual({ ok: false, error: 'exchange-failed' })
    expect(sessionStorage.getItem('review123:oauth')).toBeNull()
  })

  it('success path with repo scope: records scopes correctly', async () => {
    const stored = await setupValidSession('repo')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'gho_TOKEN123', scope: 'repo' }),
    }))
    const params = new URLSearchParams({ code: 'abc', state: stored.state })
    const result = await completeSignIn(params)
    expect(result).toEqual({ ok: true })
    // Verify the scopes are stored: import settings to check
    const { getSettings } = await import('../settings/settings')
    const s = getSettings()
    expect(s.githubAuth).toEqual({
      token: 'gho_TOKEN123',
      method: 'oauth',
      scopes: ['repo'],
    })
  })
})

describe('needsScopeUpgrade', () => {
  it('returns true when signed in via oauth with only public_repo scope', async () => {
    const stored = await (async () => {
      sessionStorage.clear()
      const url = await beginSignIn('public_repo')
      return JSON.parse(sessionStorage.getItem('review123:oauth')!)
    })()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'gho_PUBLIC', scope: 'public_repo' }),
    }))
    const params = new URLSearchParams({ code: 'abc', state: stored.state })
    await completeSignIn(params)
    expect(needsScopeUpgrade()).toBe(true)
  })

  it('returns false when signed in via oauth with repo scope', async () => {
    const stored = await (async () => {
      sessionStorage.clear()
      const url = await beginSignIn('repo')
      return JSON.parse(sessionStorage.getItem('review123:oauth')!)
    })()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'gho_FULL', scope: 'repo' }),
    }))
    const params = new URLSearchParams({ code: 'abc', state: stored.state })
    await completeSignIn(params)
    expect(needsScopeUpgrade()).toBe(false)
  })

  it('returns false when signed in via PAT (never needs upgrade)', async () => {
    const { setGithubPat } = await import('../settings/settings')
    setGithubPat('ghp_PATTOKEN')
    expect(needsScopeUpgrade()).toBe(false)
  })

  it('returns false when signed out (no token)', () => {
    expect(needsScopeUpgrade()).toBe(false)
  })
})

describe('signOut', () => {
  it('clears githubAuth from settings', async () => {
    // Sign in via PAT to set something
    const { setGithubPat, getSettings } = await import('../settings/settings')
    setGithubPat('ghp_X')
    signOut()
    expect(getSettings().githubAuth).toBeNull()
  })
})
