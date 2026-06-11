import { getSettings } from '../settings/settings'
import { GithubApiError, type GithubError } from './types'

const BASE = 'https://api.github.com'

function baseHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const pat = getSettings().githubPat
  if (pat) headers.Authorization = `Bearer ${pat}`
  return headers
}

export async function ghFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = { ...baseHeaders(), ...(init.headers as Record<string, string> | undefined) }
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers })
  } catch {
    throw new GithubApiError({ kind: 'network' })
  }
  if (res.ok) return (await res.json()) as T
  throw new GithubApiError(mapError(res))
}

// Returns one page plus the rel="next" link for paginated endpoints.
export async function ghFetchPage<T>(pathOrUrl: string): Promise<{ body: T; next: string | null }> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE}${pathOrUrl}`
  const parsedHost = new URL(url).hostname
  const headers = parsedHost === 'api.github.com' ? baseHeaders() : {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  let res: Response
  try {
    res = await fetch(url, { headers })
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
