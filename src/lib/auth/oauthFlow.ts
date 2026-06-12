/**
 * Shared OAuth flow orchestration — the SINGLE entry point every "Sign in
 * with …" handler (navbar, settings, verdict step) must use, plus the
 * callback-side dispatcher.
 *
 * Why this module exists (bug history): each entry point used to write its
 * own pending-state, and AuthCallback dispatched on "does a GitLab session
 * key exist?". A GitLab sign-in abandoned before the callback (e.g. GitLab
 * rejects the redirect URI, user presses Back) left a STALE
 * 'review123:gitlab-oauth' key behind, so the next GitHub sign-in was
 * misdispatched to the GitLab completer and failed with a GitLab-named
 * error. Two mechanisms fix this:
 *
 *   1. beginOAuth() clears BOTH pending sessions before starting a flow, so
 *      at most one pending session exists per tab.
 *   2. resolvePendingProvider() matches the callback's `state` nonce against
 *      each pending session FIRST — the freshest flow always wins even if a
 *      stale key somehow survives (defense in depth).
 */

import { beginSignIn } from './auth'
import { beginGitlabSignIn } from './gitlabAuth'
import {
  GITHUB_OAUTH_SESSION_KEY,
  GITLAB_OAUTH_SESSION_KEY,
  OAUTH_RETURN_KEY,
} from './oauthKeys'

export type OAuthProvider = 'github' | 'gitlab'

/** Remove any pending OAuth session (stale leftovers from abandoned flows). */
export function clearPendingOAuthSessions(): void {
  sessionStorage.removeItem(GITHUB_OAUTH_SESSION_KEY)
  sessionStorage.removeItem(GITLAB_OAUTH_SESSION_KEY)
}

/**
 * Begin an OAuth sign-in for `provider` and return the authorize URL the
 * caller should navigate to (location.assign).
 *
 * Clears every stale pending session first and stores `returnTo` (defaults
 * to the current path) so AuthCallback navigates back after completion.
 */
export async function beginOAuth(
  provider: OAuthProvider,
  returnTo: string = location.pathname,
): Promise<string> {
  clearPendingOAuthSessions()
  sessionStorage.setItem(OAUTH_RETURN_KEY, returnTo)
  return provider === 'gitlab' ? beginGitlabSignIn() : beginSignIn('public_repo')
}

/** Read the `state` nonce of a pending session; null if absent/malformed. */
function readSessionState(key: string): string | null {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state?: unknown }
    return typeof parsed.state === 'string' && parsed.state ? parsed.state : null
  } catch {
    return null
  }
}

/**
 * Decide which provider the incoming /auth/callback belongs to.
 *
 * Primary signal: the callback's `state` nonce — it can only match the
 * session of the flow that was actually started. Fallback (providers that
 * fail to echo `state` on error responses): a single pending session.
 * Returns null when nothing pending matches — the caller should show a
 * provider-agnostic error rather than blame the wrong provider.
 */
export function resolvePendingProvider(params: URLSearchParams): OAuthProvider | null {
  const githubState = readSessionState(GITHUB_OAUTH_SESSION_KEY)
  const gitlabState = readSessionState(GITLAB_OAUTH_SESSION_KEY)

  const incoming = params.get('state')
  if (incoming) {
    if (incoming === githubState) return 'github'
    if (incoming === gitlabState) return 'gitlab'
  }

  if (githubState !== null && gitlabState === null) return 'github'
  if (gitlabState !== null && githubState === null) return 'gitlab'
  return null
}
