/**
 * GitLab OAuth PKCE sign-in flow (public client — no client secret needed).
 *
 * GitLab fully supports PKCE for public clients (RFC 7636 / OAuth 2.0).
 * Reference: https://docs.gitlab.com/ee/api/oauth2.html#authorization-code-with-proof-key-for-code-exchange-pkce
 *
 * Token exchange is performed DIRECTLY from the browser against:
 *   POST https://{host}/oauth/token
 * GitLab's token endpoint allows CORS for PKCE public apps.
 *
 * CORS assumption: We attempt the direct browser exchange first.
 * If CORS is blocked at runtime (network error on the OPTIONS preflight),
 * completeGitlabSignIn returns { ok: false, error: 'exchange-failed' } and
 * the caller can surface a message directing the user to use a PAT instead.
 * This is a clean, recoverable failure — no server-side proxy is needed for
 * the happy path and we do not silently fall back to PAT.
 *
 * Token lifetime: GitLab access tokens expire after 2 hours.
 * Refresh is handled transparently in gitlabClient.ts (refresh grant on 401).
 *
 * State payload: The sessionStorage key holds { state, verifier, provider:'gitlab' }.
 * Both GitHub and GitLab flows share /auth/callback; dispatch to the correct
 * completer is handled by oauthFlow.resolvePendingProvider, which matches the
 * callback's `state` nonce against each pending session (the CSRF-protecting
 * nonce is the real security invariant and is validated again on completion).
 */

import { generateVerifier, challengeFromVerifier } from './pkce'
import { getSettings, saveGitlabOAuth } from '../settings/settings'
import { GITLAB_OAUTH_SESSION_KEY } from './oauthKeys'

const SESSION_KEY = GITLAB_OAUTH_SESSION_KEY

/** Scope required for full GitLab API access (MR read/write, project read). */
const GITLAB_SCOPE = 'api'

export type GitlabSignInResult =
  | { ok: true }
  | {
      ok: false
      error:
        | 'state-mismatch'
        | 'missing-code'
        | 'denied'
        | 'no-verifier'
        | 'exchange-failed'
        | 'no-client-id'
    }

interface GitlabOAuthSession {
  state: string
  verifier: string
  /** Always 'gitlab' — used by AuthCallback to dispatch the right completer. */
  provider: 'gitlab'
}

function generateState(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Begin the GitLab OAuth PKCE flow.
 * Stores { state, verifier, provider:'gitlab' } in sessionStorage and returns
 * the GitLab authorize URL.
 *
 * @param host - GitLab hostname (e.g. "gitlab.com" or "gitlab.mycompany.com").
 *               Defaults to settings.gitlabHost when omitted.
 */
export async function beginGitlabSignIn(host?: string): Promise<string> {
  const effectiveHost = host ?? getSettings().gitlabHost

  const clientId =
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GITLAB_CLIENT_ID) || ''

  if (!clientId) {
    throw new Error('VITE_GITLAB_CLIENT_ID is not set — GitLab OAuth is not configured')
  }

  const state = generateState()
  const verifier = generateVerifier()
  const challenge = await challengeFromVerifier(verifier)

  const session: GitlabOAuthSession = { state, verifier, provider: 'gitlab' }
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))

  const redirectUri = `${location.origin}/auth/callback`

  // GitLab authorize URL:
  // https://docs.gitlab.com/ee/api/oauth2.html#authorization-code-with-proof-key-for-code-exchange-pkce
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    scope: GITLAB_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })

  return `https://${effectiveHost}/oauth/authorize?${params.toString()}`
}

/**
 * Complete the GitLab OAuth PKCE flow after the callback redirect.
 * Validates state, exchanges the authorization code directly with GitLab
 * (browser → GitLab token endpoint; no server proxy required for public clients).
 * Stores the resulting token bundle ({ token, refreshToken, expiresAt }) in settings.
 */
export async function completeGitlabSignIn(params: URLSearchParams): Promise<GitlabSignInResult> {
  const rawSession = sessionStorage.getItem(SESSION_KEY)
  const session: GitlabOAuthSession | null = rawSession
    ? (JSON.parse(rawSession) as GitlabOAuthSession)
    : null

  const incomingState = params.get('state')
  const storedState = session?.state ?? null

  // Always clear the session key when completeGitlabSignIn exits.
  try {
    if (!incomingState || incomingState !== storedState) {
      return { ok: false, error: 'state-mismatch' }
    }

    if (params.get('error') === 'access_denied') {
      return { ok: false, error: 'denied' }
    }

    const code = params.get('code')
    if (!code) {
      return { ok: false, error: 'missing-code' }
    }

    const verifier = session?.verifier
    if (!verifier) {
      return { ok: false, error: 'no-verifier' }
    }

    const clientId =
      (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GITLAB_CLIENT_ID) || ''
    if (!clientId) {
      return { ok: false, error: 'no-client-id' }
    }

    const host = getSettings().gitlabHost
    const redirectUri = `${location.origin}/auth/callback`

    // Direct browser → GitLab token exchange (PKCE public client).
    // GitLab's token endpoint supports CORS for public clients using PKCE:
    // https://docs.gitlab.com/ee/api/oauth2.html#authorization-code-with-proof-key-for-code-exchange-pkce
    // No client_secret is sent — this is the "public client" grant.
    let res: Response
    try {
      res = await fetch(`https://${host}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
      })
    } catch {
      // Network error or CORS block.
      // CORS note: GitLab.com allows CORS on /oauth/token for public PKCE clients.
      // Self-hosted instances may vary — if this fails, direct the user to use a PAT.
      return { ok: false, error: 'exchange-failed' }
    }

    if (!res.ok) {
      return { ok: false, error: 'exchange-failed' }
    }

    let body: Record<string, unknown>
    try {
      body = (await res.json()) as Record<string, unknown>
    } catch {
      return { ok: false, error: 'exchange-failed' }
    }

    if (body['error']) {
      return { ok: false, error: 'exchange-failed' }
    }

    const accessToken = body['access_token']
    const refreshToken = body['refresh_token']
    // GitLab returns expires_in in seconds; convert to an absolute ms timestamp.
    const expiresIn =
      typeof body['expires_in'] === 'number' ? (body['expires_in'] as number) : 7200

    if (typeof accessToken !== 'string' || !accessToken) {
      return { ok: false, error: 'exchange-failed' }
    }
    if (typeof refreshToken !== 'string' || !refreshToken) {
      return { ok: false, error: 'exchange-failed' }
    }

    saveGitlabOAuth({
      token: accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    })

    return { ok: true }
  } finally {
    sessionStorage.removeItem(SESSION_KEY)
  }
}

/**
 * Sign the user out of GitLab OAuth by clearing gitlabOAuth from settings.
 */
export function signOutGitlab(): void {
  saveGitlabOAuth(null)
}

/**
 * Resolve the active GitLab token for API calls:
 *   1. OAuth token if present and not expired (with 60-second buffer)
 *   2. PAT (gitlabToken) as fallback
 *   3. null if neither is configured
 *
 * This is the primary entry-point for gitlabClient.ts to pick up the token.
 * Transparent refresh is handled separately in gitlabClient.ts on 401.
 */
export function resolveGitlabToken(): string | null {
  const settings = getSettings()
  const oauth = settings.gitlabOAuth
  if (oauth) {
    // 60-second grace period so we don't use a token about to expire mid-request
    const isValid = Date.now() < oauth.expiresAt - 60_000
    if (isValid) return oauth.token
  }
  // Fall back to PAT
  return settings.gitlabToken ?? null
}
