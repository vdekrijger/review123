/**
 * Tests for bitbucketClient.ts
 *
 * Tests:
 *   - Auth header construction (Basic base64(email:token))
 *   - No auth → no Authorization header
 *   - bbFetch: success, 4xx/5xx errors, network errors
 *   - bbFetchRaw: returns text, returns null on 404
 *   - bbFetchPage: pagination via body.next
 *   - bbFetchAll: collects across pages, respects maxPages
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { bbFetch, bbFetchRaw, bbFetchPage, bbFetchAll, BitbucketApiError } from './bitbucketClient'

// Mock the settings module
vi.mock('../settings/settings', () => ({
  getSettings: vi.fn(),
}))

import { getSettings } from '../settings/settings'
const mockGetSettings = vi.mocked(getSettings)

function mockAuth(email: string | null, token: string | null) {
  if (email && token) {
    mockGetSettings.mockReturnValue({
      bitbucketAuth: { email, token },
    } as ReturnType<typeof getSettings>)
  } else {
    mockGetSettings.mockReturnValue({
      bitbucketAuth: null,
    } as ReturnType<typeof getSettings>)
  }
}

// Helper to create a mock Response
function mockResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const responseHeaders = new Headers(headers)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: responseHeaders,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

const globalFetch = globalThis.fetch

beforeEach(() => {
  vi.resetAllMocks()
  mockAuth(null, null)
})

afterEach(() => {
  globalThis.fetch = globalFetch
})

// ---------------------------------------------------------------------------
// Auth header tests
// ---------------------------------------------------------------------------

describe('auth header', () => {
  it('sends Basic base64(email:token) when auth is configured', async () => {
    mockAuth('user@example.com', 'mytoken')
    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>
      return Promise.resolve(mockResponse({ values: [] }))
    })

    await bbFetchPage('/repositories/ws/repo/pullrequests/1/comments')

    const expected = `Basic ${btoa('user@example.com:mytoken')}`
    expect(capturedHeaders['Authorization']).toBe(expected)
  })

  it('does not send Authorization header when no auth configured', async () => {
    mockAuth(null, null)
    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>
      return Promise.resolve(mockResponse({ values: [] }))
    })

    await bbFetchPage('/repositories/ws/repo/pullrequests/1/comments')

    expect(capturedHeaders['Authorization']).toBeUndefined()
  })

  it('encodes email:token correctly with special characters', async () => {
    mockAuth('user+tag@example.com', 'tok/en=')
    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>
      return Promise.resolve(mockResponse({ values: [] }))
    })

    await bbFetchPage('/repositories/ws/repo/pullrequests/1/comments')

    const expected = `Basic ${btoa('user+tag@example.com:tok/en=')}`
    expect(capturedHeaders['Authorization']).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// bbFetch tests
// ---------------------------------------------------------------------------

describe('bbFetch', () => {
  it('returns parsed JSON on success', async () => {
    mockAuth('u@x.com', 'tk')
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ foo: 'bar' }))

    const result = await bbFetch<{ foo: string }>('/repositories/ws/repo/pullrequests/1')
    expect(result).toEqual({ foo: 'bar' })
  })

  it('prepends BASE URL for relative paths', async () => {
    mockAuth('u@x.com', 'tk')
    let capturedUrl = ''
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url
      return Promise.resolve(mockResponse({}))
    })

    await bbFetch('/repositories/ws/repo/pullrequests/1')
    expect(capturedUrl).toBe('https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/1')
  })

  it('uses absolute URL as-is', async () => {
    mockAuth('u@x.com', 'tk')
    let capturedUrl = ''
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url
      return Promise.resolve(mockResponse({}))
    })

    await bbFetch('https://api.bitbucket.org/2.0/custom/path')
    expect(capturedUrl).toBe('https://api.bitbucket.org/2.0/custom/path')
  })

  it('throws BitbucketApiError not-found on 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(null, 404))

    await expect(bbFetch('/x')).rejects.toMatchObject({
      detail: { kind: 'not-found' },
    })
  })

  it('throws BitbucketApiError unauthorized on 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(null, 401))

    await expect(bbFetch('/x')).rejects.toMatchObject({
      detail: { kind: 'unauthorized' },
    })
  })

  it('throws BitbucketApiError forbidden on 403', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(null, 403))

    await expect(bbFetch('/x')).rejects.toMatchObject({
      detail: { kind: 'forbidden' },
    })
  })

  it('throws BitbucketApiError server on 500', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(null, 500))

    await expect(bbFetch('/x')).rejects.toMatchObject({
      detail: { kind: 'server', status: 500 },
    })
  })

  it('throws BitbucketApiError network on fetch throw', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(bbFetch('/x')).rejects.toMatchObject({
      detail: { kind: 'network' },
    })
  })

  it('BitbucketApiError is instance of Error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(null, 404))

    try {
      await bbFetch('/x')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(BitbucketApiError)
      expect(err).toBeInstanceOf(Error)
    }
  })
})

// ---------------------------------------------------------------------------
// bbFetchRaw tests
// ---------------------------------------------------------------------------

describe('bbFetchRaw', () => {
  it('returns text content on success', async () => {
    mockAuth('u@x.com', 'tk')
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse('file content here', 200))

    const result = await bbFetchRaw('/repositories/ws/repo/src/abc123/src/main.ts')
    expect(result).toBe('file content here')
  })

  it('returns null on 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(null, 404))

    const result = await bbFetchRaw('/repositories/ws/repo/src/abc123/missing.ts')
    expect(result).toBeNull()
  })

  it('throws BitbucketApiError on non-404 errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(null, 500))

    await expect(bbFetchRaw('/repositories/ws/repo/src/abc123/file.ts')).rejects.toMatchObject({
      detail: { kind: 'server', status: 500 },
    })
  })

  it('throws BitbucketApiError network on fetch throw', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'))

    await expect(bbFetchRaw('/x')).rejects.toMatchObject({
      detail: { kind: 'network' },
    })
  })

  it('sends Accept: text/plain header', async () => {
    mockAuth('u@x.com', 'tk')
    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>
      return Promise.resolve(mockResponse('content', 200))
    })

    await bbFetchRaw('/repositories/ws/repo/src/abc/file.ts')
    expect(capturedHeaders['Accept']).toMatch(/text\/plain/)
  })
})

// ---------------------------------------------------------------------------
// bbFetchPage tests
// ---------------------------------------------------------------------------

describe('bbFetchPage', () => {
  it('returns values array and null next when no next link', async () => {
    const data = { values: [{ id: 1 }, { id: 2 }] }
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(data))

    const result = await bbFetchPage<{ id: number }>('/repositories/ws/repo/pullrequests/1/comments')
    expect(result.body).toEqual([{ id: 1 }, { id: 2 }])
    expect(result.next).toBeNull()
  })

  it('returns next URL when present in body', async () => {
    const data = {
      values: [{ id: 1 }],
      next: 'https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/1/comments?page=2',
    }
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(data))

    const result = await bbFetchPage<{ id: number }>('/repositories/ws/repo/pullrequests/1/comments')
    expect(result.next).toBe('https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/1/comments?page=2')
  })

  it('returns empty array when values is missing from body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({}))

    const result = await bbFetchPage<unknown>('/repositories/ws/repo/pullrequests/1/comments')
    expect(result.body).toEqual([])
  })

  it('throws on non-OK responses', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(null, 401))

    await expect(bbFetchPage('/x')).rejects.toMatchObject({
      detail: { kind: 'unauthorized' },
    })
  })
})

// ---------------------------------------------------------------------------
// bbFetchAll tests
// ---------------------------------------------------------------------------

describe('bbFetchAll', () => {
  it('collects items from a single page', async () => {
    const page1 = { values: [{ id: 1 }, { id: 2 }] }
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(page1))

    const result = await bbFetchAll<{ id: number }>('/repositories/ws/repo/pullrequests/1/comments')
    expect(result).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('collects items across multiple pages following next URLs', async () => {
    const page1 = {
      values: [{ id: 1 }],
      next: 'https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/1/comments?page=2',
    }
    const page2 = { values: [{ id: 2 }, { id: 3 }] }

    let callCount = 0
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++
      return Promise.resolve(mockResponse(callCount === 1 ? page1 : page2))
    })

    const result = await bbFetchAll<{ id: number }>('/repositories/ws/repo/pullrequests/1/comments')
    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    expect(callCount).toBe(2)
  })

  it('stops after maxPages even if next is present', async () => {
    const page = {
      values: [{ id: 1 }],
      next: 'https://api.bitbucket.org/2.0/next',
    }
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(page))

    const result = await bbFetchAll<{ id: number }>('/x', 2)
    expect(result).toHaveLength(2) // maxPages=2, each page has 1 item
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it('returns empty array when first page has no values', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ values: [] }))

    const result = await bbFetchAll<unknown>('/x')
    expect(result).toEqual([])
  })
})
