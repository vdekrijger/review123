import { getSettings } from '../settings/settings'
import { GithubApiError, type GithubError } from './types'
import { classifyFetchFailure, requestSignals } from '../net/signals'

const BASE = 'https://api.github.com'

/** Per-request window for a GitHub API call. */
const GITHUB_TIMEOUT_MS = 20_000

/**
 * Classify a failed fetch — or a failed read of its body — into a GithubError.
 *
 * Every one of these used to be `{ kind: 'network' }`, so a request that timed
 * out or was cancelled told the user to "check your connection". `timeoutSignal`
 * is our own window, which is what distinguishes "GitHub was too slow" from
 * "something cancelled us" when the engine reports both as an AbortError.
 */
function fetchFailure(err: unknown, timeoutSignal?: AbortSignal): GithubApiError {
  const kind = classifyFetchFailure(err, timeoutSignal)
  if (kind === 'timeout') return new GithubApiError({ kind: 'timeout', afterMs: GITHUB_TIMEOUT_MS })
  if (kind === 'cancelled') return new GithubApiError({ kind: 'cancelled' })
  return new GithubApiError({ kind: 'network' })
}

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const

function buildHeaders(targetUrl?: string): Record<string, string> {
  const headers: Record<string, string> = { ...GITHUB_HEADERS }
  const isGithubApi = !targetUrl || new URL(targetUrl).hostname === 'api.github.com'
  if (isGithubApi) {
    const auth = getSettings().githubAuth
    if (auth) headers.Authorization = `Bearer ${auth.token}`
  }
  return headers
}

export async function ghFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${BASE}${path}`
  const headers = { ...buildHeaders(url), ...(init.headers as Record<string, string> | undefined) }
  // The caller's signal is COMPOSED with the window, never substituted for it:
  // `init.signal ?? AbortSignal.timeout(...)` meant any caller that passed a
  // signal got NO timeout and could hang forever.
  const { timeoutSignal, effectiveSignal } = requestSignals(init.signal, GITHUB_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, { ...init, headers, signal: effectiveSignal })
  } catch (err) {
    throw fetchFailure(err, timeoutSignal)
  }
  // The body read is inside the same boundary: fetch() resolves on HEADERS, so
  // a window firing mid-body rejects THIS read, not the fetch.
  if (res.ok) {
    try {
      return (await res.json()) as T
    } catch (err) {
      throw fetchFailure(err, timeoutSignal)
    }
  }
  if (res.status === 422) {
    let msg = 'Unprocessable Entity'
    let errors: unknown[] | undefined
    try {
      const body = (await res.json()) as { message?: string; errors?: unknown[] }
      if (typeof body.message === 'string') msg = body.message
      if (Array.isArray(body.errors)) errors = body.errors
    } catch { /* ignore parse errors */ }
    throw new GithubApiError({ kind: 'unprocessable', message: msg, ...(errors ? { errors } : {}) })
  }
  if (res.status === 403 && res.headers.get('X-RateLimit-Remaining') !== '0') {
    // Read body to capture GitHub's message (e.g. org OAuth-app restriction messages)
    let message: string | undefined
    try {
      const body = (await res.json()) as { message?: string }
      if (typeof body.message === 'string') message = body.message
    } catch { /* ignore parse errors */ }
    throw new GithubApiError({ kind: 'forbidden', message })
  }
  throw new GithubApiError(mapError(res))
}

export async function ghFetchPage<T>(pathOrUrl: string): Promise<{ body: T; next: string | null }> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE}${pathOrUrl}`
  const { timeoutSignal, effectiveSignal } = requestSignals(undefined, GITHUB_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, { headers: buildHeaders(url), signal: effectiveSignal })
  } catch (err) {
    throw fetchFailure(err, timeoutSignal)
  }
  if (!res.ok) throw new GithubApiError(mapError(res))
  const link = res.headers.get('Link') ?? ''
  const m = link.match(/<([^>]+)>;\s*rel="next"/)
  try {
    return { body: (await res.json()) as T, next: m ? m[1] : null }
  } catch (err) {
    throw fetchFailure(err, timeoutSignal)
  }
}

function mapError(res: Response): GithubError {
  if (res.status === 404) return { kind: 'not-found' }
  if (res.status === 401) return { kind: 'unauthorized' }
  if (res.status === 403) {
    if (res.headers.get('X-RateLimit-Remaining') === '0') {
      const reset = Number(res.headers.get('X-RateLimit-Reset') ?? 0)
      return { kind: 'rate-limited', resetAt: new Date(reset * 1000) }
    }
    return { kind: 'forbidden' }
  }
  return { kind: 'server', status: res.status }
}

