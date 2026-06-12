/**
 * src/lib/provider/gitlabClient.ts — low-level GitLab REST client.
 *
 * Uses PRIVATE-TOKEN header (PAT) from settings.gitlabToken.
 * Error mapping mirrors GithubError / GithubApiError so upper layers stay symmetric.
 */

import { getSettings } from '../settings/settings'

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

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const token = getSettings().gitlabToken
  if (token) headers['PRIVATE-TOKEN'] = token
  return headers
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
