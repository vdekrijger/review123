/**
 * src/lib/provider/gitlabClient.ts — low-level GitLab REST client.
 *
 * Auth resolution order (per request):
 *   1. GitLab OAuth token (gitlabOAuth.token) if present and not expired.
 *   2. PAT (gitlabToken) as fallback.
 *
 * Transparent OAuth refresh on 401:
 *   When an OAuth token is active and the API returns 401, we attempt one
 *   token refresh (POST /oauth/token with grant_type=refresh_token). On
 *   success we update settings and retry the original request once. On
 *   failure we clear gitlabOAuth and surface the 401 as GitlabApiError
 *   { kind: 'unauthorized' } so callers can prompt re-authentication.
 *   We deliberately do NOT retry infinitely — after the single refresh
 *   attempt the request either succeeds or throws.
 *
 * CORS assumption: GitLab.com allows CORS on /oauth/token for public PKCE
 * clients. Self-hosted instances may vary; a CORS failure is surfaced as
 * GitlabApiError { kind: 'network' } which callers can display to the user.
 *
 * Error mapping mirrors GithubError / GithubApiError so upper layers stay symmetric.
 */

import { getSettings, saveGitlabOAuth } from '../settings/settings'
import { resolveGitlabToken } from '../auth/gitlabAuth'

// ---------------------------------------------------------------------------
// Error types — mirrors github/types.ts GithubError shape
// ---------------------------------------------------------------------------

export type GitlabError =
  | { kind: 'not-found' }
  | { kind: 'unauthorized' }
  | { kind: 'rate-limited'; resetAt: Date }
  | { kind: 'forbidden'; message?: string }
  | { kind: 'unprocessable'; message: string }
  | { kind: 'server'; status: number }
  | { kind: 'network' }

export class GitlabApiError extends Error {
  constructor(public readonly detail: GitlabError) {
    super(`gitlab: ${detail.kind}`)
  }
}

// ---------------------------------------------------------------------------
// Base URL + header builder
// ---------------------------------------------------------------------------

/** Compute the GitLab API base URL per-request (picks up gitlabHost changes without restart). */
function getBase(): string {
  return `https://${getSettings().gitlabHost}/api/v4`
}

/**
 * Build auth headers for a request.
 * - OAuth tokens (gitlabOAuth) → Authorization: Bearer
 * - PATs (gitlabToken) → PRIVATE-TOKEN (canonical GitLab PAT header)
 *
 * GitLab API v4 accepts both:
 *   Authorization: Bearer <oauth-token>
 *   PRIVATE-TOKEN: <pat>
 * Reference: https://docs.gitlab.com/ee/api/rest/index.html#authentication
 *
 * @param oauthTokenOverride - When set, always uses Authorization: Bearer with this token
 *   (used during the post-refresh retry so we don't re-check settings mid-flight).
 */
function buildHeaders(oauthTokenOverride?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (oauthTokenOverride) {
    // Explicit OAuth token override (post-refresh retry path)
    headers['Authorization'] = `Bearer ${oauthTokenOverride}`
    return headers
  }

  const settings = getSettings()
  const oauth = settings.gitlabOAuth
  const isOAuthActive = oauth && Date.now() < oauth.expiresAt - 60_000

  if (isOAuthActive) {
    // Active OAuth token — use Bearer
    headers['Authorization'] = `Bearer ${oauth.token}`
  } else if (settings.gitlabToken) {
    // PAT fallback — use PRIVATE-TOKEN (the canonical GitLab PAT header)
    headers['PRIVATE-TOKEN'] = settings.gitlabToken
  }
  // If neither, no auth header (unauthenticated request)
  return headers
}

/**
 * Attempt to refresh the GitLab OAuth access token using the stored refresh_token.
 * On success: updates settings.gitlabOAuth with the new token bundle and returns
 * the new access token.
 * On failure: clears settings.gitlabOAuth and returns null.
 *
 * No client_secret is required — this is a public client PKCE refresh grant.
 * Reference: https://docs.gitlab.com/ee/api/oauth2.html#authorization-code-with-proof-key-for-code-exchange-pkce
 */
async function refreshGitlabOAuth(): Promise<string | null> {
  const settings = getSettings()
  const oauth = settings.gitlabOAuth
  const clientId =
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GITLAB_CLIENT_ID) || ''

  if (!oauth || !clientId) {
    return null
  }

  const host = settings.gitlabHost

  try {
    const res = await fetch(`https://${host}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
      }),
    })

    if (!res.ok) {
      saveGitlabOAuth(null)
      return null
    }

    const body = (await res.json()) as Record<string, unknown>
    const newToken = body['access_token']
    const newRefresh = body['refresh_token']
    const expiresIn = typeof body['expires_in'] === 'number' ? (body['expires_in'] as number) : 7200

    if (typeof newToken !== 'string' || !newToken || typeof newRefresh !== 'string' || !newRefresh) {
      saveGitlabOAuth(null)
      return null
    }

    const updated = {
      token: newToken,
      refreshToken: newRefresh,
      expiresAt: Date.now() + expiresIn * 1000,
    }
    saveGitlabOAuth(updated)
    return newToken
  } catch {
    saveGitlabOAuth(null)
    return null
  }
}

// ---------------------------------------------------------------------------
// glFetch — single-page fetch
// ---------------------------------------------------------------------------

export async function glFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${getBase()}${path}`
  const headers = { ...buildHeaders(), ...(init.headers as Record<string, string> | undefined) }
  const signal = init.signal ?? AbortSignal.timeout(20_000)
  let res: Response
  try {
    res = await fetch(url, { ...init, headers, signal })
  } catch {
    throw new GitlabApiError({ kind: 'network' })
  }

  // Transparent OAuth refresh: attempt once on 401 when an OAuth token is active.
  if (res.status === 401 && getSettings().gitlabOAuth) {
    const newToken = await refreshGitlabOAuth()
    if (newToken) {
      // Retry once with the refreshed token (no loop — if this 401s again, we throw).
      const retryHeaders = {
        ...buildHeaders(newToken),
        ...(init.headers as Record<string, string> | undefined),
      }
      let retryRes: Response
      try {
        retryRes = await fetch(url, { ...init, headers: retryHeaders, signal: AbortSignal.timeout(20_000) })
      } catch {
        throw new GitlabApiError({ kind: 'network' })
      }
      if (retryRes.ok) return (await retryRes.json()) as T
      throw new GitlabApiError(mapError(retryRes, await tryParseBody(retryRes)))
    }
    // Refresh failed — gitlabOAuth was cleared; throw unauthorized so UI can prompt re-auth.
    throw new GitlabApiError({ kind: 'unauthorized' })
  }

  if (res.ok) return (await res.json()) as T
  throw new GitlabApiError(mapError(res, await tryParseBody(res)))
}

// ---------------------------------------------------------------------------
// glFetchPage — paginated fetch; extracts X-Next-Page header
// ---------------------------------------------------------------------------

export async function glFetchPage<T>(
  pathOrUrl: string,
): Promise<{ body: T; next: string | null }> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${getBase()}${pathOrUrl}`
  let res: Response
  try {
    res = await fetch(url, {
      headers: buildHeaders(),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new GitlabApiError({ kind: 'network' })
  }
  if (!res.ok) throw new GitlabApiError(mapError(res, await tryParseBody(res)))

  // GitLab uses X-Next-Page header (empty string = no next page)
  const nextPage = res.headers.get('X-Next-Page')
  let nextUrl: string | null = null
  if (nextPage && nextPage.trim() !== '') {
    // Reconstruct the URL with the page param replaced (or added).
    // Use [?&]page= regex to avoid matching "per_page=" in the URL.
    const hasPageParam = /[?&]page=/.test(url)
    if (hasPageParam) {
      nextUrl = url.replace(/([?&])page=\d+/, `$1page=${nextPage}`)
    } else {
      nextUrl = url.includes('?') ? `${url}&page=${nextPage}` : `${url}?page=${nextPage}`
    }
  }

  return { body: (await res.json()) as T, next: nextUrl }
}

// ---------------------------------------------------------------------------
// glFetchRaw — for file-content endpoints that return text, not JSON
// ---------------------------------------------------------------------------

export async function glFetchRaw(path: string): Promise<string | null> {
  const url = `${getBase()}${path}`
  let res: Response
  try {
    res = await fetch(url, {
      headers: buildHeaders(),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new GitlabApiError({ kind: 'network' })
  }
  if (res.status === 404) return null
  if (!res.ok) throw new GitlabApiError(mapError(res, await tryParseBody(res)))
  return res.text()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tryParseBody(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

function mapError(res: Response, body: Record<string, unknown>): GitlabError {
  if (res.status === 404) return { kind: 'not-found' }
  if (res.status === 401) return { kind: 'unauthorized' }
  if (res.status === 403) {
    const message = typeof body['message'] === 'string' ? body['message'] : undefined
    return { kind: 'forbidden', message }
  }
  if (res.status === 422) {
    const message = typeof body['message'] === 'string' ? body['message'] : 'Unprocessable Entity'
    return { kind: 'unprocessable', message }
  }
  // GitLab rate limiting: 429 or Retry-After header
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? 60)
    const resetAt = new Date(Date.now() + retryAfter * 1000)
    return { kind: 'rate-limited', resetAt }
  }
  return { kind: 'server', status: res.status }
}
