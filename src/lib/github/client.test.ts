import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ghFetch, ghFetchPage } from './client'
import { GithubApiError } from './types'

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers }))
}

describe('ghFetch', () => {
  beforeEach(() => localStorage.clear())

  it('returns parsed JSON on 200 and sends auth header when PAT set', async () => {
    const f = mockFetch(200, { id: 1 })
    vi.stubGlobal('fetch', f)
    localStorage.setItem('review123:settings', JSON.stringify({ githubPat: 'ghp_x' }))
    const data = await ghFetch<{ id: number }>('/repos/a/b')
    expect(data).toEqual({ id: 1 })
    expect(f.mock.calls[0][0]).toBe('https://api.github.com/repos/a/b')
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer ghp_x')
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
    localStorage.setItem('review123:settings', JSON.stringify({ githubPat: 'ghp_secret' }))
    await ghFetchPage('https://evil.example.com/x')
    expect(f.mock.calls[0][1].headers.Authorization).toBeUndefined()
  })

  it('DOES send Authorization header to api.github.com (auth guard passthrough)', async () => {
    const f = mockFetch(200, {})
    vi.stubGlobal('fetch', f)
    localStorage.setItem('review123:settings', JSON.stringify({ githubPat: 'ghp_secret' }))
    await ghFetchPage('https://api.github.com/x?page=2')
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer ghp_secret')
  })
})
