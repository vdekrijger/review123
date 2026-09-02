/**
 * src/lib/provider/bitbucketClient.ts — HTTP client for the Bitbucket Cloud REST API v2.0.
 *
 * Authentication: HTTP Basic auth with base64(email:token).
 * Base URL: https://api.bitbucket.org/2.0
 *
 * Key behaviours:
 *   - fetchJson<T>: JSON response
 *   - fetchRaw: plain-text response (for /src/:commit/:path endpoints)
 *   - fetchPage<T>: paginated responses (Bitbucket uses absolute `next` links in body)
 *   - All errors are thrown as BitbucketApiError with typed BitbucketError detail
 */

import { getSettings } from '../settings/settings'
import { classifyFetchFailure, requestSignals } from '../net/signals'

const BASE = 'https://api.bitbucket.org/2.0'

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type BitbucketError =
  | { kind: 'not-found' }
  | { kind: 'unauthorized' }
  | { kind: 'forbidden'; message?: string }
  | { kind: 'rate-limited' }
  | { kind: 'server'; status: number }
  // Mirrors GithubError: a timeout is not a connectivity failure, and a
  // cancellation is not a failure at all.
  | { kind: 'timeout'; afterMs: number }
  | { kind: 'cancelled' }
  | { kind: 'network' }

export class BitbucketApiError extends Error {
  constructor(public readonly detail: BitbucketError) {
    super(`bitbucket: ${detail.kind}`)
  }
}

/** Per-request window for a Bitbucket API call. */
const BITBUCKET_TIMEOUT_MS = 20_000

/** Classify a failed fetch (or a failed read of its body) into a BitbucketError. */
function fetchFailure(err: unknown, timeoutSignal?: AbortSignal): BitbucketApiError {
  const kind = classifyFetchFailure(err, timeoutSignal)
  if (kind === 'timeout') {
    return new BitbucketApiError({ kind: 'timeout', afterMs: BITBUCKET_TIMEOUT_MS })
  }
  if (kind === 'cancelled') return new BitbucketApiError({ kind: 'cancelled' })
  return new BitbucketApiError({ kind: 'network' })
}

// ---------------------------------------------------------------------------
// Auth header
// ---------------------------------------------------------------------------

function buildAuthHeader(): string | null {
  const auth = getSettings().bitbucketAuth
  if (!auth) return null
  const encoded = btoa(`${auth.email}:${auth.token}`)
  return `Basic ${encoded}`
}

function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...extra,
  }
  const authHeader = buildAuthHeader()
  if (authHeader) headers.Authorization = authHeader
  return headers
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapError(res: Response): BitbucketError {
  if (res.status === 404) return { kind: 'not-found' }
  if (res.status === 401) return { kind: 'unauthorized' }
  if (res.status === 403) return { kind: 'forbidden' }
  if (res.status === 429) return { kind: 'rate-limited' }
  return { kind: 'server', status: res.status }
}

// ---------------------------------------------------------------------------
// fetchJson — standard JSON fetch
// ---------------------------------------------------------------------------

export async function bbFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${BASE}${path}`
  const headers = {
    ...buildHeaders(),
    ...(init.headers as Record<string, string> | undefined),
  }
  // Composed, never substituted — a caller signal used to disable the window.
  const { timeoutSignal, effectiveSignal } = requestSignals(init.signal, BITBUCKET_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, { ...init, headers, signal: effectiveSignal })
  } catch (err) {
    throw fetchFailure(err, timeoutSignal)
  }
  if (res.ok) {
    try {
      return (await res.json()) as T
    } catch (err) {
      throw fetchFailure(err, timeoutSignal)
    }
  }
  throw new BitbucketApiError(mapError(res))
}

// ---------------------------------------------------------------------------
// fetchRaw — plain-text fetch (for /src/:commit/:path)
// ---------------------------------------------------------------------------

export async function bbFetchRaw(path: string): Promise<string | null> {
  const url = path.startsWith('http') ? path : `${BASE}${path}`
  const headers = buildHeaders({ Accept: 'text/plain, */*' })
  const { timeoutSignal, effectiveSignal } = requestSignals(undefined, BITBUCKET_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, { headers, signal: effectiveSignal })
  } catch (err) {
    throw fetchFailure(err, timeoutSignal)
  }
  if (res.status === 404) return null
  if (res.ok) {
    try {
      return await res.text()
    } catch (err) {
      throw fetchFailure(err, timeoutSignal)
    }
  }
  throw new BitbucketApiError(mapError(res))
}

// ---------------------------------------------------------------------------
// fetchPage — paginated fetch (Bitbucket puts `next` URL in response body)
// ---------------------------------------------------------------------------

export interface BbPage<T> {
  values: T[]
  next?: string
}

export async function bbFetchPage<T>(pathOrUrl: string): Promise<{ body: T[]; next: string | null }> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE}${pathOrUrl}`
  const headers = buildHeaders()
  const { timeoutSignal, effectiveSignal } = requestSignals(undefined, BITBUCKET_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, { headers, signal: effectiveSignal })
  } catch (err) {
    throw fetchFailure(err, timeoutSignal)
  }
  if (!res.ok) throw new BitbucketApiError(mapError(res))
  let page: BbPage<T>
  try {
    page = (await res.json()) as BbPage<T>
  } catch (err) {
    throw fetchFailure(err, timeoutSignal)
  }
  return {
    body: page.values ?? [],
    next: page.next ?? null,
  }
}

// ---------------------------------------------------------------------------
// Fetch all pages — collect all values from a paginated endpoint
// ---------------------------------------------------------------------------

export async function bbFetchAll<T>(startPath: string, maxPages = 20): Promise<T[]> {
  const all: T[] = []
  let next: string | null = startPath
  let pages = 0
  while (next !== null && pages < maxPages) {
    const result: { body: T[]; next: string | null } = await bbFetchPage<T>(next)
    all.push(...result.body)
    next = result.next
    pages++
  }
  return all
}
