import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ghFetch, ghFetchPage } from './client'
import { GithubApiError } from './types'
import { setGithubPat, saveGithubAuth } from '../settings/settings'
import { jsonResponse } from '../../test-helpers'

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue(jsonResponse(body, headers, status))
}

describe('ghFetch', () => {
  beforeEach(() => localStorage.clear())

  it('returns parsed JSON on 200 and sends auth header when PAT set', async () => {
    const f = mockFetch(200, { id: 1 })
    vi.stubGlobal('fetch', f)
    setGithubPat('ghp_x')
    const data = await ghFetch<{ id: number }>('/repos/a/b')
    expect(data).toEqual({ id: 1 })
    expect(f.mock.calls[0][0]).toBe('https://api.github.com/repos/a/b')
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer ghp_x')
  })

  it('sends oauth token in Authorization header when method is oauth', async () => {
    const f = mockFetch(200, { id: 2 })
    vi.stubGlobal('fetch', f)
    saveGithubAuth({ token: 'gho_oauth', method: 'oauth', scopes: ['public_repo'] })
    const data = await ghFetch<{ id: number }>('/repos/a/b')
    expect(data).toEqual({ id: 2 })
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer gho_oauth')
  })

  it('authenticates via legacy migration: raw githubPat in localStorage → Bearer token', async () => {
    const f = mockFetch(200, { id: 3 })
    vi.stubGlobal('fetch', f)
    // Seed raw legacy storage (no githubAuth key) to prove migration path end-to-end
    localStorage.setItem('review123:settings', JSON.stringify({ githubPat: 'ghp_legacy' }))
    const data = await ghFetch<{ id: number }>('/repos/a/b')
    expect(data).toEqual({ id: 3 })
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer ghp_legacy')
  })

  it('omits auth header without a token', async () => {
    const f = mockFetch(200, {})
    vi.stubGlobal('fetch', f)
    await ghFetch('/repos/a/b')
    expect(f.mock.calls[0][1].headers.Authorization).toBeUndefined()
  })

  it('maps 404 to not-found (EC-05a/EC-05b)', async () => {
    vi.stubGlobal('fetch', mockFetch(404, { message: 'Not Found' }))
    await expect(ghFetch('/x')).rejects.toThrow(GithubApiError)
    await expect(ghFetch('/x')).rejects.toMatchObject({ detail: { kind: 'not-found' } })
  })

  it('maps 401 to unauthorized (EC-04c/EC-04e)', async () => {
    vi.stubGlobal('fetch', mockFetch(401, {}))
    await expect(ghFetch('/x')).rejects.toMatchObject({ detail: { kind: 'unauthorized' } })
  })

  it('maps rate-limit 403 with reset time (EC-05c)', async () => {
    vi.stubGlobal('fetch', mockFetch(403, {}, {
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': '1781200000',
    }))
    await expect(ghFetch('/x')).rejects.toMatchObject({
      detail: { kind: 'rate-limited', resetAt: new Date(1781200000 * 1000) },
    })
  })

  it('maps plain 403 to forbidden', async () => {
    vi.stubGlobal('fetch', mockFetch(403, {}, { 'X-RateLimit-Remaining': '42' }))
    await expect(ghFetch('/x')).rejects.toMatchObject({ detail: { kind: 'forbidden' } })
  })

  it('maps 5xx to server error (EC-05d)', async () => {
    vi.stubGlobal('fetch', mockFetch(502, {}))
    await expect(ghFetch('/x')).rejects.toMatchObject({ detail: { kind: 'server', status: 502 } })
  })

  it('maps network failure (EC-05e)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(ghFetch('/x')).rejects.toMatchObject({ detail: { kind: 'network' } })
  })

  // A timeout used to be reported as { kind: 'network' }, which told the user
  // to check a connection that was working fine. It is its own kind now, and it
  // carries the window it blew so the copy can name it.
  it("maps DOMException TimeoutError to 'timeout', NOT 'network'", async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('t', 'TimeoutError')))
    await expect(ghFetch('/x')).rejects.toMatchObject({
      detail: { kind: 'timeout', afterMs: 20_000 },
    })
  })

  it("maps an AbortError with no window fired to 'cancelled', NOT 'network'", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The user aborted a request.', 'AbortError')),
    )
    await expect(ghFetch('/x')).rejects.toMatchObject({ detail: { kind: 'cancelled' } })
  })
})

describe('ghFetchPage', () => {
  beforeEach(() => localStorage.clear())

  it('returns next URL from Link header', async () => {
    const f = mockFetch(200, [1, 2], {
      Link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"',
    })
    vi.stubGlobal('fetch', f)
    const result = await ghFetchPage<number[]>('/x')
    expect(result.body).toEqual([1, 2])
    expect(result.next).toBe('https://api.github.com/x?page=2')
  })

  it('returns null next when no Link header', async () => {
    vi.stubGlobal('fetch', mockFetch(200, [3, 4]))
    const result = await ghFetchPage<number[]>('/x')
    expect(result.body).toEqual([3, 4])
    expect(result.next).toBeNull()
  })

  it('does NOT send Authorization header to non-github hosts (auth leak guard)', async () => {
    const f = mockFetch(200, {})
    vi.stubGlobal('fetch', f)
    setGithubPat('ghp_secret')
    await ghFetchPage('https://evil.example.com/x')
    expect(f.mock.calls[0][1].headers.Authorization).toBeUndefined()
  })

  it('DOES send Authorization header to api.github.com (auth guard passthrough)', async () => {
    const f = mockFetch(200, {})
    vi.stubGlobal('fetch', f)
    setGithubPat('ghp_secret')
    await ghFetchPage('https://api.github.com/x?page=2')
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer ghp_secret')
  })
})

// ---------------------------------------------------------------------------
// Timeout composition + body-read classification
//
// `init.signal ?? AbortSignal.timeout(20_000)` meant a caller-supplied signal
// REPLACED the window: those calls had no timeout at all and could hang
// forever. It is composed now (the same fix #233 made in the LLM adapters).
//
// And the body read is inside the mapped boundary: fetch() resolves on HEADERS,
// so a window firing mid-body rejects the READ — the exact shape that let a raw
// "The user aborted a request." DOMException reach the UI elsewhere.
// ---------------------------------------------------------------------------

describe('ghFetch — request window', () => {
  // These specs spy on AbortSignal.timeout; restore so the spy cannot leak into
  // a sibling and make an unrelated abort look like a timeout.
  afterEach(() => vi.restoreAllMocks())

  it('a caller signal does NOT disable the 20s window', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', mockFetch(200, {}))
    await ghFetch('/x', { signal: new AbortController().signal })
    expect(spy).toHaveBeenCalledWith(20_000)
  })

  it('the signal handed to fetch fires when the CALLER aborts', async () => {
    const f = mockFetch(200, {})
    vi.stubGlobal('fetch', f)
    const ctrl = new AbortController()
    await ghFetch('/x', { signal: ctrl.signal })
    const passed = f.mock.calls[0][1].signal as AbortSignal
    expect(passed.aborted).toBe(false)
    ctrl.abort()
    expect(passed.aborted).toBe(true)
  })

  it('the signal handed to fetch fires when the WINDOW fires', async () => {
    const fired = new AbortController()
    fired.abort(new DOMException('signal timed out', 'TimeoutError'))
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(fired.signal)
    const f = mockFetch(200, {})
    vi.stubGlobal('fetch', f)
    await ghFetch('/x', { signal: new AbortController().signal })
    expect((f.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true)
  })
})

describe('ghFetch — a body read torn down mid-stream', () => {
  afterEach(() => vi.restoreAllMocks())

  /** A 200 whose BODY read rejects the way Blink's does when aborted. */
  function abortingBody(): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          throw new DOMException('The user aborted a request.', 'AbortError')
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  it("classifies as 'cancelled' when no window fired", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(abortingBody()))
    await expect(ghFetch('/x')).rejects.toMatchObject({ detail: { kind: 'cancelled' } })
  })

  it("classifies as 'timeout' when OUR window fired", async () => {
    const fired = new AbortController()
    fired.abort(new DOMException('signal timed out', 'TimeoutError'))
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(fired.signal)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(abortingBody()))
    await expect(ghFetch('/x')).rejects.toMatchObject({ detail: { kind: 'timeout' } })
  })

  it('never lets the raw DOMException escape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(abortingBody()))
    const err = await ghFetch('/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GithubApiError)
    expect((err as Error).message).not.toMatch(/user aborted/i)
  })
})
