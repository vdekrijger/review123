/**
 * Tests for the GitLab low-level client (glFetch, glFetchPage, glFetchRaw).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { glFetch, glFetchPage, glFetchRaw, GitlabApiError } from './gitlabClient'
import { setGitlabToken, setGitlabHost } from '../settings/settings'
import { jsonResponse } from '../../test-helpers'

function mockFetch(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue(jsonResponse(body, headers, status))
}

describe('glFetch', () => {
  beforeEach(() => localStorage.clear())

  it('returns parsed JSON on 200', async () => {
    vi.stubGlobal('fetch', mockFetch({ id: 1 }))
    const data = await glFetch<{ id: number }>('/projects/1')
    expect(data).toEqual({ id: 1 })
  })

  it('sends PRIVATE-TOKEN header when gitlabToken is set', async () => {
    const f = mockFetch({})
    vi.stubGlobal('fetch', f)
    setGitlabToken('glpat_mytoken')
    await glFetch('/projects/1')
    expect(f.mock.calls[0][1].headers['PRIVATE-TOKEN']).toBe('glpat_mytoken')
  })

  it('omits PRIVATE-TOKEN when no token configured', async () => {
    const f = mockFetch({})
    vi.stubGlobal('fetch', f)
    await glFetch('/projects/1')
    expect(f.mock.calls[0][1].headers['PRIVATE-TOKEN']).toBeUndefined()
  })

  it('maps 404 to not-found', async () => {
    vi.stubGlobal('fetch', mockFetch({ message: 'Not Found' }, 404))
    await expect(glFetch('/x')).rejects.toMatchObject({ detail: { kind: 'not-found' } })
  })

  it('maps 401 to unauthorized', async () => {
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
