/**
 * GitHub OAuth PKCE sign-in flow.
 * State: sessionStorage key 'review123:oauth' holds { state, verifier, scope }.
 */
import { generateVerifier, challengeFromVerifier } from './pkce'
import { getSettings, saveGithubAuth } from '../settings/settings'
import { GITHUB_OAUTH_SESSION_KEY } from './oauthKeys'

const SESSION_KEY = GITHUB_OAUTH_SESSION_KEY
const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize'
const EXCHANGE_ENDPOINT = '/api/oauth/exchange'

export type SignInScope = 'public_repo' | 'repo'

export type SignInResult =
  | { ok: true }
  | { ok: false; error: 'state-mismatch' | 'missing-code' | 'denied' | 'no-verifier' | 'exchange-failed' }

interface OAuthSession {
  state: string
  verifier: string
  scope: string
}

function generateState(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Begin the OAuth PKCE flow.
 * Stores { state, verifier, scope } in sessionStorage and returns the GitHub authorize URL.
 */
export async function beginSignIn(scope: SignInScope): Promise<string> {
  const state = generateState()
  const verifier = generateVerifier()
  const challenge = await challengeFromVerifier(verifier)

  const session: OAuthSession = { state, verifier, scope }
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))

  const clientId = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GITHUB_CLIENT_ID)
    || ''
  const redirectUri = `${location.origin}/auth/callback`

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })

  return `${GITHUB_AUTHORIZE}?${params.toString()}`
}

/**
 * Complete the OAuth PKCE flow after the callback redirect.
 * Validates state, exchanges the code, and stores the token.
 */
export async function completeSignIn(params: URLSearchParams): Promise<SignInResult> {
  const rawSession = sessionStorage.getItem(SESSION_KEY)
  const session: OAuthSession | null = rawSession ? (JSON.parse(rawSession) as OAuthSession) : null

  const incomingState = params.get('state')
  const storedState = session?.state ?? null

  // Always clear the session key when completeSignIn exits, regardless of outcome.
  // A failed exchange means the code is dead; user must restart sign-in anyway.
  try {
    // EC-02d: state mismatch (includes case where no session at all)
    if (!incomingState || incomingState !== storedState) {
      return { ok: false, error: 'state-mismatch' }
    }

    // EC-02b: user denied
    if (params.get('error') === 'access_denied') {
      return { ok: false, error: 'denied' }
    }

    // EC-02a: missing code
    const code = params.get('code')
    if (!code) {
      return { ok: false, error: 'missing-code' }
    }

    // EC-02c: verifier missing (shouldn't happen if state matched, but guard anyway)
    const verifier = session?.verifier
    if (!verifier) {
      return { ok: false, error: 'no-verifier' }
    }

    const scope = session?.scope ?? ''

    // Exchange code for token
    let res: Response
    try {
      res = await fetch(EXCHANGE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier }),
      })
    } catch {
      return { ok: false, error: 'exchange-failed' }
    }

    // EC-02e: non-200
    if (!res.ok) {
      return { ok: false, error: 'exchange-failed' }
    }

    let body: Record<string, unknown>
    try {
      body = (await res.json()) as Record<string, unknown>
    } catch {
      return { ok: false, error: 'exchange-failed' }
    }

    // EC-02k: GitHub error in body
    if (body['error']) {
      return { ok: false, error: 'exchange-failed' }
    }

    // EC-02e: missing access_token
    const token = body['access_token']
    if (typeof token !== 'string' || !token) {
      return { ok: false, error: 'exchange-failed' }
    }

    // Success: store token
    saveGithubAuth({
      token,
      method: 'oauth',
      scopes: scope ? scope.split(',').map((s) => s.trim()).filter(Boolean) : [],
    })

    return { ok: true }
  } finally {
    sessionStorage.removeItem(SESSION_KEY)
  }
}

/**
 * REQ-03: True when signed in via OAuth without the 'repo' scope.
 * PAT users never need a scope upgrade.
 */
export function needsScopeUpgrade(): boolean {
  const auth = getSettings().githubAuth
  if (!auth || auth.method !== 'oauth') return false
  return !auth.scopes.includes('repo')
}

/**
 * Sign the user out by clearing githubAuth.
 */
export function signOut(): void {
  saveGithubAuth(null)
}
