import { getSettings } from '../settings/settings'
import { GithubApiError, type GithubError } from './types'

const BASE = 'https://api.github.com'

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
  const signal = init.signal ?? AbortSignal.timeout(20_000)
  let res: Response
  try {
    res = await fetch(url, { ...init, headers, signal })
  } catch {
    throw new GithubApiError({ kind: 'network' })
  }
  if (res.ok) return (await res.json()) as T
  if (res.status === 422) {
    let msg = 'Unprocessable Entity'
    try {
      const body = (await res.json()) as { message?: string }
      if (typeof body.message === 'string') msg = body.message
    } catch { /* ignore parse errors */ }
    throw new GithubApiError({ kind: 'unprocessable', message: msg })
  }
  throw new GithubApiError(mapError(res))
}

export async function ghFetchPage<T>(pathOrUrl: string): Promise<{ body: T; next: string | null }> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE}${pathOrUrl}`
  let res: Response
  try {
    res = await fetch(url, { headers: buildHeaders(url), signal: AbortSignal.timeout(20_000) })
  } catch {
    throw new GithubApiError({ kind: 'network' })
  }
  if (!res.ok) throw new GithubApiError(mapError(res))
  const link = res.headers.get('Link') ?? ''
  const m = link.match(/<([^>]+)>;\s*rel="next"/)
  return { body: (await res.json()) as T, next: m ? m[1] : null }
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
