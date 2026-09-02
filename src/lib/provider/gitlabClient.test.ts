/**
 * Tests for the GitLab low-level client (glFetch, glFetchPage, glFetchRaw).
 *
 * Auth header tests:
 *   - PAT → PRIVATE-TOKEN header
 *   - OAuth (valid, not expired) → Authorization: Bearer header
 *   - No token → no auth header
 *
 * Refresh-on-401 tests:
 *   - OAuth active + 401 → refresh + retry succeeds (no infinite loop)
 *   - OAuth active + 401 → refresh fails → unauthorized thrown, gitlabOAuth cleared
 *   - No OAuth + 401 → unauthorized thrown immediately (no refresh attempt)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { glFetch, glFetchPage, glFetchRaw, GitlabApiError } from './gitlabClient'
import { setGitlabToken, setGitlabHost, saveGitlabOAuth, getSettings } from '../settings/settings'
import { jsonResponse } from '../../test-helpers'

function mockFetch(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue(jsonResponse(body, headers, status))
}

describe('glFetch', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  it('returns parsed JSON on 200', async () => {
    vi.stubGlobal('fetch', mockFetch({ id: 1 }))
    const data = await glFetch<{ id: number }>('/projects/1')
    expect(data).toEqual({ id: 1 })
  })

  it('sends PRIVATE-TOKEN header when gitlabToken (PAT) is set and no OAuth', async () => {
    const f = mockFetch({})
    vi.stubGlobal('fetch', f)
    setGitlabToken('glpat_mytoken')
    await glFetch('/projects/1')
    expect(f.mock.calls[0][1].headers['PRIVATE-TOKEN']).toBe('glpat_mytoken')
    expect(f.mock.calls[0][1].headers['Authorization']).toBeUndefined()
  })

  it('sends Authorization: Bearer when OAuth token is active (not expired)', async () => {
    const f = mockFetch({})
    vi.stubGlobal('fetch', f)
    saveGitlabOAuth({
      token: 'glOAT-active',
      refreshToken: 'glORT',
      expiresAt: Date.now() + 3_600_000,
    })
    await glFetch('/projects/1')
    expect(f.mock.calls[0][1].headers['Authorization']).toBe('Bearer glOAT-active')
    expect(f.mock.calls[0][1].headers['PRIVATE-TOKEN']).toBeUndefined()
  })

  it('falls back to PRIVATE-TOKEN when OAuth token is expired', async () => {
    const f = mockFetch({})
    vi.stubGlobal('fetch', f)
    saveGitlabOAuth({
      token: 'glOAT-expired',
      refreshToken: 'glORT',
      expiresAt: Date.now() - 1000,
    })
    setGitlabToken('glpat_fallback')
    await glFetch('/projects/1')
    expect(f.mock.calls[0][1].headers['PRIVATE-TOKEN']).toBe('glpat_fallback')
    expect(f.mock.calls[0][1].headers['Authorization']).toBeUndefined()
  })

  it('omits PRIVATE-TOKEN when no token configured', async () => {
    const f = mockFetch({})
    vi.stubGlobal('fetch', f)
    await glFetch('/projects/1')
    expect(f.mock.calls[0][1].headers['PRIVATE-TOKEN']).toBeUndefined()
    expect(f.mock.calls[0][1].headers['Authorization']).toBeUndefined()
  })

  it('maps 404 to not-found', async () => {
    vi.stubGlobal('fetch', mockFetch({ message: 'Not Found' }, 404))
    await expect(glFetch('/x')).rejects.toMatchObject({ detail: { kind: 'not-found' } })
  })

  it('maps 401 to unauthorized when no OAuth is configured (no refresh attempt)', async () => {
    vi.stubGlobal('fetch', mockFetch({}, 401))
    await expect(glFetch('/x')).rejects.toMatchObject({ detail: { kind: 'unauthorized' } })
  })

  it('maps 403 to forbidden', async () => {
    vi.stubGlobal('fetch', mockFetch({ message: 'Access denied' }, 403))
    await expect(glFetch('/x')).rejects.toMatchObject({ detail: { kind: 'forbidden', message: 'Access denied' } })
  })

  it('maps 422 to unprocessable with message', async () => {
    vi.stubGlobal('fetch', mockFetch({ message: 'invalid position' }, 422))
    await expect(glFetch('/x')).rejects.toMatchObject({ detail: { kind: 'unprocessable', message: 'invalid position' } })
  })

  it('maps 429 to rate-limited with Retry-After header', async () => {
    vi.stubGlobal('fetch', mockFetch({}, 429, { 'Retry-After': '60' }))
    await expect(glFetch('/x')).rejects.toMatchObject({ detail: { kind: 'rate-limited' } })
  })

  it('maps 5xx to server error', async () => {
    vi.stubGlobal('fetch', mockFetch({}, 502))
    await expect(glFetch('/x')).rejects.toMatchObject({ detail: { kind: 'server', status: 502 } })
  })

  it('maps network failure to network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(glFetch('/x')).rejects.toMatchObject({ detail: { kind: 'network' } })
  })

  it('throws GitlabApiError for error responses', async () => {
    vi.stubGlobal('fetch', mockFetch({}, 404))
    await expect(glFetch('/x')).rejects.toBeInstanceOf(GitlabApiError)
  })
})

// ---------------------------------------------------------------------------
// OAuth refresh-on-401 behavior
// ---------------------------------------------------------------------------

describe('glFetch — OAuth refresh-on-401', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.unstubAllEnvs()
  })
  afterEach(() => vi.unstubAllGlobals())

  function setActiveOAuth() {
    saveGitlabOAuth({
      token: 'glOAT-initial',
      refreshToken: 'glORT-refresh',
      expiresAt: Date.now() + 3_600_000,
    })
  }

  it('retries once after successful refresh on 401', async () => {
    vi.stubEnv('VITE_GITLAB_CLIENT_ID', 'test_gitlab_client_id')
    setActiveOAuth()

    let callCount = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      // Token refresh call → succeed
      if (url.includes('/oauth/token')) {
        return jsonResponse({
          access_token: 'glOAT-refreshed',
          refresh_token: 'glORT-new',
          expires_in: 7200,
        })
      }
      callCount++
      if (callCount === 1) {
        // First API call → 401 (triggers refresh)
        return jsonResponse({}, {}, 401)
      }
      // Second API call (retry after refresh) → 200
      return jsonResponse({ id: 42 })
    }))

    const data = await glFetch<{ id: number }>('/projects/1')
    expect(data).toEqual({ id: 42 })
    // Settings should have the new token
    expect(getSettings().gitlabOAuth?.token).toBe('glOAT-refreshed')
  })

  it('does NOT retry again if the retry also returns 401 (no infinite loop)', async () => {
    vi.stubEnv('VITE_GITLAB_CLIENT_ID', 'test_gitlab_client_id')
    setActiveOAuth()

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/oauth/token')) {
        return jsonResponse({
          access_token: 'glOAT-refreshed',
          refresh_token: 'glORT-new',
          expires_in: 7200,
        })
      }
      // All API calls → 401 (both initial and retry)
      return jsonResponse({}, {}, 401)
    }))

    // Should throw unauthorized after one retry — not loop
    await expect(glFetch('/x')).rejects.toMatchObject({ detail: { kind: 'unauthorized' } })
  })

  it('clears gitlabOAuth and throws unauthorized when refresh itself fails', async () => {
    vi.stubEnv('VITE_GITLAB_CLIENT_ID', 'test_gitlab_client_id')
    setActiveOAuth()

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/oauth/token')) {
        // Refresh fails
        return jsonResponse({ error: 'invalid_grant' }, {}, 400)
      }
      return jsonResponse({}, {}, 401)
    }))

    await expect(glFetch('/x')).rejects.toMatchObject({ detail: { kind: 'unauthorized' } })
    // gitlabOAuth must be cleared so UI can prompt re-auth
    expect(getSettings().gitlabOAuth).toBeNull()
  })

  it('does NOT attempt refresh when no OAuth is configured (plain PAT + 401)', async () => {
    setGitlabToken('glpat_pat_only')
    const fetchMock = mockFetch({}, 401)
    vi.stubGlobal('fetch', fetchMock)

    await expect(glFetch('/x')).rejects.toMatchObject({ detail: { kind: 'unauthorized' } })
    // Only one fetch call (no token refresh call)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('clears gitlabOAuth when refresh returns no access_token', async () => {
    vi.stubEnv('VITE_GITLAB_CLIENT_ID', 'test_gitlab_client_id')
    setActiveOAuth()

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/oauth/token')) {
        // Malformed response
        return jsonResponse({ token_type: 'Bearer' }, {}, 200)
      }
      return jsonResponse({}, {}, 401)
    }))

    await expect(glFetch('/x')).rejects.toMatchObject({ detail: { kind: 'unauthorized' } })
    expect(getSettings().gitlabOAuth).toBeNull()
  })
})

describe('glFetchPage', () => {
  beforeEach(() => localStorage.clear())

  it('returns body and null next when X-Next-Page is absent', async () => {
    vi.stubGlobal('fetch', mockFetch([1, 2, 3]))
    const result = await glFetchPage<number[]>('/items?per_page=100')
    expect(result.body).toEqual([1, 2, 3])
    expect(result.next).toBeNull()
  })

  it('returns body and null next when X-Next-Page is empty string', async () => {
    vi.stubGlobal('fetch', mockFetch([1], 200, { 'X-Next-Page': '' }))
    const result = await glFetchPage<number[]>('/items?per_page=100')
    expect(result.next).toBeNull()
  })

  it('returns next URL with page param when X-Next-Page is set', async () => {
    vi.stubGlobal('fetch', mockFetch([1, 2], 200, { 'X-Next-Page': '2' }))
    const result = await glFetchPage<number[]>('https://gitlab.com/api/v4/items?per_page=100')
    expect(result.next).toContain('page=2')
  })

  it('replaces existing page param when paginating', async () => {
    vi.stubGlobal('fetch', mockFetch([3, 4], 200, { 'X-Next-Page': '3' }))
    const result = await glFetchPage<number[]>('https://gitlab.com/api/v4/items?per_page=100&page=2')
    expect(result.next).toContain('page=3')
    expect(result.next).not.toMatch(/page=2/)
  })

  it('maps errors just like glFetch', async () => {
    vi.stubGlobal('fetch', mockFetch({}, 401))
    await expect(glFetchPage('/x')).rejects.toMatchObject({ detail: { kind: 'unauthorized' } })
  })
})

describe('self-hosted GitLab base URL', () => {
  beforeEach(() => localStorage.clear())

  it('glFetch uses https://gitlab.com/api/v4 by default', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }))
    vi.stubGlobal('fetch', f)
    await glFetch<{ id: number }>('/projects/1')
    expect(f.mock.calls[0][0]).toContain('https://gitlab.com/api/v4/projects/1')
  })

  it('glFetch uses custom host when gitlabHost is configured', async () => {
    setGitlabHost('gitlab.mycompany.com')
    const f = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }))
    vi.stubGlobal('fetch', f)
    await glFetch<{ id: number }>('/projects/1')
    expect(f.mock.calls[0][0]).toContain('https://gitlab.mycompany.com/api/v4/projects/1')
    expect(f.mock.calls[0][0]).not.toContain('gitlab.com')
  })

  it('glFetch recomputes base URL per request (second request picks up new host)', async () => {
    const f = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({})))
    vi.stubGlobal('fetch', f)
    await glFetch('/a')
    setGitlabHost('custom.host.io')
    await glFetch('/b')
    expect(f.mock.calls[0][0]).toContain('gitlab.com')
    expect(f.mock.calls[1][0]).toContain('custom.host.io')
  })

  it('glFetchPage uses custom host when gitlabHost is configured', async () => {
    setGitlabHost('mygitlab.corp')
    const f = vi.fn().mockResolvedValue(jsonResponse([1], { 'X-Next-Page': '' }))
    vi.stubGlobal('fetch', f)
    await glFetchPage('/items')
    expect(f.mock.calls[0][0]).toContain('https://mygitlab.corp/api/v4/items')
  })

  it('glFetchRaw uses custom host when gitlabHost is configured', async () => {
    setGitlabHost('gitlab.example.org')
    const f = vi.fn().mockResolvedValue(new Response('content', { status: 200 }))
    vi.stubGlobal('fetch', f)
    await glFetchRaw('/projects/1/repository/files/foo/raw?ref=main')
    expect(f.mock.calls[0][0]).toContain('https://gitlab.example.org/api/v4')
  })
})

describe('glFetchRaw', () => {
  beforeEach(() => localStorage.clear())

  it('returns text content on 200', async () => {
    const f = vi.fn().mockResolvedValue(new Response('file contents here', { status: 200 }))
    vi.stubGlobal('fetch', f)
    const result = await glFetchRaw('/projects/1/repository/files/src%2Ffoo.ts/raw?ref=main')
    expect(result).toBe('file contents here')
  })

  it('returns null on 404 (file not found at ref)', async () => {
    vi.stubGlobal('fetch', mockFetch({ message: 'Not Found' }, 404))
    const result = await glFetchRaw('/projects/1/repository/files/notexist/raw?ref=abc')
    expect(result).toBeNull()
  })

  it('throws GitlabApiError on 401', async () => {
    vi.stubGlobal('fetch', mockFetch({}, 401))
    await expect(glFetchRaw('/x')).rejects.toBeInstanceOf(GitlabApiError)
  })
})

// ---------------------------------------------------------------------------
// Abort/timeout classification + window composition (matches ghFetch/bbFetch).
// Every transport failure used to collapse to { kind: 'network' }, and a
// caller-supplied signal REPLACED the 20s window instead of composing with it.
// ---------------------------------------------------------------------------

describe('glFetch — abort/timeout classification', () => {
  afterEach(() => vi.restoreAllMocks())

  it("a TimeoutError is 'timeout', not 'network'", async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('t', 'TimeoutError')))
    await expect(glFetch('/x')).rejects.toMatchObject({
      detail: { kind: 'timeout', afterMs: 20_000 },
    })
  })

  it("an AbortError with no window fired is 'cancelled', not 'network'", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The user aborted a request.', 'AbortError')),
    )
    await expect(glFetch('/x')).rejects.toMatchObject({ detail: { kind: 'cancelled' } })
  })

  it("a genuine connectivity TypeError stays 'network'", async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(glFetch('/x')).rejects.toMatchObject({ detail: { kind: 'network' } })
  })

  it('a caller signal does NOT disable the 20s window', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', mockFetch({ id: 1 }))
    await glFetch('/x', { signal: new AbortController().signal })
    expect(spy).toHaveBeenCalledWith(20_000)
  })

  it('a body read torn down mid-stream never escapes as a raw DOMException', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              throw new DOMException('The user aborted a request.', 'AbortError')
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    const err = await glFetch('/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitlabApiError)
    expect((err as Error).message).not.toMatch(/user aborted/i)
  })
})
