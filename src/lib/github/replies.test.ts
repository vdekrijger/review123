/**
 * Tests for replyToReviewComment — immediate-post replies to existing
 * GitHub review-comment threads.
 *
 * - posts to /repos/{o}/{r}/pulls/{n}/comments/{id}/replies with { body }
 * - maps the created raw comment to PrComment (typed Result, ok: true)
 * - maps API errors to typed Result errors (ok: false, message) — never throws
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { replyToReviewComment } from './replies'
import { jsonResponse } from '../../test-helpers'

const REF = { owner: 'acme', repo: 'web', number: 7 }

function makeRawReply(overrides: Record<string, unknown> = {}) {
  return {
    id: 9001,
    user: { login: 'me', avatar_url: null },
    body: 'Good point, fixed.',
    created_at: '2024-03-01T10:00:00Z',
    path: 'src/foo.ts',
    line: 42,
    side: 'RIGHT' as const,
    in_reply_to_id: 101,
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('replyToReviewComment', () => {
  it('POSTs to the /replies endpoint with the body and returns the mapped comment', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(makeRawReply()))
    vi.stubGlobal('fetch', fetchMock)

    const result = await replyToReviewComment(REF, 101, 'Good point, fixed.')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/repos/acme/web/pulls/7/comments/101/replies')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ body: 'Good point, fixed.' })

    expect(result).toEqual({
      ok: true,
      comment: {
        id: 9001,
        author: 'me',
        authorAvatar: null,
        body: 'Good point, fixed.',
        createdAt: '2024-03-01T10:00:00Z',
        path: 'src/foo.ts',
        line: 42,
        side: 'RIGHT',
        inReplyTo: 101,
      },
    })
  })

  it('404 → typed error result (comment deleted), does not throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'Not Found' }, {}, 404)))
    const result = await replyToReviewComment(REF, 101, 'hello')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/not found/i)
  })

  it('401 → typed error result mentioning authentication', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'Bad credentials' }, {}, 401)))
    const result = await replyToReviewComment(REF, 101, 'hello')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/not authenticated/i)
  })

  it('422 → surfaces the API message verbatim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse({ message: 'Validation Failed: body too long' }, {}, 422)),
    )
    const result = await replyToReviewComment(REF, 101, 'hello')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/body too long/i)
  })

  it('network failure → typed error result, does not throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')))
    const result = await replyToReviewComment(REF, 101, 'hello')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/network/i)
  })
})
