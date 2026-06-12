/**
 * Tests for src/lib/auth/oauthFlow.ts — the shared begin-OAuth helper and the
 * callback dispatcher.
 *
 * Regression focus (settings-initiated GitHub sign-in failed with a GITLAB
 * error): a stale GitLab pending session must never win over a fresh GitHub
 * one (and vice versa).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { beginOAuth, clearPendingOAuthSessions, resolvePendingProvider } from './oauthFlow'
import {
  GITHUB_OAUTH_SESSION_KEY,
  GITLAB_OAUTH_SESSION_KEY,
  OAUTH_RETURN_KEY,
} from './oauthKeys'

vi.stubEnv('VITE_GITHUB_CLIENT_ID', 'test_client_id')
vi.stubEnv('VITE_GITLAB_CLIENT_ID', 'test_gitlab_client_id')

Object.defineProperty(globalThis, 'location', {
  value: { origin: 'https://app.example.com', pathname: '/settings' },
  writable: true,
  configurable: true,
})

function seedGithubSession(state = 'gh-state'): void {
  sessionStorage.setItem(
    GITHUB_OAUTH_SESSION_KEY,
    JSON.stringify({ state, verifier: 'gh-verifier', scope: 'public_repo' }),
  )
}

function seedGitlabSession(state = 'gl-state'): void {
  sessionStorage.setItem(
    GITLAB_OAUTH_SESSION_KEY,
    JSON.stringify({ state, verifier: 'gl-verifier', provider: 'gitlab' }),
  )
}

function storedState(key: string): string | undefined {
  const raw = sessionStorage.getItem(key)
  return raw ? (JSON.parse(raw) as { state?: string }).state : undefined
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// beginOAuth — single shared entry point
// ---------------------------------------------------------------------------

describe('beginOAuth', () => {
  it('github: returns a github.com authorize URL and stores a fresh GitHub session', async () => {
    const url = await beginOAuth('github')
    expect(url).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/)
    expect(sessionStorage.getItem(GITHUB_OAUTH_SESSION_KEY)).not.toBeNull()
    // The URL carries the same state nonce that was stored
    const state = new URL(url).searchParams.get('state')
    expect(state).toBe(storedState(GITHUB_OAUTH_SESSION_KEY))
  })

  it('gitlab: returns a gitlab authorize URL and stores a fresh GitLab session', async () => {
    const url = await beginOAuth('gitlab')
    expect(url).toMatch(/^https:\/\/gitlab\.com\/oauth\/authorize\?/)
    expect(sessionStorage.getItem(GITLAB_OAUTH_SESSION_KEY)).not.toBeNull()
    const state = new URL(url).searchParams.get('state')
    expect(state).toBe(storedState(GITLAB_OAUTH_SESSION_KEY))
  })

  it('clears a STALE GitLab pending session when a GitHub flow starts (the misdispatch bug)', async () => {
    seedGitlabSession('stale-gitlab-state')
    await beginOAuth('github')
    expect(sessionStorage.getItem(GITLAB_OAUTH_SESSION_KEY)).toBeNull()
    expect(sessionStorage.getItem(GITHUB_OAUTH_SESSION_KEY)).not.toBeNull()
  })

  it('clears a STALE GitHub pending session when a GitLab flow starts', async () => {
    seedGithubSession('stale-github-state')
    await beginOAuth('gitlab')
    expect(sessionStorage.getItem(GITHUB_OAUTH_SESSION_KEY)).toBeNull()
    expect(sessionStorage.getItem(GITLAB_OAUTH_SESSION_KEY)).not.toBeNull()
  })

  it('stores returnTo (defaults to location.pathname)', async () => {
    await beginOAuth('github')
    expect(sessionStorage.getItem(OAUTH_RETURN_KEY)).toBe('/settings')
  })

  it('stores an explicit returnTo when given', async () => {
    await beginOAuth('gitlab', '/review/a/b/7')
    expect(sessionStorage.getItem(OAUTH_RETURN_KEY)).toBe('/review/a/b/7')
  })
})

// ---------------------------------------------------------------------------
// clearPendingOAuthSessions
// ---------------------------------------------------------------------------

describe('clearPendingOAuthSessions', () => {
  it('removes both providers’ pending sessions', () => {
    seedGithubSession()
    seedGitlabSession()
    clearPendingOAuthSessions()
    expect(sessionStorage.getItem(GITHUB_OAUTH_SESSION_KEY)).toBeNull()
    expect(sessionStorage.getItem(GITLAB_OAUTH_SESSION_KEY)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resolvePendingProvider — callback dispatch
// ---------------------------------------------------------------------------

describe('resolvePendingProvider', () => {
  it('github pending + matching state → github', () => {
    seedGithubSession('s1')
    expect(resolvePendingProvider(new URLSearchParams('code=c&state=s1'))).toBe('github')
  })

  it('gitlab pending + matching state → gitlab', () => {
    seedGitlabSession('s2')
    expect(resolvePendingProvider(new URLSearchParams('code=c&state=s2'))).toBe('gitlab')
  })

  it('STALE gitlab + fresh github: state matches github → github wins', () => {
    seedGitlabSession('stale-gitlab')
    seedGithubSession('fresh-github')
    const params = new URLSearchParams('code=c&state=fresh-github')
    expect(resolvePendingProvider(params)).toBe('github')
  })

  it('STALE github + fresh gitlab: state matches gitlab → gitlab wins', () => {
    seedGithubSession('stale-github')
    seedGitlabSession('fresh-gitlab')
    const params = new URLSearchParams('code=c&state=fresh-gitlab')
    expect(resolvePendingProvider(params)).toBe('gitlab')
  })

  it('single github pending without a state param → github (error callbacks)', () => {
    seedGithubSession('s1')
    expect(resolvePendingProvider(new URLSearchParams('error=access_denied'))).toBe('github')
  })

  it('single gitlab pending without a state param → gitlab (error callbacks)', () => {
    seedGitlabSession('s2')
    expect(resolvePendingProvider(new URLSearchParams('error=access_denied'))).toBe('gitlab')
  })

  it('nothing pending → null', () => {
    expect(resolvePendingProvider(new URLSearchParams('code=c&state=s1'))).toBeNull()
  })

  it('both pending but state matches neither → null (ambiguous, never guess)', () => {
    seedGithubSession('a')
    seedGitlabSession('b')
    expect(resolvePendingProvider(new URLSearchParams('code=c&state=zzz'))).toBeNull()
  })

  it('malformed session JSON is treated as absent', () => {
    sessionStorage.setItem(GITLAB_OAUTH_SESSION_KEY, '{not json')
    seedGithubSession('s1')
    expect(resolvePendingProvider(new URLSearchParams('code=c&state=s1'))).toBe('github')
    expect(resolvePendingProvider(new URLSearchParams('code=c'))).toBe('github')
  })
})
