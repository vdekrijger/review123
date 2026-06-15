/**
 * Tests for getPrComments — fetches review + issue comments for a PR.
 *
 * EC-COMM-01: review comment mapped correctly (path, line, side, inReplyTo)
 * EC-COMM-02: issue comment mapped correctly (path/line/side/inReplyTo all null)
 * EC-COMM-03: outdated review comment (line null) keeps null
 * EC-COMM-04: pagination — fetches up to MAX_PAGES (5) pages each endpoint
 * EC-COMM-05: both endpoints combined and sorted by createdAt
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getPrComments } from './comments'
import { jsonResponse } from '../../test-helpers'

const REF = { owner: 'acme', repo: 'web', number: 7 }

// ---------------------------------------------------------------------------
// Raw fixture builders
// ---------------------------------------------------------------------------

function makeRawReviewComment(overrides: Partial<{
  id: number
  user: { login: string; avatar_url: string | null }
  body: string
  created_at: string
  path: string
  line: number | null
  side: 'LEFT' | 'RIGHT'
  in_reply_to_id: number | null
  html_url: string | undefined
}> = {}) {
  return {
    id: 101,
    user: { login: 'alice', avatar_url: 'https://avatars.github.com/alice' },
    body: 'LGTM!',
    created_at: '2024-01-01T10:00:00Z',
    path: 'src/foo.ts',
    line: 42,
    side: 'RIGHT' as const,
    in_reply_to_id: null,
    html_url: 'https://github.com/acme/web/pull/7#discussion_r101',
    ...overrides,
  }
}

function makeRawIssueComment(overrides: Partial<{
  id: number
  user: { login: string; avatar_url: string | null }
  body: string
  created_at: string
  html_url: string | undefined
}> = {}) {
  return {
    id: 201,
    user: { login: 'bob', avatar_url: null },
    body: 'Great PR!',
    created_at: '2024-01-01T09:00:00Z',
    ...overrides,
  }
}

function pageOf(items: unknown[], nextUrl?: string): Response {
  const headers: Record<string, string> = {}
  if (nextUrl) {
    headers['Link'] = `<${nextUrl}>; rel="next"`
  }
  return jsonResponse(items, headers)
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// EC-COMM-01: review comment mapping
// ---------------------------------------------------------------------------

describe('getPrComments — review comment mapping (EC-COMM-01)', () => {
  it('maps a review comment with path, line, side, and inReplyTo', async () => {
    const raw = makeRawReviewComment({
      id: 501,
      user: { login: 'alice', avatar_url: 'https://avatars.github.com/alice' },
      body: 'Consider renaming this.',
      created_at: '2024-02-01T12:00:00Z',
      path: 'src/utils.ts',
      line: 15,
      side: 'RIGHT',
      in_reply_to_id: null,
      html_url: 'https://github.com/acme/web/pull/7#discussion_r501',
    })

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(pageOf([raw]))    // review comments page 1 (no next)
      .mockResolvedValueOnce(pageOf([]))        // issue comments page 1 (no next)
    )

    const comments = await getPrComments(REF)
    expect(comments).toHaveLength(1)
    expect(comments[0]).toEqual({
      id: 501,
      author: 'alice',
      authorAvatar: 'https://avatars.github.com/alice',
      body: 'Consider renaming this.',
      createdAt: '2024-02-01T12:00:00Z',
      path: 'src/utils.ts',
      line: 15,
      side: 'RIGHT',
      inReplyTo: null,
      url: 'https://github.com/acme/web/pull/7#discussion_r501',
    })
  })

  it('maps inReplyTo from in_reply_to_id', async () => {
    const raw = makeRawReviewComment({
      id: 502,
      in_reply_to_id: 501,
    })

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(pageOf([raw]))
      .mockResolvedValueOnce(pageOf([]))
    )

    const comments = await getPrComments(REF)
    expect(comments[0].inReplyTo).toBe(501)
  })

  it('maps LEFT side correctly', async () => {
    const raw = makeRawReviewComment({ side: 'LEFT' })

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(pageOf([raw]))
      .mockResolvedValueOnce(pageOf([]))
    )

    const comments = await getPrComments(REF)
    expect(comments[0].side).toBe('LEFT')
  })
})

// ---------------------------------------------------------------------------
// EC-COMM-02: issue comment mapping (path/line/side/inReplyTo all null)
// ---------------------------------------------------------------------------

describe('getPrComments — issue comment mapping (EC-COMM-02)', () => {
  it('maps an issue comment with null path, line, side, inReplyTo', async () => {
    const raw = makeRawIssueComment({
      id: 601,
      user: { login: 'bob', avatar_url: null },
      body: 'Looks good overall!',
      created_at: '2024-02-01T11:00:00Z',
    })

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(pageOf([]))      // review comments — empty
      .mockResolvedValueOnce(pageOf([raw]))   // issue comments
    )

    const comments = await getPrComments(REF)
    expect(comments).toHaveLength(1)
    expect(comments[0]).toEqual({
      id: 601,
      author: 'bob',
      authorAvatar: null,
      body: 'Looks good overall!',
      createdAt: '2024-02-01T11:00:00Z',
      path: null,
      line: null,
      side: null,
      inReplyTo: null,
    })
  })
})

// ---------------------------------------------------------------------------
// EC-COMM-URL: html_url → comment.url permalink mapping
// ---------------------------------------------------------------------------

describe('getPrComments — comment permalink mapping (EC-COMM-URL)', () => {
  it('maps review comment html_url to comment.url', async () => {
    const raw = makeRawReviewComment({
      id: 701,
      html_url: 'https://github.com/acme/web/pull/7#discussion_r701',
    })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(pageOf([raw]))
      .mockResolvedValueOnce(pageOf([]))
    )
    const comments = await getPrComments(REF)
    expect(comments[0].url).toBe('https://github.com/acme/web/pull/7#discussion_r701')
  })

  it('maps issue comment html_url to comment.url', async () => {
    const raw = makeRawIssueComment({
      id: 801,
      html_url: 'https://github.com/acme/web/pull/7#issuecomment-801',
    })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(pageOf([]))
      .mockResolvedValueOnce(pageOf([raw]))
    )
    const comments = await getPrComments(REF)
    expect(comments[0].url).toBe('https://github.com/acme/web/pull/7#issuecomment-801')
  })

  it('leaves comment.url undefined when html_url is absent', async () => {
    const raw = makeRawReviewComment({ id: 901, html_url: undefined })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(pageOf([raw]))
      .mockResolvedValueOnce(pageOf([]))
    )
    const comments = await getPrComments(REF)
    expect(comments[0].url).toBeUndefined()
    expect('url' in comments[0]).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// EC-COMM-03: outdated review comment (line null) → kept as null
// ---------------------------------------------------------------------------

describe('getPrComments — outdated comment line null (EC-COMM-03)', () => {
  it('keeps line as null when review comment has null line (outdated comment)', async () => {
    const raw = makeRawReviewComment({ line: null })

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(pageOf([raw]))
      .mockResolvedValueOnce(pageOf([]))
    )

    const comments = await getPrComments(REF)
    expect(comments[0].line).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// EC-COMM-04: pagination — up to 5 pages per endpoint
// ---------------------------------------------------------------------------

describe('getPrComments — pagination (EC-COMM-04)', () => {
  it('follows Link next header for review comments across 2 pages', async () => {
    const page1Comment = makeRawReviewComment({ id: 1, created_at: '2024-01-01T10:00:00Z' })
    const page2Comment = makeRawReviewComment({ id: 2, created_at: '2024-01-01T11:00:00Z' })
    const nextUrl = 'https://api.github.com/repos/acme/web/pulls/7/comments?per_page=100&page=2'

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(pageOf([page1Comment], nextUrl))   // review page 1 → next
      .mockResolvedValueOnce(pageOf([page2Comment]))             // review page 2 → done
      .mockResolvedValueOnce(pageOf([]))                         // issue page 1
    )

    const comments = await getPrComments(REF)
    expect(comments.filter(c => c.path !== null)).toHaveLength(2)
  })

  it('follows Link next header for issue comments across 2 pages', async () => {
    const page1Comment = makeRawIssueComment({ id: 101, created_at: '2024-01-01T10:00:00Z' })
    const page2Comment = makeRawIssueComment({ id: 102, created_at: '2024-01-01T11:00:00Z' })
    const nextUrl = 'https://api.github.com/repos/acme/web/issues/7/comments?per_page=100&page=2'

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(pageOf([]))                          // review page 1 — empty
      .mockResolvedValueOnce(pageOf([page1Comment], nextUrl))    // issue page 1 → next
      .mockResolvedValueOnce(pageOf([page2Comment]))              // issue page 2 → done
    )

    const comments = await getPrComments(REF)
    expect(comments.filter(c => c.path === null)).toHaveLength(2)
  })

  it('stops at MAX_PAGES (5) per endpoint even with infinite next links', async () => {
    const nextUrl = 'https://api.github.com/repos/acme/web/pulls/7/comments?per_page=100&page=next'
    const comment = makeRawReviewComment({ id: 1 })

    // Always return next so loop could be infinite — expect cap at 5 pages
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementation(() => Promise.resolve(pageOf([comment], nextUrl)))
    )

    const comments = await getPrComments(REF)
    // 5 pages review + 5 pages issue = 10 calls, each with 1 comment = 10 comments
    expect(comments).toHaveLength(10)
  })
})

// ---------------------------------------------------------------------------
// EC-COMM-05: combined and sorted by createdAt
// ---------------------------------------------------------------------------

describe('getPrComments — combined and sorted by createdAt (EC-COMM-05)', () => {
  it('sorts all comments by createdAt ascending regardless of source', async () => {
    const reviewComment = makeRawReviewComment({
      id: 301,
      created_at: '2024-01-15T14:00:00Z',
    })
    const issueComment1 = makeRawIssueComment({
      id: 401,
      created_at: '2024-01-15T10:00:00Z',
    })
    const issueComment2 = makeRawIssueComment({
      id: 402,
      created_at: '2024-01-15T16:00:00Z',
    })

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(pageOf([reviewComment]))
      .mockResolvedValueOnce(pageOf([issueComment1, issueComment2]))
    )

    const comments = await getPrComments(REF)
    expect(comments).toHaveLength(3)
    expect(comments[0].id).toBe(401)   // 10:00
    expect(comments[1].id).toBe(301)   // 14:00
    expect(comments[2].id).toBe(402)   // 16:00
  })
})

// ---------------------------------------------------------------------------
// URL correctness
// ---------------------------------------------------------------------------

describe('getPrComments — correct API URLs', () => {
  it('calls the correct review and issue comment endpoints', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(pageOf([]))
      .mockResolvedValueOnce(pageOf([]))

    vi.stubGlobal('fetch', mockFetch)

    await getPrComments(REF)

    const urls = mockFetch.mock.calls.map((call) => call[0] as string)
    expect(urls[0]).toContain(`/repos/${REF.owner}/${REF.repo}/pulls/${REF.number}/comments`)
    expect(urls[0]).toContain('per_page=100')
    expect(urls[1]).toContain(`/repos/${REF.owner}/${REF.repo}/issues/${REF.number}/comments`)
    expect(urls[1]).toContain('per_page=100')
  })
})
